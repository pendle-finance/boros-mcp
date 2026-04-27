import { type Address, type Hex, toHex } from 'viem';
import { CROSS_MARKET_ID } from '../config.js';

/** Pack (root, accountId) into a 21-byte hex (bytes21). */
export function packAccount(root: Address, accountId: number): Hex {
  const packed = (BigInt(root) << 8n) | BigInt(accountId);
  return toHex(packed, { size: 21 });
}

/** Pack (root, accountId, tokenId, marketId) into a 26-byte hex (bytes26). */
export function packMarketAcc(root: Address, accountId: number, tokenId: number, marketId: number): Hex {
  const packed = (BigInt(root) << 48n) | (BigInt(accountId) << 40n) | (BigInt(tokenId) << 24n) | BigInt(marketId);
  return toHex(packed, { size: 26 });
}

/** Inverse of packMarketAcc — split a 26-byte marketAcc into its components. */
export interface UnpackedMarketAcc {
  root: Address;
  accountId: number;
  tokenId: number;
  marketId: number;
  isCross: boolean;
}

export function unpackMarketAcc(marketAcc: string): UnpackedMarketAcc {
  const hex = marketAcc.startsWith('0x') ? marketAcc.slice(2) : marketAcc;
  if (hex.length !== 52) {
    throw new Error(`marketAcc must be 26 bytes / 52 hex chars (got ${hex.length})`);
  }
  const packed = BigInt('0x' + hex);
  const marketId = Number(packed & 0xffffffn);
  const tokenId = Number((packed >> 24n) & 0xffffn);
  const accountId = Number((packed >> 40n) & 0xffn);
  const rootBig = packed >> 48n;
  const root = ('0x' + rootBig.toString(16).padStart(40, '0')) as Address;
  return { root, accountId, tokenId, marketId, isCross: marketId === CROSS_MARKET_ID };
}
