export enum BorosErrorCode {
  // Retryable
  RATE_LIMITED = 'RATE_LIMITED',
  API_UNAVAILABLE = 'API_UNAVAILABLE',
  TIMEOUT = 'TIMEOUT',

  // Not retryable (auth)
  AGENT_EXPIRED = 'AGENT_EXPIRED',
  AGENT_NOT_SETUP = 'AGENT_NOT_SETUP',
  AGENT_LOCKED = 'AGENT_LOCKED',
  DISABLED_AGENT = 'DISABLED_AGENT',

  // Not retryable (bad input)
  MARKET_NOT_FOUND = 'MARKET_NOT_FOUND',
  AMM_NOT_FOUND = 'AMM_NOT_FOUND',
  INVALID_PARAMS = 'INVALID_PARAMS',
  INSUFFICIENT_MARGIN = 'INSUFFICIENT_MARGIN',
  INSUFFICIENT_GAS = 'INSUFFICIENT_GAS',
  SLIPPAGE_EXCEEDED = 'SLIPPAGE_EXCEEDED',
  MIN_ORDER_VALUE = 'MIN_ORDER_VALUE',
  AMM_MIN_CASH = 'AMM_MIN_CASH',

  // Not retryable (market state)
  MARKET_PAUSED = 'MARKET_PAUSED',
  MARKET_HALTED = 'MARKET_HALTED',

  // Not retryable (simulation / execution)
  SIMULATION_FAILED = 'SIMULATION_FAILED',
  PRICE_IMPACT_TOO_HIGH = 'PRICE_IMPACT_TOO_HIGH',
  EXECUTION_REVERTED = 'EXECUTION_REVERTED',
  NO_FILL = 'NO_FILL',

  // Retryable (browser UX) — legacy alias; new flows should emit USER_CANCELLED instead.
  BROWSER_DISMISSED = 'BROWSER_DISMISSED',

  // Not retryable (user action)
  USER_CANCELLED = 'USER_CANCELLED',

  // Not retryable (wallet incompatibility)
  WALLET_INCOMPATIBLE = 'WALLET_INCOMPATIBLE',

  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  UNKNOWN = 'UNKNOWN',
}

const ERROR_ACTIONS: Record<BorosErrorCode, string> = {
  [BorosErrorCode.RATE_LIMITED]: 'API rate limit reached. Wait a moment and retry.',
  [BorosErrorCode.API_UNAVAILABLE]: 'Boros API is temporarily unavailable. Retry in a few seconds.',
  [BorosErrorCode.TIMEOUT]: 'Request timed out. Retry the operation.',
  [BorosErrorCode.AGENT_EXPIRED]: 'Agent has expired. Call setup_agent to re-approve with your wallet.',
  [BorosErrorCode.AGENT_NOT_SETUP]: 'No agent configured. Call setup_agent first to connect your wallet.',
  [BorosErrorCode.AGENT_LOCKED]: 'Agent key is password-protected and locked. An unlock page has been opened in your browser — enter your password there, then retry.',
  [BorosErrorCode.DISABLED_AGENT]: 'Agent has been disabled. Call setup_agent to create a new agent.',
  [BorosErrorCode.MARKET_NOT_FOUND]: 'Market not found. Use get_markets to list available markets.',
  [BorosErrorCode.AMM_NOT_FOUND]: 'This market has no AMM (vault). Only markets with metadata.ammId > 0 support AMM operations; use get_orderbook instead.',
  [BorosErrorCode.INVALID_PARAMS]: 'Invalid parameters. Check your input and try again.',
  [BorosErrorCode.INSUFFICIENT_MARGIN]: 'Insufficient margin. Deposit more collateral or reduce order size.',
  [BorosErrorCode.INSUFFICIENT_GAS]: 'Off-chain gas budget too low. Call pay_gas (marketId, amount in USD, marginMode) to top up — funds are debited from your margin account, not your wallet. See `nextTool` if present for a pre-filled call.',
  [BorosErrorCode.SLIPPAGE_EXCEEDED]: 'Price moved beyond slippage tolerance. Increase slippage or try again.',
  [BorosErrorCode.MIN_ORDER_VALUE]: 'Order notional below the market minimum (typically $10). Increase size.',
  [BorosErrorCode.AMM_MIN_CASH]: 'Cash deposit is below the AMM min-cash floor (MMInsufficientMinCash). Increase humanCash/cashAmount and retry.',
  [BorosErrorCode.MARKET_PAUSED]: 'Market is in close-only mode. You can only close existing positions, not open new ones.',
  [BorosErrorCode.MARKET_HALTED]: 'Market is halted. No operations allowed.',
  [BorosErrorCode.SIMULATION_FAILED]: 'Order simulation failed. Adjust parameters and retry.',
  [BorosErrorCode.PRICE_IMPACT_TOO_HIGH]: 'Price impact is too high. Reduce order size, use limit orders, or raise the `slippage` param on simulate_order/place_order (decimal, 0.05 = 5%).',
  [BorosErrorCode.EXECUTION_REVERTED]: 'On-chain execution reverted. See `execution` array for per-call revert reasons; no state was changed for reverted calls.',
  [BorosErrorCode.NO_FILL]: 'Order did not fill. IOC/FOK with no matching liquidity at the given rate. Widen the rate guard or switch to GTC.',
  [BorosErrorCode.BROWSER_DISMISSED]: 'User closed the browser tab before completing the transaction. Re-run the tool to reopen the signing page.',
  [BorosErrorCode.USER_CANCELLED]: 'User cancelled the wallet flow (closed the tab or clicked cancel). No on-chain action was taken. Re-issue the same tool call when you are ready to complete it.',
  [BorosErrorCode.WALLET_INCOMPATIBLE]: 'Wallet is incompatible: it has an EIP-7702 delegation (or other smart-account abstraction) that the Boros backend does not support. Switch to a non-7702-delegated EOA (e.g. a fresh MetaMask account) and re-run the flow. Retrying with the same wallet will keep failing.',
  [BorosErrorCode.NOT_IMPLEMENTED]: 'This operation is not available in the current Boros API.',
  [BorosErrorCode.UNKNOWN]: 'An unexpected error occurred. Check the error message for details.',
};

