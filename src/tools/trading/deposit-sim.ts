import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Address } from 'viem';
import { CROSS_MARKET_ID, DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiPost } from '../../api/open-api.js';
import { packMarketAcc } from '../../chain/pack-account.js';
import {
  jsonResult,
  enrichAmount,
  resolveAmount,
} from '../../utils.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { tokenIdField } from '../_schemas.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';
import { getAssetInfo } from '../../api/asset-cache.js';

export function registerDepositSimTools(server: McpServer) {
  server.registerTool(
    'simulate_deposit',
    {
      annotations: { readOnlyHint: true },
      description: 'Simulate depositing collateral into a margin account. Returns pre/post collateral balance, maintenance margin, and margin ratio without executing. Use before deposit to preview the account state change. Target the cross account by omitting marketId; isolated by providing marketId.',
      inputSchema: {
        tokenId: tokenIdField('Collateral token ID'),
        amount: z.string().optional().describe('Raw amount (token smallest unit). Provide either amount or humanAmount.'),
        humanAmount: z.number().optional().describe('Human-readable amount (e.g. 100.5). Provide either amount or humanAmount.'),
        marketId: z.number().optional().describe('Market ID for isolated deposit. Omit for cross margin.'),
      },
    },
    withAuth(async ({ tokenId, amount, humanAmount, marketId }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        // Throw on unknown tokenId — default decimals=18 silently makes bogus preview look valid.
        const asset = await getAssetInfo(tokenId);
        const decimals = asset.decimals;
        const symbol = asset.symbol;
        const resolvedAmount = resolveAmount(amount, humanAmount, decimals);

        const effectiveMarketId = marketId ?? CROSS_MARKET_ID;
        const marketAcc = packMarketAcc(rootAddress as Address, accountId, tokenId, effectiveMarketId);

        // CRITICAL: sim endpoint expects 10^18-scaled amount (else off 10^12 for USDT, 10^10 for WBTC).
        // Chain-side deposit calldata is unaffected (contract scales internally).
        const scaleExp = 18 - decimals;
        const scaledAmountForSim =
          scaleExp >= 0
            ? (BigInt(resolvedAmount) * 10n ** BigInt(scaleExp)).toString()
            : (BigInt(resolvedAmount) / 10n ** BigInt(-scaleExp)).toString();

        const sim = await fetchWithRetry(() =>
          openApiPost('/v1/simulations/deposit', { marketAcc, amount: scaledAmountForSim }),
        );

        // Backend bug: /v1/simulations/deposit returns postUserState.collateralBalance as string-concat
        // of amount + preBalance (e.g. "99999999" + "000028572084991260721762") instead of bigint sum.
        // Recompute locally — both operands are 18-dec internal cash units.
        const preCollateral = sim.preUserState?.collateralBalance;
        const postUserState =
          preCollateral !== undefined && preCollateral !== null
            ? {
                ...sim.postUserState,
                collateralBalance: (
                  BigInt(preCollateral) + BigInt(scaledAmountForSim)
                ).toString(),
              }
            : sim.postUserState;

        return jsonResult({
          ok: true,
          tokenId,
          symbol,
          ...enrichAmount(resolvedAmount, decimals, symbol),
          ...(marketId !== undefined ? { marketId } : {}),
          marginType: marketId !== undefined ? 'isolated' : 'cross',
          simulation: {
            preUserState: sim.preUserState,
            postUserState,
          },
          nextTool: {
            tool: 'deposit',
            params: {
              tokenId,
              ...(amount !== undefined ? { amount } : {}),
              ...(humanAmount !== undefined ? { humanAmount } : {}),
              ...(marketId !== undefined ? { marketId } : {}),
            },
            instruction: 'If the user confirms, call deposit to execute via wallet signing.',
          },
          _context: {
            stateFields: 'collateralBalance, maintenanceMargin, and marginRatio (collateral / maintenance).',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
