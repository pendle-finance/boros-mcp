import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIncentivesMakerTools } from './maker.js';

export function registerIncentivesTools(server: McpServer): void {
  registerIncentivesMakerTools(server);
}
