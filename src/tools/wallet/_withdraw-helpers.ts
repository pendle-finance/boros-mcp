// Helpers shared by withdraw + cancel_withdraw — cooldown block + best-effort pending-withdrawal lookup.
import type { Address } from 'viem';
import { openApiGet } from '../../api/open-api.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { BOROS_INTERNAL_DECIMALS, rawToHuman } from '../../utils.js';
import { fetchGlobalConfig } from '../../api/configs-cache.js';

// On-chain globalCooldown() has been 900 s continuously since 2026-04-08 (worst historical 3600).
const FALLBACK_MAX_COOLDOWN_HOURS = 0.25;

export async function buildCooldownBlock(root: Address): Promise<Record<string, unknown>> {
  const cfg = await fetchGlobalConfig(root);
  if (!cfg || typeof cfg.coolDown !== 'number' || !Number.isFinite(cfg.coolDown)) {
    return {
      note: 'Withdrawals are auto-finalized by a backend bot once the cooldown elapses — there is no separate claim step. backend config fetch failed, using fallback ceiling.',
      maxCooldownHours: FALLBACK_MAX_COOLDOWN_HOURS,
      source: 'fallback',
    };
  }
  const globalSec = cfg.coolDown;
  const personalSec =
    typeof cfg.personalCoolDown?.coolDown === 'number' && Number.isFinite(cfg.personalCoolDown.coolDown)
      ? cfg.personalCoolDown.coolDown
      : undefined;
  const effectiveSec = personalSec ?? globalSec;
  const isFlagged = personalSec != null && personalSec > globalSec;
  const toHours = (s: number) => Math.round((s / 3600) * 100) / 100;
  return {
    note: 'Withdrawals are auto-finalized by a backend bot once the cooldown elapses — there is no separate claim step. The on-chain personalCooldown can be longer than the global value if your account is flagged by the on-chain withdrawal-policy enforcement.',
    globalCooldownSeconds: globalSec,
    globalCooldownHours: toHours(globalSec),
    ...(personalSec !== undefined
      ? {
          personalCooldownSeconds: personalSec,
          personalCooldownHours: toHours(personalSec),
        }
      : {}),
    effectiveCooldownSeconds: effectiveSec,
    effectiveCooldownHours: toHours(effectiveSec),
    // Legacy field — kept for existing LLM prompts.
    maxCooldownHours: toHours(effectiveSec),
    isWithdrawalRestricted: isFlagged,
    source: 'live',
  };
}

// Enough rows to reach the pending withdrawal past any newer cash transfers on the same token.
const TRANSFER_LOG_LIMIT = 50;

// A withdrawal leaves the cross account for the wallet; `pending` marks the ones still in cooldown
// (fast-sync flips them to success/failed on finalize/cancel). Rows come newest-first.
function pickPendingWithdrawal(res: any, decimals: number, symbol: string) {
  const rows: any[] = Array.isArray(res?.results) ? res.results : [];
  const row = rows.find((r) => r?.toFundLocation?.fundType === 'wallet' && r?.status === 'pending');
  if (!row) return null;
  const raw18 = String(row.amount ?? '0');
  if (!/^[0-9]+$/.test(raw18) || BigInt(raw18) === 0n) return null;
  const ts = Number(row.blockTimestamp ?? 0);
  if (!ts) return null;
  // transfer-logs normalise every amount to 18d; convert back to token-native units so rawAmount
  // stays comparable with the calldata amount callers already hold.
  const raw = (
    (BigInt(raw18) * 10n ** BigInt(decimals)) /
    10n ** BigInt(BOROS_INTERNAL_DECIMALS)
  ).toString();
  if (BigInt(raw) === 0n) return null;
  return {
    rawAmount: raw,
    humanAmount: rawToHuman(raw, decimals),
    requestedAt: ts,
    requestedAtIso: new Date(ts * 1000).toISOString(),
    symbol,
  };
}

// Best-effort lookup of the user's pending withdrawal for tokenId; null when none.
export async function fetchPendingWithdrawal(
  userAddress: Address,
  accountId: number,
  tokenId: number,
  decimals: number,
  symbol: string,
): Promise<{
  rawAmount: string;
  humanAmount: string;
  requestedAt: number;
  requestedAtIso: string;
  symbol: string;
} | null> {
  try {
    const res = await fetchWithRetry(() =>
      openApiGet('/v1/accounts/transfer-logs', {
        root: userAddress,
        accountId,
        tokenId,
        limit: TRANSFER_LOG_LIMIT,
      }),
    );
    return pickPendingWithdrawal(res, decimals, symbol);
  } catch {
    return null;
  }
}

// Returns pending + indexer syncStatus.timestamp from the same /accounts/transfer-logs call.
// Used by cancel_withdraw to decide whether the absence-of-pending signal is trustworthy
// (fresh indexer) or possibly stale (recent withdraw still indexing).
export async function fetchPendingWithdrawalWithSync(
  userAddress: Address,
  accountId: number,
  tokenId: number,
  decimals: number,
  symbol: string,
): Promise<{
  pending: Awaited<ReturnType<typeof fetchPendingWithdrawal>>;
  syncTimestamp: number | undefined;
}> {
  try {
    const res = await fetchWithRetry(() =>
      openApiGet('/v1/accounts/transfer-logs', {
        root: userAddress,
        accountId,
        tokenId,
        limit: TRANSFER_LOG_LIMIT,
      }),
    );
    const syncTimestamp =
      typeof res?.syncStatus?.timestamp === 'number' ? res.syncStatus.timestamp : undefined;
    return { pending: pickPendingWithdrawal(res, decimals, symbol), syncTimestamp };
  } catch {
    return { pending: null, syncTimestamp: undefined };
  }
}
