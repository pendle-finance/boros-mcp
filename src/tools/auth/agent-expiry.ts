import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichTimestamp, formatDuration } from '../../utils.js';
import {
  userAddressField,
  addressField,
  accountIdField,
} from '../_schemas.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';

export function registerAgentExpiryTool(server: McpServer) {
  server.registerTool(
    'get_agent_expiry',
    {
      annotations: { readOnlyHint: true },
      description: 'Read the on-chain agent-approval expiry for any (userAddress, accountId, agent) triple by querying the Router.agentExpiry mapping via the backend. Public/read-only — does not require setup_agent. expiryTime=0 means the agent is NOT currently approved (covers both never-approved and previously-revoked cases — the contract `delete`s the slot on revoke). Use agent_status for the locally-configured MCP agent; use this for arbitrary third-party agents.',
      inputSchema: {
        userAddress: userAddressField('User wallet address (0x...)'),
        accountId: accountIdField(),
        agentAddress: addressField('agentAddress', 'Agent wallet address to check (0x...)'),
      },
    },
    async ({ userAddress, accountId, agentAddress }) => {
      try {
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
        // floor matches agent_status / agent-manager — avoids over-reporting by a day when expiry is < 1 day away.
        const daysRemaining = isApproved ? Math.floor(secondsRemaining / 86400) : 0;
        const expiringSoon = isApproved && secondsRemaining <= 7 * 86400;
        return jsonResult({
          userAddress,
          accountId,
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
            daysRemaining: 'Math.floor((expiryTime - now) / 86400) — full whole days remaining; matches agent_status. For sub-day precision read secondsRemaining or `remaining`.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
