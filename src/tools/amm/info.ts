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
  // Always surfaced: a liquidated / withdraw-only pool must never look healthy by default.
  'disabled',
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
  'disabledAt',
  'disabledReason',
  'totalValue',
  'totalSupplyCap',
  'lpApy',
  'lpPrice',
] as const;

export function registerAmmInfoTools(server: McpServer): void {
  server.registerTool(
    'get_amm_info',
    {
      annotations: { readOnlyHint: true },
      description: 'Get the AMM (Automated Market Maker) swap-state for a market: total float / normalized-fixed reserves, LP token total supply, fee rate, current implied APR, rate bounds, maturity, cutoff, and whether the pool has been disabled (`disabled` is always returned — true means liquidated / withdraw-only, so the quoted impliedRate is frozen, not live). Vault economics (totalValue, totalSupplyCap, lpApy, lpPrice) ride on the same response — request them via include instead of a second call. Use get_vault_info for your own deposit position, fillPercent, or the all-vaults list. For order-book depth (including AMM liquidity merged at each tick), use get_orderbook with includeAmm=true. AMM is auto-routed by place_order when ammId is non-zero.',
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
          disabled: state.disabled ?? false,
          disabledAt: state.disabledAt,
          disabledReason: state.disabledReason,
        };
        const full = {
          ammId: result.ammId,
          marketId: result.marketId,
          ...(marketName ? { marketName } : {}),
          isPositive: result.isPositive,
          feeRate: result.feeRate,
          impliedRate: result.impliedRate,
          ...(result.impliedRate !== undefined ? { impliedRatePercent: `${(result.impliedRate * 100).toFixed(4)}%` } : {}),
          // Vault economics — same /v1/amm/states row, no extra HTTP call.
          totalValue: result.totalValue,
          totalSupplyCap: result.totalSupplyCap,
          lpApy: result.lpApy,
          lpPrice: result.lpPrice,
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
            disabled: 'true = this AMM has been shut down (e.g. liquidated) and is WITHDRAW-ONLY: add_liquidity is rejected by the backend (404 AMM_WITHDRAW_ONLY), remove_liquidity still works. When true, impliedRate/feeRate/reserves are FROZEN at shutdown — do NOT quote them as live prices. Independent of isCutOffReached: a pool can be disabled days before cutoff.',
            disabledAt: 'Unix seconds when the AMM was disabled (only present when disabled=true).',
            disabledReason: 'Free-form backend reason for the shutdown, e.g. "liquidated" (only present when disabled=true).',
            totalValue: 'Vault TVL as a raw bigint string in the BOROS-INTERNAL 18-DECIMAL cash unit — ALWAYS 1e18, NEVER token-native decimals. Divide by 1e18 to get whole collateral units; scaling by get_assets decimals overstates a 6-decimal-token vault by 1e12.',
            totalSupplyCap: 'Hard cap on LP supply (raw 18-decimal bigint string, same scale as totalLp). Minting is rejected once totalLp reaches it.',
            lpApy: 'Annualized LP yield (decimal, 0.05 = 5%), combined swap fees + Pendle incentives. NOT impliedRate — that is the marginal swap price.',
            lpPrice: 'Value of 1 LP token in WHOLE collateral units (plain number, from the latest snapshot; 0 before the first snapshot). So totalLp/1e18 * lpPrice ≈ totalValue/1e18.',
          }, includeSet, ['apr']),
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
