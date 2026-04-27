import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichTimestamp, formatX18 } from '../../utils.js';
import { tokenIdField } from '../_schemas.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { safeAssetMap } from '../../api/asset-cache.js';

export function registerLeaderboardListTools(server: McpServer): void {
  server.registerTool(
    'get_leaderboard',
    {
      annotations: { readOnlyHint: true },
      description: 'Get top traders by ROI on Boros for a given period and collateral token (one leaderboard per (period, tokenId)). Returns rank, wallet, PnL, net balance, trading volume, max capital, and ROI per entry. Computed from a daily UTC-midnight snapshot — values lag up to ~24h. Eligibility: wallets with <$2k account value or <$100k notional volume in the period are excluded. ROI = PnL / (starting account value + max net deposit), as a decimal (0.15 = 15%). All amount fields are decimal strings already normalized from the backend\'s 18-decimal FixedX18 internal representation; do NOT multiply by token decimals. For a single-wallet lookup prefer search_leaderboard. Use get_assets to discover valid tokenIds.',
      inputSchema: {
        period: z.enum(['7d', '30d', 'all_time']).default('7d').describe('Leaderboard period (default 7d)'),
        tokenId: tokenIdField('Collateral token ID'),
        limit: z.number().min(1).max(1000).default(100).describe('Number of entries (default 100, max 1000)'),
        offset: z.number().min(0).default(0).describe('Pagination offset'),
      },
    },
    async ({ period, tokenId, limit, offset }) => {
      try {
        const [res, assetMap] = await Promise.all([
          fetchWithRetry(() =>
            openApiGet('/v1/leaderboard', { period, tokenId, limit, offset }),
          ),
          safeAssetMap(),
        ]);
        const asset = assetMap.get(tokenId);
        const amountSymbol = asset?.symbol;
        // Backend ships amounts as FixedX18 regardless of native token decimals — formatX18.
        const entries = (res.entries ?? []).map((e: any) => ({
          rank: e.rank,
          root: e.root,
          accountId: e.accountId,
          ...(e.pnl !== undefined ? { pnl: formatX18(e.pnl) } : {}),
          ...(e.netBalance !== undefined ? { netBalance: formatX18(e.netBalance) } : {}),
          ...(e.tradingVolume !== undefined ? { tradingVolume: formatX18(e.tradingVolume) } : {}),
          ...(e.maxCapital !== undefined ? { maxCapital: formatX18(e.maxCapital) } : {}),
          roi: e.roi,
        }));
        return jsonResult({
          ...(res.snapshotTimestamp ? { snapshot: enrichTimestamp(res.snapshotTimestamp) } : {}),
          totalEntries: res.totalEntries,
          count: entries.length,
          ...(amountSymbol ? { amountSymbol } : {}),
          entries,
          _context: {
            period,
            tokenId,
            amounts: `pnl / netBalance / tradingVolume / maxCapital are decimal strings in ${amountSymbol ?? 'the collateral token'}, already divided from the backend's 18-decimal FixedX18 raw representation.`,
            roi: 'Return on investment as decimal (0.15 = 15%).',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
