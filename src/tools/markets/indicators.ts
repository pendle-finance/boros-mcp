import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichTimestamp } from '../../utils.js';
import {
  marketIdField,
  timeFrameField,
  unixTimestampFieldOptional,
  paginationLimitField,
  TIMEFRAME_SECONDS,
} from '../_schemas.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { fetchAllMarkets } from '../_shared/fetch-all-markets.js';

export function registerMarketsIndicatorsTools(server: McpServer): void {
  server.registerTool(
    'get_market_indicators',
    {
      annotations: { readOnlyHint: true },
      description: `Get market indicators over time as overlays for chart analysis. All rate fields are decimals (0.05 = 5%).
Indicators: u = underlying perp funding rate (annualized; CEX or DEX venue per market); fp = quarterly futures premium (annualised decimal); fgi = fear & greed index (integer 0-100, exposed as fearGreedIndex + fearGreedClassification); ap = underlying asset spot USD price; udma = N-day moving average of u, computed for each value of udmaPeriods (1-365 days, up to 10 periods).
Use this for fundamental analysis overlays. When udma is selected, the lookback window is automatically expanded to cover max(udmaPeriods) days so the rolling average has enough history.
Do NOT use this for OHLCV candlestick data — use get_market_ohlcv instead.
Pagination (max 50 points per call): to fetch older history, set endTimestamp = (oldest timestamp from prior page) - 1 and pass startTimestamp = endTimestamp - 50 * timeFrameSeconds. Timeframe seconds: 5m=300, 1h=3600, 1d=86400, 1w=604800.`,
      inputSchema: {
        marketId: marketIdField(),
        timeFrame: timeFrameField({ defaultValue: '1h' }),
        select: z
          .array(z.enum(['u', 'fp', 'fgi', 'ap', 'udma']))
          .min(1)
          .describe('Indicators to fetch: u (underlying perp funding rate, annualized; CEX or DEX venue per market), fp (quarterly futures premium), fgi (fear & greed index), ap (asset spot USD price), udma (rolling mean of u). Indicators that are unavailable for the market are omitted and listed under `warnings` in the response.'),
        udmaPeriods: z
          .array(z.number().int().min(1).max(365))
          .max(10)
          .optional()
          .describe('Moving-average windows in days for udma (e.g. [7, 30]). Each period must be 1-365; up to 10 periods allowed. Defaults to [7, 30] when udma is selected.'),
        limit: paginationLimitField({
          max: 50,
          defaultValue: 20,
          desc: 'Number of data points to return (default 20, max 50). Ignored when startTimestamp is provided. To page beyond 50, use endTimestamp; see tool description.',
        }),
        startTimestamp: unixTimestampFieldOptional(
          'startTimestamp',
          'Start timestamp (Unix seconds; not milliseconds). When paging older history, set startTimestamp = endTimestamp - 50 * timeFrameSeconds.',
        ),
        endTimestamp: unixTimestampFieldOptional(
          'endTimestamp',
          'End timestamp (Unix seconds). Must be >= startTimestamp. Set to (oldest timestamp from prior page) - 1 to page backwards.',
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
            ...(select.includes('u') || select.includes('fp') || wantsUdma
              ? { apr: APR_NOTE }
              : {}),
            ...(select.includes('u') || wantsUdma
              ? { underlyingApr: 'Annualized underlying perp funding rate as decimal (0.05 = 5%); CEX or DEX venue per market (Binance/Bybit/OKX/Gate or Hyperliquid/Lighter). NOT the same as Boros markApr — that is the on-Boros mark.' }
              : {}),
            ...(select.includes('fp')
              ? { futurePremium: 'Quarterly futures basis (annualized decimal). Positive = futures > spot.' }
              : {}),
            ...(select.includes('fgi')
              ? {
                  fearGreedIndex: '0-100 integer; 0 = extreme fear, 100 = extreme greed.',
                  fearGreedClassification: 'Human label: "Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed".',
                }
              : {}),
            ...(select.includes('ap')
              ? { assetPrice: 'Underlying asset spot price in USD (interpolated hourly snapshot; may differ slightly from get_market.assetMarkPrice which is the live oracle).' }
              : {}),
            warnings: 'When the backend cannot serve a requested indicator (e.g. market has no fundingRateSymbol), it is dropped from the response and listed here.',
            ...(wantsUdma
              ? { udma: `Rolling daily moving averages of underlying perp funding rate for periods (days): ${effectivePeriods.join(', ')}. Decimals.` }
              : {}),
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
