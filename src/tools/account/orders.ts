import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import {
  jsonResult, enrichAprValue, enrichTimestamp, formatSize, decodeMarketAcc, orderStatusLabel,
} from '../../utils.js';
import {
  userAddressField,
  resumeTokenField,
  paginationLimitField,
} from '../_schemas.js';
import { APR_NOTE } from '../_context.js';

import { safeAssetMap, type AssetInfo } from '../../api/asset-cache.js';
import { fetchMarketMap, type MarketInfo } from '../../api/market-cache.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';

const ORDER_TYPE_LABELS: Record<number, string> = {
  0: 'LIMIT',
  1: 'MARKET',
  2: 'TAKE_PROFIT_MARKET',
  3: 'STOP_LOSS_MARKET',
};

function enrichLimitOrder(
  order: any,
  marketMap: Map<number, MarketInfo>,
  assetMap: Map<number, AssetInfo>,
) {
  const mkt = marketMap.get(order.marketId);
  // Strip noisy last-updated eventIndex; preserve placedEventIndex (immutable cursor).
  // Raw impliedApr dropped (carried by *Percent sibling).
  const {
    side, status, orderType,
    placedSize, unfilledSize, impliedApr,
    blockTimestamp, placedTimestamp, eventIndex, root, marketAcc,
    ...rest
  } = order;
  const resolvedTs = placedTimestamp ?? blockTimestamp;
  const orderTypeLabel = orderType !== undefined ? (ORDER_TYPE_LABELS[orderType] ?? 'unknown') : undefined;
  return {
    ...rest,
    ...(order.marketAcc ? { marketAccDecoded: decodeMarketAcc(order.marketAcc, assetMap) } : {}),
    ...(mkt?.name ? { marketName: mkt.name } : {}),
    ...(mkt?.symbol ? { marketSymbol: mkt.symbol } : {}),
    sideLabel: side === 0 ? 'long' : 'short',
    ...(status !== undefined ? { statusLabel: orderStatusLabel(status, order) } : {}),
    ...(orderTypeLabel ? { orderTypeLabel } : {}),
    ...(resolvedTs ? { placedAt: enrichTimestamp(resolvedTs) } : {}),
    ...(placedSize !== undefined ? { size: formatSize(placedSize) } : {}),
    ...(unfilledSize !== undefined ? { unfilled: formatSize(unfilledSize) } : {}),
    ...(impliedApr !== undefined
      ? { impliedAprPercent: enrichAprValue(impliedApr)?.aprPercent }
      : {}),
  };
}

export function registerAccountOrdersTools(server: McpServer) {
  server.registerTool(
    'get_limit_orders',
    {
      annotations: { readOnlyHint: true },
      description: 'List your limit orders, filtered by market and/or active status. Sorted by last-updated event index descending (NOT by placement) — paginating mid-stream can miss/duplicate orders that were updated between pages; use get_all_limit_orders for an immutable placed-event-index sort when fully enumerating. Defaults to active orders only — pass `isActive:false` for filled/cancelled, or `isActive:null` to include every status. To cancel a returned order, pass its `orderId` (not `placedTxHash`) to cancel_orders.',
      inputSchema: {
        userAddress: userAddressField(),
        accountId: z
          .number()
          .default(0)
          .describe('Account ID (default 0 for main account)'),
        marketId: z
          .number()
          .optional()
          .describe('Filter by market ID'),
        isActive: z
          .boolean()
          .nullable()
          .default(true)
          .describe('Active status filter. Default true = only currently open orders. Pass false for filled/cancelled only, null to include every status.'),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe('Number of orders to return (max 100). Backend allows up to 2000 but we cap to keep LLM context manageable; for full enumeration use get_all_limit_orders.'),
        resumeToken: z
          .string()
          .optional()
          .describe('Cursor token from previous response for next page. Backend may return resumeToken even when fewer than `limit` rows are returned; pass it to continue.'),
      },
    },
    withAuth(async ({ userAddress, accountId, marketId, isActive, limit, resumeToken }) => {
      try {
        const data = await fetchWithRetry(() =>
          openApiGet('/v1/accounts/orders', {
            root: userAddress,
            accountId: accountId ?? 0,
            ...(marketId !== undefined ? { marketId } : {}),
            // null = include all statuses (omit param).
            ...(isActive !== null && isActive !== undefined ? { isActive } : {}),
            limit: limit ?? 20,
            ...(resumeToken ? { resumeToken } : {}),
          }),
        );

        const results = data.results ?? (Array.isArray(data) ? data : []);
        const [marketMap, assetMap] = await Promise.all([fetchMarketMap(), safeAssetMap()]);

        const orders = results.map((order: any) => enrichLimitOrder(order, marketMap, assetMap));

        return jsonResult({
          count: orders.length,
          sizeUnit: 'YU',
          orders,
          ...(data.resumeToken ? { resumeToken: data.resumeToken } : {}),
          _context: {
            apr: APR_NOTE,
            sortOrder: 'Sorted by last-updated eventIndex descending. Use get_all_limit_orders for placed-index sort when fully enumerating.',
            cancellation: 'To cancel, pass `orderId` (not `placedTxHash`) to cancel_orders.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );

  server.registerTool(
    'get_all_limit_orders',
    {
      annotations: { readOnlyHint: true },
      description: 'Get all limit orders for an account, sorted by placed event index (immutable), using cursor-based pagination. Unlike get_limit_orders, paginating here guarantees no orders are missed. Does not support filtering by market, status, or order type — use get_limit_orders for those.',
      inputSchema: {
        userAddress: userAddressField('Wallet address (0x...)'),
        accountId: z.number().default(0).describe('Account ID (default 0)'),
        limit: paginationLimitField({ max: 2000, defaultValue: 50 }),
        resumeToken: resumeTokenField(),
      },
    },
    withAuth(async ({ userAddress, accountId, limit, resumeToken }) => {
      try {
        const res = await fetchWithRetry(() =>
          openApiGet('/v1/accounts/orders-by-placed-time', {
            root: userAddress,
            accountId: accountId ?? 0,
            limit,
            ...(resumeToken ? { resumeToken } : {}),
          }),
        );
        const results = res.results ?? (Array.isArray(res) ? res : []);
        const [marketMap, assetMap] = await Promise.all([fetchMarketMap(), safeAssetMap()]);
        const orders = results.map((order: any) => enrichLimitOrder(order, marketMap, assetMap));

        return jsonResult({
          count: orders.length,
          sizeUnit: 'YU',
          orders,
          ...(res.resumeToken ? { resumeToken: res.resumeToken } : {}),
          _context: {
            apr: APR_NOTE,
            sortOrder: 'Sorted by placed event index descending (immutable).',
            resumeToken: 'Pass this value as resumeToken to fetch the next page. Absent when there are no more results.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
