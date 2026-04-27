import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, formatX18 } from '../../utils.js';
import { userAddressField, tokenIdField } from '../_schemas.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { safeAssetMap } from '../../api/asset-cache.js';

export function registerLeaderboardSearchTools(server: McpServer): void {
  server.registerTool(
    'search_leaderboard',
    {
      annotations: { readOnlyHint: true },
      description: 'Look up a specific user on the leaderboard for a single (period, tokenId). Returns rank, PnL, net balance, trading volume, and ROI. Prefer this over scanning get_leaderboard whenever you have a wallet address. Rank and ROI are populated only when the user qualifies for the leaderboard (≥$2k account value AND ≥$100k notional volume); otherwise PnL/balance/volume zeros may mean either "below threshold" or "never traded". Each tokenId is a separate leaderboard — call once per collateral token.',
      inputSchema: {
        userAddress: userAddressField('Wallet address (0x...)'),
        accountId: z.number().int().min(0).default(0).describe('Account ID (default 0)'),
        period: z.enum(['7d', '30d', 'all_time']).default('7d').describe('Leaderboard period (default 7d)'),
        tokenId: tokenIdField('Collateral token ID (use get_assets to discover valid IDs)'),
      },
    },
    async ({ userAddress, accountId, period, tokenId }) => {
      try {
        const [res, assetMap] = await Promise.all([
          fetchWithRetry(() =>
            openApiGet('/v1/leaderboard/search', { userAddress, accountId, period, tokenId }),
          ),
          safeAssetMap(),
        ]);
        const asset = assetMap.get(tokenId);
        const amountSymbol = asset?.symbol;
        // UserSearchResponse has no maxCapital (only on ranked leaderboard entry).
        const userInLeaderboard = res.rank !== undefined;
        return jsonResult({
          userAddress,
          accountId,
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
            rank: 'User rank — present only if user qualified.',
            amounts: `pnl / netBalance / tradingVolume are decimal strings in ${amountSymbol ?? 'the collateral token'}, already divided from the backend's 18-decimal FixedX18 raw representation.`,
            roi: 'Return on investment as decimal (0.15 = 15%). Only present if user qualified.',
            absentUser: 'When userInLeaderboard is false (sub-threshold), pnl/netBalance/tradingVolume still reflect actual wallet activity (decoded from FixedX18); only `rank` and `roi` are omitted. A wallet that has never traded will show all zeros — but a sub-threshold trader will show real numbers, so zeros do NOT prove "never traded".',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
