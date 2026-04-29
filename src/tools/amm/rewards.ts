import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { userAddressField, makeFilterSchema, makeSortSchema } from '../_schemas.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { applyFilters, applySort } from '../../lib/collections.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const AMM_REWARDS_FILTER_FIELDS = ['marketId', 'unclaimedRewards'] as const;
const AMM_REWARDS_SORT_FIELDS = ['marketId', 'unclaimedRewards'] as const;

export function registerAmmRewardsTools(server: McpServer): void {
  server.registerTool(
    'get_amm_user_rewards',
    {
      annotations: { readOnlyHint: true },
      description: 'Get accrued and unclaimed LP-vault rewards (Boros amm_lp_rewards Merkle campaign) in USD for a wallet, summed across all vaults. Rewards come as PENDLE (incentive) plus the vault collateral token (swap fees); the USD figures here aggregate both. Distribution is weekly via Merkle-root publication (Thursdays); newly-deposited LPs may show $0 until the next root. Aggregation is per ROOT WALLET (not per accountId). Do NOT confuse with maker incentives (get_maker_incentives) or per-vault swap-fee/PENDLE breakdown (get_vault_info with marketId+userAddress).',
      inputSchema: {
        userAddress: userAddressField().refine(
          (addr) => addr.toLowerCase() !== ZERO_ADDRESS,
          'userAddress cannot be the zero address',
        ),
        filter: z
          .array(makeFilterSchema(AMM_REWARDS_FILTER_FIELDS))
          .optional()
          .describe('Filter conditions applied to `perMarket[]` only — top-level USD totals are unchanged. Nested `allTimeRewards.*` fields are not addressable.'),
        sort: makeSortSchema(AMM_REWARDS_SORT_FIELDS).optional().describe('Sort criteria for `perMarket[]`.'),
      },
    },
    async ({ userAddress, filter, sort }) => {
      try {
        const res = await fetchWithRetry(() =>
          openApiGet('/v1/incentives/amm-incentives', { user: userAddress }),
        );
        const perMarketAll = res.perMarket ?? [];
        const filteredPerMarket = applyFilters(perMarketAll, filter);
        const sortedPerMarket = applySort(filteredPerMarket, sort);
        const filterApplied = filter !== undefined && filter.length > 0;
        return jsonResult({
          userAddress: userAddress.toLowerCase(),
          accruedAmountInUsd: res.accruedAmountInUsd,
          unclaimedAmountInUsd: res.unclaimedAmountInUsd,
          unit: 'USD',
          ...(filterApplied ? { perMarketTotalBeforeFilter: perMarketAll.length } : {}),
          perMarket: sortedPerMarket,
          _context: {
            accruedAmountInUsd: 'Cumulative lifetime accrued in USD as of the most recently published Merkle root (typically updated weekly).',
            unclaimedAmountInUsd: 'Total accrued minus what has already been pulled on-chain via MultiTokenMerkleDistributor.claim.',
            campaign: 'amm_lp_rewards Merkle campaign. Tokens distributed: PENDLE (incentive) + vault collateral token (swap fees).',
            perMarket:
              'Per-market breakdown for AMMs the user has activity in. Each entry: { marketId, unclaimedRewards (bigint string in collateral units), allTimeRewards: { pendleRewards (number, PENDLE), swapFeeRewards (number, collateral asset) } }.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
