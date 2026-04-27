import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { dedupTtl } from '../../lib/dedup.js';
import { MARKETS_CACHE_TTL_MS } from '../_shared/fetch-all-markets.js';

export function registerProtocolAssetsTools(server: McpServer): void {
  server.registerTool(
    'get_assets',
    {
      annotations: { readOnlyHint: true },
      description: `Get supported tokens registered on Boros (collateral + reward tokens), including token addresses, decimals, USD prices, and minimal metadata.
By default only deposit-eligible collaterals are returned (isCollateral=true, positive tokenId). Set includeNonCollateral=true to also list non-collateral reward tokens such as PENDLE — these share tokenId = -1 and cannot be deposited as margin.
Use this to look up an asset's tokenId / decimals before depositing or signing transfers.
Do NOT confuse the "asset" registry here with the underlying-asset symbols of MARKETS (NVDA, XAU, SOL, ETH-Binance, etc.) — those market underlyings are NOT entries in this list; query get_markets / get_market for those.`,
      inputSchema: {
        includeNonCollateral: z
          .boolean()
          .default(false)
          .describe('Include non-collateral reward tokens (e.g. PENDLE) with tokenId = -1. Default false.'),
      },
    },
    async ({ includeNonCollateral }) => {
      try {
        const res = await dedupTtl('assets', {}, MARKETS_CACHE_TTL_MS, () =>
          fetchWithRetry(() => openApiGet('/v1/assets')),
        );

        const all = res.results ?? [];
        const assets = includeNonCollateral ? all : all.filter((a: any) => a.isCollateral === true);
        return jsonResult({
          count: assets.length,
          totalIncludingNonCollateral: all.length,
          includeNonCollateral: !!includeNonCollateral,
          assets,
          _context: {
            description: 'Supported tokens. Only entries with isCollateral=true (and a positive tokenId) can be deposited as margin. tokenId=-1 marks reward tokens (e.g. PENDLE) that flow through the Merkle distributors.',
            fields: 'Each asset carries: id, address, tokenId, name, symbol, decimals, usdPrice (decimal string, USD spot), isCollateral, metadata.proSymbol. Use the returned tokenId — not symbol or address — when calling deposit/withdraw/simulate_order.',
            usdPrice: 'Spot USD price as a decimal string, refreshed by the backend price-strategy worker. Not oracle-grade and not stable enough for slippage math.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
