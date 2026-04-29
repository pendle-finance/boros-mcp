import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichTimestamp, formatX18, asX18 } from '../../utils.js';
import { addressFieldOptional, marketIdField } from '../_schemas.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { dedupTtl } from '../../lib/dedup.js';

export function registerIncentivesMakerTools(server: McpServer): void {
  server.registerTool(
    'get_maker_incentives',
    {
      annotations: { readOnlyHint: true },
      description: 'Get maker incentive campaign data for a market: per-side (long/short) add-liquidity PENDLE rewards plus filled-volume epoch rewards. Boros currently rewards limit-order makers only; takers get nothing here. All rewards are paid in PENDLE (not the market\'s collateral token). Pass `maker` (your wallet) to populate currentEligibleShare and accumulatedReward; without it, those fields are 0. For prospective rewards on a draft order see place_order(mode:"simulate").makerIncentive.',
      inputSchema: {
        marketId: marketIdField(),
        maker: addressFieldOptional('maker', 'Maker wallet address (optional)'),
      },
    },
    async ({ marketId, maker }) => {
      try {
        if (marketId === 0xFFFFFF) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            'marketId 16777215 is the cross-margin sentinel (CROSS_MARKET_ID), not a tradable market. Pass a real marketId from get_markets.',
          );
        }
        const res = await dedupTtl('maker-incentives', { marketId, maker: maker ?? '' }, 30_000, () =>
          fetchWithRetry(() =>
            openApiGet(`/v1/incentives/maker-incentives/campaigns/${marketId}`, {
              ...(maker ? { maker } : {}),
            }),
          ),
        );
        // Emit decoded YU sibling so LLM doesn't quote raw FixedX18 21–25 digit numbers as YU.
        const enrichSide = (side: any) => {
          if (!side) return side;
          return {
            ...side,
            ...(typeof side.currentInRangeLiquidity === 'string'
              ? { currentInRangeLiquidityYu: formatX18(asX18(side.currentInRangeLiquidity)) }
              : {}),
          };
        };
        const addLiquidityIncentive = res.addLiquidityIncentive
          ? {
              long: enrichSide(res.addLiquidityIncentive.long),
              short: enrichSide(res.addLiquidityIncentive.short),
            }
          : res.addLiquidityIncentive;
        return jsonResult({
          marketId,
          ...(maker ? { maker } : {}),
          ...(res.epochTimestamp ? { epoch: enrichTimestamp(res.epochTimestamp) } : {}),
          rewardToken: 'PENDLE',
          addLiquidityIncentive,
          filledVolumeIncentive: res.filledVolumeIncentive,
          _context: {
            description: 'Maker rewards: PENDLE budget for in-range liquidity (per side) + filled-volume epoch rewards. Rewards are accumulated per-market; a maker active in N markets must call this N times.',
            rewardToken: 'All reward amounts are denominated in PENDLE token (not the market\'s collateral).',
            'addLiquidityIncentive.long/short.incentiveRange': 'Coefficient (NOT a direct APR offset). Effective tick range from mid APR is: incentiveRange × INCENTIVE_RANGE_FACTOR × max(midApr, marginThresh).',
            'addLiquidityIncentive.long/short.budgetPerHour': 'PENDLE budget per hour for this side (uncapped target).',
            'addLiquidityIncentive.long/short.currentInRangeLiquidity': 'Raw FixedX18 (1e18) bigint string of in-range YU. Use the sibling currentInRangeLiquidityYu for a human-readable decimal.',
            'addLiquidityIncentive.long/short.currentInRangeLiquidityYu': 'In-range liquidity in YU (already divided by 1e18).',
            'addLiquidityIncentive.long/short.currentCappedDistributionPerHour': 'PENDLE actually distributed per hour (after cap) — use this for realised hourly emission.',
            'addLiquidityIncentive.long/short.currentEligibleShare': '0..1 fraction of this side\'s budget the maker is eligible for (multiply by 100 for percent). 0 if maker not provided.',
            'addLiquidityIncentive.long/short.accumulatedReward': 'Lifetime PENDLE accumulated for this maker on this side (not just current epoch). 0 if maker not provided.',
            'filledVolumeIncentive.userMakerVolume': 'User maker volume in current epoch (YU).',
            'filledVolumeIncentive.totalMakerVolume': 'Total maker volume in current epoch (YU).',
            'filledVolumeIncentive.totalEpochReward': 'PENDLE allocated to filled-volume reward this epoch.',
            'filledVolumeIncentive.avgRewardPerYu': 'PENDLE per YU = totalEpochReward / max(totalMakerVolume, 1).',
            takerNote: 'Boros currently rewards limit-order makers only; takers have no rewards program here.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
