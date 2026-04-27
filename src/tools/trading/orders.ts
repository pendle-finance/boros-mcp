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
  resolveRecentOrderIds,
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
    'simulate_order',
    {
      annotations: { readOnlyHint: true },
      description: `Simulate placing an order WITHOUT executing it. Returns a preview of the expected fill, margin, price impact, and liquidation APR.

UNITS: \`size\` is YU (yield units), ALWAYS POSITIVE — direction comes from \`side\` (LONG/SHORT). NEVER sign size to indicate short. \`limitApr\` and \`slippage\` are DECIMALS (0.05 = 5%, NOT 5). \`marginMode:'cross'\` = per-token shared bucket (across all entered markets for that token); \`'isolated'\` = per-market subaccount.

WORKFLOW: When a user says they want to trade/order on a market:
1. If they gave a market name (e.g. "lighter-sol"), use get_markets to resolve the marketId first.
2. Ask for any missing required info: side (long/short), size, order type (market/limit), and limitApr if limit.
3. Call this tool to simulate and show the user the preview.
4. If the user confirms, call place_order with the SAME params to execute.
Never skip the simulation step — always preview before executing. Re-simulate after price drift; calldata uses the current mid-rate at execute-time.`,
      inputSchema: {
        marketId: marketIdField(),
        side: sideSchema,
        size: z.string().describe('Notional size in YU (yield units), human-readable decimal (e.g. "1000.5"). ALWAYS POSITIVE — direction is set by `side`, never by signing size.'),
        orderType: z.enum(['market', 'limit']).describe('Order type. market → defaults to FOK (all-or-nothing); limit → defaults to GTC (rests on book).'),
        limitApr: z.number().optional().describe('Limit APR as DECIMAL (0.05 = 5%, NOT 5). Backend rounds: LONG rounds DOWN, SHORT rounds UP to the nearest tick. No upper bound — some markets (e.g. oil) have legitimately traded at |APR| > 100%.'),
        marginMode: marginModeField(),
        slippage: slippageField('Max slippage for the SIMULATION as DECIMAL (0.05 = 5%, NOT 5). Must match the slippage you plan to pass to place_order — otherwise the preview can succeed while the real order rejects on PRICE_IMPACT_TOO_HIGH.'),
        timeInForce: timeInForceField(),
      },
    },
    withAuth(async ({ marketId, side, size, orderType, limitApr, marginMode, slippage, timeInForce }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        const market = await getMarketInfo(marketId);
        const tokenId: number = market.tokenId;
        const marketNameRaw: string | undefined = market.imData?.name;
        const marketSymbol: string | undefined = market.metadata?.underlyingSymbol;
        const collateralSymbol = await resolveCollateralSymbol(tokenId);
        // Backend no longer auto-picks AMM — fall back to 0 (orderbook-only) when not configured.
        const ammId: number = market.extConfig?.ammId ?? market.metadata?.ammId ?? 0;

        if (orderType === 'limit' && limitApr === undefined) {
          return errorContent(BorosErrorCode.INVALID_PARAMS, 'limitApr is required for limit orders');
        }

        const marketAcc = resolveMarketAcc(rootAddress, accountId, tokenId, marginMode, marketId);
        const sizeRaw = parseSize(size).toString();

        const tif = tifString(orderType, timeInForce);
        // ALO/SOFT_ALO cannot route through AMM — backend strips ammId, so calldata-builder
        // and intent must agree on 0 to avoid a verifier mismatch. Mirror the same in sim.
        const effectiveAmmId = (tif === 'ALO' || tif === 'SOFT_ALO') ? 0 : ammId;
        // Only FOK is rate-free; everything else needs the rate guard, so forward limitApr whenever set.
        const sim = await fetchWithRetry(() =>
          openApiPost('/v1/simulations/place-order', {
            marketAcc,
            marketId,
            side: SIDE_MAP[side],
            size: sizeRaw,
            tif: TIF_MAP[tif],
            ...(limitApr !== undefined ? { rate: limitApr } : {}),
            slippage,
            ammId: effectiveAmmId,
          }),
        );

        // place_order re-simulates seconds later → often PRICE_IMPACT_TOO_HIGH on same params;
        // surface a structured signal so LLM can widen slippage before execute.
        const priceImpactNearSlippage =
          typeof sim.priceImpact === 'number' && Math.abs(sim.priceImpact) > slippage * 0.8;

        return jsonResult({
          ok: true,
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
                  priceImpactWarning: `Simulated price impact ${((sim.priceImpact as number) * 100).toFixed(2)}% is close to slippage tolerance ${(slippage * 100).toFixed(2)}%. Consider raising slippage before calling place_order.`,
                }
              : {}),
          },
          nextTool: {
            tool: 'place_order',
            params: { marketId, side, size, orderType, limitApr, marginMode, slippage, timeInForce },
            instruction: 'If the user confirms, call place_order with these params to execute the trade.',
          },
          _context: { apr: APR_NOTE },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );

  server.registerTool(
    'place_order',
    {
      annotations: { destructiveHint: true },
      description: 'Execute an order on a Boros market. Simulates first to validate, then signs and submits via the agent key. IMPORTANT: Always call simulate_order FIRST with the SAME params, show the user the preview, and only call this after the user confirms. UNITS: size is YU (always positive — direction is `side`); limitApr/slippage are DECIMALS (0.05 = 5%, NOT 5). The actual encoded rate may snap by up to half a tick (LONG rounds DOWN, SHORT rounds UP). If the order fails with "Insufficient gas balance", top up via pay_gas first.',
      inputSchema: {
        marketId: marketIdField('Market ID to trade on (positive integer)'),
        side: sideSchema,
        size: z.string().describe('Notional size in YU, human-readable decimal (e.g. "1000.5"). ALWAYS POSITIVE — direction is set by `side`. NEVER sign size to indicate short.'),
        orderType: z.enum(['market', 'limit']).describe('Order type. market → defaults to FOK (all-or-nothing); limit → defaults to GTC.'),
        limitApr: z.number().optional().describe('Limit APR as DECIMAL (0.05 = 5%, NOT 5). Required for orderType:"limit"; optional for "market" (acts as a rate guard with IOC). No upper bound — some markets (e.g. oil) have legitimately traded at |APR| > 100%.'),
        marginMode: marginModeField('Margin mode. cross (default): per-token bucket shared across all entered markets for that token. isolated: per-market subaccount.'),
        slippage: slippageField('Max slippage tolerance as DECIMAL (0.05 = 5%, NOT 5). Hard max 1 (100%). MUST match the slippage you simulated with — different values produce a different desiredRate.'),
        timeInForce: timeInForceField(),
      },
    },
    withAuth(async ({ marketId, side, size, orderType, limitApr, marginMode, slippage, timeInForce }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        const market = await getMarketInfo(marketId);
        const tokenId: number = market.tokenId;
        const marketNameRaw: string | undefined = market.imData?.name;
        const marketSymbol: string | undefined = market.metadata?.underlyingSymbol;
        const collateralSymbol = await resolveCollateralSymbol(tokenId);
        // Backend no longer auto-picks AMM — derive from market record (0 = orderbook-only).
        const ammId: number = market.extConfig?.ammId ?? market.metadata?.ammId ?? 0;

        if (orderType === 'limit' && limitApr === undefined) {
          return errorContent(BorosErrorCode.INVALID_PARAMS, 'limitApr is required for limit orders');
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
            // Only FOK is rate-free; everything else needs rate.
            ...(limitApr !== undefined ? { rate: limitApr } : {}),
            slippage,
            ammId: effectiveAmmId,
          }),
        );

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
            // FOK is the only TIF where omission means "market order"; else rate is required.
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

        // Pin selector — allowing bulkOrders would let a compromised open-api substitute payload.
        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['placeSingleOrder'],
          { intents: [placeIntent] },
        );

        const execErr = executionErrorContent('place_order', result);
        if (execErr) return execErr;

        // GTC/ALO/SOFT_ALO rest → resolve fresh orderIds (saves follow-up query). FOK/IOC skip.
        let placedOrderIds: string[] | undefined;
        if (tif === 'GTC' || tif === 'ALO' || tif === 'SOFT_ALO') {
          placedOrderIds = await resolveRecentOrderIds(
            rootAddress,
            accountId,
            marketId,
            1,
          );
        }

        const txHash = extractTxHash(result);

        return jsonResult({
          ok: true,
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
        return catchToErrorContent(err, {
          nextToolFor: {
            [BorosErrorCode.INSUFFICIENT_GAS]: {
              name: 'pay_gas',
              args: { marketId, marginMode, amount: 1 },
              why: 'Off-chain gas budget exhausted. Top up first, then re-run place_order with the same params. `amount` is USD; raise it to top up more headroom.',
            },
          },
        });
      }
    }),
  );
}
