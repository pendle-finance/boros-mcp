import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiGet, openApiPost } from '../../api/open-api.js';
import { type IntentExpectation } from '../../agent/signing.js';
import { ROUTER_SELECTORS } from '../../chain/selectors.js';
import { jsonResult, analyzeExecution } from '../../utils.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { marginModeField, marketIdField } from '../_schemas.js';
import { getMarketInfo, resolveMarketAcc } from './_market.js';
import {
  executeAgentAction,
  extractCalldatas,
  extractTxHash,
  executionErrorContent,
} from './_execute.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';

export function registerCancelTools(server: McpServer) {
  server.registerTool(
    'cancel_orders',
    {
      annotations: { destructiveHint: true },
      description: 'Cancel one or more limit orders on a market. Provide specific orderIds or set cancelAll to true. Stale-id handling: with `atomic:false` the on-chain bulkCancels silently skips ids that are filled/cancelled. With `atomic:true` the contract reverts on any unknown id. The backend pre-flight simulator may also reject the whole batch when an id is unknown to its state — observed inconsistently in 2026-Q2 testing, so the safest pattern is still to filter stale ids client-side via get_limit_orders before calling, especially under atomic:true. `cancelledCount` reflects the number of orders actually removed from the book (computed from the active-orders diff), NOT the request size.',
      inputSchema: {
        marketId: marketIdField(),
        orderIds: z.array(z.string().regex(/^\d+$/, 'orderId must be a numeric string')).optional().describe('Array of order ID strings to cancel. Mutually exclusive with cancelAll:true.'),
        cancelAll: z.boolean().default(false).describe('Cancel all open orders on this market. Mutually exclusive with orderIds.'),
        marginMode: marginModeField(),
        atomic: z.boolean().default(true).describe('true (default): whole batch reverts if any cancel fails (and the contract treats any unknown id as failure). false: best-effort on-chain — stale ids are silently skipped. The backend pre-flight simulator can still reject a mixed-stale batch under either setting; pre-filter stale ids via get_limit_orders for reliable MM workflows.'),
      },
    },
    withAuth(async ({ marketId, orderIds, cancelAll, marginMode, atomic }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        if (!cancelAll && (!orderIds || orderIds.length === 0)) {
          return errorContent(BorosErrorCode.INVALID_PARAMS, 'Provide orderIds or set cancelAll to true');
        }
        if (cancelAll && orderIds && orderIds.length > 0) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            'cancelAll:true and non-empty orderIds are mutually exclusive — pick one. Server behavior when both are sent is implementation-defined.',
          );
        }

        const market = await getMarketInfo(marketId);
        const tokenId: number = market.tokenId;
        const marketAcc = resolveMarketAcc(rootAddress, accountId, tokenId, marginMode, marketId);
        const marketNameRaw: string | undefined = market.imData?.name;
        const marketSymbol: string | undefined = market.metadata?.underlyingSymbol;

        // Pre-flight active-order snapshot — drives accurate cancelledCount in BOTH paths:
        // - cancelAll: short-circuit when book is already empty (saves gas), and tell the user how
        //   many orders were taken off the book.
        // - explicit orderIds: filter stale ids out of the cancelledCount so a mix of valid+stale
        //   doesn't inflate the report (Finding #6: callers thought 2 cancels happened when only 1
        //   was actually live).
        let preActiveSet: Set<string> | undefined;
        try {
          const ordersRes = await fetchWithRetry(() =>
            openApiGet('/v1/accounts/orders', {
              root: rootAddress,
              accountId,
              marketId,
              isActive: true,
              limit: 100,
            }),
          );
          const openOrders: any[] = Array.isArray(ordersRes)
            ? ordersRes
            : (ordersRes.results ?? []);
          preActiveSet = new Set(
            openOrders
              .map((o: any) => String(o.orderId ?? ''))
              .filter((s) => s.length > 0),
          );
        } catch {
          preActiveSet = undefined;
        }

        const prevOpenCount = preActiveSet?.size;
        if (cancelAll && prevOpenCount === 0) {
          return jsonResult({
            ok: true,
            action: 'cancel_orders',
            marketId,
            ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
            marketSymbol,
            cancelledAll: true,
            orderIds: [],
            cancelledCount: 0,
            atomic,
            skippedReason: 'No open orders detected pre-flight; on-chain tx skipped to save gas.',
          });
        }

        // For explicit orderIds: pre-flight count of ids that are actually active (excludes stale).
        const liveRequestedCount =
          !cancelAll && orderIds && preActiveSet
            ? orderIds.filter((id) => preActiveSet!.has(id)).length
            : undefined;

        // atomic:false + we have a fresh active-orders snapshot → drop stale ids client-side
        // before sending. Backend pre-flight simulator otherwise rejects the WHOLE batch on a
        // single unknown id (MarketOrderNotFound), even though the on-chain bulkCancels would
        // have silently skipped them. If everything was stale, short-circuit to ok:true.
        const filteredOrderIds =
          !cancelAll && orderIds && !atomic && preActiveSet
            ? orderIds.filter((id) => preActiveSet!.has(id))
            : orderIds;
        const droppedStaleIds =
          !cancelAll && orderIds && !atomic && preActiveSet
            ? orderIds.filter((id) => !preActiveSet!.has(id))
            : [];
        if (!cancelAll && !atomic && filteredOrderIds && filteredOrderIds.length === 0 && (orderIds?.length ?? 0) > 0) {
          return jsonResult({
            ok: true,
            action: 'cancel_orders',
            marketId,
            ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
            marketSymbol,
            cancelledAll: false,
            orderIds: [],
            cancelledCount: 0,
            atomic,
            skippedStaleIds: droppedStaleIds,
            skippedReason: 'Every requested orderId was already filled/cancelled before this call (atomic:false short-circuit; on-chain tx skipped to save gas).',
          });
        }

        const calldataRes = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/agent/cancel-orders', {
            markets: [{
              marketAcc,
              marketId,
              cancelAll: cancelAll ?? false,
              ...(filteredOrderIds && filteredOrderIds.length > 0 ? { orderIds: filteredOrderIds } : {}),
            }],
          }),
        );
        const calldatas = extractCalldatas(calldataRes);

        // bulkCancels: orderIds → SUBSET match (backend drops filled/cancelled).
        // Pin marketId, not marketAcc (see place_order).
        const cancelIntent: IntentExpectation = {
          selector: ROUTER_SELECTORS.bulkCancels,
          marketId,
          cross: marginMode !== 'isolated',
          ...(filteredOrderIds && filteredOrderIds.length > 0
            ? { orderIdsSubset: filteredOrderIds.map((s) => BigInt(s)) }
            : {}),
        };

        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['bulkCancels'],
          { atomic, intents: [cancelIntent] },
        );

        // Count from execution status, not request size — partial reverts must not inflate count.
        // For cancelAll, status.successCount is the number of bulkCancels calls (≈1), not the
        // number of orders cancelled — fall back to the pre-flight openOrders count.
        // For explicit orderIds, fall back to the pre-flight LIVE count (Finding #6: stale ids
        // would otherwise be counted as cancelled because bulkCancels silently skips them).
        const status = analyzeExecution(result);
        const requestedCount = cancelAll
          ? prevOpenCount ?? null
          : (liveRequestedCount ?? orderIds?.length ?? 0);
        const cancelledCount = status.allSuccess
          ? (requestedCount ?? status.successCount)
          : status.successCount;
        const skippedStaleIds =
          !cancelAll && orderIds && liveRequestedCount !== undefined
            ? orderIds.filter((id) => !preActiveSet!.has(id))
            : undefined;
        // Distinguish a "real" revert from one caused entirely by stale ids the contract would
        // have silently skipped. With atomic:false, the latter is a successful partial cancel,
        // not a failure — flip ok back to true and surface a partialOk:true marker.
        const allRevertsAreStaleId =
          !atomic &&
          status.revertCount > 0 &&
          status.reverts.every((r: any) => /MarketOrderNotFound/.test(String(r?.error ?? '')));

        if (atomic && status.revertCount > 0) {
          const execErr = executionErrorContent('cancel_orders', result);
          if (execErr) return execErr;
        }
        if (allRevertsAreStaleId) {
          const txHash = extractTxHash(result);
          return jsonResult({
            ok: true,
            partialOk: true,
            action: 'cancel_orders',
            ...(txHash ? { txHash } : {}),
            marketId,
            ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
            marketSymbol,
            cancelledAll: Boolean(cancelAll),
            orderIds: cancelAll ? [] : (orderIds ?? []),
            cancelledCount: status.successCount,
            atomic,
            ...(skippedStaleIds && skippedStaleIds.length > 0
              ? { skippedStaleIds, skippedStaleNote: 'Backend pre-flight rejected these as MarketOrderNotFound; on-chain bulkCancels would have silently skipped them. atomic:false treats this as partial success.' }
              : {}),
            reverts: status.reverts,
            execution: result,
          });
        }

        const txHash = extractTxHash(result);

        return jsonResult({
          ok: status.revertCount === 0,
          action: 'cancel_orders',
          ...(txHash ? { txHash } : {}),
          marketId,
          ...(marketNameRaw ? { marketName: marketNameRaw } : {}),
          marketSymbol,
          cancelledAll: Boolean(cancelAll),
          orderIds: cancelAll ? [] : (orderIds ?? []),
          cancelledCount,
          ...(skippedStaleIds && skippedStaleIds.length > 0
            ? {
                skippedStaleIds,
                skippedStaleNote: `${skippedStaleIds.length} of the requested orderIds were already filled/cancelled before this call. The contract silently skipped them; cancelledCount excludes them.`,
              }
            : {}),
          atomic,
          ...(status.revertCount > 0
            ? { reverts: status.reverts }
            : {}),
          execution: result,
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
