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
} from './_helpers.js';
import {
  getMarketInfo,
  resolveMarketAcc,
  resolveRecentOrderIds,
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
      description: `Place N (max 100) independent single orders in one agent transaction. Advanced tier — exposes raw limitTick, absolute desiredRate, per-order ammId, and atomic preCancelOrderId. Use place_order for single-order UI flow (which simulates first); use place_ladders for orderbook-only bundled orders (cheaper gas, single bulkOrders call).

NO PER-ENTRY SIMULATION: this tool does NOT call /v1/simulations/place-order before signing. For unfamiliar markets, call simulate_order on representative entries first, especially when |rate| is large or notional is small (backend enforces a $10 min order value).

Each order entry must belong to the same (root, accountId). Per entry:
- Limit price (pick one, mutually exclusive): limitTick (raw contract tick) OR rate (DECIMAL APR; 0.085 = 8.5%). Required for limit TIFs (GTC/ALO/SOFT_ALO); optional for FOK/IOC.
- Execution guard (pick one, mutually exclusive): desiredRate (absolute DECIMAL APR ceiling) OR slippage (relative from mid as DECIMAL). Optional for limit; recommended for market.
- ammId: 0 = orderbook-only, specific AMM id = route through that AMM. Required.

ALL entries land in ONE on-chain tryAggregate tx — every sub-call shares the same txHash. \`ok\` is true only when EVERY sub-call succeeded; inspect \`reverts[]\` for partials. preCancelOrderId is STRICT: the WHOLE BATCH reverts if a pre-cancel cannot be honored, even with atomic:false.`,
      inputSchema: {
        orders: z
          .array(
            z.object({
              marketId: marketIdField('Market ID'),
              marginMode: marginModeField(),
              side: sideSchema.describe('Order side (any case)'),
              size: z.string().describe('Notional size in YU, human-readable decimal (e.g. "1000.5"). ALWAYS POSITIVE.'),
              timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'ALO', 'SOFT_ALO']).describe(TIME_IN_FORCE_DESCRIPTION),
              limitTick: z.number().int().min(-32768).max(32767).optional().describe('Raw contract tick. Mutually exclusive with rate.'),
              rate: z.number().optional().describe('APR as DECIMAL (0.085 = 8.5%, NOT 8.5). Mutually exclusive with limitTick. No upper bound — some markets have legitimately traded at |APR| > 100%.'),
              desiredRate: z.number().optional().describe('Absolute execution ceiling as DECIMAL APR. Mutually exclusive with slippage.'),
              slippage: z.number().min(0).max(1, 'slippage > 1 — DECIMAL: 0.05 = 5%, not 5').optional().describe('Relative tolerance from mid as DECIMAL (0.05 = 5%). Mutually exclusive with desiredRate.'),
              ammId: ammIdField('AMM routing. 0 = orderbook-only; specific id = route that AMM. Required.'),
              preCancelOrderId: z.string().optional().describe('Order id to atomically cancel before matching. STRICT: the WHOLE BATCH reverts if the pre-cancel cannot be honored, even with atomic:false.'),
            }),
          )
          .min(1)
          .max(100, 'place_orders supports at most 100 entries (send-txs-bot MAX_ALLOWED_BULK_DIRECT_CALL_SIZE).')
          .describe('Array of independent single orders (max 100). Each entry becomes one placeSingleOrder contract call, all bundled under a single on-chain tryAggregate tx (one txHash for the whole batch).'),
        atomic: z.boolean().default(true).describe('true (default): whole batch reverts if any order fails. false: best-effort — survivors execute independently, but `ok` is still false if ANY sub-call reverted (inspect `reverts[]`).'),
      },
    },
    withAuth(async ({ orders, atomic }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        // Soft decimal-vs-percent warning per entry (|rate| > 1) — does not reject.
        const limitAprWarnings: { index: number; warning: string }[] = [];
        for (let i = 0; i < orders.length; i++) {
          const o: any = orders[i];
          const w = limitAprWarning(o.rate);
          if (w) limitAprWarnings.push({ index: i, warning: w });
        }

        // V2 backend 400s without one of slippage/desiredRate. Tif-aware default:
        // GTC/ALO/SOFT_ALO already gated by per-tick limitTick → slippage:1 (disabled);
        // FOK/IOC takers need a real guard → reject pre-flight.
        const slippageDefaulted: number[] = [];
        for (let i = 0; i < orders.length; i++) {
          const o: any = orders[i];
          if (o.slippage === undefined && o.desiredRate === undefined) {
            if (o.timeInForce === 'FOK' || o.timeInForce === 'IOC') {
              return errorContent(
                BorosErrorCode.INVALID_PARAMS,
                `orders[${i}] (${o.timeInForce}): one of \`slippage\` or \`desiredRate\` is required for taker orders. Pass slippage (e.g. 0.01 = 1%) or desiredRate (absolute APR ceiling).`,
              );
            }
            slippageDefaulted.push(i);
          }
        }

        const entries = await Promise.all(
          orders.map(async (o: any, i: number) => {
            const market = await getMarketInfo(o.marketId);
            const tokenId: number = market.tokenId;
            const marketAcc = resolveMarketAcc(rootAddress, accountId, tokenId, o.marginMode, o.marketId);
            const sizeRaw = parseSize(o.size).toString();
            const effectiveSlippage = o.slippage !== undefined
              ? o.slippage
              : (slippageDefaulted.includes(i) ? 1 : undefined);
            // ALO/SOFT_ALO cannot route through AMM — backend strips ammId, so calldata
            // and intent must agree on 0 to avoid a verifier mismatch.
            const effectiveAmmId = (o.timeInForce === 'ALO' || o.timeInForce === 'SOFT_ALO') ? 0 : o.ammId;
            return {
              marketAcc,
              marketId: o.marketId,
              side: SIDE_MAP[o.side as keyof typeof SIDE_MAP],
              size: sizeRaw,
              tif: TIF_MAP[o.timeInForce as keyof typeof TIF_MAP],
              ammId: effectiveAmmId,
              ...(o.limitTick !== undefined ? { limitTick: o.limitTick } : {}),
              ...(o.rate !== undefined ? { rate: o.rate } : {}),
              ...(o.desiredRate !== undefined ? { desiredRate: o.desiredRate } : {}),
              ...(effectiveSlippage !== undefined ? { slippage: effectiveSlippage } : {}),
              ...(o.preCancelOrderId ? { preCancelOrderId: o.preCancelOrderId } : {}),
            };
          }),
        );

        // /place-orders shape: each entry is { singleOrder? | bulkOrders? } (exactly one).
        // place_orders sends only singleOrder; place_ladders sends one bulkOrders.
        const calldataRes = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/agent/place-orders', {
            orderRequests: entries.map((e: any) => ({ singleOrder: e })),
          }),
        );
        const calldatas = extractCalldatas(calldataRes);
        // Translate numeric wire side → MCP label for human-readable echo.
        const resolved = (calldataRes.calls ?? []).map((c: any) => {
          const r = c.resolved;
          if (!r || typeof r !== 'object') return r;
          const sideLabel = sideLabelFromWire(r.side);
          return sideLabel !== undefined ? { ...r, side: sideLabel } : r;
        });

        // Per-entry placeSingleOrder intent. No tick pin on rate path (rate→tick rounding LONG↓/SHORT↑).
        const placeOrdersIntents: IntentExpectation[] = entries.map((e: any, i: number) => {
          const sizeForIntent = tryBigInt(e.size);
          const o: any = orders[i];
          // Pin marketId+cross (not marketAcc) — see place_order.
          const intent: IntentExpectation = {
            selector: ROUTER_SELECTORS.placeSingleOrder,
            marketId: e.marketId,
            cross: o.marginMode !== 'isolated',
            side: o.side,
            tif: TIF_MAP[o.timeInForce as keyof typeof TIF_MAP],
            ammId: e.ammId,
            ...(sizeForIntent !== undefined ? { sizeAbs: sizeForIntent } : {}),
            ...(typeof o.limitTick === 'number' ? { tickExact: o.limitTick } : {}),
          };
          return intent;
        });

        // Pin selector — allowing bulkOrders would let a compromised open-api swap to bundled payload.
        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['placeSingleOrder'],
          { atomic, intents: placeOrdersIntents },
        );

        const status = analyzeExecution(result);
        if (atomic && status.revertCount > 0) {
          const execErr = executionErrorContent('place_orders', result);
          if (execErr) return execErr;
        }

        // GTC/ALO/SOFT_ALO only — best-effort orderId lookup grouped by marketId.
        const restingByMarket = new Map<number, number>();
        for (const o of orders) {
          if (o.timeInForce === 'GTC' || o.timeInForce === 'ALO' || o.timeInForce === 'SOFT_ALO') {
            restingByMarket.set(o.marketId, (restingByMarket.get(o.marketId) ?? 0) + 1);
          }
        }
        const orderIdsByMarket: Record<number, string[]> = {};
        await Promise.all(
          [...restingByMarket.entries()].map(async ([mid, n]) => {
            const ids = await resolveRecentOrderIds(rootAddress, accountId, mid, n);
            if (ids && ids.length) orderIdsByMarket[mid] = ids;
          }),
        );

        const txHash = extractTxHash(result);

        return jsonResult({
          ok: status.revertCount === 0,
          action: 'place_orders',
          ...(txHash ? { txHash } : {}),
          orderCount: orders.length,
          atomic,
          resolved,
          ...(limitAprWarnings.length > 0 ? { limitAprWarnings } : {}),
          ...(slippageDefaulted.length > 0
            ? { slippageDefaulted, slippageDefaultedNote: 'Indices got slippage:1 (effectively disabled) because no slippage/desiredRate was provided. Per-tick limitTick still gates fills for resting orders, so this is safe for GTC/ALO/SOFT_ALO.' }
            : {}),
          ...(Object.keys(orderIdsByMarket).length > 0 ? { orderIdsByMarket } : {}),
          ...(status.revertCount > 0 ? { reverts: status.reverts } : {}),
          execution: result,
          _context: {
            apr: APR_NOTE,
            resolved: 'Per-order echo of tick/rate/desiredRate actually encoded.',
            orderIdsByMarket: 'Newly-placed resting orderIds, grouped by marketId. Best-effort — may be empty under concurrent placements.',
            okSemantics: '`ok` is true only if every sub-call succeeded. atomic:false partial reverts still flip ok:false; inspect `reverts[]`.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );

  server.registerTool(
    'place_ladders',
    {
      annotations: { destructiveHint: true },
      description: `Place N orderbook-only orders bundled into a single on-chain bulkOrders call. AMM is skipped by construction — strictly cheaper than place_orders with ammId:0 on every entry. Two main use cases:
1. MM ladder refresh — cancelData per market atomically cancels stale resting orders and places fresh ones at multiple tick levels (uniform side+tif per ladder).
2. Gas-efficient taker batch — N orderbook-only orders as single-order ladders (sizes:[x], limitTicks:[y]).

Constraints:
- cross:false (isolated) pins the account to the first ladder's marketId — send one ladder per request.
- cross:true lets multiple markets share the same tokenId in one request.
- No AMM routing, no per-order preCancelOrderId, no inline isolated cash moves. Use place_order / place_orders for those.`,
      inputSchema: {
        cross: z.boolean().describe('true → cross account; false → isolated (pinned to first ladder\'s marketId).'),
        ladders: z
          .array(
            z.object({
              marketId: z.number().int().describe('Market ID for this ladder'),
              orders: z.object({
                side: sideSchema.describe('Side applied to every order in this ladder (any case)'),
                sizes: z.array(z.string()).min(1).describe('Per-order notional sizes in human-readable decimal'),
                limitTicks: z.array(z.number().int()).min(1).describe('Per-order raw tick indices. sizes.length === limitTicks.length'),
                timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'ALO', 'SOFT_ALO']).describe('TIF applied to every order in the ladder. ' + TIME_IN_FORCE_DESCRIPTION),
              }),
              cancelData: z
                .object({
                  ids: z.array(z.string()).optional().describe('Order IDs to cancel. Ignored when isAll:true.'),
                  isAll: z.boolean().describe('Cancel every resting order in this market. `ids` is ignored when true.'),
                  isStrict: z.boolean().describe('Revert the whole ladder call if any id cancel fails. MM default: false (best-effort).'),
                })
                .optional()
                .describe('Atomic cancel-before-place for this market. Omit to place without cancelling.'),
              desiredRate: z.number().optional().describe('Absolute execution ceiling for this ladder. Strongly recommended when any FOK is present.'),
            }),
          )
          .min(1)
          .describe('Per-market ladder entries. One contract call per entry (all bundled into one bulkOrders tx).'),
        atomic: z.boolean().default(true).describe('true (default): whole bulkOrders tx reverts if any ladder fails. false: best-effort — survivors execute independently. MM workflows usually want false to tolerate a single stale-id revert.'),
      },
    },
    withAuth(async ({ cross, ladders, atomic }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        // cross:false pins whole call to first ladder's marketId (contract limit) — reject 2nd ladder
        // pre-flight to avoid silent misroute to first marketAcc.
        if (!cross && ladders.length > 1) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            'place_ladders with cross:false must contain exactly one ladder — send separate calls for each isolated market.',
          );
        }

        // Folds ladder bundle into one bulkOrders entry under /place-orders.
        // cancelData is required per bulk (default empty/non-strict).
        // Bulk requires one of desiredRate/slippage — default slippage:1 (disabled) to avoid 400.
        const bulks = ladders.map((l: any) => {
          const cancelData = l.cancelData
            ? {
                ids: l.cancelData.ids ?? [],
                isAll: l.cancelData.isAll,
                isStrict: l.cancelData.isStrict,
              }
            : { ids: [], isAll: false, isStrict: false };
          const guard =
            l.desiredRate !== undefined
              ? { desiredRate: l.desiredRate }
              : { slippage: 1 };
          return {
            marketId: l.marketId,
            cancelData,
            orders: {
              side: SIDE_MAP[l.orders.side as keyof typeof SIDE_MAP],
              sizes: l.orders.sizes.map((s: string) => parseSize(s).toString()),
              limitTicks: l.orders.limitTicks,
              tif: TIF_MAP[l.orders.timeInForce as keyof typeof TIF_MAP],
            },
            ...guard,
          };
        });

        const body = {
          orderRequests: [
            {
              bulkOrders: {
                accountId,
                cross,
                bulks,
              },
            },
          ],
        };

        const calldataRes = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/agent/place-orders', body),
        );
        const calldatas = extractCalldatas(calldataRes);

        // bulkOrders: backend bundles ladders into one calldata. Pin uniform marketId/side/tif when possible
        // and size/tick min/max envelope across all bulks (false-positive safe).
        const allMarketIds = ladders.map((l: any) => l.marketId);
        const allSides = ladders.map((l: any) => l.orders.side);
        const allTifs = ladders.map((l: any) => l.orders.timeInForce);
        const uniformMarketId = allMarketIds.every((m: number) => m === allMarketIds[0]) ? allMarketIds[0] : undefined;
        const uniformSide = allSides.every((s: string) => s === allSides[0]) ? allSides[0] : undefined;
        const uniformTif = allTifs.every((t: string) => t === allTifs[0]) ? allTifs[0] : undefined;

        const allTicks: number[] = ladders.flatMap((l: any) => l.orders.limitTicks as number[]);
        const tickMin = allTicks.length ? Math.min(...allTicks) : undefined;
        const tickMax = allTicks.length ? Math.max(...allTicks) : undefined;

        const allSizes: bigint[] = ladders.flatMap((l: any) =>
          l.orders.sizes.map((s: string) => parseSize(s)),
        );
        const sizeMin = allSizes.length ? allSizes.reduce((a, b) => (b < a ? b : a)) : undefined;
        const sizeMax = allSizes.length ? allSizes.reduce((a, b) => (b > a ? b : a)) : undefined;

        const ladderIntent: IntentExpectation = {
          selector: ROUTER_SELECTORS.bulkOrders,
          cross,

          ...(uniformMarketId !== undefined ? { marketId: uniformMarketId } : {}),
          ...(uniformSide !== undefined ? { side: uniformSide } : {}),
          ...(uniformTif !== undefined ? { tif: TIF_MAP[uniformTif as keyof typeof TIF_MAP] } : {}),
          ...(tickMin !== undefined ? { tickMin } : {}),
          ...(tickMax !== undefined ? { tickMax } : {}),
          ...(sizeMin !== undefined ? { sizeMin } : {}),
          ...(sizeMax !== undefined ? { sizeMax } : {}),
        };

        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['bulkOrders'],
          { atomic, intents: [ladderIntent] },
        );

        // EXECUTION_REVERTED on: atomic:true with any revert OR atomic:false fully-reverted.
        const status = analyzeExecution(result);
        const allReverted = status.entries.length > 0 && status.revertCount === status.entries.length;
        if ((atomic && status.revertCount > 0) || allReverted) {
          const execErr = executionErrorContent('place_ladders', result);
          if (execErr) return execErr;
        }

        const orderIdsByMarket: Record<number, string[]> = {};
        await Promise.all(
          ladders.map(async (l: any) => {
            const tif = l.orders.timeInForce;
            if (tif !== 'GTC' && tif !== 'ALO' && tif !== 'SOFT_ALO') return;
            const ids = await resolveRecentOrderIds(rootAddress, accountId, l.marketId, l.orders.sizes.length);
            if (ids && ids.length) orderIdsByMarket[l.marketId] = ids;
          }),
        );

        const txHash = extractTxHash(result);

        return jsonResult({
          ok: status.revertCount === 0,
          action: 'place_ladders',
          ...(txHash ? { txHash } : {}),
          cross,
          ladderCount: ladders.length,
          totalOrders: ladders.reduce((acc: number, l: any) => acc + l.orders.sizes.length, 0),
          atomic,
          ...(Object.keys(orderIdsByMarket).length > 0 ? { orderIdsByMarket } : {}),
          ...(status.revertCount > 0 ? { reverts: status.reverts } : {}),
          execution: result,
          _context: {
            apr: APR_NOTE,
            note: 'All ladders bundled into one on-chain bulkOrders call. Orderbook-only (no AMM).',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
