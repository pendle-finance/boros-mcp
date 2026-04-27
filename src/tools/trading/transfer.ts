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
import { catchToErrorContent, BorosErrorCode } from '../../agent/errors.js';
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

export function registerTransferTools(server: McpServer) {
  server.registerTool(
    'simulate_cash_transfer',
    {
      annotations: { readOnlyHint: true },
      description: `Preview a collateral transfer between cross-margin and an isolated market account, WITHOUT executing. Mirrors the simulate_order → place_order two-step pattern.

WORKFLOW:
1. Call this to get the pre/post margin state for each side.
2. If the user confirms, call cash_transfer with the same params to execute.`,
      inputSchema: {
        marketId: z.number().describe('Market ID for the isolated account'),
        direction: z
          .enum(['cross_to_isolated', 'isolated_to_cross'])
          .describe('Transfer direction'),
        amount: z.string().optional().describe('Raw token amount to transfer'),
        humanAmount: z.number().optional().describe('Human-readable amount to transfer (e.g. 100.5)'),
      },
    },
    withAuth(async ({ marketId, direction, amount, humanAmount }, { rootAddress }) => {
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

        const sim = await fetchWithRetry(() =>
          openApiPost('/v1/simulations/cash-transfer', {
            root: rootAddress,
            accountId,
            marketId,
            direction: directionStr,
            amount: transferAmount,
          }),
        );

        return jsonResult({
          ok: true,
          action: 'simulate_cash_transfer',
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
              marketId,
              direction,
              ...(amount !== undefined ? { amount } : {}),
              ...(humanAmount !== undefined ? { humanAmount } : {}),
            },
            instruction: 'If the user confirms the simulation, call cash_transfer with these params to execute.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );

  server.registerTool(
    'cash_transfer',
    {
      annotations: { destructiveHint: true },
      description: 'INTERNAL margin move between your own cross and isolated buckets on Boros. NOT an ERC-20 transfer — there is no recipient address. To move funds out of Boros use `withdraw`; to deposit fresh tokens use `deposit`; to top up gas budget use `pay_gas`. Call simulate_cash_transfer FIRST and show the preview; only call this after the user confirms. Requires gas budget (top up via pay_gas if needed).',
      inputSchema: {
        marketId: z.number().describe('Market ID for the isolated account'),
        direction: z
          .enum(['cross_to_isolated', 'isolated_to_cross'])
          .describe('Transfer direction'),
        amount: z.string().optional().describe('Raw token amount to transfer'),
        humanAmount: z.number().optional().describe('Human-readable amount to transfer (e.g. 100.5)'),
      },
    },
    withAuth(async ({ marketId, direction, amount, humanAmount }, { rootAddress }) => {
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
        // Pin exact amount (no slippage).
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
            // Default cross (most common); user overrides on retry.
            [BorosErrorCode.INSUFFICIENT_GAS]: {
              name: 'pay_gas',
              args: { marketId, marginMode: 'cross', amount: 1 },
              why: 'Off-chain gas budget exhausted. Top up first, then re-run cash_transfer with the same params. `amount` is USD.',
            },
          },
        });
      }
    }),
  );
}
