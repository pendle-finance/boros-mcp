import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiPost } from '../../api/open-api.js';
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
  flipSideString,
  limitAprWarning,
  TIF_MAP,
  SIDE_MAP,
} from './_helpers.js';
import {
  getMarketInfo,
  resolveMarketAcc,
  resolveCollateralSymbol,
  resolveActivePosition,
} from './_market.js';
import {
  executeAgentAction,
  extractCalldatas,
  extractTxHash,
  executionErrorContent,
  assertSimSucceeded,
  assertPriceImpactWithinSlippage,
} from './_execute.js';
import {
  buildSimEcho,
  gatherCloseTradePnlInputs,
} from './_sim-echo.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';

export function registerCloseTools(server: McpServer) {
  server.registerTool(
    'close_position',
    {
      annotations: { destructiveHint: true },
      description: `Simulate or execute closing a position. Default mode is 'simulate' — ALWAYS run mode:'simulate' first, show the preview, then ONLY call mode:'execute' AFTER explicit user confirmation.

The tool AUTO-FLIPS your input \`side\` (the position side) to derive the counter-order side internally — pass the side of the OPEN position, NOT the close direction. Omit \`size\` to close the full active position.

Reduce-only is NOT enforced server-side anymore (the backend dropped its validateCloseActivePosition path) and the on-chain placeSingleOrder has NO reduce-only flag — the only guard is this tool's local pre-flight check that compares the requested size to the current absolute position size. Between simulate and execute, an external fill or liquidation can shrink/flip the position so that the same size opens a REVERSE position. To reduce risk, prefer partial-close with explicit \`size\` over full-close, and re-simulate immediately before confirming.

UNITS: \`size\` is YU, always positive. \`limitApr\` and \`slippage\` are DECIMALS (0.05 = 5%, NOT 5). \`marginMode\` MUST match how the position was opened (cross/isolated) — otherwise the position lookup fails. If execute fails with "Insufficient gas balance", top up via pay_gas first.`,
      inputSchema: {
        mode: z
          .enum(['simulate', 'execute'])
          .default('simulate')
          .describe(
            '"simulate" (default): preview the close fill, PnL, and margin impact. "execute": re-simulate, then sign and submit via the agent place-order calldata endpoint with flipped side. ALWAYS simulate first; execute requires explicit user confirmation.',
          ),
        marketId: marketIdField('Market of the position to close.'),
        side: sideSchema.describe('Side of the EXISTING position (long or short; any case). The tool flips internally to derive the counter-order side.'),
        size: z.string().optional().describe('Notional size to close in YU, human-readable decimal. Omit for full close. Always positive.'),
        closeType: z.enum(['market', 'limit']).default('market').describe('Close order type. market → defaults to FOK; limit → defaults to GTC.'),
        limitApr: z.number().optional().describe('Limit APR for limit close orders as DECIMAL (0.05 = 5%, NOT 5). No upper bound.'),
        marginMode: marginModeField('MUST match how the position was opened.'),
        slippage: slippageField('MUST match between simulate and execute.'),
        timeInForce: timeInForceField(),
      },
    },
    withAuth(async ({ mode, marketId, side, size, closeType, limitApr, marginMode, slippage, timeInForce }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        const market = await getMarketInfo(marketId);
        const tokenId: number = market.tokenId;
        const marketNameRaw: string | undefined = market.imData?.name;
        const marketSymbol: string | undefined = market.metadata?.underlyingSymbol;
        const collateralSymbol = await resolveCollateralSymbol(tokenId);
        const ammId: number = market.extConfig?.ammId ?? market.metadata?.ammId ?? 0;

        if (closeType === 'limit' && limitApr === undefined) {
          return errorContent(BorosErrorCode.INVALID_PARAMS, 'limitApr is required for limit close orders');
        }

        const marketAcc = resolveMarketAcc(rootAddress, accountId, tokenId, marginMode, marketId);

        const activePosition = await resolveActivePosition(rootAddress, accountId, marketId, marketAcc);

        // Reduce-only is NOT enforced anywhere — wrong side opens a NEW position. Reject pre-sim.
        if (activePosition && activePosition.signedSize) {
          const signed = BigInt(activePosition.signedSize);
          if (signed !== 0n) {
            const positionSide = signed > 0n ? 'long' : 'short';
            if (positionSide !== side.toLowerCase()) {
              return errorContent(
                BorosErrorCode.INVALID_PARAMS,
                `Position on market ${marketId} (marginMode=${marginMode}) is ${positionSide}, not ${side.toLowerCase()}. Pass side='${positionSide}' to close it. Passing the wrong side would open a NEW position in the opposite direction.`,
              );
            }
          }
        }

        let sizeRaw: string;
        let positionSignedSize: bigint | null = null;
        if (activePosition?.signedSize) {
          try {
            const signed = BigInt(activePosition.signedSize);
            positionSignedSize = signed < 0n ? -signed : signed;
          } catch { /* keep null */ }
        }
        if (size) {
          sizeRaw = parseSize(size).toString();
          // Reduce-only NOT on-chain — oversized close opens reverse position. Detect pre-sign.
          if (positionSignedSize !== null && BigInt(sizeRaw) > positionSignedSize) {
            return errorContent(
              BorosErrorCode.INVALID_PARAMS,
              `Requested close size (${sizeRaw}) exceeds current absolute position size (${positionSignedSize.toString()}). ` +
                `On-chain placeSingleOrder has no reduce-only flag — submitting would open a reverse position. ` +
                `Reduce \`size\` or omit it for a full close.`,
            );
          }
        } else {
          if (positionSignedSize === null) {
            return errorContent(
              BorosErrorCode.INVALID_PARAMS,
              `No open position on market ${marketId} (marginMode=${marginMode}) to close. ` +
                `If the position is on the other margin mode, retry with marginMode='${marginMode === 'cross' ? 'isolated' : 'cross'}'.`,
            );
          }
          sizeRaw = positionSignedSize.toString();
        }

        const closeSideStr = flipSideString(side);
        const tif = tifString(closeType, timeInForce);
        // ALO/SOFT_ALO cannot route through AMM — backend strips ammId, so calldata-builder
        // and intent must agree on 0 to avoid a verifier mismatch.
        const effectiveAmmId = (tif === 'ALO' || tif === 'SOFT_ALO') ? 0 : ammId;

        // close-position sim removed — use place-order sim. positionSignedSize guard above
        // is the only protection against position flip.
        const sim = await fetchWithRetry(() =>
          openApiPost('/v1/simulations/place-order', {
            marketAcc,
            marketId,
            side: SIDE_MAP[closeSideStr],
            size: sizeRaw,
            tif: TIF_MAP[tif],
            ...(limitApr !== undefined ? { rate: limitApr } : {}),
            slippage,
            ammId: effectiveAmmId,
          }),
        );

        const closePnlInputs = gatherCloseTradePnlInputs(activePosition, market);

        if (mode === 'simulate') {
          return jsonResult({
            ok: true,
            mode: 'simulate',
            marketId,
            ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
            marketSymbol,
            simulation: {
              ...buildSimEcho(sim, {
                includeStatus: true,
                includeLongYield: true,
                includeClose: true,
                collateralSymbol,
                ...closePnlInputs,
              }),
              positionSide: side,
              closeSide: closeSideStr,
              closeType,
              timeInForce: tif,
              size: size ?? 'full',
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
            nextTool: {
              tool: 'close_position',
              params: { mode: 'execute', marketId, side, size, closeType, limitApr, marginMode, slippage, timeInForce },
              instruction: 'If the user confirms, call close_position with mode:"execute" and the same params to submit.',
            },
            _context: { apr: APR_NOTE },
          });
        }

        // mode === 'execute'
        const simErr = assertSimSucceeded(sim, {
          variant: 'close',
          isMarketOrder: closeType === 'market',
        });
        if (simErr) return simErr;
        const impactErr = assertPriceImpactWithinSlippage(sim, slippage, { variant: 'close' });
        if (impactErr) return impactErr;

        const calldataRes = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/agent/place-order', {
            marketAcc,
            marketId,
            side: SIDE_MAP[closeSideStr],
            size: sizeRaw,
            tif: TIF_MAP[tif],
            ...(limitApr !== undefined ? { rate: limitApr } : {}),
            slippage,
            ammId: effectiveAmmId,
          }),
        );
        const calldatas = extractCalldatas(calldataRes);

        // placeSingleOrder with flipped side. Pin marketId+cross (not marketAcc — see place_order).
        const sizeForIntent = tryBigInt(sizeRaw);
        const closeIntent: IntentExpectation = {
          selector: ROUTER_SELECTORS.placeSingleOrder,
          marketId,
          cross: marginMode !== 'isolated',
          side: closeSideStr,
          tif: TIF_MAP[tif],
          ammId: effectiveAmmId,
          ...(sizeForIntent !== undefined ? { sizeAbs: sizeForIntent } : {}),
        };

        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['placeSingleOrder'],
          { intents: [closeIntent] },
        );

        const execErr = executionErrorContent('close_position', result);
        if (execErr) return execErr;

        const txHash = extractTxHash(result);

        return jsonResult({
          ok: true,
          mode: 'execute',
          action: 'close_position',
          ...(txHash ? { txHash } : {}),
          positionSide: side,
          closeSide: closeSideStr,
          closeType,
          timeInForce: tif,
          size: size ?? 'full',
          sizeUnit: 'YU',
          marketId,
          ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
          marketSymbol,
          ...(limitAprWarning(limitApr) ? { limitAprWarning: limitAprWarning(limitApr) } : {}),
          simulation: buildSimEcho(sim, {
            includeClose: true,
            collateralSymbol,
            ...closePnlInputs,
          }),
          execution: result,
        });
      } catch (err) {
        return catchToErrorContent(err, {
          nextToolFor: {
            [BorosErrorCode.INSUFFICIENT_GAS]: {
              name: 'pay_gas',
              args: { marketId, marginMode, amount: 1 },
              why: 'Off-chain gas budget exhausted. Top up first, then re-run close_position with mode:"execute". `amount` is USD.',
            },
          },
        });
      }
    }),
  );
}
