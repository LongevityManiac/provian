import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * PE METER — where one act's earnings are, claim by claim (2026-10-04).
 *
 * An act's paying legs each sit in exactly one BASE claim (never counting its top-ups): its batch
 * claim, its own act claim (pre-fold), or — for a takeover-capable witness since the fold — its
 * batch's window claim, or the SLICE a settlement run cut its ready acts into (the parent's
 * `moved` names it). Every caller that asks "is this act's money still unregistered?" (the
 * / takeover), "take this act's share out" (a takeover or a bug demotion) or "has every
 * leg settled?" (the settlement writeback) resolves the legs here, so all of them read the same
 * documents and get the same answer.
 */

import type { DocumentReference, DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { actBaseClaimKeyOf, meterTopupClaimKey, type ActClaimHome, type MeterActLeg } from './meter-claims';
import { METER_ACT_KEYS_COLLECTION, METER_PENDING_CLAIMS_COLLECTION, type MeterPendingClaim } from './meter-store';

/** Reads one document: `db` outside a transaction, or `txn` inside one (both resolve a snapshot). */
export type ClaimReader = (ref: DocumentReference) => Promise<DocumentSnapshot>;

export interface ResolvedActLeg {
  readonly leg: MeterActLeg;
  /** The key of the claim that carries the act's share of this leg (the parent's when nothing carries it). */
  readonly key: string;
  readonly ref: DocumentReference;
  /** That claim, or null when it does not exist. */
  readonly claim: MeterPendingClaim | null;
  /** True when `claim` lists the act. */
  readonly carried: boolean;
}

function carries(claim: MeterPendingClaim | null, relayPeId: string): boolean {
  return claim !== null && Array.isArray(claim.acts) && claim.acts.some((a) => a.relay_pe_id === relayPeId);
}

/**
 * Every paying leg of an act, with the base claim that carries it. Two read rounds at most: the
 * first claim of each leg, then — for a window act a run has cut into a slice — the slice.
 */
export async function resolveActBaseClaims(
  db: Firestore,
  read: ClaimReader,
  key: ActClaimHome,
): Promise<ResolvedActLeg[]> {
  if (key.legs === null) return [];
  const first: { leg: MeterActLeg; key: string; ref: DocumentReference }[] = [];
  for (const leg of key.legs) {
    const k = actBaseClaimKeyOf(key, leg);
    if (k !== null) first.push({ leg, key: k, ref: db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(k) });
  }
  const snaps = await Promise.all(first.map((f) => read(f.ref)));
  const out: ResolvedActLeg[] = [];
  const second: { index: number; leg: MeterActLeg; key: string; ref: DocumentReference }[] = [];
  first.forEach((f, i) => {
    const claim = snaps[i].exists ? (snaps[i].data() as MeterPendingClaim) : null;
    const isCarried = carries(claim, key.relay_pe_id);
    const movedTo = !isCarried && claim !== null && key.unit === 'window' ? claim.moved?.[key.relay_pe_id] : undefined;
    if (typeof movedTo === 'string' && movedTo.length > 0) {
      second.push({ index: out.length, leg: f.leg, key: movedTo, ref: db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(movedTo) });
    }
    out.push({ leg: f.leg, key: f.key, ref: f.ref, claim, carried: isCarried });
  });
  if (second.length > 0) {
    const sliceSnaps = await Promise.all(second.map((s) => read(s.ref)));
    second.forEach((s, j) => {
      const claim = sliceSnaps[j].exists ? (sliceSnaps[j].data() as MeterPendingClaim) : null;
      out[s.index] = { leg: s.leg, key: s.key, ref: s.ref, claim, carried: carries(claim, key.relay_pe_id) };
    });
  }
  return out;
}

/**
 * True while NONE of an act's earnings has left `pending` every paying leg's base claim exists,
 * is still `pending`, and still carries the act. This is the meter's "the incumbent has not
 * registered" for the / takeover — a claim taken into a payout (`aggregated`),
 * registered or settled is committed to mint, and a slice exists only once a run took the act.
 * Fails closed: a missing claim, a claim that no longer lists the act, or any other state is
 * committed (no takeover). An act with no paying leg has nothing registered.
 */
export function actClaimsUncommitted(legs: readonly ResolvedActLeg[]): boolean {
  return legs.every((l) => l.claim !== null && l.carried && l.claim.state === 'pending');
}

export interface ResolvedActTopup {
  readonly leg: MeterActLeg;
  readonly key: string;
  readonly ref: DocumentReference;
  /** The leg's top-up claim (`mt_<pe>_<leg>`), or null when no corroboration lifted the act. */
  readonly claim: MeterPendingClaim | null;
}

/** The top-up claim of every paying leg of an act (one read round). */
export async function resolveActTopupClaims(
  db: Firestore,
  read: ClaimReader,
  key: ActClaimHome,
): Promise<ResolvedActTopup[]> {
  if (key.legs === null) return [];
  const legs = key.legs.map((leg) => {
    const k = meterTopupClaimKey(key.relay_pe_id, leg.leg);
    return { leg, key: k, ref: db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(k) };
  });
  const snaps = await Promise.all(legs.map((l) => read(l.ref)));
  return legs.map((l, i) => ({ ...l, claim: snaps[i].exists ? (snaps[i].data() as MeterPendingClaim) : null }));
}

/**
 * True while none of an act's TOP-UPS has left `pending` (or been voided): a corroboration lift a
 * run has taken into a payout, registered or settled is committed to mint, so the act is
 * registered exactly as it is when one of its base claims is — a takeover would then mint the
 * taker's base on top of the incumbent's lift. No top-up at all is uncommitted.
 */
export function actTopupsUncommitted(topups: readonly ResolvedActTopup[]): boolean {
  return topups.every((t) => t.claim === null || t.claim.state === 'pending' || t.claim.state === 'void');
}

/**
 * The takeover pre-check's question for a METERED incumbent: true while none of its earnings has
 * left `pending` — neither a base claim (`actClaimsUncommitted`) nor a top-up
 * (`actTopupsUncommitted`). Null when the act has no meter key (a pre-meter row: the caller asks
 * the legacy claim ledger, as it always did).
 */
export async function meterActUnregistered(db: Firestore, relayPeId: string): Promise<boolean | null> {
  const snap = await privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(relayPeId).get();
  if (!snap.exists) return null;
  const key = snap.data() as ActClaimHome;
  const read: ClaimReader = (ref) => ref.get();
  const [base, topups] = await Promise.all([resolveActBaseClaims(db, read, key), resolveActTopupClaims(db, read, key)]);
  return actClaimsUncommitted(base) && actTopupsUncommitted(topups);
}
