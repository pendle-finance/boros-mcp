import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';

export function registerProtocolTvlTools(server: McpServer): void {
  server.registerTool(
    'get_tvl',
    {
      annotations: { readOnlyHint: true },
      description: 'Get Boros protocol *collateral* TVL in USD — the sum of every collateral ERC-20 held by the MarketHub contract on Arbitrum, broken down per token. Each entry shows the raw on-chain balance (in token decimals — divide by `decimals` for human units), USD price, and USD value. This is NOT vault TVL (use get_amm_info for per-vault TVL) and NOT open interest. Token prices are cached oracle snapshots refreshed ~every 60s.',
      inputSchema: {},
    },
    async () => {
      try {
        const res = await fetchWithRetry(() => openApiGet('/v1/total-value-locked'));
        return jsonResult({
          totalInUSD: res.totalInUSD,
          breakdown: res.breakdown ?? [],
          _context: {
            description: 'Protocol TVL computed from on-chain MarketHub balances. All USD fields are plain USD strings.',
            breakdown: 'Per-collateral-token: address, symbol, decimals, balance (raw in token decimals), usdPrice, tokenInUSD.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
