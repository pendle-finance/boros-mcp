import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult, applyFilters, applySort } from '../../utils.js';
import {
  FilterConditionSchema,
  SortSchema,
  marketIdField,
  paginationLimitField,
  type FilterCondition,
} from '../_schemas.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { openApiGet } from '../../api/open-api.js';
import {
  flattenMarket,
  FLATTEN_MARKET_DEFAULT_FIELDS,
  FLATTEN_MARKET_OPTIONAL_FIELDS,
} from '../_shared/flatten-market.js';
import { fetchAllMarkets } from '../_shared/fetch-all-markets.js';
import { buildIncludeSet, projectFields, includeFieldSchema } from '../_shared/projection.js';

export function registerMarketsRegistryTools(server: McpServer): void {
  server.registerTool(
    'get_markets',
    {
      annotations: { readOnlyHint: true },
      description: `Unified market lookup. Two modes:

LIST MODE (no \`marketIds\`): list UI-whitelisted markets with optional filtering and sorting. Use to discover markets, compare volume/APR/OI, find by name/symbol. By default matures are hidden — set \`includeMatured:true\` to include. The cross-margin sentinel marketId 16777215 is never returned. Pass \`include:["all"]\` (or legacy \`fullDetail:true\`) to surface raw imData/config/metadata/extConfig/data per market.

ID MODE (\`marketIds\` set): bulk fetch by ID, preserves request order, dedups, INCLUDES matured markets. Returns missing IDs in the \`missing\` array (cause not distinguished — typo vs hidden). Maximum 100 IDs per request. Doubles as the batched top-of-book endpoint: each market carries \`bestBid\`, \`bestAsk\`, \`midApr\`, \`markApr\`, \`lastTradedApr\` when included. Prefer over N parallel get_orderbook calls. Markets flagged \`metadata.isWhitelisted = false\` are never returned.

When presenting results, ALWAYS include marketId alongside name/symbol — it's required for every follow-up tool. status values (on-chain MarketStatus, independent of maturity): 2 = "GOOD" (normal), 1 = "CLO" / "CLOSE_ONLY" (position-reducing orders only), 0 = "PAUSED" (no trading at all — fully halted).

Filterable fields (LIST mode): marketId, status, underlyingSymbol, fundingRateSymbol, volume24h, notionalOI, markApr, lastTradedApr, midApr, floatingApr, timeToMaturity, maturity. Filters operate on the underlying record — they work even when the field isn't in your \`include\` projection.
Sortable fields: marketId, volume24h, notionalOI, markApr, midApr, floatingApr, timeToMaturity.`,
      inputSchema: {
        marketIds: z
          .array(marketIdField())
          .min(1)
          .max(100)
          .optional()
          .describe('When provided, switches to ID mode (bulk fetch by ID, preserves order, dedups, includes matured). Max 100. Omit for LIST mode.'),
        filter: z.array(FilterConditionSchema).optional().describe('Filter conditions (LIST mode only).'),
        sort: SortSchema.optional().describe('Sort criteria (LIST mode only).'),
        limit: paginationLimitField({ max: 50, defaultValue: 20, desc: 'Max results to return (LIST mode only; default 20, max 50).' }),
        skip: z.number().min(0).default(0).describe('Pagination skip (LIST mode only).'),
        includeMatured: z.boolean().default(false).describe('Include markets past maturity (LIST mode only; default false).'),
        include: includeFieldSchema({
          defaults: FLATTEN_MARKET_DEFAULT_FIELDS,
          optional: FLATTEN_MARKET_OPTIONAL_FIELDS,
        }),
        fullDetail: z
          .boolean()
          .default(false)
          .describe('Legacy alias for include:["all"]. Adds raw imData/config/metadata/extConfig/data/state blocks. Default false.'),
      },
    },
    async ({ marketIds, filter, sort, limit, skip, includeMatured, include, fullDetail }) => {
      try {
        const effectiveInclude = fullDetail ? ['all'] : include;
        const includeSet = buildIncludeSet(
          effectiveInclude,
          FLATTEN_MARKET_DEFAULT_FIELDS,
          FLATTEN_MARKET_OPTIONAL_FIELDS,
        );

        if (marketIds !== undefined) {
          // Dedup → invariant `requested == returned + missing` holds.
          const uniqueIds = [...new Set(marketIds)];
          const res = await fetchWithRetry(() =>
            openApiGet('/v1/markets/by-ids', { marketIds: uniqueIds.join(',') }),
          );
          const rawMarkets = res.results ?? [];
          const markets = rawMarkets.map((m: any) => projectFields(flattenMarket(m), includeSet));
          const foundIds = new Set(rawMarkets.map((m: any) => m.marketId));
          const missing = uniqueIds.filter((id) => !foundIds.has(id));
          const inputDuplicates = marketIds.length - uniqueIds.length;
          return jsonResult({
            mode: 'byId',
            requested: uniqueIds.length,
            returned: markets.length,
            ...(inputDuplicates > 0 ? { inputDuplicates } : {}),
            missing,
            markets,
            ...(res.syncStatus ? { syncStatus: res.syncStatus } : {}),
            _context: {
              apr: APR_NOTE,
              volumeAndOi: '`volume24h` and `notionalOI` are denominated in YU (yield units, the same unit as orderbook size and trade size). Multiply by the collateral asset `usdPrice` from `get_assets` for an approximate USD notional.',
              note: 'Missing IDs (typo or non-whitelisted) appear in `missing` without distinguishing the cause. Cross-margin sentinel marketId 16777215 is not a tradable market.',
            },
          });
        }

        const rawMarkets = await fetchAllMarkets();
        const flattened = rawMarkets.map((m: any) => flattenMarket(m));

        let filtered = applyFilters(flattened, filter as FilterCondition[] | undefined);
        if (!includeMatured) {
          filtered = filtered.filter((m: any) => !m.isMatured);
        }
        filtered = applySort(filtered, sort);

        const paged = filtered.slice(skip, skip + limit);
        const projected = paged.map((m: any) => projectFields(m, includeSet));

        return jsonResult({
          mode: 'list',
          total: filtered.length,
          skip,
          limit,
          count: projected.length,
          hasMore: skip + projected.length < filtered.length,
          includeMatured: !!includeMatured,
          results: projected,
          _context: {
            apr: APR_NOTE,
            status: 'On-chain MarketStatus enum (independent of maturity): 2="GOOD" (normal), 1="CLO"/"CLOSE_ONLY" (position-reducing orders only), 0="PAUSED" (no trading — fully halted).',
            apys:
              'Four APR fields are emitted per market — markApr (TWAP fair value used for margin/liquidation), lastTradedApr (last fill on the orderbook; the dapp labels this "Implied APR"), midApr (book mid), floatingApr (the underlying perp funding rate; CEX or DEX venue per market). All decimals (0.05 = 5%).',
            volumeAndOi: '`volume24h` and `notionalOI` are denominated in YU (yield units, the same unit as orderbook size and trade size). Multiply by the collateral asset `usdPrice` from `get_assets` for an approximate USD notional.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
