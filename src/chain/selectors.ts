// Single source of truth for 4-byte function selectors.
// ROUTER_SELECTORS: agent-signed via EIP-712 (allowlist in signing.ts, semantic check in calldata-verify.ts).
// WALLET_SELECTORS: user wallet broadcasts directly (allowlisted in receipt-validator.ts).

export const ROUTER_SELECTORS = {
  bulkOrders: '0xb412c67c',
  bulkCancels: '0x8e728bb2',
  cashTransfer: '0xa458e316',
  ammCashTransfer: '0x5065e6f9',
  payTreasury: '0xa567afa9',
  enterExitMarkets: '0x49c31adc',
  placeSingleOrder: '0x8c69996c',
  swapWithAmm: '0x27b1b0d3',
  addLiquidityDualToAmm: '0xa75ab675',
  addLiquiditySingleCashToAmm: '0x80fc6ec7',
  removeLiquidityDualFromAmm: '0x34da5c82',
  removeLiquiditySingleCashFromAmm: '0x5092d247',
} as const;

export type RouterSelectorName = keyof typeof ROUTER_SELECTORS;
export type RouterSelector = (typeof ROUTER_SELECTORS)[RouterSelectorName];

// Inverse of ROUTER_SELECTORS for allowlist messages.
export const ROUTER_SELECTOR_NAMES: Readonly<Record<string, RouterSelectorName>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ROUTER_SELECTORS).map(([name, sel]) => [sel, name as RouterSelectorName]),
  ),
);

// Selectors with semantic verifiers in calldata-verify.ts.
export const ROUTER_SELECTORS_VERIFIED = [
  ROUTER_SELECTORS.placeSingleOrder,
  ROUTER_SELECTORS.bulkOrders,
  ROUTER_SELECTORS.bulkCancels,
  ROUTER_SELECTORS.cashTransfer,
  ROUTER_SELECTORS.payTreasury,
  ROUTER_SELECTORS.enterExitMarkets,
] as const;

export const ROUTER_SELECTORS_DEFERRED = [
  ROUTER_SELECTORS.ammCashTransfer,
  ROUTER_SELECTORS.swapWithAmm,
  ROUTER_SELECTORS.addLiquidityDualToAmm,
  ROUTER_SELECTORS.addLiquiditySingleCashToAmm,
  ROUTER_SELECTORS.removeLiquidityDualFromAmm,
  ROUTER_SELECTORS.removeLiquiditySingleCashFromAmm,
] as const;

// Direct overloads broadcast by user wallet from src/pages/*.html.
export const WALLET_SELECTORS = {
  vaultDeposit: '0x1cea11dd',
  requestVaultWithdrawal: '0x91a0783f',
  cancelVaultWithdrawal: '0x73a886d7',
  vaultPayTreasury: '0x99bee960',
  revokeAgent: '0x24218484',
  // Signed/relayed via send-txs-bot after approve_agent's EIP-712 sig.
  approveAgentSigned: '0xffe6fb25',
} as const;

export type WalletSelectorName = keyof typeof WALLET_SELECTORS;
