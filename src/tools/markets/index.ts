import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMarketsRegistryTools } from './registry.js';
import { registerMarketsMicrostructureTools } from './microstructure.js';
import { registerMarketsChartTools } from './chart.js';
import { registerMarketsIndicatorsTools } from './indicators.js';
import { registerMarketsStrategiesTools } from './strategies.js';

export function registerMarketsTools(server: McpServer): void {
  registerMarketsRegistryTools(server);
  registerMarketsMicrostructureTools(server);
  registerMarketsChartTools(server);
  registerMarketsIndicatorsTools(server);
  registerMarketsStrategiesTools(server);
}
