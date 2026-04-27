import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFundingSymbolsTools } from './symbols.js';
import { registerFundingSettlementTools } from './settlement.js';

export function registerFundingTools(server: McpServer): void {
  registerFundingSymbolsTools(server);
  registerFundingSettlementTools(server);
}
