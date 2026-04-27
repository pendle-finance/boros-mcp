// On-chain validation: after the browser POSTs a txHash, verify (a) it hit ROUTER_ADDRESS and
// (b) the selector matches the action's allowlist. Without this a malicious page could submit
// any successful tx and resolve the pending action as if the deposit/withdrawal occurred.

import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';
import type { Hex } from 'viem';
import { ARBITRUM_RPC, ROUTER_ADDRESS } from '../config.js';
import { WALLET_SELECTORS } from '../chain/selectors.js';
import { makeTypedError } from './state.js';

export const ACTION_SELECTOR_ALLOWLIST: Record<string, readonly string[]> = {
  deposit: [WALLET_SELECTORS.vaultDeposit],
  withdraw: [WALLET_SELECTORS.requestVaultWithdrawal],
  cancel_withdraw: [WALLET_SELECTORS.cancelVaultWithdrawal],
  vault_pay_treasury: [WALLET_SELECTORS.vaultPayTreasury],
  revoke_agent: [WALLET_SELECTORS.revokeAgent],
  approve_agent: [WALLET_SELECTORS.approveAgentSigned],
};

const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(ARBITRUM_RPC),
});

export interface VerifiedReceipt {
  blockNumber: bigint;
}

/** Throws on verification failure; returns block number on success. */
export async function verifyWalletTxReceipt(
  txHash: string,
  actionType: string,
  expectedFrom: string | undefined,
): Promise<VerifiedReceipt> {
  // Need both: receipt has status/from/blockNumber; getTransaction has calldata (to, input).
  const [onchain, tx] = await Promise.all([
    publicClient.getTransactionReceipt({ hash: txHash as Hex }),
    publicClient.getTransaction({ hash: txHash as Hex }),
  ]);

  if (onchain.status !== 'success') {
    throw new Error(`Transaction ${txHash} reverted on-chain (status=${onchain.status})`);
  }

  if (expectedFrom && onchain.from.toLowerCase() !== expectedFrom.toLowerCase()) {
    throw new Error(`txHash ${txHash} was signed by ${onchain.from}, not expected ${expectedFrom}`);
  }

  // Case-insensitive — RPC providers may checksum receipts differently than ROUTER_ADDRESS.
  const txTo = tx.to ? tx.to.toLowerCase() : null;
  if (txTo !== ROUTER_ADDRESS.toLowerCase()) {
    throw makeTypedError(
      'INVALID_PARAMS',
      `txHash ${txHash} was sent to ${tx.to ?? '(contract creation)'}, not the Boros Router (${ROUTER_ADDRESS}). Refusing to resolve action ${actionType}.`,
    );
  }

  const allowedSelectors = ACTION_SELECTOR_ALLOWLIST[actionType];
  if (allowedSelectors && allowedSelectors.length > 0) {
    const inputHex = (tx.input ?? '0x').toLowerCase();
    const selector = inputHex.length >= 10 ? inputHex.slice(0, 10) : inputHex;
    if (!allowedSelectors.includes(selector)) {
      throw makeTypedError(
        'INVALID_PARAMS',
        `txHash ${txHash} called selector ${selector} on the Router, but action ${actionType} only permits [${allowedSelectors.join(', ')}]. Refusing to resolve.`,
      );
    }
  }

  return { blockNumber: onchain.blockNumber };
}
