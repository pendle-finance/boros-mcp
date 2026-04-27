import { type Address, type Hex, keccak256 } from 'viem';
import { signTypedData } from 'viem/accounts';
import { EIP712_DOMAIN } from '../config.js';
import { getAgentPrivateKey, getAgentAddress } from './agent-manager.js';
import { verifyCalldataIntent, type IntentExpectation } from '../chain/calldata-verify.js';
import { ROUTER_SELECTOR_NAMES } from '../chain/selectors.js';
import { packAccount } from '../chain/pack-account.js';

export type { IntentExpectation } from '../chain/calldata-verify.js';
export { verifyCalldataIntent } from '../chain/calldata-verify.js';

/** Assert every calldata's selector is in the agent allowlist (defense vs MITM'd open-api). */
export function assertCalldatasAllowed(calldatas: Hex[], expected?: string[]): void {
  const expectedSet = expected ? new Set(expected) : null;
  for (const cd of calldatas) {
    if (typeof cd !== 'string' || !cd.startsWith('0x') || cd.length < 10) {
      throw new Error(`Refusing to sign malformed calldata: ${String(cd).slice(0, 16)}…`);
    }
    const sel = cd.slice(0, 10).toLowerCase();
    const fn = ROUTER_SELECTOR_NAMES[sel];
    if (!fn) {
      throw new Error(
        `Refusing to sign calldata with unknown selector ${sel}. ` +
        `This is not an agent-permitted Router function. Possible compromised or stale open-api response.`,
      );
    }
    if (expectedSet && !expectedSet.has(fn)) {
      throw new Error(
        `Refusing to sign calldata for ${fn} (selector ${sel}) — tool only permits ${[...expectedSet].join(', ')}. ` +
        `Possible compromised or stale open-api response.`,
      );
    }
  }
}

const PENDLE_SIGN_TX_TYPES = {
  PendleSignTx: [
    { name: 'account', type: 'bytes21' },
    { name: 'connectionId', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export interface SignedAgentExecution {
  agent: Address;
  message: { account: Hex; connectionId: Hex; nonce: string };
  signature: Hex;
  calldata: Hex;
}

/**
 * Sign calldatas with the agent key (EIP-712).
 * If `intents` is supplied, length must equal calldatas.length and each is verified
 * via verifyCalldataIntent before signing; otherwise only the selector allowlist applies.
 */
export async function bulkSignWithAgent(
  root: Address,
  accountId: number,
  calldatas: Hex[],
  expected?: string[],
  intents?: IntentExpectation[],
): Promise<SignedAgentExecution[]> {
  assertCalldatasAllowed(calldatas, expected);

  if (intents !== undefined) {
    if (intents.length !== calldatas.length) {
      throw new Error(
        `bulkSignWithAgent: intents.length (${intents.length}) must equal calldatas.length (${calldatas.length})`,
      );
    }
    for (let i = 0; i < calldatas.length; i++) {
      verifyCalldataIntent(calldatas[i], intents[i]);
    }
  }

  const privateKey = getAgentPrivateKey();
  const agentAddress = getAgentAddress();
  const account = packAccount(root, accountId);

  const results: SignedAgentExecution[] = [];
  for (let i = 0; i < calldatas.length; i++) {
    const connectionId = keccak256(calldatas[i]);
    // Nonce = ms*1000 + i so same-ms batch entries don't collide with the Router's per-agent nonce store.
    const nonce = BigInt(Date.now() * 1000 + i);

    const signature = await signTypedData({
      privateKey,
      domain: { ...EIP712_DOMAIN, chainId: Number(EIP712_DOMAIN.chainId) },
      types: PENDLE_SIGN_TX_TYPES,
      primaryType: 'PendleSignTx',
      message: { account, connectionId, nonce },
    });

    results.push({
      agent: agentAddress,
      message: { account, connectionId, nonce: nonce.toString() },
      signature,
      calldata: calldatas[i],
    });
  }
  return results;
}
