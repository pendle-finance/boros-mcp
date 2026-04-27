// Shared Zod field factories — validation rules locked here so error messages stay consistent across tools.
import { z } from 'zod';
import { DEFAULT_SLIPPAGE } from '../config.js';
import { ADDRESS_REGEX, MARKET_ACC_REGEX, type FilterCondition } from '../utils.js';

export type { FilterCondition };

const DEFAULT_USER_ADDRESS_DESC = 'Your wallet address (0x...)';
const DEFAULT_MARKET_ACC_DESC =
  'Packed marketAcc: 0x followed by 52 hex chars (54 chars total). Cross accounts carry 0xFFFFFF in the marketId segment.';

export function userAddressField(desc: string = DEFAULT_USER_ADDRESS_DESC) {
  return z
    .string()
    .regex(ADDRESS_REGEX, 'userAddress must be 0x + 40 hex chars')
    .describe(desc);
}

export function userAddressFieldOptional(desc: string) {
  return z
    .string()
    .regex(ADDRESS_REGEX, 'userAddress must be 0x + 40 hex chars')
    .optional()
    .describe(desc);
}

export function addressField(label: string, desc: string) {
  return z
    .string()
    .regex(ADDRESS_REGEX, `${label} must be 0x + 40 hex chars`)
    .describe(desc);
}

export function addressFieldOptional(label: string, desc: string) {
  return z
    .string()
    .regex(ADDRESS_REGEX, `${label} must be 0x + 40 hex chars`)
    .optional()
    .describe(desc);
}

export function accountIdField(opts?: {
  defaultValue?: number;
  min?: number;
  max?: number;
  desc?: string;
}) {
  const min = opts?.min ?? 0;
  const max = opts?.max ?? 255;
  const def = opts?.defaultValue ?? 0;
  const desc = opts?.desc ?? `Account ID ${min}..${max}, default ${def}.`;
  return z.number().int().min(min).max(max).default(def).describe(desc);
}

export function marketIdField(
  desc: string = 'Market ID to trade on (positive integer; resolve via get_markets)',
  opts?: { min?: number; max?: number },
) {
  const min = opts?.min ?? 1;
  let s = z.number().int().min(min);
  if (opts?.max !== undefined) s = s.max(opts.max);
  return s.describe(desc);
}

export function marketIdOptionalField(desc: string) {
  return z.number().int().optional().describe(desc);
}

export function marketAccField(desc: string = DEFAULT_MARKET_ACC_DESC) {
  return z.string().regex(MARKET_ACC_REGEX, 'marketAcc must be 0x + 52 hex chars').describe(desc);
}

export function marketAccFieldOptional(desc: string) {
  return z
    .string()
    .regex(MARKET_ACC_REGEX, 'marketAcc must be 0x + 52 hex chars')
    .optional()
    .describe(desc);
}

export function slippageField(
  desc: string = 'Max slippage as DECIMAL (0.05 = 5%, NOT 5).',
) {
  return z
    .number()
    .min(0, 'slippage cannot be negative')
    .max(1, 'slippage > 1 — DECIMAL (0.05 = 5%), not 5')
    .default(DEFAULT_SLIPPAGE)
    .describe(desc);
}

export function marginModeField(
  desc: string = 'Margin mode. cross (default): one bucket per (root, accountId, tokenId) — shared across all entered markets for that token. isolated: per-market bucket keyed by marketId, walled off from cross. Move funds via cash_transfer.',
) {
  return z.enum(['cross', 'isolated']).default('cross').describe(desc);
}

export const TIME_IN_FORCE_VALUES = ['GTC', 'IOC', 'FOK', 'ALO', 'SOFT_ALO'] as const;
export const TIME_IN_FORCE_DESCRIPTION =
  'Order time-in-force policy. Defaults when omitted: orderType=limit → GTC; orderType=market → FOK. ' +
  'Values: ' +
  'GTC = rest unmatched remainder on book until filled or cancelled (standard limit). ' +
  'IOC = take whatever crosses now, cancel rest; pair with limitApr as a rate guard for partial-fill market orders. ' +
  'FOK = fill entire size atomically against current liquidity or revert; the only TIF the backend treats as a rate-free market order (every other TIF requires a rate). ' +
  'ALO = strict post-only. Reverts (MarketOrderALOFilled) if ANY size would fill on placement. Order must rest 100% as maker. Cannot route through AMM. ' +
  'SOFT_ALO = lenient post-only. Crossing slices are silently dropped (no fill, no revert); non-crossing slices rest as maker. Best for batch/ladder placements where partial post-only success is acceptable. Cannot route through AMM. ' +
  'Note: Boros charges only takerFee — makers pay nothing — so ALO/SOFT_ALO guarantee zero-fee execution at placement; once resting, the order behaves like a normal limit and fills naturally when later takers cross it.';

