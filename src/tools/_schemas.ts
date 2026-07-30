// Shared Zod field factories — validation rules locked here so error messages stay consistent across tools.
import { z } from 'zod';
import { ADDRESS_REGEX, MARKET_ACC_REGEX, type FilterCondition } from '../utils.js';

export type { FilterCondition };

const USER_ADDRESS_BASE = 'Your wallet address (0x...).';
const MARKET_ACC_BASE =
  'Packed marketAcc: 0x followed by 52 hex chars (54 chars total). Cross accounts carry 0xFFFFFF in the marketId segment.';

function appendNotes(base: string, notes?: string) {
  return notes ? `${base} ${notes}` : base;
}

export function userAddressField(notes?: string) {
  return z
    .string()
    .regex(ADDRESS_REGEX, 'userAddress must be 0x + 40 hex chars')
    .describe(appendNotes(USER_ADDRESS_BASE, notes));
}

export function userAddressFieldOptional(notes?: string) {
  return z
    .string()
    .regex(ADDRESS_REGEX, 'userAddress must be 0x + 40 hex chars')
    .optional()
    .describe(appendNotes(USER_ADDRESS_BASE, notes));
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

export function accountIdField(notes?: string) {
  return z
    .number()
    .int()
    .min(0)
    .max(255)
    .default(0)
    .describe(appendNotes('Account ID 0..255, default 0.', notes));
}

const MARKET_ID_BASE = 'Market ID (positive integer 1..2^24-1; resolve via get_markets).';

export function marketIdField(notes?: string) {
  return z
    .number()
    .int()
    .min(1)
    .max(0xFFFFFF)
    .describe(appendNotes(MARKET_ID_BASE, notes));
}

export function marketIdOptionalField(notes?: string) {
  return z
    .number()
    .int()
    .min(1)
    .max(0xFFFFFF)
    .optional()
    .describe(appendNotes(MARKET_ID_BASE, notes));
}

export function marketAccField(notes?: string) {
  return z
    .string()
    .regex(MARKET_ACC_REGEX, 'marketAcc must be 0x + 52 hex chars')
    .describe(appendNotes(MARKET_ACC_BASE, notes));
}

export function marketAccFieldOptional(notes?: string) {
  return z
    .string()
    .regex(MARKET_ACC_REGEX, 'marketAcc must be 0x + 52 hex chars')
    .optional()
    .describe(appendNotes(MARKET_ACC_BASE, notes));
}

export function slippageField(notes?: string) {
  return z
    .number()
    .min(0, 'slippage cannot be negative')
    .max(1, 'slippage > 1 — DECIMAL (0.05 = 5%), not 5')
    .optional()
    .describe(
      appendNotes(
        'Max slippage as DECIMAL (0.05 = 5%, NOT 5). Effective only for FOK market orders — backend silently ignores it for GTC/ALO/SOFT_ALO (those are guarded by limitApr/limitTick instead). If omitted, defaults per-market to 0.5 × market.maxRateDeviation (scales with markApr volatility), falling back to 5% only if market config is missing.',
        notes,
      ),
    );
}

export function marginModeField(notes?: string) {
  const base =
    "Margin mode. cross (default): one bucket per (root, accountId, tokenId) — shared across all entered markets for that token. isolated: per-market bucket keyed by marketId, walled off from cross. Move funds via cash_transfer. Some markets are isolated-only (`isIsolatedOnly:true` in get_markets) and reject cross — pass `'isolated'` for those.";
  return z.enum(['cross', 'isolated']).default('cross').describe(appendNotes(base, notes));
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

export function timeInForceField(notes?: string) {
  return z.enum(TIME_IN_FORCE_VALUES).optional().describe(appendNotes(TIME_IN_FORCE_DESCRIPTION, notes));
}

// Normalize `side` to uppercase wire form. calldata-verify uses its own lowercase string→0/1 enum
// (calldata-verify.ts:225); IntentExpectation builders map UPPER → lower at that edge.
export const sideSchema = z
  .enum(['long', 'short', 'LONG', 'SHORT'])
  .transform((s) => s.toUpperCase() as 'LONG' | 'SHORT')
  .describe('Trade direction (accepts either case)');

export function resumeTokenField() {
  return z.string().optional().describe('Cursor from previous response for next page.');
}

export function paginationLimitField(opts: { max: number; defaultValue: number; desc?: string }) {
  return z
    .number()
    .int()
    .min(1)
    .max(opts.max)
    .default(opts.defaultValue)
    .describe(opts.desc ?? `Max results (default ${opts.defaultValue}, capped at ${opts.max}).`);
}

// Boros mainnet genesis (UTC 2025-07-24). Backend rejects timestamps before this; see
// pendle-backend-v3 apps/open-api/src/events/dtos/events.dto.ts.
export const BOROS_GENESIS_EPOCH = 1753334471;

export function borosUnixTimestampField(label: string, desc?: string) {
  return z
    .number()
    .min(BOROS_GENESIS_EPOCH, `${label} must be >= ${BOROS_GENESIS_EPOCH} (Boros mainnet genesis — backend rejects earlier values)`)
    .refine(UNIX_SECONDS_REFINE, { message: `${label} ${UNIX_SECONDS_REFINE_MSG}` })
    .optional()
    .describe(desc ?? `${label} (Unix seconds inclusive; must be >= ${BOROS_GENESIS_EPOCH}, Boros mainnet genesis)`);
}

const TOKEN_ID_BASE = 'Collateral token ID (see get_assets).';

// Default min=1: backend TokenIdApiParam is IsInt()+Min(1) on all 9 DTOs, and there is no token 0
// (/v1/assets → 1-5; non-collateral rows report -1). 0 used to pass zod and 400 at the API.
export function tokenIdField(notes?: string, opts?: { min?: number }) {
  const min = opts?.min ?? 1;
  return z.number().int().min(min).describe(appendNotes(TOKEN_ID_BASE, notes));
}

export function tokenIdFieldOptional(notes?: string, opts?: { min?: number }) {
  const min = opts?.min ?? 1;
  return z.number().int().min(min).optional().describe(appendNotes(TOKEN_ID_BASE, notes));
}

export function ammIdField(notes?: string) {
  const base = 'AMM routing. 0 = orderbook-only; specific id = route that AMM. Required.';
  return z.number().int().min(0).describe(appendNotes(base, notes));
}

export function ammIdOptionalField(notes?: string) {
  const base = 'AMM ID (positive). Resolve via market info.';
  return z.number().int().positive().optional().describe(appendNotes(base, notes));
}

export const TIMEFRAME_VALUES = ['5m', '1h', '1d', '1w'] as const;

export const TIMEFRAME_SECONDS: Record<(typeof TIMEFRAME_VALUES)[number], number> = {
  '5m': 300,
  '1h': 3600,
  '1d': 86400,
  '1w': 604800,
};

export function timeFrameField(opts?: { defaultValue?: (typeof TIMEFRAME_VALUES)[number] }) {
  const defaultValue = opts?.defaultValue;
  const desc =
    defaultValue !== undefined
      ? `Candle time frame: 5m (5 minutes), 1h (1 hour), 1d (1 day), 1w (1 week). Default: ${defaultValue}.`
      : 'Candle time frame: 5m, 1h, 1d, 1w.';
  if (defaultValue !== undefined) {
    return z.enum(TIMEFRAME_VALUES).default(defaultValue).describe(desc);
  }
  return z.enum(TIMEFRAME_VALUES).describe(desc);
}

// UNIX seconds guard — >1e12 catches LLMs emitting milliseconds.
const UNIX_SECONDS_REFINE = (v: number) => v <= 1e12;
const UNIX_SECONDS_REFINE_MSG = 'must be UNIX seconds, not milliseconds (saw a value > 1e12)';

// min(1), not nonnegative: every consumer of the REQUIRED variant has @Min(1) server-side.
// Do NOT copy this to the Optional variant below — ohlcv/indicators legitimately accept 0.
export function unixTimestampField(label: string, desc?: string) {
  return z
    .number()
    .int()
    .min(1, `${label} must be >= 1 (backend rejects 0)`)
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

// Generic filter/sort schemas — each tool defines its own field allow-list as a
// `readonly [string, ...string[]]` tuple and passes it to these factories.
export function makeFilterSchema<F extends readonly [string, ...string[]]>(fields: F) {
  return z.object({
    field: z.enum(fields),
    op: z
      .enum(['=', '!=', '>', '<', '>=', '<=', 'LIKE'])
      .describe('LIKE = case-insensitive substring (NOT SQL wildcards) — leading/trailing % and _ stripped.'),
    value: z
      .union([z.string(), z.number()])
      .describe('Top-level field only; nested paths and booleans not supported.'),
  });
}

export function makeSortSchema<F extends readonly [string, ...string[]]>(
  fields: F,
  opts?: { defaultDirection?: 'asc' | 'desc' },
) {
  return z.object({
    field: z.enum(fields),
    direction: z
      .enum(['asc', 'desc'])
      .default(opts?.defaultDirection ?? 'desc')
      .describe('default desc'),
  });
}

export const MARKETS_FILTER_FIELDS = [
  'marketId', 'status', 'underlyingSymbol', 'fundingRateSymbol',
  'volume24h', 'notionalOI', 'markApr', 'lastTradedApr', 'midApr',
  'floatingApr', 'timeToMaturity', 'maturity',
] as const;
export const MARKETS_SORT_FIELDS = [
  'marketId', 'volume24h', 'notionalOI', 'markApr', 'midApr',
  'floatingApr', 'timeToMaturity',
] as const;

export const FilterConditionSchema = makeFilterSchema(MARKETS_FILTER_FIELDS);
export const SortSchema = makeSortSchema(MARKETS_SORT_FIELDS);
