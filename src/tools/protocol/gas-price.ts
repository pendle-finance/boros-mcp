import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, formatUsd6 } from '../../utils.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';

export function registerProtocolGasPriceTools(server: McpServer): void {
  server.registerTool(
    'get_gas_price',
    {
      annotations: { readOnlyHint: true },
      description: `Get the current Arbitrum L2 gas price (gwei) and the estimated USD cost of placing a single non-AMM limit order on chain (assumes 374,758 gas units; cancel/settle/multi-order/AMM costs differ).
This is what the Boros bot wallet spends per transaction — NOT what the user is charged. Users pay an off-chain USD gas budget which is separate from the L2 gas price.
Do NOT use this to read the user's off-chain gas budget — use get_gas_balance for that. To top up the budget, use pay_gas. To see what was actually charged per past action, use get_gas_history. Do NOT use this for market pricing — see get_market / get_orderbook.`,
      inputSchema: {},
    },
    async () => {
      try {
        const gasData = await fetchWithRetry(() =>
          openApiGet('/v1/gas-price/current'),
        );

        const gwei = gasData.gasPriceWei
          ? Number((Number(gasData.gasPriceWei) / 1e9).toFixed(4))
          : undefined;
        const orderCostUsd = formatUsd6(gasData.estimatedOrderGasCostUsd);
        const stale = gwei === undefined && orderCostUsd === undefined;
        return jsonResult({
          gwei,
          orderCostUsd,
          ...(gasData.timestamp ? { timestamp: gasData.timestamp } : {}),
          // 374758 = median gas for a single non-AMM limit-order Router call (matches the Boros
          // backend poller and official UI).
          gasUnitsAssumed: 374758,
          ...(stale ? { note: 'Gas price data unavailable from backend (poller stale).' } : {}),
          _context: {
            unit: 'gwei (Arbitrum L2 gas price)',
            orderCostUnit: 'USD (single non-AMM limit order)',
            relatedTools: 'get_gas_balance (off-chain USD budget), pay_gas (top up), get_gas_history (per-action charges).',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
