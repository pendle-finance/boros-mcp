import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAccountPositionsTools } from './positions.js';
import { registerAccountOrdersTools } from './orders.js';
import { registerAccountHistoryTools } from './history.js';
import { registerAccountGasTools } from './gas.js';

export function registerAccountTools(server: McpServer): void {
  registerAccountPositionsTools(server);
  registerAccountOrdersTools(server);
  registerAccountHistoryTools(server);
  registerAccountGasTools(server);
}
