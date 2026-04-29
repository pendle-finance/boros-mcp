import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult } from '../../utils.js';
import { userAddressFieldOptional, marketIdOptionalField, accountIdField, paginationLimitField } from '../_schemas.js';
import { APR_NOTE } from '../_context.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import type { Address } from 'viem';
import { packAccount } from '../../chain/pack-account.js';
import { fetchAllMarkets } from '../_shared/fetch-all-markets.js';

const REWARDS_NOTE =
  'Unclaimed/all-time vault rewards are no longer returned here. Use get_amm_user_rewards (per-market breakdown) for live unclaimed and lifetime rewards.';

const vaultContext = {
  apr: APR_NOTE,
  lpApy: 'Annualized LP yield (decimal, 0.05 = 5%). Combined fees + Pendle incentives — the v2 endpoint does not split them; for the breakdown, fetch /v1/amm/chart (no MCP wrapper today).',
  lpPrice: 'Collateral-asset value of 1 LP token (number, derived from the latest snapshot).',
  totalLp: 'BOROS20 LP token supply (raw 18-decimal bigint string).',
  totalValue: 'Vault TVL in COLLATERAL-ASSET decimals (USDC=6, WBTC=8, WETH/USDe=18). NOT 18-decimal across the board — use get_assets to look up the collateral decimals before formatting.',
  totalSupplyCap: 'Maximum LP supply cap (raw 18-decimal bigint string, same scale as totalLp).',
  fillPercent: 'totalLp / totalSupplyCap, clamped to 100% (matches the dapp). Pure LP-supply ratio.',
  user: 'Present only when userAddress is provided AND the account has a deposit in this market. depositValue / availableBalanceToDeposit are in collateral-asset decimals; user.totalLp is 18-decimal.',
  rewards: REWARDS_NOTE,
  availableBalanceToDeposit: 'Cross-margin available initial margin minus the market entrance fee (NOT wallet ERC-20 balance). To deposit you may first need to bridge funds from the wallet via deposit/cash_transfer.',
};

type GlobalAmmState = {
  marketId: number;
  tokenId: number;
  ammId: number;
  state?: any;
  isPositive?: boolean;
  feeRate?: string;
  impliedRate?: number;
  totalLp?: string;
  totalValue?: string;
  totalSupplyCap?: string;
  lpApy?: number;
  lpPrice?: number;
};

type UserAmmState = {
  marketId: number;
  tokenId: number;
  ammId: number;
  averageLpPrice: number;
  depositValue: string;
  totalLp: string;
  availableBalanceToDeposit: string;
};

function enrichVault(g: GlobalAmmState, u?: UserAmmState) {
  // fillPercent MUST be LP/LP — value/LP would be garbage for non-18d collateral (USDC off 1e12).
  // Dapp parity: clamp 100%.
  let fillPercent: string | undefined;
  if (g.totalLp && g.totalSupplyCap && g.totalSupplyCap !== '0') {
    const ratio = Number((BigInt(g.totalLp) * 10000n) / BigInt(g.totalSupplyCap)) / 100;
    fillPercent = `${Math.min(100, ratio).toFixed(2)}%`;
  }
  return {
    marketId: g.marketId,
    tokenId: g.tokenId,
    ammId: g.ammId,
    lpApy: g.lpApy,
    lpApyPercent: g.lpApy !== undefined ? `${(g.lpApy * 100).toFixed(4)}%` : undefined,
    lpPrice: g.lpPrice,
    totalLp: g.totalLp,
    totalValue: g.totalValue,
    totalSupplyCap: g.totalSupplyCap,
    ...(fillPercent ? { fillPercent } : {}),
    ...(u ? {
      user: {
        depositValue: u.depositValue,
        totalLp: u.totalLp,
        avgLpPrice: u.averageLpPrice,
        availableBalanceToDeposit: u.availableBalanceToDeposit,
        rewardsNote: REWARDS_NOTE,
      },
    } : {}),
  };
}

async function fetchAmmStates(marketIds: number[]): Promise<GlobalAmmState[]> {
  if (marketIds.length === 0) return [];
  const data = await fetchWithRetry(() =>
    openApiGet('/v1/amm/states', { marketIds: marketIds.join(',') }),
  );
  return (data.results ?? []) as GlobalAmmState[];
}

async function fetchUserAmmStates(account: string): Promise<UserAmmState[]> {
  const data = await fetchWithRetry(() =>
    openApiGet('/v1/accounts/amm-states', { account }),
  );
  return (data.results ?? []) as UserAmmState[];
}

