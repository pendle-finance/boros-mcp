import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichTimestamp } from '../../utils.js';
import {
  marketIdField,
  timeFrameField,
  unixTimestampFieldOptional,
  paginationLimitField,
  TIMEFRAME_SECONDS,
} from '../_schemas.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { fetchAllMarkets } from '../_shared/fetch-all-markets.js';

export function registerMarketsChartTools(server: McpServer): void {
  server.registerTool(
    'get_market_ohlcv',
    {
      annotations: { readOnlyHint: true },
      description: `Get OHLCV candlestick chart data for a market. Candles are built from EXECUTED TRADES (last-traded APR), not the mark rate, AMM implied rate, or oracle funding rate. OHLC values are APR DECIMALS (0.05 = 5%), not prices.
Use this for trade-rate trend analysis. Empty buckets are FORWARD-FILLED with the previous close and volume=0; those rows are flagged with synthetic=true so an LLM doesn't read them as low-volatility periods.
Do NOT use this for individual trade details — use get_market_trades instead.
For indicator overlays (underlying APR, future premium, fear & greed, funding-rate MAs), use get_market_indicators.
Pagination (max 200 candles per call — the backend's own hard cap): to fetch older history pass BOTH endTimestamp = (oldest timestamp from prior page) - 1 AND startTimestamp = endTimestamp - 200 * timeFrameSeconds (5m=300, 1h=3600, 1d=86400, 1w=604800).
For bulk/long-range history (months of candles) instead of paging this API, download the archive: https://historical-data.boros.finance (GET /files.json for the manifest; see boros_glossary docs.historicalDataArchive).`,
      inputSchema: {
        marketId: marketIdField(),
        timeFrame: timeFrameField({ defaultValue: '1h' }),
        limit: paginationLimitField({
          max: 200,
          defaultValue: 50,
          desc: 'Number of candles to return (default 50, max 200 = the backend cap). Ignored when startTimestamp is provided. To reach older history, pass startTimestamp + endTimestamp; see tool description.',
        }),
        startTimestamp: unixTimestampFieldOptional(
          'startTimestamp',
          'Start timestamp (Unix seconds; not milliseconds). When paging older history, set startTimestamp = endTimestamp - 200 * timeFrameSeconds.',
        ),
        endTimestamp: unixTimestampFieldOptional(
          'endTimestamp',
          'End timestamp (Unix seconds). Silently clamped to "now" if in the future. Set to (oldest timestamp from prior page) - 1 to page backwards.',
        ),
      },
    },
    async ({ marketId, timeFrame, limit, startTimestamp, endTimestamp }) => {
      try {
        const query: Record<string, any> = { marketId, timeFrame };
        if (startTimestamp !== undefined) {
          query.startTimestamp = startTimestamp;
        } else {
          query.startTimestamp = Math.floor(Date.now() / 1000) - limit * TIMEFRAME_SECONDS[timeFrame];
        }
        if (endTimestamp !== undefined) query.endTimestamp = endTimestamp;

        const res = await fetchWithRetry(() =>
          openApiGet('/v1/markets/ohlcv', query),
        );

        const rawMarkets = await fetchAllMarkets();
        const market = rawMarkets.find((m: any) => m.marketId === marketId);
        const marketName: string | undefined = market?.imData?.name;
        const marketSymbol = market?.metadata?.underlyingSymbol;

        // Tag synthetic forward-fill (backend emits o=h=l=c=lastClose, v=0 for empty buckets).
        const allCandles = (res.results ?? []).map((c: any) => {
          const synthetic = c.v === 0 && c.o === c.h && c.h === c.l && c.l === c.c;
          return {
            ...enrichTimestamp(c.ts),
            open: c.o,
            high: c.h,
            low: c.l,
            close: c.c,
            volume: c.v,
            ...(synthetic ? { synthetic: true } : {}),
          };
        });
        const candles = startTimestamp === undefined ? allCandles.slice(-limit) : allCandles;
        const syntheticCount = candles.filter((c: any) => c.synthetic).length;
        // Backend caps at 200 — surface explicit range >200 as truncated.
        const tfSec = TIMEFRAME_SECONDS[timeFrame];
        const requestedSpan = endTimestamp !== undefined && startTimestamp !== undefined
          ? Math.floor((endTimestamp - startTimestamp) / tfSec) + 1
          : undefined;
        const truncated = requestedSpan !== undefined && requestedSpan > 200;

        return jsonResult({
          marketId,
          ...(marketName ? { marketName } : {}),
          marketSymbol,
          timeFrame,
          volumeUnit: 'YU',
          count: candles.length,
          ...(truncated ? { truncated: true, backendCap: 200 } : {}),
          ...(syntheticCount > 0 ? { syntheticCount } : {}),
          results: candles,
          _context: {
            ohlc: 'Open/High/Low/Close are LAST-TRADED APR values (annualized decimal), NOT prices, mark rate, or oracle funding. 0.05 = 5% APR.',
            volume: 'Trading volume in YU (yield units, sum of |trade.size| in the bucket). Multiply by the collateral asset `usdPrice` from `get_assets` for approximate USD notional.',
            synthetic: 'Rows with synthetic=true are forward-filled by the backend for buckets with no trades (volume=0, OHLC equal to the previous close). Treat as "no data", not as a flat-volatility period.',
            cap: 'Backend caps the response at 200 candles regardless of the requested range; older data falls off the front.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
