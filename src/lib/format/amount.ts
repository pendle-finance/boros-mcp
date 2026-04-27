import { BorosErrorCode, throwBorosError } from '../../agent/errors.js';

// Boros normalizes every collateral/LP unit to 18d internally regardless of ERC-20 native decimals.
export const BOROS_INTERNAL_DECIMALS = 18;

// Reject neg/sci/whitespace/multi-dot. Bare BigInt() would silently accept '-1' or throw → UNKNOWN.
const SIZE_RE = /^\d+(?:\.\d+)?$/;

export function parseSize(size: string): bigint {
  if (typeof size !== 'string' || !SIZE_RE.test(size)) {
    throwBorosError(
      BorosErrorCode.INVALID_PARAMS,
      `Invalid size "${size}" — must be a non-negative decimal (e.g. "0", "1", "1.5"). ` +
      `Do not include signs, whitespace, scientific notation, or thousands separators.`,
    );
  }
  const parts = size.split('.');
  const whole = parts[0] ?? '0';
  let frac = parts[1] ?? '';
  if (frac.length > 18) frac = frac.slice(0, 18);
  frac = frac.padEnd(18, '0');
  return BigInt(whole) * 10n ** 18n + BigInt(frac);
}

export function formatSize(raw: bigint | string): string {
  const val = BigInt(raw);
  const negative = val < 0n;
  const abs = negative ? -val : val;
  const whole = abs / 10n ** 18n;
  const frac = abs % 10n ** 18n;
  const sign = negative ? '-' : '';
  if (frac === 0n) return `${sign}${whole.toString()}`;
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return `${sign}${whole}.${fracStr}`;
}

// toFixed(decimals) so 1e-7 USDC round-trips through BigInt (Number.toString → "1e-7" else).
export function humanToRaw(humanAmount: number, decimals: number): string {
  if (!Number.isFinite(humanAmount) || humanAmount < 0) {
    throwBorosError(
      BorosErrorCode.INVALID_PARAMS,
      `Invalid humanAmount ${humanAmount} — must be a non-negative finite number.`,
    );
  }
  const fixed = humanAmount.toFixed(decimals);
  const parts = fixed.split('.');
  const whole = parts[0] ?? '0';
  let frac = parts[1] ?? '';
  if (frac.length > decimals) frac = frac.slice(0, decimals);
  frac = frac.padEnd(decimals, '0');
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac);
  return raw.toString();
}

export function rawToHuman(raw: string | bigint, decimals: number): string {
  const val = BigInt(raw);
  const negative = val < 0n;
  const abs = negative ? -val : val;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const sign = negative ? '-' : '';
  if (frac === 0n) return `${sign}${whole.toString()}`;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${whole}.${fracStr}`;
}

// X18 decoder for ALL Boros collateral bigints (cash/margin/pnl/positionValue/fees/etc.).
// USD conversion: × asset.usdPrice AFTER formatting. New code should brand wire via asX18().
export function formatX18(raw: string | bigint | number | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    return rawToHuman(typeof raw === 'number' ? BigInt(Math.trunc(raw)) : raw, BOROS_INTERNAL_DECIMALS);
  } catch {
    return undefined;
  }
}

// Raw USD fields (gasFeeUsd, orderGasCostUsd) carry float noise (0.100000000000001) — round uniformly.
export function formatUsd6(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Number(n.toFixed(6));
}

export function resolveAmount(
  rawAmount: string | undefined,
  humanAmount: number | undefined,
  decimals: number,
): string {
  // Mutex: providing both is ambiguous (50× under-deposit reported for amount=100000 + humanAmount=5).
  if (rawAmount !== undefined && humanAmount !== undefined) {
    throwBorosError(
      BorosErrorCode.INVALID_PARAMS,
      `Provide either \`amount\` or \`humanAmount\`, not both. Got amount=${rawAmount}, humanAmount=${humanAmount}.`,
    );
  }
  if (rawAmount) {
    if (!/^\d+$/.test(rawAmount)) {
      throwBorosError(
        BorosErrorCode.INVALID_PARAMS,
        `Invalid raw amount "${rawAmount}" — must be a non-negative integer string (token smallest unit).`,
      );
    }
    return rawAmount;
  }
  if (humanAmount !== undefined) return humanToRaw(humanAmount, decimals);
  throwBorosError(BorosErrorCode.INVALID_PARAMS, 'Either amount or humanAmount must be provided');
}
