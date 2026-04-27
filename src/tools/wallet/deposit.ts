import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CROSS_MARKET_ID, DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiPost } from '../../api/open-api.js';
import { packMarketAcc } from '../../chain/pack-account.js';
import { jsonResult } from '../../utils.js';
import { tokenIdField } from '../_schemas.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';
import { runWalletFlow } from '../_shared/run-wallet-flow.js';
import { resolveTokenAmount } from './_resolve-token-amount.js';

export function registerDepositTool(server: McpServer) {
  server.registerTool(
    'deposit',
    {
      annotations: { destructiveHint: true },
      description: 'Deposit ERC-20 collateral from your wallet into your Boros margin account on Arbitrum. Opens a browser page; YOUR WALLET (MetaMask/Rabby) signs — the agent key is NOT used. Two on-chain txs are required (approve + deposit), and you pay gas in ETH on Arbitrum. Native ETH is not auto-wrapped — hold WETH (tokenId 2) instead. Use `humanAmount` rather than `amount` to avoid decimals-unit mistakes (USDT0=6dec, WBTC=8dec, WETH/BNB/HYPE=18dec). For isolated-margin deposits the market must already be entered (run `enter_exit_markets` first); omit `marketId` for cross. Use `simulate_deposit` first to preview the post-balance. Do NOT use this for off-chain gas top-up — use `pay_gas` (agent-signed) or `vault_pay_treasury` (wallet-signed).',
      inputSchema: {
        tokenId: tokenIdField('Token ID of the collateral asset to deposit (must have isCollateral:true; see get_assets).'),
        amount: z.string().optional().describe('Raw amount (in the token\'s smallest unit; e.g. 1000000 = 1 USDT0). Provide either amount or humanAmount.'),
        humanAmount: z.number().optional().describe('Human-readable amount (e.g. 100.5 USDT). Provide either amount or humanAmount.'),
        marketId: z.number().int().optional().describe('Market ID for isolated-margin deposit (market must already be entered). Omit for cross margin.'),
      },
    },
    withAuth(async ({ tokenId, amount, humanAmount, marketId }, auth) => runWalletFlow({
      auth,
      toolName: 'deposit',
      cancelArgs: {
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
          // Echo marketId only when caller passed one — cross-sentinel (16777215) is internal.
          renderResponse: (result, url) => jsonResult({
            ok: true,
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
    })),
  );
}
