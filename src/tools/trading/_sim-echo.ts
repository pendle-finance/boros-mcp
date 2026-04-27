// Sim-echo formatter for simulate_order/place_order/simulate_close/close_position.
// Drops raw preState; reshapes matched/postState. open-api close-position sim returns null
// for closeTradePnl — we derive locally from the canonical Boros core formula.
import { formatSize, enrichAprValue } from '../../utils.js';
import { tryBigInt } from './_helpers.js';

// Inputs for local closeTradePnl. All optional — buildSimEcho populates only when
// all are finite, otherwise emits closeTradePnlReason naming the missing field.
export interface CloseTradePnlInputs {
  positionSignedSizeRawX18?: bigint;
  entryRate?: number;
  maturityUnix?: number;
}

export function gatherCloseTradePnlInputs(
  activePosition: any | null,
  market: any,
): CloseTradePnlInputs {
  const positionSignedSizeRawX18 = activePosition?.signedSize
    ? tryBigInt(activePosition.signedSize)
    : undefined;
  const entryRate =
    typeof activePosition?.fixedApr === 'number' ? activePosition.fixedApr : undefined;
  const maturityUnixRaw = market?.imData?.maturity;
  const maturityUnixNum =
    maturityUnixRaw !== undefined && maturityUnixRaw !== null
      ? Number(maturityUnixRaw)
      : undefined;
  const maturityUnix =
    maturityUnixNum !== undefined && Number.isFinite(maturityUnixNum)
      ? maturityUnixNum
      : undefined;
  return { positionSignedSizeRawX18, entryRate, maturityUnix };
}

// `resolved` dropped: actualRate is tick-encoded sentinel (25.486 reads as 2548% APR → LLM misread).
// longYieldApr clamped undefined when |val|>1 (extrapolation can be -412% but never realized).
// closeTradePnl formula: positionSignedSize × (closeRate − entryRate) × yearsToMaturity.
export function buildSimEcho(
  sim: any,
  opts: {
    includeStatus?: boolean;
    includeLongYield?: boolean;
    includeClose?: boolean;
    collateralSymbol?: string;
    positionSignedSizeRawX18?: bigint; // 10^18-scaled YU bigint from active-positions.signedSize
    entryRate?: number;                // active-positions.fixedApr (decimal APR)
    maturityUnix?: number;             // imData.maturity unix seconds
  } = {},
) {
  const {
    includeStatus = false,
    includeLongYield = false,
    includeClose = false,
    collateralSymbol,
    positionSignedSizeRawX18,
    entryRate,
    maturityUnix,
  } = opts;
  const unit = collateralSymbol ?? 'token';
  // Fill only when ALL inputs finite; else surface closeTradePnlReason for auditability.
  let closeTradePnl: number | string | null | undefined = sim.closeTradePnl;
  let closeTradePnlReason: string | undefined;
  if (includeClose && (closeTradePnl === null || closeTradePnl === undefined)) {
    try {
      const closeRate = sim.matched?.rate;
      const SECONDS_PER_YEAR = 31_536_000;
      const nowUnix = Math.floor(Date.now() / 1000);
      const yearsToMaturity =
        maturityUnix !== undefined && maturityUnix > nowUnix
          ? (maturityUnix - nowUnix) / SECONDS_PER_YEAR
          : undefined;

      if (
        positionSignedSizeRawX18 !== undefined &&
        typeof entryRate === 'number' && Number.isFinite(entryRate) &&
        typeof closeRate === 'number' && Number.isFinite(closeRate) &&
        yearsToMaturity !== undefined
      ) {
        // FixedX18 bigint → float YU. Loses sub-1e-15 precision; display-only PnL.
        const sizeFloat = Number(positionSignedSizeRawX18) / 1e18;
        const pnl = sizeFloat * (closeRate - entryRate) * yearsToMaturity;
        if (Number.isFinite(pnl)) {
          closeTradePnl = pnl;
        } else {
          closeTradePnl = null;
          closeTradePnlReason = 'pnl computation produced a non-finite value';
        }
      } else {
        closeTradePnl = null;
        const missing: string[] = [];
        if (positionSignedSizeRawX18 === undefined) missing.push('positionSignedSize');
        if (typeof entryRate !== 'number' || !Number.isFinite(entryRate)) missing.push('entryRate');
        if (typeof closeRate !== 'number' || !Number.isFinite(closeRate)) missing.push('matched.rate (closeRate)');
        if (yearsToMaturity === undefined) missing.push('yearsToMaturity');
        closeTradePnlReason = `closeTradePnl not computed — missing: ${missing.join(', ')}`;
      }
    } catch (e: any) {
      closeTradePnl = null;
      closeTradePnlReason = `closeTradePnl computation failed: ${e?.message ?? String(e)}`;
    }
  }
  const longYield = sim.postState?.longYieldApr;
  const longYieldUsable =
    typeof longYield === 'number' && Number.isFinite(longYield) && Math.abs(longYield) <= 1
      ? longYield
      : undefined;
  return {
    ...(includeStatus ? { status: sim.status } : {}),
    statusCode: sim.statusCode,
    matched: sim.matched
      ? {
          size: formatSize(sim.matched.size),
          sizeUnit: 'YU',
          cost: sim.matched.cost,
          costUnit: unit,
          rate: sim.matched.rate,
          ...enrichAprValue(sim.matched.rate),
        }
      : sim.matched,
    marginRequired: sim.postState?.marginRequired,
    marginRequiredUnit: unit,
    liquidationApr: sim.postState?.liquidationApr,
    liquidationAprPercent: enrichAprValue(sim.postState?.liquidationApr)?.aprPercent,
    ...(includeLongYield && longYieldUsable !== undefined
      ? {
          longYieldApr: longYieldUsable,
          longYieldAprPercent: enrichAprValue(longYieldUsable)?.aprPercent,
        }
      : {}),
    // Mask backend's mid-vs-zero priceImpact when nothing matched (e.g. SOFT_ALO post-only
    // fully resting). The backend reports `priceImpact = -mid` because matchedRate is 0,
    // which reads like a real impact in tooling. Force 0 when no slice executed.
    priceImpact:
      sim.matched && Number(formatSize(sim.matched.size)) === 0 ? 0 : sim.priceImpact,
    priceImpactPercent:
      sim.matched && Number(formatSize(sim.matched.size)) === 0
        ? '0.00%'
        : sim.priceImpact !== undefined
          ? `${(sim.priceImpact * 100).toFixed(2)}%`
          : undefined,
    makerOrderReward: sim.makerOrderReward,
    ...(includeClose && closeTradePnl !== null && closeTradePnl !== undefined
      ? { closeTradePnl, closeTradePnlUnit: unit }
      : {}),
    ...(includeClose && closeTradePnlReason ? { closeTradePnlReason } : {}),
  };
}
