import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { fetchAllMarkets } from '../_shared/fetch-all-markets.js';
import { buildIncludeSet, projectFields, projectContext, includeFieldSchema } from '../_shared/projection.js';
import { ammIdOptionalField, marketIdOptionalField } from '../_schemas.js';

const AMM_INFO_DEFAULT_FIELDS = [
  'ammId',
  'marketId',
  'marketName',
  'isPositive',
  'feeRate',
  'impliedRate',
  'impliedRatePercent',
] as const;
const AMM_INFO_OPTIONAL_FIELDS = [
  'state',
  'totalFloatAmount',
  'normFixedAmount',
  'totalLp',
  'minAbsRate',
  'maxAbsRate',
  'maturity',
  'seedTime',
  'cutOffTimestamp',
  'isCutOffReached',
  'latestFTime',
] as const;

export function registerAmmInfoTools(server: McpServer): void {
  server.registerTool(
    'get_amm_info',
    {
      annotations: { readOnlyHint: true },
      description: 'Get the AMM (Automated Market Maker) swap-state for a market: total float / normalized-fixed reserves, LP token total supply, fee rate, current implied APR, rate bounds, maturity, and cutoff. This is the swap-side math — NOT vault economics. For TVL, lpApy, lpPrice, supply cap, and your deposit, use get_vault_info. For order-book depth (including AMM liquidity merged at each tick), use get_orderbook with includeAmm=true. AMM is auto-routed by place_order when ammId is non-zero.',
      inputSchema: {
        marketId: marketIdOptionalField('Direct lookup key. Provide either marketId or ammId.'),
        ammId: ammIdOptionalField('Reverse-resolves to marketId via market list. Takes precedence over marketId if both provided.'),
        include: includeFieldSchema({
          defaults: AMM_INFO_DEFAULT_FIELDS,
          optional: AMM_INFO_OPTIONAL_FIELDS,
          describeExtra: 'state-block fields (totalFloatAmount, normFixedAmount, etc.) are lifted into the top-level when included.',
        }),
      },
    },
    async ({ marketId, ammId, include }) => {
      try {
        let resolvedMarketId = marketId;
        let resolvedAmmId = ammId;
        let marketName: string | undefined;

        if (resolvedMarketId === undefined && resolvedAmmId !== undefined) {
          const list = await fetchAllMarkets();
          const mkt = list.find(
            (m: any) =>
              m.extConfig?.ammId === resolvedAmmId || m.metadata?.ammId === resolvedAmmId,
          );
          if (!mkt) {
            return errorContent(
              BorosErrorCode.AMM_NOT_FOUND,
              `No market found with ammId ${resolvedAmmId}.`,
            );
          }
          resolvedMarketId = mkt.marketId;
          marketName = mkt.imData?.name;
        } else if (resolvedMarketId !== undefined) {
          const list = await fetchAllMarkets();
          const mkt = list.find((m: any) => m.marketId === resolvedMarketId);
          if (!mkt) {
            return errorContent(BorosErrorCode.MARKET_NOT_FOUND, `Market ${resolvedMarketId} not found`);
          }
          const mktAmmId = mkt.extConfig?.ammId ?? mkt.metadata?.ammId;
          marketName = mkt.imData?.name;
          if (mktAmmId === undefined || mktAmmId === 0) {
            return errorContent(
              BorosErrorCode.AMM_NOT_FOUND,
              `Market ${resolvedMarketId} has no AMM (ammId is ${mktAmmId ?? 'undefined'}). Use get_orderbook for order-book liquidity on this market.`,
            );
          }
        }

        if (resolvedMarketId === undefined) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            'Provide either marketId or ammId. Run get_markets to discover marketIds (and the ammId field on each market), or get_vault_info to list ammIds with their associated markets.',
          );
        }

        const data = await fetchWithRetry(() =>
          openApiGet('/v1/amm/states', { marketIds: String(resolvedMarketId) }),
        );

        const result = (data.results ?? [])[0];
        if (!result) {
          return errorContent(
            BorosErrorCode.AMM_NOT_FOUND,
            `No AMM state returned for market ${resolvedMarketId}.`,
          );
        }

        const state = result.state ?? {};
        const includeSet = buildIncludeSet(include, AMM_INFO_DEFAULT_FIELDS, AMM_INFO_OPTIONAL_FIELDS);
        const stateFlat = {
          totalFloatAmount: state.totalFloatAmount,
          normFixedAmount: state.normFixedAmount,
          totalLp: state.totalLp,
          minAbsRate: state.minAbsRate,
          maxAbsRate: state.maxAbsRate,
          maturity: state.maturity,
          seedTime: state.seedTime,
          cutOffTimestamp: state.cutOffTimestamp,
          isCutOffReached: state.isCutOffReached,
          latestFTime: state.latestFTime,
        };
        const full = {
          ammId: result.ammId,
          marketId: result.marketId,
          ...(marketName ? { marketName } : {}),
          isPositive: result.isPositive,
          feeRate: result.feeRate,
          impliedRate: result.impliedRate,
          ...(result.impliedRate !== undefined ? { impliedRatePercent: `${(result.impliedRate * 100).toFixed(4)}%` } : {}),
          state: stateFlat,
          ...stateFlat,
        };
        return jsonResult({
          ...projectFields(full, includeSet),
          _context: projectContext({
            apr: APR_NOTE,
            impliedRate: 'Current implied APR from AMM reserves (decimal, 0.05 = 5%). Marginal swap price — NOT the LP yield (lpApy from get_vault_info) and NOT the mark APR (markApr from get_markets).',
            feeRate: 'AMM swap fee rate as a 1e18-scaled bigint string. Divide by 1e18 to get a decimal (e.g. "500000000000000" → 0.0005 = 0.05%).',
            isPositive: 'AMM polarity: true = PositiveAMM (long-biased math class), false = NegativeAMM (short-biased). Determines which AMM math governs swap pricing — does NOT mean the APR sign is positive/negative.',
            totalFloatAmount: 'Floating-rate notional in the AMM pool (raw bigint string).',
            normFixedAmount: 'Fixed-rate notional, normalized by AMM math (raw bigint string).',
            totalLp: 'BOROS20 LP token total supply (always 18-decimal raw bigint string).',
            minAbsRate: 'Lower rate bound (1e18-scaled FixedX18 raw value, not basis points).',
            maxAbsRate: 'Upper rate bound (1e18-scaled FixedX18 raw value).',
            cutOffTimestamp: 'Unix seconds at which the AMM stops accepting new swaps; typically before maturity.',
          }, includeSet, ['apr']),
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