const RETRYABLE = new Set<BorosErrorCode>([
  BorosErrorCode.RATE_LIMITED,
  BorosErrorCode.API_UNAVAILABLE,
  BorosErrorCode.TIMEOUT,
  BorosErrorCode.BROWSER_DISMISSED,
]);

/** Pre-filled follow-up call attached to a StructuredError (e.g. INSUFFICIENT_GAS → pay_gas). */
export interface NextToolHint {
  name: string;
  args: Record<string, unknown>;
  why?: string;
}

export interface StructuredError {
  ok: false;
  error: {
    code: BorosErrorCode;
    message: string;
    retryable: boolean;
    action: string;
    nextTool?: NextToolHint;
  };
}

/** Tag an error with a BorosErrorCode so classifyError routes it deterministically (no message regex). */
export function tagBorosError<E extends Error>(err: E, code: BorosErrorCode): E {
  (err as Error & { __borosCode?: string }).__borosCode = code;
  return err;
}

export function throwBorosError(code: BorosErrorCode, message: string): never {
  throw tagBorosError(new Error(message), code);
}

/**
 * Solidity custom-error names → BorosErrorCode. Upstream surfaces these as bare
 * `SomeError()` strings inside the 4xx body's `message` field. Match BEFORE the
 * generic `mminsufficient` substring rule so MMInsufficientMinCash gets its own
 * AMM_MIN_CASH classification rather than being lumped under INSUFFICIENT_MARGIN.
 */
const KNOWN_REVERTS: Record<string, BorosErrorCode> = {
  MarketLastTradedRateTooFar: BorosErrorCode.INVALID_PARAMS,
  AMMTotalSupplyCapExceeded: BorosErrorCode.INVALID_PARAMS,
  MMInsufficientMinCash: BorosErrorCode.AMM_MIN_CASH,
  MMInsufficientIM: BorosErrorCode.INSUFFICIENT_MARGIN,
  MMInsufficientMM: BorosErrorCode.INSUFFICIENT_MARGIN,
};

/** Bare `SomeError()` (NestJS pass-through of a Solidity custom-error). */
const REVERT_RE = /\b([A-Z][A-Za-z0-9_]*)\(\)/;

