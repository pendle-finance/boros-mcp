import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichTimestamp, formatUsd6 } from '../../utils.js';
import { userAddressField } from '../_schemas.js';

import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';

export function registerAccountGasTools(server: McpServer) {
  server.registerTool(
    'get_gas_balance',
    {
      annotations: { readOnlyHint: true },
      description: 'Get your off-chain Boros gas budget (USD ledger). NOT Arbitrum L2 gas in ETH — this is a Mongo-backed USD balance the send-txs-bot debits when relaying agent-signed transactions. Per-wallet (per `root` EOA), not per-accountId. Backend rejects only when balance goes strictly negative; per-action cost is reported by get_gas_history. Top up: pay_gas (debits a marketAcc) or vault_pay_treasury (debits vault token balance). For Arbitrum L2 gwei see get_gas_price.',
      inputSchema: {
        userAddress: userAddressField(),
      },
    },
    withAuth(async ({ userAddress }) => {
      try {
        const response = await fetchWithRetry(() =>
          openApiGet('/v1/accounts/gas-balance', { root: userAddress }),
        );

        const balance = typeof response?.balanceInUSD === 'number' ? response.balanceInUSD : undefined;
        return jsonResult({
          ...response,
          ...(balance !== undefined ? { low: balance <= 0 } : {}),
          _context: {
            note: 'Off-chain Boros gas budget (USD). NOT Arbitrum L2 gas in ETH.',
            topUp: 'pay_gas (deducts from margin) or vault_pay_treasury (deducts from vault token balance).',
            relatedTools: 'get_gas_history (per-action ledger), get_gas_price (Arbitrum L2 gwei).',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );

  server.registerTool(
    'get_gas_history',
    {
      annotations: { readOnlyHint: true },
      description: 'Off-chain Boros gas budget consumption history (USD per action) — NOT Arbitrum L2 ETH gas. Shows gas fees paid for each agent-relayed action (Place order, Cancel, Deposit, Withdraw, Pay treasury, Enter market, etc.). Per-wallet (per `root` EOA), no accountId scoping. Use get_gas_balance for current balance, get_gas_price for L2 gwei. Top-up rows appear as actionType "Pay treasury (credit)".',
      inputSchema: {
        userAddress: userAddressField(),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe('Number of records to return (max 100)'),
        resumeToken: z
          .string()
          .optional()
          .describe('Cursor token from previous response for next page'),
      },
    },
    withAuth(async ({ userAddress, limit, resumeToken }) => {
      try {
        const data = await fetchWithRetry(() =>
          openApiGet('/v1/accounts/gas-consumption-history', {
            root: userAddress,
            limit: limit ?? 20,
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

        return jsonResult({
          count: history.length,
          gasHistory: history,
          ...(data.resumeToken ? { resumeToken: data.resumeToken } : {}),
          _context: {
            gasFeeUsd: 'Always non-negative USD (backend Math.abs on both `gasFee` and `gasFeeV2`). Sign of the budget impact is implied by `actionType` — entries containing "(credit)" (e.g. "Pay treasury (credit)") are top-ups, others are debits.',
            actionType: 'Action that consumed (or credited) gas — e.g. "Place order", "Cancel open orders", "Deposit to vault", "Pay treasury", "Pay treasury (credit)", "Enter market", "Exit market".',
            resumeToken: 'Pass as resumeToken to fetch the next page. Absent when there are no more results.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
