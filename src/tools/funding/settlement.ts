import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiPost } from '../../api/open-api.js';
import { jsonResult, enrichAprValue, enrichTimestamp } from '../../utils.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { makeFilterSchema, makeSortSchema, marketIdField, unixTimestampField } from '../_schemas.js';
import { applyFilters, applySort } from '../../lib/collections.js';

const SETTLEMENT_FILTER_FIELDS = [
  'marketId', 'settlementApr', 'totalFee',
  'totalNotionalSize', 'totalSettledValue', 'periodTimestamp',
] as const;
const SETTLEMENT_SORT_FIELDS = [
  'marketId', 'settlementApr', 'totalFee',
  'totalNotionalSize', 'totalSettledValue', 'periodTimestamp',
] as const;

export function registerFundingSettlementTools(server: McpServer): void {
  server.registerTool(
    'get_settlement_summary',
    {
      annotations: { readOnlyHint: true },
      description: 'Get periodic funding-rate settlement aggregates (market-wide), one row per market per settlement bucket, sorted newest-first. Bucket cadence is per market (commonly 1h, 4h, or 8h — matches the upstream perp funding interval; resolve via the `periodTimestamp` deltas in the response). This is funding settlement, NOT market-maturity expiry settlement. Use get_pnl_history for a single account\'s funding paid/received; use get_market_indicators for upstream perp funding source rates per market; use get_pnl_by_market for live unrealized funding. Use this only for market-wide settlement history.',
      inputSchema: {
        marketIds: z.array(marketIdField()).optional().describe('Markets to include. Omit to include all.'),
        fromTimestamp: unixTimestampField('fromTimestamp', 'Start of range (Unix seconds; not milliseconds).'),
        toTimestamp: unixTimestampField('toTimestamp', 'End of range (Unix seconds; not milliseconds).'),
        filter: z
          .array(makeFilterSchema(SETTLEMENT_FILTER_FIELDS))
          .optional()
          .describe('Filter conditions. Filter on raw `settlementApr` (decimal), not the enriched `period`/`block` objects.'),
        sort: makeSortSchema(SETTLEMENT_SORT_FIELDS).optional().describe('Sort criteria. Default desc on `periodTimestamp` matches the existing newest-first server order.'),
      },
    },
    async ({ marketIds, fromTimestamp, toTimestamp, filter, sort }) => {
      try {
        if (toTimestamp < fromTimestamp) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            `toTimestamp (${toTimestamp}) must be >= fromTimestamp (${fromTimestamp}).`,
          );
        }
        const res = await fetchWithRetry(() =>
          openApiPost('/v1/funding-rate/settlement-summary', {
            ...(marketIds ? { marketIds } : {}),
            fromTimestamp,
            toTimestamp,
          }),
        );
        const fullRows = (res.settlementMarketSummaries ?? []).map((s: any) => ({
          ...s,
          settlementAprPercent: enrichAprValue(s.settlementApr)?.aprPercent,
          ...(s.periodTimestamp ? { period: enrichTimestamp(s.periodTimestamp) } : {}),
          ...(s.blockTimestamp ? { block: enrichTimestamp(s.blockTimestamp) } : {}),
        }));
        // Output blow-up guard. Unbounded calls (no marketIds, large window) can return ~30 markets
        // × 24+ hourly buckets ≈ 700 rows ≈ >100KB JSON, exceeding the MCP tool result token cap.
        // Refuse rather than truncating silently — caller should narrow `marketIds` or `to-from`.
        const ROW_LIMIT = 200;
        if (fullRows.length > ROW_LIMIT) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            `Result has ${fullRows.length} rows (>${ROW_LIMIT} limit) — would exceed MCP tool token cap. Narrow the query: pass \`marketIds\` to scope, or shrink the time range (toTimestamp − fromTimestamp = ${toTimestamp - fromTimestamp}s).`,
          );
        }
        const totalBeforeFilter = fullRows.length;
        const filtered = applyFilters(fullRows, filter);
        const summaries = applySort(filtered, sort);
        const filterApplied = filter !== undefined && filter.length > 0;
        return jsonResult({
          count: summaries.length,
          ...(filterApplied ? { totalBeforeFilter } : {}),
          fromTimestamp,
          toTimestamp,
          settlementMarketSummaries: summaries,
          _context: {
            apr: APR_NOTE,
            settlementApr: 'Annualized settlement APR (decimal, 0.085 = 8.5%).',
            totalFee: 'Total protocol fees at settlement, as a decoded decimal number in the market\'s collateral token (NOT a raw 18-dec bigint string — backend already calls .toNumber()).',
            totalNotionalSize: 'One-sided notional in YU (yield units), NOT USD. Backend halves the long+short sum so this equals the open-interest YU that participated in this settlement bucket. Convert to collateral via get_market.positionValue/positionSize.',
            totalSettledValue: 'Total value exchanged between longs and shorts, as a decoded decimal number in the market\'s collateral token (already halved like totalNotionalSize). NOT a raw 18-dec bigint.',
            sortOrder: 'periodTimestamp DESC (newest first). No pagination; bound your time range tightly.',
            whitelistFilter: 'Non-whitelisted and dev-test markets are excluded server-side; count may be less than marketIds.length × periods.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
