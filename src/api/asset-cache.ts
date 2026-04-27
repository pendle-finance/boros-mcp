import { openApiGet } from '../api/open-api.js';
import { fetchWithRetry } from '../lib/fetch-retry.js';
import { dedupTtl } from '../lib/dedup.js';
import { BorosErrorCode, throwBorosError } from '../agent/errors.js';

export interface AssetInfo {
  tokenId: number;
  symbol: string;
  decimals: number;
  address?: string;
  name?: string;
  usdPrice?: string;
  isCollateral?: boolean;
  [k: string]: unknown;
}

// /v1/assets is near-static; shared TTL cache (key 'assets') so trading/wallet flows reuse payload.
const ASSET_CACHE_TTL_MS = 60_000;

export async function getAssetMap(): Promise<Map<number, AssetInfo>> {
  const res = await dedupTtl('assets', {}, ASSET_CACHE_TTL_MS, () =>
    fetchWithRetry(() => openApiGet('/v1/assets')),
  );
  const list: AssetInfo[] = res.results ?? [];
  const map = new Map<number, AssetInfo>();
  for (const a of list) {
    // tokenId=-1 is reward sentinel (PENDLE) shared by multiple rows; skip to avoid overwrites.
    if (typeof a.tokenId === 'number' && a.tokenId > 0) map.set(a.tokenId, a);
  }
  return map;
}

/** Swallows network failures so decoded marketAcc just omits tokenSymbol on otherwise-successful tools. */
export async function safeAssetMap(): Promise<Map<number, AssetInfo>> {
  try { return await getAssetMap(); } catch { return new Map(); }
}

export async function getAssetInfo(tokenId: number): Promise<AssetInfo> {
  const map = await getAssetMap();
  const asset = map.get(tokenId);
  if (!asset) {
    throwBorosError(
      BorosErrorCode.INVALID_PARAMS,
      `Token ID ${tokenId} not found. Call get_assets to list valid tokenIds (deposit-eligible collaterals have positive tokenId; -1 is reserved for reward tokens).`,
    );
  }
  return asset;
}
