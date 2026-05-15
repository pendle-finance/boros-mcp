import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_ACCOUNT_ID } from '../../config.js';
import { openApiPost } from '../../api/open-api.js';
import { type IntentExpectation } from '../../agent/signing.js';
import { ROUTER_SELECTORS } from '../../chain/selectors.js';
import { jsonResult } from '../../utils.js';
import { BOROS_INTERNAL_DECIMALS, humanToRaw } from '../../lib/format/amount.js';
import { catchToErrorContent, errorContent, BorosErrorCode } from '../../agent/errors.js';
import { marketIdField, marginModeField } from '../_schemas.js';
import {
  executeAgentAction,
  extractCalldatas,
  extractTxHash,
  executionErrorContent,
} from './_execute.js';
import { getMarketInfo, assertMarginModeAllowed } from './_market.js';
import { getAssetInfo } from '../../api/asset-cache.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { withAuth } from '../_with-auth.js';

export function registerGasTools(server: McpServer) {
  server.registerTool(
    'pay_gas',
    {
      annotations: { destructiveHint: true },
      description: 'Top up the off-chain gas budget by paying treasury for a specific market. DEDUCTED FROM YOUR MARGIN ACCOUNT (cross or isolated per marginMode) — this moves collateral into a non-withdrawable gas budget. Required before placing orders if gas balance is low.',
      inputSchema: {
        amount: z.number().positive('amount must be > 0').describe('Amount in USD to top up the off-chain gas budget (must be > 0)'),
        marketId: marketIdField('Market treasury receives the payment.'),
        marginMode: marginModeField('Which account pays the fee.'),
      },
    },
    withAuth(async ({ amount, marketId, marginMode }, { rootAddress }) => {
      try {
        const accountId = DEFAULT_ACCOUNT_ID;

        // Backend payTreasury wires `amount` in Boros internal X18 (1e18 = 1 token of collateral),
        // NOT the ERC-20 native decimals — payTreasury is a pure-internal move (cash bucket → gas
        // budget) and never touches the ERC-20, so the asset's `decimals` (USDT0=6, WBTC=8, …) is
        // irrelevant for the wire. Convert USD → token amount via spot price, then scale by 1e18.
        const market = await getMarketInfo(marketId);
        const marginErr = assertMarginModeAllowed(market, marginMode, marketId);
        if (marginErr) return errorContent(BorosErrorCode.INVALID_PARAMS, marginErr);
        const tokenId: number = market.tokenId;
        const asset = await getAssetInfo(tokenId);
        const usdPriceStr = asset.usdPrice;
        const usdPrice = usdPriceStr !== undefined ? Number(usdPriceStr) : NaN;
        if (!Number.isFinite(usdPrice) || usdPrice <= 0) {
          return errorContent(
            BorosErrorCode.UNKNOWN,
            `Could not resolve a valid USD price for tokenId ${tokenId} (asset.usdPrice=${usdPriceStr ?? 'undefined'}). Cannot convert USD amount to X18 cash units.`,
          );
        }
        const tokenAmountFloat = amount / usdPrice;
        const tokenAmountRaw = humanToRaw(tokenAmountFloat, BOROS_INTERNAL_DECIMALS);
        if (tokenAmountRaw === '0') {
          return errorContent(
            BorosErrorCode.INVALID_PARAMS,
            `USD amount ${amount} converts to 0 X18 units at price ${usdPrice}. Increase amount.`,
          );
        }

        const calldataRes = await fetchWithRetry(() =>
          openApiPost('/v1/calldata-builder/agent/pay-treasury', {
            accountId,
            isCross: marginMode === 'cross',
            marketId,
            amount: tokenAmountRaw,
          }),
        );
        const calldatas = extractCalldatas(calldataRes);

        // Skip amount pin (price-feed/precision delta legit) — pin cross+marketId only.
        const payTreasuryIntent: IntentExpectation = {
          selector: ROUTER_SELECTORS.payTreasury,
          marketId,
          cross: marginMode === 'cross',
        };

        const result = await executeAgentAction(
          calldatas,
          rootAddress,
          accountId,
          ['payTreasury'],
          { intents: [payTreasuryIntent] },
        );

        const execErr = executionErrorContent('pay_gas', result);
        if (execErr) return execErr;

        const txHash = extractTxHash(result);

        return jsonResult({
          ok: true,
          action: 'pay_gas',
          ...(txHash ? { txHash } : {}),
          amount,
          amountUnit: 'USD (credited to off-chain gas budget)',
          marketId,
          marginMode,
          execution: result,
          _context: {
            note: 'Payment is deducted from your margin account (cross or isolated based on marginMode) and credited to your off-chain gas budget, which funds subsequent agent-signed transactions.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    }),
  );
}
