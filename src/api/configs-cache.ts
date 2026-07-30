import type { Address } from 'viem';
import { openApiGet } from '../api/open-api.js';
import { fetchWithRetry } from '../lib/fetch-retry.js';
import { CORE_API_URL } from '../config.js';

// 15-min per-root cache for /v1/configs. Global rarely changes; personalCoolDown override may
// extend mins-hours when account flagged by withdrawal-policy enforcement.
const GLOBAL_CONFIG_TTL_MS = 15 * 60 * 1000;

export interface GlobalConfigCacheEntry {
  value: GlobalConfigShape;
  expiresAt: number;
}
export interface GlobalConfigShape {
  coolDown?: number; // seconds
  personalCoolDown?: { coolDown?: number };
  exemptCLOMarkets?: { crossMarkets?: number[]; isolatedMarkets?: number[] };
}
const globalConfigCache = new Map<string, GlobalConfigCacheEntry>();

export async function fetchGlobalConfig(root: Address): Promise<GlobalConfigShape | null> {
  const key = root.toLowerCase();
  const now = Date.now();
  const hit = globalConfigCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  try {
    const res = (await fetchWithRetry(() =>
      openApiGet('/v1/configs', { root }, CORE_API_URL),
    )) as GlobalConfigShape;
    globalConfigCache.set(key, { value: res ?? {}, expiresAt: now + GLOBAL_CONFIG_TTL_MS });
    return res ?? {};
  } catch {
    // Don't cache failures — next withdraw retries.
    return null;
  }
}
