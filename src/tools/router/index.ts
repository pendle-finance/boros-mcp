// `boros_router` discovery helper: free-form intent → Boros MCP tool suggestions or glossary block.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult } from '../../utils.js';
import { APR_NOTE, BOROS_GLOSSARY, SIDE_CONTEXT, MARKET_ACC_ENCODING } from '../_context.js';
import { CROSS_MARKET_ID, ROUTER_ADDRESS, CHAIN_ID } from '../../config.js';
import { CATALOG_BY_NAME, type ToolEntry } from './catalog.js';
import { matchTools } from './matcher.js';
import { assertCatalogMatchesRegistry, ROUTER_TOOL_NAME } from './drift.js';

export function registerRouterTool(server: McpServer) {
  // Drift check runs BEFORE we register the router so it sees only "real" tools.
  // `registerRouterTool` MUST remain the last call in `registerAllTools` for this to work.
  assertCatalogMatchesRegistry(server);

  server.registerTool(
    ROUTER_TOOL_NAME,
    {
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Tool-finder / discovery helper. Describe what you want to do in natural language and this returns the best Boros MCP tool(s) with example invocations. ' +
        'NOTE: this is a meta-tool, NOT the on-chain Pendle Boros Router contract — to place trades use simulate_order/place_order, to authorize the agent use setup_agent. ' +
        'Examples use `<marketId>` / `<tokenId>` placeholders — resolve real IDs via get_markets / get_assets before invoking the suggested tool. ' +
        'Call this once when uncertain, not on every turn.',
      inputSchema: {
        intent: z
          .string()
          .trim()
          .min(1, 'intent must not be empty')
          .max(500, 'intent must be at most 500 characters')
          .describe('Describe what you want to do, e.g. "open a long position", "check my balance", or "what is a tick"'),
      },
    },
    async ({ intent }) => {
      const { tools: matched, glossary } = matchTools(intent);

      if (glossary) {
        return jsonResult({
          intent,
          glossary: BOROS_GLOSSARY,
          constants: {
            CROSS_MARKET_ID,
            ROUTER_ADDRESS,
            CHAIN_ID: CHAIN_ID.toString(),
          },
          legacyContext: {
            apr: APR_NOTE,
            ...SIDE_CONTEXT,
            marketAcc: MARKET_ACC_ENCODING,
          },
          hint: 'These are reference definitions only — no tool was called. Re-invoke with a more specific action verb (e.g. "place a long") to get a tool suggestion.',
        });
      }

      if (matched.length > 0) {
        return jsonResult({
          intent,
          suggestedTools: matched.map((t) => ({
            tool: t.name,
            description: t.description,
            example: t.example,
          })),
          hint: matched.length === 1
            ? `Use the "${matched[0].name}" tool. Replace any <placeholders> in the example with real IDs.`
            : `Consider these ${matched.length} tools. Start with "${matched[0].name}" if unsure. Replace any <placeholders> in examples with real IDs (resolve via get_markets / get_assets).`,
        });
      }

      // Curated fallback — full dump blew context budget and LLM kept picking catalog[0].
      const fallbackNames = [
        'get_markets',
        'get_assets',
        'get_portfolio_summary',
        'simulate_order',
        'setup_agent',
        'agent_status',
        'deposit',
        'withdraw',
      ];
      const fallback = fallbackNames
        .map((n) => CATALOG_BY_NAME.get(n))
        .filter((e): e is ToolEntry => Boolean(e));

      return jsonResult({
        intent,
        _no_match: true,
        message:
          'No keyword match. Be more specific (e.g. "open a long", "list assets", "check positions"). ' +
          'Below are common entry-point tools; for the full catalog, ask for "glossary" or list tools by area.',
        suggestedTools: fallback.map((t) => ({
          tool: t.name,
          description: t.description,
          example: t.example,
        })),
      });
    },
  );
}
