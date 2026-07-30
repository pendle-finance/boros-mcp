import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichTimestamp, formatX18, asX18 } from '../../utils.js';
import { addressFieldOptional, marketIdField } from '../_schemas.js';
import { fetchMarketMap } from '../../api/market-cache.js';
import { safeAssetMap } from '../../api/asset-cache.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { dedupTtl } from '../../lib/dedup.js';

export function registerIncentivesMakerTools(server: McpServer): void {
  server.registerTool(
    'get_maker_incentives',
    {
      annotations: { readOnlyHint: true },
      description: 'Get maker incentive campaign data for a market: three tracks — per-side (long/short) add-liquidity PENDLE rewards, filled-volume epoch PENDLE rewards, and the maker-fee rebate. Boros currently rewards limit-order makers only; takers get nothing here. Denominations differ per track: the two incentive tracks pay PENDLE, while makerFeeRebate is denominated in the MARKET\'S COLLATERAL TOKEN — see the `rewardTokens` map in the response, do not assume one token for everything. Pass `maker` (your wallet) to populate currentEligibleShare, accumulatedReward and the rebate amounts; without it, those fields are 0. For prospective rewards on a draft order see place_order(mode:"simulate").makerIncentive.',
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
        // makerFeeRebate is collateral-denominated but the response carries no token id/symbol, so
        // resolve it here. Both maps are shared TTL caches (dedup keys 'markets-all' / 'assets')
        // already warmed by get_markets / get_positions, and both degrade to empty on failure.
        const [res, mktMap, assetMap] = await Promise.all([
          dedupTtl('maker-incentives', { marketId, maker: maker ?? '' }, 30_000, () =>
            fetchWithRetry(() =>
              openApiGet(`/v1/incentives/maker-incentives/campaigns/${marketId}`, {
                ...(maker ? { maker } : {}),
              }),
            ),
          ),
          fetchMarketMap(),
          safeAssetMap(),
        ]);
        const collateralTokenId = mktMap.get(marketId)?.tokenId;
        const collateralSymbol = collateralTokenId ? assetMap.get(collateralTokenId)?.symbol : undefined;
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
          rewardTokens: {
            addLiquidityIncentive: 'PENDLE',
            filledVolumeIncentive: 'PENDLE',
            makerFeeRebate: collateralSymbol
              ?? (collateralTokenId
                ? `market collateral token (tokenId ${collateralTokenId}) — call get_assets to resolve the symbol`
                : 'the market\'s collateral token — call get_markets for this market\'s tokenId, then get_assets'),
          },
          ...(collateralTokenId ? { collateralTokenId } : {}),
          addLiquidityIncentive,
          filledVolumeIncentive: res.filledVolumeIncentive,
          makerFeeRebate: res.makerFeeRebate,
          _context: {
            description: 'Maker rewards, three independent tracks: (1) addLiquidityIncentive — PENDLE budget for in-range resting liquidity, per side; (2) filledVolumeIncentive — PENDLE for filled maker volume this epoch; (3) makerFeeRebate — a share of the taker fee paid on fills of your resting orders, in the market\'s COLLATERAL token. Rewards are accumulated per-market; a maker active in N markets must call this N times.',
            rewardTokens: 'Per-track denomination. The two incentive tracks are PENDLE; makerFeeRebate.currentEpochRebate and .takerFeeContribution are in the market\'s collateral token. Never sum across tracks — they are different assets.',
            'addLiquidityIncentive.long/short.incentiveRange': 'ABSOLUTE APR half-width around mid APR, as a decimal (0.0116 = ±1.16% APR = ±116 bps). Use it directly — an order is in-range when |orderApr − midApr| <= incentiveRange. Do NOT multiply it by anything: the backend already scaled it by the market\'s max-deviation rate before storing, and consumes it as-is. 0 means no in-range window this hour (nothing qualifies). Long and short can differ — the backend widens the side that is short on depth.',
            'addLiquidityIncentive.long/short.budgetPerHour': 'PENDLE budget per hour for this side (uncapped target).',
            'addLiquidityIncentive.long/short.currentInRangeLiquidity': 'Raw FixedX18 (1e18) bigint string of in-range YU. Use the sibling currentInRangeLiquidityYu for a human-readable decimal.',
            'addLiquidityIncentive.long/short.currentInRangeLiquidityYu': 'In-range liquidity in YU (already divided by 1e18).',
            'addLiquidityIncentive.long/short.currentCappedDistributionPerHour': 'PENDLE actually distributed per hour (after cap) — use this for realised hourly emission.',
            'addLiquidityIncentive.long/short.currentEligibleShare': '0..1 fraction of this side\'s budget the maker is eligible for (multiply by 100 for percent). 0 if maker not provided.',
            'addLiquidityIncentive.long/short.accumulatedReward': 'PENDLE accumulated for this maker on this side IN THE CURRENT EPOCH ONLY (`epoch` above) — NOT lifetime. It RESETS to 0 at each epoch rollover, so do not present it as a career total or diff it across epoch boundaries. 0 if maker not provided.',
            'filledVolumeIncentive.userMakerVolume': 'User maker volume in current epoch (YU).',
            'filledVolumeIncentive.totalMakerVolume': 'Total maker volume in current epoch (YU).',
            'filledVolumeIncentive.totalEpochReward': 'PENDLE allocated to filled-volume reward this epoch.',
            'filledVolumeIncentive.avgRewardPerYu': 'PENDLE per YU = totalEpochReward / max(totalMakerVolume, 1).',
            'makerFeeRebate.feeShareRate': 'Fraction of the gross taker fee rebated to makers this epoch (0.2 = 20%). Market-level — populated even without `maker`.',
            'makerFeeRebate.currentEpochRebate': 'This maker\'s rebate accrued so far in the current epoch, in WHOLE units of the market\'s COLLATERAL token (see rewardTokens.makerFeeRebate) — not PENDLE, and not a raw 1e18 bigint. Resets each epoch. 0 if maker not provided.',
            'makerFeeRebate.takerFeeContribution': 'Gross taker fee paid on fills of this maker\'s resting orders this epoch — the base currentEpochRebate is computed from (rebate ≈ takerFeeContribution × feeShareRate). Same collateral-token unit. 0 if maker not provided.',
            takerNote: 'Boros currently rewards limit-order makers only; takers have no rewards program here.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
