import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';

export function registerMarketsStrategiesTools(server: McpServer): void {
  server.registerTool(
    'get_strategies',
    {
      annotations: { readOnlyHint: true },
      description: `Get cross-market funding-rate arbitrage opportunities. Each row pairs two Boros markets on the same underlying asset — a longMarket leg (pay fixed, receive floating) and a shortMarket leg (receive fixed, pay floating) — that together capture the spread between two implied APRs.
Use this to discover two-leg arbitrage candidates. There is no on-chain "strategy" object — execution is two independent place_order calls (one per leg).
Do NOT confuse with vault strategies or saved trade templates. Filter passes (backend-side): aprTimesMaxLeverage > 0 AND daysToMaturity > 10.`,
      inputSchema: {},
    },
    async () => {
      try {
        const res = await fetchWithRetry(() => openApiGet('/v1/strategies'));
        const strategies = res.strategies ?? [];
        return jsonResult({
          count: res.totalCount ?? strategies.length,
          results: strategies,
          _context: {
            apr: APR_NOTE,
            description: 'Cross-market arbitrage candidates. Backend filter: aprTimesMaxLeverage > 0 AND daysToMaturity > 10. Sort: aprTimesMaxLeverage descending.',
            longMarket: 'Boros market to PAY fixed on (the long leg of the strategy). Quote it via place_order with side="long".',
            shortMarket: 'Boros market to RECEIVE fixed on (the short leg). Quote it via place_order with side="short".',
            impliedAprSpread: 'abs(impliedApr(longMarket) - impliedApr(shortMarket)). Decimal, ALWAYS >= 0 — the backend takes Math.abs and always assigns the LOWER-APR leg as longMarket, so this equals impliedApr(shortMarket) - impliedApr(longMarket). Never negative; do not read the sign as a direction.',
            aprTimesMaxLeverage: 'Indicative ROI at the strategy-wide max leverage, net of fees and Boros margin requirements. Decimal (0.10 = 10%).',
            maxPerpLeverage: 'Top-level field is the strategy-wide max leverage (calculateMaxPerpLeverage). longMarket.maxPerpLeverage / shortMarket.maxPerpLeverage are per-leg caps; use the top-level value when sizing the combined position. The top-level value is additionally hard-capped at 10 — it is min(10, longLeg, shortLeg) — so it reads 10 whenever both legs allow 10x or more, even if a leg advertises 100x.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
