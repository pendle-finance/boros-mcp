import { openApiGet } from '../../api/open-api.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { dedupTtl } from '../../lib/dedup.js';

// 30s TTL eliminates refetch storms across get_markets → simulate_order → place_order in one turn.
export const MARKETS_CACHE_TTL_MS = 30_000;

export async function fetchAllMarkets(): Promise<any[]> {
  return dedupTtl('markets-all', {}, MARKETS_CACHE_TTL_MS, async () => {
    const results: any[] = [];
    let resumeToken: string | undefined;
    do {
      const res = await fetchWithRetry(() =>
        openApiGet('/v1/markets', {
          limit: 200,
          isUiWhitelisted: true,
          ...(resumeToken ? { resumeToken } : {}),
        }),
      );
      const page = res.results ?? [];
      results.push(...page);
      resumeToken = res.resumeToken ?? undefined;
    } while (resumeToken);
    return results;
  });
}
