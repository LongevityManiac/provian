/**
 * Demotion hold — a metered act being demoted cannot settle while the demotion is in flight
 * (, after the standard-lane settlement was run by hand mid-demotion and minted 95
 * proven duplicates the run was about to withdraw).
 *
 * The hold lives ON the pending claims it guards: opening it writes `demotion_hold` onto every
 * claim that carries an act about to be demoted, in one transaction that requires each to be
 * `pending`. That write is the guard for every settlement path at once — the scheduled run, a run
 * triggered by hand from anywhere, and an on-demand payout all go through `runMeterClaimInlet`,
 * which
 * - skips a claim whose hold is live (`isDemotionHeld`), and
 * - takes claims with a write conditioned on the version its scan read, so a hold opened after
 * the scan (it changed the claim) fails that take and leaves the chunk to the next run.
 * The demotion itself refuses to execute unless every pending claim of its act carries the run's
 * live hold (`meter-act-bug-demotion.ts`), so no demotion runs unguarded.
 *
 * A hold expires (`expires_at_ms`, at most `DEMOTION_HOLD_MAX_TTL_MS`) so a run that died cannot
 * strand earnings; an expired hold guards nothing, and a demotion under it is refused. Releasing
 * sets the run's own hold to null (no other run's). The field is outside the claim's integrity commitment and the
 * demotion's trim merges, so a trimmed claim keeps it.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { METER_PENDING_CLAIMS_COLLECTION } from './meter-store';

export const DEMOTION_HOLD_FIELD = 'demotion_hold';
export const DEMOTION_HOLD_DEFAULT_TTL_MS = 60 * 60 * 1000;
export const DEMOTION_HOLD_MAX_TTL_MS = 6 * 60 * 60 * 1000;
/** Claims written per hold transaction (Firestore's 500-write bound, with room). */
const HOLD_CHUNK = 400;

export interface DemotionHold {
  readonly hold_id: string;
  readonly opened_at_ms: number;
  readonly expires_at_ms: number;
  readonly reason: string;
}

function isHold(v: unknown): v is DemotionHold {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.hold_id === 'string' && o.hold_id.length > 0
    && typeof o.opened_at_ms === 'number' && typeof o.expires_at_ms === 'number' && typeof o.reason === 'string';
}

/** The claim's live hold, or null (none, malformed, or expired). */
export function liveDemotionHold(claim: Record<string, unknown>, nowMs: number): DemotionHold | null {
  const h = claim[DEMOTION_HOLD_FIELD];
  if (h === undefined || h === null) return null;
  if (!isHold(h)) return null;
  return h.expires_at_ms > nowMs ? h : null;
}

/**
 * Whether settlement must leave the claim where it is. A field that is present but malformed holds
 * it too (unknown = block): only an absent field, null, or an expired well-formed hold releases it.
 */
export function isDemotionHeld(claim: Record<string, unknown>, nowMs: number): boolean {
  const h = claim[DEMOTION_HOLD_FIELD];
  if (h === undefined || h === null) return false;
  if (!isHold(h)) return true;
  return h.expires_at_ms > nowMs;
}

export type OpenHoldResult =
  | { readonly kind: 'opened'; readonly held: readonly string[]; readonly missing: readonly string[]; readonly expires_at_ms: number }
  | { readonly kind: 'refused'; readonly reason: string; readonly held_before_refusal: readonly string[] };

/**
 * Hold every listed claim. Each must exist-and-be-`pending` (or be absent — nothing to settle) and
 * carry no other live hold; the first that is not refuses, and every claim this call already held
 * is released again. Idempotent for the same `holdId` (it extends the expiry).
 */
