import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPortfolioSummaryTools } from './summary.js';

export function registerPortfolioTools(server: McpServer): void {
  registerPortfolioSummaryTools(server);
}
