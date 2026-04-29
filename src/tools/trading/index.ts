import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerOrderTools } from './orders.js';
import { registerCloseTools } from './close.js';
import { registerCancelTools } from './cancel.js';
import { registerTransferTools } from './transfer.js';
import { registerGasTools } from './gas.js';
import { registerBulkTools } from './bulk.js';
import { registerMarketsTools } from './markets.js';

export function registerTradingTools(server: McpServer) {
  registerOrderTools(server);
  registerCloseTools(server);
  registerCancelTools(server);
  registerTransferTools(server);
  registerGasTools(server);
  registerBulkTools(server);
  registerMarketsTools(server);
}
