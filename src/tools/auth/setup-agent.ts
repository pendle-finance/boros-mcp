import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AGENT_EXPIRY_DAYS } from '../../config.js';
import { jsonResult, formatDuration } from '../../utils.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import {
  generateAgentKey, getAgentMeta,
} from '../../agent/agent-manager.js';
import { createPendingAction, storeAgentKey, openPage } from '../../wallet-flow/server.js';
import { privateKeyToAccount } from 'viem/accounts';

export function registerSetupAgentTool(server: McpServer) {
  server.registerTool(
    'setup_agent',
    {
      annotations: { destructiveHint: true },
      description: 'Bootstrap the MCP trading agent on Arbitrum One (chainId 42161). Opens a localhost browser page; the user connects MetaMask/Rabby and signs ONE EIP-712 typed message (NOT a transaction — no gas paid by the user; send-txs-bot relays the approval on-chain). Required before any trading tool can run. The agent is bounded by contract to 12 trade/AMM router selectors — it CANNOT withdraw, transfer cash to other wallets, change account managers, or approve other agents. The browser page asks for a PASSWORD that encrypts the agent key on disk; an empty password is allowed only if the user ticks an explicit acknowledgement checkbox (otherwise the form refuses to submit) — see agent_status.passwordProtected to detect the unprotected case post-setup. Default approval duration is 30 days; pass `expiryDays` (1–365) to override (also editable on the signing page). The MCP agent is independent of any agent created in the Pendle dapp UI. Auto-renewal: if the locally-recorded agent has already expired, this tool will silently generate a fresh keypair and re-approve. If the prior local agent is still valid, this tool refuses unless `force:true` — in that case, run `revoke_agent` on the old agentAddress first, otherwise both keys remain valid on-chain until the original expiry.',
      inputSchema: {
        expiryDays: z.number().int().min(1).max(365).optional().describe('Approval duration in days (1–365). Default 30. The signing page also lets the user adjust this before signing.'),
        force: z.boolean().default(false).describe('Overwrite an already-configured local agent that has not yet expired. Only use AFTER calling revoke_agent on the old agentAddress — otherwise the old approval stays live on-chain until its original expiry and BOTH keys can sign trades simultaneously. Locally-expired agents auto-renew without this flag.'),
      },
    },
    async ({ force, expiryDays }) => {
      try {
        // Refuse re-run while previous local agent is still active — old on-chain approval
        // remains valid until its expiry, so both keys would sign simultaneously. Locally-
        // expired agent treated as natural renewal (dapp parity).
        const existing = getAgentMeta();
        const nowSec = Math.floor(Date.now() / 1000);
        const existingExpired = existing ? nowSec > existing.expiryTimestamp : false;
        if (existing && !existingExpired && !force) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            `Agent already configured for ${existing.rootAddress} (agentAddress=${existing.agentAddress}, expires ${new Date(existing.expiryTimestamp * 1000).toISOString()}). Call revoke_agent({ agentAddress: "${existing.agentAddress}" }) first, then re-run setup_agent with force:true. Do NOT pass force:true without revoking — the old on-chain approval will remain valid until expiry.`,
          );
        }

        const requestedDays = expiryDays ?? AGENT_EXPIRY_DAYS;

        const privateKey = generateAgentKey();
        const account = privateKeyToAccount(privateKey);
        const agentAddress = account.address;

        // PUBLIC data only — private key stored server-side, never exposed to the browser.
        const { token: actionToken, promise } = createPendingAction({
          type: 'approve_agent',
          agentAddress,
          expiryDays: requestedDays,
        });

        storeAgentKey(actionToken, privateKey);

        const url = await openPage('/approve-agent', { token: actionToken });

        const result = await promise;

        // Use result.expiry (set by /api/complete) — getAgentStatus() can race or fall back to
        // the default if the user picked a non-default duration on the page.
        const meta = getAgentMeta();
        const signedExpiry = Number((result as any)?.expiry ?? meta?.expiryTimestamp ?? 0);
        const expiryDate = signedExpiry > 0 ? new Date(signedExpiry * 1000).toISOString() : undefined;
        const secondsRemaining = signedExpiry > 0 ? Math.max(0, signedExpiry - Math.floor(Date.now() / 1000)) : 0;
        const daysRemaining = Math.floor(secondsRemaining / 86400);
        return jsonResult({
          ok: true,
          action: 'setup_agent',
          agentAddress,
          rootAddress: meta?.rootAddress ?? (result as any)?.rootAddress,
          expiryDate,
          daysRemaining,
          humanRemaining: formatDuration(secondsRemaining),
          message: `Agent approved! Wallet connected for ${formatDuration(secondsRemaining)} (until ${expiryDate ?? 'unknown'}).`,
          url,
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
