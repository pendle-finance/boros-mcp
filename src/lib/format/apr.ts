import { getRateAtTick as getRateAtTickFn, estimateTickForRate as estimateTickForRateFn } from '../../chain/tick-math.js';
import { rawToHuman } from './amount.js';

export function aprToTick(apr: number, tickStep: bigint | number): bigint {
  return estimateTickForRateFn(apr, tickStep, false);
}

export function tickToApr(tick: bigint | number, tickStep: bigint | number): number {
  return getRateAtTickFn(tick, tickStep);
}

// APR as 18-dec bigint string ("-50009046703767357" → -0.05 = -5%). From /v1/accounts/*.
export function formatApr18(raw: string | bigint | number | null | undefined): { apr: number; aprPercent: string } | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    const human = rawToHuman(typeof raw === 'number' ? BigInt(Math.trunc(raw)) : raw, 18);
    const apr = Number(human);
    if (!Number.isFinite(apr)) return undefined;
    return { apr, aprPercent: `${(apr * 100).toFixed(4)}%` };
  } catch {
    return undefined;
  }
}

export function enrichApr(tick: bigint | number | undefined, tickStep: bigint | number) {
  if (tick === undefined || tick === null) return { tick: undefined, apr: undefined };
  return {
    tick: Number(tick),
    apr: tickToApr(tick, tickStep),
    aprPercent: `${(tickToApr(tick, tickStep) * 100).toFixed(4)}%`,
  };
}

export function enrichAprValue(value: number | undefined | null) {
  if (value === undefined || value === null) return undefined;
  return { aprPercent: `${(value * 100).toFixed(4)}%` };
}
