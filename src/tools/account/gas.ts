import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichTimestamp, formatUsd6 } from '../../utils.js';
import { userAddressFieldOptional, paginationLimitField } from '../_schemas.js';

import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { requireAuth } from '../../agent/require-auth.js';

async function fetchPrice() {
  const gasData = await fetchWithRetry(() => openApiGet('/v1/gas-price/current'));
  const gwei = gasData.gasPriceWei
    ? Number((Number(gasData.gasPriceWei) / 1e9).toFixed(4))
    : undefined;
  const orderCostUsd = formatUsd6(gasData.estimatedOrderGasCostUsd);
  const stale = gwei === undefined && orderCostUsd === undefined;
  return {
    gwei,
    orderCostUsd,
    ...(gasData.timestamp ? { timestamp: gasData.timestamp } : {}),
    // 374758 = median gas for a single non-AMM limit-order Router call.
    gasUnitsAssumed: 374758,
    ...(stale ? { note: 'Gas price data unavailable from backend (poller stale).' } : {}),
  };
}

async function fetchBalance(userAddress: string) {
  const response = await fetchWithRetry(() =>
    openApiGet('/v1/accounts/gas-balance', { root: userAddress }),
  );
  const balance = typeof response?.balanceInUSD === 'number' ? response.balanceInUSD : undefined;
  return {
    ...response,
    ...(balance !== undefined ? { low: balance <= 0 } : {}),
  };
}

async function fetchHistory(userAddress: string, limit: number, resumeToken?: string) {
  const data = await fetchWithRetry(() =>
    openApiGet('/v1/accounts/gas-consumption-history', {
      root: userAddress,
      limit,
      ...(resumeToken ? { resumeToken } : {}),
    }),
  );
  const results = data.results ?? (Array.isArray(data) ? data : []);
  const history = results.map((r: any) => {
    const { gasFee, chainId, ...rest } = r;
    return {
      ...rest,
      gasFeeUsd: gasFee !== undefined && gasFee !== null ? formatUsd6(gasFee) : gasFee,
      ...(r.blockTimestamp ? { timestamp: enrichTimestamp(r.blockTimestamp) } : {}),
    };
  });
  return {
    count: history.length,
    gasHistory: history,
    ...(data.resumeToken ? { resumeToken: data.resumeToken } : {}),
  };
}

export function registerAccountGasTools(server: McpServer) {
  server.registerTool(
    'get_gas_info',
    {
      annotations: { readOnlyHint: true },
      description: `Unified gas read. Combines: off-chain Boros gas BUDGET (USD ledger debited by send-txs-bot), per-action gas HISTORY (USD), and Arbitrum L2 gas PRICE (gwei + USD per non-AMM limit order).

The BUDGET is per-wallet (per \`root\` EOA), NOT per-accountId; backend rejects only when balance goes strictly negative. Top up: pay_gas (debits margin) or vault_pay_treasury (debits wallet token balance). The L2 PRICE is what the bot wallet pays per tx, NOT what the user is charged.

\`scope\` selects what to return:
- 'all' (default): { budget, history (latest \`limit\`), price } — needs userAddress.
- 'balance': budget only — needs userAddress.
- 'history': per-action ledger only — needs userAddress.
- 'price': L2 gwei + per-order USD only — public, no userAddress required.

History rows containing actionType "(credit)" (e.g. "Pay treasury (credit)") are top-ups; others are debits.`,
      inputSchema: {
        scope: z
          .enum(['all', 'balance', 'history', 'price'])
          .default('all')
          .describe('Which gas reads to return. Default "all".'),
        userAddress: userAddressFieldOptional(
          'Required when scope is "all", "balance", or "history". Ignored for "price".',
        ),
        limit: paginationLimitField({ max: 50, defaultValue: 20, desc: 'Number of history records to return (max 50). Used only when scope is "all" or "history".' }),
        resumeToken: z
          .string()
          .optional()
          .describe('Cursor token from previous response for next page of history.'),
      },
    },
    async ({ scope, userAddress, limit, resumeToken }) => {
      try {
        const needsAuth = scope !== 'price';
        let resolvedUser = userAddress;
        if (needsAuth) {
          const auth = await requireAuth();
          if (!auth.ok) return auth.error;
          resolvedUser = resolvedUser ?? auth.rootAddress;
        }

        if (scope === 'price') {
          return jsonResult({
            ...(await fetchPrice()),
            _context: {
              unit: 'gwei (Arbitrum L2 gas price)',
              orderCostUnit: 'USD (single non-AMM limit order)',
              relatedScopes: 'scope:"balance" for off-chain USD budget; scope:"history" for per-action charges.',
            },
          });
        }

        if (!resolvedUser) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            'userAddress is required when scope is "all", "balance", or "history".',
          );
        }

        if (scope === 'balance') {
          return jsonResult({
            ...(await fetchBalance(resolvedUser)),
            _context: {
              note: 'Off-chain Boros gas budget (USD). NOT Arbitrum L2 gas in ETH.',
              topUp: 'pay_gas (deducts from margin) or vault_pay_treasury (deducts from wallet token balance).',
              relatedScopes: 'scope:"history" for per-action ledger; scope:"price" for L2 gwei.',
            },
          });
        }

        if (scope === 'history') {
          return jsonResult({
            ...(await fetchHistory(resolvedUser, limit, resumeToken)),
            _context: {
              gasFeeUsd:
                'Always non-negative USD. Sign of the budget impact is implied by `actionType` — entries containing "(credit)" are top-ups, others are debits.',
              actionType:
                'Action that consumed (or credited) gas — e.g. "Place order", "Cancel open orders", "Deposit to vault", "Pay treasury", "Pay treasury (credit)", "Enter market", "Exit market".',
              resumeToken: 'Pass as resumeToken to fetch the next page. Absent when there are no more results.',
            },
          });
        }

        // scope === 'all'
        const [budget, history, price] = await Promise.all([
          fetchBalance(resolvedUser),
          fetchHistory(resolvedUser, limit, resumeToken),
          fetchPrice(),
        ]);
        return jsonResult({
          budget,
          history,
          price,
          _context: {
            budget: 'Off-chain Boros gas budget (USD). NOT Arbitrum L2 gas in ETH.',
            history: 'Per-action ledger. "(credit)" actionTypes are top-ups; others are debits.',
            price: 'Arbitrum L2 gwei + estimated USD cost of a single non-AMM limit order.',
            topUp: 'pay_gas (deducts from margin) or vault_pay_treasury (deducts from wallet token balance).',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
