import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiPost } from '../../api/open-api.js';
import { type IntentExpectation } from '../../agent/signing.js';
import { ROUTER_SELECTORS } from '../../chain/selectors.js';
import {
  jsonResult,
  parseSize,
  analyzeExecution,
} from '../../utils.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import {
  sideSchema,
  marketIdField,
  marginModeField,
  ammIdField,
  TIME_IN_FORCE_DESCRIPTION,
} from '../_schemas.js';
import {
  TIF_MAP,
  SIDE_MAP,
  sideLabelFromWire,
  tryBigInt,
  limitAprWarning,
  computeDefaultSlippage,
  RESTING_TIFS,
} from './_helpers.js';
import {
  getMarketInfo,
  resolveMarketAcc,
  snapshotActiveOrderIds,
  resolveRecentOrderIdsSinceSnapshot,
} from './_market.js';
import {
  executeAgentAction,
  extractCalldatas,
  extractTxHash,
  executionErrorContent,
} from './_execute.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';


export function registerBulkTools(server: McpServer) {
  server.registerTool(
    'place_orders',
    {
      annotations: { destructiveHint: true },
      description: `ADVANCED — liquidity-provisioning / market-making batch placement. Places up to 100 heterogeneous order entries in ONE agent transaction (one signature, one txHash). Each entry is one of two kinds:

- kind:'single' — compiles to one on-chain placeSingleOrder call. Power-user controls: raw limitTick XOR human-readable rate; absolute desiredRate XOR relative slippage; per-entry ammId (0 = orderbook-only, n = AMM route); optional preCancelOrderId (atomic strict cancel-and-replace one resting id).
- kind:'bulk' — compiles to one on-chain bulkOrders multicall covering N per-market sub-orders ('bulks[]'). Strictly orderbook (no AMM by construction). Per-bulk uniform side+tif, multi-tick sizes[]/limitTicks[], optional cancelData (multi-id atomic cancel-before-place; isAll wipes resting; isStrict reverts on missing id).

Use place_order (singular) for single-trade UI flow with simulate→execute. Prefer 'bulk' kind over many ammId:0 'single' entries — strictly cheaper gas (one bulkOrders multicall vs N placeSingleOrder calls) and supports multi-id cancelData.

NO PER-ENTRY SIMULATION: this tool does NOT call /v1/simulations/place-order before signing. Backend has no batch-sim endpoint. For unfamiliar markets, sim a representative entry via place_order mode:'simulate' first, especially when |rate| is large or notional is small (backend enforces a $10 min order value).

Constraints:
- All entries share one (root, accountId) — one agent signature covers the whole batch.
- bulk entry with cross:false (isolated) must contain exactly one bulks[] element — isolated account is pinned to one marketId.
- ALO/SOFT_ALO orders cannot route AMM — ammId is forced to 0 internally for those TIFs (single entries only).
- preCancelOrderId is STRICT: the WHOLE BATCH reverts if a pre-cancel cannot be honored, even with atomic:false.
- ALL entries land in ONE on-chain tryAggregate tx — every sub-call shares the same txHash. \`ok\` is true only when EVERY sub-call succeeded; inspect \`reverts[]\` for partials.

SLIPPAGE: backend's place-orders DTO requires one of {desiredRate, slippage} per single/bulk. If neither is provided, this tool fills slippage with the per-market default (0.5 × market.maxRateDeviation). Backend ignores slippage for GTC/ALO/SOFT_ALO (limitTick is the guard); for FOK/IOC the default acts as a real ceiling.`,
      inputSchema: {
        entries: z
          .array(
            z.discriminatedUnion('kind', [
              z.object({
                kind: z.literal('single').describe("One placeSingleOrder call. Per-entry marketId, side, ammId, etc."),
                marketId: marketIdField(),
                marginMode: marginModeField(),
                side: sideSchema.describe('Order side (any case)'),
                size: z.string().describe('Notional size in YU, human-readable decimal (e.g. "1000.5"). ALWAYS POSITIVE.'),
                timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'ALO', 'SOFT_ALO']).describe(TIME_IN_FORCE_DESCRIPTION),
                limitTick: z.number().int().min(-32768).max(32767).optional().describe('Raw contract tick. Mutually exclusive with rate.'),
                rate: z.number().optional().describe('APR as DECIMAL (0.085 = 8.5%, NOT 8.5). Mutually exclusive with limitTick. Values exceeding max(1, |markApr|*5) on the entry\'s market require the top-level acknowledgeHighRate:true (e.g. an oil market trading at –117% accepts rate:1.2 freely; a 5%-mark USDT market rejects rate:5).'),
                desiredRate: z.number().optional().describe('Absolute execution ceiling as DECIMAL APR. Mutually exclusive with slippage.'),
                slippage: z.number().min(0).max(1, 'slippage > 1 — DECIMAL: 0.05 = 5%, not 5').optional().describe('Relative tolerance from mid as DECIMAL (0.05 = 5%). Mutually exclusive with desiredRate.'),
                ammId: ammIdField(),
                preCancelOrderId: z.string().optional().describe('Order id to atomically cancel before matching. STRICT: the WHOLE BATCH reverts if the pre-cancel cannot be honored, even with atomic:false.'),
              }),
              z.object({
                kind: z.literal('bulk').describe('One bulkOrders multicall covering multi-market sub-orders. Orderbook-only (no AMM).'),
                cross: z.boolean().describe('true → cross account; false → isolated. With cross:false, bulks[] must have exactly one element (isolated is pinned to one marketId).'),
                bulks: z
                  .array(
                    z.object({
                      marketId: marketIdField('Sub-order market.'),
                      orders: z.object({
                        side: sideSchema.describe('Side applied to every sub-order in this bulk (any case)'),
                        sizes: z.array(z.string()).min(1).describe('Per-sub-order notional sizes (human-readable decimal).'),
                        limitTicks: z.array(z.number().int()).min(1).describe('Per-sub-order raw tick indices. sizes.length === limitTicks.length'),
                        timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'ALO', 'SOFT_ALO']).describe('TIF applied to every sub-order in the bulk. ' + TIME_IN_FORCE_DESCRIPTION),
                      }),
                      cancelData: z
                        .object({
                          ids: z.array(z.string()).optional().describe('Order IDs to cancel. Ignored when isAll:true.'),
                          isAll: z.boolean().describe('Cancel every resting order in this market. `ids` is ignored when true.'),
                          isStrict: z.boolean().describe('Revert the whole bulkOrders call if any id cancel fails. MM default: false (best-effort).'),
                        })
                        .optional()
                        .describe('Atomic cancel-before-place for this market. Omit to place without cancelling.'),
                      desiredRate: z.number().optional().describe('Absolute execution ceiling for this bulk. Mutually exclusive with slippage.'),
                      slippage: z.number().min(0).max(1, 'slippage > 1 — DECIMAL: 0.05 = 5%, not 5').optional().describe('Relative tolerance from mid for this bulk. Mutually exclusive with desiredRate.'),
                    }),
                  )
                  .min(1)
                  .describe('Per-market sub-order groups bundled into ONE bulkOrders contract call.'),
              }),
            ]),
          )
          .min(1)
          .max(100, 'place_orders supports at most 100 entries (send-txs-bot MAX_ALLOWED_BULK_DIRECT_CALL_SIZE).')
          .describe('Heterogeneous batch of order entries (max 100). Each entry becomes one on-chain call (placeSingleOrder OR bulkOrders), all bundled under one tryAggregate tx.'),
        atomic: z.boolean().default(true).describe('true (default): whole batch reverts if any entry fails. false: best-effort — survivors execute independently, but `ok` is still false if ANY sub-call reverted (inspect `reverts[]`).'),
        acknowledgeHighRate: z.boolean().default(false).describe('Required when any single-entry `rate` exceeds max(1, |markApr|*5) for its market. The threshold scales with the market\'s current markApr — markets that already trade at extreme APR (oil at –117%, etc.) accept commensurate rates; markets near a normal range reject percent-vs-decimal typos like rate:5 (= 500%) on a 5%-mark book.'),
      },
    },
    withAuth(async ({ entries, atomic, acknowledgeHighRate }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        for (let i = 0; i < entries.length; i++) {
          const e: any = entries[i];
          if (e.kind === 'single') {
            if (e.slippage === undefined && e.desiredRate === undefined) {
              if (e.timeInForce === 'FOK' || e.timeInForce === 'IOC') {
                return errorContent(
                  BorosErrorCode.INVALID_PARAMS,
                  `entries[${i}] (single, ${e.timeInForce}): one of \`slippage\` or \`desiredRate\` is required for taker orders.`,
                );
              }
            }
          } else {
            if (!e.cross && e.bulks.length > 1) {
              return errorContent(
                BorosErrorCode.INVALID_PARAMS,
                `entries[${i}] (bulk, cross:false): isolated bulkOrders must contain exactly one bulks[] element — split into separate entries for each isolated market.`,
              );
            }
            for (let j = 0; j < e.bulks.length; j++) {
              const b: any = e.bulks[j];
              if (b.desiredRate !== undefined && b.slippage !== undefined) {
                return errorContent(
                  BorosErrorCode.INVALID_PARAMS,
                  `entries[${i}].bulks[${j}]: desiredRate and slippage are mutually exclusive.`,
                );
              }
              if (b.orders.sizes.length !== b.orders.limitTicks.length) {
                return errorContent(
                  BorosErrorCode.INVALID_PARAMS,
                  `entries[${i}].bulks[${j}]: sizes.length (${b.orders.sizes.length}) must equal limitTicks.length (${b.orders.limitTicks.length}).`,
                );
              }
            }
          }
        }

        // Per-entry typo gate scaled by each market's own markApr (e.g. oil at –117% accepts
        // rate:1.2 without warning, while a 5% USDT-funding market rejects rate:5 = 500%).
        const limitAprWarnings: { index: number; warning: string }[] = [];
        const suspectEntries: { index: number; rate: number; markApr: number | undefined; floor: number }[] = [];
        for (let i = 0; i < entries.length; i++) {
          const e: any = entries[i];
          if (e.kind !== 'single' || e.rate === undefined || !Number.isFinite(e.rate)) continue;
          const w = limitAprWarning(e.rate);
          if (w) limitAprWarnings.push({ index: i, warning: w });
          let markApr: number | undefined;
          try {
            const m = await getMarketInfo(e.marketId);
            // /v1/markets rows nest live stats under .data; tolerate flattened/legacy shapes too.
            const raw = m?.data?.markApr ?? m?.markApr ?? m?.stats?.markApr;
            if (typeof raw === 'number' && Number.isFinite(raw)) markApr = raw;
          } catch { /* best-effort */ }
          const floor = Math.max(1, Math.abs(markApr ?? 0) * 5);
          if (Math.abs(e.rate) > floor) {
            suspectEntries.push({ index: i, rate: e.rate, markApr, floor });
          }
        }
        if (suspectEntries.length > 0 && !acknowledgeHighRate) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            `${suspectEntries.length} single entry(ies) exceed the markApr-scaled rate floor (likely percent-vs-decimal typo). ` +
              `Re-call with acknowledgeHighRate:true to confirm, or divide each rate by 100. Offenders: ` +
              suspectEntries
                .map(
                  (s) =>
                    `entries[${s.index}] rate=${s.rate} (markApr=${s.markApr === undefined ? 'unknown' : `${(s.markApr * 100).toFixed(2)}%`}, floor=${(s.floor * 100).toFixed(0)}%)`,
                )
                .join('; ') +
              '.',
          );
        }

        const slippageDefaultedSingles: number[] = [];
        const orderRequests: any[] = [];
        const intents: IntentExpectation[] = [];

        for (let i = 0; i < entries.length; i++) {
          const e: any = entries[i];

          if (e.kind === 'single') {
            const market = await getMarketInfo(e.marketId);
            const tokenId: number = market.tokenId;
            const marketAcc = resolveMarketAcc(rootAddress, accountId, tokenId, e.marginMode, e.marketId);
            const sizeRaw = parseSize(e.size).toString();
            // place-orders DTO requires one of {desiredRate, slippage} per entry — cannot drop
            // slippage entirely the way single-entry place_order does. Use the per-market default
            // (0.5 × maxRateDeviation) as the satisfying value; backend ignores it for resting TIFs.
            let effectiveSlippage = e.slippage;
            if (effectiveSlippage === undefined && e.desiredRate === undefined) {
              effectiveSlippage = computeDefaultSlippage(market);
              slippageDefaultedSingles.push(i);
            }
            // ALO/SOFT_ALO cannot route AMM — backend strips ammId, calldata + intent must agree on 0.
            const effectiveAmmId = (e.timeInForce === 'ALO' || e.timeInForce === 'SOFT_ALO') ? 0 : e.ammId;

            const singleOrder: any = {
              marketAcc,
              marketId: e.marketId,
              side: SIDE_MAP[e.side as keyof typeof SIDE_MAP],
              size: sizeRaw,
              tif: TIF_MAP[e.timeInForce as keyof typeof TIF_MAP],
              ammId: effectiveAmmId,
              ...(e.limitTick !== undefined ? { limitTick: e.limitTick } : {}),
              ...(e.rate !== undefined ? { rate: e.rate } : {}),
              ...(e.desiredRate !== undefined ? { desiredRate: e.desiredRate } : {}),
              ...(effectiveSlippage !== undefined ? { slippage: effectiveSlippage } : {}),
              ...(e.preCancelOrderId ? { preCancelOrderId: e.preCancelOrderId } : {}),
            };
            orderRequests.push({ singleOrder });

            const sizeForIntent = tryBigInt(sizeRaw);
            // Pin marketId+cross (not marketAcc) — see place_order.
            intents.push({
              selector: ROUTER_SELECTORS.placeSingleOrder,
              marketId: e.marketId,
              cross: e.marginMode !== 'isolated',
              side: e.side,
              tif: TIF_MAP[e.timeInForce as keyof typeof TIF_MAP],
              ammId: effectiveAmmId,
              ...(sizeForIntent !== undefined ? { sizeAbs: sizeForIntent } : {}),
              ...(typeof e.limitTick === 'number' ? { tickExact: e.limitTick } : {}),
            });
          } else {
            const bulks = await Promise.all(
              (e.bulks as any[]).map(async (b: any) => {
                const cancelData = b.cancelData
                  ? {
                      ids: b.cancelData.ids ?? [],
                      isAll: b.cancelData.isAll,
                      isStrict: b.cancelData.isStrict,
                    }
                  : { ids: [], isAll: false, isStrict: false };
                let guard: { desiredRate: number } | { slippage: number };
                if (b.desiredRate !== undefined) {
                  guard = { desiredRate: b.desiredRate };
                } else if (b.slippage !== undefined) {
                  guard = { slippage: b.slippage };
                } else {
                  // Backend requires one of {desiredRate, slippage}; use per-market default.
                  const bMarket = await getMarketInfo(b.marketId);
                  guard = { slippage: computeDefaultSlippage(bMarket) };
                }
                return {
                  marketId: b.marketId,
                  cancelData,
                  orders: {
                    side: SIDE_MAP[b.orders.side as keyof typeof SIDE_MAP],
                    sizes: b.orders.sizes.map((s: string) => parseSize(s).toString()),
                    limitTicks: b.orders.limitTicks,
                    tif: TIF_MAP[b.orders.timeInForce as keyof typeof TIF_MAP],
                  },
                  ...guard,
                };
              }),
            );
            orderRequests.push({ bulkOrders: { accountId, cross: e.cross, bulks } });

            const allMarketIds = e.bulks.map((b: any) => b.marketId);
            const allSides = e.bulks.map((b: any) => b.orders.side);
            const allTifs = e.bulks.map((b: any) => b.orders.timeInForce);
            const uniformMarketId = allMarketIds.every((m: number) => m === allMarketIds[0]) ? allMarketIds[0] : undefined;
            const uniformSide = allSides.every((s: string) => s === allSides[0]) ? allSides[0] : undefined;
            const uniformTif = allTifs.every((t: string) => t === allTifs[0]) ? allTifs[0] : undefined;

            const allTicks: number[] = e.bulks.flatMap((b: any) => b.orders.limitTicks as number[]);
            const tickMin = allTicks.length ? Math.min(...allTicks) : undefined;
            const tickMax = allTicks.length ? Math.max(...allTicks) : undefined;

            const allSizes: bigint[] = e.bulks.flatMap((b: any) =>
              b.orders.sizes.map((s: string) => parseSize(s)),
            );
            const sizeMin = allSizes.length ? allSizes.reduce((a, b) => (b < a ? b : a)) : undefined;
            const sizeMax = allSizes.length ? allSizes.reduce((a, b) => (b > a ? b : a)) : undefined;

            intents.push({
              selector: ROUTER_SELECTORS.bulkOrders,
              cross: e.cross,
              ...(uniformMarketId !== undefined ? { marketId: uniformMarketId } : {}),
              ...(uniformSide !== undefined ? { side: uniformSide } : {}),
              ...(uniformTif !== undefined ? { tif: TIF_MAP[uniformTif as keyof typeof TIF_MAP] } : {}),
              ...(tickMin !== undefined ? { tickMin } : {}),
              ...(tickMax !== undefined ? { tickMax } : {}),
              ...(sizeMin !== undefined ? { sizeMin } : {}),
              ...(sizeMax !== undefined ? { sizeMax } : {}),
            });
          }
        }

        const calldataRes = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/agent/place-orders', { orderRequests }),
        );
        const calldatas = extractCalldatas(calldataRes);
        const resolved = (calldataRes.calls ?? []).map((c: any, i: number) => {
          const r = c.resolved;
          if (r && typeof r === 'object') {
            const sideLabel = sideLabelFromWire(r.side);
            return sideLabel !== undefined ? { ...r, side: sideLabel } : r;
          }
          // Backend returns resolved:null for bulk entries — synthesize from inputs so the caller
          const e: any = entries[i];
          if (e?.kind === 'bulk') {
            return {
              kind: 'bulk',
              cross: e.cross,
              bulks: (e.bulks as any[]).map((b) => ({
                marketId: b.marketId,
                side: b.orders.side,
                tif: b.orders.timeInForce,
                orders: b.orders.sizes.map((sz: string, idx: number) => ({
                  subIndex: idx,
                  sizeYU: sz,
                  limitTick: b.orders.limitTicks[idx],
                })),
                ...(b.cancelData ? { cancelData: b.cancelData } : {}),
              })),
            };
          }
          return r;
        });

        // Pre-snapshot resting orders per marketId — covers both kinds.
        // single resting → +1 per market; bulk resting → +sizes.length per market.
        const restingCountByMarket = new Map<number, number>();
        for (const e of entries as any[]) {
          if (e.kind === 'single') {
            if (RESTING_TIFS.has(e.timeInForce)) {
              restingCountByMarket.set(e.marketId, (restingCountByMarket.get(e.marketId) ?? 0) + 1);
            }
          } else {
            for (const b of e.bulks as any[]) {
              if (RESTING_TIFS.has(b.orders.timeInForce)) {
                restingCountByMarket.set(
                  b.marketId,
                  (restingCountByMarket.get(b.marketId) ?? 0) + b.orders.sizes.length,
                );
              }
            }
          }
        }
        const preSnapshotByMarket = new Map<number, Set<string>>();
        await Promise.all(
          [...restingCountByMarket.keys()].map(async (mid) => {
            preSnapshotByMarket.set(
              mid,
              await snapshotActiveOrderIds(rootAddress, accountId, mid),
            );
          }),
        );

        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['placeSingleOrder', 'bulkOrders'],
          { atomic, intents },
        );

        const status = analyzeExecution(result);
        const allReverted = status.entries.length > 0 && status.revertCount === status.entries.length;
        if ((atomic && status.revertCount > 0) || allReverted) {
          const execErr = executionErrorContent('place_orders', result);
          if (execErr) return execErr;
        }

        const orderIdsByMarket: Record<number, string[]> = {};
        await Promise.all(
          [...restingCountByMarket.entries()].map(async ([mid, n]) => {
            const pre = preSnapshotByMarket.get(mid) ?? new Set<string>();
            const ids = await resolveRecentOrderIdsSinceSnapshot(rootAddress, accountId, mid, pre, n);
            if (ids && ids.length) orderIdsByMarket[mid] = ids;
          }),
        );

        const txHash = extractTxHash(result);

        const entryKindCounts = entries.reduce(
          (acc: { single: number; bulk: number }, e: any) => {
            acc[e.kind as 'single' | 'bulk']++;
            return acc;
          },
          { single: 0, bulk: 0 },
        );
        const totalSubOrders = (entries as any[]).reduce((acc, e) => {
          if (e.kind === 'single') return acc + 1;
          return acc + e.bulks.reduce((s: number, b: any) => s + b.orders.sizes.length, 0);
        }, 0);

        return jsonResult({
          ok: status.revertCount === 0,
          action: 'place_orders',
          ...(txHash ? { txHash } : {}),
          entryCount: entries.length,
          entryKindCounts,
          totalSubOrders,
          atomic,
          resolved,
          ...(limitAprWarnings.length > 0 ? { limitAprWarnings } : {}),
          ...(slippageDefaultedSingles.length > 0
            ? {
                slippageDefaultedSingles,
                slippageDefaultedNote:
                  'Indicated single entries got the per-market default slippage (0.5 × market.maxRateDeviation) because no slippage/desiredRate was provided. Backend ignores slippage for GTC/ALO/SOFT_ALO (limitTick is the guard); for FOK/IOC this acts as a real ceiling.',
              }
            : {}),
          ...(Object.keys(orderIdsByMarket).length > 0 ? { orderIdsByMarket } : {}),
          ...(status.revertCount > 0 ? { reverts: status.reverts } : {}),
          execution: result,
          _context: {
            apr: APR_NOTE,
            resolved: 'Per-call echo of tick/rate/desiredRate actually encoded.',
            orderIdsByMarket: 'Newly-placed resting orderIds, grouped by marketId. Diff of active-orders set before vs. after the tx — automatically filters out preCancelOrderId / cancelData targets and unrelated resting orders. May be empty under heavy concurrent placements.',
            okSemantics: '`ok` is true only if every sub-call succeeded. atomic:false partial reverts still flip ok:false; inspect `reverts[]`.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