// Strips viem's `Unrecognized custom error: 0x...\nDocs:...\nVersion:...` preamble; keeps selector for debugging.
const VIEM_UNRECOGNIZED_RE = /Unrecognized custom error:\s*(0x[0-9a-fA-F]{8})[\s\S]*$/;
// open-api / send-txs-bot Object.assign upstream NestJS body onto err, so Error.message can be array (validation) or object.
export function sanitizeErrorMessage(message: unknown): string {
  if (message == null) return '';
  if (typeof message !== 'string') {
    try {
      return Array.isArray(message) || typeof message === 'object' ? JSON.stringify(message) : String(message);
    } catch {
      return String(message);
    }
  }
  if (!message) return message;
  const m = message.match(VIEM_UNRECOGNIZED_RE);
  if (m) {
    return `On-chain call reverted with an undecoded custom error (selector ${m[1]}). Likely cause: invalid amount/state for this operation (e.g. LP balance below minimum, AMM out of bounds, supply cap, or rate guard). Adjust inputs and retry; if persistent, report the selector to support.`;
  }
  return message;
}

/** NestJS class-validator output shape: array of `{property, messages?: string[]}`. */
function looksLikeNestValidation(message: unknown): boolean {
  if (!Array.isArray(message) || message.length === 0) return false;
  return message.every(
    (e) => e && typeof e === 'object' && typeof (e as { property?: unknown }).property === 'string',
  );
}

export function classifyError(err: unknown): BorosErrorCode {
  // Honour explicit __borosCode first so callers tagging plain objects/Errors aren't degraded to UNKNOWN.
  const anyErrRoot = err as Record<string, unknown> | null | undefined;
  const directCode = anyErrRoot?.__borosCode as string | undefined;
  if (directCode && Object.values(BorosErrorCode).includes(directCode as BorosErrorCode)) {
    return directCode as BorosErrorCode;
  }

  if (err instanceof Error) {
    const anyErr = err as unknown as Record<string, unknown>;
    const status = (anyErr.status ?? anyErr.statusCode) as number | undefined;

    if (status === 429) return BorosErrorCode.RATE_LIMITED;
    if (status === 503) return BorosErrorCode.API_UNAVAILABLE;

    // open-api.ts/send-txs-bot.ts do `Object.assign(err, JSON.parse(body))` so the
    // upstream NestJS `message` field overwrites Error.message — possibly with an
    // array of {property, messages}. Inspect it directly before stringifying.
    const rawMessage = anyErr.message;
    if (looksLikeNestValidation(rawMessage)) return BorosErrorCode.INVALID_PARAMS;

    // Known Solidity reverts pass through as `SomeError()` in the message string.
    const msgRaw = typeof rawMessage === 'string' ? rawMessage : String(err.message);
    const revertMatch = msgRaw.match(REVERT_RE);
    if (revertMatch && KNOWN_REVERTS[revertMatch[1]]) {
      return KNOWN_REVERTS[revertMatch[1]];
    }

    // 4xx with a plain-string `message` (e.g. "limitTick and rate are mutually exclusive",
    // "Collateral not found, tokenId: 999") is a NestJS guard/lookup miss — bad input.
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 404) {
      if (typeof rawMessage === 'string' && rawMessage.length > 0) {
        // Skip if a more specific rule below would match — fall through to lower checks.
        const lower = rawMessage.toLowerCase();
        const hasSpecificMatch =
          /market\s+\S+\s+not found/.test(lower) ||
          lower.includes('market not found') ||
          /order value must be greater than.*usd/.test(lower) ||
          lower.includes('min order value') ||
          lower.includes('below minimum') ||
          lower.includes('insufficient gas');
        if (!hasSpecificMatch) return BorosErrorCode.INVALID_PARAMS;
      }
    }
    // 404 lookup-misses (e.g. "Collateral not found, tokenId: 999") — bad caller input.
    if (status === 404 && typeof rawMessage === 'string' && /not found/i.test(rawMessage)) {
      return BorosErrorCode.INVALID_PARAMS;
    }

    const msg = msgRaw.toLowerCase();

    const errorCode = anyErr.errorCode as string | undefined;
    if (errorCode) {
      if (errorCode === 'INSUFFICIENT_MARGIN' || errorCode.startsWith('MMInsufficient')) return BorosErrorCode.INSUFFICIENT_MARGIN;
      if (errorCode === 'INSUFFICIENT_GAS') return BorosErrorCode.INSUFFICIENT_GAS;
      if (errorCode.includes('SLIPPAGE')) return BorosErrorCode.SLIPPAGE_EXCEEDED;
      if (errorCode === 'AMM_NOT_FOUND') return BorosErrorCode.AMM_NOT_FOUND;
      if (errorCode === 'MARKET_NOT_FOUND') return BorosErrorCode.MARKET_NOT_FOUND;
      if (
        errorCode === 'EIP7702_INCOMPATIBLE' ||
        errorCode.includes('EIP7702') ||
        errorCode.includes('EIP_7702')
      )
        return BorosErrorCode.WALLET_INCOMPATIBLE;
    }

    // EIP-7702 incompat — match clear signals only; avoid "smart wallet" alone (false positives).
    if (
      msg.includes('eip-7702') ||
      msg.includes('eip 7702') ||
      msg.includes('eip7702') ||
      msg.includes('7702 wallet') ||
      msg.includes('incompatible eip') ||
      msg.includes('delegated wallet') ||
      (msg.includes('please delegate') && msg.includes('contract'))
    ) {
      return BorosErrorCode.WALLET_INCOMPATIBLE;
    }

    // user_closed_tab/user_cancelled posted by wallet pages → USER_CANCELLED (not retryable; LLM re-issues).
    if (msg === 'user_cancelled' || msg.includes('user_cancelled') || msg.includes('user cancelled') || msg.includes('user canceled')) return BorosErrorCode.USER_CANCELLED;
    if (msg === 'user_closed_tab' || msg.includes('user_closed_tab')) return BorosErrorCode.USER_CANCELLED;
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')) return BorosErrorCode.TIMEOUT;
    if (msg.includes('agent') && msg.includes('expired')) return BorosErrorCode.AGENT_EXPIRED;
    if (msg.includes('agent') && msg.includes('disabled')) return BorosErrorCode.DISABLED_AGENT;
    if (msg.includes('rate limit') || msg.includes('too many')) return BorosErrorCode.RATE_LIMITED;
    // getMarketInfo throws `Market ${id} not found` w/o errorCode — match before generic checks.
    if (/market\s+\S+\s+not found/.test(msg) || msg.includes('market not found')) return BorosErrorCode.MARKET_NOT_FOUND;
    // Backend min-notional guard: "Order value must be greater than 10 USD".
    if (/order value must be greater than.*usd/.test(msg) || msg.includes('min order value') || msg.includes('below minimum')) return BorosErrorCode.MIN_ORDER_VALUE;
    // EVM revert strings: MMInsufficientMinCash/IM/MM.
    if (msg.includes('mminsufficient') || msg.includes('insufficient margin') || msg.includes('insufficient min cash')) return BorosErrorCode.INSUFFICIENT_MARGIN;
    if (msg.includes('insufficient gas')) return BorosErrorCode.INSUFFICIENT_GAS;
    if (msg.includes('market') && msg.includes('paused')) return BorosErrorCode.MARKET_PAUSED;
    if (msg.includes('market') && msg.includes('halted')) return BorosErrorCode.MARKET_HALTED;
    if (msg.includes('simulation') && msg.includes('failed')) return BorosErrorCode.SIMULATION_FAILED;
  }

  return BorosErrorCode.UNKNOWN;
}

