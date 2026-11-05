/**
 * The `wallets` fields the network-stats leaderboard ranks on, declared ONCE.
 *
 * `pe_count` has always been maintained on the wallet document by the durable
 * accrual effects. The WEEKLY pair is new (H2 close-out): the all-time
 * board ranks by `pe_count`, the weekly board used to rank by `pvt_accrual.
 * weeklyPEs` which lives on a DIFFERENT collection keyed by userId/agentId,
 * so ranking wallets by it meant scanning every accrual document and joining
 * in memory. Keeping the weekly count on the wallet itself lets the weekly
 * board be one bounded, indexed query.
 *
 * The roll rule mirrors `nextAgentAccrual` exactly: same week → +1, any other
 * (or absent) week → 1. The equality guard on `weekly_week_start` at read time
 * is what keeps the weekly board honest — a wallet inactive this week carries
 * last-active-week's count under a stale week start and never matches.
 *
 * Both the writer (`durable-accrual-effects.ts`) and the reader
 * (`network-stats-projection.ts`) import these names; the composite index in
 * `firestore.indexes.json` is (weekly_week_start ASC, weekly_pe_count DESC).
 */

import { getWeekStart } from './week-start';

export const WALLET_PE_COUNT_FIELD = 'pe_count';
export const WALLET_WEEKLY_PE_COUNT_FIELD = 'weekly_pe_count';
export const WALLET_WEEKLY_WEEK_START_FIELD = 'weekly_week_start';

export interface WalletWeeklyCounter {
  readonly [WALLET_WEEKLY_PE_COUNT_FIELD]: number;
  readonly [WALLET_WEEKLY_WEEK_START_FIELD]: number;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The weekly counter after ONE more PE at `timestampMs`, given the wallet's prior fields. */
export function nextWalletWeeklyCounter(
  prior: Record<string, unknown> | undefined,
  timestampMs: number,
): WalletWeeklyCounter {
  const weekStart = getWeekStart(timestampMs);
  const priorWeek = numberOrNull(prior?.[WALLET_WEEKLY_WEEK_START_FIELD]);
  const priorCount = numberOrNull(prior?.[WALLET_WEEKLY_PE_COUNT_FIELD]) ?? 0;
  return {
    [WALLET_WEEKLY_PE_COUNT_FIELD]: priorWeek === weekStart ? priorCount + 1 : 1,
    [WALLET_WEEKLY_WEEK_START_FIELD]: weekStart,
  };
}

/** Read a wallet's count for the CURRENT week; a stale week start reads as 0. */
export function currentWeekWalletCount(
  wallet: Record<string, unknown> | undefined,
  currentWeekStart: number,
): number {
  if (numberOrNull(wallet?.[WALLET_WEEKLY_WEEK_START_FIELD]) !== currentWeekStart) return 0;
  return numberOrNull(wallet?.[WALLET_WEEKLY_PE_COUNT_FIELD]) ?? 0;
}
