import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLeaderboardListTools } from './list.js';

export function registerLeaderboardTools(server: McpServer): void {
  registerLeaderboardListTools(server);
}
