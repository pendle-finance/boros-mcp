// Wire-format brands. Boros normalizes every collateral to X18 (1e18) internally regardless
// of native ERC-20 decimals; only wallet-boundary fields (deposit/withdraw) use native scale.
// Both arrive as plain `string` — applying rawToHuman(x, asset.decimals) to an X18 field
// gives off-by-10^(18-native) bugs (USDT/USDC). Brand at consumer boundary so the type
// system blocks accidental mixing.

import { rawToHuman } from './format/amount.js';

declare const __scaleBrand: unique symbol;

/** Wire string in FixedX18 (1e18) scale. Boros normalizes every collateral here. */
export type WireX18 = string & { readonly [__scaleBrand]: 'x18' };

/** Wire string in token-native ERC-20 scale, paired with its decimals so the
 *  formatter doesn't need to look up the token again. */
export interface WireNative {
  readonly raw: string & { readonly [__scaleBrand]: 'native' };
  readonly decimals: number;
}

/** Cast-only brand (no runtime check). Returns undefined on null/undefined for conditional-spread. */
export function asX18(raw: string | bigint | number): WireX18;
export function asX18(raw: string | bigint | number | null | undefined): WireX18 | undefined;
export function asX18(raw: string | bigint | number | null | undefined): WireX18 | undefined {
  if (raw === null || raw === undefined) return undefined;
  return (typeof raw === 'string' ? raw : String(raw)) as WireX18;
}

/** Use only at wallet boundary (real ERC-20 transfer amounts). */
export function asNative(raw: string | bigint, decimals: number): WireNative {
  return {
    raw: (typeof raw === 'string' ? raw : raw.toString()) as WireNative['raw'],
    decimals,
  };
}

export function formatNative(v: WireNative): string {
  return rawToHuman(v.raw, v.decimals);
}
