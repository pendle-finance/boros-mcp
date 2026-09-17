import { type Address, createPublicClient, http, parseAbiItem } from 'viem';
import { arbitrum } from 'viem/chains';
import { fetchWithRetry } from '../lib/fetch-retry.js';
import { ARBITRUM_RPC, MARKET_HUB_ADDRESS } from '../config.js';

// 15-min per-root cache for the MarketHub cooldown reads. Global rarely changes; personalCoolDown
// override may extend mins-hours when account flagged by withdrawal-policy enforcement.
const GLOBAL_CONFIG_TTL_MS = 15 * 60 * 1000;

// resetPersonalCooldown() stores type(uint32).max, which the contract reads back as "no personal
// override — use globalCooldown". Normalise it or it surfaces as a 136-year cooldown.
const NO_PERSONAL_COOLDOWN = 4294967295;

const ABI_GLOBAL_COOLDOWN = parseAbiItem('function globalCooldown() view returns (uint32)');
const ABI_GET_PERSONAL_COOLDOWN = parseAbiItem(
  'function getPersonalCooldown(address userAddr) view returns (uint32)',
);

const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(ARBITRUM_RPC),
});

export interface GlobalConfigCacheEntry {
  value: GlobalConfigShape;
  expiresAt: number;
}
export interface GlobalConfigShape {
  coolDown?: number; // seconds
  personalCoolDown?: { coolDown?: number };
}
const globalConfigCache = new Map<string, GlobalConfigCacheEntry>();

export async function fetchGlobalConfig(root: Address): Promise<GlobalConfigShape | null> {
  const key = root.toLowerCase();
  const now = Date.now();
  const hit = globalConfigCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  try {
    const [coolDown, personalCoolDown] = await fetchWithRetry(() =>
      Promise.all([
        publicClient.readContract({
          address: MARKET_HUB_ADDRESS,
          abi: [ABI_GLOBAL_COOLDOWN],
          functionName: 'globalCooldown',
        }),
        publicClient.readContract({
          address: MARKET_HUB_ADDRESS,
          abi: [ABI_GET_PERSONAL_COOLDOWN],
          functionName: 'getPersonalCooldown',
          args: [root],
        }),
      ]),
    );
    const value: GlobalConfigShape = {
      coolDown,
      ...(personalCoolDown === NO_PERSONAL_COOLDOWN
        ? {}
        : { personalCoolDown: { coolDown: personalCoolDown } }),
    };
    globalConfigCache.set(key, { value, expiresAt: now + GLOBAL_CONFIG_TTL_MS });
    return value;
  } catch {
    // Don't cache failures — next withdraw retries.
    return null;
  }
}
