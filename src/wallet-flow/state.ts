// Pending wallet/approve action state. Tools create a PendingAction keyed by UUID, open a page
// that posts back to /api/complete which resolves/rejects the promise.

import crypto from 'node:crypto';
import type { Hex } from 'viem';
import { BorosErrorCode, tagBorosError } from '../agent/errors.js';

// 5 min budget matches unlock page — exceeds wallet UX, short enough not to hang MCP.
export const PENDING_ACTION_TIMEOUT_MS = 5 * 60 * 1000;

export interface PendingAction {
  token: string;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  data: any; // public data only — never contains private keys
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export const pendingActions = new Map<string, PendingAction>();

// Server-side only — NEVER exposed to browser.
export const agentKeyStore = new Map<string, Hex>();

/** Tag with BorosErrorCode so classifyError maps it without regex on the message. */
export function makeTypedError(code: string, message: string): Error {
  return tagBorosError(new Error(message), code as BorosErrorCode);
}

export function createPendingAction(data: any): { token: string; promise: Promise<any> } {
  const token = crypto.randomUUID();
  let resolve!: (result: any) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });

  const timer = setTimeout(() => {
    const action = pendingActions.get(token);
    if (action) {
      pendingActions.delete(token);
      agentKeyStore.delete(token);
      action.reject(new Error('Action timed out (5 minutes)'));
    }
  }, PENDING_ACTION_TIMEOUT_MS);

  pendingActions.set(token, {
    token,
    resolve,
    reject,
    data,
    expiresAt: Date.now() + PENDING_ACTION_TIMEOUT_MS,
    timer,
  });

  return { token, promise };
}

export function storeAgentKey(token: string, privateKey: Hex): void {
  agentKeyStore.set(token, privateKey);
}

/** Reject + teardown timer/key. Centralised so the ~10 cleanup sites in /api/complete can't drift. */
export function failPendingAction(
  action: PendingAction,
  token: string,
  err: Error,
): void {
  clearTimeout(action.timer);
  pendingActions.delete(token);
  agentKeyStore.delete(token);
  action.reject(err);
}

/** Resolve + teardown timer/key. */
export function resolvePendingAction(
  action: PendingAction,
  token: string,
  payload: any,
): void {
  clearTimeout(action.timer);
  pendingActions.delete(token);
  agentKeyStore.delete(token);
  action.resolve(payload);
}