export function structuredError(
  code: BorosErrorCode,
  message?: string,
  opts?: { nextTool?: NextToolHint },
): StructuredError {
  return {
    ok: false,
    error: {
      code,
      message: message ?? ERROR_ACTIONS[code],
      retryable: RETRYABLE.has(code),
      action: ERROR_ACTIONS[code],
      ...(opts?.nextTool ? { nextTool: opts.nextTool } : {}),
    },
  };
}

export function errorContent(
  code: BorosErrorCode,
  message?: string,
  opts?: { nextTool?: NextToolHint },
) {
  const pretty = process.env.BOROS_MCP_PRETTY === '1';
  const err = structuredError(code, message, opts);
  return {
    content: [{ type: 'text' as const, text: pretty ? JSON.stringify(err, null, 2) : JSON.stringify(err) }],
    isError: true,
  };
}

/** Per-code follow-up hints; only the entry matching the resolved BorosErrorCode is attached. */
export function catchToErrorContent(
  err: unknown,
  opts?: { nextToolFor?: Partial<Record<BorosErrorCode, NextToolHint>> },
) {
  const code = classifyError(err);
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = sanitizeErrorMessage(rawMessage);
  const nextTool = opts?.nextToolFor?.[code];
  return errorContent(code, message, nextTool ? { nextTool } : undefined);
}
