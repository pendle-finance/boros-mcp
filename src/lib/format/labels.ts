// Mirrors Boros UI ORDER_STATUSES. Wire 0="Filling"; UI emits 'partially_filled' unconditionally.
// We split 0 → 'open' (zero fills) vs 'partially_filled' so LLM can see whether size moved.
const ORDER_STATUS_LABELS: Record<number, string> = {
  0: 'partially_filled', // overridden to 'open' by orderStatusLabel when zero-filled
  1: 'cancelled',
  2: 'filled',
  3: 'expired',
  4: 'purged',
  5: 'pending',
  6: 'executing',
  7: 'retrying',
  8: 'failed',
};

interface OrderStatusContext {
  placedSize?: string | number | bigint | null;
  unfilledSize?: string | number | bigint | null;
  filledSize?: string | number | bigint | null;
}

function isZeroFilled(order: OrderStatusContext): boolean {
  // dapp derives filledSize = placedSize - unfilledSize.
  if (order.filledSize !== undefined && order.filledSize !== null) {
    try { return BigInt(order.filledSize.toString()) === 0n; } catch { /* fall through */ }
  }
  if (order.placedSize !== undefined && order.placedSize !== null &&
      order.unfilledSize !== undefined && order.unfilledSize !== null) {
    try {
      return BigInt(order.placedSize.toString()) === BigInt(order.unfilledSize.toString());
    } catch { /* fall through */ }
  }
  return false;
}

export function orderStatusLabel(
  code: number | undefined | null,
  order?: OrderStatusContext,
): string | undefined {
  if (code === null || code === undefined) return undefined;
  const base = ORDER_STATUS_LABELS[code];
  if (base === undefined) return 'unknown_status';
  if (code === 0 && order && isZeroFilled(order)) return 'open';
  return base;
}

// Labels round-trip via Zod enums on place_orders without remapping.
const TIME_IN_FORCE_LABELS: Record<number, string> = {
  0: 'GTC',
  1: 'IOC',
  2: 'FOK',
  3: 'ALO',
  4: 'SOFT_ALO',
};

export function timeInForceLabel(code: number | undefined | null): string | undefined {
  if (code === null || code === undefined) return undefined;
  return TIME_IN_FORCE_LABELS[code] ?? 'unknown_tif';
}
