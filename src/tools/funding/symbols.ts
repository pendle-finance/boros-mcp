import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { dedupTtl } from '../../lib/dedup.js';
import { makeFilterSchema } from '../_schemas.js';
import { applyFilters } from '../../lib/collections.js';

const FUNDING_SYMBOLS_FILTER_FIELDS = ['fundingRateSymbol', 'assetSymbol', 'exchange'] as const;

export function registerFundingSymbolsTools(server: McpServer): void {
  server.registerTool(
    'get_funding_rate_symbols',
    {
      annotations: { readOnlyHint: true },
      description: 'List the upstream funding-rate sources Boros tracks. Each entry is one (exchange, perp-ticker, asset) tuple feeding the indexer. This is NOT a list of tradeable Boros markets and `fundingRateSymbol` is NOT a Boros marketId — call get_markets and join on metadata.fundingRateSymbol to map a symbol to its Boros marketIds.',
      inputSchema: {
        filter: z
          .array(makeFilterSchema(FUNDING_SYMBOLS_FILTER_FIELDS))
          .optional()
          .describe('Filter conditions. LIKE on `fundingRateSymbol`/`assetSymbol`/`exchange` is the typical use; lowercase both sides since `exchange` casing is non-canonical.'),
      },
    },
    async ({ filter }) => {
      try {
        const res = await dedupTtl('funding-rate-symbols', {}, 5 * 60_000, () =>
          fetchWithRetry(() => openApiGet('/v1/funding-rate/all-funding-rate-symbols')),
        );
        const symbols = res.fundingRateSymbols ?? [];
        if (symbols.length === 0) {
          return errorContent(
            BorosErrorCode.API_UNAVAILABLE,
            'Funding-rate symbol registry is empty (upstream not yet populated). Retry shortly.',
          );
        }
        const totalBeforeFilter = symbols.length;
        const filtered = applyFilters(symbols, filter);
        const filterApplied = filter !== undefined && filter.length > 0;
        return jsonResult({
          count: filtered.length,
          ...(filterApplied ? { totalBeforeFilter } : {}),
          fundingRateSymbols: filtered,
          _context: {
            fundingRateSymbol: 'Opaque registry key, TWO shapes in production: Binance uses the venue\'s own uppercase perp ticker (BTCUSDT, ETHUSDT, XAUUSDT); every OTHER exchange uses a synthetic lowercase `venue-asset` key (okx-btc, hyperliquid-eth, bybit-sol, lighter-xau, deribit-xrp, gate-hype, kucoin-bnb, bitget-xag). Do NOT construct it — a venue\'s native contract name such as BTC-USDT-SWAP is NOT this field (that string is get_strategies.strategyMetadata.name). Copy it verbatim and join against get_markets.metadata.fundingRateSymbol; it is NOT a Boros marketId.',
            assetSymbol: 'Underlying asset, uppercase (BTC, ETH, XAU, HYPE). Note the same underlying can appear under different `fundingRateSymbol` asset slugs across venues (Hyperliquid uses -gold/-silver where others use -xau/-xag), so join on fundingRateSymbol, not on assetSymbol. Different scope from Boros collateral assets returned by get_assets.',
            exchange: 'Source exchange, ALWAYS populated (verified: 0 empty across 80 entries / 9 exchanges). Live values are capitalized display names: Binance, Bybit, OKX, Gate, Kucoin, Bitget, Deribit, Hyperliquid, Lighter. Casing is not contractual (the OpenAPI example shows lowercase), so lowercase both sides before comparing rather than matching these strings exactly.',
            cardinality: 'A single fundingRateSymbol typically maps to multiple Boros marketIds (one per maturity).',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
