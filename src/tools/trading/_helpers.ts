// TIF wire codes for Router (OrderInput.tif) + open-api `tif` field. MCP uses strings; translate at boundary.
export const TIF_MAP = {
  GTC: 0,
  IOC: 1,
  FOK: 2,
  ALO: 3,
  SOFT_ALO: 4,
} as const;

export type TifWireCode = (typeof TIF_MAP)[keyof typeof TIF_MAP];

// Side wire codes — numeric end-to-end (backend dropped PlaceOrderSide wrapper).
export const SIDE_MAP = {
  LONG: 0,
  SHORT: 1,
} as const;

export type SideWireCode = (typeof SIDE_MAP)[keyof typeof SIDE_MAP];

// Wire numeric side → MCP label. undefined for non 0/1 so callers can spread conditionally.
export function sideLabelFromWire(code: unknown): SideStr | undefined {
  if (code === 0) return 'LONG';
  if (code === 1) return 'SHORT';
  return undefined;
}

export type SideStr = 'LONG' | 'SHORT';
export type TifStr = 'GTC' | 'IOC' | 'FOK' | 'ALO' | 'SOFT_ALO';

// Best-effort BigInt parse — undefined on failure so we skip a bound rather than throw.
export function tryBigInt(x: unknown): bigint | undefined {
  try { return BigInt(x as any); } catch { return undefined; }
}

// Market orders default FOK (backend treats ONLY FOK as market: isMarketOrder = tif===FOK).
// IOC hits limit branch and errors without rate. For partial-fill: IOC + explicit limitApr.
export function tifString(orderType: string, override?: TifStr): TifStr {
  if (override) return override;
  return orderType === 'limit' ? 'GTC' : 'FOK';
}

// Throws on unknown side so upstream bugs surface instead of silently picking a direction.
export function flipSideString(side: SideStr): SideStr {
  switch (side) {
    case 'LONG': return 'SHORT';
    case 'SHORT': return 'LONG';
    default: {
      const err: any = new Error(`flipSideString received unknown side: ${side as string}`);
      err.__borosCode = 'INVALID_PARAMS';
      throw err;
    }
  }
}

// Soft "did you mean 0.05 instead of 5?" hint when limitApr looks like a percent (|x|>1).
export function limitAprWarning(limitApr: number | undefined): string | undefined {
  if (limitApr === undefined || !Number.isFinite(limitApr)) return undefined;
  const abs = Math.abs(limitApr);
  if (abs <= 1) return undefined;
  return `limitApr=${limitApr} looks like a percent, not a decimal. The API expects a decimal (0.05 = 5%). ` +
    `If you meant ${limitApr}% pass ${limitApr / 100} instead. Proceeding as ${(limitApr * 100).toFixed(2)}%.`;
}
