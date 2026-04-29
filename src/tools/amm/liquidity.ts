import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiPost } from '../../api/open-api.js';
import { type IntentExpectation } from '../../agent/signing.js';
import { ROUTER_SELECTORS } from '../../chain/selectors.js';
import { jsonResult, humanToRaw } from '../../utils.js';
import { BOROS_INTERNAL_DECIMALS } from '../../lib/format/amount.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { marketIdField } from '../_schemas.js';
import { getMarketInfo } from '../trading/_market.js';
import {
  executeAgentAction,
  extractCalldatas,
  extractTxHash,
  executionErrorContent,
} from '../trading/_execute.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';

function resolveCash(humanCash: number | undefined, cashAmount: string | undefined): string {
  if (cashAmount !== undefined) {
    if (!/^\d+$/.test(cashAmount)) {
      throw Object.assign(new Error(`Invalid cashAmount "${cashAmount}" — must be a non-negative integer string (18d raw bigint).`), {
        __borosCode: BorosErrorCode.INVALID_PARAMS,
      });
    }
    return cashAmount;
  }
  if (humanCash !== undefined) return humanToRaw(humanCash, BOROS_INTERNAL_DECIMALS);
  throw Object.assign(new Error('Either humanCash or cashAmount must be provided'), {
    __borosCode: BorosErrorCode.INVALID_PARAMS,
  });
}

function resolveLp(humanLp: number | undefined, lpAmount: string | undefined): string {
  if (lpAmount !== undefined) {
    if (!/^\d+$/.test(lpAmount)) {
      throw Object.assign(new Error(`Invalid lpAmount "${lpAmount}" — must be a non-negative integer string (18d raw bigint).`), {
        __borosCode: BorosErrorCode.INVALID_PARAMS,
      });
    }
    return lpAmount;
  }
  if (humanLp !== undefined) return humanToRaw(humanLp, BOROS_INTERNAL_DECIMALS);
  throw Object.assign(new Error('Either humanLp or lpAmount must be provided'), {
    __borosCode: BorosErrorCode.INVALID_PARAMS,
  });
}

function validateRawBigIntString(label: string, value: string): string {
  if (!/^\d+$/.test(value)) {
    throw Object.assign(new Error(`Invalid ${label} "${value}" — must be a non-negative integer string (18d raw bigint).`), {
      __borosCode: BorosErrorCode.INVALID_PARAMS,
    });
  }
  return value;
}

const NO_MIN_LP_OUT_WARNING =
  'minLpOut defaulted to 0 (no slippage protection). The simulation only returns a fee preview — it does not project LP-out today, so we cannot derive a default. To bound slippage, pass an explicit `minLpOut` raw 18d string.';

const NO_MIN_CASH_OUT_WARNING =
  'minCashOut defaulted to 0 (no slippage protection). The simulation only returns a fee preview — it does not project cash-out today, so we cannot derive a default. To bound slippage, pass an explicit `minCashOut` raw 18d string (Boros internal 18d cash unit).';

