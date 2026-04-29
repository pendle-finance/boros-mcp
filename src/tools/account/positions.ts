import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Address } from 'viem';
import { openApiGet, openApiPost } from '../../api/open-api.js';
import { CROSS_MARKET_ID } from '../../config.js';
import { packMarketAcc, unpackMarketAcc } from '../../chain/pack-account.js';
import {
  jsonResult, enrichAprValue, formatSize, formatX18, decodeMarketAcc,
  formatApr18, sumBigStrings,
} from '../../utils.js';
import {
  userAddressField,
  userAddressFieldOptional,
  accountIdField,
  marketAccField,
  marketAccFieldOptional,
  tokenIdFieldOptional,
  marketIdField,
  makeFilterSchema,
  makeSortSchema,
} from '../_schemas.js';
import { applyFilters, applySort } from '../../lib/collections.js';
import { APR_NOTE, AMOUNTS_IN_COLLATERAL_NOTE } from '../_context.js';
import { buildIncludeSet, projectFields, includeFieldSchema } from '../_shared/projection.js';

import { safeAssetMap } from '../../api/asset-cache.js';
import { fetchMarketMap } from '../../api/market-cache.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';

export function registerAccountPositionsTools(server: McpServer) {
  const POSITIONS_DEFAULT_FIELDS = [
    'marketId',
    'marketName',
    'marketSymbol',
    'sideLabel',
    'signedSize',
    'cumulativePnl',
    'fixedAprPercent',
  ] as const;
  const POSITIONS_OPTIONAL_FIELDS = [
    'marketAcc',
    'marketAccDecoded',
    'fixedApr',
    'unrealisedPnl',
    'settlementPnl',
    'isMatured',
    'positionValue',
    'liquidationApr',
    'initialMargin',
    'maintMargin',
    'tokenId',
  ] as const;

  const POSITIONS_FILTER_FIELDS = [
    'marketId', 'marketName', 'marketSymbol', 'sideLabel',
    'signedSize', 'cumulativePnl', 'unrealisedPnl', 'fixedApr', 'tokenId',
  ] as const;
  const POSITIONS_SORT_FIELDS = [
    'marketId', 'signedSize', 'cumulativePnl', 'unrealisedPnl', 'fixedApr',
  ] as const;

  server.registerTool(
    'get_positions',
    {
      annotations: { readOnlyHint: true },
      description: 'List open positions (non-zero size) for an account from the indexer. Per row: market, direction (long/short), signed size in YU, entry fixedApr, all-time cumulative trade PnL (in the marketAcc collateral token), maturity flag, decoded marketAcc. Does NOT return unrealised PnL, mark/liquidation APR, or margin by default — use get_pnl_by_market for live PnL and get_collateral for margin/liquidation APR. cumulativePnl is shipped formatted via the 18-dec internal scaling.',
      inputSchema: {
        userAddress: userAddressField(),
        accountId: accountIdField('Default 0 for main account.'),
        include: includeFieldSchema({
          defaults: POSITIONS_DEFAULT_FIELDS,
          optional: POSITIONS_OPTIONAL_FIELDS,
          noun: 'fields per position',
        }),
        filter: z
          .array(makeFilterSchema(POSITIONS_FILTER_FIELDS))
          .optional()
          .describe('Filter conditions. Operates on the underlying record, regardless of `include` projection. Filter on raw `fixedApr` (decimal), not `fixedAprPercent` (string with `%` suffix).'),
        sort: makeSortSchema(POSITIONS_SORT_FIELDS).optional().describe('Sort criteria. Sortable fields are numeric only — sort on raw `fixedApr`, not `fixedAprPercent`.'),
      },
    },
    withAuth(async ({ userAddress, accountId, include, filter, sort }) => {
      try {
        const data = await fetchWithRetry(() =>
          openApiGet('/v1/accounts/active-positions', {
            root: userAddress,
            accountId: accountId ?? 0,
          }),
        );

        const positions = Array.isArray(data) ? data : (data.results ?? []);
        const [marketMap, assetMap] = await Promise.all([fetchMarketMap(), safeAssetMap()]);

        const includeSet = buildIncludeSet(include, POSITIONS_DEFAULT_FIELDS, POSITIONS_OPTIONAL_FIELDS);

        const fullRows = positions.map((p: any) => {
          const mkt = marketMap.get(p.marketId);
          const { side, signedSize, cumulativePnl, ...rest } = p;
          return {
            ...rest,
            ...(p.marketAcc ? { marketAccDecoded: decodeMarketAcc(p.marketAcc, assetMap) } : {}),
            ...(mkt?.name ? { marketName: mkt.name } : {}),
            ...(mkt?.symbol ? { marketSymbol: mkt.symbol } : {}),
            sideLabel: side === 0 ? 'long' : 'short',
            ...(p.fixedApr !== undefined ? { fixedAprPercent: enrichAprValue(p.fixedApr)?.aprPercent } : {}),
            ...(signedSize !== undefined ? { signedSize: formatSize(signedSize) } : {}),
            ...(cumulativePnl !== undefined ? { cumulativePnl: formatX18(cumulativePnl) } : {}),
          };
        });
        const totalBeforeFilter = fullRows.length;
        const filtered = applyFilters(fullRows, filter);
        const sorted = applySort(filtered, sort);
        const projected = sorted.map((f: any) => projectFields(f, includeSet));
        const filterApplied = filter !== undefined && filter.length > 0;

        return jsonResult({
          count: projected.length,
          ...(filterApplied ? { totalBeforeFilter } : {}),
          sizeUnit: 'YU',
          ...(data.syncStatus ? { syncStatus: data.syncStatus } : {}),
          positions: projected,
          _context: {
            apr: APR_NOTE,
            amounts: AMOUNTS_IN_COLLATERAL_NOTE,
            cumulativePnl: 'All-time realised trade PnL for this (marketAcc, marketId), not unrealised mark-to-market.',
            missing: 'For unrealised PnL: get_pnl_by_market. For margin / liquidation APR: get_collateral.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );

  // *Formatted fields are decimal strings post-formatX18 (already divided by 1e18) — safe for
  // Number() coercion at realistic-balance magnitudes.
  const COLLATERAL_FILTER_FIELDS = [
    'marketAcc', 'totalCashFormatted', 'netBalanceFormatted',
    'availableInitialMarginFormatted', 'availableMaintMarginFormatted',
  ] as const;
  const COLLATERAL_SORT_FIELDS = [
    'totalCashFormatted', 'netBalanceFormatted',
    'availableInitialMarginFormatted', 'availableMaintMarginFormatted',
  ] as const;

  server.registerTool(
    'get_collateral',
    {
      annotations: { readOnlyHint: true },
      description: 'Get per-marketAcc margin/equity (totalCash, netBalance, initialMargin, availableInitialMargin, availableMaintMargin, per-position margin/liquidationApr/orders) by POSTing /v1/accounts/market-acc-infos. When marketAccs is omitted, derives the list from active positions AND synthesizes the cross marketAcc for every known token — so a cross account with cash but no positions is still visible. Boros supports multi-asset collateral: each account entry carries its own marketAccDecoded.tokenSymbol (USDT, WETH, etc.) but all numeric *Formatted values are 18-dec normalized internal cash units (do NOT re-scale by token on-chain decimals). NOT a gas-balance view — for that use get_gas_info.',
      inputSchema: {
        userAddress: userAddressField(),
        accountId: accountIdField('Default 0 for main account.'),
        marketAccs: z
          .array(z.string())
          .optional()
          .describe('Specific marketAcc addresses to query. If omitted, derives from active positions + cross account.'),
        filter: z
          .array(makeFilterSchema(COLLATERAL_FILTER_FIELDS))
          .optional()
          .describe('Filter conditions. Sortable/filterable balance fields are `*Formatted` decimal strings; nested `positions[]` fields are not addressable.'),
        sort: makeSortSchema(COLLATERAL_SORT_FIELDS).optional().describe('Sort criteria.'),
      },
    },
    withAuth(async ({ userAddress, accountId, marketAccs, filter, sort }) => {
      try {
        // No marketAccs → derive from active positions AND synthesize cross marketAcc per known
        // tokenId so freshly-funded cross accounts (no positions yet) aren't reported as empty.
        let accs = marketAccs;
        if (!accs || accs.length === 0) {
          const [positions, assetMap] = await Promise.all([
            fetchWithRetry(() =>
              openApiGet('/v1/accounts/active-positions', {
                root: userAddress,
                accountId: accountId ?? 0,
              }),
            ),
            safeAssetMap(),
          ]);
          const posArray = Array.isArray(positions) ? positions : (positions.results ?? []);
          const fromPositions = new Set(posArray.map((p: any) => p.marketAcc).filter(Boolean) as string[]);
          // Include cross marketAcc per tokenId so cash-but-no-position accounts stay visible.
          for (const tokenId of assetMap.keys()) {
            try {
              fromPositions.add(packMarketAcc(userAddress as Address, accountId ?? 0, tokenId, CROSS_MARKET_ID));
            } catch { /* skip unpackable */ }
          }
          accs = [...fromPositions];

          if (accs.length === 0) {
            return jsonResult({
              message: 'Asset list unavailable and no active positions found. Pass marketAccs explicitly to query specific accounts.',
              accounts: [],
            });
          }
        } else {
          accs = [...new Set(accs)];
        }

        const res = await fetchWithRetry(() =>
          openApiPost('/v1/accounts/market-acc-infos', { marketAccs: accs }),
        );

        const rawAccounts = Array.isArray(res) ? res : (res.results ?? [res]);
        const assetMap = await safeAssetMap();
        // Drop raw 18d bigints — keep *Formatted/*Percent/*Label only.
        const enrichAccount = (acc: any) => {
          const {
            totalCash, netBalance, initialMargin, initialMarginWithLeverage,
            availableInitialMargin, availableMaintMargin, positions,
            ...rest
          } = acc;
          return {
            ...rest,
            ...(acc.marketAcc ? { marketAccDecoded: decodeMarketAcc(acc.marketAcc, assetMap) } : {}),
            ...(acc.totalCash !== undefined ? { totalCashFormatted: formatX18(acc.totalCash) } : {}),
            ...(acc.netBalance !== undefined ? { netBalanceFormatted: formatX18(acc.netBalance) } : {}),
            ...(acc.initialMargin !== undefined ? { initialMarginFormatted: formatX18(acc.initialMargin) } : {}),
            ...(acc.initialMarginWithLeverage !== undefined ? { initialMarginWithLeverageFormatted: formatX18(acc.initialMarginWithLeverage) } : {}),
            ...(acc.availableInitialMargin !== undefined ? { availableInitialMarginFormatted: formatX18(acc.availableInitialMargin) } : {}),
            ...(acc.availableMaintMargin !== undefined ? { availableMaintMarginFormatted: formatX18(acc.availableMaintMargin) } : {}),
            ...(Array.isArray(positions)
              ? {
                  positions: positions.map((p: any) => {
                    const {
                      positionValue, liquidationApr, initialMargin: pim,
                      initialMarginWithLeverage: pimwl, maintMargin,
                      signedSize, orders, ...prest
                    } = p;
                    return {
                      ...prest,
                      ...(Array.isArray(orders)
                        ? {
                            orders: orders.map((o: any) => {
                              const { size: osize, rate: orate, initialMarginWithLeverage: oimwl, ...orest } = o;
                              return {
                                ...orest,
                                ...(o.maker ? { makerDecoded: decodeMarketAcc(o.maker, assetMap) } : {}),
                                ...(o.size !== undefined ? { sizeFormatted: formatSize(o.size) } : {}),
                                ...(o.rate !== undefined ? { ratePercent: formatApr18(o.rate)?.aprPercent } : {}),
                                ...(o.initialMarginWithLeverage !== undefined ? { initialMarginWithLeverageFormatted: formatX18(o.initialMarginWithLeverage) } : {}),
                              };
                            }),
                          }
                        : {}),
                      ...(p.signedSize !== undefined ? { signedSizeFormatted: formatSize(p.signedSize) } : {}),
                      ...(p.positionValue !== undefined ? { positionValueFormatted: formatX18(p.positionValue) } : {}),
                      ...(p.liquidationApr !== undefined ? { liquidationAprPercent: formatApr18(p.liquidationApr)?.aprPercent } : {}),
                      ...(p.initialMargin !== undefined ? { initialMarginFormatted: formatX18(p.initialMargin) } : {}),
                      ...(p.initialMarginWithLeverage !== undefined ? { initialMarginWithLeverageFormatted: formatX18(p.initialMarginWithLeverage) } : {}),
                      ...(p.maintMargin !== undefined ? { maintMarginFormatted: formatX18(p.maintMargin) } : {}),
                    };
                  }),
                }
              : {}),
          };
        };

        const enriched = rawAccounts.map(enrichAccount);
        const totalBeforeFilter = enriched.length;
        const filtered = applyFilters(enriched, filter);
        const sorted = applySort(filtered, sort);
        const filterApplied = filter !== undefined && filter.length > 0;

        return jsonResult({
          count: sorted.length,
          ...(filterApplied ? { totalBeforeFilter } : {}),
          sizeUnit: 'YU',
          ...(res.syncStatus ? { syncStatus: res.syncStatus } : {}),
          accounts: sorted,
          _context: {
            apr: APR_NOTE,
            balances: AMOUNTS_IN_COLLATERAL_NOTE,
            tokenSymbol: 'marketAccDecoded.tokenSymbol identifies the underlying token but values are already 18-dec normalized.',
            gasBudget: 'For gas budget, call get_gas_info — collateral and gas are separate.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );

  const PNL_BY_MARKET_DEFAULT_FIELDS = [
    'marketAcc',
    'marketId',
    'marketName',
    'marketSymbol',
    'unrealisedPnl',
    'allTimeTradePnl',
    'allTimeSettlementPnl',
    'allTimePnl',
    'netPnl',
  ] as const;
  const PNL_BY_MARKET_OPTIONAL_FIELDS = [
    'marketAccDecoded',
    'syncStatus',
  ] as const;

  server.registerTool(
    'get_pnl_by_market',
    {
      annotations: { readOnlyHint: true },
      description: 'Get a snapshot of per-market PnL for a (marketAcc, marketId) position: live unrealisedPnl + all-time realised trade PnL (allTimeTradePnl, NET of fees) + all-time funding-rate settlement PnL (allTimeSettlementPnl), plus derived allTimePnl (trade+settlement) and netPnl (trade+settlement+unrealised). Backed by GET /v1/accounts/active-positions — the standalone /pnl-by-market endpoint was deprecated. The since-open breakdown is no longer surfaced (only all-time + unrealised). For cross marketAcc, marketId picks which market to summarise; for isolated marketAcc, marketId must equal the marketAcc embedded marketId. For per-settlement records over time use get_pnl_history; for the position list use get_positions.',
      inputSchema: {
        marketAcc: marketAccField(),
        marketId: marketIdField('Market to summarise PnL for. For isolated marketAcc this must equal the marketAcc embedded marketId.'),
        include: includeFieldSchema({
          defaults: PNL_BY_MARKET_DEFAULT_FIELDS,
          optional: PNL_BY_MARKET_OPTIONAL_FIELDS,
        }),
      },
    },
    withAuth(async ({ marketAcc, marketId, include }) => {
      try {
        const { root, accountId } = unpackMarketAcc(marketAcc);
        const res = await fetchWithRetry(() =>
          openApiGet('/v1/accounts/active-positions', { root, accountId }),
        );
        const positions = Array.isArray(res) ? res : (res.results ?? []);
        // Match by (marketAcc, marketId) — cross returns positions across markets; isolated returns one.
        const lowerAcc = marketAcc.toLowerCase();
        const match = positions.find(
          (p: any) => p.marketAcc?.toLowerCase() === lowerAcc && p.marketId === marketId,
        );
        if (!match) {
          return jsonResult({
            marketAcc,
            marketId,
            message: `No active position found for marketAcc ${marketAcc} on market ${marketId}. Position may be flat or closed; only open positions are surfaced by the V2 endpoint.`,
          });
        }
        const [marketMap, assetMap] = await Promise.all([fetchMarketMap(), safeAssetMap()]);
        const mkt = marketMap.get(marketId);

        const allTimeTradePnl = match.cumulativePnl;
        const allTimeSettlementPnl = match.settlementPnl;
        const unrealisedPnl = match.unrealisedPnl;
        const allTimePnlRaw = sumBigStrings(allTimeTradePnl, allTimeSettlementPnl);
        const netPnlRaw = sumBigStrings(allTimeTradePnl, allTimeSettlementPnl, unrealisedPnl);

        const includeSet = buildIncludeSet(
          include,
          PNL_BY_MARKET_DEFAULT_FIELDS,
          PNL_BY_MARKET_OPTIONAL_FIELDS,
        );
        const fullPnl = {
          marketAcc,
          marketAccDecoded: decodeMarketAcc(marketAcc, assetMap),
          marketId,
          ...(mkt?.name ? { marketName: mkt.name } : {}),
          ...(mkt?.symbol ? { marketSymbol: mkt.symbol } : {}),
          ...(unrealisedPnl !== undefined ? { unrealisedPnl: formatX18(unrealisedPnl) } : {}),
          ...(allTimeTradePnl !== undefined ? { allTimeTradePnl: formatX18(allTimeTradePnl) } : {}),
          ...(allTimeSettlementPnl !== undefined ? { allTimeSettlementPnl: formatX18(allTimeSettlementPnl) } : {}),
          ...(allTimePnlRaw !== undefined ? { allTimePnl: formatX18(allTimePnlRaw) } : {}),
          ...(netPnlRaw !== undefined ? { netPnl: formatX18(netPnlRaw) } : {}),
          ...(res.syncStatus ? { syncStatus: res.syncStatus } : {}),
        };
        return jsonResult({
          ...projectFields(fullPnl, includeSet),
          _context: {
            amounts: AMOUNTS_IN_COLLATERAL_NOTE,
            unrealisedPnl: 'Live on-chain mark-to-market PnL of the current open position. Zero when the position is flat.',
            allTimeTradePnl: 'Lifetime realised trade PnL for this (marketAcc, marketId), net of taker/maker fees. Persists across close/reopen cycles.',
            allTimeSettlementPnl: 'Lifetime cumulative funding-rate settlement PnL for this (marketAcc, marketId).',
            allTimePnl: 'Derived: allTimeTradePnl + allTimeSettlementPnl.',
            netPnl: 'Derived: allTimeTradePnl + allTimeSettlementPnl + unrealisedPnl.',
            sinceOpenNote: 'The V2 endpoint no longer exposes since-open breakdowns; only all-time + unrealised are returned.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );

  const ENTERED_MARKETS_FILTER_FIELDS = ['marketId', 'marketName', 'marketSymbol'] as const;
  const ENTERED_MARKETS_SORT_FIELDS = ['marketId'] as const;

  server.registerTool(
    'get_entered_markets',
    {
      annotations: { readOnlyHint: true },
      description: 'Get the list of markets a cross margin account has entered. Only applicable to cross accounts — entering a market is required before trading on it under cross margin (entry can also happen implicitly inside place_order via the `enterMarket` flag, paying a small fee). Isolated accounts do not use this concept. Pass the cross marketAcc directly, OR pass userAddress + accountId + tokenId to have it packed for you. Note: a market can be `entered` while position size is 0 — exit via enter_exit_markets requires zero position AND zero open limit orders. Matured markets cannot be exited at all today (the calldata-builder rejects them with "Market X is expired"); they remain permanently in the entered list until the protocol changes that path.',
      inputSchema: {
        marketAcc: marketAccFieldOptional('Either pass this OR (userAddress + accountId + tokenId).'),
        userAddress: userAddressFieldOptional('Used with accountId + tokenId to pack a cross marketAcc when marketAcc is omitted.'),
        accountId: accountIdField('Used only when marketAcc is omitted.'),
        tokenId: tokenIdFieldOptional('Used only when marketAcc is omitted.'),
        filter: z
          .array(makeFilterSchema(ENTERED_MARKETS_FILTER_FIELDS))
          .optional()
          .describe('Filter conditions. Operates on the underlying record, regardless of projection.'),
        sort: makeSortSchema(ENTERED_MARKETS_SORT_FIELDS).optional().describe('Sort criteria.'),
      },
    },
    withAuth(async ({ marketAcc, userAddress, accountId, tokenId, filter, sort }) => {
      try {
        let resolvedMarketAcc = marketAcc;
        if (!resolvedMarketAcc) {
          if (!userAddress || tokenId === undefined) {
            return errorContent(
              BorosErrorCode.INVALID_PARAMS,
              'Provide either marketAcc, or (userAddress + tokenId).',
            );
          }
          resolvedMarketAcc = packMarketAcc(userAddress as Address, accountId ?? 0, tokenId, CROSS_MARKET_ID);
        }

        const res = await fetchWithRetry(() =>
          openApiGet('/v1/accounts/entered-markets', { marketAcc: resolvedMarketAcc }),
        );
        const results = res.results ?? [];
        const [marketMap, assetMap] = await Promise.all([fetchMarketMap(), safeAssetMap()]);
        const fullRows = results.map((r: any) => {
          const mkt = marketMap.get(r.marketId);
          return {
            ...r,
            ...(mkt?.name ? { marketName: mkt.name } : {}),
            ...(mkt?.symbol ? { marketSymbol: mkt.symbol } : {}),
          };
        });
        const totalBeforeFilter = fullRows.length;
        const filtered = applyFilters(fullRows, filter);
        const sorted = applySort(filtered, sort);
        const liveCount = sorted.filter((r: any) => !r.isMatured).length;
        const maturedCount = sorted.length - liveCount;
        const filterApplied = filter !== undefined && filter.length > 0;

        return jsonResult({
          marketAcc: resolvedMarketAcc,
          marketAccDecoded: decodeMarketAcc(resolvedMarketAcc, assetMap),
          count: sorted.length,
          ...(filterApplied ? { totalBeforeFilter } : {}),
          liveCount,
          maturedCount,
          enteredMarkets: sorted,
          _context: {
            isMatured: 'true → market reached maturity. The calldata-builder currently REJECTS exit on matured markets ("Market X is expired"), so they stay in the entered list until the protocol path is opened. false → exit requires zero position size AND zero open limit orders.',
            relatedTools: 'enter_exit_markets to enter or exit. get_positions for position size per market. get_limit_orders for open limit orders.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
