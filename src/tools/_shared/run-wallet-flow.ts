// Canonical browser-flow recipe shared by deposit, withdraw, cancel_withdraw, vault_pay_treasury,
// revoke_agent. Owns the USER_CANCELLED + catchToErrorContent envelope so each tool only describes
// per-tool diffs.
import type { Address } from 'viem';
import { createPendingAction, openPage } from '../../wallet-flow/server.js';
import type { RequireAuthOk } from '../../agent/require-auth.js';
import { BorosErrorCode, catchToErrorContent, classifyError } from '../../agent/errors.js';

function isUserCancelledError(err: unknown): boolean {
  const direct = (err as { __borosCode?: string } | null | undefined)?.__borosCode;
  if (direct === BorosErrorCode.USER_CANCELLED) return true;
  // Fallback handles rewrapped errors.
  return classifyError(err) === BorosErrorCode.USER_CANCELLED;
}

function userCancelledContent(
  toolName: string,
  toolArgs: Record<string, unknown>,
  actionLabel: string,
) {
  const payload = {
    ok: false,
    error: {
      code: BorosErrorCode.USER_CANCELLED,
      message: `User cancelled the ${actionLabel} flow before signing.`,
      retryable: false,
      action:
        'User cancelled the wallet flow (closed the tab or clicked cancel). No on-chain action was taken; no funds are at risk. Re-issue the same tool call when the user is ready to complete it.',
    },
    cancelled: true,
    onChainStateChanged: false,
    fundsAtRisk: false,
    nextTool: {
      name: toolName,
      args: toolArgs,
      why: 'User asked to cancel; if they want to retry, re-issue the same tool call to reopen the signing page.',
    },
  };
  const pretty = process.env.BOROS_MCP_PRETTY === '1';
  return {
    content: [
      {
        type: 'text' as const,
        text: pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload),
      },
    ],
    isError: true,
  };
}

export async function runWalletFlow<R extends { content: any[] }>(args: {
  auth: RequireAuthOk;
  toolName: string;
  cancelArgs: Record<string, unknown>;
  actionLabel: string;
  pagePath: string;
  setup: (auth: { rootAddress: Address; agentAddress: Address; agentExpiry: number }) => Promise<{
    pendingData: any;
    renderResponse: (result: unknown, url: string) => R | Promise<R>;
  }>;
}) {
  try {
    const { pendingData, renderResponse } = await args.setup({
      rootAddress: args.auth.rootAddress,
      agentAddress: args.auth.agentAddress,
      agentExpiry: args.auth.agentExpiry,
    });
    const { token: actionToken, promise } = createPendingAction(pendingData);
    const url = await openPage(args.pagePath, { token: actionToken });
    const result = await promise;
    return await renderResponse(result, url);
  } catch (err) {
    if (isUserCancelledError(err)) {
      return userCancelledContent(args.toolName, args.cancelArgs, args.actionLabel);
    }
    return catchToErrorContent(err);
  }
}
