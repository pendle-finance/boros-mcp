import type { Address } from 'viem';
import { UNLOCK_WAIT_MS } from '../config.js';
import { BorosErrorCode, errorContent } from './errors.js';
import { getAgentMeta, isAgentLocked, isAgentReady, waitForUnlock } from './agent-manager.js';
import { openUnlockPageOnce } from '../wallet-flow/server.js';

export interface RequireAuthOk {
  ok: true;
  rootAddress: Address;
  agentAddress: Address;
  agentExpiry: number;
}

export interface RequireAuthErr {
  ok: false;
  error: ReturnType<typeof errorContent>;
}

export type RequireAuthResult = RequireAuthOk | RequireAuthErr;

/** Auth guard: short-circuit on `result.ok === false`, else read meta from the `ok: true` branch. */
export async function requireAuth(): Promise<RequireAuthResult> {
  if (isAgentLocked()) {
    const unlockUrl = openUnlockPageOnce();
    const unlocked = await waitForUnlock(UNLOCK_WAIT_MS);
    if (!unlocked) {
      return {
        ok: false,
        error: errorContent(
          BorosErrorCode.AGENT_LOCKED,
          `Agent still locked after waiting ${UNLOCK_WAIT_MS / 60000} min. Unlock at ${unlockUrl} then retry.`,
        ),
      };
    }
  }
  if (!isAgentReady()) {
    return { ok: false, error: errorContent(BorosErrorCode.AGENT_NOT_SETUP) };
  }
  const meta = getAgentMeta();
  if (!meta) {
    return { ok: false, error: errorContent(BorosErrorCode.AGENT_NOT_SETUP) };
  }
  return {
    ok: true,
    rootAddress: meta.rootAddress as Address,
    agentAddress: meta.agentAddress as Address,
    agentExpiry: meta.expiryTimestamp,
  };
}
