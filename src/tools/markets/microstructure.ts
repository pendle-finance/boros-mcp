import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichAprValue, enrichTimestamp, formatSize } from '../../utils.js';
import { marketIdField, resumeTokenField, paginationLimitField } from '../_schemas.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { fetchAllMarkets } from '../_shared/fetch-all-markets.js';
import { getMarketInfo } from '../trading/_market.js';

export function registerMarketsMicrostructureTools(server: McpServer): void {
  server.registerTool(
    'get_orderbook',
    {
      annotations: { readOnlyHint: true },
      description: `Get the order book for a market, showing aggregated bid/ask levels at a given tick size.
Use this to see current market depth, best bid/ask, and liquidity distribution.
Do NOT use this for historical data — use get_market_ohlcv or get_market_trades instead. For bulk historical order-book snapshots, download the archive: https://historical-data.boros.finance (see boros_glossary docs.historicalDataArchive).`,
      inputSchema: {
        marketId: marketIdField(),
        tickSize: z
          .preprocess(
            (v) => {
              if (typeof v === 'number') return v;
              if (typeof v === 'string') {
                // Strip wrapping quotes (e.g. "\"0.0001\"" from double-encoded JSON) before
                // numeric coercion so the user gets a positive-number error, not "received nan".
                const cleaned = v.trim().replace(/^['"]+|['"]+$/g, '');
                const n = Number(cleaned);
                return Number.isFinite(n) ? n : v;
              }
              return v;
            },
            z
              .number({
                invalid_type_error:
                  'tickSize must be one of 0.0001, 0.001, 0.01, 0.1. Pass as a bare number (0.0001) or a numeric string ("0.0001") — wrapping quotes like "\\"0.0001\\"" are stripped automatically; non-numeric strings are rejected.',
              })
              // Backend TickSize is a closed enum (order-book.schema.ts); anything else 400s.
              .refine(
                (v) => [0.0001, 0.001, 0.01, 0.1].includes(v),
                'tickSize must be one of 0.0001, 0.001, 0.01, 0.1 (closed backend enum).',
              ),
          )
          .default(0.001)
          .describe('Tick size for order book aggregation as DECIMAL (0.001 = 0.1%). Pass as a bare number or numeric string. Allowed values (closed backend enum): 0.0001, 0.001 (default), 0.01, 0.1.'),
        includeAmm: z
          .boolean()
          .default(true)
          .describe('Include AMM liquidity in the order book (default true)'),
        topN: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Client-side trim of the top-N levels per side (default 20). The server has no `topN` parameter — this is applied locally after `minSize`. The server caps every response at 50 levels/side UNCONDITIONALLY, so values >50 never have any effect on any market. Raise above 20 (up to 50) to inspect deeper rungs / dust tails.'),
        minSize: z
          .number()
          .min(0)
          .default(0)
          .describe('Filter out levels smaller than this YU size (default 0 = keep all). Useful for cutting LP dust rungs.'),
      },
    },
    async ({ marketId, tickSize, includeAmm, topN, minSize }) => {
      try {
        const [ob, rawMarkets] = await Promise.all([
          fetchWithRetry(() =>
            openApiGet('/v1/markets/order-book', { marketId, tickSize: Number(tickSize), includeAmm }),
          ),
          fetchAllMarkets(),
        ]);

        const market = rawMarkets.find((m: any) => m.marketId === marketId);
        const marketName: string | undefined = market?.imData?.name;
        const marketSymbol = market?.metadata?.underlyingSymbol;

        const tickSizeNum = Number(tickSize);
        const enrichSide = (side: { ia: number[]; sz: string[] }) => {
          const rows = side.ia
            .map((ia, i) => ({ apr: ia * tickSizeNum, size: formatSize(side.sz[i]) }))
            .filter((r) => Number(r.size) >= minSize);
          return rows.slice(0, topN);
        };

        return jsonResult({
          marketId,
          ...(marketName ? { marketName } : {}),
          marketSymbol,
          tickSize,
          topN,
          minSize,
          sizeUnit: 'YU',
          long: enrichSide(ob.long),
          short: enrichSide(ob.short),
          _context: {
            apr: APR_NOTE,
            // CRITICAL semantics — long pays fixed, short receives (Order.sol:24-27 enum Side {LONG,SHORT}).
            long: 'Resting orders willing to PAY fixed APR (receive the underlying/floating APR). A long position pays fixed and receives floating. Long quotes are sorted highest APR first; the highest APR is the best bid (the most a fixed-payer is willing to commit).',
            short: 'Resting orders willing to RECEIVE fixed APR (pay the underlying/floating APR). A short position receives fixed and pays floating. Short quotes are sorted lowest APR first; the lowest APR is the best ask.',
            bidAskMapping: 'long ≈ bid side (highest APR first); short ≈ ask side (lowest APR first). APRs may be negative for negative-funding-rate markets.',
            depthCap: 'Server caps each side at 50 levels UNCONDITIONALLY — `includeAmm`, AMM presence and the AMM merge step make no difference, because `formatBook`\'s own default is `limit = 50`. No response can ever exceed 50/side. Only a minority of active markets (5 of 37 at the time of writing, ~14%) have a live AMM, and those are the ones that actually saturate the 50/50 cap; plain-orderbook markets are typically well under it. `topN` is a client-side trim applied after that, so it can only reduce depth further.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );

  server.registerTool(
    'get_market_trades',
    {
      annotations: { readOnlyHint: true },
      description: `Get recent executed trades on a market (public, anonymous tape — no trader address). Sorted newest-first.
Use this to see the most recent fills (size, rate, timestamp). Multiple rows can share a txHash — those are partial fills against different price levels.
Do NOT use this to look up YOUR trades — use get_transaction_history. Do NOT use this for candlestick/OHLCV data — use get_market_ohlcv instead. For the full historical trade tape (months), download the archive: https://historical-data.boros.finance (see boros_glossary docs.historicalDataArchive).`,
      inputSchema: {
        marketId: marketIdField(),
        limit: paginationLimitField({ max: 50, defaultValue: 20, desc: 'Max trades to return (default 20, max 50)' }),
        resumeToken: resumeTokenField(),
      },
    },
    async ({ marketId, limit, resumeToken }) => {
      try {
        // Validate marketId up-front so bogus ids return MARKET_NOT_FOUND instead of an empty
        // results array (matches get_orderbook / get_market_ohlcv / get_market behavior).
        await getMarketInfo(marketId);
        const [res, rawMarkets] = await Promise.all([
          fetchWithRetry(() =>
            openApiGet('/v1/markets/trades', {
              marketId,
              limit,
              ...(resumeToken ? { resumeToken } : {}),
            }),
          ),
          fetchAllMarkets(),
        ]);

        const market = rawMarkets.find((m: any) => m.marketId === marketId);
        const marketName: string | undefined = market?.imData?.name;
        const marketSymbol = market?.metadata?.underlyingSymbol;

        const trades = (res.results ?? []).map((t: any) => ({
          size: t.size,
          direction: typeof t.size === 'number' ? (t.size >= 0 ? 'long' : 'short') : undefined,
          rate: t.rate,
          ...enrichAprValue(t.rate as number),
          txHash: t.txHash,
          ...enrichTimestamp(t.blockTimestamp),
        }));

        return jsonResult({
          marketId,
          ...(marketName ? { marketName } : {}),
          marketSymbol,
          sizeUnit: 'YU (signed notional, already formatted)',
          count: trades.length,
          results: trades,
          ...(res.resumeToken ? { resumeToken: res.resumeToken } : {}),
          _context: {
            apr: APR_NOTE,
            size: 'Signed YU (yield-unit) notional, already formatted (not raw 18-dec). Positive = long taker, negative = short taker. To get USD notional, multiply by the collateral asset\'s usdPrice from get_assets.',
            rate: 'Trade APR as annualized decimal (0.05 = 5%)',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