export function timeInForceField(desc: string = TIME_IN_FORCE_DESCRIPTION) {
  return z.enum(TIME_IN_FORCE_VALUES).optional().describe(desc);
}

// Normalize `side` to uppercase wire form. calldata-verify uses its own lowercase string→0/1 enum
// (calldata-verify.ts:225); IntentExpectation builders map UPPER → lower at that edge.
export const sideSchema = z
  .enum(['long', 'short', 'LONG', 'SHORT'])
  .transform((s) => s.toUpperCase() as 'LONG' | 'SHORT')
  .describe('Trade direction (accepts either case)');

export function resumeTokenField(
  desc: string = 'Cursor from previous response for next page',
) {
  return z.string().optional().describe(desc);
}

export function paginationLimitField(opts: {
  min?: number;
  max: number;
  defaultValue: number;
  desc?: string;
}) {
  const min = opts.min ?? 1;
  const desc = opts.desc ?? `Max results (default ${opts.defaultValue}, capped at ${opts.max})`;
  return z.number().int().min(min).max(opts.max).default(opts.defaultValue).describe(desc);
}

// Default min=0: some endpoints accept tokenId=0 as a valid sentinel.
export function tokenIdField(
  desc: string = 'Collateral token ID (see get_assets)',
  opts?: { min?: number },
) {
  const min = opts?.min ?? 0;
  return z.number().int().min(min).describe(desc);
}

export function tokenIdFieldOptional(
  desc: string = 'Collateral token ID (see get_assets)',
  opts?: { min?: number },
) {
  const min = opts?.min ?? 0;
  return z.number().int().min(min).optional().describe(desc);
}

export function ammIdField(
  desc: string = 'AMM routing. 0 = orderbook-only; specific id = route that AMM. Required.',
) {
  return z.number().int().min(0).describe(desc);
}

export const TIMEFRAME_VALUES = ['5m', '1h', '1d', '1w'] as const;

export const TIMEFRAME_SECONDS: Record<(typeof TIMEFRAME_VALUES)[number], number> = {
  '5m': 300,
  '1h': 3600,
  '1d': 86400,
  '1w': 604800,
};

export function timeFrameField(opts?: {
  defaultValue?: (typeof TIMEFRAME_VALUES)[number];
  desc?: string;
}) {
  const desc =
    opts?.desc ??
    (opts?.defaultValue !== undefined
      ? `Candle time frame: 5m (5 minutes), 1h (1 hour), 1d (1 day), 1w (1 week). Default: ${opts.defaultValue}.`
      : 'Candle time frame');
  if (opts?.defaultValue !== undefined) {
    return z.enum(TIMEFRAME_VALUES).default(opts.defaultValue).describe(desc);
  }
  return z.enum(TIMEFRAME_VALUES).describe(desc);
}

// UNIX seconds guard — >1e12 catches LLMs emitting milliseconds.
const UNIX_SECONDS_REFINE = (v: number) => v <= 1e12;
const UNIX_SECONDS_REFINE_MSG = 'must be UNIX seconds, not milliseconds (saw a value > 1e12)';

export function unixTimestampField(label: string, desc?: string) {
  return z
    .number()
    .int()
    .nonnegative()
    .refine(UNIX_SECONDS_REFINE, { message: `${label} ${UNIX_SECONDS_REFINE_MSG}` })
    .describe(desc ?? `${label} (Unix seconds; not milliseconds)`);
}

export function unixTimestampFieldOptional(label: string, desc?: string) {
  return z
    .number()
    .int()
    .nonnegative()
    .refine(UNIX_SECONDS_REFINE, { message: `${label} ${UNIX_SECONDS_REFINE_MSG}` })
    .optional()
    .describe(desc ?? `${label} (Unix seconds; not milliseconds)`);
}

export const FilterConditionSchema = z.object({
  field: z
    .enum([
      'marketId', 'status', 'underlyingSymbol', 'fundingRateSymbol',
      'volume24h', 'notionalOI', 'markApr', 'lastTradedApr', 'midApr',
      'floatingApr', 'timeToMaturity', 'maturity',
    ])
    .describe('Field to filter on'),
  op: z.enum(['=', '!=', '>', '<', '>=', '<=', 'LIKE']).describe('Comparison operator. LIKE is a case-insensitive substring match (NOT SQL wildcards) — leading/trailing `%` and `_` are stripped, so `"ETH"`, `"%ETH%"`, and `"eth"` all behave the same.'),
  value: z.union([z.string(), z.number()]).describe('Value to compare against'),
});

export const SortSchema = z.object({
  field: z
    .enum([
      'marketId', 'volume24h', 'notionalOI', 'markApr', 'midApr',
      'floatingApr', 'timeToMaturity',
    ])
    .describe('Field to sort by'),
  direction: z.enum(['asc', 'desc']).describe('Sort direction'),
});