export function registerAmmVaultTools(server: McpServer): void {
  server.registerTool(
    'get_vault_info',
    {
      annotations: { readOnlyHint: true },
      description: `Get Boros LP vault info: TVL (totalValue, in collateral-asset decimals), LP token supply, supply cap, lpPrice, lpApy (combined fees+incentives), and optionally your deposit position.
With marketId: single-vault detail. Without marketId: summary list — by default only ACTIVE vaults (maturity > now) plus any matured vaults where the caller still holds LP. Pass includeMatured=true for the full set. Per-vault user blocks are suppressed by default; pass fullDetail=true to include them (response can exceed 50 KB).
Use this for: vault TVL, LP APY, fillPercent, my deposit position. Do NOT use for: protocol-level TVL (get_tvl), AMM swap-state math (get_amm_info), claimable LP rewards (get_amm_user_rewards), or the wallet-side treasury payment (vault_pay_treasury — unrelated despite the name).`,
      inputSchema: {
        marketId: marketIdOptionalField('Specific vault. Omit to get the all-vaults summary.'),
        userAddress: userAddressFieldOptional('Include user-specific vault position data (only materialised in single-vault mode or when fullDetail=true). When set in list mode, also surfaces matured vaults where the caller still holds LP.'),
        accountId: accountIdField('Only used when userAddress is provided.'),
        fullDetail: z
          .boolean()
          .default(false)
          .describe('Only meaningful in list mode (no marketId). When true, include the full per-vault user position object. Default false.'),
        includeMatured: z
          .boolean()
          .default(false)
          .describe('List mode only. When true, include vaults whose maturity has passed (residual LP only). Default false — matured vaults appear only when the caller has a non-zero LP balance there.'),
        limit: paginationLimitField({ max: 100, defaultValue: 50, desc: 'Max vaults to return in list mode (default 50, max 100 — matches the backend hard cap).' }),
      },
    },
    async ({ marketId, userAddress, accountId, fullDetail, includeMatured, limit }) => {
      try {
        const account = userAddress
          ? packAccount(userAddress as Address, accountId ?? 0)
          : undefined;

        if (marketId !== undefined) {
          const globals = await fetchAmmStates([marketId]);
          const g = globals[0];
          if (!g) {
            return errorContent(
              BorosErrorCode.AMM_NOT_FOUND,
              `Market ${marketId} has no LP vault (orderbook-only market). Use get_orderbook for liquidity.`,
            );
          }

          let userEntry: UserAmmState | undefined;
          if (account) {
            const userStates = await fetchUserAmmStates(account);
            userEntry = userStates.find((u) => u.marketId === marketId);
          }

          return jsonResult({
            vault: enrichVault(g, userEntry),
            _context: vaultContext,
          });
        }

        const allMarkets = await fetchAllMarkets();
        const nowSec = Math.floor(Date.now() / 1000);
        const ammMarkets = allMarkets.filter((m: any) => {
          const id = m.extConfig?.ammId ?? m.metadata?.ammId;
          return typeof id === 'number' && id !== 0;
        });
        const ammMarketIds: number[] = ammMarkets.map((m: any) => m.marketId as number);
        const activeAmmIds = new Set<number>(
          ammMarkets
            .filter((m: any) => (m.imData?.maturity ?? 0) > nowSec)
            .map((m: any) => m.marketId as number),
        );

        let userByMarketId: Map<number, UserAmmState> | undefined;
        if (account) {
          const userStates = await fetchUserAmmStates(account);
          userByMarketId = new Map(userStates.map((u) => [u.marketId, u]));
        }
        const userDepositIds = new Set<number>();
        if (userByMarketId) {
          for (const [mid, u] of userByMarketId) {
            if (u.totalLp && u.totalLp !== '0') userDepositIds.add(mid);
          }
        }

        const effectiveIds = ammMarketIds.filter((id) => {
          if (includeMatured) return true;
          if (activeAmmIds.has(id)) return true;
          return userDepositIds.has(id);
        });

        // API cap 100 — surface overflow via truncated.
        const apiCappedIds = effectiveIds.slice(0, 100);
        const globals = await fetchAmmStates(apiCappedIds);

        const allVaults = globals.map((g) => {
          const u = userByMarketId?.get(g.marketId);
          const enriched = enrichVault(g, u);
          const matured = !activeAmmIds.has(g.marketId);
          const decorated = matured ? { ...enriched, matured: true } : enriched;
          if (!fullDetail && decorated.user) {
            const { user, ...slim } = decorated;
            return slim;
          }
          return decorated;
        });
        const vaults = allVaults.slice(0, limit);
        const maturedShown = vaults.filter((v: any) => v.matured).length;

        return jsonResult({
          totalAmm: ammMarketIds.length,
          activeAmm: activeAmmIds.size,
          eligible: effectiveIds.length,
          count: vaults.length,
          maturedShown,
          truncated: effectiveIds.length > vaults.length,
          fullDetail: !!fullDetail,
          includeMatured: !!includeMatured,
          vaults,
          _context: {
            ...vaultContext,
            listMode: 'Per-vault `user` object is hidden by default. Pass fullDetail=true (or use marketId) to include it.',
            filtering: 'Default list shows ACTIVE vaults (maturity > now) plus matured vaults where the caller still has LP. Pass includeMatured=true to see every AMM-enabled market regardless of maturity.',
            matured: 'Vaults flagged `matured: true` no longer accept new swaps; LP can still withdraw residual collateral.',
            totalTvlUsd: 'No longer returned by the backend (the v2 aggregate endpoint was removed). Sum totalValue per collateral via get_assets if you need a USD figure.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
