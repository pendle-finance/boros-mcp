import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiGet, openApiPost } from '../../api/open-api.js';
import { type IntentExpectation } from '../../agent/signing.js';
import { ROUTER_SELECTORS } from '../../chain/selectors.js';
import {
  jsonResult,
  parseSize,
  enrichAprValue,
} from '../../utils.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import {
  sideSchema,
  marketIdField,
  slippageField,
  marginModeField,
  timeInForceField,
} from '../_schemas.js';
import {
  tryBigInt,
  tifString,
  limitAprWarning,
  TIF_MAP,
  SIDE_MAP,
  type SideStr,
} from './_helpers.js';
import {
  getMarketInfo,
  resolveMarketAcc,
  resolveCollateralSymbol,
  snapshotActiveOrderIds,
  resolveRecentOrderIdsSinceSnapshot,
} from './_market.js';
import {
  executeAgentAction,
  extractCalldatas,
  extractTxHash,
  executionErrorContent,
  assertSimSucceeded,
  assertPriceImpactWithinSlippage,
} from './_execute.js';
import { buildSimEcho } from './_sim-echo.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';

export function registerOrderTools(server: McpServer) {
  server.registerTool(
    'place_order',
    {
      annotations: { destructiveHint: true },
      description: `Simulate or execute an order on a Boros market. Default mode is 'simulate' — ALWAYS run mode:'simulate' first, show the preview to the user, then ONLY call mode:'execute' AFTER explicit user confirmation. The execute path re-runs the simulation internally before signing; calldata uses the current mid-rate at execute-time, so re-simulate after any meaningful delay.

UNITS: \`size\` is YU (yield units), ALWAYS POSITIVE — direction comes from \`side\` (LONG/SHORT). NEVER sign size to indicate short. \`limitApr\` and \`slippage\` are DECIMALS (0.05 = 5%, NOT 5). \`marginMode:'cross'\` = per-token shared bucket (across all entered markets for that token); \`'isolated'\` = per-market subaccount. The actual encoded rate may snap by up to half a tick (LONG rounds DOWN, SHORT rounds UP).

WORKFLOW for a new trade:
1. If user gave a market name, resolve marketId via get_markets.
2. Ask for missing info: side, size, order type, limitApr if limit.
3. Call mode:'simulate' to preview.
4. If user confirms, call mode:'execute' with the SAME params.

If execute fails with "Insufficient gas balance", top up via pay_gas first.`,
      inputSchema: {
        mode: z
          .enum(['simulate', 'execute'])
          .default('simulate')
          .describe(
            '"simulate" (default): preview only — fill, margin, price impact, liquidation APR. "execute": re-simulate, then sign and submit via the agent key. ALWAYS simulate first; execute requires explicit user confirmation.',
          ),
        marketId: marketIdField(),
        side: sideSchema,
        size: z.string().describe('Notional size in YU (yield units), human-readable decimal (e.g. "1000.5"). ALWAYS POSITIVE — direction is set by `side`, never by signing size.'),
        orderType: z.enum(['market', 'limit']).describe('Order type. market → defaults to FOK (all-or-nothing); limit → defaults to GTC (rests on book).'),
        limitApr: z.number().optional().describe('Limit APR as DECIMAL (0.05 = 5%, NOT 5). Required for orderType:"limit"; optional for "market" (acts as a rate guard with IOC). Values exceeding max(1, |markApr|*5) for the target market require acknowledgeHighRate:true — markets that already trade at extreme APR (oil at –117%, etc.) accept commensurate values without ack.'),
        marginMode: marginModeField(),
        slippage: slippageField('MUST match between simulate and execute — different values produce a different desiredRate, so the execute can reject on PRICE_IMPACT_TOO_HIGH even if the simulate succeeded.'),
        timeInForce: timeInForceField(),
        acknowledgeHighRate: z.boolean().default(false).describe('Required when |limitApr| exceeds max(1, |markApr|*5) for the target market. The floor scales with each market\'s current markApr — typical 5%-mark books reject limitApr:5 (= 500%) as a percent-vs-decimal typo, while markets quoting 80%+ APR accept commensurate values without ack.'),
      },
    },
    withAuth(async ({ mode, marketId, side, size, orderType, limitApr, marginMode, slippage, timeInForce, acknowledgeHighRate }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        const market = await getMarketInfo(marketId);
        const tokenId: number = market.tokenId;
        const marketNameRaw: string | undefined = market.imData?.name;
        const marketSymbol: string | undefined = market.metadata?.underlyingSymbol;
        const collateralSymbol = await resolveCollateralSymbol(tokenId);
        const ammId: number = market.extConfig?.ammId ?? market.metadata?.ammId ?? 0;

        // TIF↔orderType compatibility: GTC/ALO/SOFT_ALO need a rate (resting limit semantics);
        // a "market" order with one of these TIFs is contradictory. Catch here so the user gets
        // an actionable error instead of the misleading backend "rate is required for limit orders".
        const RESTING_TIFS_LOCAL = new Set(['GTC', 'ALO', 'SOFT_ALO']);
        if (orderType === 'market' && timeInForce !== undefined && RESTING_TIFS_LOCAL.has(timeInForce)) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            `timeInForce '${timeInForce}' requires orderType:'limit' with a limitApr. For market orders use 'FOK' (default) or 'IOC' (with limitApr as a rate guard).`,
          );
        }
        if (orderType === 'limit' && limitApr === undefined) {
          return errorContent(BorosErrorCode.INVALID_PARAMS, 'limitApr is required for limit orders');
        }
        // Scale the typo gate by the market's own markApr — e.g. an oil market that already
        // trades at –117% should accept limitApr:1.2 without a percent-vs-decimal warning,
        // while a USDT-funding market at 5% markApr should reject limitApr:5 (= 500%).
        // Threshold: |limitApr| > max(1, |markApr| * 5) requires explicit acknowledgeHighRate.
        // /v1/markets rows nest live stats under .data (MarketListItemResponse.data.markApr).
        // Fall back to flattened/legacy positions in case the upstream shape ever changes.
        const markAprRaw =
          market?.data?.markApr ?? market?.markApr ?? market?.stats?.markApr;
        const markApr: number | undefined =
          typeof markAprRaw === 'number' && Number.isFinite(markAprRaw) ? markAprRaw : undefined;
        const HIGH_RATE_FLOOR = Math.max(1, Math.abs(markApr ?? 0) * 5);
        if (limitApr !== undefined && Math.abs(limitApr) > HIGH_RATE_FLOOR && !acknowledgeHighRate) {
          const markStr = markApr !== undefined ? `${(markApr * 100).toFixed(2)}%` : 'unknown';
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            `limitApr=${limitApr} (${(limitApr * 100).toFixed(2)}%) is >${(HIGH_RATE_FLOOR * 100).toFixed(0)}% APR while market markApr is ${markStr} — likely a percent-vs-decimal typo (API expects DECIMAL: 0.05 = 5%). If intentional, re-call with acknowledgeHighRate:true. To trade at ${limitApr}% instead, pass limitApr:${limitApr / 100}.`,
          );
        }

        const marketAcc = resolveMarketAcc(rootAddress, accountId, tokenId, marginMode, marketId);
        const sizeRaw = parseSize(size).toString();
        const sideStr: SideStr = side;
        const tif = tifString(orderType, timeInForce);
        // ALO/SOFT_ALO cannot route through AMM — backend strips ammId, so calldata-builder
        // and intent must agree on 0 to avoid a verifier mismatch.
        const effectiveAmmId = (tif === 'ALO' || tif === 'SOFT_ALO') ? 0 : ammId;

        const sim = await fetchWithRetry(() =>
          openApiPost('/v1/simulations/place-order', {
            marketAcc,
            marketId,
            side: SIDE_MAP[sideStr],
            size: sizeRaw,
            tif: TIF_MAP[tif],
            ...(limitApr !== undefined ? { rate: limitApr } : {}),
            slippage,
            ammId: effectiveAmmId,
          }),
        );

        if (mode === 'simulate') {
          // execute re-simulates seconds later → often PRICE_IMPACT_TOO_HIGH on same params;
          // surface a structured signal so LLM can widen slippage before mode:'execute'.
          const priceImpactNearSlippage =
            typeof sim.priceImpact === 'number' && Math.abs(sim.priceImpact) > slippage * 0.8;

          return jsonResult({
            ok: true,
            mode: 'simulate',
            marketId,
            ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
            marketSymbol,
            simulation: {
              ...buildSimEcho(sim, { includeStatus: true, includeLongYield: true, collateralSymbol }),
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
              ...(priceImpactNearSlippage
                ? {
                    priceImpactNearSlippage: true,
                    priceImpactWarning: `Simulated price impact ${((sim.priceImpact as number) * 100).toFixed(2)}% is close to slippage tolerance ${(slippage * 100).toFixed(2)}%. Consider raising slippage before mode:'execute'.`,
                  }
                : {}),
            },
            nextTool: {
              tool: 'place_order',
              params: { mode: 'execute', marketId, side, size, orderType, limitApr, marginMode, slippage, timeInForce },
              instruction: 'If the user confirms, call place_order with mode:"execute" and the SAME params to submit the trade.',
            },
            _context: { apr: APR_NOTE },
          });
        }

        // mode === 'execute'
        const simErr = assertSimSucceeded(sim, {
          variant: 'order',
          isMarketOrder: orderType === 'market',
        });
        if (simErr) return simErr;
        const impactErr = assertPriceImpactWithinSlippage(sim, slippage, { variant: 'order' });
        if (impactErr) return impactErr;

        // Reject pre-tx — saves gas, surfaces NO_FILL not generic revert.
        const matchedSize = sim.matched?.size ? BigInt(sim.matched.size) : 0n;
        if ((tif === 'IOC' || tif === 'FOK') && matchedSize === 0n) {
          return errorContent(
            BorosErrorCode.NO_FILL,
            `${tif} order would not fill at the given rate guard (matched.size=0). Widen limitApr or switch to GTC.`,
          );
        }

        // Pre-flight gas check; threshold <=0 matches send-txs-bot. On lookup failure, fall through.
        try {
          const gas = await fetchWithRetry(() =>
            openApiGet('/v1/accounts/gas-balance', { root: rootAddress }),
          );
          const balanceInUSD = typeof gas?.balanceInUSD === 'number' ? gas.balanceInUSD : undefined;
          if (balanceInUSD !== undefined && balanceInUSD <= 0) {
            return errorContent(
              BorosErrorCode.INSUFFICIENT_GAS,
              `Off-chain gas budget is ${balanceInUSD} USD — send-txs-bot will reject. Top up via pay_gas first.`,
              {
                nextTool: {
                  name: 'pay_gas',
                  args: { marketId, marginMode, amount: 1 },
                  why: 'Pre-flight check failed: gas budget exhausted. Top up before retrying place_order. `amount` is USD; raise it for more headroom.',
                },
              },
            );
          }
        } catch {
          // Swallow — bot surfaces INSUFFICIENT_GAS if needed.
        }

        const calldataRes = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/agent/place-order', {
            marketAcc,
            marketId,
            side: SIDE_MAP[sideStr],
            size: sizeRaw,
            tif: TIF_MAP[tif],
            ...(limitApr !== undefined ? { rate: limitApr } : {}),
            slippage,
            ammId: effectiveAmmId,
          }),
        );
        const calldatas = extractCalldatas(calldataRes);

        // PIN marketId, NOT marketAcc — OrderReq.marketId is real uint24 (not cross-sentinel);
        // cross is separate OrderReq.cross. Pinning marketAcc (encodes CROSS_MARKET_ID) would
        // false-positive every cross call. No tick pin — slippage + desiredMatchRate cover it.
        const sizeForIntent = tryBigInt(sizeRaw);
        const placeIntent: IntentExpectation = {
          selector: ROUTER_SELECTORS.placeSingleOrder,
          marketId,
          cross: marginMode !== 'isolated',
          side: sideStr,
          tif: TIF_MAP[tif],
          ammId: effectiveAmmId,
          ...(sizeForIntent !== undefined ? { sizeAbs: sizeForIntent } : {}),
        };

        const willRest = tif === 'GTC' || tif === 'ALO' || tif === 'SOFT_ALO';
        const preSnapshot = willRest
          ? await snapshotActiveOrderIds(rootAddress, accountId, marketId)
          : undefined;

        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['placeSingleOrder'],
          { intents: [placeIntent] },
        );

        const execErr = executionErrorContent('place_order', result);
        if (execErr) return execErr;

        let placedOrderIds: string[] | undefined;
        if (preSnapshot) {
          placedOrderIds = await resolveRecentOrderIdsSinceSnapshot(
            rootAddress,
            accountId,
            marketId,
            preSnapshot,
            1,
          );
        }

        const txHash = extractTxHash(result);

        return jsonResult({
          ok: true,
          mode: 'execute',
          action: 'place_order',
          ...(txHash ? { txHash } : {}),
          side,
          orderType,
          timeInForce: tif,
          size,
          sizeUnit: 'YU',
          marketId,
          ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
          marketSymbol,
          ...(placedOrderIds && placedOrderIds.length > 0 ? { orderIds: placedOrderIds } : {}),
          ...(limitAprWarning(limitApr) ? { limitAprWarning: limitAprWarning(limitApr) } : {}),
          simulation: buildSimEcho(sim, { collateralSymbol }),
          execution: result,
        });
      } catch (err) {
        // Re-route MMInsufficientMinCash for isolated trades to a clearer error: the AMM_MIN_CASH
        // hint ("increase humanCash") only makes sense for AMM vault deposits, not trades.
        // Isolated trade with empty bucket → tell the user to cash_transfer or use marginMode:"cross".
        if (marginMode === 'isolated') {
          const msg = err instanceof Error ? err.message : String(err);
          if (/MMInsufficientMinCash/.test(msg)) {
            return errorContent(
              BorosErrorCode.INSUFFICIENT_MARGIN,
              `Isolated bucket on market ${marketId} has insufficient cash for this trade. Top up via cash_transfer({direction:"cross_to_isolated", marketId:${marketId}, humanAmount:<usd>}) first, or retry with marginMode:"cross".`,
            );
          }
        }
        return catchToErrorContent(err, {
          nextToolFor: {
            [BorosErrorCode.INSUFFICIENT_GAS]: {
              name: 'pay_gas',
              args: { marketId, marginMode, amount: 1 },
              why: 'Off-chain gas budget exhausted. Top up first, then re-run place_order with mode:"execute". `amount` is USD; raise it to top up more headroom.',
            },
          },
        });
      }
    }),
  );
}
