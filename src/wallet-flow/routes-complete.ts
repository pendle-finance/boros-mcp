// /api/complete: resolves pending wallet/approve actions.
// approve_agent path: gasless relay — browser EIP-712 signs, we encode + forward to send-txs-bot.
// wallet tx path: browser broadcasts, posts back txHash, we verify on-chain.

import express from 'express';
import { encodeFunctionData, recoverTypedDataAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { CHAIN_ID, ROUTER_ADDRESS } from '../config.js';
import { sendTxsBotPost } from '../api/send-txs-bot.js';
import { fetchWithRetry } from '../lib/fetch-retry.js';
import { saveAgent } from '../agent/agent-manager.js';
import {
  agentKeyStore,
  failPendingAction,
  makeTypedError,
  pendingActions,
  resolvePendingAction,
} from './state.js';
import { verifyWalletTxReceipt } from './receipt-validator.js';

// Signed overload — encoded server-side so user wallet never broadcasts; send-txs-bot pays gas.
const APPROVE_AGENT_ABI = [{
  name: 'approveAgent',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [
    {
      name: 'message',
      type: 'tuple',
      components: [
        { name: 'root', type: 'address' },
        { name: 'accountId', type: 'uint8' },
        { name: 'agent', type: 'address' },
        { name: 'expiry', type: 'uint64' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    { name: 'sig', type: 'bytes' },
  ],
  outputs: [],
}] as const;

const APPROVE_AGENT_TYPES = {
  ApproveAgentMessage: [
    { name: 'root', type: 'address' },
    { name: 'accountId', type: 'uint8' },
    { name: 'agent', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

function detectCancelReason(error: unknown, cancelled: unknown): string | null {
  if (cancelled === true) return 'user_cancelled';
  if (typeof error !== 'string') return null;
  const e = error.toLowerCase();
  if (e === 'user_cancelled' || e === 'user_closed_tab' || e === 'user cancelled' || e === 'user canceled') {
    return error;
  }
  return null;
}

export async function handleComplete(req: express.Request, res: express.Response): Promise<void> {
  const { token, txHash, receipt, error, signature, rootAddress, expiry, nonce, password, cancelled } = req.body;
  if (!token) { res.status(400).json({ error: 'Missing token' }); return; }
  const action = pendingActions.get(token);
  if (!action) { res.status(404).json({ error: 'Unknown or expired token' }); return; }
  if (Date.now() > action.expiresAt) {
    failPendingAction(action, token, new Error('Token expired'));
    res.status(410).json({ error: 'Token expired' });
    return;
  }

  // user_closed_tab / user_cancelled / cancelled:true → USER_CANCELLED for all action types.
  const cancelReason = detectCancelReason(error, cancelled);
  if (cancelReason) {
    failPendingAction(action, token, makeTypedError('USER_CANCELLED', cancelReason));
    res.json({ ok: true, cancelled: true });
    return;
  }

  if (action.data?.type === 'approve_agent') {
    if (error) {
      failPendingAction(action, token, new Error(error));
      res.json({ ok: false, error });
      return;
    }
    if (!signature || !rootAddress || !expiry || !nonce) {
      res.status(400).json({ ok: false, error: 'Missing signature, rootAddress, expiry, or nonce' });
      return;
    }
    try {
      const privateKey = agentKeyStore.get(token);
      if (!privateKey) {
        res.status(400).json({ ok: false, error: 'Agent key not found for this token' });
        return;
      }

      // Without recovery check, a malicious page could pass any rootAddress and we'd persist
      // agent meta claiming approval over an address the agent has no authority over.
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: 'Pendle Boros Router',
          version: '1.0',
          chainId: Number(CHAIN_ID),
          verifyingContract: ROUTER_ADDRESS,
        },
        types: APPROVE_AGENT_TYPES,
        primaryType: 'ApproveAgentMessage',
        message: {
          root: rootAddress as Address,
          accountId: 0,
          agent: action.data.agentAddress as Address,
          expiry: BigInt(expiry),
          nonce: BigInt(nonce),
        },
        signature: signature as Hex,
      });
      if (recovered.toLowerCase() !== String(rootAddress).toLowerCase()) {
        const msg = `Signature recovery mismatch: recovered ${recovered}, browser claimed ${rootAddress}. Refusing to persist agent.`;
        failPendingAction(action, token, new Error(msg));
        res.status(400).json({ ok: false, error: msg });
        return;
      }

      const approveCalldata = encodeFunctionData({
        abi: APPROVE_AGENT_ABI,
        functionName: 'approveAgent',
        args: [
          {
            root: rootAddress as Address,
            accountId: 0,
            agent: action.data.agentAddress as Address,
            expiry: BigInt(expiry),
            nonce: BigInt(nonce),
          },
          signature as Hex,
        ],
      });

      // Retry so a transient 5xx doesn't wipe the pending key + force a full re-flow.
      const relayResult = await fetchWithRetry(() =>
        sendTxsBotPost('/v1/agent/approve', { approveAgentCalldata: approveCalldata }),
      );

      // Persist agent meta only after relay accepts the tx — failure path skips agent.json/enc writes.
      await saveAgent(privateKey, rootAddress as Address, password ?? '', Number(expiry));

      const relayTxHash =
        relayResult?.approveAgentResult?.txHash ?? relayResult?.txHash ?? null;
      resolvePendingAction(action, token, {
        rootAddress,
        agentAddress: action.data.agentAddress,
        txHash: relayTxHash,
      });
      res.json({ ok: true, txHash: relayTxHash });
    } catch (err: any) {
      failPendingAction(action, token, new Error(err.message ?? 'Agent approval failed'));
      res.status(500).json({ ok: false, error: err.message ?? 'Agent approval failed' });
    }
    return;
  }

  // Standard wallet tx — browser-supplied txHash is not trusted; verify on-chain before resolving.
  if (error) {
    failPendingAction(action, token, new Error(error));
    res.json({ ok: true });
    return;
  }

  if (!txHash || typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    const msg = 'Missing or malformed txHash in wallet completion';
    failPendingAction(action, token, new Error(msg));
    res.status(400).json({ ok: false, error: msg });
    return;
  }

  try {
    const verified = await verifyWalletTxReceipt(
      txHash,
      String(action.data?.type ?? ''),
      action.data?.expectedAddress,
    );
    resolvePendingAction(action, token, {
      txHash,
      receipt: receipt ?? { status: '0x1', blockNumber: verified.blockNumber.toString() },
    });
    res.json({ ok: true });
  } catch (err: any) {
    // Page already waited — surface real error rather than silently trusting browser's claim.
    const msg = err?.message ?? `Failed to verify txHash ${txHash}: ${err}`;
    const wrapped = err?.__borosCode
      ? err
      : new Error(msg.includes(txHash) ? msg : `Failed to verify txHash ${txHash}: ${msg}`);
    failPendingAction(action, token, wrapped);
    res.status(err?.__borosCode === 'INVALID_PARAMS' ? 400 : 500).json({ ok: false, error: msg });
  }
}
