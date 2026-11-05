import { retainComplianceDecisions } from '../jurisdiction/location-retention';
import { evaluateMintCompliance } from '../jurisdiction/mint-compliance';
import { isCarriedOverLegacyClaim } from './meter-claims';
import { readyMeterClaimKeys, createIndexedMeterClaim, removeIndexedMeterClaims, updateIndexedReadiness } from './pending-claim-index';
import { readPackedMeterKeyPages, withPrivateReadSession } from '../provenance/private-store';
import { privateRetentionCollection, protectRetainedFields } from '../provenance/private-retention';
import { METER_KEY_LIFETIME_MS } from './meter-constants';
import { noteBatchClaimSettlement } from './batch-economics';
/**
 * PE METER — settling earnings that were never PEs at the relay.
 *
 * Three pieces, each the meter's half of a step the PVT9 settlement runtime already has:
 *
 * 1. INLET `runMeterClaimInlet` registers ready pending claims (`meter_pending_claims_v1`,
 * state `pending`) as ordinary standard-lane ledger rows. The row's `pe_id` is the
 * pending claim's key (`mb_…` / `mw_…` / `ma_…` / `mt_…` / `mp_…`), so `claimKeyOf`
 * keeps one row per claim and nothing downstream (selection, planning, reservation,
 * the kernel) can tell a meter claim from any other. Recovery escrow never holds a
 * claim : an agent registers whether or not it is escrowed. A window claim
 * is taken act by act: only the acts whose takeover windows have
 * closed, cut into a slice when others still wait.
 * 2. GATE `verifyMeterClaimMembers` is what the batch approver runs for a meter member in
 * place of re-deriving the claim id from a `pe_history` envelope: the pending claim
 * must be intact (its integrity commitment), on the member's leg, carry the claim id
 * the member settles, and that id must RE-DERIVE from the claim's own identity
 * (the batch hash — with the part, for a window claim — or the act's sealed identity
 * for act/top-up units). No act it
 * covers may have been demoted since (a takeover voids a claim; a voided claim
 * never settles).
 * 3. WRITEBACK `settleMeterClaims` marks the claims settled (they then expire in 30 days — the
 * kernel's `claimSettled` is the permanent dedupe) and, once every leg of an act is
 * settled, flips the act's row to `minted` with the economic-aggregate delta, exactly
 * as `writeLedgerSettlement` does for a `pe_history` row. A reorg reverses both.
 *
 * The kernel claim shape and the verifier digest are untouched: a meter claim is a
 * `(claimId, recordPointsAtomic)` under a `(contributor, beneficiaryClass)` recipient like any
 * other, and the digest the verifier signs never contained a PE.
 */

import {scanQueryUnordered,compareQueryDocuments} from '../provenance/query-pages';
import stableStringify from 'json-stable-stringify';
import type { DocumentReference, DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../pe-history';
import type { PayoutLegRole } from '../pvt/wp-ev/payout-legs';
import { EconomicAggregateWriter } from '../pvt/policy/economic-aggregate';
import { registerClaim } from '../pvt/wp4/durable-settlement-store';
import type { SettlementDb } from '../pvt/wp4/durable-settlement-store';
import { actKeyIdentity, type MeterActKeyDoc } from './meter-act-key';
import { actKeyOfPageAct, readBatchActPages } from './meter-act-pages';
import { resolveActBaseClaims, resolveActTopupClaims } from './act-claims';
import { LEGACY_PRE_METER_BATCH } from './meter-store';
import { isDemotionHeld } from './meter-demotion-hold';
import {
  actBaseClaimKeyOf,
  buildPayoutClaim,
  canonicalPayoutMembers,
  isMeterClaimKey,
  MAX_PAYOUT_MEMBERS,
  meterActClaimId,
  meterBatchClaimId,
  meterPayoutClaimId,
  meterTopupClaimId,
  meterTopupClaimKey,
  meterWindowClaimId,
  pendingClaimIntact,
  readyWindowActs,
  sliceWindowClaim,
} from './meter-claims';
import {
  expireAt,
  METER_ACT_KEYS_COLLECTION,
  METER_BATCHES_COLLECTION,
  METER_DEMOTED_ACT_STATUSES,
  METER_HELD_ACTS_COLLECTION,
  METER_PENDING_CLAIMS_COLLECTION,
  METER_SETTLED_CLAIM_LIFETIME_MS,
  type MeterPendingClaim,
} from './meter-store';

export { METER_SETTLED_CLAIM_LIFETIME_MS };

export { isMeterClaimKey };

const DEMOTED_STATUSES = METER_DEMOTED_ACT_STATUSES;

// ---------------------------------------------------------------------------
// 1. Inlet
// ---------------------------------------------------------------------------

export interface MeterInletReport {
  readonly scanned: number;
  /** Payout claims registered on the ledger this run (each settles one payee's ready claims). */
  readonly registered: number;
  readonly alreadyRegistered: number;
  readonly notReady: number;
  readonly tampered: readonly string[];
  readonly rejected: readonly { readonly claimKey: string; readonly reason: string }[];
  /** Pending claims taken into a payout claim this run. */
  readonly aggregated: number;
  /** Payout claims built this run. */
  readonly payouts: number;
  /** Pending claims left where they are because a demotion of one of their acts is in flight. */
  readonly held: number;
}

/**
 * One pending claim the inlet takes into a payout, as the scan read it: the version it read (its
 * `updateTime`, the precondition of the take), and — for a window parent only some of whose acts
 * are ready — the slice the take cuts and the parent it leaves.
 */
interface TakenClaim {
  readonly claim: MeterPendingClaim;
  readonly ref: DocumentReference;
  readonly readAt: FirebaseFirestore.Timestamp;
  readonly cut: ReturnType<typeof sliceWindowClaim> | null;
}

/** What a payout lists for a taken claim: the slice it cuts, or the claim itself. */
function memberOf(taken: TakenClaim): { claim_key: string; claim_id: string; points_atomic: string } {
  const source = taken.cut?.slice ?? taken.claim;
  return { claim_key: source.claim_key, claim_id: source.claim_id, points_atomic: source.record_points_atomic };
}

interface PayoutGroup {
  readonly leg: PayoutLegRole;
  readonly contributor: string;
  readonly beneficiary_class: number;
  readonly claims: TakenClaim[];
}

/** A take whose precondition no longer holds (a member changed since the scan, or a key exists). */
function isTakeConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  // NOT_FOUND (5), ALREADY_EXISTS (6), FAILED_PRECONDITION (9) — numeric from the server, or the
  // string form some client paths report.
  return code === 5 || code === 6 || code === 9
    || code === 'not-found' || code === 'already-exists' || code === 'failed-precondition';
}

