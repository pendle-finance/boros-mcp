import { formatDuration } from '../../utils.js';

export interface FlattenMarketOptions {
  full?: boolean;
}

export type FlattenedMarket = Record<string, unknown>;

// /v1/markets ships status as a numeric MarketStatus enum where ordering is anti-intuitive
// (0=PAUSED worst, 2=GOOD best). Translate to string labels so LLMs don't reason on the numbers.
const MARKET_STATUS_LABEL: Record<number, string> = {
  0: 'PAUSED',
  1: 'CLOSE_ONLY',
  2: 'GOOD',
};

function statusLabel(raw: unknown): unknown {
  if (typeof raw === 'number') return MARKET_STATUS_LABEL[raw] ?? raw;
  return raw;
}

// Round APR to 6dp — backend returns 17 sig figs (e.g. 0.02695625491747749), other fields are 4dp.
export function roundApr(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Number(v.toFixed(6));
}

export function flattenMarket(
  m: unknown,
  opts: FlattenMarketOptions = {},
): FlattenedMarket {
  const raw = m as Record<string, unknown>;
  const imData = (raw.imData ?? {}) as Record<string, unknown>;
  const config = (raw.config ?? {}) as Record<string, unknown>;
  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  const data = (raw.data ?? {}) as Record<string, unknown>;
  const state = (raw.state ?? {}) as Record<string, unknown>;

  const maturity = imData.maturity as number | undefined;
  const nextSettlement = data.nextSettlementTime as number | undefined;
  const ttm = data.timeToMaturity as number | undefined;
  // imData.name is the full label (e.g. "Hyperliquid ETH 26 Jun 2026"); imData.marketName is legacy.
  const name = (imData.name as string | undefined) ?? (imData.marketName as string | undefined);
  const symbol = imData.symbol as string | undefined;

  // v2 puts ammId on extConfig; older snapshots used metadata.ammId — read both.
  const extConfig = (raw.extConfig ?? {}) as Record<string, unknown>;
  const resolvedAmmId =
    (extConfig.ammId as number | undefined) ?? (metadata.ammId as number | undefined);

  const base: Record<string, unknown> = {
    marketId: raw.marketId,
    address: raw.address,
    tokenId: raw.tokenId,
    status: statusLabel(config.status),
    ...(name ? { name } : {}),
    ...(symbol ? { symbol } : {}),
    maturity,
    ...(maturity ? { maturityIso: new Date(maturity * 1000).toISOString() } : {}),
    underlyingSymbol: metadata.underlyingSymbol,
    fundingRateSymbol: metadata.fundingRateSymbol,
    ammId: resolvedAmmId,
    markApr: roundApr(data.markApr),
    lastTradedApr: roundApr(data.lastTradedApr),
    midApr: roundApr(data.midApr),
    bestBid: roundApr(data.bestBid),
    bestAsk: roundApr(data.bestAsk),
    ammImpliedApr: roundApr(data.ammImpliedApr),
    floatingApr: roundApr(data.floatingApr),
    longYieldApr: roundApr(data.longYieldApr),
    volume24h: data.volume24h,
    notionalOI: data.notionalOI,
    nextSettlementTime: nextSettlement,
    ...(nextSettlement ? { nextSettlementIso: new Date(nextSettlement * 1000).toISOString() } : {}),
    timeToMaturity: ttm,
    ...(ttm ? { timeToMaturityLabel: formatDuration(ttm) } : {}),
    assetMarkPrice: data.assetMarkPrice,
    softOICap: config.softOICap,
  };
  // full=true: surface extra blocks. Omit `state` when missing (v2 list-item DTO has no state).
  if (opts.full) {
    base.imData = imData;
    // Mirror the numeric→label status translation onto config so consumers don't see disagreeing values.
    base.config = { ...config, status: statusLabel(config.status) };
    base.metadata = metadata;
    base.extConfig = extConfig;
    base.data = data;
    if (raw.state !== undefined) base.state = state;
  }
  return base;
}
