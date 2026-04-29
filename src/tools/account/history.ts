import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Address } from 'viem';
import { openApiGet } from '../../api/open-api.js';
import { CROSS_MARKET_ID } from '../../config.js';
import { packMarketAcc } from '../../chain/pack-account.js';
import {
  jsonResult, enrichAprValue, enrichTimestamp, formatSize, formatX18, asX18,
} from '../../utils.js';
import {
  userAddressField,
  tokenIdFieldOptional,
  marketIdOptionalField,
  paginationLimitField,
} from '../_schemas.js';
import { APR_NOTE, AMOUNTS_IN_COLLATERAL_NOTE } from '../_context.js';

import { safeAssetMap } from '../../api/asset-cache.js';
import { fetchMarketMap } from '../../api/market-cache.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';
import { buildIncludeSet, projectFields, includeFieldSchema } from '../_shared/projection.js';

const PNL_HISTORY_DEFAULT_FIELDS = [
  'marketId',
  'marketName',
  'marketSymbol',
  'sideLabel',
  'settledAt',
  'settlementRatePercent',
  'positionSize',
  'settlement',
  'cumulativeSettlementPnl',
] as const;
const PNL_HISTORY_OPTIONAL_FIELDS = [
  'marketAcc',
  'positionValue',
  'yieldPaid',
  'yieldReceived',
  'fee',
  'sinceOpenSettlementPnl',
  'settlementRate',
  'side',
  'timestamp',
  'eventIndex',
  'txHash',
  'tokenId',
] as const;

const TX_HISTORY_DEFAULT_FIELDS = [
  'marketId',
  'marketName',
  'marketSymbol',
  'sideLabel',
  'tradedAt',
  'tradeRatePercent',
  'tradeSize',
  'tradeValue',
  'pnl',
  'fee',
] as const;
const TX_HISTORY_OPTIONAL_FIELDS = [
  'marketAcc',
  'txHash',
  'eventIndex',
  'timestamp',
  'tradeRate',
  'side',
  'orderId',
  'positionPreSize',
  'positionPostSize',
  'positionPreSignedSize',
  'positionPostSignedSize',
] as const;

const TRANSFER_LOG_DEFAULT_FIELDS = [
  'at',
  'transferType',
  'amount',
  'amountSymbol',
  'status',
  'fromType',
  'toType',
] as const;
const TRANSFER_LOG_OPTIONAL_FIELDS = [
  'tokenId',
  'fromMarketId',
  'toMarketId',
  'eventIndex',
  'txHash',
  'blockTimestamp',
  'requestId',
  'cooldownEnd',
  'cooldownEndIso',
] as const;

