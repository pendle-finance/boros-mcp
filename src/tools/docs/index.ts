import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDocsTool } from './tool.js';
import { registerDocsResources } from './resources.js';

export function registerDocsTools(server: McpServer): void {
  registerDocsTool(server);
  registerDocsResources(server);
}
