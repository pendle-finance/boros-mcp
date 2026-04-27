import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { CONFIG_DIR, AGENT_KEY_FILE, AGENT_META_FILE } from '../config.js';

interface AgentMeta {
  rootAddress: Address;
  agentAddress: Address;
  expiryTimestamp: number; // unix seconds
  createdAt: string; // ISO
}

interface EncryptedKey {
  version: number;
  passwordProtected: boolean;
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

let agentReady = false;
let agentMeta: AgentMeta | null = null;
let locked = false; // true when password-protected but not yet unlocked
let agentPrivateKey: Hex | null = null;
let agentAddress: Address | null = null;

// Resolvers for callers blocked on waitForUnlock(). Fired when activateAgent succeeds.
const unlockWaiters = new Set<(unlocked: boolean) => void>();

export function getAgentPrivateKey(): Hex {
  if (!agentPrivateKey) throw new Error('Agent not ready');
  return agentPrivateKey;
}

export function getAgentAddress(): Address {
  if (!agentAddress) throw new Error('Agent not ready');
  return agentAddress;
}

function activateAgent(privateKey: Hex): Address {
  const account = privateKeyToAccount(privateKey);
  agentPrivateKey = privateKey;
  agentAddress = account.address;
  agentReady = true;
  locked = false;
  for (const resolve of unlockWaiters) resolve(true);
  unlockWaiters.clear();
  return account.address;
}

export function isAgentReady(): boolean { return agentReady; }
export function isAgentLocked(): boolean { return locked; }
export function getAgentMeta(): AgentMeta | null { return agentMeta; }

// Blocks until the agent is unlocked via /api/unlock, or the timeout elapses.
// Returns true on unlock, false on timeout. Resolves immediately if already unlocked.
export function waitForUnlock(timeoutMs: number): Promise<boolean> {
  if (!locked) return Promise.resolve(agentReady);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      unlockWaiters.delete(waiter);
      resolve(false);
    }, timeoutMs);
    const waiter = (unlocked: boolean) => {
      clearTimeout(timer);
      resolve(unlocked);
    };
    unlockWaiters.add(waiter);
  });
}

// scrypt N=2^14 matches OWASP min for interactive auth; higher would stall the MCP main loop on cold start.
function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, 32, { N: 2 ** 14, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
}

function encryptKey(privateKey: Hex, password: string): EncryptedKey {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    passwordProtected: password.length > 0,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    tag: tag.toString('hex'),
  };
}

function decryptKey(data: EncryptedKey, password: string): Hex {
  const salt = Buffer.from(data.salt, 'hex');
  const iv = Buffer.from(data.iv, 'hex');
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'hex')), decipher.final()]);
  return decrypted.toString('utf8') as Hex;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export async function saveAgent(privateKey: Hex, rootAddress: Address, password: string, expiryTimestamp: number): Promise<void> {
  ensureConfigDir();

  const agentAddr = activateAgent(privateKey);

  const encrypted = encryptKey(privateKey, password);
  const keyPath = path.join(CONFIG_DIR, AGENT_KEY_FILE);
  fs.writeFileSync(keyPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });

  const meta: AgentMeta = {
    rootAddress,
    agentAddress: agentAddr,
    expiryTimestamp,
    createdAt: new Date().toISOString(),
  };
  const metaPath = path.join(CONFIG_DIR, AGENT_META_FILE);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });

  agentMeta = meta;
}

export async function loadAgent(): Promise<'ready' | 'locked' | 'not_setup'> {
  const keyPath = path.join(CONFIG_DIR, AGENT_KEY_FILE);
  const metaPath = path.join(CONFIG_DIR, AGENT_META_FILE);

  if (!fs.existsSync(keyPath) || !fs.existsSync(metaPath)) {
    return 'not_setup';
  }

  const metaRaw = fs.readFileSync(metaPath, 'utf-8');
  agentMeta = JSON.parse(metaRaw) as AgentMeta;

  const encRaw = fs.readFileSync(keyPath, 'utf-8');
  const encData = JSON.parse(encRaw) as EncryptedKey;

  if (!encData.passwordProtected) {
    const privateKey = decryptKey(encData, '');
    activateAgent(privateKey);
    return 'ready';
  }

  locked = true;
  return 'locked';
}

export function unlockAgent(password: string): boolean {
  const keyPath = path.join(CONFIG_DIR, AGENT_KEY_FILE);
  try {
    const encRaw = fs.readFileSync(keyPath, 'utf-8');
    const encData = JSON.parse(encRaw) as EncryptedKey;
    const privateKey = decryptKey(encData, password);
    activateAgent(privateKey);
    return true;
  } catch {
    return false;
  }
}

export function isAgentExpired(): boolean {
  if (!agentMeta) return true;
  return Date.now() / 1000 > agentMeta.expiryTimestamp;
}

export function generateAgentKey(): Hex {
  return `0x${crypto.randomBytes(32).toString('hex')}` as Hex;
}

// Call after on-chain revoke so getAgentPrivateKey() fails fast (local key would only sign reverts).
export function clearAgent(): void {
  agentReady = false;
  agentMeta = null;
  locked = false;
  agentPrivateKey = null;
  agentAddress = null;
  for (const resolve of unlockWaiters) resolve(false);
  unlockWaiters.clear();
  for (const filename of [AGENT_KEY_FILE, AGENT_META_FILE]) {
    const p = path.join(CONFIG_DIR, filename);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // Best-effort: in-memory wipe above is what stops further signing.
    }
  }
}

export function getAgentStatus() {
  if (!agentMeta) {
    return { configured: false };
  }
  const now = Date.now() / 1000;
  const daysRemaining = Math.max(0, Math.floor((agentMeta.expiryTimestamp - now) / 86400));
  return {
    configured: true,
    agentAddress: agentMeta.agentAddress,
    rootAddress: agentMeta.rootAddress,
    expiryDate: new Date(agentMeta.expiryTimestamp * 1000).toISOString(),
    isExpired: now > agentMeta.expiryTimestamp,
    daysRemaining,
    locked,
    ready: agentReady,
  };
}
