import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CHAIN_ID } from '../../config.js';
import { jsonResult, enrichTimestamp, formatDuration } from '../../utils.js';
import { catchToErrorContent } from '../../agent/errors.js';
import {
  isAgentReady, getAgentMeta, isAgentLocked, isAgentPasswordProtected,
} from '../../agent/agent-manager.js';
import { openApiGet } from '../../api/open-api.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import {
  userAddressFieldOptional,
  addressFieldOptional,
  accountIdField,
} from '../_schemas.js';

export function registerAgentStatusTool(server: McpServer) {
  server.registerTool(
    'agent_status',
    {
      annotations: { readOnlyHint: true },
      description: `Check agent approval status. Two modes:

LOCAL MODE (no args, or only \`accountId\`): inspect THIS MCP install's configured agent. Returns \`configured\`, \`locked\`, \`ready\`, \`passwordProtected\` (false → on-disk key is encrypted with empty password and will auto-decrypt on every MCP startup; surfaces a \`securityWarning\`), \`agentAddress\`, \`rootAddress\`, \`accountId\` (always 0 for the MCP), \`chainId\` (42161), \`expiryDate\`, \`isExpired\`, \`daysRemaining\`, \`secondsRemaining\`, \`humanRemaining\`, \`createdAt\`, plus on-chain reconciliation against the Boros Router (\`GET /v1/agents/expiry-time\`). Sets \`onChainExpiryMismatch=true\` if local meta and on-chain \`agentExpiry\` storage diverge — e.g. user revoked the approval externally (any trade would fail at signing time).

LOOKUP MODE (\`agentAddress\` + \`userAddress\` set): read the on-chain agent-approval expiry for any (userAddress, accountId, agent) triple. Public/read-only, does NOT require setup_agent. \`expiryTime=0\` means the agent is NOT currently approved (covers never-approved AND previously-revoked — the contract \`delete\`s the slot on revoke).`,
      inputSchema: {
        agentAddress: addressFieldOptional(
          'agentAddress',
          'Agent wallet address to look up. Set this (with userAddress) to switch to LOOKUP MODE for a third-party agent.',
        ),
        userAddress: userAddressFieldOptional(
          'Required when agentAddress is set (LOOKUP MODE).',
        ),
        accountId: accountIdField('LOCAL MODE: ignored (MCP always uses 0). LOOKUP MODE: queries that triple.'),
      },
    },
    async ({ agentAddress, userAddress, accountId }) => {
      try {
        // LOOKUP MODE — third-party agent expiry lookup, no local-agent semantics.
        if (agentAddress && userAddress) {
          const res = await fetchWithRetry(() =>
            openApiGet('/v1/agents/expiry-time', {
              root: userAddress,
              accountId: accountId ?? 0,
              agentAddress,
            }),
          );
          const expiryTime = res.expiryTime ?? 0;
          const now = Math.floor(Date.now() / 1000);
          const isApproved = expiryTime > now;
          const secondsRemaining = isApproved ? expiryTime - now : 0;
          const daysRemaining = isApproved ? Math.floor(secondsRemaining / 86400) : 0;
          const expiringSoon = isApproved && secondsRemaining <= 7 * 86400;
          return jsonResult({
            mode: 'lookup',
            userAddress,
            accountId: accountId ?? 0,
            agentAddress,
            expiryTime,
            ...(expiryTime > 0 ? { expiry: enrichTimestamp(expiryTime) } : {}),
            isApproved,
            secondsRemaining,
            daysRemaining,
            ...(isApproved ? { remaining: formatDuration(secondsRemaining) } : {}),
            ...(expiringSoon ? { warning: `Approval expires in ${formatDuration(secondsRemaining)}; consider re-approving via setup_agent.` } : {}),
            _context: {
              expiryTime: 'Unix seconds when on-chain approval expires. 0 means not currently approved (never-approved or revoked — both clear the slot).',
              isApproved: 'expiryTime > nowSeconds, computed against the MCP host clock.',
            },
          });
        }
        if (agentAddress && !userAddress) {
          return jsonResult({
            error: 'agentAddress requires userAddress for LOOKUP MODE. Omit both for LOCAL MODE.',
          });
        }

        // LOCAL MODE
        const meta = getAgentMeta();
        if (!meta) {
          return jsonResult({
            mode: 'local',
            configured: false,
            chainId: Number(CHAIN_ID),
            message: 'No agent configured. Call setup_agent to connect your wallet.',
            nextTool: { name: 'setup_agent', params: {} },
          });
        }

        const ready = isAgentReady();
        const locked = isAgentLocked();
        const passwordProtected = isAgentPasswordProtected();
        const now = Date.now() / 1000;
        const isExpired = now > meta.expiryTimestamp;
        const secondsRemaining = Math.max(0, Math.floor(meta.expiryTimestamp - now));
        const daysRemaining = Math.floor(secondsRemaining / 86400);
        const expiryDate = new Date(meta.expiryTimestamp * 1000).toISOString();

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
          if (!isExpired && (!onChainApproved || Math.abs(onChainExpiryTime - meta.expiryTimestamp) > 60)) {
            onChainExpiryMismatch = true;
          }
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          onChainCheckError = raw.length > 240 ? raw.slice(0, 240) + '…' : raw;
        }

        const baseFields = {
          mode: 'local',
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
          passwordProtected,
          ...(passwordProtected ? {} : {
            securityWarning: 'Agent key on disk is encrypted with EMPTY password — anyone with read access to ~/.boros-mcp/agent.enc can decrypt it. Re-run revoke_agent + setup_agent and set a non-empty password to harden.',
          }),
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
