import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiGet, openApiPost } from '../../api/open-api.js';
import { type IntentExpectation } from '../../agent/signing.js';
import { ROUTER_SELECTORS } from '../../chain/selectors.js';
import { jsonResult } from '../../utils.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import {
  executeAgentAction,
  extractCalldatas,
  extractTxHash,
  executionErrorContent,
} from './_execute.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { dedupTtl } from '../../lib/dedup.js';
import { withAuth } from '../_with-auth.js';
import { marketIdField, marginModeField } from '../_schemas.js';

export function registerMarketsTools(server: McpServer) {
  server.registerTool(
    'enter_exit_markets',
    {
      annotations: { destructiveHint: true },
      description: 'Enter or exit markets. Entering a market allows trading on it under the chosen margin mode. Exiting requires zero position size AND zero open limit orders in that same bucket. Markets flagged `isIsolatedOnly:true` by get_markets REQUIRE marginMode:"isolated" — a cross entry on one of those still succeeds and still charges the entry fee, but the account can never place an order there. Isolated enter/exit targets exactly ONE marketId per call (backend rule); call again per market. NOTE: entering a market draws a one-time per-market entrance fee in collateral, on top of the off-chain gas budget. It is small but NOT uniform across collaterals — measured ~$0.05 on WBTC and WETH markets and $0.10 on USD₮0 — so read the real number from a simulation `feeBreakdown.marketEntranceFee` rather than assuming one. SEPARATELY, a thinly funded account is rejected by the backend simulation with "Top up at least ~$10 to trade"; that ~$10 is a minimum-to-trade floor, NOT the entrance fee. If you hit it, deposit more collateral.',
      inputSchema: {
        action: z.enum(['enter', 'exit']).describe('Whether to enter or exit the markets'),
        marginMode: marginModeField('MUST be "isolated" for isolated-only markets, and then marketIds must hold exactly one id.'),
        marketIds: z.array(marketIdField()).min(1, 'marketIds must contain at least one market ID').max(100, 'marketIds accepts at most 100 market IDs').describe('Array of market IDs to enter or exit (1..100; exactly 1 when marginMode is "isolated")'),
      },
    },
    withAuth(async ({ action, marginMode, marketIds }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        const isEnter = action === 'enter';
        const isCross = marginMode !== 'isolated';

        // Backend rule: "Isolated enter/exit must target exactly one marketId" (400). Check first so
        // we never pay gas — and never burn a per-market entry fee — on a request that cannot build.
        if (!isCross && marketIds.length !== 1) {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            `marginMode:'isolated' requires exactly one marketId (got ${marketIds.length}). Isolated buckets are per-market — call enter_exit_markets once per market.`,
          );
        }

        // Exit pre-check: contract requires signedSize==0 AND nOrders==0 (MarketHubEntry.exitMarket)
        // — fetch both positions + resting orders per marketId to avoid MMMarketExitDenied revert.
        // Matched on `isCross` too: cross and isolated are separate buckets with separate nOrders
        // counters, so a cross position must not block an isolated exit of the same marketId.
        if (!isEnter) {
          const positions = await fetchWithRetry(() =>
            openApiGet('/v1/accounts/active-positions', {
              root: rootAddress,
              accountId,
            }),
          );
          const posArray = Array.isArray(positions) ? positions : ((positions as any).results ?? []);
          const blockers: { marketId: number; signedSize?: string; openOrderCount?: number }[] = [];
          const blockerByMarket = new Map<number, { signedSize?: string; openOrderCount?: number }>();
          for (const p of posArray) {
            if (p.marketId !== undefined && marketIds.includes(p.marketId) && p.isCross === isCross) {
              let nonZero = true;
              try { nonZero = BigInt(p.signedSize ?? '0') !== 0n; } catch { /* keep */ }
              if (nonZero) {
                blockerByMarket.set(p.marketId, {
                  ...(blockerByMarket.get(p.marketId) ?? {}),
                  signedSize: String(p.signedSize ?? '?'),
                });
              }
            }
          }

          // Best-effort: lookup failure falls through to on-chain check, don't block on transient fetch error.
          await Promise.all(
            marketIds.map(async (mid) => {
              try {
                const data = await fetchWithRetry(() =>
                  openApiGet('/v1/accounts/orders', {
                    root: rootAddress,
                    accountId,
                    marketId: mid,
                    isActive: true,
                    limit: 50,
                  }),
                );
                // LimitOrdersV2Response is {results, resumeToken, syncStatus} — no `total`. The
                // endpoint has no isCross filter, so page a chunk and match the bucket locally.
                const total = (Array.isArray(data?.results) ? data.results : []).filter(
                  (o: any) => o.isCross === isCross,
                ).length;
                if (total > 0) {
                  blockerByMarket.set(mid, {
                    ...(blockerByMarket.get(mid) ?? {}),
                    openOrderCount: total,
                  });
                }
              } catch { /* best-effort — chain check will catch */ }
            }),
          );

          for (const [marketId, info] of blockerByMarket.entries()) {
            blockers.push({ marketId, ...info });
          }

          if (blockers.length > 0) {
            return errorContent(
              BorosErrorCode.INVALID_PARAMS,
              `Cannot exit ${marginMode} market(s) — contract requires signedSize==0 AND nOrders==0 (MMMarketExitDenied). ` +
                `Blocked: ${blockers
                  .map((b) => {
                    const parts: string[] = [`marketId=${b.marketId}`];
                    if (b.signedSize) parts.push(`signedSize=${b.signedSize}`);
                    if (b.openOrderCount) parts.push(`openOrders=${b.openOrderCount}`);
                    return parts.join(' ');
                  })
                  .join('; ')}. Close any open positions via close_position AND cancel any resting orders via cancel_orders, then retry.`,
            );
          }
        }

        const endpoint = isEnter
          ? '/v1/calldata-builder/agent/enter-markets'
          : '/v1/calldata-builder/agent/exit-markets';

        const calldataRes = await fetchWithRetry(() =>
          openApiPost(endpoint, { accountId, isCross, marketIds }),
        );
        const calldatas = extractCalldatas(calldataRes);

        const enterExitIntent: IntentExpectation = {
          selector: ROUTER_SELECTORS.enterExitMarkets,
          cross: isCross,
          isEnter,
          marketIdsSet: marketIds,
        };

        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['enterExitMarkets'],
          { intents: [enterExitIntent] },
        );

        // CRITICAL: must flip ok on revert (e.g. MMMarketAlreadyEntered).
        const execErr = executionErrorContent(`${action}_markets`, result);
        if (execErr) return execErr;

        let marketNames: { marketId: number; name?: string; symbol?: string }[] = [];
        try {
          const list = await dedupTtl('markets-all', {}, 30_000, async () => {
            const out: any[] = [];
            let resumeToken: string | undefined;
            do {
              const mkts = await fetchWithRetry(() =>
                openApiGet('/v1/markets', {
                  limit: 100,
                  isUiWhitelisted: true,
                  ...(resumeToken ? { resumeToken } : {}),
                }),
              );
              out.push(...(mkts.results ?? []));
              resumeToken = mkts.resumeToken ?? undefined;
            } while (resumeToken);
            return out;
          });
          marketNames = marketIds.map((mid) => {
            const m = list.find((mm: any) => mm.marketId === mid);
            return {
              marketId: mid,
              ...(m?.imData?.name ? { name: m.imData.name } : {}),
              symbol: m?.metadata?.underlyingSymbol,
            };
          });
        } catch {
          marketNames = marketIds.map((mid) => ({ marketId: mid }));
        }

        const txHash = extractTxHash(result);

        return jsonResult({
          ok: true,
          action: `${action}_markets`,
          marginMode,
          ...(txHash ? { txHash } : {}),
          markets: marketNames,
          count: marketIds.length,
          execution: result,
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
