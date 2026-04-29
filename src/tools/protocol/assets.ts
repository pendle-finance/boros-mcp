import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { dedupTtl } from '../../lib/dedup.js';
import { MARKETS_CACHE_TTL_MS } from '../_shared/fetch-all-markets.js';
import { makeFilterSchema, makeSortSchema } from '../_schemas.js';
import { applyFilters, applySort } from '../../lib/collections.js';

const ASSETS_FILTER_FIELDS = ['tokenId', 'symbol', 'name', 'decimals', 'usdPrice'] as const;
const ASSETS_SORT_FIELDS = ['tokenId', 'decimals', 'usdPrice'] as const;

export function registerProtocolAssetsTools(server: McpServer): void {
  server.registerTool(
    'get_assets',
    {
      annotations: { readOnlyHint: true },
      description: `Get supported tokens registered on Boros (collateral + non-collateral entries), including token addresses, decimals, USD prices, and minimal metadata.
By default only deposit-eligible collaterals are returned (isCollateral=true, positive tokenId). Set includeNonCollateral=true to also list non-collateral entries: the PENDLE reward token plus market-underlying price refs (NVDA, XAU, SOL, oil, etc.). All non-collateral entries share tokenId = -1 (sentinel — not unique) and cannot be deposited as margin; identify them by address or symbol.
Use this to look up an asset's tokenId / decimals before depositing or signing transfers, or to fetch PENDLE/underlying-asset spot prices.`,
      inputSchema: {
        includeNonCollateral: z
          .boolean()
          .default(false)
          .describe('Include non-collateral entries (PENDLE reward token + market-underlying price refs like NVDA/XAU/SOL/oil). All share tokenId = -1 sentinel and cannot be deposited. Default false.'),
        filter: z
          .array(makeFilterSchema(ASSETS_FILTER_FIELDS))
          .optional()
          .describe('Filter conditions.'),
        sort: makeSortSchema(ASSETS_SORT_FIELDS).optional().describe('Sort criteria.'),
      },
    },
    async ({ includeNonCollateral, filter, sort }) => {
      try {
        const res = await dedupTtl('assets', {}, MARKETS_CACHE_TTL_MS, () =>
          fetchWithRetry(() => openApiGet('/v1/assets')),
        );

        const all = res.results ?? [];
        const eligible = includeNonCollateral ? all : all.filter((a: any) => a.isCollateral === true);
        const totalBeforeFilter = eligible.length;
        const filtered = applyFilters(eligible, filter);
        const sorted = applySort(filtered, sort);
        const filterApplied = filter !== undefined && filter.length > 0;
        return jsonResult({
          count: sorted.length,
          ...(filterApplied ? { totalBeforeFilter } : {}),
          totalIncludingNonCollateral: all.length,
          includeNonCollateral: !!includeNonCollateral,
          assets: sorted,
          _context: {
            description: 'Supported tokens. Only entries with isCollateral=true (and a positive tokenId) can be deposited as margin. tokenId=-1 is a shared sentinel for non-collateral entries: the PENDLE reward token (Merkle distributors) plus market-underlying price refs (NVDA/XAU/SOL/oil/etc., used for spot pricing only — not deposited).',
            fields: 'Each asset carries: id, address, tokenId, name, symbol, decimals, usdPrice (decimal string, USD spot), isCollateral, metadata.proSymbol. Use the returned tokenId — not symbol or address — when calling deposit/withdraw/place_order.',
            usdPrice: 'Spot USD price as a decimal string.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
