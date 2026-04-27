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

export function registerMarketsTools(server: McpServer) {
  server.registerTool(
    'enter_exit_markets',
    {
      annotations: { destructiveHint: true },
      description: 'Enter or exit markets on the cross account. Entering a market allows trading on it under cross margin. Exiting removes it (requires no open positions).',
      inputSchema: {
        action: z.enum(['enter', 'exit']).describe('Whether to enter or exit the markets'),
        marketIds: z.array(z.number()).min(1, 'marketIds must contain at least one market ID').describe('Array of market IDs to enter or exit (at least one required)'),
      },
    },
    withAuth(async ({ action, marketIds }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        const isEnter = action === 'enter';

        // Exit pre-check: contract requires signedSize==0 AND nOrders==0 (MarketHubEntry.exitMarket)
        // — fetch both positions + resting orders per marketId to avoid MMMarketExitDenied revert.
        if (!isEnter) {
          const positions = await fetchWithRetry(() =>
            openApiGet('/v1/accounts/active-positions', {
              root: rootAddress,
              accountId,
            }),
          );
          const posArray = Array.isArray(positions) ? positions : (positions.results ?? []);
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
