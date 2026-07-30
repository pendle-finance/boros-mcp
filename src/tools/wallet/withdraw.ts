import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiPost } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { getAssetInfo } from '../../api/asset-cache.js';
import { tokenIdField } from '../_schemas.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';
import { runWalletFlow } from '../_shared/run-wallet-flow.js';
import { resolveTokenAmount } from './_resolve-token-amount.js';
import {
  buildCooldownBlock,
  fetchPendingWithdrawal,
  fetchPendingWithdrawalWithSync,
} from './_withdraw-helpers.js';
import { errorContent, BorosErrorCode } from '../../agent/errors.js';

export function registerWithdrawTool(server: McpServer) {
  server.registerTool(
    'withdraw',
    {
      annotations: { destructiveHint: true },
      description: 'Request an on-chain withdrawal of collateral from your CROSS margin account. Opens a browser page; YOUR WALLET (root EOA) signs — the agent key is NOT used. Two-step withdrawal: this submits the request, then the protocol auto-finalizes after a cooldown (~15 min on mainnet; can be longer if your account is flagged by the on-chain withdrawal-policy enforcement). There is no separate claim step. To withdraw isolated collateral, first run `cash_transfer({direction:"ISOLATED_TO_CROSS"})`. IMPORTANT: re-running this while a withdrawal is already pending ADDS the new amount to the existing pending balance AND RESETS the cooldown clock — use `cancel_withdraw` if you want to undo. Use `humanAmount` to avoid decimals-unit mistakes.',
      inputSchema: {
        tokenId: tokenIdField('Asset to withdraw.'),
        amount: z.string().optional().describe('Raw amount (in the token\'s smallest unit). Provide either amount or humanAmount.'),
        humanAmount: z.number().optional().describe('Human-readable amount (e.g. 50.0 USDT). Provide either amount or humanAmount.'),
      },
    },
    withAuth(async ({ tokenId, amount, humanAmount }, auth) => runWalletFlow({
      auth,
      toolName: 'withdraw',
      cancelArgs: {
        tokenId,
        ...(amount !== undefined ? { amount } : {}),
        ...(humanAmount !== undefined ? { humanAmount } : {}),
      },
      actionLabel: 'withdrawal',
      pagePath: '/withdraw',
      setup: async ({ rootAddress: root }) => {
        const { asset, decimals, symbol, resolvedAmount, enriched } = await resolveTokenAmount(
          tokenId,
          amount,
          humanAmount,
        );

        // Two different units for the same withdrawal: the simulation DTO takes 1e18 cash-accounting
        // units, the calldata body takes token-native decimals. Do NOT unify them.
        const [simulation, calldata, pendingWithdrawal] = await Promise.all([
          fetchWithRetry(() =>
            openApiPost('/v1/simulations/request-withdrawal', {
              root,
              tokenId,
              amount: ((BigInt(resolvedAmount) * 10n ** 18n) / 10n ** BigInt(decimals)).toString(),
            }),
          ),
          fetchWithRetry(() =>
            openApiPost('/v1/calldata-builder/user/request-withdrawal', { root, tokenId, amount: resolvedAmount }),
          ),
          // Best-effort surface existing pending so user doesn't accidentally reset cooldown.
          fetchPendingWithdrawal(root, 0, tokenId, decimals, symbol),
        ]);

        return {
          pendingData: {
            type: 'withdraw',
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
            ...(pendingWithdrawal ? { pendingWithdrawal } : {}),
            pendingSameAmount: Boolean(pendingWithdrawal && pendingWithdrawal.rawAmount === resolvedAmount),
          },
          renderResponse: async (result, url) => {
            const cooldown = await buildCooldownBlock(root);
            return jsonResult({
              ok: true,
              action: 'withdraw_request',
              tokenId,
              ...enriched,
              txHash: (result as any)?.txHash,
              ...((simulation as any)?.preUserState || (simulation as any)?.postUserState
                ? { simulation: { preUserState: (simulation as any)?.preUserState, postUserState: (simulation as any)?.postUserState } }
                : {}),
              ...(pendingWithdrawal
                ? {
                    pendingWithdrawal: {
                      ...pendingWithdrawal,
                      note: 'A withdrawal was already pending before this call. The contract ADDS the new amount to user.unscaled and RESETS the cooldown clock.',
                    },
                    nextTool: { name: 'cancel_withdraw', args: { tokenId }, why: 'Cancel the pending withdrawal (returns the full accumulated amount to your cross account).' },
                  }
                : {}),
              cooldown,
              message: `Withdrawal request submitted for ${enriched.humanAmount} ${symbol}. Funds auto-finalize after the cooldown — no claim step needed.`,
              url,
            });
          },
        };
      },
    })),
  );
}