export async function openDemotionHold(db: Firestore, input: {
  readonly claimKeys: readonly string[];
  readonly holdId: string;
  readonly reason: string;
  readonly nowMs: number;
  readonly ttlMs?: number;
}): Promise<OpenHoldResult> {
  const ttl = Math.min(Math.max(1, input.ttlMs ?? DEMOTION_HOLD_DEFAULT_TTL_MS), DEMOTION_HOLD_MAX_TTL_MS);
  const hold: DemotionHold = { hold_id: input.holdId, opened_at_ms: input.nowMs, expires_at_ms: input.nowMs + ttl, reason: input.reason };
  const keys = [...new Set(input.claimKeys)].sort();
  const held: string[] = [];
  const missing: string[] = [];
  for (let i = 0; i < keys.length; i += HOLD_CHUNK) {
    const chunk = keys.slice(i, i + HOLD_CHUNK);
    const refusal = await db.runTransaction(async (txn) => {
      const refs = chunk.map((k) => db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(k));
      const snaps = await Promise.all(refs.map((r) => txn.get(r)));
      const take: number[] = [];
      for (let j = 0; j < snaps.length; j += 1) {
        if (!snaps[j].exists) { missing.push(chunk[j]); continue; }
        const c = snaps[j].data() as Record<string, unknown>;
        if (c.state === 'void') { missing.push(chunk[j]); continue; }
        if (c.state !== 'pending') return `claim_not_pending:${chunk[j]}:${String(c.state)}`;
        const other = c[DEMOTION_HOLD_FIELD];
        if (other !== undefined && other !== null && (!isHold(other) || (other.hold_id !== input.holdId && other.expires_at_ms > input.nowMs))) {
          return `claim_held_by_another_demotion:${chunk[j]}`;
        }
        take.push(j);
      }
      for (const j of take) txn.update(refs[j], { [DEMOTION_HOLD_FIELD]: hold });
      return null;
    });
    if (refusal !== null) {
      await releaseDemotionHold(db, { claimKeys: held, holdId: input.holdId });
      return { kind: 'refused', reason: refusal, held_before_refusal: held };
    }
    for (const k of chunk) if (!missing.includes(k)) held.push(k);
  }
  return { kind: 'opened', held, missing, expires_at_ms: hold.expires_at_ms };
}

/**
 * Extend this run's hold on the listed claims to `nowMs + ttl`. Only a claim still `pending` and
 * still carrying this run's LIVE hold is extended; one that lost it (expired, then taken) is left
 * as it is and reported — the demotion of its act then refuses in its own transaction.
 */
export async function renewDemotionHold(db: Firestore, input: {
  readonly claimKeys: readonly string[];
  readonly holdId: string;
  readonly nowMs: number;
  readonly ttlMs?: number;
}): Promise<{ readonly renewed: number; readonly lost: readonly string[]; readonly expires_at_ms: number }> {
  const ttl = Math.min(Math.max(1, input.ttlMs ?? DEMOTION_HOLD_DEFAULT_TTL_MS), DEMOTION_HOLD_MAX_TTL_MS);
  const expiresAt = input.nowMs + ttl;
  let renewed = 0;
  const lost: string[] = [];
  const keys = [...new Set(input.claimKeys)];
  for (let i = 0; i < keys.length; i += HOLD_CHUNK) {
    const chunk = keys.slice(i, i + HOLD_CHUNK);
    await db.runTransaction(async (txn) => {
      const refs = chunk.map((k) => db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(k));
      const snaps = await Promise.all(refs.map((r) => txn.get(r)));
      for (let j = 0; j < snaps.length; j += 1) {
        if (!snaps[j].exists) continue;
        const c = snaps[j].data() as Record<string, unknown>;
        if (c.state === 'void') continue;
        const h = liveDemotionHold(c, input.nowMs);
        if (c.state !== 'pending' || h === null || h.hold_id !== input.holdId) { lost.push(chunk[j]); continue; }
        txn.update(refs[j], { [DEMOTION_HOLD_FIELD]: { ...h, expires_at_ms: expiresAt } });
        renewed += 1;
      }
    });
  }
  return { renewed, lost, expires_at_ms: expiresAt };
}

/** Clear this run's hold from the listed claims (another run's hold, or none, is left alone). */
export async function releaseDemotionHold(db: Firestore, input: {
  readonly claimKeys: readonly string[];
  readonly holdId: string;
}): Promise<{ readonly released: number }> {
  let released = 0;
  const keys = [...new Set(input.claimKeys)];
  for (let i = 0; i < keys.length; i += HOLD_CHUNK) {
    const chunk = keys.slice(i, i + HOLD_CHUNK);
    released += await db.runTransaction(async (txn) => {
      const refs = chunk.map((k) => db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(k));
      const snaps = await Promise.all(refs.map((r) => txn.get(r)));
      let n = 0;
      for (let j = 0; j < snaps.length; j += 1) {
        if (!snaps[j].exists) continue;
        const h = (snaps[j].data() as Record<string, unknown>)[DEMOTION_HOLD_FIELD];
        if (isHold(h) && h.hold_id === input.holdId) {
          txn.update(refs[j], { [DEMOTION_HOLD_FIELD]: null });
          n += 1;
        }
      }
      return n;
    });
  }
  return { released };
}