export function registerAmmLiquidityTools(server: McpServer) {
  server.registerTool(
    'add_liquidity',
    {
      annotations: { destructiveHint: true },
      description: `Simulate or execute adding single-sided cash liquidity to a market's AMM pool. Default mode is 'simulate' — ALWAYS run mode:'simulate' first, show the fee preview, then ONLY call mode:'execute' AFTER explicit user confirmation.

UNITS: \`humanCash\` / \`cashAmount\` are in the BOROS-INTERNAL 18-DECIMAL cash unit (NOT token-native decimals — Boros normalizes every collateral to 18d after deposit). One cash unit ≈ 1 USD-equivalent of the market's collateral.

\`minLpOut\` (raw 18d bigint string) is REQUIRED for mode:'execute' unless \`acknowledgeNoSlippageProtection:true\` is set. The public sim does NOT project LP-out today, so we cannot derive a default — omitting opens the deposit to MEV/sandwich attacks. Execute requires gas budget; top up via pay_gas if needed.`,
      inputSchema: {
        mode: z
          .enum(['simulate', 'execute'])
          .default('simulate')
          .describe('"simulate" (default): fee-only preview. "execute": sign and submit via the agent key. ALWAYS simulate first.'),
        marketId: marketIdField('AMM pool to deposit cash into.'),
        humanCash: z.number().optional().describe('Human-readable cash amount to deposit (e.g. 100.5). Boros-internal 18d cash unit (NOT token-native).'),
        cashAmount: z.string().optional().describe('Raw cash amount as 18d bigint string. Provide either humanCash or cashAmount.'),
        minLpOut: z.string().optional().describe('Minimum LP tokens to receive, as a raw 18d bigint string. Required for mode:"execute" unless `acknowledgeNoSlippageProtection:true` is set.'),
        acknowledgeNoSlippageProtection: z.boolean().optional().describe("Set to `true` ONLY when explicitly told by the user to skip MEV protection. When true, `minLpOut` defaults to '0'."),
      },
    },
    withAuth(async ({ mode, marketId, humanCash, cashAmount, minLpOut, acknowledgeNoSlippageProtection }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;
        const netCashIn = resolveCash(humanCash, cashAmount);
        if (BigInt(netCashIn) === 0n) {
          return errorContent(BorosErrorCode.INVALID_PARAMS, 'netCashIn must be > 0');
        }

        const market = await getMarketInfo(marketId);
        const marketNameRaw: string | undefined = market.imData?.name;
        const marketSymbol: string | undefined = market.metadata?.underlyingSymbol;
        const ammId: number | undefined = market.extConfig?.ammId ?? market.metadata?.ammId;
        if (!ammId) {
          return errorContent(
            BorosErrorCode.AMM_NOT_FOUND,
            `Market ${marketId} has no AMM (ammId is 0). Use get_orderbook for order-book liquidity on this market.`,
          );
        }

        if (mode === 'simulate') {
          const sim = await fetchWithRetry(() =>
            openApiPost('/v1/simulations/add-liquidity-to-amm', {
              root: rootAddress,
              accountId,
              marketId,
              netCashIn,
            }),
          );

          return jsonResult({
            ok: true,
            mode: 'simulate',
            action: 'add_liquidity',
            marketId,
            ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
            marketSymbol,
            ...(ammId ? { ammId } : {}),
            netCashIn,
            simulation: sim,
            nextTool: {
              tool: 'add_liquidity',
              params: { mode: 'execute', marketId, humanCash, cashAmount },
              instruction: 'If the user confirms, call add_liquidity with mode:"execute" and the same params (PLUS an explicit `minLpOut` to bound slippage) to submit.',
            },
            _context: {
              cashUnit: 'Boros-internal 18d cash unit (not token-native decimals).',
              minLpOut: NO_MIN_LP_OUT_WARNING,
            },
          });
        }

        // mode === 'execute'
        if (minLpOut === undefined && !acknowledgeNoSlippageProtection) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            'minLpOut is required to protect this deposit from MEV/sandwich attacks. Pass an explicit `minLpOut` (raw 18d bigint string) — or, only if the user has explicitly accepted the risk, pass `acknowledgeNoSlippageProtection: true`.',
          );
        }
        const minLpOutResolved = minLpOut !== undefined
          ? validateRawBigIntString('minLpOut', minLpOut)
          : '0';
        const minLpOutDefaulted = minLpOut === undefined;

        // Pre-flight sim — gate before signing. Failures (RPC blip, gas budget, market state)
        // bubble to outer catchToErrorContent for classification.
        const sim = await fetchWithRetry(() =>
          openApiPost('/v1/simulations/add-liquidity-to-amm', {
            root: rootAddress,
            accountId,
            marketId,
            netCashIn,
          }),
        );

        const calldataRes = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/agent/add-liquidity-to-amm', {
            marketId,
            netCashIn,
            minLpOut: minLpOutResolved,
          }),
        );
        const calldatas = extractCalldatas(calldataRes);

        // Endpoint emits ammCashTransfer + addLiquiditySingleCashToAmm. Pin marketId on the AMM call
        // so a compromised open-api can't redirect the deposit to a different pool.
        const intents: IntentExpectation[] = calldatas.map((cd) => {
          const sel = (cd.slice(0, 10) as string).toLowerCase();
          if (sel === ROUTER_SELECTORS.addLiquiditySingleCashToAmm) {
            return {
              selector: ROUTER_SELECTORS.addLiquiditySingleCashToAmm,
              marketId,
            };
          }
          return { selector: sel };
        });

        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['ammCashTransfer', 'addLiquiditySingleCashToAmm'],
          { intents },
        );

        const execErr = executionErrorContent('add_liquidity', result);
        if (execErr) return execErr;

        const txHash = extractTxHash(result);

        return jsonResult({
          ok: true,
          mode: 'execute',
          action: 'add_liquidity',
          ...(txHash ? { txHash } : {}),
          marketId,
          ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
          marketSymbol,
          ...(ammId ? { ammId } : {}),
          netCashIn,
          minLpOut: minLpOutResolved,
          ...(minLpOutDefaulted ? { minLpOutWarning: NO_MIN_LP_OUT_WARNING } : {}),
          ...(sim ? { simulation: sim } : {}),
          execution: result,
        });
      } catch (err) {
        return catchToErrorContent(err, {
          nextToolFor: {
            [BorosErrorCode.INSUFFICIENT_GAS]: {
              name: 'pay_gas',
              args: { marketId, marginMode: 'cross', amount: 1 },
              why: 'Off-chain gas budget exhausted. Top up first, then re-run add_liquidity with mode:"execute". `amount` is USD.',
            },
          },
        });
      }
    }),
  );

  server.registerTool(
    'remove_liquidity',
    {
      annotations: { destructiveHint: true },
      description: `Simulate or execute burning LP tokens to receive single-sided cash from a market's AMM pool. Default mode is 'simulate' — ALWAYS run mode:'simulate' first, show the fee preview, then ONLY call mode:'execute' AFTER explicit user confirmation.

UNITS: \`humanLp\` / \`lpAmount\` are in 18-decimal LP tokens. \`minCashOut\` is a raw 18d bigint string in the BOROS-INTERNAL 18-DECIMAL cash unit (NOT token-native).

\`minCashOut\` is REQUIRED for mode:'execute' unless \`acknowledgeNoSlippageProtection:true\` is set — the public sim does NOT project cash-out today, so omitting opens the burn to MEV/sandwich attacks. Execute requires gas budget; top up via pay_gas if needed.`,
      inputSchema: {
        mode: z
          .enum(['simulate', 'execute'])
          .default('simulate')
          .describe('"simulate" (default): fee-only preview. "execute": sign and submit via the agent key. ALWAYS simulate first.'),
        marketId: marketIdField('AMM pool to burn LP tokens from.'),
        humanLp: z.number().optional().describe('Human-readable LP amount to burn (e.g. 10.5). 18-decimal LP tokens.'),
        lpAmount: z.string().optional().describe('Raw LP amount as 18d bigint string. Provide either humanLp or lpAmount.'),
        minCashOut: z.string().optional().describe('Minimum cash to receive, as raw 18d bigint string in the Boros-internal cash unit. Required for mode:"execute" unless `acknowledgeNoSlippageProtection:true` is set.'),
        acknowledgeNoSlippageProtection: z.boolean().optional().describe("Set to `true` ONLY when explicitly told by the user to skip MEV protection. When true, `minCashOut` defaults to '0'."),
      },
    },
    withAuth(async ({ mode, marketId, humanLp, lpAmount, minCashOut, acknowledgeNoSlippageProtection }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;
        const lpToRemove = resolveLp(humanLp, lpAmount);
        if (BigInt(lpToRemove) === 0n) {
          return errorContent(BorosErrorCode.INVALID_PARAMS, 'lpToRemove must be > 0');
        }

        const market = await getMarketInfo(marketId);
        const marketNameRaw: string | undefined = market.imData?.name;
        const marketSymbol: string | undefined = market.metadata?.underlyingSymbol;
        const ammId: number | undefined = market.extConfig?.ammId ?? market.metadata?.ammId;
        if (!ammId) {
          return errorContent(
            BorosErrorCode.AMM_NOT_FOUND,
            `Market ${marketId} has no AMM (ammId is 0). Use get_orderbook for order-book liquidity on this market.`,
          );
        }

        if (mode === 'simulate') {
          const sim = await fetchWithRetry(() =>
            openApiPost('/v1/simulations/remove-liquidity-from-amm', {
              root: rootAddress,
              accountId,
              marketId,
              lpToRemove,
            }),
          );

          return jsonResult({
            ok: true,
            mode: 'simulate',
            action: 'remove_liquidity',
            marketId,
            ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
            marketSymbol,
            ...(ammId ? { ammId } : {}),
            lpToRemove,
            simulation: sim,
            nextTool: {
              tool: 'remove_liquidity',
              params: { mode: 'execute', marketId, humanLp, lpAmount },
              instruction: 'If the user confirms, call remove_liquidity with mode:"execute" and the same params (PLUS an explicit `minCashOut` to bound slippage) to submit.',
            },
            _context: {
              lpUnit: 'AMM-internal 18d LP token unit.',
              minCashOut: NO_MIN_CASH_OUT_WARNING,
            },
          });
        }

        // mode === 'execute'
        if (minCashOut === undefined && !acknowledgeNoSlippageProtection) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            'minCashOut is required to protect this burn from MEV/sandwich attacks. Pass an explicit `minCashOut` (raw 18d bigint string) — or, only if the user has explicitly accepted the risk, pass `acknowledgeNoSlippageProtection: true`.',
          );
        }
        const minCashOutResolved = minCashOut !== undefined
          ? validateRawBigIntString('minCashOut', minCashOut)
          : '0';
        const minCashOutDefaulted = minCashOut === undefined;

        // Pre-flight sim — gate before signing.
        const sim = await fetchWithRetry(() =>
          openApiPost('/v1/simulations/remove-liquidity-from-amm', {
            root: rootAddress,
            accountId,
            marketId,
            lpToRemove,
          }),
        );

        const calldataRes = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/agent/remove-liquidity-from-amm', {
            marketId,
            lpToRemove,
            minCashOut: minCashOutResolved,
          }),
        );
        const calldatas = extractCalldatas(calldataRes);

        // Pin marketId on the AMM call so a compromised open-api can't redirect the burn.
        const intents: IntentExpectation[] = calldatas.map((cd) => {
          const sel = (cd.slice(0, 10) as string).toLowerCase();
          if (sel === ROUTER_SELECTORS.removeLiquiditySingleCashFromAmm) {
            return {
              selector: ROUTER_SELECTORS.removeLiquiditySingleCashFromAmm,
              marketId,
            };
          }
          return { selector: sel };
        });

        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['ammCashTransfer', 'removeLiquiditySingleCashFromAmm'],
          { intents },
        );

        const execErr = executionErrorContent('remove_liquidity', result);
        if (execErr) return execErr;

        const txHash = extractTxHash(result);

        return jsonResult({
          ok: true,
          mode: 'execute',
          action: 'remove_liquidity',
          ...(txHash ? { txHash } : {}),
          marketId,
          ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
          marketSymbol,
          ...(ammId ? { ammId } : {}),
          lpToRemove,
          minCashOut: minCashOutResolved,
          ...(minCashOutDefaulted ? { minCashOutWarning: NO_MIN_CASH_OUT_WARNING } : {}),
          ...(sim ? { simulation: sim } : {}),
          execution: result,
        });
      } catch (err) {
        return catchToErrorContent(err, {
          nextToolFor: {
            [BorosErrorCode.INSUFFICIENT_GAS]: {
              name: 'pay_gas',
              args: { marketId, marginMode: 'cross', amount: 1 },
              why: 'Off-chain gas budget exhausted. Top up first, then re-run remove_liquidity with mode:"execute". `amount` is USD.',
            },
          },
        });
      }
    }),
  );
}
