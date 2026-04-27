import { rawToHuman } from './amount.js';
import { unpackMarketAcc } from '../../chain/pack-account.js';
import type { AssetInfo } from '../../api/asset-cache.js';

export function enrichAmount(raw: string | bigint, decimals: number, symbol?: string) {
  return {
    raw: raw.toString(),
    humanAmount: rawToHuman(raw, decimals),
    ...(symbol ? { symbol } : {}),
  };
}

export function enrichTimestamp(unixSeconds: number) {
  return {
    timestamp: unixSeconds,
    iso: new Date(unixSeconds * 1000).toISOString(),
  };
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export interface DecodedMarketAcc {
  root: string;
  accountId: number;
  tokenId: number;
  tokenSymbol?: string;
  marketId: number;
  isCross: boolean;
}

export function decodeMarketAcc(
  marketAcc: string | null | undefined,
  assetMap?: Map<number, AssetInfo>,
): DecodedMarketAcc | undefined {
  if (!marketAcc) return undefined;
  try {
    const u = unpackMarketAcc(marketAcc);
    const tokenSymbol = assetMap?.get(u.tokenId)?.symbol;
    return tokenSymbol ? { ...u, tokenSymbol } : u;
  } catch {
    return undefined;
  }
}
