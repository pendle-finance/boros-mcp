// Port of @pendle/boros-offchain-math tick math
// getRateAtTick: (1.00005^(tickIndex * tickStep)) - 1, using 100-digit precision
// estimateTickForRate: inverse via ln approximation + correction

const PRECISION = 10n ** 100n;
const BASE = (100005n * PRECISION) / 100000n; // 1.00005 at 10^100 precision
const RAW_ONE = 10n ** 18n; // FixedX18 scale
const PRECISION_SHIFT = PRECISION / RAW_ONE;

function getRateAtAbsTick(absTickIndex: bigint, tickStep: bigint): bigint {
  let tickIndex = absTickIndex * tickStep;
  let base = BASE;
  let rawAns = PRECISION;
  for (; tickIndex > 0n; tickIndex >>= 1n, base = (base * base) / PRECISION) {
    if (tickIndex & 1n) {
      rawAns = (rawAns * base) / PRECISION;
    }
  }
  rawAns -= PRECISION; // subtract 1.0
  return (rawAns + PRECISION_SHIFT / 2n) / PRECISION_SHIFT; // convert to 18-decimal
}

/** Returns rate as a FixedX18 raw bigint (18 decimals). Positive for tick >= 0, negative for tick < 0. */
export function getRateAtTickRaw(tickIndex: bigint, tickStep: bigint): bigint {
  if (tickIndex === 0n) return 0n;
  const abs = tickIndex < 0n ? -tickIndex : tickIndex;
  const rate = getRateAtAbsTick(abs, tickStep);
  return tickIndex < 0n ? -rate : rate;
}

/** Returns rate as a JS number (e.g. 0.05 for 5%). */
export function getRateAtTick(tickIndex: bigint | number, tickStep: bigint | number): number {
  return Number(getRateAtTickRaw(BigInt(tickIndex), BigInt(tickStep))) / 1e18;
}

/** Estimates the tick for a given rate (JS number, e.g. 0.05 for 5%). */
export function estimateTickForRate(rate: number, tickStep: bigint | number, roundDown: boolean): bigint {
  const step = BigInt(tickStep);
  if (rate === 0) return 0n;

  const isPositive = rate > 0;
  const absRate = Math.abs(rate);

  // ln(absRate + 1) / ln(1.00005) gives us the raw tick (before dividing by tickStep)
  const rawTick = Math.log(absRate + 1) / Math.log(1.00005);
  const adjustedRoundDown = roundDown === isPositive;

  let tick: bigint;
  if (adjustedRoundDown) {
    tick = BigInt(Math.floor(rawTick)) / step;
  } else {
    tick = (BigInt(Math.ceil(rawTick)) + step - 1n) / step;
  }

  // Binary search correction: check tick-1 and tick+1 (bounded to prevent infinite loops)
  const rateRaw = BigInt(Math.round(rate * 1e18));
  const MAX_CORRECTIONS = 20;
  if (adjustedRoundDown) {
    // Round down: find largest tick where getRateAtTickRaw(tick) <= rateRaw
    for (let i = 0; i < MAX_CORRECTIONS && getRateAtTickRaw(tick + 1n, step) <= rateRaw; i++) tick++;
    for (let i = 0; i < MAX_CORRECTIONS && getRateAtTickRaw(tick, step) > rateRaw; i++) tick--;
  } else {
    // Round up: find smallest tick where getRateAtTickRaw(tick) >= rateRaw
    for (let i = 0; i < MAX_CORRECTIONS && getRateAtTickRaw(tick - 1n, step) >= rateRaw; i++) tick--;
    for (let i = 0; i < MAX_CORRECTIONS && getRateAtTickRaw(tick, step) < rateRaw; i++) tick++;
  }

  return isPositive ? tick : -tick;
}
