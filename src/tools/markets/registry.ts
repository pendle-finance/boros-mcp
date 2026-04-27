import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult, applyFilters, applySort } from '../../utils.js';
import {
  FilterConditionSchema,
  SortSchema,
  type FilterCondition,
} from '../_schemas.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { openApiGet } from '../../api/open-api.js';
import { flattenMarket } from '../_shared/flatten-market.js';
import { fetchAllMarkets } from '../_shared/fetch-all-markets.js';

export function registerMarketsRegistryTools(server: McpServer): void {
  server.registerTool(
    'get_markets',
    {
      annotations: { readOnlyHint: true },
      description: `List Boros markets with optional filtering and sorting (UI-whitelisted only).
Use this to discover available markets, compare volume, APR, open interest, or find a specific market by name/symbol.
Do NOT use this when you already know the marketId — use get_market (single) or get_markets_by_ids (batch). For per-market order book depth, use get_orderbook; for AMM swap state, use get_amm_info; for LP vault TVL/APY, use get_vault_info.

By default, matured markets are hidden. Set includeMatured=true to include them. The cross-margin sentinel marketId 16777215 is never a tradable market and is not returned here.

When presenting results to the user, ALWAYS include marketId alongside the market name/symbol — it is required for every follow-up tool (get_market, get_orderbook, get_market_trades, get_chart, simulate_order, place_order, place_orders, place_ladders, simulate_close, close_position, get_amm_info, etc.). Never show a market in a list, table, or summary without its marketId visible to the user.

status values (trading mode, independent of maturity): "GOOD" = normal trading, "CLOSE_ONLY" / "PAUSED" = position-reducing only. Maturity is a separate timestamp — check maturity / timeToMaturity / isMatured, not status.

Filterable fields: marketId, status, underlyingSymbol, fundingRateSymbol, volume24h, notionalOI, markApr, lastTradedApr, midApr, floatingApr, timeToMaturity, maturity.
Sortable fields: marketId, volume24h, notionalOI, markApr, midApr, floatingApr, timeToMaturity.`,
      inputSchema: {
        filter: z.array(FilterConditionSchema).optional().describe('Filter conditions to apply'),
        sort: SortSchema.optional().describe('Sort criteria'),
        limit: z.number().min(1).max(100).default(20).describe('Max results to return (default 20, max 100)'),
        skip: z.number().min(0).default(0).describe('Number of results to skip for pagination'),
        includeMatured: z.boolean().default(false).describe('Include markets past their maturity date (default false).'),
      },
    },
    async ({ filter, sort, limit, skip, includeMatured }) => {
      try {
        const rawMarkets = await fetchAllMarkets();
        const markets = rawMarkets.map((m: any) => flattenMarket(m));

        let filtered = applyFilters(markets, filter as FilterCondition[] | undefined);
        if (!includeMatured) {
          const nowSec = Math.floor(Date.now() / 1000);
          filtered = filtered.filter((m: any) => {
            const mat = m.maturity as number | undefined;
            return mat === undefined || mat > nowSec;
          });
        }
        filtered = applySort(filtered, sort);

        const paged = filtered.slice(skip, skip + limit);

        const nowSecForFlag = Math.floor(Date.now() / 1000);
        const enriched = paged.map((m: any) => ({
          ...m,
          isMatured: typeof m.maturity === 'number' ? m.maturity <= nowSecForFlag : false,
        }));

        return jsonResult({
          total: filtered.length,
          skip,
          limit,
          count: enriched.length,
          hasMore: skip + enriched.length < filtered.length,
          includeMatured: !!includeMatured,
          results: enriched,
          _context: {
            apr: APR_NOTE,
            status: 'Trading-mode enum: "GOOD" (normal), "CLOSE_ONLY" / "PAUSED" (reduce-only). Independent of maturity.',
            apys:
              'Four APR fields are emitted per market — markApr (TWAP fair value used for margin/liquidation), lastTradedApr (last fill on the orderbook; the dapp labels this "Implied APR"), midApr (book mid), floatingApr (the underlying funding-rate oracle). All decimals (0.05 = 5%).',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );

  server.registerTool(
    'get_market',
    {
      annotations: { readOnlyHint: true },
      description: `Get details for a single Boros market by ID. Returns the same fields as get_markets plus the raw imData/config/metadata/extConfig/data blocks under "full" mode.
Use this when you know the marketId. Matured and non-UI-whitelisted markets are reachable here (lookup is by direct id, not the UI-filtered list).
Do NOT use this to search — use get_markets with a filter instead. Note: marketId 16777215 is the cross-margin sentinel (CROSS_MARKET_ID) and is not a tradable market.`,
      inputSchema: {
        marketId: z
          .number()
          .int()
          .positive()
          .describe('The numeric market ID (positive integer; not a contract address).'),
      },
    },
    async ({ marketId }) => {
      try {
        // by-ids has no isUiWhitelisted filter → dev/test markets resolve via explicit ID.
        const res = await fetchWithRetry(() =>
          openApiGet('/v1/markets/by-ids', { marketIds: String(marketId) }),
        );
        const rawMarkets = res.results ?? [];
        const market = rawMarkets[0];

        if (!market) {
          const sentinelHint =
            marketId === 16777215
              ? ' Note: 16777215 is the cross-margin sentinel (CROSS_MARKET_ID), not a tradable market.'
              : '';
          return errorContent(
            BorosErrorCode.MARKET_NOT_FOUND,
            `Market ${marketId} not found.${sentinelHint}`,
          );
        }

        return jsonResult({
          ...flattenMarket(market, { full: true }),
          ...(res.syncStatus ? { syncStatus: res.syncStatus } : {}),
          _context: { apr: APR_NOTE },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );

  server.registerTool(
    'get_markets_by_ids',
    {
      annotations: { readOnlyHint: true },
      description: 'Get specific markets by ID in bulk, preserving request order. Unlike get_markets, this returns matured markets by direct lookup, but never returns markets flagged `metadata.isWhitelisted = false`. Missing IDs are returned in the `missing` array (cause not distinguished — typo vs hidden). Duplicate IDs are deduped before sending; pass each ID once. Maximum 100 IDs per request — chunk and call multiple times for >100. Doubles as the batched top-of-book endpoint: each market carries `bestBid`, `bestAsk`, `midApr`, `markApr`, `lastTradedApr` (all APR decimals). Prefer this over N parallel get_orderbook/get_market calls when scanning quotes across markets. Pass fullDetail=true to also include the raw imData/config/metadata/extConfig/data blocks per market.',
      inputSchema: {
        marketIds: z.array(z.number().int().positive()).min(1).max(100).describe('Market IDs to fetch (preserves input order; duplicates deduped server-side here).'),
        fullDetail: z.boolean().default(false).describe('Include raw imData/config/metadata/extConfig/data blocks per market (default false).'),
      },
    },
    async ({ marketIds, fullDetail }) => {
      try {
        // Dedup → invariant `requested == returned + missing` holds. [5,5,5] would otherwise be requested:3, returned:1.
        const uniqueIds = [...new Set(marketIds)];
        const res = await fetchWithRetry(() =>
          openApiGet('/v1/markets/by-ids', { marketIds: uniqueIds.join(',') }),
        );
        const rawMarkets = res.results ?? [];
        const markets = rawMarkets.map((m: any) => flattenMarket(m, { full: !!fullDetail }));
        const foundIds = new Set(rawMarkets.map((m: any) => m.marketId));
        const missing = uniqueIds.filter((id) => !foundIds.has(id));
        const inputDuplicates = marketIds.length - uniqueIds.length;
        return jsonResult({
          requested: uniqueIds.length,
          returned: markets.length,
          ...(inputDuplicates > 0 ? { inputDuplicates } : {}),
          missing,
          markets,
          ...(res.syncStatus ? { syncStatus: res.syncStatus } : {}),
          _context: {
            apr: APR_NOTE,
            note: 'Missing IDs (typo or non-whitelisted) appear in `missing` without distinguishing the cause.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
