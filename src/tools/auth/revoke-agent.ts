import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Address } from 'viem';
import { openApiPost } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { addressFieldOptional } from '../_schemas.js';
import { BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';
import { getAgentMeta, clearAgent } from '../../agent/agent-manager.js';
import { runWalletFlow } from '../_shared/run-wallet-flow.js';

export function registerRevokeAgentTool(server: McpServer) {
  server.registerTool(
    'revoke_agent',
    {
      annotations: { destructiveHint: true },
      description: 'Revoke an on-chain trading-agent approval. Opens a browser page; YOUR WALLET (root EOA) signs and broadcasts Router.revokeAgent on Arbitrum (you pay gas). REVOCATION IS IRREVERSIBLE — to use the agent again you must run `setup_agent` (with `force:true`) to issue a fresh approval. If `agentAddress` matches the agent currently used by this MCP install, every subsequent place_order / cancel_orders / pay_gas will revert at agentExecute until you re-run `setup_agent`. Re-running `setup_agent` ALONE does NOT revoke — it only generates a new key locally; the old on-chain approval keeps signing rights until expiry (up to 30 days). Use this for agent revocation only. Do NOT use for cancelling withdrawals (`cancel_withdraw`) or limit orders (`cancel_orders`).',
      inputSchema: {
        agentAddress: addressFieldOptional('agentAddress', 'Agent wallet address to revoke (0x...). Defaults to the agent currently configured in this MCP install.'),
        accountId: z.number().int().min(0).max(0).default(0).describe('Account ID — only 0 (the main/cross account) is supported today.'),
      },
    },
    withAuth(async ({ agentAddress, accountId }, auth) => runWalletFlow({
      auth,
      toolName: 'revoke_agent',
      cancelArgs: {
        ...(agentAddress !== undefined ? { agentAddress } : {}),
        accountId: accountId ?? 0,
      },
      actionLabel: 'agent revocation',
      pagePath: '/sign-tx',
      setup: async ({ rootAddress: root }) => {
        // Default target is the local MCP agent (LLM rarely has another address).
        const localMeta = getAgentMeta();
        const targetAgent = (agentAddress ?? localMeta?.agentAddress) as Address | undefined;
        if (!targetAgent) {
          throw Object.assign(
            new Error('agentAddress is required when no local agent is configured.'),
            { __borosCode: BorosErrorCode.INVALID_PARAMS },
          );
        }
        const isCurrentMcpAgent = Boolean(
          localMeta?.agentAddress &&
            localMeta.agentAddress.toLowerCase() === targetAgent.toLowerCase(),
        );

        const calldata = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/user/revoke-agent', {
            root,
            accountId: accountId ?? 0,
            agentAddress: targetAgent,
          }),
        );

        return {
          pendingData: {
            type: 'revoke_agent',
            tx: { data: calldata.calldata, from: calldata.from ?? root, to: calldata.to, gas: calldata.gas },
            expectedAddress: root,
            agentAddress: targetAgent,
            accountId: accountId ?? 0,
            isCurrentMcpAgent,
          },
          renderResponse: (result, url) => {
            // Wipe local key/meta when revoking this MCP's own agent so the next agent-signed
            // call fails fast instead of signing typed data that agentExecute will revert.
            let localKeyCleared = false;
            if (isCurrentMcpAgent) {
              clearAgent();
              localKeyCleared = true;
            }
            return jsonResult({
              ok: true,
              action: 'revoke_agent',
              agentAddress: targetAgent,
              accountId: accountId ?? 0,
              txHash: (result as any)?.txHash,
              isCurrentMcpAgent,
              localKeyCleared,
              ...(isCurrentMcpAgent
                ? {
                    warning: 'You revoked the agent currently used by this MCP install. The local agent key has been deleted. Run setup_agent before placing any further trades.',
                    nextTool: { name: 'setup_agent', args: {}, why: 'Issue a fresh on-chain approval and a new local agent key.' },
                  }
                : {}),
              message: `Agent ${targetAgent} has been revoked on-chain.`,
              url,
            });
          },
        };
      },
    })),
  );
}
