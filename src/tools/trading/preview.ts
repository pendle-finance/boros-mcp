import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiPost } from '../../api/open-api.js';
import {
  jsonResult,
  parseSize,
  enrichAprValue,
  formatSize,
  formatX18,
} from '../../utils.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import {
  sideSchema,
  marketIdField,
  slippageField,
  timeInForceField,
} from '../_schemas.js';
import {
  tifString,
  limitAprWarning,
  SIDE_MAP,
  TIF_MAP,
  RESTING_TIFS,
  type SideStr,
} from './_helpers.js';
import { getMarketInfo, resolveCollateralSymbol } from './_market.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';

export function registerPreviewTools(server: McpServer) {
  server.registerTool(
    'simulate_place_order',
    {
      annotations: { readOnlyHint: true },
      description: `Preview a place-order WITHOUT a connected wallet. Returns matched size/cost/rate, margin required, price impact, fee breakdown, maker incentives, and the resolved tick/rate the order would snap to. No authentication or agent setup needed — use for quick order quotes before wallet connection.

UNITS: \`size\` is YU (yield units), ALWAYS POSITIVE — direction comes from \`side\` (LONG/SHORT). \`limitApr\` and \`slippage\` are DECIMALS (0.05 = 5%, NOT 5).

Use this tool when:
- User wants to estimate an order without connecting a wallet.
- Building a quote preview / order-entry UI.
- Exploring market depth or price impact for a given size.

For authenticated simulation with margin-mode, liquidation APR, and execution, use place_order(mode:'simulate') instead.`,
      inputSchema: {
        marketId: marketIdField(),
        side: sideSchema,
        size: z.string().describe('Notional size in YU (yield units), human-readable decimal (e.g. "1000.5"). ALWAYS POSITIVE — direction is set by `side`.'),
        orderType: z.enum(['market', 'limit']).describe('Order type. market → defaults to FOK; limit → defaults to GTC.'),
        limitApr: z.number().optional().describe('Limit APR as DECIMAL (0.05 = 5%). Required for limit orders; optional for market (rate guard).'),
        slippage: slippageField(),
        timeInForce: timeInForceField(),
        includeAmm: z.boolean().default(true).describe('true (default) = route via market AMM if one exists. false = orderbook-only.'),
      },
    },
    async ({ marketId, side, size, orderType, limitApr, slippage, timeInForce, includeAmm }) => {
      try {
        const market = await getMarketInfo(marketId);
        const tokenId: number = market.tokenId;
        const marketNameRaw: string | undefined = market.imData?.name;
        const marketSymbol: string | undefined = market.metadata?.underlyingSymbol;
        const collateralSymbol = await resolveCollateralSymbol(tokenId);
        const marketDefaultAmmId: number = market.extConfig?.ammId ?? market.metadata?.ammId ?? 0;
        const ammId: number = includeAmm ? marketDefaultAmmId : 0;

        const tif = tifString(orderType, timeInForce);

        const RESTING_TIFS_LOCAL = new Set(['GTC', 'ALO', 'SOFT_ALO']);
        if (orderType === 'market' && timeInForce !== undefined && RESTING_TIFS_LOCAL.has(timeInForce)) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            `timeInForce '${timeInForce}' requires orderType:'limit' with a limitApr. For market orders use 'FOK' (default) or 'IOC'.`,
          );
        }
        if (orderType === 'limit' && limitApr === undefined) {
          return errorContent(BorosErrorCode.INVALID_PARAMS, 'limitApr is required for limit orders');
        }

        const effectiveAmmId = (tif === 'ALO' || tif === 'SOFT_ALO') ? 0 : ammId;
        const effectiveSlippage = RESTING_TIFS.has(tif) ? undefined : slippage;

        const sizeRaw = parseSize(size).toString();
        const sideStr: SideStr = side;

        const sim = await fetchWithRetry(() =>
          openApiPost('/v1/simulations/place-order-anonymous', {
            marketId,
            side: SIDE_MAP[sideStr],
            size: sizeRaw,
            tif: TIF_MAP[tif],
            ...(limitApr !== undefined ? { rate: limitApr } : {}),
            ...(effectiveSlippage !== undefined ? { slippage: effectiveSlippage } : {}),
            ammId: effectiveAmmId,
          }),
        );

        const unit = collateralSymbol ?? 'token';
        const matchedSizeZero = sim.matched && Number(formatSize(sim.matched.size)) === 0;

        return jsonResult({
          ok: true,
          marketId,
          ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
          marketSymbol,
          simulation: {
            matched: sim.matched
              ? {
                  size: formatSize(sim.matched.size),
                  sizeUnit: 'YU',
                  cost: sim.matched.cost,
                  costUnit: unit,
                  rate: sim.matched.rate,
                  ...enrichAprValue(sim.matched.rate),
                }
              : sim.matched,
            marginRequired: formatX18(sim.marginRequired),
            marginRequiredUnit: unit,
            priceImpact: matchedSizeZero ? 0 : sim.priceImpact,
            priceImpactPercent: matchedSizeZero
              ? '0.00%'
              : sim.priceImpact !== undefined
                ? `${(sim.priceImpact * 100).toFixed(2)}%`
                : undefined,
            feeBreakdown: {
              ...(sim.feeBreakdown?.takerOtcFee != null
                ? { takerOtcFee: formatX18(sim.feeBreakdown.takerOtcFee), takerOtcFeeUnit: unit }
                : {}),
              ...(sim.feeBreakdown?.takerOtcFeeInUSD != null
                ? { takerOtcFeeInUSD: sim.feeBreakdown.takerOtcFeeInUSD }
                : {}),
            },
            makerOrderReward: sim.makerOrderReward,
            makerIncentive: sim.makerIncentive,
            resolved: sim.resolved
              ? {
                  ...sim.resolved,
                  actualRatePercent: enrichAprValue(sim.resolved.actualRate)?.aprPercent,
                  ...(sim.resolved.requestedRate != null
                    ? { requestedRatePercent: enrichAprValue(sim.resolved.requestedRate)?.aprPercent }
                    : {}),
                  ...(sim.resolved.desiredRate != null
                    ? { desiredRatePercent: enrichAprValue(sim.resolved.desiredRate)?.aprPercent }
                    : {}),
                }
              : undefined,
            side,
            orderType,
            timeInForce: tif,
            size,
            sizeUnit: 'YU',
            sizeRaw,
            ...(limitApr !== undefined
              ? {
                  limitApr,
                  limitAprPercent: enrichAprValue(limitApr)?.aprPercent,
                  ...(limitAprWarning(limitApr) ? { limitAprWarning: limitAprWarning(limitApr) } : {}),
                }
              : {}),
          },
          _context: { apr: APR_NOTE },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
