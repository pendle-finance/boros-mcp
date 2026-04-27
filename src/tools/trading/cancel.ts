import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiGet, openApiPost } from '../../api/open-api.js';
import { type IntentExpectation } from '../../agent/signing.js';
import { ROUTER_SELECTORS } from '../../chain/selectors.js';
import { jsonResult, analyzeExecution } from '../../utils.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { marginModeField } from '../_schemas.js';
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
      description: 'Cancel one or more limit orders on a market. Provide specific orderIds or set cancelAll to true. NOTE on `atomic:false`: the on-chain bulkCancels does ignore stale ids, BUT the backend pre-flight simulator currently rejects the WHOLE batch (with MarketOrderNotFound) if any id is unknown to the simulator state — so a known-stale id mixed with valid ones can still abort the call. Filter stale ids client-side (via get_limit_orders) before calling, or pass each suspect id alone.',
      inputSchema: {
        marketId: z.number().describe('Market ID'),
        orderIds: z.array(z.string().regex(/^\d+$/, 'orderId must be a numeric string')).optional().describe('Array of order ID strings to cancel. Mutually exclusive with cancelAll:true.'),
        cancelAll: z.boolean().default(false).describe('Cancel all open orders on this market. Mutually exclusive with orderIds.'),
        marginMode: marginModeField(),
        atomic: z.boolean().default(true).describe('true (default): whole batch reverts if any cancel fails. false: best-effort on-chain — stale ids are ignored at execution. CAVEAT: backend pre-flight simulator still rejects the whole batch if any id is unknown to its state, so filter stale ids client-side first. MM workflows usually want false.'),
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

        // Pre-flight count of open orders for cancelAll — drives accurate cancelledCount
        // (status.successCount counts contract calls, not individual order cancellations) and
        // lets us short-circuit when the book is already empty (saves gas).
        let prevOpenCount: number | undefined;
        if (cancelAll) {
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
            prevOpenCount = openOrders.length;
          } catch {
            // Fall through — if the indexer is flaky, still submit the tx (it's a no-op on-chain).
            prevOpenCount = undefined;
          }
          if (prevOpenCount === 0) {
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
        }

        const calldataRes = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/agent/cancel-orders', {
            markets: [{
              marketAcc,
              marketId,
              cancelAll: cancelAll ?? false,
              ...(orderIds && orderIds.length > 0 ? { orderIds } : {}),
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
          ...(orderIds && orderIds.length > 0
            ? { orderIdsSubset: orderIds.map((s) => BigInt(s)) }
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
        // number of orders cancelled — fall back to the pre-flight openOrders count so an
        // already-empty book doesn't wrongly report cancelledCount:1.
        const status = analyzeExecution(result);
        const requestedCount = cancelAll ? prevOpenCount ?? null : (orderIds?.length ?? 0);
        const cancelledCount = status.allSuccess
          ? (requestedCount ?? status.successCount)
          : status.successCount;

        if (atomic && status.revertCount > 0) {
          const execErr = executionErrorContent('cancel_orders', result);
          if (execErr) return execErr;
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