/**
 * Registers the meter's earnings for settlement — ONE kernel claim per payee per run (PE meter
 * cost pass, 2026-10-04). Every ready pending claim (a batch's, a takeover-capable act's, a top-up)
 * of one (leg, address, beneficiary class) is taken into a single payout claim, in one transaction
 * that marks each member `aggregated` (so no member is ever in two payouts) and creates the payout;
 * the payout alone is registered on the ledger. An on-chain claim costs ~24k gas whatever it pays,
 * so one per payee per run instead of one per batch leg is the settlement's dominant saving. The
 * claim shape is unchanged: a payout is a `(claimId, recordPointsAtomic)` under its
 * `(contributor, beneficiaryClass)`, its id derived from its members' ids (`meterPayoutClaimId`).
 */
export type MeterInletOptions = {
    readonly nowMs: number;
    readonly pageSize?: number;
    readonly log?: (message: string) => void;
    /** — an on-demand payout registers only this payee's claims (lowercase address). */
    readonly contributor?: string;
    /** Scheduled runs aggregate only due payees; on-demand payout omits this filter. */
    readonly payeeDue?: (address: string) => Promise<boolean>;
  };
export function runMeterClaimInlet(db: Firestore, options: MeterInletOptions): Promise<MeterInletReport> {
  return withPrivateReadSession(() => runMeterClaimInletAttempt(db, options));
}
async function runMeterClaimInletAttempt(db: Firestore, options: MeterInletOptions): Promise<MeterInletReport> {
  const pageSize = options.pageSize ?? 500;
  const log = options.log ?? (() => {});
  let scanned = 0;
  let registered = 0;
  let alreadyRegistered = 0;
  let notReady = 0;
  let aggregated = 0;
  let payouts = 0;
  let held = 0;
  const tamperedDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  const rejected: { claimKey: string; reason: string }[] = [];
  const toRegister: MeterPendingClaim[] = [];
  const registerSources = new Map<string, DocumentSnapshot>();
  const groups = new Map<string, PayoutGroup>();
  const base = options.contributor !== undefined
    ? db.collection(METER_PENDING_CLAIMS_COLLECTION).where('contributor', '==', options.contributor.toLowerCase())
    : db.collection(METER_PENDING_CLAIMS_COLLECTION);
  const query = base.where('state', '==', 'pending').orderBy('claim_key', 'asc');
  const dueKeys = options.payeeDue && options.contributor === undefined ? await readyMeterClaimKeys(db, options.nowMs, options.payeeDue) : null;
  const queries = dueKeys === null ? [query] : Array.from({length:Math.ceil(dueKeys.length / 30)}, (_, i) => query.where('claim_key', 'in', dueKeys.slice(i * 30, i * 30 + 30)));
  // Scan at one pinned readTime. Physical alias order is immaterial until the complete set is read.
  for (const selected of queries) await scanQueryUnordered(selected, pageSize, async (doc) => {
    scanned += 1;
    const claim = doc.data() as MeterPendingClaim;
    if (!pendingClaimIntact(claim) || claim.claim_key !== doc.id) {
      tamperedDocs.push(doc);
      return;
    }
    if (options.contributor !== undefined && claim.contributor.toLowerCase() !== options.contributor.toLowerCase()) return;
    if (options.payeeDue && !await options.payeeDue(claim.contributor)) { notReady += 1; return; }
    // A payout built by an earlier run whose registration did not complete: register it as is.
    if (claim.unit === 'payout') {
      toRegister.push(claim);
      registerSources.set(claim.claim_key, doc);
      return;
    }
    // A demotion of one of its acts is in flight (meter-demotion-hold.ts): it does not settle until
    // the demotion has withdrawn the act's share and released the hold. A hold opened after this
    // scan changed the claim, so the take below — conditioned on the version read here — fails.
    if (isDemotionHeld(claim as unknown as Record<string, unknown>, options.nowMs)) {
      held += 1;
      return;
    }
    // : a window claim's acts each wait their own takeover window. All ready: the
    // claim is taken whole. Some ready: they are cut into a slice, and the rest keep waiting.
    let cut: TakenClaim['cut'] = null;
    if (claim.unit === 'window') {
      const ready = readyWindowActs(claim, options.nowMs);
      if (ready.length === 0) {
        notReady += 1;
        return;
      }
      if (ready.length < claim.acts.length) cut = sliceWindowClaim(claim, options.nowMs);
    } else if (claim.ready_at_ms > options.nowMs && !isCarriedOverLegacyClaim(claim)) {
      notReady += 1;
      return;
    }
    const groupKey = `${claim.leg}|${claim.contributor.toLowerCase()}|${claim.beneficiary_class}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = {
        leg: claim.leg as PayoutLegRole,
        contributor: claim.contributor.toLowerCase(),
        beneficiary_class: claim.beneficiary_class,
        claims: [],
      };
      groups.set(groupKey, group);
    }
    group.claims.push({ claim, ref: doc.ref, readAt: doc.updateTime, cut });
  });
  // Restore the old logical scan's observable order: existing payouts first, then groups ordered
  // by the first ORIGINAL claim key (window slicing may change the member key).
  toRegister.sort((a, b) => a.claim_key < b.claim_key ? -1 : a.claim_key > b.claim_key ? 1 : 0);
  const groupFirst = new Map([...groups.values()].map(g => [g, g.claims.reduce((min, t) => t.claim.claim_key < min ? t.claim.claim_key : min, g.claims[0].claim.claim_key)]));
  const orderedGroups = [...groups.values()].sort((a, b) => groupFirst.get(a)! < groupFirst.get(b)! ? -1 : groupFirst.get(a)! > groupFirst.get(b)! ? 1 : 0);
  const tampered = tamperedDocs.sort(compareQueryDocuments(query)).map(doc => doc.id);

  for (const group of orderedGroups) {
    const ordered = [...group.claims].sort((a, b) => {
      const ka = memberOf(a).claim_key;
      const kb = memberOf(b).claim_key;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    for (let i = 0; i < ordered.length; i += MAX_PAYOUT_MEMBERS) {
      const chunk = ordered.slice(i, i + MAX_PAYOUT_MEMBERS);
      const payout = buildPayoutClaim({
        leg: group.leg,
        contributor: group.contributor,
        beneficiary_class: group.beneficiary_class,
        members: chunk.map(memberOf),
        created_at_ms: options.nowMs,
      });
      // ONE atomic write takes the chunk. Every member must still be exactly the pending claim
      // this run's scan read — each write is conditioned on the version the scan read
      // (`lastUpdateTime`), so a claim voided or trimmed by a takeover, taken by a concurrent
      // run, or edited since fails the whole take and leaves the chunk to the next run. (The scan
      // is the only read: before A3 a transaction read every member a second time.)
      const taking = { state: 'aggregated', payout_key: payout.claim_key, aggregated_at_ms: options.nowMs };
      const write = db.batch();
      removeIndexedMeterClaims(db, write, chunk.filter(t => t.cut === null).map(t => t.claim));
      for (const t of chunk) {
        if (t.cut === null) {
          write.update(t.ref, { ...taking, inlet_indexed_v1: false }, { lastUpdateTime: t.readAt });
          continue;
        }
        const left = t.cut.parent;
        updateIndexedReadiness(db, write, { ...left, state: 'pending', inlet_indexed_v1: (t.claim as MeterPendingClaim & { inlet_indexed_v1?: boolean }).inlet_indexed_v1 });
        write.update(t.ref, {
          acts: left.acts,
          record_points_atomic: left.record_points_atomic,
          ready_at_ms: left.ready_at_ms,
          moved: left.moved,
          integrity_sha256: left.integrity_sha256,
        }, { lastUpdateTime: t.readAt });
        write.create(db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(t.cut.slice.claim_key), { ...t.cut.slice, ...taking, inlet_indexed_v1: false });
      }
      const indexedPayout = createIndexedMeterClaim(db, write, db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(payout.claim_key), payout);
      try {
        await write.commit();
      } catch (error) {
        if (!isTakeConflict(error)) throw error;
        rejected.push({ claimKey: payout.claim_key, reason: 'payout_members_changed' });
        continue;
      }
      aggregated += chunk.length;
      payouts += 1;
      toRegister.push(indexedPayout);
    }
  }

  for (const claim of toRegister) {
    const result = await registerClaim(db as unknown as SettlementDb, {
      pe_id: claim.claim_key,
      leg: claim.leg as PayoutLegRole,
      claim_id: claim.claim_id,
      lane: 'standard',
      contributor: claim.contributor,
      beneficiary_class: claim.beneficiary_class as 0 | 1 | 2,
      record_points_atomic: claim.record_points_atomic,
    }, options.nowMs);
    if (result.kind === 'rejected') {
      rejected.push({ claimKey: claim.claim_key, reason: result.reason });
      continue;
    }
    // A crash between the ledger create and this update re-registers identically next run.
    const source = registerSources.get(claim.claim_key) ?? await db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(claim.claim_key).get();
    try {
      if (!source.exists || source.get('state') !== 'pending') {
        if (result.kind === 'created') registered++; else alreadyRegistered++;
        continue;
      }
      const final = db.batch();
      final.update(source?.ref ?? db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(claim.claim_key),
        { state: 'registered', registered_at_ms: options.nowMs, inlet_indexed_v1: false }, ...(source?.updateTime ? [{ lastUpdateTime: source.updateTime }] : []));
      removeIndexedMeterClaims(db, final, [claim]);
      await final.commit();
    } catch (error) {
      if (!source || !isTakeConflict(error)) throw error;
      // Registration already succeeded idempotently. Never overwrite a concurrent inlet or
      // demotion, and never abort the other payees. A still-pending payout retries safely.
      log('[meter-inlet] payout finalization raced after idempotent ledger registration');
    }
    if (result.kind === 'created') registered += 1;
    else alreadyRegistered += 1;
  }
  if (tampered.length > 0) log(`[meter-inlet] ${tampered.length} pending claim(s) fail their integrity commitment: ${tampered.slice(0, 5).join(', ')}`);
  if (held > 0) log(`[meter-inlet] ${held} pending claim(s) held by a demotion in flight — left for the next run`);
  if (rejected.length > 0) log(`[meter-inlet] ${rejected.length} registration(s) refused: ${rejected.slice(0, 5).map((r) => `${r.claimKey}:${r.reason}`).join(', ')}`);
  return { scanned, registered, alreadyRegistered, notReady, tampered, rejected, aggregated, payouts, held };
}

// ---------------------------------------------------------------------------
// 2. Approval gate
// ---------------------------------------------------------------------------

/**
 * : every claim the PE meter migration carried over from the
 * pre-meter ledger is paid NOW, not after its cross-witness takeover window. The relay keeps no
 * pre-meter PE, so no later witness of a pre-meter act is awaited; a late witness still finds the
 * claim registered and records as a duplicate (mint-once), it never pays twice. Identified by the
 * migration's own markers, both inside the claim's integrity commitment.
 */
export { isCarriedOverLegacyClaim } from './meter-claims';

export interface MeterClaimMember {
  readonly pe_id: string;
  readonly leg: PayoutLegRole;
  readonly claim_id: string;
}

export type MeterMemberVerdict =
  | {
    readonly ok: true;
    readonly contributor: string;
    readonly beneficiaryClass: number;
    readonly recordPointsAtomic: string;
  }
  | { readonly ok: false; readonly reason: string };

async function readActKeys(db: Firestore, relayPeIds: readonly string[]): Promise<Map<string, MeterActKeyDoc>> {
  const out = new Map<string, MeterActKeyDoc>();
  const unique = [...new Set(relayPeIds)];
  for (let i = 0; i < unique.length; i += 300) {
    const chunk = unique.slice(i, i + 300);
    const refs = chunk.map((id) => privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(id));
    const snaps = await Promise.all(refs.map((r) => r.get()));
    // A held act's record is read only for an act whose key is gone (the key wins when both
    // exist, so reading the held record beside a present key never changed the answer).
    const missing = chunk.filter((_, j) => !snaps[j].exists);
    const heldSnaps = await Promise.all(missing.map((id) => privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).doc(id).get()));
    snaps.forEach((snap, j) => {
      if (snap.exists) out.set(chunk[j], snap.data() as MeterActKeyDoc);
    });
    heldSnaps.forEach((snap, j) => {
      if (!snap.exists) return;
      const held = snap.data()?.key as MeterActKeyDoc | undefined;
      if (held) out.set(missing[j], held);
    });
  }
  return out;
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** What the claim id of this pending claim must be, re-derived from its own identity. */
function rederiveClaimId(claim: MeterPendingClaim, acts: Map<string, MeterActKeyDoc>): string | { error: string } {
  if (claim.unit === 'batch') {
    return meterBatchClaimId({
      batch_hash: claim.batch_hash,
      leg: claim.leg as PayoutLegRole,
      contributor: claim.contributor,
      beneficiary_class: claim.beneficiary_class,
    });
  }
  if (claim.unit === 'window') {
    // : a window claim's id derives from its batch, payee and part (0 for the batch's
    // own claim, the cut instant for a slice) — all inside its integrity commitment.
    try {
      return meterWindowClaimId({
        batch_hash: claim.batch_hash,
        leg: claim.leg as PayoutLegRole,
        contributor: claim.contributor,
        beneficiary_class: claim.beneficiary_class,
        part: claim.window_part ?? Number.NaN,
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'claim_id_underivable' };
    }
  }
  if (claim.acts.length !== 1) return { error: 'act_identity_unavailable' };
  // The claim's own (integrity-committed) identity, so a key past its 31 days still pays. When
  // the key is still here it must name the same act.
  const key = acts.get(claim.acts[0].relay_pe_id);
  const fromKey = key === undefined ? undefined : actKeyIdentity(key);
  const identity = claim.act_identity ?? fromKey;
  if (identity === undefined) return { error: 'act_identity_unavailable' };
  if (fromKey !== undefined && stableStringify(fromKey) !== stableStringify(identity)) {
    return { error: 'act_identity_mismatch' };
  }
  try {
    return claim.unit === 'act'
      ? meterActClaimId(identity, claim.leg as PayoutLegRole)
      : meterTopupClaimId(identity, claim.leg as PayoutLegRole);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'claim_id_underivable' };
  }
}

/** Pending-claim states a payout member may be in while its payout is approved (or re-approved after a reorg). */
const PAYOUT_MEMBER_STATES = new Set(['aggregated', 'settled']);

/**
 * The approval gate for payout claims. A payout settles iff: it is intact (its integrity covers
 * its members); its claim id re-derives from its payee and its members' claim ids; and every member
 * exists, is intact, was taken into THIS payout (`aggregated` with `payout_key`, or `settled`
 * through it on a reorg re-approval), pays the same leg, address and class, carries the claim id
 * and points the payout lists, and its own claim id re-derives from its own identity (batch hash or
 * act identity). The points must sum exactly. No act key is read: a member's commitment is its own
 * integrity hash, and a demotion of an act voids or trims its claim before the claim leaves
 * `pending` (`mutatePeHistoryRowWithAggregate` refuses it afterwards), never after.
 */
async function verifyPayoutClaims(
  db: Firestore,
  payouts: readonly MeterPendingClaim[],
  memo?: MeterPayoutVerdictMemo,
): Promise<Map<string, MeterMemberVerdict>> {
  const out = new Map<string, MeterMemberVerdict>();
  const noActs = new Map<string, MeterActKeyDoc>();
  for (const payout of payouts) {
    // Already approved in this run, and the payout read moments ago is still exactly that
    // payout (same integrity: same members, ids and points): its members cannot have changed
    // since — a member leaves `aggregated` only through this payout's own settlement writeback.
    const memoKey = `${payout.claim_key}|${payout.integrity_sha256}`;
    const approved = memo?.get(memoKey);
    if (approved !== undefined && pendingClaimIntact(payout)) {
      let failure: string | null = null;
      for (const party of approved.parties) {
        const compliance = await evaluateMintCompliance(party.actor, party.recipient, db);
        if (compliance.policy !== 'immediate') {
          await retainComplianceDecisions(db, party.eventIds, { userId: party.actor, beneficiary_routing_snapshot: { human_address: party.recipient } }, compliance);
          failure = `mint_compliance_${compliance.reason}`; break;
        }
      }
      out.set(payout.claim_key, failure ? { ok: false, reason: failure } : approved.verdict);
      continue;
    }
    const fail = (reason: string): void => { out.set(payout.claim_key, { ok: false, reason }); };
    const listed = payout.members ?? [];
    if (listed.length === 0 || listed.length > MAX_PAYOUT_MEMBERS) { fail('meter_payout_member_count'); continue; }
    let canonical: ReturnType<typeof canonicalPayoutMembers>;
    try {
      canonical = canonicalPayoutMembers(listed);
    } catch {
      fail('meter_payout_member_duplicate');
      continue;
    }
    if (canonical.some((m, i) => m.claim_key !== listed[i].claim_key)) { fail('meter_payout_members_unordered'); continue; }
    let expectedId: string;
    try {
      expectedId = meterPayoutClaimId({
        leg: payout.leg as PayoutLegRole,
        contributor: payout.contributor,
        beneficiary_class: payout.beneficiary_class,
        members: canonical,
      });
    } catch {
      fail('meter_payout_claim_id_underivable');
      continue;
    }
    if (!sameHex(expectedId, payout.claim_id)) { fail('meter_payout_claim_id_not_derived'); continue; }
    const refs = canonical.map((m) => db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(m.claim_key));
    const snaps = await db.getAll(...refs);
    let total = 0n;
    const parties = new Map<string, { actor: string; recipient: string; eventIds: string[] }>();
    let reason: string | null = null;
    for (let i = 0; i < canonical.length && reason === null; i += 1) {
      const listedMember = canonical[i];
      const snap = snaps[i];
      if (!snap.exists) { reason = `meter_payout_member_missing:${listedMember.claim_key}`; break; }
      const m = snap.data() as MeterPendingClaim;
      if (m.claim_key !== listedMember.claim_key || !pendingClaimIntact(m)) { reason = `meter_payout_member_integrity:${listedMember.claim_key}`; break; }
      if (m.unit === 'payout') { reason = `meter_payout_member_nested:${listedMember.claim_key}`; break; }
      if (!PAYOUT_MEMBER_STATES.has(m.state) || m.payout_key !== payout.claim_key) {
        reason = `meter_payout_member_state_${m.state}:${listedMember.claim_key}`;
        break;
      }
      if (m.leg !== payout.leg || m.contributor.toLowerCase() !== payout.contributor.toLowerCase()
        || m.beneficiary_class !== payout.beneficiary_class) {
        reason = `meter_payout_member_payee_mismatch:${listedMember.claim_key}`;
        break;
      }
      if (!sameHex(m.claim_id, listedMember.claim_id) || m.record_points_atomic !== listedMember.points_atomic) {
        reason = `meter_payout_member_commitment_mismatch:${listedMember.claim_key}`;
        break;
      }
      const partyKey = `${m.actor_id}|${m.contributor.toLowerCase()}`;
      const compliance = parties.has(partyKey) ? null : await evaluateMintCompliance(m.actor_id, m.contributor, db);
      if (compliance !== null && compliance.policy !== 'immediate') {
        await retainComplianceDecisions(db, m.acts.map(a => a.relay_pe_id), { userId: m.actor_id, beneficiary_routing_snapshot: { human_address: m.contributor } }, compliance);
        reason = `mint_compliance_${compliance.reason}`; break;
      }
      const priorIds = parties.get(partyKey)?.eventIds ?? [];
      parties.set(partyKey, { actor: m.actor_id, recipient: m.contributor, eventIds: [...new Set([...priorIds, ...m.acts.map(a => a.relay_pe_id)])] });
      const derived = rederiveClaimId(m, noActs);
      if (typeof derived !== 'string' || !sameHex(derived, m.claim_id)) {
        reason = `meter_payout_member_claim_id_not_derived:${listedMember.claim_key}`;
        break;
      }
      total += BigInt(m.record_points_atomic);
    }
    if (reason !== null) { fail(reason); continue; }
    if (total.toString() !== payout.record_points_atomic || total <= 0n) { fail('meter_payout_points_mismatch'); continue; }
    const verdict = {
      ok: true as const,
      contributor: payout.contributor,
      beneficiaryClass: payout.beneficiary_class,
      recordPointsAtomic: payout.record_points_atomic,
    };
    out.set(payout.claim_key, verdict);
    memo?.set(memoKey, { verdict, parties: [...parties.values()] });
  }
  return out;
}

/**
 * Payout approvals one settlement run has reached, by `claim_key|integrity_sha256` .
 * Only approvals are kept; a refusal is always re-judged.
 */
export type MeterPayoutVerdictMemo = Map<string, {
  readonly verdict: Extract<MeterMemberVerdict, { ok: true }>;
  readonly parties: readonly { readonly actor: string; readonly recipient: string; readonly eventIds: readonly string[] }[];
}>;

/**
 * The approval gate's meter verifier for ONE settlement run. The runner approves a batch before
 * simulating it and again before signing it (`settlement-cycle-runner.ts` `ensureApproved`); the
 * second approval re-reads and re-checks every claim the batch settles, but a payout approved
 * earlier in the run whose document still carries the same integrity commitment does not re-read
 * its members — a member is `aggregated` into exactly one payout by the inlet's atomic take and
 * leaves that state only through the payout's own settlement writeback (or its reorg reversal),
 * after the transaction is broadcast, never between the two approvals.
 */
export function createMeterClaimVerifier(db: Firestore): (members: readonly MeterClaimMember[]) => Promise<Map<string, MeterMemberVerdict>> {
  const memo: MeterPayoutVerdictMemo = new Map();
  return (members) => verifyMeterClaimMembers(db, members, memo);
}

export async function verifyMeterClaimMembers(
  db: Firestore,
  members: readonly MeterClaimMember[],
  memo?: MeterPayoutVerdictMemo,
): Promise<Map<string, MeterMemberVerdict>> {
  const verdicts = new Map<string, MeterMemberVerdict>();
  if (members.length === 0) return verdicts;
  const refs = members.map((m) => db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(m.pe_id));
  const snaps = await Promise.all(refs.map((r) => r.get()));
  const claims = new Map<string, MeterPendingClaim>();
  snaps.forEach((snap, i) => {
    if (snap.exists) claims.set(members[i].pe_id, snap.data() as MeterPendingClaim);
  });
  // A payout claim is verified from its members' own commitments (`verifyPayoutClaim`); only the
  // pre-payout units still read act keys.
  const acts = await readActKeys(db, [...claims.values()].filter((c) => c.unit !== 'payout').flatMap((c) => c.acts.map((a) => a.relay_pe_id)));
  const payoutVerdicts = await verifyPayoutClaims(db, [...claims.values()].filter((c) => c.unit === 'payout'), memo);
  for (const member of members) {
    const claim = claims.get(member.pe_id);
    if (claim === undefined) {
      verdicts.set(member.pe_id, { ok: false, reason: 'meter_claim_missing' });
      continue;
    }
    if (!pendingClaimIntact(claim) || claim.claim_key !== member.pe_id) {
      verdicts.set(member.pe_id, { ok: false, reason: 'meter_claim_integrity' });
      continue;
    }
    // `settled` is admitted so a batch reorged out of the chain can be re-approved; the kernel's
    // `claimSettled` refuses a genuine second settlement either way.
    if (claim.state !== 'registered' && claim.state !== 'settled') {
      verdicts.set(member.pe_id, { ok: false, reason: `meter_claim_state_${claim.state}` });
      continue;
    }
    if (claim.leg !== member.leg) {
      verdicts.set(member.pe_id, { ok: false, reason: 'meter_claim_leg_mismatch' });
      continue;
    }
    if (!sameHex(claim.claim_id, member.claim_id)) {
      verdicts.set(member.pe_id, { ok: false, reason: 'meter_claim_id_mismatch' });
      continue;
    }
    if (claim.unit === 'payout') {
      const verdict = payoutVerdicts.get(claim.claim_key) ?? { ok: false as const, reason: 'meter_payout_unverified' };
      verdicts.set(member.pe_id, verdict);
      continue;
    }
    const compliance = await evaluateMintCompliance(claim.actor_id, claim.contributor, db);
    if (compliance.policy !== 'immediate') {
      await retainComplianceDecisions(db, claim.acts.map(a => a.relay_pe_id), { userId: claim.actor_id, beneficiary_routing_snapshot: { human_address: claim.contributor } }, compliance);
      verdicts.set(member.pe_id, { ok: false, reason: `mint_compliance_${compliance.reason}` });
      continue;
    }
    const derived = rederiveClaimId(claim, acts);
    if (typeof derived !== 'string') {
      verdicts.set(member.pe_id, { ok: false, reason: `meter_claim_id_${derived.error}` });
      continue;
    }
    if (!sameHex(derived, claim.claim_id)) {
      verdicts.set(member.pe_id, { ok: false, reason: 'meter_claim_id_not_derived' });
      continue;
    }
    // An act that has since been demoted (a takeover, a bug demotion) is not paid. An act whose
    // 31-day key has expired is covered by the claim's own commitment: every demotion path voids
    // the claims of the act it demotes, and a voided claim never reaches this gate.
    const demoted = claim.acts.find((a) => {
      const key = acts.get(a.relay_pe_id);
      const status = key?.row?.mint_status;
      return typeof status === 'string' && DEMOTED_STATUSES.has(status);
    });
    if (demoted !== undefined) {
      verdicts.set(member.pe_id, { ok: false, reason: `meter_act_demoted:${demoted.relay_pe_id}` });
      continue;
    }
    verdicts.set(member.pe_id, {
      ok: true,
      contributor: claim.contributor,
      beneficiaryClass: claim.beneficiary_class,
      recordPointsAtomic: claim.record_points_atomic,
    });
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// 3. Writeback (and its reorg reversal)
// ---------------------------------------------------------------------------

export interface MeterSettlementTally {
  readonly claims_settled: number;
  readonly claims_missing: number;
  readonly acts_minted: number;
  readonly acts_partial: number;
  readonly acts_without_key: number;
}

interface ActRef {
  readonly base?: boolean;
  readonly id: string;
  /** The batch the act was accepted in (where a single-lane act's row lives, ). */
  readonly batch: string;
}

/** `${relay_pe_id}|${leg}` — one leg of one act. */
function actLegId(relayPeId: string, leg: string): string {
  return `${relayPeId}|${leg}`;
}

/** The units whose claim IS an act's leg (a top-up is additive and never decides a flip). */
const BASE_UNITS = new Set<MeterPendingClaim['unit']>(['batch', 'act', 'window']);

async function flipActRows(
  db: Firestore,
  actRefs: readonly ActRef[],
  nowMs: number,
  direction: 'mint' | 'revert',
  settledBy: { batchId: string; txHash: string | null },
  /**
   * Act legs whose base claim this writeback has just settled : read from the
   * member claims it settled moments ago, so the flip does not read those claims a second time.
   * The writeback runs under the settlement signer lease, the only writer of a settled claim.
   */
  settledLegs: ReadonlySet<string> = new Set(),
): Promise<{ minted: number; partial: number; withoutKey: number }> {
  let minted = 0;
  let partial = 0;
  let withoutKey = 0;
  const byId = new Map<string, ActRef>();
  for (const ref of actRefs) {
    const prior = byId.get(ref.id);
    byId.set(ref.id, { ...ref, base: (prior?.base ?? false) || ref.base !== false });
  }
  const ids = [...byId.keys()];
  // One transaction per group of acts (not per act): each act's flip rule is unchanged and
  // evaluated in the same order, but the group reads each shared leg claim once and loads,
  // folds and writes each economic aggregate once (the per-act deltas sum exactly as they did
  // across per-act transactions).
  for (let start = 0; start < ids.length; start += FLIP_GROUP_SIZE) {
    const group = ids.slice(start, start + FLIP_GROUP_SIZE);
    const outcomes = await db.runTransaction(async (txn) => {
      // /A3: a single-lane act keeps no key of its own; its row lives on its batch's
      // act page. Read each batch's pages ONCE first (one query per batch), then read an act key
      // only for an act no page carries (a multi-lane act, or a carried-over legacy act) — never a
      // probe of a key that cannot exist (the probe was ~85% of the weekly run's reads).
      const pageBatches = [...new Set(group.map((id) => (byId.get(id) as ActRef).batch))]
        .filter((b) => b.length > 0 && b !== LEGACY_PRE_METER_BATCH);
      const pageActs = new Map<string, { key: MeterActKeyDoc; ref: DocumentReference }>();
      const rowless = new Set<string>();
      const batchTopups = new Map<string, Set<string>>();
      const packedKeys = new Map<string, { key: MeterActKeyDoc; ref: DocumentReference }>();
      for (const batch of pageBatches) {
        const record = (await txn.get(db.collection(METER_BATCHES_COLLECTION).doc(batch))).data();
        if (record?.per_batch_pricing === true) {
          if (Array.isArray(record.topup_claim_keys)) batchTopups.set(batch, new Set(record.topup_claim_keys));
          const retained = new Set<string>(record.retained_act_ids as string[]);
          if (Array.isArray(record.key_page_ids) && group.some(id => byId.get(id)?.batch === batch && retained.has(id))) for (const [id, value] of await readPackedMeterKeyPages(db, txn, record.key_page_ids, true)) {
            packedKeys.set(id, { key: value.data as MeterActKeyDoc, ref: value.ref });
          }
          for (const id of group) if ((byId.get(id) as ActRef).batch === batch && !retained.has(id)) rowless.add(id);
          continue;
        }
        for (const { ref, doc } of await readBatchActPages(db, batch, txn)) {
          for (const [id, act] of Object.entries(doc.acts)) pageActs.set(id, { key: actKeyOfPageAct(act), ref });
        }
      }
      const keyed = group.filter((id) => !pageActs.has(id) && !rowless.has(id) && !packedKeys.has(id));
      const keyRefs = new Map([...keyed.map((id) => [id, privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(id)] as const), ...[...packedKeys].map(([id, entry]) => [id, entry.ref] as const)]);
      const keySnaps = new Map(await Promise.all(keyed.map(async (id) => [id, await txn.get(keyRefs.get(id) as DocumentReference)] as const)));
      const homes = group.map((id): { key: MeterActKeyDoc; ref: DocumentReference; onPage: boolean } | null => {
        const packed = packedKeys.get(id);
        if (packed) return { ...packed, onPage: false };
        const paged = pageActs.get(id);
        if (paged !== undefined) return { ...paged, onPage: true };
        const snap = keySnaps.get(id);
        if (snap !== undefined && snap.exists) return { key: snap.data() as MeterActKeyDoc, ref: keyRefs.get(id) as DocumentReference, onPage: false };
        return null;
      });
      // An act mints once EVERY paying leg's base claim — its batch claim, its act claim, or the
      // window claim or slice that carries it — has settled. A leg this writeback just settled is
      // known; every other leg is read here (each claim once per group). A reversal reads none:
      // it un-mints every minted act of the claims it reverts.
      const cached = new Map<string, Promise<DocumentSnapshot>>();
      const read = (ref: DocumentReference): Promise<DocumentSnapshot> => {
        let got = cached.get(ref.path);
        if (got === undefined) {
          got = txn.get(ref);
          cached.set(ref.path, got);
        }
        return got;
      };
      const settledOf = direction === 'mint'
        ? await Promise.all(homes.map(async (home): Promise<boolean> => {
          if (home === null) return false;
          const key = home.key;
          const paying = (key.legs ?? []).filter((leg) => actBaseClaimKeyOf(key, leg) !== null);
          if (paying.length === 0) return false;
          const unknown = paying.filter((leg) => !settledLegs.has(actLegId(key.relay_pe_id, leg.leg)));
          if (unknown.length === 0) return true;
          const resolved = await resolveActBaseClaims(db, read, { ...key, legs: unknown });
          return resolved.length === unknown.length
            && resolved.every((l) => l.claim !== null && l.carried && l.claim.state === 'settled');
        }))
        : homes.map(() => false);
      const retention = new Map<string, FirebaseFirestore.Timestamp | null>();
      await Promise.all(homes.map(async (home, i) => {
        if (!home || home.onPage || home.key.pending_retention_v1 !== true) return;
        const key = home.key;
        const knownTopups = batchTopups.get(key.batch_hash);
        const topupKey = knownTopups ? { ...key, legs: (key.legs ?? []).filter(leg => knownTopups.has(meterTopupClaimKey(key.relay_pe_id, leg.leg))) } : key;
        const topups = await resolveActTopupClaims(db, read, topupKey);
        const baseComplete = key.row.mint_status === 'minted' || settledOf[i];
        const complete = direction === 'mint' && baseComplete
          && topups.every(t => t.claim === null || t.claim.state === 'settled' || t.claim.state === 'void');
        const expiry = complete ? expireAt(Math.max(key.timestamp + METER_KEY_LIFETIME_MS, nowMs + METER_SETTLED_CLAIM_LIFETIME_MS)) : null;
        if (expiry !== null || key.expire_at !== null) retention.set(group[i], expiry);
      }));
      const plan = homes.map((home, i): { kind: 'without_key' | 'partial' | 'unchanged' | 'batch_only' } | { kind: 'flip'; before: PEHistoryDocument; after: PEHistoryDocument } => {
        if (rowless.has(group[i])) return { kind: 'batch_only' };
        if (home === null) return { kind: 'without_key' };
        const key = home.key;
        const allSettled = settledOf[i];
        const before = key.row as unknown as PEHistoryDocument;
        const status = before.mint_status;
        if (direction === 'mint') {
          if (!allSettled) return { kind: 'partial' };
          if (status !== 'eligible') return { kind: 'unchanged' };
        } else if ((byId.get(group[i]) as ActRef).base === false || status !== 'minted') {
          return { kind: 'unchanged' };
        }
        const after = {
          ...before,
          mint_status: direction === 'mint' ? 'minted' : 'eligible',
          ...(direction === 'mint'
            ? { settled_batch_id: settledBy.batchId, settled_tx_hash: settledBy.txHash, settled_at: nowMs, minted_via: 'pvt9_settlement' }
            : { settled_batch_id: null, settled_tx_hash: null, settled_at: null, minted_via: null }),
        } as unknown as PEHistoryDocument;
        return { kind: 'flip', before, after };
      });
      const flips = plan.flatMap((p, i) => (p.kind === 'flip' ? [{ ...p, id: group[i], home: homes[i] as NonNullable<typeof homes[number]> }] : []));
      if (flips.length > 0) {
        const writer = new EconomicAggregateWriter(db, txn, nowMs);
        await writer.load(flips.flatMap((f) => EconomicAggregateWriter.identitiesOf(f.before, f.after)));
        for (const f of flips) writer.applyMutation(f.before, f.after);
        writer.commit();
        // One update per document: a page carries many acts, each patched at its own field path.
        const pagePatches = new Map<string, { ref: DocumentReference; patch: Record<string, unknown> }>();
        for (const f of flips) {
          if (!f.home.onPage) {
            txn.update(f.home.ref, protectRetainedFields(METER_ACT_KEYS_COLLECTION, { row: f.after, ...(retention.has(f.id) ? { expire_at: retention.get(f.id) } : {}) }));
            retention.delete(f.id);
            continue;
          }
          const entry = pagePatches.get(f.home.ref.path) ?? { ref: f.home.ref, patch: {} };
          entry.patch[`acts.${f.id}.row`] = f.after;
          pagePatches.set(f.home.ref.path, entry);
        }
        for (const { ref, patch } of pagePatches.values()) txn.update(ref, protectRetainedFields('meter_batch_acts_v1', patch));
      }
      for (const [id, expire_at] of retention) txn.update(keyRefs.get(id) as DocumentReference, { expire_at });
      return plan.map((p) => (p.kind === 'flip' ? 'flipped' as const : p.kind));
    });
    for (const outcome of outcomes) {
      if (outcome === 'flipped' && direction === 'mint') minted += 1;
      else if (outcome === 'partial') partial += 1;
      else if (outcome === 'without_key') withoutKey += 1;
    }
  }
  return { minted, partial, withoutKey };
}

/** Acts flipped per transaction (each act reads its key; the group shares legs and aggregates). */
const FLIP_GROUP_SIZE = 100;

export async function settleMeterClaims(
  db: Firestore,
  params: {
    readonly claimKeys: readonly string[];
    readonly batchId: string;
    readonly txHash: string | null;
    readonly nowMs: number;
    readonly via?: 'pvt9_settlement' | 'pvt9_chain_evidence';
  },
): Promise<MeterSettlementTally> {
  let settled = 0;
  let batchActsMinted = 0;
  let missing = 0;
  const relayPeIds: ActRef[] = [];
  // The act legs whose base claim this writeback settles (handed to the flip, which then reads
  // only the legs settled elsewhere — ).
  const settledLegs = new Set<string>();
  const noteSettled = (claim: MeterPendingClaim): void => {
    if (!BASE_UNITS.has(claim.unit)) return;
    for (const a of claim.acts) settledLegs.add(actLegId(a.relay_pe_id, claim.leg));
  };
  for (const claimKey of new Set(params.claimKeys)) {
    const ref = db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(claimKey);
    const snap = await ref.get();
    if (!snap.exists) {
      missing += 1;
      continue;
    }
    const claim = snap.data() as MeterPendingClaim;
    const settledFields = {
      state: 'settled',
      settled_batch_id: params.batchId,
      settled_tx_hash: params.txHash,
      settled_at_ms: params.nowMs,
      settled_via: params.via ?? 'pvt9_settlement',
      expire_at: expireAt(params.nowMs + METER_SETTLED_CLAIM_LIFETIME_MS),
    };
    if (claim.unit === 'payout') {
      // A payout settles its members with it (they keep `payout_key`); their acts are what flip.
      const memberKeys = (claim.members ?? []).map((m) => m.claim_key);
      for (let i = 0; i < memberKeys.length; i += 300) {
        const chunk = memberKeys.slice(i, i + 300).map((k) => db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(k));
        const memberSnaps = await db.getAll(...chunk);
        const writer = db.batch();
        memberSnaps.forEach((m, j) => {
          if (!m.exists) return;
          const member = m.data() as MeterPendingClaim;
          if (member.payout_key !== claim.claim_key) return;
          writer.update(m.ref ?? chunk[j], settledFields, ...(m.updateTime ? [{ lastUpdateTime: m.updateTime }] : []));
          relayPeIds.push(...member.acts.map((a) => ({ id: a.relay_pe_id, batch: member.batch_hash, base: BASE_UNITS.has(member.unit) })));
          noteSettled(member);
        });
        await writer.commit();
        for (const m of memberSnaps) {
          if (m.exists && (m.data() as MeterPendingClaim).payout_key === claim.claim_key) {
            batchActsMinted += await noteBatchClaimSettlement(db, m.data() as MeterPendingClaim, true, params.nowMs);
          }
        }
      }
    } else {
      relayPeIds.push(...claim.acts.map((a) => ({ id: a.relay_pe_id, batch: claim.batch_hash, base: BASE_UNITS.has(claim.unit) })));
      noteSettled(claim);
      batchActsMinted += await noteBatchClaimSettlement(db, claim, true, params.nowMs);
    }
    await (snap.ref ?? ref).update(settledFields, ...(snap.updateTime ? [{ lastUpdateTime: snap.updateTime }] : []));
    settled += 1;
  }
  const flips = await flipActRows(db, relayPeIds, params.nowMs, 'mint', { batchId: params.batchId, txHash: params.txHash }, settledLegs);
  return {
    claims_settled: settled,
    claims_missing: missing,
    acts_minted: flips.minted + batchActsMinted,
    acts_partial: flips.partial,
    acts_without_key: flips.withoutKey,
  };
}

/** A settled batch was reorged out: its meter claims are registered (unsettled) again. */
export async function revertMeterClaimsSettled(
  db: Firestore,
  params: { readonly claimKeys: readonly string[]; readonly nowMs: number },
): Promise<{ reverted: number }> {
  let reverted = 0;
  const relayPeIds: ActRef[] = [];
  for (const claimKey of new Set(params.claimKeys)) {
    const ref = db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(claimKey);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const claim = snap.data() as MeterPendingClaim;
    if (claim.state !== 'settled') continue;
    const unsettled = { settled_batch_id: null, settled_tx_hash: null, settled_at_ms: null, expire_at: null };
    if (claim.unit === 'payout') {
      // Its members go back to waiting on it (`aggregated`), never to `pending`: they stay in it.
      const memberKeys = (claim.members ?? []).map((m) => m.claim_key);
      for (let i = 0; i < memberKeys.length; i += 300) {
        const chunk = memberKeys.slice(i, i + 300).map((k) => db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(k));
        const memberSnaps = await db.getAll(...chunk);
        const writer = db.batch();
        memberSnaps.forEach((m, j) => {
          if (!m.exists) return;
          const member = m.data() as MeterPendingClaim;
          if (member.payout_key !== claim.claim_key || member.state !== 'settled') return;
          writer.update(chunk[j], { state: 'aggregated', ...unsettled });
          relayPeIds.push(...member.acts.map((a) => ({ id: a.relay_pe_id, batch: member.batch_hash, base: BASE_UNITS.has(member.unit) })));
        });
        await writer.commit();
        for (const m of memberSnaps) {
          if (m.exists && (m.data() as MeterPendingClaim).payout_key === claim.claim_key) {
            await noteBatchClaimSettlement(db, m.data() as MeterPendingClaim, false, params.nowMs);
          }
        }
      }
    } else {
      relayPeIds.push(...claim.acts.map((a) => ({ id: a.relay_pe_id, batch: claim.batch_hash, base: BASE_UNITS.has(claim.unit) })));
      await noteBatchClaimSettlement(db, claim, false, params.nowMs);
    }
    await ref.update({ state: 'registered', ...unsettled });
    reverted += 1;
  }
  await flipActRows(db, relayPeIds, params.nowMs, 'revert', { batchId: '', txHash: null });
  return { reverted };
}
