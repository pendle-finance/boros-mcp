import path from 'node:path';
import os from 'node:os';

export const OPEN_API_URL = process.env.BOROS_API_URL ?? 'https://api-boros.pendle.finance/apis/';
export const SEND_TXS_BOT_URL = process.env.BOROS_SEND_TXS_URL ?? 'https://api.boros.finance/send-txs-bot';

export const CROSS_MARKET_ID = 16777215; // 2^24 - 1
export const DEFAULT_ACCOUNT_ID = 0;
export const AGENT_EXPIRY_DAYS = 30;
export const CHAIN_ID = 42161n; // Arbitrum
export const ROUTER_ADDRESS = '0x8080808080daB95eFED788a9214e400ba552DEf6' as const;
export const DEFAULT_SLIPPAGE = 0.05; // 5%
export const CONFIG_DIR = path.join(os.homedir(), '.boros-mcp');
export const AGENT_KEY_FILE = 'agent.enc';
export const AGENT_META_FILE = 'agent.json';

export const DEFAULT_PORT = parseInt(process.env.BOROS_MCP_PORT ?? '3000', 10);

// 5 min budget matches browser wallet pages — long enough for human action, short enough to not hang MCP.
export const UNLOCK_WAIT_MS = 5 * 60 * 1000;

// EIP-712 domain (shared across all signing)
export const EIP712_DOMAIN = {
  name: 'Pendle Boros Router',
  version: '1.0',
  chainId: CHAIN_ID,
  verifyingContract: ROUTER_ADDRESS,
} as const;

export const ARBITRUM_RPC = process.env.ARBITRUM_RPC ?? 'https://arb1.arbitrum.io/rpc';
