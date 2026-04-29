import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult } from '../utils.js';
import { BOROS_GLOSSARY } from './_context.js';
import { CROSS_MARKET_ID, ROUTER_ADDRESS, CHAIN_ID } from '../config.js';

export function registerGlossaryTool(server: McpServer): void {
  server.registerTool(
    'boros_glossary',
    {
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Returns the Boros domain glossary (apr, side, marketAcc, cross/isolated, tick, YU, agent, router) plus chain constants. ' +
        'Call once when uncertain about a term. Reference only — does not invoke any other tool.',
      inputSchema: {},
    },
    async () =>
      jsonResult({
        glossary: BOROS_GLOSSARY,
        constants: {
          CROSS_MARKET_ID,
          ROUTER_ADDRESS,
          CHAIN_ID: CHAIN_ID.toString(),
        },
      }),
  );
}
