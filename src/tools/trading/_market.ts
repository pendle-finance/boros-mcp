// Market & account-state lookups for trading tools. Best-effort resolvers never throw on transient API hiccups.
import type { Address, Hex } from 'viem';
import { CROSS_MARKET_ID } from '../../config.js';
import { openApiGet } from '../../api/open-api.js';
import { packMarketAcc } from '../../chain/pack-account.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { dedupTtl } from '../../lib/dedup.js';
import { getAssetInfo } from '../../api/asset-cache.js';

// 30s TTL matches market-tools.fetchAllMarkets so get_markets→simulate→place skips refetch.
// Throws if marketId not found in paginated whitelisted list.
export async function getMarketInfo(marketId: number): Promise<any> {
  return dedupTtl('market-info', marketId, 30_000, async () => {
    let resumeToken: string | undefined;
    do {
      const res = await fetchWithRetry(() =>
        openApiGet('/v1/markets', {
          limit: 100,
          isUiWhitelisted: true,
          ...(resumeToken ? { resumeToken } : {}),
        }),
      );
      const list = res.results ?? [];
      const market = list.find((m: any) => m.marketId === marketId);
      if (market) return market;
      resumeToken = res.resumeToken ?? undefined;
    } while (resumeToken);
    throw new Error(`Market ${marketId} not found`);
  });
}

// Picks CROSS_MARKET_ID for cross, actual marketId for isolated.
export function resolveMarketAcc(
  root: Address,
  accountId: number,
  tokenId: number,
  marginMode: string | undefined,
  marketId: number,
): Hex {
  const effectiveMarketId =
    marginMode === 'isolated' ? marketId : CROSS_MARKET_ID;
  return packMarketAcc(root, accountId, tokenId, effectiveMarketId);
}

// Best-effort — falls back to undefined so sim echo never shows USDT on a WETH account.
export async function resolveCollateralSymbol(tokenId: number | undefined): Promise<string | undefined> {
  if (tokenId === undefined) return undefined;
  try {
    const asset = await getAssetInfo(tokenId);
    return asset?.symbol;
  } catch {
    return undefined;
  }
}

// Feeds signedSize+fixedApr into local closeTradePnl derivation. Best-effort, null on miss.
export async function resolveActivePosition(
  rootAddress: Address,
  accountId: number,
  marketId: number,
  marketAcc: Hex,
): Promise<any | null> {
  try {
    const positions = await fetchWithRetry(() =>
      openApiGet('/v1/accounts/active-positions', {
        root: rootAddress,
        accountId,
      }),
    );
    const posArray = Array.isArray(positions) ? positions : (positions.results ?? []);
    const lowerAcc = marketAcc.toLowerCase();
    return posArray.find((p: any) => p.marketId === marketId && p.marketAcc?.toLowerCase() === lowerAcc) ?? null;
  } catch {
    return null;
  }
}

// Newest resting orderIds post-place. Saves caller a get_limit_orders poll. Best-effort.
export async function resolveRecentOrderIds(
  userAddress: Address,
  accountId: number,
  marketId: number,
  expectedCount: number,
): Promise<string[] | undefined> {
  try {
    const data = await fetchWithRetry(() =>
      openApiGet('/v1/accounts/orders', {
        root: userAddress,
        accountId,
        marketId,
        isActive: true,
        // 2× headroom for concurrent placements + indexer flush; floor 10 for dup-id heuristic.
        limit: Math.max(expectedCount * 2, 10),
      }),
    );
    const results: any[] = data.results ?? (Array.isArray(data) ? data : []);
    // Backend sorts by placed-event desc; take newest N.
    return results
      .slice(0, expectedCount)
      .map((o: any) => String(o.orderId ?? ''))
      .filter((s) => s.length > 0);
  } catch {
    return undefined;
  }
}
