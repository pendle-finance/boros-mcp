// Shared resolver for wallet tools — getAssetInfo → decimals → resolveAmount → enrichAmount.
// Throws INVALID_PARAMS on zero-amount so every wallet tool rejects identically.
import { getAssetInfo, type AssetInfo } from '../../api/asset-cache.js';
import { resolveAmount, enrichAmount } from '../../utils.js';
import { BorosErrorCode } from '../../agent/errors.js';

export interface ResolvedTokenAmount {
  asset: AssetInfo;
  decimals: number;
  symbol: string;
  resolvedAmount: string;
  enriched: ReturnType<typeof enrichAmount>;
}

export async function resolveTokenAmount(
  tokenId: number,
  amount: string | undefined,
  humanAmount: number | undefined,
): Promise<ResolvedTokenAmount> {
  const asset = await getAssetInfo(tokenId);
  const decimals: number = asset.decimals ?? 18;
  const symbol: string = asset.symbol ?? `TOKEN-${tokenId}`;
  const resolvedAmount = resolveAmount(amount, humanAmount, decimals);
  if (BigInt(resolvedAmount) === 0n) {
    throw Object.assign(new Error('amount must be > 0'), {
      __borosCode: BorosErrorCode.INVALID_PARAMS,
    });
  }
  const enriched = enrichAmount(resolvedAmount, decimals, symbol);
  return { asset, decimals, symbol, resolvedAmount, enriched };
}
