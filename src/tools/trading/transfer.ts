import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiPost } from '../../api/open-api.js';
import { type IntentExpectation } from '../../agent/signing.js';
import { ROUTER_SELECTORS } from '../../chain/selectors.js';
import {
  jsonResult,
  enrichAmount,
  resolveAmount,
} from '../../utils.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { tryBigInt } from './_helpers.js';
import { getMarketInfo } from './_market.js';
import {
  executeAgentAction,
  extractCalldatas,
  extractTxHash,
  executionErrorContent,
} from './_execute.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';
import { getAssetInfo } from '../../api/asset-cache.js';
import { marketIdField } from '../_schemas.js';

export function registerTransferTools(server: McpServer) {
  server.registerTool(
    'cash_transfer',
    {
      annotations: { destructiveHint: true },
      description: `INTERNAL margin move between your own cross and isolated buckets on Boros. NOT an ERC-20 transfer — there is no recipient address. To move funds out of Boros use \`withdraw\`; to deposit fresh tokens use \`deposit\`; to top up gas budget use \`pay_gas\`.

Default mode is 'simulate' — ALWAYS run mode:'simulate' first to preview pre/post margin state, show the user, then ONLY call mode:'execute' AFTER confirmation. Execute requires gas budget; top up via pay_gas if needed.`,
      inputSchema: {
        mode: z
          .enum(['simulate', 'execute'])
          .default('simulate')
          .describe('"simulate" (default): preview pre/post margin state. "execute": sign and submit via the agent key. ALWAYS simulate first.'),
        marketId: marketIdField('Isolated account.'),
        direction: z
          .enum(['cross_to_isolated', 'isolated_to_cross'])
          .describe('Transfer direction'),
        amount: z.string().optional().describe('Raw token amount to transfer'),
        humanAmount: z.number().optional().describe('Human-readable amount to transfer (e.g. 100.5)'),
      },
    },
    withAuth(async ({ mode, marketId, direction, amount, humanAmount }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        const market = await getMarketInfo(marketId);
        const tokenId: number = market.tokenId;
        const marketNameRaw: string | undefined = market.imData?.name;
        const marketSymbol: string | undefined = market.metadata?.underlyingSymbol;

        const asset = await getAssetInfo(tokenId);
        const decimals = asset.decimals;
        const assetSymbol: string = asset.symbol;
        const transferAmount = resolveAmount(amount, humanAmount, decimals);

        const directionStr = direction === 'cross_to_isolated' ? 'CROSS_TO_ISOLATED' : 'ISOLATED_TO_CROSS';

        if (mode === 'simulate') {
          const sim = await fetchWithRetry(() =>
            openApiPost('/v1/simulations/cash-transfer', {
              root: rootAddress,
              accountId,
              marketId,
              direction: directionStr,
              amount: transferAmount,
            }),
          );

          // Pre-flight overdraft check — backend sim happily diffs balances even when the user
          // doesn't have the funds, so the failure only surfaces at execute. Compare in 18-dec
          // internal cash units (sim's pre is netBalance in 18-dec; transferAmount is native).
          try {
            const sourceLeg =
              direction === 'cross_to_isolated' ? sim?.crossAccState : sim?.isolatedAccState;
            const preBalanceRaw = sourceLeg?.preUserState?.collateralBalance;
            if (preBalanceRaw !== undefined && preBalanceRaw !== null) {
              const preBalance18 = BigInt(preBalanceRaw);
              const scaleExp = 18 - decimals;
              const requested18 =
                scaleExp >= 0
                  ? BigInt(transferAmount) * 10n ** BigInt(scaleExp)
                  : BigInt(transferAmount) / 10n ** BigInt(-scaleExp);
              if (requested18 > preBalance18) {
                const humanReq = enrichAmount(transferAmount, decimals, assetSymbol).humanAmount;
                const humanPre = (Number(preBalance18) / 1e18).toFixed(decimals);
                return errorContent(
                  BorosErrorCode.INVALID_PARAMS,
                  `Insufficient ${direction === 'cross_to_isolated' ? 'cross' : 'isolated'} balance: requested ${humanReq} ${assetSymbol}, available ~${humanPre} ${assetSymbol}.`,
                );
              }
            }
          } catch { /* best-effort — fall through to backend sim semantics */ }

          return jsonResult({
            ok: true,
            mode: 'simulate',
            action: 'cash_transfer',
            marketId,
            ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
            marketSymbol,
            direction,
            humanAmount: enrichAmount(transferAmount, decimals, assetSymbol).humanAmount,
            symbol: assetSymbol,
            simulation: sim,
            nextTool: {
              tool: 'cash_transfer',
              params: {
                mode: 'execute',
                marketId,
                direction,
                ...(amount !== undefined ? { amount } : {}),
                ...(humanAmount !== undefined ? { humanAmount } : {}),
              },
              instruction: 'If the user confirms, call cash_transfer with mode:"execute" and the same params to submit.',
            },
          });
        }

        // mode === 'execute' — pre-flight sim, abort before signing if it fails.
        await fetchWithRetry(() =>
          openApiPost('/v1/simulations/cash-transfer', {
            root: rootAddress,
            accountId,
            marketId,
            direction: directionStr,
            amount: transferAmount,
          }),
        );

        const calldataRes = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/agent/cash-transfer', {
            accountId,
            marketId,
            direction: directionStr,
            amount: transferAmount,
          }),
        );
        const calldatas = extractCalldatas(calldataRes);

        // signedAmount: + for CROSS→ISOLATED, − for ISOLATED→CROSS (CashTransferReq int256).
        const transferAmountBig = tryBigInt(transferAmount);
        const cashTransferIntent: IntentExpectation = {
          selector: ROUTER_SELECTORS.cashTransfer,
          // marketId = isolated id (NOT cross sentinel); no `cross` field on CashTransferReq.
          marketId,
          ...(transferAmountBig !== undefined
            ? directionStr === 'CROSS_TO_ISOLATED'
              ? { signedAmountExact: transferAmountBig }
              : { signedAmountExact: -transferAmountBig }
            : {}),
        };

        // Pin selector — allowing payTreasury would let a compromised open-api substitute a
        // treasury debit (moves collateral to non-withdrawable gas budget).
        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['cashTransfer'],
          { intents: [cashTransferIntent] },
        );

        const execErr = executionErrorContent('cash_transfer', result);
        if (execErr) return execErr;

        const txHash = extractTxHash(result);

        return jsonResult({
          ok: true,
          mode: 'execute',
          action: 'cash_transfer',
          ...(txHash ? { txHash } : {}),
          marketId,
          ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
          marketSymbol,
          direction,
          ...enrichAmount(transferAmount, decimals, assetSymbol),
          execution: result,
        });
      } catch (err) {
        return catchToErrorContent(err, {
          nextToolFor: {
            [BorosErrorCode.INSUFFICIENT_GAS]: {
              name: 'pay_gas',
              args: { marketId, marginMode: 'cross', amount: 1 },
              why: 'Off-chain gas budget exhausted. Top up first, then re-run cash_transfer with mode:"execute". `amount` is USD.',
            },
          },
        });
      }
    }),
  );
}
