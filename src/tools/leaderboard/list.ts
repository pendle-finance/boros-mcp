import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichTimestamp, formatX18 } from '../../utils.js';
import { tokenIdField, userAddressFieldOptional, accountIdField, paginationLimitField } from '../_schemas.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { safeAssetMap } from '../../api/asset-cache.js';

export function registerLeaderboardListTools(server: McpServer): void {
  server.registerTool(
    'get_leaderboard',
    {
      annotations: { readOnlyHint: true },
      description: `Get leaderboard data for a (period, tokenId). Two modes:

LIST MODE (no \`userAddress\`): top traders by ROI, paginated. Returns rank, wallet, PnL, net balance, trading volume, max capital, ROI per entry.

LOOKUP MODE (\`userAddress\` set): single-wallet lookup — returns rank/PnL/balance/volume/ROI for that wallet. \`userInLeaderboard\` is true iff the user qualifies (≥$2k account value AND ≥$100k notional volume); otherwise PnL/balance/volume zeros may mean "below threshold" OR "never traded".

Computed from a daily UTC-midnight snapshot (lags up to ~24h). ROI = PnL / (starting account value + max net deposit), as decimal (0.15 = 15%). All amounts are decimal strings already normalized from FixedX18 — do NOT multiply by token decimals. Each tokenId is a separate leaderboard.`,
      inputSchema: {
        period: z.enum(['7d', '30d', 'all_time']).default('7d').describe('Leaderboard period (default 7d).'),
        tokenId: tokenIdField(),
        userAddress: userAddressFieldOptional('When set, switches to LOOKUP MODE for a single user.'),
        accountId: accountIdField('Used only in LOOKUP MODE.'),
        limit: paginationLimitField({ max: 50, defaultValue: 20, desc: 'Number of entries (LIST mode only; default 20, max 50).' }),
        offset: z.number().min(0).default(0).describe('Pagination offset (LIST mode only).'),
      },
    },
    async ({ period, tokenId, userAddress, accountId, limit, offset }) => {
      try {
        const assetMap = await safeAssetMap();
        const asset = assetMap.get(tokenId);
        const amountSymbol = asset?.symbol;

        if (userAddress) {
          const res = await fetchWithRetry(() =>
            openApiGet('/v1/leaderboard/search', { userAddress, accountId: accountId ?? 0, period, tokenId }),
          );
          const userInLeaderboard = res.rank !== undefined;
          return jsonResult({
            mode: 'lookup',
            userAddress,
            accountId: accountId ?? 0,
            period,
            tokenId,
            ...(amountSymbol ? { amountSymbol } : {}),
            userInLeaderboard,
            ...(res.rank !== undefined ? { rank: res.rank } : {}),
            ...(res.pnl !== undefined ? { pnl: formatX18(res.pnl) } : {}),
            ...(res.netBalance !== undefined ? { netBalance: formatX18(res.netBalance) } : {}),
            ...(res.tradingVolume !== undefined ? { tradingVolume: formatX18(res.tradingVolume) } : {}),
            ...(res.roi !== undefined ? { roi: res.roi } : {}),
            _context: {
              userInLeaderboard: 'true iff `rank` is present (user qualified for the leaderboard).',
              rank: 'User rank — present only if user qualified (≥$2k account value AND ≥$100k notional volume).',
              amounts: `pnl / netBalance / tradingVolume are decimal strings in ${amountSymbol ?? 'the collateral token'}, already divided from FixedX18.`,
              roi: 'Return on investment as decimal (0.15 = 15%). Only present if user qualified.',
              absentUser: 'When userInLeaderboard is false (sub-threshold), pnl/netBalance/tradingVolume still reflect actual wallet activity; only `rank` and `roi` are omitted. A wallet that has never traded shows all zeros — but a sub-threshold trader will too, so zeros do NOT prove "never traded".',
            },
          });
        }

        const res = await fetchWithRetry(() =>
          openApiGet('/v1/leaderboard', { period, tokenId, limit, offset }),
        );
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
          mode: 'list',
          ...(res.snapshotTimestamp ? { snapshot: enrichTimestamp(res.snapshotTimestamp) } : {}),
          totalEntries: res.totalEntries,
          count: entries.length,
          ...(amountSymbol ? { amountSymbol } : {}),
          entries,
          _context: {
            period,
            tokenId,
            amounts: `pnl / netBalance / tradingVolume / maxCapital are decimal strings in ${amountSymbol ?? 'the collateral token'}, already divided from FixedX18.`,
            roi: 'Return on investment as decimal (0.15 = 15%).',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
