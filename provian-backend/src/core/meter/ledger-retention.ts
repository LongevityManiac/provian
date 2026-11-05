/**
 * PE METER — how long a SETTLED meter claim's ledger row is kept (, ruling item 7:
 * "Batch records go once settled and anchored").
 *
 * A settled row of `pvt9_claim_ledger_v1` whose `pe_id` is a meter claim key (`mb_` / `ma_` /
 * `mt_`) gets a Timestamp `expire_at` when it is written settled, and Firestore's TTL then drops
 * it. The kernel's `claimSettled` is the permanent mint-once; the ledger row only has to outlive
 * every path that could otherwise REGISTER OR RE-PLAN the same claim. If one did after the row was
 * gone, nothing could double-mint (the kernel refuses a settled claim) — but `ClaimAlreadySettled`
 * reverts the WHOLE settlement batch, so a re-registered settled claim would wedge every claim
 * batched with it, run after run. That liveness failure is what the inequality below rules out.
 *
 * THE INEQUALITY (every window measured from the claim's settlement, its latest possible end):
 *
 * SETTLED_METER_LEDGER_ROW_LIFETIME_MS > max(window ends) + FIRESTORE_TTL_DELETION_LAG_MS
 *
 * The lag term is there because a window's own documents are deleted by TTL, which may run after
 * their `expire_at`; the ledger row must be the LAST to go. The windows:
 * - the settled pending claim (`meter_pending_claims_v1`, state `settled`, 30 days past
 * settlement): while it exists the approval gate still admits it for re-approval after a reorg;
 * - claim creation: a pending claim is created only in the commit that creates its act's key, and
 * only for an act inside the 30-day mint window; an act key (and its mint-once claims) lives 31
 * days past the act's occurrence, which is never later than settlement + the clock-skew bound
 * (a Genesis act key lives 31 days past its mint writeback, but Genesis claims are not meter
 * keys and are never given an expiry here);
 * - the corroboration top-up horizon: 30 days from record time (≤ settlement);
 * - a staged relay act (`meter_relay_acts_v1`, 7 days): the replay sweep re-prices only through
 * the act key, which refuses a second key;
 * - reorg reversal: a settle is applied only at the safe head and re-checked by the finality
 * sweep; `SETTLEMENT_REORG_HORIZON_MS` is a deliberately generous bound on how late a reorg
 * reversal of an applied batch can run (Base L2 blocks are final on L1 within hours).
 * Not windows, and why:
 * - the meter inlet registers only `pending`-state claims, and a claim leaves `pending` before its
 * row can be settled (the approval gate refuses a `pending` claim);
 * - `auditLedgerSinceWatermark` reads rows created since its watermark, never old ones;
 * - the legacy migration's `ledgerStateOf` reads LEGACY claim keys (`pe_…#leg`), which are never
 * given an expiry; the migration (running at the time of this change) retires a PE in the same
 * transaction that creates its meter claims, so it can never plan the same act twice. Rows
 * settled BEFORE this change carry no `expire_at`; once the migration has finished they can be
 * given one by `scripts/ledger-settled-expiry-backfill.ts` (not run automatically).
 */

import { Timestamp } from 'firebase-admin/firestore';
import { isMeterClaimKey } from './meter-claims';
import {
  DAY_MS,
  METER_KEY_LIFETIME_MS,
  METER_MAX_FUTURE_SKEW_MS,
  METER_RELAY_ACT_LIFETIME_MS,
  METER_SETTLED_CLAIM_LIFETIME_MS,
} from './meter-store';
import { METER_MINT_WINDOW_MS } from './meter-wire';
import { ATTESTATION_ENHANCEMENT_HORIZON_MS } from '../pvt/policy/monetary-accounting';

/** A settled meter claim's ledger row lives this long past its settlement. */
export const SETTLED_METER_LEDGER_ROW_LIFETIME_MS = 45 * DAY_MS;
/** Generous bound on how late after settlement a reorg reversal of an applied batch can run. */
export const SETTLEMENT_REORG_HORIZON_MS = 7 * DAY_MS;
/** Firestore deletes an expired document "typically within 24 hours"; three days of margin. */
export const FIRESTORE_TTL_DELETION_LAG_MS = 3 * DAY_MS;

export interface RetentionWindow {
  readonly name: string;
  /** The latest the window can end, measured from the claim's settlement. */
  readonly endAfterSettlementMs: number;
}

/** Every window that must close before a settled meter claim's ledger row may go. */
export function meterLedgerRetentionWindows(): readonly RetentionWindow[] {
  return [
    { name: 'settled pending claim (re-approval after a reorg)', endAfterSettlementMs: METER_SETTLED_CLAIM_LIFETIME_MS },
    { name: 'act key + mint-once claims (occurrence + 31 d, occurrence <= settlement + skew)', endAfterSettlementMs: METER_KEY_LIFETIME_MS + METER_MAX_FUTURE_SKEW_MS },
    { name: 'claim creation (30-day mint window from occurrence)', endAfterSettlementMs: METER_MINT_WINDOW_MS + METER_MAX_FUTURE_SKEW_MS },
    { name: 'corroboration top-up horizon (record time + 30 d)', endAfterSettlementMs: ATTESTATION_ENHANCEMENT_HORIZON_MS },
    { name: 'staged relay act replay', endAfterSettlementMs: METER_RELAY_ACT_LIFETIME_MS },
    { name: 'reorg reversal of the applied batch', endAfterSettlementMs: SETTLEMENT_REORG_HORIZON_MS },
  ];
}

/** The windows a lifetime fails to outlast (with the TTL deletion lag). Empty = safe. */
export function ledgerRetentionViolations(
  lifetimeMs: number,
  windows: readonly RetentionWindow[],
  ttlLagMs: number = FIRESTORE_TTL_DELETION_LAG_MS,
): string[] {
  if (windows.length === 0) return ['no windows evaluated'];
  return windows
    .filter((w) => !(lifetimeMs > w.endAfterSettlementMs + ttlLagMs))
    .map((w) => `${w.name}: ${w.endAfterSettlementMs + ttlLagMs} >= ${lifetimeMs}`);
}

/**
 * The expiry a ledger row gets when it is written settled: only a meter claim's, never a legacy
 * or Genesis row's. Spread into the settled write.
 */
export function settledLedgerRowExpiry(peId: string, settledAtMs: number): { expire_at?: Timestamp } {
  return isMeterClaimKey(peId) ? { expire_at: Timestamp.fromMillis(settledAtMs + SETTLED_METER_LEDGER_ROW_LIFETIME_MS) } : {};
}

/** A row returned to unsettled (reorg reversal) never expires. */
export function unsettledLedgerRowExpiry(peId: string): { expire_at?: null } {
  return isMeterClaimKey(peId) ? { expire_at: null } : {};
}
