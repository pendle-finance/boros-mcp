import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { dedupTtl } from '../../lib/dedup.js';

export function registerFundingSymbolsTools(server: McpServer): void {
  server.registerTool(
    'get_funding_rate_symbols',
    {
      annotations: { readOnlyHint: true },
      description: 'List the upstream funding-rate sources Boros tracks. Each entry is one (exchange, perp-ticker, asset) tuple feeding the indexer. This is NOT a list of tradeable Boros markets and `fundingRateSymbol` is NOT a Boros marketId — call get_markets and join on metadata.fundingRateSymbol to map a symbol to its Boros marketIds.',
      inputSchema: {},
    },
    async () => {
      try {
        const res = await dedupTtl('funding-rate-symbols', {}, 5 * 60_000, () =>
          fetchWithRetry(() => openApiGet('/v1/funding-rate/all-funding-rate-symbols')),
        );
        const symbols = res.fundingRateSymbols ?? [];
        // Cold-start / empty registry: fail loud, not count:0.
        // Empty mongo collection != "no symbols".
        if (symbols.length === 0) {
          return errorContent(
            BorosErrorCode.API_UNAVAILABLE,
            'Funding-rate symbol registry is empty (upstream not yet populated). Retry shortly.',
          );
        }
        return jsonResult({
          count: symbols.length,
          fundingRateSymbols: symbols,
          _context: {
            fundingRateSymbol: 'Exchange-specific perp ticker (e.g. BTCUSDT for Binance, BTC-USDT-SWAP for OKX, BTC for Hyperliquid). Use this string as the `fundingRateSymbol` join key against get_markets.metadata.fundingRateSymbol — NOT as a Boros marketId.',
            assetSymbol: 'Underlying asset (e.g. BTC). Different scope from Boros collateral assets returned by get_assets.',
            exchange: 'Source exchange. Casing is non-canonical — backend stores whatever was inserted at strategy-setup time (lowercase per OpenAPI example, sometimes capitalized in production, sometimes undefined for OKX). Do NOT case-sensitive filter; lowercase both sides before comparing.',
            cardinality: 'A single fundingRateSymbol typically maps to multiple Boros marketIds (one per maturity).',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
