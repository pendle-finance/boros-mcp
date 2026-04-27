import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { userAddressField } from '../_schemas.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function registerAmmRewardsTools(server: McpServer): void {
  server.registerTool(
    'get_amm_user_rewards',
    {
      annotations: { readOnlyHint: true },
      description: 'Get accrued and unclaimed LP-vault rewards (Boros amm_lp_rewards Merkle campaign) in USD for a wallet, summed across all vaults. Rewards come as PENDLE (incentive) plus the vault collateral token (swap fees); the USD figures here aggregate both. Distribution is weekly via Merkle-root publication (Thursdays); newly-deposited LPs may show $0 until the next root. Aggregation is per ROOT WALLET (not per accountId). Do NOT confuse with maker incentives (get_maker_incentives) or per-vault swap-fee/PENDLE breakdown (get_vault_info with marketId+userAddress).',
      inputSchema: {
        userAddress: userAddressField('Wallet address (0x...)').refine(
          (addr) => addr.toLowerCase() !== ZERO_ADDRESS,
          'userAddress cannot be the zero address',
        ),
      },
    },
    async ({ userAddress }) => {
      try {
        const res = await fetchWithRetry(() =>
          openApiGet('/v1/incentives/amm-incentives', { user: userAddress }),
        );
        return jsonResult({
          // Lowercase per backend + on-chain convention.
          userAddress: userAddress.toLowerCase(),
          accruedAmountInUsd: res.accruedAmountInUsd,
          unclaimedAmountInUsd: res.unclaimedAmountInUsd,
          unit: 'USD',
          perMarket: res.perMarket ?? [],
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
