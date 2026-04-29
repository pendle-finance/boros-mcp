import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichAprValue, enrichTimestamp } from '../../utils.js';
import { marketIdOptionalField, borosUnixTimestampField, paginationLimitField } from '../_schemas.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';

export function registerEventsLiquidationsTools(server: McpServer): void {
  server.registerTool(
    'get_liquidation_events',
    {
      annotations: { readOnlyHint: true },
      description: 'Get recent forced-liquidation events sorted newest-first. Each event shows the violator and liquidator positions before/after, mark APR at liquidation, the APR the liquidation trade executed at, the YU size moved, and the tx hash. Filter by market and/or time range. NOT the same as periodic funding settlements (use get_settlement_summary) and NOT a voluntary close (use get_transaction_history). For raw on-chain Liquidate logs see get_on_chain_events. Pagination (max 50 per call): to page older history, set toTimestamp = (oldest event timestamp from prior page) - 1.',
      inputSchema: {
        marketId: marketIdOptionalField('Filter by market.'),
        fromTimestamp: borosUnixTimestampField('fromTimestamp', 'Unix seconds inclusive lower bound.'),
        toTimestamp: borosUnixTimestampField('toTimestamp', 'Unix seconds inclusive upper bound.'),
        limit: paginationLimitField({ max: 50, defaultValue: 20 }),
      },
    },
    async ({ marketId, fromTimestamp, toTimestamp, limit }) => {
      try {
        const res = await fetchWithRetry(() =>
          openApiGet('/v1/events/liquidation-events', {
            ...(marketId !== undefined ? { marketId } : {}),
            ...(fromTimestamp !== undefined ? { fromTimestamp } : {}),
            ...(toTimestamp !== undefined ? { toTimestamp } : {}),
            limit,
          }),
        );
        const events = (res.liquidationEvents ?? []).map((e: any) => ({
          ...e,
          ...(e.timestamp ? { occurredAt: enrichTimestamp(e.timestamp) } : {}),
          ...(e.rate !== undefined ? { ratePercent: enrichAprValue(e.rate)?.aprPercent } : {}),
          ...(e.tradeRate !== undefined ? { tradeRatePercent: enrichAprValue(e.tradeRate)?.aprPercent } : {}),
        }));
        return jsonResult({
          count: events.length,
          events,
          _context: {
            apr: APR_NOTE,
            size: 'Signed size in YU (yield units), NOT USD. To convert YU to USD notional multiply by time-to-maturity in years (1 YU = 1 USD of yield exposure for 1 year), then by collateral USD price. abs(violator.prevPositionSize) - abs(violator.postPositionSize) gives the YU liquidated.',
            rate: 'Mark APR at liquidation (decimal, 0.085 = 8.5%). Boros markets quote APR not price — there is no "liquidation price" field.',
            tradeRate: 'APR at which the liquidation trade executed (decimal).',
            'violator/liquidator.prevPositionRate/postPositionRate': 'APR decimals (0.085 = 8.5%). Sign-aware. Currently NOT enriched with *Percent siblings — divide by 100 mentally.',
            'violator/liquidator.marketAcc': 'Packed bytes26 marketAcc — currently NOT decoded by this tool. Use the same encoding documented on get_portfolio_summary.accounts[i].marketAccDecoded.',
            count: 'May be < limit even when older liquidations exist; the upstream service drops events whose PnL join is incomplete. To page older, set toTimestamp = events[last].timestamp - 1 and re-call.',
            scope: 'Filter is by marketId + time range only. To find liquidations of a specific account, fetch by market and filter the violator.marketAcc client-side.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
