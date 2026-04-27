import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAmmInfoTools } from './info.js';
import { registerAmmVaultTools } from './vault.js';
import { registerAmmRewardsTools } from './rewards.js';
import { registerAmmLiquidityTools } from './liquidity.js';

export function registerAmmTools(server: McpServer): void {
  registerAmmInfoTools(server);
  registerAmmVaultTools(server);
  registerAmmRewardsTools(server);
  registerAmmLiquidityTools(server);
}
