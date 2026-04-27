import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CHAIN_ID } from '../../config.js';
import { jsonResult, formatDuration } from '../../utils.js';
import { catchToErrorContent } from '../../agent/errors.js';
import {
  isAgentReady, getAgentMeta, isAgentLocked,
} from '../../agent/agent-manager.js';
import { openApiGet } from '../../api/open-api.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';

export function registerAgentStatusTool(server: McpServer) {
  server.registerTool(
    'agent_status',
    {
      annotations: { readOnlyHint: true },
      description: 'Check the local MCP agent\'s status. Returns `configured`, `locked`, `ready`, `agentAddress`, `rootAddress`, `accountId` (always 0 for the MCP), `chainId` (42161), `expiryDate`, `isExpired`, `daysRemaining`, `secondsRemaining`, `humanRemaining`, `createdAt`, plus on-chain reconciliation against the Boros Router (`GET /v1/agents/expiry-time`). Sets `onChainExpiryMismatch=true` if the local meta and the on-chain `agentExpiry` storage diverge — e.g. the user revoked the approval from the dapp or another wallet (in which case any trade would fail at signing time). For inspecting OTHER agents (third-party bots) or non-zero accountIds, use get_agent_expiry instead.',
      inputSchema: {},
    },
    async () => {
      try {
        const meta = getAgentMeta();

        // `configured` reflects on-disk presence regardless of unlock state — keeps this in
        // sync with setup_agent's refusal path which also reads meta directly.
        if (!meta) {
          return jsonResult({
            configured: false,
            chainId: Number(CHAIN_ID),
            message: 'No agent configured. Call setup_agent to connect your wallet.',
            nextTool: { name: 'setup_agent', params: {} },
          });
        }

        const ready = isAgentReady();
        const locked = isAgentLocked();
        const now = Date.now() / 1000;
        const isExpired = now > meta.expiryTimestamp;
        // floor matches agent-manager.ts:200 — avoids over-reporting by a day when expiry is < 1 day away.
        const secondsRemaining = Math.max(0, Math.floor(meta.expiryTimestamp - now));
        const daysRemaining = Math.floor(secondsRemaining / 86400);
        const expiryDate = new Date(meta.expiryTimestamp * 1000).toISOString();

        // Reconcile on-chain BEFORE the locked-branch early-return so password-locked agents
        // still surface external revocations. Probe is unauthenticated.
        let onChainExpiryTime: number | undefined;
        let onChainExpiryIso: string | undefined;
        let onChainApproved: boolean | undefined;
        let onChainExpiryMismatch = false;
        let onChainCheckError: string | undefined;
        try {
          const res = await fetchWithRetry(() =>
            openApiGet('/v1/agents/expiry-time', {
              root: meta.rootAddress,
              accountId: 0,
              agentAddress: meta.agentAddress,
            }),
          );
          onChainExpiryTime = Number(res?.expiryTime ?? 0);
          onChainApproved = onChainExpiryTime > now;
          if (onChainExpiryTime > 0) {
            onChainExpiryIso = new Date(onChainExpiryTime * 1000).toISOString();
          }
          // Mismatch: local claims valid but chain says no, OR expiries diverge >60s (genuine clock
          // skew is sub-second).
          if (!isExpired && (!onChainApproved || Math.abs(onChainExpiryTime - meta.expiryTimestamp) > 60)) {
            onChainExpiryMismatch = true;
          }
        } catch (err) {
          // Truncate to avoid leaking verbose backend HTML/error pages into the response.
          const raw = err instanceof Error ? err.message : String(err);
          onChainCheckError = raw.length > 240 ? raw.slice(0, 240) + '…' : raw;
        }

        // Stable shape across every branch.
        const baseFields = {
          configured: true,
          chainId: Number(CHAIN_ID),
          accountId: 0,
          agentAddress: meta.agentAddress,
          rootAddress: meta.rootAddress,
          createdAt: meta.createdAt,
          localExpiryTime: meta.expiryTimestamp,
          expiryDate,
          isExpired,
          daysRemaining,
          secondsRemaining,
          humanRemaining: formatDuration(secondsRemaining),
          ready,
          locked,
        };

        const onChainFields = onChainExpiryTime !== undefined
          ? {
              onChain: {
                expiryTime: onChainExpiryTime,
                expiryIso: onChainExpiryIso,
                isApproved: onChainApproved,
              },
              onChainExpiryMismatch,
            }
          : { onChainCheckError };

        if (!ready && locked) {
          return jsonResult({
            ...baseFields,
            ...onChainFields,
            message: 'Agent is password-protected and not yet unlocked. A browser unlock page is opened on first use; enter the password there.',
          });
        }

        let message: string;
        let nextTool: { name: string; params: Record<string, unknown> } | undefined;
        if (isExpired) {
          message = 'Agent has expired locally. Call setup_agent to re-approve (locally-expired agents auto-renew without force).';
          nextTool = { name: 'setup_agent', params: {} };
        } else if (onChainExpiryMismatch) {
          if (onChainApproved === false) {
            message = 'Agent appears active locally, but the on-chain approval is GONE — the user (or another tool) revoked it. There is nothing to revoke; just call setup_agent with force:true to re-approve.';
            nextTool = { name: 'setup_agent', params: { force: true } };
          } else {
            message = 'Local and on-chain expiries disagree (the agent was likely re-approved with a different duration externally). Compare localExpiryTime vs onChain.expiryTime and re-run setup_agent if needed.';
          }
        } else {
          message = `Agent is active with ${formatDuration(secondsRemaining)} remaining.`;
        }

        return jsonResult({
          ...baseFields,
          ...onChainFields,
          message,
          ...(nextTool ? { nextTool } : {}),
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
