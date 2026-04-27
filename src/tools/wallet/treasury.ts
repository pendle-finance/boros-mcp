import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiPost } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { tokenIdField } from '../_schemas.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';
import { runWalletFlow } from '../_shared/run-wallet-flow.js';
import { resolveTokenAmount } from './_resolve-token-amount.js';

export function registerVaultPayTreasuryTool(server: McpServer) {
  server.registerTool(
    'vault_pay_treasury',
    {
      annotations: { destructiveHint: true },
      description: 'Top up your off-chain gas budget by pulling collateral tokens DIRECTLY from your EOA wallet (instead of from already-deposited margin). Opens a browser page; YOUR WALLET (root EOA) signs Router.vaultPayTreasury(tokenId, amount) and you pay gas. Tokens transfer to the Boros Router; the backend credits the equivalent USD value to your gas budget after the tx confirms. PREFER `pay_gas` when you have margin collateral — it is agent-signed (no wallet popup) and cheaper. Use `vault_pay_treasury` only when (a) you have not yet deposited collateral, or (b) your agent is unavailable, or (c) you specifically want to keep margin balance untouched. NOTE: this is unrelated to AMM LP vaults (`get_vault_info` / `get_amm_info`); the "vault" name is a contract-level term. First call may prompt for ERC-20 approval; second call signs the actual transfer.',
      inputSchema: {
        tokenId: tokenIdField('Collateral token ID (must have isCollateral:true).'),
        amount: z.string().optional().describe('Raw amount in token smallest unit (e.g. 1000000 = 1 USDT0). Provide either amount or humanAmount.'),
        humanAmount: z.number().optional().describe('Human-readable amount (e.g. 0.5 WETH). Provide either amount or humanAmount.'),
      },
    },
    withAuth(async ({ tokenId, amount, humanAmount }, auth) => runWalletFlow({
      auth,
      toolName: 'vault_pay_treasury',
      cancelArgs: {
        tokenId,
        ...(amount !== undefined ? { amount } : {}),
        ...(humanAmount !== undefined ? { humanAmount } : {}),
      },
      actionLabel: 'treasury payment',
      pagePath: '/sign-tx',
      setup: async ({ rootAddress: root }) => {
        const { asset, decimals, symbol, resolvedAmount, enriched } = await resolveTokenAmount(
          tokenId,
          amount,
          humanAmount,
        );

        // Pass token-native decimals — IERC20.safeTransferFrom consumes unscaled amount;
        // MarketHubEntry.vaultPayTreasury _toScaled-converts internally. Backend DTO docstring
        // saying "scaled by 10^18" is incorrect; on-chain contract is the source of truth.
        const calldata = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/user/vault-pay-treasury', {
            root,
            tokenId,
            amount: resolvedAmount,
          }),
        );

        return {
          pendingData: {
            type: 'vault_pay_treasury',
            tx: { data: calldata.calldata, from: calldata.from ?? root, to: calldata.to, gas: calldata.gas },
            expectedAddress: root,
            tokenId,
            tokenAddress: asset.address ?? null,
            symbol,
            decimals,
            rawAmount: resolvedAmount,
            amount: resolvedAmount,
            humanAmount: enriched.humanAmount,
          },
          renderResponse: (result, url) => jsonResult({
            ok: true,
            action: 'vault_pay_treasury',
            tokenId,
            ...enriched,
            txHash: (result as any)?.txHash,
            message: `Treasury payment of ${enriched.humanAmount} ${symbol} submitted; the backend will credit your gas budget after the receipt is indexed.`,
            nextTool: { name: 'get_gas_balance', args: {}, why: 'Confirm the gas-budget credit landed (may take a few seconds for the indexer).' },
            url,
          }),
        };
      },
    })),
  );
}
