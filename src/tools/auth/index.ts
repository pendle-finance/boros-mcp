import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSetupAgentTool } from './setup-agent.js';
import { registerAgentStatusTool } from './agent-status.js';
import { registerRevokeAgentTool } from './revoke-agent.js';

export function registerAuthTools(server: McpServer): void {
  registerSetupAgentTool(server);
  registerAgentStatusTool(server);
  registerRevokeAgentTool(server);
}
