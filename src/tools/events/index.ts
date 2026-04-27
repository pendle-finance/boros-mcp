import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEventsLiquidationsTools } from './liquidations.js';
import { registerEventsOnChainTools } from './on-chain.js';

export function registerEventsTools(server: McpServer): void {
  registerEventsLiquidationsTools(server);
  registerEventsOnChainTools(server);
}
