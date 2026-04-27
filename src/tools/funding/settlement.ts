import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiPost } from '../../api/open-api.js';
import { jsonResult, enrichAprValue, enrichTimestamp } from '../../utils.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';

export function registerFundingSettlementTools(server: McpServer): void {
  server.registerTool(
    'get_settlement_summary',
    {
      annotations: { readOnlyHint: true },
      description: 'Get hourly funding-rate settlement aggregates (market-wide), one row per market per hourly settlement bucket, sorted newest-first. This is funding settlement (periodic, hourly), NOT market-maturity expiry settlement. Use get_pnl_history for a single account\'s funding paid/received; use get_market_indicators for upstream CEX source rates per market; use get_pnl_by_market for live unrealized funding. Use this only for market-wide settlement history.',
      inputSchema: {
        marketIds: z.array(z.number()).optional().describe('Markets to include. Omit to include all.'),
        fromTimestamp: z.number().describe('Start of range (Unix seconds)'),
        toTimestamp: z.number().describe('End of range (Unix seconds)'),
      },
    },
    async ({ marketIds, fromTimestamp, toTimestamp }) => {
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
        const summaries = (res.settlementMarketSummaries ?? []).map((s: any) => ({
          ...s,
          settlementAprPercent: enrichAprValue(s.settlementApr)?.aprPercent,
          ...(s.periodTimestamp ? { period: enrichTimestamp(s.periodTimestamp) } : {}),
          ...(s.blockTimestamp ? { block: enrichTimestamp(s.blockTimestamp) } : {}),
        }));
        return jsonResult({
          count: summaries.length,
          fromTimestamp,
          toTimestamp,
          settlementMarketSummaries: summaries,
          _context: {
            apr: APR_NOTE,
            settlementApr: 'Annualized settlement APR (decimal, 0.085 = 8.5%).',
            totalFee: 'Total protocol fees at settlement, as a decoded decimal number in the market\'s collateral token (NOT a raw 18-dec bigint string — backend already calls .toNumber()).',
            totalNotionalSize: 'One-sided notional in YU (yield units), NOT USD. Backend halves the long+short sum so this equals the open-interest YU that participated in this hourly settlement. Convert to collateral via get_market.positionValue/positionSize.',
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
