import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, formatX18, decodeMarketAcc, sumBigInts } from '../../utils.js';
import { unpackMarketAcc } from '../../chain/pack-account.js';
import { userAddressField, accountIdField } from '../_schemas.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { safeAssetMap } from '../../api/asset-cache.js';

export function registerPortfolioSummaryTools(server: McpServer): void {
  server.registerTool(
    'get_portfolio_summary',
    {
      annotations: { readOnlyHint: true },
      description: 'Aggregate portfolio snapshot for an account: per-collateral-token totals (collateral, equity, initial/available margin), open-position count, open-order count, margin utilization, and optionally unrealized PnL. Discovers EVERY funded sub-account under the root via /v1/accounts/market-acc-infos-by-root, so dust accounts (cash but no positions, cross or isolated) are included. Single read-only call that replaces fan-out over get_collateral + get_positions + get_pnl_by_market + get_orders. Use summaryByToken when summary.isCrossCollateral is true (positions in >1 token, e.g. WETH and USDT). Does NOT include the gas wallet (use get_gas_info).',
      inputSchema: {
        userAddress: userAddressField(),
        accountId: accountIdField('Default 0 for main account.'),
        includePnl: z.boolean().default(false).describe('If true, fetch per-(marketAcc,marketId) unrealized PnL (adds N parallel calls). Default false to keep the summary fast.'),
      },
    },
    async ({ userAddress, accountId, includePnl }) => {
      try {
        const wantAccountId = accountId ?? 0;
        const ORDER_PAGE_LIMIT = 100;
        const [positionsRes, accInfosRes, ordersRes, assetMap] = await Promise.all([
          fetchWithRetry(() =>
            openApiGet('/v1/accounts/active-positions', {
              root: userAddress,
              accountId: wantAccountId,
            }),
          ),
          fetchWithRetry(() =>
            openApiGet('/v1/accounts/market-acc-infos-by-root', { root: userAddress }),
          ),
          fetchWithRetry(() =>
            openApiGet('/v1/accounts/orders', {
              root: userAddress,
              accountId: wantAccountId,
              isActive: true,
              limit: ORDER_PAGE_LIMIT,
            }),
          ),
          safeAssetMap(),
        ]);

        const positions = Array.isArray(positionsRes) ? positionsRes : (positionsRes.results ?? []);
        const allAccounts: any[] = Array.isArray(accInfosRes)
          ? accInfosRes
          : (accInfosRes.results ?? []);
        const accounts: any[] = allAccounts.filter((a: any) => {
          if (!a?.marketAcc) return false;
          try { return unpackMarketAcc(a.marketAcc).accountId === wantAccountId; }
          catch { return false; }
        });

        // Group by collateral tokenSymbol so multi-collateral accounts (WETH+USDT) get a
        // per-token breakdown instead of a nonsensical cross-token sum. Aggregate as bigint
        // to avoid 18d precision loss.
        type Bucket = {
          totalCash: bigint;
          netBalance: bigint;
          initialMargin: bigint;
          availableInitialMargin: bigint;
        };
        const emptyBucket = (): Bucket => ({
          totalCash: 0n,
          netBalance: 0n,
          initialMargin: 0n,
          availableInitialMargin: 0n,
        });
        const byToken: Map<string, Bucket> = new Map();
        for (const a of accounts) {
          const decoded = a.marketAcc ? decodeMarketAcc(a.marketAcc, assetMap) : undefined;
          const sym = (decoded?.tokenSymbol as string | undefined) ?? 'UNKNOWN';
          const bucket = byToken.get(sym) ?? emptyBucket();
          bucket.totalCash += a.totalCash ? BigInt(a.totalCash) : 0n;
          bucket.netBalance += a.netBalance ? BigInt(a.netBalance) : 0n;
          bucket.initialMargin += a.initialMargin ? BigInt(a.initialMargin) : 0n;
          bucket.availableInitialMargin += a.availableInitialMargin ? BigInt(a.availableInitialMargin) : 0n;
          byToken.set(sym, bucket);
        }
        const collateralTokens = [...byToken.keys()];

        // Cross-token sums kept for back-compat; only meaningful for single-collateral accts.
        const totalCash = sumBigInts(accounts.map((a) => a.totalCash));
        const netBalance = sumBigInts(accounts.map((a) => a.netBalance));
        const initialMargin = sumBigInts(accounts.map((a) => a.initialMargin));
        const availableInitialMargin = sumBigInts(accounts.map((a) => a.availableInitialMargin));

        // marginUtil = initialMargin / netBalance, guarding zero/neg equity. Scale to 4dp percent
        // precision without losing bigint accuracy.
        let marginUtilizationPct: number | null = null;
        if (netBalance > 0n) {
          const scaled = Number((initialMargin * 10_000n) / netBalance);
          marginUtilizationPct = scaled / 100;
        }

        // DTO has no `total` field — report page length and flag lower-bound at page limit.
        const orderResults: any[] = ordersRes.results ?? (Array.isArray(ordersRes) ? ordersRes : []);
        const openOrderCount = orderResults.length;
        const openOrderCountIsLowerBound = orderResults.length >= ORDER_PAGE_LIMIT;

        // V2 active-positions embeds unrealisedPnl per position — free local rollup, no extra calls.
        let unrealizedPnl: bigint | undefined;
        let pnlBreakdown: any[] | undefined;
        if (includePnl && positions.length) {
          const seen = new Set<string>();
          const entries: any[] = [];
          for (const p of positions) {
            if (!p.marketAcc || p.marketId === undefined) continue;
            const key = `${p.marketAcc}:${p.marketId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push({
              marketAcc: p.marketAcc,
              marketId: p.marketId,
              unrealisedPnl: p.unrealisedPnl,
            });
          }
          unrealizedPnl = sumBigInts(entries.map((r) => r.unrealisedPnl));
          pnlBreakdown = entries.map((r) => ({
            marketAcc: r.marketAcc,
            marketId: r.marketId,
            unrealisedPnl: formatX18(r.unrealisedPnl),
          }));
        }

        // Formatted-only view; use get_collateral for contract precision.
        const accountsEnriched = accounts.map((a: any) => ({
          marketAcc: a.marketAcc,
          ...(a.marketAcc ? { marketAccDecoded: decodeMarketAcc(a.marketAcc, assetMap) } : {}),
          totalCash: formatX18(a.totalCash),
          netBalance: formatX18(a.netBalance),
          initialMargin: formatX18(a.initialMargin),
          availableInitialMargin: formatX18(a.availableInitialMargin),
          positionCount: Array.isArray(a.positions) ? a.positions.length : 0,
        }));

        const summary: Record<string, unknown> = {
          totalCollateral: formatX18(totalCash.toString()),
          netBalance: formatX18(netBalance.toString()),
          initialMargin: formatX18(initialMargin.toString()),
          availableMargin: formatX18(availableInitialMargin.toString()),
          openPositionCount: positions.length,
          openOrderCount,
          openOrderCountIsLowerBound,
          marginUtilizationPct,
          collateralTokens,
          isCrossCollateral: collateralTokens.filter((s) => s !== 'UNKNOWN').length > 1,
        };
        if (unrealizedPnl !== undefined) {
          summary.unrealizedPnl = formatX18(unrealizedPnl.toString());
        }

        const summaryByToken: Record<string, unknown> = {};
        for (const [sym, b] of byToken) {
          summaryByToken[sym] = {
            totalCollateral: formatX18(b.totalCash.toString()),
            netBalance: formatX18(b.netBalance.toString()),
            initialMargin: formatX18(b.initialMargin.toString()),
            availableMargin: formatX18(b.availableInitialMargin.toString()),
          };
        }

        return jsonResult({
          ok: true,
          userAddress,
          accountId: accountId ?? 0,
          summary,
          summaryByToken,
          accounts: accountsEnriched,
          ...(pnlBreakdown ? { pnlBreakdown } : {}),
          _context: {
            summary: 'Cross-collateral sums of 18-dec FixedX18 raw values. Only meaningful when summary.isCrossCollateral is false (single collateral token). When true, READ summaryByToken — adding e.g. WETH + USDT amounts is not meaningful.',
            summaryByToken: 'Per-collateral-token aggregation (keyed by token symbol). Use this whenever the account holds positions in more than one collateral.',
            marginUtilizationPct: 'initialMargin / netBalance expressed as percent (0–100+). null when netBalance <= 0. Computed across all marketAccs combined; meaningful only for single-collateral accounts.',
            openOrderCount: `Open limit orders across all markets. Based on a single page query (limit=${ORDER_PAGE_LIMIT}); when openOrderCountIsLowerBound is true, paginate get_orders with sort:"placed" for the exact count.`,
            gasWalletNote: 'Does NOT include the gas wallet (ETH for tx fees) — use get_gas_info.',
            ...(includePnl
              ? { unrealizedPnl: 'Sum of unrealisedPnl across each active (marketAcc, marketId). Sourced from /v1/accounts/active-positions — no extra requests.' }
              : { note: 'Call with includePnl:true to include aggregated unrealized PnL (no extra cost in V2 — read straight off active-positions).' }),
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