export function registerAccountHistoryTools(server: McpServer) {
  server.registerTool(
    'get_pnl_history',
    {
      annotations: { readOnlyHint: true },
      description: 'Get funding-rate SETTLEMENT history (one row per periodic funding payment) — NOT a combined PnL series. Each record carries yieldPaid, yieldReceived, fee, the net settlement (yieldReceived - yieldPaid - fee), the position side/size/value at settlement time, and both all-time (cumulativeSettlementPnl) and since-open (sinceOpenSettlementPnl) cumulative settlement PnL. Note: cumulativeSettlementPnl excludes per-row fee while per-row `settlement` subtracts it — they will not reconcile by exact sum. Does NOT include realized trade PnL — use get_transaction_history for per-trade PnL, or get_pnl_by_market for a combined per-market summary. All amounts are 18-dec normalized human strings (Boros internal cash unit, NOT raw token decimals).',
      inputSchema: {
        userAddress: userAddressField(),
        accountId: z
          .number()
          .default(0)
          .describe('Account ID (default 0 for main account)'),
        marketId: marketIdOptionalField('Filter by market ID.'),
        limit: paginationLimitField({ max: 50, defaultValue: 20, desc: 'Number of settlement records to return (max 50, default 20).' }),
        resumeToken: z
          .string()
          .optional()
          .describe('Cursor token from previous response for next page.'),
        include: includeFieldSchema({
          defaults: PNL_HISTORY_DEFAULT_FIELDS,
          optional: PNL_HISTORY_OPTIONAL_FIELDS,
          noun: 'fields per settlement record',
        }),
      },
    },
    withAuth(async ({ userAddress, accountId, marketId, limit, resumeToken, include }) => {
      try {
        const data = await fetchWithRetry(() =>
          openApiGet('/v1/accounts/settlement-events', {
            root: userAddress,
            accountId: accountId ?? 0,
            ...(marketId !== undefined ? { marketId } : {}),
            limit: limit ?? 20,
            ...(resumeToken ? { resumeToken } : {}),
          }),
        );

        const results = data.results ?? (Array.isArray(data) ? data : []);
        const marketMap = await fetchMarketMap();
        // Single-market: hoist marketName/Symbol to top, drop per-row. Multi: per-row.
        const singleMarket = marketId !== undefined;
        const topMkt = singleMarket ? marketMap.get(marketId!) : undefined;
        const includeSet = buildIncludeSet(include, PNL_HISTORY_DEFAULT_FIELDS, PNL_HISTORY_OPTIONAL_FIELDS);
        const settlements = results.map((s: any) => {
          const mkt = marketMap.get(s.marketId);
          const {
            side, positionSize, positionValue, yieldPaid, yieldReceived, fee, settlement,
            cumulativeSettlementPnl, sinceOpenSettlementPnl,
          } = s;
          const full = {
            ...s,
            ...(!singleMarket
              ? {
                  ...(mkt?.name ? { marketName: mkt.name } : {}),
                  ...(mkt?.symbol ? { marketSymbol: mkt.symbol } : {}),
                }
              : {}),
            sideLabel: side === 0 ? 'long' : side === 1 ? 'short' : undefined,
            settledAt: enrichTimestamp(s.timestamp),
            ...(s.settlementRate !== undefined ? { settlementRatePercent: enrichAprValue(s.settlementRate)?.aprPercent } : {}),
            ...(positionSize !== undefined ? { positionSize: formatSize(positionSize) } : {}),
            ...(positionValue !== undefined ? { positionValue: formatX18(positionValue) } : {}),
            ...(yieldPaid !== undefined ? { yieldPaid: formatX18(yieldPaid) } : {}),
            ...(yieldReceived !== undefined ? { yieldReceived: formatX18(yieldReceived) } : {}),
            ...(fee !== undefined ? { fee: formatX18(fee) } : {}),
            ...(settlement !== undefined ? { settlement: formatX18(settlement) } : {}),
            ...(cumulativeSettlementPnl !== undefined ? { cumulativeSettlementPnl: formatX18(cumulativeSettlementPnl) } : {}),
            ...(sinceOpenSettlementPnl !== undefined ? { sinceOpenSettlementPnl: formatX18(sinceOpenSettlementPnl) } : {}),
          };
          return projectFields(full, includeSet);
        });

        return jsonResult({
          ...(singleMarket
            ? {
                marketId,
                ...(topMkt?.name ? { marketName: topMkt.name } : {}),
                ...(topMkt?.symbol ? { marketSymbol: topMkt.symbol } : {}),
              }
            : {}),
          positionSizeUnit: 'YU',
          count: settlements.length,
          settlements,
          ...(data.resumeToken ? { resumeToken: data.resumeToken } : {}),
          ...(data.syncStatus ? { syncStatus: data.syncStatus } : {}),
          _context: {
            apr: APR_NOTE,
            amounts: AMOUNTS_IN_COLLATERAL_NOTE,
            cumulativeSettlementPnl: 'Excludes per-row `fee`. Sum of per-row `settlement` will differ by Σ fee.',
            sinceOpenSettlementPnl: '0 when the latest settlement predates the current open. Resets each time the position is reopened; cumulativeSettlementPnl persists.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );

  server.registerTool(
    'get_transaction_history',
    {
      annotations: { readOnlyHint: true },
      description: `Get historical trading FILLS (one record per fill: tradeSize, tradeRate, tradeValue, fee, realized pnl, txHash, pre/post position). Backed by GET /v1/accounts/position-update-events (requires marketAcc + marketId per request). Sorted newest-first by eventIndex. Behaviour: pass marketId to query that market (even if the position is closed or matured) — resumeToken pagination is only supported in single-market mode. Omit marketId and this tool iterates the user's ACTIVE positions only — closed markets are silently missing, so always pass marketId for historical/closed markets. Use cases this is NOT for: deposits/withdrawals (get_transfer_logs), funding settlements (get_pnl_history), order place/cancel events (get_on_chain_events), liquidation labels (get_liquidation_events). The V2 endpoint does not return txType/entryApr/pnlPercentage — liquidation fills are indistinguishable from normal fills here. All amount fields are 18-dec normalized human strings (Boros internal cash unit).`,
      inputSchema: {
        userAddress: userAddressField(),
        accountId: z
          .number()
          .default(0)
          .describe('Account ID (default 0 for main account)'),
        marketId: marketIdOptionalField('Filter by market ID. If omitted, queries all markets with active positions (no pagination across closed markets).'),
        marginMode: z
          .enum(['cross', 'isolated'])
          .default('cross')
          .describe('Margin mode (default cross). Only used when marketId is set.'),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe('Number of transactions per market (max 50, default 20).'),
        resumeToken: z
          .string()
          .optional()
          .describe('Cursor token from previous response (single-market mode only).'),
        include: includeFieldSchema({
          defaults: TX_HISTORY_DEFAULT_FIELDS,
          optional: TX_HISTORY_OPTIONAL_FIELDS,
          noun: 'fields per fill',
        }),
      },
    },
    withAuth(async ({ userAddress, accountId, marketId, marginMode, limit, resumeToken, include }) => {
      try {
        const marketMap = await fetchMarketMap();

        let queries: { marketAcc: string; marketId: number }[] = [];

        if (marketId !== undefined) {
          const mkt = marketMap.get(marketId);
          const tokenId = mkt?.tokenId ?? 0;
          const effectiveMarketId = marginMode === 'cross' ? CROSS_MARKET_ID : marketId;
          const marketAcc = packMarketAcc(userAddress as Address, accountId ?? 0, tokenId, effectiveMarketId);
          queries = [{ marketAcc, marketId }];
        } else {
          const positions = await fetchWithRetry(() =>
            openApiGet('/v1/accounts/active-positions', {
              root: userAddress,
              accountId: accountId ?? 0,
            }),
          );
          const posArray = Array.isArray(positions) ? positions : (positions.results ?? []);
          // Dedup by (marketAcc, marketId) — cross accts share marketAcc across many markets, so
          // marketAcc-only dedup would silently drop all but the first market.
          const seen = new Set<string>();
          for (const p of posArray) {
            if (p.marketAcc && p.marketId !== undefined) {
              const key = `${p.marketAcc}:${p.marketId}`;
              if (seen.has(key)) continue;
              seen.add(key);
              queries.push({ marketAcc: p.marketAcc, marketId: p.marketId });
            }
          }
          if (queries.length === 0) {
            return jsonResult({
              count: 0,
              transactions: [],
              message: 'No active positions found. Provide a marketId to query a specific market.',
            });
          }
        }

        // Single market: hoist marketName/Symbol + forward resumeToken. Multi: per-row + ignore
        // resumeToken (ambiguous across markets).
        const singleMarket = marketId !== undefined;
        const topMkt = singleMarket ? marketMap.get(marketId!) : undefined;
        const allTransactions: any[] = [];
        let nextResumeToken: string | undefined;
        for (const q of queries) {
          const data = await fetchWithRetry(() =>
            openApiGet('/v1/accounts/position-update-events', {
              marketAcc: q.marketAcc,
              marketId: q.marketId,
              limit: limit ?? 20,
              ...(singleMarket && resumeToken ? { resumeToken } : {}),
            }),
          );
          const results = data.results ?? (Array.isArray(data) ? data : []);
          if (singleMarket) nextResumeToken = data.resumeToken;
          const includeSet = buildIncludeSet(include, TX_HISTORY_DEFAULT_FIELDS, TX_HISTORY_OPTIONAL_FIELDS);
          for (const tx of results) {
            const mkt = marketMap.get(tx.marketId ?? q.marketId);
            const { side, tradeSize, tradeValue, fee, pnl } = tx;
            const full = {
              ...tx,
              ...(!singleMarket
                ? {
                    ...(mkt?.name ? { marketName: mkt.name } : {}),
                    ...(mkt?.symbol ? { marketSymbol: mkt.symbol } : {}),
                  }
                : {}),
              ...(tx.timestamp !== undefined ? { tradedAt: enrichTimestamp(tx.timestamp) } : {}),
              sideLabel: side === 0 ? 'long' : 'short',
              ...(tx.tradeRate !== undefined ? { tradeRatePercent: enrichAprValue(tx.tradeRate)?.aprPercent } : {}),
              ...(tradeSize !== undefined ? { tradeSize: formatSize(tradeSize) } : {}),
              ...(tradeValue !== undefined ? { tradeValue: formatX18(tradeValue) } : {}),
              ...(fee !== undefined ? { fee: formatX18(fee) } : {}),
              ...(pnl !== undefined ? { pnl: formatX18(pnl) } : {}),
            };
            allTransactions.push(projectFields(full, includeSet));
          }
        }

        return jsonResult({
          ...(singleMarket
            ? {
                marketId,
                ...(topMkt?.name ? { marketName: topMkt.name } : {}),
                ...(topMkt?.symbol ? { marketSymbol: topMkt.symbol } : {}),
              }
            : {}),
          tradeSizeUnit: 'YU',
          count: allTransactions.length,
          transactions: allTransactions,
          ...(singleMarket && nextResumeToken ? { resumeToken: nextResumeToken } : {}),
          _context: {
            apr: APR_NOTE,
            amounts: AMOUNTS_IN_COLLATERAL_NOTE,
            sortOrder: 'newest-first by eventIndex.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );

  server.registerTool(
    'get_transfer_logs',
    {
      annotations: { readOnlyHint: true },
      description: 'Boros internal collateral ledger — vault deposits/withdrawals, cross↔isolated transfers, isolated↔isolated transfers, and AMM↔cross (vault deposit/withdraw) cash moves. NOT ERC-20 Transfer events. Withdrawals appear as `pending` during cooldown and flip to `success` on finalisation (or `failed` on cancel). Direction is encoded by fromType→toType — `amount` is always non-negative. tokenId filter can be derived from get_assets. Use get_transaction_history for trade fills, get_pnl_history for funding settlements, get_gas_info(scope:"history") for gas budget movements.',
      inputSchema: {
        userAddress: userAddressField(),
        accountId: z
          .number()
          .default(0)
          .describe('Account ID (default 0 for main account)'),
        tokenId: tokenIdFieldOptional('Filter by collateral token.'),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe('Number of records to return (max 50)'),
        resumeToken: z
          .string()
          .optional()
          .describe('Cursor token from previous response for next page'),
        include: includeFieldSchema({
          defaults: TRANSFER_LOG_DEFAULT_FIELDS,
          optional: TRANSFER_LOG_OPTIONAL_FIELDS,
          noun: 'fields per transfer log',
        }),
      },
    },
    withAuth(async ({ userAddress, accountId, tokenId, limit, resumeToken, include }) => {
      try {
        const data = await fetchWithRetry(() =>
          openApiGet('/v1/accounts/transfer-logs', {
            root: userAddress,
            accountId: accountId ?? 0,
            limit: limit ?? 20,
            ...(tokenId !== undefined ? { tokenId } : {}),
            ...(resumeToken ? { resumeToken } : {}),
          }),
        );

        const results = data.results ?? (Array.isArray(data) ? data : []);
        const assetMap = await safeAssetMap();
        const deriveTransferType = (from?: string, to?: string): string | undefined => {
          if (!from || !to) return undefined;
          if (from === 'wallet' && (to === 'cross_account' || to === 'isolated_account')) return 'deposit';
          if ((from === 'cross_account' || from === 'isolated_account') && to === 'wallet') return 'withdraw';
          if (from === 'cross_account' && to === 'isolated_account') return 'cross_to_isolated';
          if (from === 'isolated_account' && to === 'cross_account') return 'isolated_to_cross';
          if (from === 'isolated_account' && to === 'isolated_account') return 'isolated_to_isolated';
          if (from === 'cross_account' && to === 'amm') return 'vault_deposit';
          if (from === 'amm' && to === 'cross_account') return 'vault_withdraw';
          return `${from}_to_${to}`;
        };
        const includeSet = buildIncludeSet(include, TRANSFER_LOG_DEFAULT_FIELDS, TRANSFER_LOG_OPTIONAL_FIELDS);
        const logs = results.map((log: any) => {
          const asset = log.tokenId !== undefined ? assetMap.get(log.tokenId) : undefined;
          const symbol = asset?.symbol;
          // Wire `amount` is FixedX18 regardless of native ERC-20 decimals; asX18 brand keeps the
          // type system from accepting rawToHuman(amount, asset.decimals).
          const { amount } = log;
          const fromType = log.fromFundLocation?.fundType;
          const toType = log.toFundLocation?.fundType;
          const full = {
            ...log,
            ...(log.blockTimestamp ? { at: enrichTimestamp(log.blockTimestamp) } : {}),
            ...(amount !== undefined && amount !== null ? { amount: formatX18(asX18(amount)) } : {}),
            ...(symbol ? { amountSymbol: symbol } : {}),
            fromType,
            toType,
            ...(deriveTransferType(fromType, toType) ? { transferType: deriveTransferType(fromType, toType) } : {}),
            ...(log.fromFundLocation?.marketId !== undefined ? { fromMarketId: log.fromFundLocation.marketId } : {}),
            ...(log.toFundLocation?.marketId !== undefined ? { toMarketId: log.toFundLocation.marketId } : {}),
          };
          return projectFields(full, includeSet);
        });

        return jsonResult({
          count: logs.length,
          transferLogs: logs,
          ...(data.resumeToken ? { resumeToken: data.resumeToken } : {}),
          ...(data.syncStatus ? { syncStatus: data.syncStatus } : {}),
          _context: {
            fundTypes: 'wallet, cross_account, isolated_account, amm',
            status: 'pending (withdrawal cooldown), success, or failed (e.g. cancelled withdrawal)',
            amount: '18-dec normalized human string (Boros internal cash unit). amountSymbol identifies the underlying token but the value is NOT in token-native decimals.',
            transferType: 'Derived label: deposit, withdraw, cross_to_isolated, isolated_to_cross, isolated_to_isolated, vault_deposit (cross→amm), vault_withdraw (amm→cross).',
            resumeToken: 'Pass this value as resumeToken to fetch the next page. Absent when there are no more results.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
