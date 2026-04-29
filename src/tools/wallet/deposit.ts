import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Address } from 'viem';
import { CROSS_MARKET_ID, DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiPost } from '../../api/open-api.js';
import { packMarketAcc } from '../../chain/pack-account.js';
import {
  jsonResult,
  enrichAmount,
  resolveAmount,
  formatX18,
} from '../../utils.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { tokenIdField, marketIdOptionalField } from '../_schemas.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';
import { runWalletFlow } from '../_shared/run-wallet-flow.js';
import { resolveTokenAmount } from './_resolve-token-amount.js';
import { getAssetInfo } from '../../api/asset-cache.js';

export function registerDepositTool(server: McpServer) {
  server.registerTool(
    'deposit',
    {
      annotations: { destructiveHint: true },
      description: `Simulate or execute depositing ERC-20 collateral from your wallet into your Boros margin account on Arbitrum. Default mode is 'simulate' — ALWAYS run mode:'simulate' first to preview pre/post collateral balance, maintenance margin, and margin ratio, then ONLY call mode:'execute' AFTER explicit user confirmation.

mode:'execute' opens a browser page; YOUR WALLET (MetaMask/Rabby) signs — the agent key is NOT used. Two on-chain txs required (approve + deposit), and you pay gas in ETH on Arbitrum. Native ETH is not auto-wrapped — hold WETH (tokenId 2) instead. Use \`humanAmount\` rather than \`amount\` to avoid decimals-unit mistakes (USDT0=6dec, WBTC=8dec, WETH/BNB/HYPE=18dec).

For isolated-margin deposits the market must already be entered (run \`enter_exit_markets\` first); omit \`marketId\` for cross. Do NOT use this for off-chain gas top-up — use \`pay_gas\` (agent-signed) or \`vault_pay_treasury\` (wallet-signed).`,
      inputSchema: {
        mode: z
          .enum(['simulate', 'execute'])
          .default('simulate')
          .describe('"simulate" (default): preview pre/post account state. "execute": opens a browser page for wallet signing. ALWAYS simulate first.'),
        tokenId: tokenIdField('Asset to deposit (must have isCollateral:true).'),
        amount: z.string().optional().describe('Raw amount (in the token\'s smallest unit; e.g. 1000000 = 1 USDT0). Provide either amount or humanAmount.'),
        humanAmount: z.number().optional().describe('Human-readable amount (e.g. 100.5 USDT). Provide either amount or humanAmount.'),
        marketId: marketIdOptionalField('Isolated-margin deposit (market must already be entered). Omit for cross margin.'),
      },
    },
    withAuth(async ({ mode, tokenId, amount, humanAmount, marketId }, auth) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;
        const asset = await getAssetInfo(tokenId);
        const decimals = asset.decimals;
        const symbol = asset.symbol;
        const resolvedAmount = resolveAmount(amount, humanAmount, decimals);

        const effectiveMarketId = marketId ?? CROSS_MARKET_ID;
        const marketAcc = packMarketAcc(auth.rootAddress as Address, accountId, tokenId, effectiveMarketId);

        // V2 backend (POST /v1/simulations/deposit → simulateDepositV2) expects amount in the
        // collateral token's NATIVE decimals — it scales internally to 18-dec for the post diff.
        // Pre-scaling here used to compensate for a since-fixed V1 quirk; doing it now causes
        // double-scaling on isolated marketAccs.
        const sim = await fetchWithRetry(() =>
          openApiPost('/v1/simulations/deposit', { marketAcc, amount: resolvedAmount }),
        );

        if (mode === 'simulate') {
          // Backend returns collateralBalance/maintenanceMargin in FixedX18 raw (18-dec internal
          // cash units), regardless of token native decimals. Audit mistook small raw values
          // (e.g. 10^6 wei ≈ $1e-12 leftover) for 6-dec USDT and flagged a scale bug. Surface
          // *Formatted USD-readable strings so the unit is unambiguous; keep raw for precision.
          const enrichState = (s: any) =>
            s
              ? {
                  ...s,
                  ...(s.collateralBalance !== undefined
                    ? { collateralBalanceFormatted: formatX18(s.collateralBalance) }
                    : {}),
                  ...(s.maintenanceMargin !== undefined
                    ? { maintenanceMarginFormatted: formatX18(s.maintenanceMargin) }
                    : {}),
                }
              : s;
          return jsonResult({
            ok: true,
            mode: 'simulate',
            action: 'deposit',
            tokenId,
            symbol,
            ...enrichAmount(resolvedAmount, decimals, symbol),
            ...(marketId !== undefined ? { marketId } : {}),
            marginType: marketId !== undefined ? 'isolated' : 'cross',
            simulation: {
              preUserState: enrichState(sim.preUserState),
              postUserState: enrichState(sim.postUserState),
              ...(sim.minReceived !== undefined
                ? { minReceived: sim.minReceived, minReceivedFormatted: formatX18(sim.minReceived) }
                : {}),
              _balanceUnit: 'collateralBalance / maintenanceMargin are FixedX18 raw (18-dec internal cash). *Formatted strings are USD-equivalent.',
            },
            nextTool: {
              tool: 'deposit',
              params: {
                mode: 'execute',
                tokenId,
                ...(amount !== undefined ? { amount } : {}),
                ...(humanAmount !== undefined ? { humanAmount } : {}),
                ...(marketId !== undefined ? { marketId } : {}),
              },
              instruction: 'If the user confirms, call deposit with mode:"execute" to open the wallet-signing page.',
            },
            _context: {
              stateFields: 'collateralBalance, maintenanceMargin, and marginRatio (collateral / maintenance).',
            },
          });
        }

        // mode === 'execute' — sim above acts as pre-flight gate before opening wallet flow.
        return runWalletFlow({
          auth,
          toolName: 'deposit',
          cancelArgs: {
            mode: 'execute',
            tokenId,
            ...(amount !== undefined ? { amount } : {}),
            ...(humanAmount !== undefined ? { humanAmount } : {}),
            ...(marketId !== undefined ? { marketId } : {}),
          },
          actionLabel: 'deposit',
          pagePath: '/deposit',
          setup: async ({ rootAddress: root }) => {
            const { asset, decimals, symbol, resolvedAmount, enriched } = await resolveTokenAmount(
              tokenId,
              amount,
              humanAmount,
            );

            const effectiveMarketId = marketId ?? CROSS_MARKET_ID;
            const marketAcc = packMarketAcc(root, DEFAULT_ACCOUNT_ID, tokenId, effectiveMarketId);
            const calldata = await fetchWithRetry(() =>
              openApiPost('/v1/calldata-builder/user/deposit', { marketAcc, amount: resolvedAmount }),
            );

            // vaultDeposit is non-payable so no `value`. No Arbitrum collateral uses reset-to-zero approval.
            return {
              pendingData: {
                type: 'deposit',
                calldata: calldata.calldata,
                from: calldata.from ?? root,
                to: calldata.to,
                gas: calldata.gas,
                expectedAddress: root,
                tokenId,
                tokenAddress: asset.address ?? null,
                tokenSymbol: symbol,
                decimals,
                rawAmount: resolvedAmount,
                amount: resolvedAmount,
                humanAmount: enriched.humanAmount,
                marketLabel: marketId ? `Isolated (market ${marketId})` : 'Cross Margin',
              },
              renderResponse: (result, url) => jsonResult({
                ok: true,
                mode: 'execute',
                action: 'deposit',
                tokenId,
                ...enriched,
                ...(marketId !== undefined ? { marketId } : {}),
                marginType: marketId !== undefined ? 'isolated' : 'cross',
                txHash: (result as any)?.txHash,
                message: `Successfully deposited ${enriched.humanAmount} ${symbol} into your ${marketId !== undefined ? 'isolated' : 'cross'} margin account.`,
                url,
              }),
            };
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