export function registerCancelWithdrawTool(server: McpServer) {
  server.registerTool(
    'cancel_withdraw',
    {
      annotations: { destructiveHint: true },
      description: 'Cancel YOUR pending COLLATERAL WITHDRAWAL that is still queued (cooldown or post-cooldown but pre-finalize). Opens a browser page; YOUR WALLET (root EOA) signs — the agent key is NOT used. The contract returns the entire accumulated `user.unscaled` balance back to your cross account; subsequent `withdraw` calls restart the cooldown clock from zero. Use this for vault-withdrawal cancellation only. Do NOT use for: cancelling limit orders (use `cancel_orders`), revoking a trading agent (use `revoke_agent`), or cancelling a deposit (deposits are atomic — no cancel exists). Run `get_collateral` first to find the tokenId of an asset with a pending withdrawal.',
      inputSchema: {
        tokenId: tokenIdField('Asset whose pending withdrawal to cancel.'),
        force: z.boolean().default(false).describe('Skip the no-pending-detected guard and submit the on-chain cancel anyway. Use only when you believe the indexer is stale (e.g. you JUST submitted withdraw and it has not propagated yet). Default false — when no pending is detected and the indexer is fresh, the tool returns an error instead of paying gas for a no-op.'),
      },
    },
    withAuth(async ({ tokenId, force }, auth) => {
      const root = auth.rootAddress;

      // Pre-flight: trust the no-pending signal and reject by default. force:true is the explicit
      // escape hatch for indexer lag (e.g. user JUST submitted withdraw and it hasn't propagated).
      // Earlier version gated this on indexer freshness, but undefined syncTimestamp from the helper's
      // error path silently disabled the guard — so the on-chain noOp tx still fired.
      if (!force) {
        const asset = await getAssetInfo(tokenId);
        const symbol: string = asset.symbol ?? `TOKEN-${tokenId}`;
        const decimals: number = asset.decimals ?? 18;
        const { pending, syncTimestamp } = await fetchPendingWithdrawalWithSync(
          root,
          0,
          tokenId,
          decimals,
          symbol,
        );
        if (!pending) {
          const lagSec =
            syncTimestamp !== undefined
              ? Math.max(0, Math.floor(Date.now() / 1000) - syncTimestamp)
              : undefined;
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            `No pending withdrawal detected for ${symbol} (tokenId ${tokenId})${
              lagSec !== undefined ? `; indexer lag ${lagSec}s` : ''
            }. Pass force:true to submit anyway (e.g. you just submitted withdraw and the indexer has not propagated).`,
          );
        }
      }

      return runWalletFlow({
      auth,
      toolName: 'cancel_withdraw',
      cancelArgs: { tokenId, ...(force ? { force } : {}) },
      actionLabel: 'withdrawal cancellation',
      pagePath: '/cancel-withdraw',
      setup: async ({ rootAddress: root }) => {
        const [asset, calldata] = await Promise.all([
          getAssetInfo(tokenId),
          fetchWithRetry(() =>
            openApiPost('/v1/calldata-builder/user/cancel-withdrawal', { root, tokenId }),
          ),
        ]);
        const symbol: string = asset.symbol ?? `TOKEN-${tokenId}`;
        const decimals: number = asset.decimals ?? 18;
        // Fetch pending so the cancel page can show what's being cancelled.
        const pendingWithdrawal = await fetchPendingWithdrawal(root, 0, tokenId, decimals, symbol);

        return {
          pendingData: {
            type: 'cancel_withdraw',
            calldata: calldata.calldata,
            from: calldata.from ?? root,
            to: calldata.to,
            gas: calldata.gas,
            expectedAddress: root,
            tokenId,
            tokenSymbol: symbol,
            ...(pendingWithdrawal ? { pendingWithdrawal } : {}),
          },
          // cancelVaultWithdrawal silently no-ops (emits ...Canceled(..., 0)) when nothing pending.
          // pendingWithdrawal is the on-chain snapshot taken when this page was prepared — a hint,
          // not proof of the tx outcome, since the wallet may sign minutes later. Never claim
          // certainty; when there is no snapshot the outcome is unknown, not necessarily a no-op.
          renderResponse: (result, url) => {
            const txHash = (result as any)?.txHash as string | undefined;
            return jsonResult({
              ok: true,
              action: 'cancel_withdraw',
              tokenId,
              symbol,
              ...(txHash ? { txHash } : {}),
              ...(pendingWithdrawal
                ? {
                    cancelledAmount: pendingWithdrawal.humanAmount,
                    cancelledAmountSource: 'preflight_onchain_snapshot',
                  }
                : { outcome: 'indeterminate' }),
              message: pendingWithdrawal
                ? `Cancel transaction submitted for ${symbol}. ${pendingWithdrawal.humanAmount} ${symbol} was pending when this request was prepared — if it was still pending at signing time it is now back in your cross margin account. Run get_collateral to confirm the final balance.`
                : `Cancel transaction submitted for ${symbol}. Nothing was pending when this request was prepared, so the call may have been a no-op (gas still paid) — but a withdrawal submitted in between would have been cancelled. Run get_collateral or get_transfer_logs to confirm.`,
              url,
            });
          },
        };
      },
      });
    }),
  );
}
