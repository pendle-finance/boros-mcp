import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichTimestamp } from '../../utils.js';
import {
  marketIdField,
  timeFrameField,
  unixTimestampFieldOptional,
  TIMEFRAME_SECONDS,
} from '../_schemas.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { OPEN_API_URL } from '../../config.js';
import { fetchAllMarkets } from '../_shared/fetch-all-markets.js';

export function registerMarketsIndicatorsTools(server: McpServer): void {
  server.registerTool(
    'get_market_indicators',
    {
      annotations: { readOnlyHint: true },
      description: `Get market indicators over time as overlays for chart analysis. All rate fields are decimals (0.05 = 5%).
Indicators: u = underlying CEX funding rate; fp = quarterly futures premium (annualised decimal); fgi = fear & greed index (integer 0-100, exposed as fearGreedIndex + fearGreedClassification); ap = underlying asset spot USD price; udma = N-day moving average of u, computed for each value of udmaPeriods (1-365 days, up to 10 periods).
Use this for fundamental analysis overlays. When udma is selected, the lookback window is automatically expanded to cover max(udmaPeriods) days so the rolling average has enough history.
Do NOT use this for OHLCV candlestick data — use get_chart instead. For larger CSV exports, use get_indicators_export.`,
      inputSchema: {
        marketId: marketIdField('The numeric market ID', { min: 0 }),
        timeFrame: timeFrameField({ defaultValue: '1h' }),
        select: z
          .array(z.enum(['u', 'fp', 'fgi', 'ap', 'udma']))
          .min(1)
          .describe('Indicators to fetch: u (underlying CEX funding rate), fp (quarterly futures premium), fgi (fear & greed index), ap (asset spot USD price), udma (rolling mean of u). Indicators that are unavailable for the market are omitted and listed under `warnings` in the response.'),
        udmaPeriods: z
          .array(z.number().int().min(1).max(365))
          .max(10)
          .optional()
          .describe('Moving-average windows in days for udma (e.g. [7, 30]). Each period must be 1-365; up to 10 periods allowed. Defaults to [7, 30] when udma is selected.'),
        limit: z.number().int().min(1).max(500).default(20).describe(
          'Number of most recent data points to return (default 20, max 500). Ignored when startTimestamp is provided.',
        ),
        startTimestamp: unixTimestampFieldOptional(
          'startTimestamp',
          'Start timestamp (Unix seconds; not milliseconds). When provided, limit is ignored.',
        ),
        endTimestamp: unixTimestampFieldOptional(
          'endTimestamp',
          'End timestamp (Unix seconds). Must be >= startTimestamp.',
        ),
      },
    },
    async ({ marketId, timeFrame, select, udmaPeriods, limit, startTimestamp, endTimestamp }) => {
      try {
        if (
          startTimestamp !== undefined &&
          endTimestamp !== undefined &&
          endTimestamp < startTimestamp
        ) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            'endTimestamp must be >= startTimestamp.',
          );
        }
        // udma uses colon syntax with semicolon-delimited periods (e.g. "udma:7;30").
        const selectParts: string[] = select.filter((s) => s !== 'udma');
        const wantsUdma = select.includes('udma');
        const effectivePeriods = wantsUdma ? (udmaPeriods ?? [7, 30]) : [];
        if (wantsUdma) {
          selectParts.push(`udma:${effectivePeriods.join(';')}`);
        }

        const query: Record<string, any> = {
          marketId,
          timeFrame,
          select: selectParts.join(','),
        };
        if (startTimestamp !== undefined) {
          query.startTimestamp = startTimestamp;
        } else {
          // UDMA needs `period` days of data PRECEDING the window or values come back empty.
          let lookbackSec = limit * TIMEFRAME_SECONDS[timeFrame];
          if (wantsUdma && effectivePeriods.length > 0) {
            const maxPeriodSec = Math.max(...effectivePeriods) * 86400;
            lookbackSec = Math.max(lookbackSec, maxPeriodSec + limit * TIMEFRAME_SECONDS[timeFrame]);
          }
          query.startTimestamp = Math.floor(Date.now() / 1000) - lookbackSec;
        }
        if (endTimestamp !== undefined) query.endTimestamp = endTimestamp;

        const res = await fetchWithRetry(() =>
          openApiGet('/v1/indicators', query),
        );

        const indicatorData = res;

        // udma lookback pulls extra rows for rolling-mean warmup; trim back to the requested `limit`.
        if (
          startTimestamp === undefined &&
          wantsUdma &&
          Array.isArray(indicatorData?.results) &&
          indicatorData.results.length > limit
        ) {
          indicatorData.results = indicatorData.results.slice(-limit);
        }

        const rawMarkets = await fetchAllMarkets();
        const market = rawMarkets.find((mm: any) => mm.marketId === marketId);
        const marketName: string | undefined = market?.imData?.name;
        const marketSymbol = market?.metadata?.underlyingSymbol;

        const periods = wantsUdma ? effectivePeriods : [];

        // Backend silently drops unservable indicators (e.g. fp on no-futures market) — warn.
        const requested = indicatorData.metadata?.requested as string[] | undefined;
        const available = indicatorData.metadata?.available as string[] | undefined;
        const missing = requested && available
          ? requested.filter((r) => !available.includes(r))
          : [];
        const warnings = missing.length > 0
          ? [`Unavailable indicators dropped: ${missing.join(', ')}`]
          : undefined;

        return jsonResult({
          marketId,
          ...(marketName ? { marketName } : {}),
          marketSymbol,
          timeFrame,
          ...(warnings ? { warnings } : {}),
          metadata: indicatorData.metadata,
          count: (indicatorData.results ?? []).length,
          results: (indicatorData.results ?? []).map((dp: any) => {
            // Flatten fgi {v,vc} into 2 keys to avoid nested object _context can't describe.
            const fgi = dp.fgi as { v?: number; vc?: string } | number | undefined;
            const fgiValue =
              typeof fgi === 'number' ? fgi : fgi && typeof fgi.v === 'number' ? fgi.v : undefined;
            const fgiClass =
              typeof fgi === 'object' && fgi && typeof fgi.vc === 'string' ? fgi.vc : undefined;
            return {
              ...enrichTimestamp(dp.ts),
              ...(dp.u !== undefined ? { underlyingApr: dp.u } : {}),
              ...(dp.fp !== undefined ? { futurePremium: dp.fp } : {}),
              ...(fgiValue !== undefined ? { fearGreedIndex: fgiValue } : {}),
              ...(fgiClass !== undefined ? { fearGreedClassification: fgiClass } : {}),
              ...(dp.ap !== undefined ? { assetPrice: dp.ap } : {}),
              ...(dp.udma
                ? periods.reduce((acc: Record<string, any>, p: number) => {
                    const v = (dp.udma as Record<string, number>)[String(p)];
                    if (v !== undefined) {
                      acc[`udma${p}`] = v;
                    }
                    return acc;
                  }, {})
                : {}),
            };
          }),
          _context: {
            apr: APR_NOTE,
            underlyingApr: 'Annualized underlying CEX funding rate as decimal (0.05 = 5%). NOT the same as Boros markApr — that is the on-Boros mark.',
            futurePremium: 'Quarterly futures basis (annualized decimal). Positive = futures > spot.',
            fearGreedIndex: '0-100 integer; 0 = extreme fear, 100 = extreme greed.',
            fearGreedClassification: 'Human label: "Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed".',
            assetPrice: 'Underlying asset spot price in USD (interpolated hourly snapshot; may differ slightly from get_market.assetMarkPrice which is the live oracle).',
            warnings: 'When the backend cannot serve a requested indicator (e.g. market has no fundingRateSymbol), it is dropped from the response and listed here.',
            ...(wantsUdma
              ? { udma: `Rolling daily moving averages of underlying CEX funding rate for periods (days): ${effectivePeriods.join(', ')}. Decimals.` }
              : {}),
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );

  server.registerTool(
    'get_indicators_export',
    {
      annotations: { readOnlyHint: true },
      description: 'Export market OHLCV + optional indicators as CSV (up to 10,000 rows). Rate-limited to 3 requests per minute per IP. Use get_chart or get_market_indicators for JSON instead.',
      inputSchema: {
        marketId: marketIdField('Market ID'),
        timeFrame: timeFrameField({ desc: 'Candle time frame' }),
        startTimestamp: z.number().optional().describe('Start timestamp (Unix seconds)'),
        endTimestamp: z.number().optional().describe('End timestamp (Unix seconds), default now'),
        select: z.string().optional().describe('Additional indicators, comma-separated. Supported: u, fp, fgi, ap, udma:<periods> (e.g. "u,fgi,udma:7;30")'),
      },
    },
    async ({ marketId, timeFrame, startTimestamp, endTimestamp, select }) => {
      try {
        const url = new URL(`${OPEN_API_URL}/v1/indicators/export`);
        url.searchParams.set('marketId', String(marketId));
        url.searchParams.set('timeFrame', timeFrame);
        if (startTimestamp !== undefined) url.searchParams.set('startTimestamp', String(startTimestamp));
        if (endTimestamp !== undefined) url.searchParams.set('endTimestamp', String(endTimestamp));
        if (select) url.searchParams.set('select', select);

        const csv = await fetchWithRetry(async () => {
          const response = await fetch(url.toString());
          if (!response.ok) {
            const body = await response.text().catch(() => '');
            const err = new Error(`API ${response.status}: ${response.statusText} — ${body}`);
            (err as any).status = response.status;
            // Mirror open-api.ts: surface NestJS body fields (incl. structured `message`)
            // so classifyError can map 400 validation errors to INVALID_PARAMS.
            try { Object.assign(err, JSON.parse(body)); } catch {}
            throw err;
          }
          return response.text();
        });
        const lines = csv.split('\n');
        return jsonResult({
          marketId,
          timeFrame,
          rowCount: Math.max(0, lines.length - 1),
          headers: lines[0] ?? '',
          csv,
          _context: {
            format: 'CSV with OHLCV always included plus any requested indicators.',
            rateLimit: '3 requests per minute per IP.',
            maxRows: 10000,
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
