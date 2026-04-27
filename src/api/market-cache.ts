import { openApiGet } from '../api/open-api.js';
import { fetchWithRetry } from '../lib/fetch-retry.js';
import { dedupTtl } from '../lib/dedup.js';

// `name` optional — backend omits imData.marketName on many markets; conditionally spread at callsites.
export interface MarketInfo {
  name?: string;
  symbol: string;
  tokenId: number;
}

// 30s TTL shared w/ market-tools.fetchAllMarkets via dedupTtl key 'markets-all'.
const MARKET_CACHE_TTL_MS = 30_000;

export async function fetchMarketMap(): Promise<Map<number, MarketInfo>> {
  const map = new Map<number, MarketInfo>();
  try {
    const list = await dedupTtl('markets-all', {}, MARKET_CACHE_TTL_MS, async () => {
      const out: any[] = [];
      let resumeToken: string | undefined;
      do {
        const mkts = await fetchWithRetry(() =>
          openApiGet('/v1/markets', {
            limit: 100,
            isUiWhitelisted: true,
            ...(resumeToken ? { resumeToken } : {}),
          }),
        );
        out.push(...(mkts.results ?? []));
        resumeToken = mkts.resumeToken ?? undefined;
      } while (resumeToken);
      return out;
    });

    for (const m of list) {
      map.set(m.marketId, {
        ...(m.imData?.marketName ? { name: m.imData.marketName } : {}),
        symbol: m.metadata?.underlyingSymbol ?? '',
        tokenId: m.tokenId ?? 0,
      });
    }
  } catch { /* empty map */ }
  return map;
}
