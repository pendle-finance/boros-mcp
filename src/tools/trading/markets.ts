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
import { marketIdField } from '../_schemas.js';

export function registerMarketsTools(server: McpServer) {
  server.registerTool(
    'enter_exit_markets',
    {
      annotations: { destructiveHint: true },
      description: 'Enter or exit markets on the cross account. Entering a market allows trading on it under cross margin. Exiting requires zero position size AND zero open limit orders. NOTE: entering a market draws a per-market entry fee (~$10 of cross collateral, on top of the off-chain gas budget) — if your cross account is below this floor the call reverts with "Top up at least ~$10 to trade"; deposit more cross collateral first. NOTE: matured markets cannot be exited today — the calldata-builder rejects them with "Market X is expired", so they remain permanently in get_entered_markets until that path is opened. The pre-flight here detects matured markets and returns a clear error before paying gas.',
      inputSchema: {
        action: z.enum(['enter', 'exit']).describe('Whether to enter or exit the markets'),
        marketIds: z.array(marketIdField()).min(1, 'marketIds must contain at least one market ID').describe('Array of market IDs to enter or exit (at least one required)'),
      },
    },
    withAuth(async ({ action, marketIds }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        const isEnter = action === 'enter';

        // Exit pre-check: contract requires signedSize==0 AND nOrders==0 (MarketHubEntry.exitMarket)
        // — fetch both positions + resting orders per marketId to avoid MMMarketExitDenied revert.
        // Also fetch market metadata so matured markets can be flagged client-side (the
        // calldata-builder rejects them with "Market X is expired" — we want a clear pre-flight
        // error instead of a blind round-trip + paid gas).
        if (!isEnter) {
          const [positions, marketsInfo] = await Promise.all([
            fetchWithRetry(() =>
              openApiGet('/v1/accounts/active-positions', {
                root: rootAddress,
                accountId,
              }),
            ),
            Promise.all(
              marketIds.map(async (mid) => {
                try {
                  const m = await fetchWithRetry(() =>
                    openApiGet(`/v1/markets/${mid}`),
                  );
                  return { mid, isMatured: Boolean(m?.isMatured ?? (typeof m?.maturity === 'number' && m.maturity * 1000 <= Date.now())) };
                } catch {
                  return { mid, isMatured: false };
                }
              }),
            ),
          ]);
          const matured = marketsInfo.filter((m) => m.isMatured).map((m) => m.mid);
          if (matured.length > 0) {
            return errorContent(
              BorosErrorCode.INVALID_PARAMS,
              `Cannot exit matured market(s): ${matured.join(', ')}. The Boros calldata-builder rejects exit on matured markets ("Market X is expired"). Matured markets stay permanently in get_entered_markets — there is no current workaround. To exit live markets in this batch, omit the matured ids from marketIds.`,
            );
          }
          const posArray = Array.isArray(positions) ? positions : ((positions as any).results ?? []);
          const blockers: { marketId: number; signedSize?: string; openOrderCount?: number }[] = [];
          const blockerByMarket = new Map<number, { signedSize?: string; openOrderCount?: number }>();
          for (const p of posArray) {
            if (p.marketId !== undefined && marketIds.includes(p.marketId)) {
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
                    limit: 1,
                  }),
                );
                const total = typeof data?.total === 'number'
                  ? data.total
                  : Array.isArray(data?.results) ? data.results.length : 0;
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
              `Cannot exit market(s) — contract requires signedSize==0 AND nOrders==0 (MMMarketExitDenied). ` +
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

        // Pin isCross:true — this MCP surface is cross-only; explicit prevents future default drift.
        const calldataRes = await fetchWithRetry(() =>
          openApiPost(endpoint, { accountId, isCross: true, marketIds }),
        );
        const calldatas = extractCalldatas(calldataRes);

        // enterExitMarkets always cross-account (IRouterEventsAndTypes).
        const enterExitIntent: IntentExpectation = {
          selector: ROUTER_SELECTORS.enterExitMarkets,
          cross: true,
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
