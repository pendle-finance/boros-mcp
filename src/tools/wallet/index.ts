import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDepositTool } from './deposit.js';
import { registerWithdrawTool, registerCancelWithdrawTool } from './withdraw.js';
import { registerVaultPayTreasuryTool } from './treasury.js';

export function registerWalletTools(server: McpServer): void {
  registerDepositTool(server);
  registerWithdrawTool(server);
  registerVaultPayTreasuryTool(server);
  registerCancelWithdrawTool(server);
}
