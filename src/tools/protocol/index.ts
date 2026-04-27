import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerProtocolTvlTools } from './tvl.js';
import { registerProtocolGasPriceTools } from './gas-price.js';
import { registerProtocolAssetsTools } from './assets.js';

export function registerProtocolTools(server: McpServer): void {
  registerProtocolTvlTools(server);
  registerProtocolGasPriceTools(server);
  registerProtocolAssetsTools(server);
}
