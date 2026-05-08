import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import {
  jsonResult, enrichAprValue, enrichTimestamp, formatSize, decodeMarketAcc, orderStatusLabel,
} from '../../utils.js';
import {
  userAddressField,
  marketIdOptionalField,
  accountIdField,
  paginationLimitField,
} from '../_schemas.js';
import { APR_NOTE } from '../_context.js';

import { safeAssetMap, type AssetInfo } from '../../api/asset-cache.js';
import { fetchMarketMap, type MarketInfo } from '../../api/market-cache.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';
import { buildIncludeSet, projectFields, includeFieldSchema } from '../_shared/projection.js';

const ORDERS_DEFAULT_FIELDS = [
  'orderId',
  'marketId',
  'marketName',
  'marketSymbol',
  'sideLabel',
  'statusLabel',
  'orderTypeLabel',
  'size',
  'unfilled',
  'impliedAprPercent',
] as const;
const ORDERS_OPTIONAL_FIELDS = [
  'marketAcc',
  'marketAccDecoded',
  'placedAt',
  'placedTimestamp',
  'blockTimestamp',
  'eventIndex',
  'root',
  'placedTxHash',
  'tokenId',
  'tick',
  'placedSize',
  'unfilledSize',
  'impliedApr',
  'side',
  'status',
  'orderType',
] as const;

const ORDER_TYPE_LABELS: Record<number, string> = {
  0: 'LIMIT',
  1: 'MARKET',
  2: 'TAKE_PROFIT_MARKET',
  3: 'STOP_LOSS_MARKET',
};

function enrichOrder(
  order: any,
  marketMap: Map<number, MarketInfo>,
  assetMap: Map<number, AssetInfo>,
  includeSet: ReadonlySet<string>,
) {
  const mkt = marketMap.get(order.marketId);
  const {
    side, status, orderType,
    placedSize, unfilledSize, impliedApr,
    placedTimestamp, blockTimestamp,
  } = order;
  const resolvedTs = placedTimestamp ?? blockTimestamp;
  const orderTypeLabel = orderType !== undefined ? (ORDER_TYPE_LABELS[orderType] ?? 'unknown') : undefined;
  const full = {
    ...order,
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
  return projectFields(full, includeSet);
}

export function registerAccountOrdersTools(server: McpServer) {
  server.registerTool(
    'get_orders',
    {
      annotations: { readOnlyHint: true },
      description: `List a user's orders (LIMIT, MARKET, TAKE_PROFIT_MARKET, STOP_LOSS_MARKET). Two sort modes:

\`sort:'updated'\` (default): newest by last-updated event index — supports filtering by \`marketId\` and \`isActive\`. Paginating mid-stream can miss/duplicate orders that were updated between pages. Default \`isActive:true\` returns only currently-open orders (typically resting LIMIT / TP / SL). Use this for "open orders" / "pending orders" queries.

\`sort:'placed'\`: newest by placed event index (immutable cursor) — guarantees no orders missed when fully enumerating, but ignores the \`marketId\` and \`isActive\` filters. Higher \`limit\` cap (2000 vs 100). Use when you need the complete history.

To cancel a returned order, pass its \`orderId\` (not \`placedTxHash\`) to \`cancel_orders\`.`,
      inputSchema: {
        userAddress: userAddressField(),
        accountId: accountIdField('Default 0 for main account.'),
        sort: z
          .enum(['updated', 'placed'])
          .default('updated')
          .describe('Sort: "updated" (default, supports marketId/isActive filters) or "placed" (immutable cursor, ignores filters).'),
        marketId: marketIdOptionalField('Filter by market ID. Honored only when sort="updated".'),
        isActive: z
          .boolean()
          .nullable()
          .default(true)
          .describe('Active status filter (sort="updated" only). Default true. Pass false for filled/cancelled, null to include every status.'),
        limit: paginationLimitField({ max: 50, defaultValue: 20, desc: 'Number of orders (max 50, default 20).' }),
        resumeToken: z
          .string()
          .optional()
          .describe('Cursor token from previous response.'),
        include: includeFieldSchema({
          defaults: ORDERS_DEFAULT_FIELDS,
          optional: ORDERS_OPTIONAL_FIELDS,
          noun: 'fields per order',
        }),
      },
    },
    withAuth(async ({ userAddress, accountId, sort, marketId, isActive, limit, resumeToken, include }) => {
      try {
        const includeSet = buildIncludeSet(include, ORDERS_DEFAULT_FIELDS, ORDERS_OPTIONAL_FIELDS);
        if (sort === 'placed') {
          const cappedLimit = Math.min(limit ?? 20, 2000);
          const res = await fetchWithRetry(() =>
            openApiGet('/v1/accounts/orders-by-placed-time', {
              root: userAddress,
              accountId: accountId ?? 0,
              limit: cappedLimit,
              ...(resumeToken ? { resumeToken } : {}),
            }),
          );
          const results = res.results ?? (Array.isArray(res) ? res : []);
          const [marketMap, assetMap] = await Promise.all([fetchMarketMap(), safeAssetMap()]);
          const orders = results.map((order: any) => enrichOrder(order, marketMap, assetMap, includeSet));
          return jsonResult({
            sort,
            count: orders.length,
            sizeUnit: 'YU',
            orders,
            ...(res.resumeToken ? { resumeToken: res.resumeToken } : {}),
            _context: {
              apr: APR_NOTE,
              sortOrder: 'Sorted by placed event index descending (immutable). Filters (marketId, isActive) are NOT applied in this mode.',
              resumeToken: 'Pass this value as resumeToken to fetch the next page. Absent when there are no more results.',
            },
          });
        }

        // sort === 'updated'
        const cappedLimit = Math.min(limit ?? 20, 100);
        const data = await fetchWithRetry(() =>
          openApiGet('/v1/accounts/orders', {
            root: userAddress,
            accountId: accountId ?? 0,
            ...(marketId !== undefined ? { marketId } : {}),
            ...(isActive !== null && isActive !== undefined ? { isActive } : {}),
            limit: cappedLimit,
            ...(resumeToken ? { resumeToken } : {}),
          }),
        );

        const results = data.results ?? (Array.isArray(data) ? data : []);
        const [marketMap, assetMap] = await Promise.all([fetchMarketMap(), safeAssetMap()]);

        const orders = results.map((order: any) => enrichOrder(order, marketMap, assetMap, includeSet));

        return jsonResult({
          sort,
          count: orders.length,
          sizeUnit: 'YU',
          orders,
          ...(data.resumeToken ? { resumeToken: data.resumeToken } : {}),
          _context: {
            apr: APR_NOTE,
            sortOrder: 'Sorted by last-updated eventIndex descending. Use sort="placed" for immutable enumeration.',
            cancellation: 'To cancel, pass `orderId` (not `placedTxHash`) to cancel_orders.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
