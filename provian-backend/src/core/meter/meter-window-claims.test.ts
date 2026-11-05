/**
 * (: "a batch costs a handful of documents") — the takeover-capable
 * witnesses of a batch fold into one WINDOW claim per (leg, payee, class), and every economic rule
 * the per-act claims carried still holds act by act:
 *
 * - READINESS: each act waits its OWN 72 h cross-witness takeover window. A run that finds some of
 * a claim's acts ready cuts exactly those into a slice; the rest keep waiting in the parent.
 * - TAKEOVER / DEMOTION BEFORE REGISTRATION: the act's points leave the claim (trimmed, integrity
 * recomputed), atomically with the demotion; once a run has taken the act it is committed —
 * the demotion is refused and the takeover pre-check reports it registered.
 * - THE TAKE: one atomic write conditioned on the version the scan read — a claim changed since
 * the scan leaves the whole take to the next run (no member is read a second time).
 * - THE GATE: a slice's claim id re-derives from its part; a run's second approval of the same
 * payout reads no member; a changed payout is re-judged.
 * - THE WRITEBACK: an act mints once every leg's claim (parent or slice) has settled.
 * - MIGRATION: a pre-fold per-act claim still settles, beside window claims, in the same payout.
 *
 * RED controls are in-suite: the act still waiting is in no payout; a tampered slice part is
 * refused; a take whose claim changed lands nothing; a demotion after the cut is refused; an act
 * with one leg unsettled stays unminted; an old claim not yet ready is not taken.
 */
import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../pe-history';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { actKeyDocFor, seedMeteredRows } from './__test-helpers__/seed-act-keys';
import { computeRecordSnapshot, CROSS_WITNESS_TAKEOVER_WINDOW_MS, hashRecordEconomicSnapshot } from '../pvt/policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from '../pvt/policy/runtime-monetary-policy';
import { mutatePeHistoryRowWithAggregate } from '../pvt/policy/economic-aggregate';
import type { SealedEnvelopeIdentity } from '../pvt/wp-ev/claim-id';
import {
  aggregateWindowClaims,
  aggregateBatchClaims,
  buildPendingClaim,
  meterActClaimId,
  meterTopupClaimId,
  meterTopupClaimKey,
  meterActClaimKey,
  meterWindowClaimId,
  meterWindowClaimKey,
  pendingClaimIntact,
  pendingClaimIntegrity,
  type MeterActLeg,
} from './meter-claims';
import { createMeterClaimVerifier, runMeterClaimInlet, settleMeterClaims, revertMeterClaimsSettled, verifyMeterClaimMembers } from './meter-settlement';
import { meterActUnregistered } from './act-claims';
import { actKeyIdentity, type MeterActKeyDoc } from './meter-act-key';
import { evaluateCompletionWitness } from '../pvt/completion-takeover';
import { METER_ACT_KEYS_COLLECTION, METER_PENDING_CLAIMS_COLLECTION, type MeterPendingClaim } from './meter-store';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 5, 0, 0, 0);
const W = CROSS_WITNESS_TAKEOVER_WINDOW_MS;
const BATCH = 'c'.repeat(64);
const AGENT = '0x00000000000000000000000000000000000000aa';
const HUMAN = '0x00000000000000000000000000000000000000bb';
const POLICY = materializeProposedMonetaryPolicy(0);

function db(fake: FakeFirestore): Firestore {
  return fake as unknown as Firestore;
}

function row(peId: string, at: number, actionType = 'wallet_created'): PEHistoryDocument {
  const s = computeRecordSnapshot(POLICY, {
    peId, economicActorId: 'agent-1', actionType, recordedAtMs: at,
    occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false,
    attestationTier: 'software', linkageState: 'unlinked', evidenceState: 'verified',
    canonicalEventId: actionType === 'agent_tool_orchestration' ? 'agent_tool_orchestration:retention-test' : null, selfReferencing: false, sharedBeneficialOwnership: false,
    pairChurnDetected: false, sessionLineageId: null, genesisReservation: null,
  });
  return {
    peId, userId: 'agent-1', actionType: s.actionType, timestamp: s.recordedAtMs, category: 'wallet',
    mint_status: 'eligible', mint_disposition: s.mintDisposition, attestationDepth: 'software',
    corroboration_status: 'none', corroboration_received_at: null,
    economic_snapshot: s, economic_snapshot_hash: hashRecordEconomicSnapshot(s),
    record_points_atomic: s.recordPointsAtomic, beneficiary_wallet_id: null,
  } as unknown as PEHistoryDocument;
}

/** The linked agent's split: 20% to the agent, 80% to its human. */
function legsOf(r: PEHistoryDocument): MeterActLeg[] {
  const total = BigInt(String(r.record_points_atomic));
  const agent = (total * 2_000n) / 10_000n;
  return [
    { leg: 'agent', contributor: AGENT, beneficiary_class: 1, bps: 2_000, points_atomic: agent.toString() },
    { leg: 'beneficiary', contributor: HUMAN, beneficiary_class: 1, bps: 8_000, points_atomic: (total - agent).toString() },
  ];
}

interface Seeded {
  readonly rows: PEHistoryDocument[];
  readonly parents: MeterPendingClaim[];
}

/** A committed batch of three takeover-capable acts (as `meter-commit.ts` leaves it). */
async function seedWindowBatch(fake: FakeFirestore, ats: readonly number[] = [T0, T0 + 10 * HOUR, T0 + 20 * HOUR], actionType = 'wallet_created'): Promise<Seeded> {
  const rows = await seedMeteredRows(fake, ats.map((at, i) => row(`pe_m_w${i + 1}`, at, actionType)), T0, { withActKeys: false });
  for (const r of rows) {
    fake.store.set(`${METER_ACT_KEYS_COLLECTION}/${r.peId}`, actKeyDocFor(r as unknown as Record<string, unknown>, {
      unit: 'window', legs: legsOf(r), batch_hash: BATCH,
    }));
  }
  const parents = aggregateWindowClaims({
    batch_hash: BATCH, device_id: 'dev_1', actor_id: 'agent-1', created_at_ms: T0 + 21 * HOUR,
    acts: rows.map((r) => ({ relay_pe_id: r.peId, legs: legsOf(r), ready_at_ms: r.timestamp + W })),
  });
  for (const p of parents) fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${p.claim_key}`, { ...p });
  return { rows, parents };
}

function claimsIn(fake: FakeFirestore): MeterPendingClaim[] {
  const prefix = `${METER_PENDING_CLAIMS_COLLECTION}/`;
  return [...fake.store.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v as unknown as MeterPendingClaim);
}

const legPoints = (r: PEHistoryDocument, leg: 'agent' | 'beneficiary'): bigint =>
  BigInt(legsOf(r).find((l) => l.leg === leg)!.points_atomic);

describe('window claims: one claim per payee leg per batch, each act on its own takeover window', () => {
  it('a pending additive top-up reopens new-key retention and a top-up reorg never un-mints the paid base', async () => {
    const fake = createFakeFirestore();
    const seeded = await seedWindowBatch(fake, [T0], 'agent_tool_orchestration');
    for (const claim of claimsIn(fake)) fake.store.delete(`${METER_PENDING_CLAIMS_COLLECTION}/${claim.claim_key}`);
    for (const claim of aggregateBatchClaims({ batch_hash: BATCH, device_id: 'dev_1', actor_id: 'agent-1', created_at_ms: T0, acts: seeded.rows.map(r => ({ relay_pe_id: r.peId, legs: legsOf(r) })) })) fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${claim.claim_key}`, { ...claim });
    const id = 'pe_m_w1', slot = `${METER_ACT_KEYS_COLLECTION}/${id}`;
    fake.store.set(slot, { ...fake.store.get(slot), pending_retention_v1: true, unit: 'batch', expire_at: null });
    const payAt = T0 + HOUR;
    await runMeterClaimInlet(db(fake), { nowMs: payAt });
    await settleMeterClaims(db(fake), { claimKeys: claimsIn(fake).filter(c => c.unit === 'payout').map(c => c.claim_key), batchId: 'base', txHash: 'base-tx', nowMs: payAt });
    expect((fake.store.get(slot) as unknown as MeterActKeyDoc).row.mint_status).toBe('minted');
    expect((fake.store.get(slot) as unknown as MeterActKeyDoc).expire_at).not.toBeNull();
    // This fake has no Firestore converter; recover the same row a real converter returns.
    const { recoverRetainedFields } = await import('../provenance/private-retention');
    fake.store.set(slot, recoverRetainedFields(METER_ACT_KEYS_COLLECTION, fake.store.get(slot)!));
    const { recordMeterIncumbentCorroboration } = await import('./meter-corroboration');
    expect((await recordMeterIncumbentCorroboration(db(fake), { incumbentPeId: id, corroboratingPeId: 'second-witness', status: 'peer_verified', nowMs: payAt + HOUR })).topups).toBeGreaterThan(0);
    expect((fake.store.get(slot) as unknown as MeterActKeyDoc).expire_at).toBeNull();
    const topups = claimsIn(fake).filter(c => c.unit === 'topup').map(c => c.claim_key);
    const delayed = T0 + 60 * 24 * HOUR;
    await settleMeterClaims(db(fake), { claimKeys: topups, batchId: 'topup', txHash: 'topup-tx', nowMs: delayed });
    expect((fake.store.get(slot) as unknown as MeterActKeyDoc).expire_at!.toMillis()).toBeGreaterThanOrEqual(delayed + 30 * 24 * HOUR);
    fake.store.set(slot, recoverRetainedFields(METER_ACT_KEYS_COLLECTION, fake.store.get(slot)!));
    await revertMeterClaimsSettled(db(fake), { claimKeys: topups, nowMs: delayed + HOUR });
    expect((fake.store.get(slot) as unknown as MeterActKeyDoc).row.mint_status).toBe('minted');
    expect((fake.store.get(slot) as unknown as MeterActKeyDoc).expire_at).toBeNull();
  });

  it('folds the batch\'s witnesses into one claim per leg; each act keeps its own ready instant', async () => {
    const fake = createFakeFirestore();
    const { rows, parents } = await seedWindowBatch(fake);
    expect(parents).toHaveLength(2);
    for (const p of parents) {
      const leg = p.leg as 'agent' | 'beneficiary';
      expect(p.unit).toBe('window');
      expect(p.window_part).toBe(0);
      expect(p.acts.map((a) => [a.relay_pe_id, a.ready_at_ms])).toEqual(rows.map((r) => [r.peId, r.timestamp + W]));
      expect(p.ready_at_ms).toBe(T0 + W);
      expect(BigInt(p.record_points_atomic)).toBe(rows.reduce((t, r) => t + legPoints(r, leg), 0n));
      expect(p.claim_id).toBe(meterWindowClaimId({ batch_hash: BATCH, leg, contributor: p.contributor, beneficiary_class: 1, part: 0 }));
      expect(pendingClaimIntact(p)).toBe(true);
      // RED: an act's ready instant is inside the integrity commitment; another part is another id.
      expect(pendingClaimIntact({ ...p, acts: p.acts.map((a, i) => (i === 2 ? { ...a, ready_at_ms: T0 } : a)) })).toBe(false);
      expect(meterWindowClaimId({ batch_hash: BATCH, leg, contributor: p.contributor, beneficiary_class: 1, part: 1 })).not.toBe(p.claim_id);
    }
  });

  it('a run takes exactly the acts whose windows have closed; the act still waiting is in no payout', async () => {
    const fake = createFakeFirestore();
    const { rows, parents } = await seedWindowBatch(fake);
    const cut = T0 + W + 15 * HOUR; // w1, w2 ready; w3 (ready at T0+W+20h) waits
    const report = await runMeterClaimInlet(db(fake), { nowMs: cut });
    expect(report.payouts).toBe(2);
    expect(report.registered).toBe(2);
    expect(report.rejected).toEqual([]);
    for (const parent of parents) {
      const leg = parent.leg as 'agent' | 'beneficiary';
      const slice = claimsIn(fake).find((c) => c.parent_key === parent.claim_key)!;
      expect(slice).toBeDefined();
      expect(slice.state).toBe('aggregated');
      expect(slice.window_part).toBe(cut);
      expect(slice.claim_key).toBe(meterWindowClaimKey({ batch_hash: BATCH, leg, contributor: parent.contributor, beneficiary_class: 1, part: cut }));
      expect(slice.acts.map((a) => a.relay_pe_id)).toEqual(['pe_m_w1', 'pe_m_w2']);
      expect(BigInt(slice.record_points_atomic)).toBe(legPoints(rows[0], leg) + legPoints(rows[1], leg));
      expect(pendingClaimIntact(slice)).toBe(true);
      const left = fake.store.get(`${METER_PENDING_CLAIMS_COLLECTION}/${parent.claim_key}`) as unknown as MeterPendingClaim;
      expect(left.state).toBe('pending');
      expect(left.acts.map((a) => a.relay_pe_id)).toEqual(['pe_m_w3']);
      expect(left.record_points_atomic).toBe(legPoints(rows[2], leg).toString());
      expect(left.ready_at_ms).toBe(rows[2].timestamp + W);
      expect(left.moved).toEqual({ pe_m_w1: slice.claim_key, pe_m_w2: slice.claim_key });
      expect(pendingClaimIntact(left)).toBe(true);
      // RED: the waiting act's points are in no payout.
      const payout = claimsIn(fake).find((c) => c.unit === 'payout' && c.leg === leg)!;
      expect(payout.members!.map((m) => m.claim_key)).toEqual([slice.claim_key]);
      expect(payout.record_points_atomic).toBe(slice.record_points_atomic);
    }
    // The next run, once w3's window has closed, takes the parent itself: every act paid once.
    const later = await runMeterClaimInlet(db(fake), { nowMs: T0 + W + 21 * HOUR });
    expect(later.payouts).toBe(2);
    for (const leg of ['agent', 'beneficiary'] as const) {
      const paid = claimsIn(fake).filter((c) => c.unit === 'payout' && c.leg === leg)
        .reduce((t, c) => t + BigInt(c.record_points_atomic), 0n);
      expect(paid).toBe(rows.reduce((t, r) => t + legPoints(r, leg), 0n));
    }
  });

  it('nothing ready: the claim waits and nothing is written', async () => {
    const fake = createFakeFirestore();
    await seedWindowBatch(fake);
    const before = JSON.stringify([...fake.store.entries()]);
    const report = await runMeterClaimInlet(db(fake), { nowMs: T0 + W - 1 });
    expect(report.notReady).toBe(2);
    expect(report.payouts).toBe(0);
    expect(JSON.stringify([...fake.store.entries()])).toBe(before);
  });

  it('RED: a claim changed between the scan and the take leaves the whole take to the next run', async () => {
    const fake = createFakeFirestore();
    const { parents } = await seedWindowBatch(fake);
    // A takeover trims w3 out of both parents after the scan read them, before the take commits.
    const realBatch = fake.batch.bind(fake);
    let raced = false;
    fake.batch = () => {
      if (!raced) {
        raced = true;
        for (const p of parents) {
          const key = `${METER_PENDING_CLAIMS_COLLECTION}/${p.claim_key}`;
          const current = fake.store.get(key) as unknown as MeterPendingClaim;
          fake.store.set(key, { ...current, acts: current.acts.slice(0, 2) } as unknown as Record<string, unknown>);
        }
      }
      return realBatch();
    };
    const report = await runMeterClaimInlet(db(fake), { nowMs: T0 + W + 15 * HOUR });
    expect(report.rejected.map((r) => r.reason)).toEqual(['payout_members_changed', 'payout_members_changed']);
    expect(report.payouts).toBe(0);
    // Atomic: no slice, no payout, no member state moved — only the concurrent trim landed.
    const all = claimsIn(fake);
    expect(all.filter((c) => c.unit === 'payout' || c.parent_key !== undefined)).toEqual([]);
    expect(all.every((c) => c.state === 'pending' && c.moved === undefined && c.acts.length === 2)).toBe(true);
  });
});

describe('window claims at the approval gate and the writeback', () => {
  async function takenAndRegistered(fake: FakeFirestore): Promise<{ rows: PEHistoryDocument[]; payouts: MeterPendingClaim[] }> {
    const { rows } = await seedWindowBatch(fake);
    await runMeterClaimInlet(db(fake), { nowMs: T0 + W + 15 * HOUR });
    return { rows, payouts: claimsIn(fake).filter((c) => c.unit === 'payout') };
  }
  const membersOf = (payouts: readonly MeterPendingClaim[]) => payouts.map((p) => ({ pe_id: p.claim_key, leg: p.leg as 'agent' | 'beneficiary', claim_id: p.claim_id }));

  it('admits a payout of slices, re-deriving each slice\'s claim id from its part', async () => {
    const fake = createFakeFirestore();
    const { payouts } = await takenAndRegistered(fake);
    const verdicts = await verifyMeterClaimMembers(db(fake), membersOf(payouts));
    for (const p of payouts) expect(verdicts.get(p.claim_key)).toEqual({ ok: true, contributor: p.contributor, beneficiaryClass: 1, recordPointsAtomic: p.record_points_atomic });
  });

  it('RED: a slice whose part was rewritten (integrity recomputed to match) no longer derives its claim id', async () => {
    const fake = createFakeFirestore();
    const { payouts } = await takenAndRegistered(fake);
    const slice = claimsIn(fake).find((c) => c.parent_key !== undefined && c.leg === 'agent')!;
    const forged = { ...slice, window_part: (slice.window_part ?? 0) + 1 };
    const { state: _s, integrity_sha256: _i, payout_key: _p, ...base } = forged as MeterPendingClaim & { aggregated_at_ms?: number };
    fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${slice.claim_key}`, { ...forged, integrity_sha256: pendingClaimIntegrity(base) } as unknown as Record<string, unknown>);
    const verdicts = await verifyMeterClaimMembers(db(fake), membersOf(payouts));
    const agentPayout = payouts.find((p) => p.leg === 'agent')!;
    expect(verdicts.get(agentPayout.claim_key)).toEqual({ ok: false, reason: `meter_payout_member_claim_id_not_derived:${slice.claim_key}` });
  });

  it('a run\'s second approval of the same payout reads no member; a changed payout is re-judged (RED)', async () => {
    const fake = createFakeFirestore();
    const { payouts } = await takenAndRegistered(fake);
    let memberReads = 0;
    const realGetAll = fake.getAll.bind(fake);
    fake.getAll = async (...refs) => { memberReads += refs.length; return realGetAll(...refs); };
    const verify = createMeterClaimVerifier(db(fake));
    const first = await verify(membersOf(payouts));
    expect(memberReads).toBe(2); // one slice per payout
    const second = await verify(membersOf(payouts));
    expect(memberReads).toBe(2);
    expect([...second.entries()]).toEqual([...first.entries()]);
    // RED: the payout document changed (its points, integrity recomputed to match) — the memo
    // misses, the members are read again and the payout is refused.
    const agentPayout = payouts.find((p) => p.leg === 'agent')!;
    const changed = { ...agentPayout, record_points_atomic: (BigInt(agentPayout.record_points_atomic) + 1n).toString() };
    const { state: _s, integrity_sha256: _i, ...base } = changed;
    fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${agentPayout.claim_key}`, { ...changed, integrity_sha256: pendingClaimIntegrity(base) } as unknown as Record<string, unknown>);
    const third = await verify(membersOf(payouts));
    expect(memberReads).toBe(3);
    expect(third.get(agentPayout.claim_key)).toEqual({ ok: false, reason: 'meter_payout_points_mismatch' });
  });

  /** Counts the pending-claim reads the flip's transactions make. */
  function countFlipClaimReads(fake: FakeFirestore): { readonly count: () => number } {
    let reads = 0;
    const realRun = fake.runTransaction.bind(fake);
    fake.runTransaction = (<T>(fn: (txn: Parameters<Parameters<FakeFirestore['runTransaction']>[0]>[0]) => Promise<T>) => realRun((txn) => fn({
      ...txn,
      get: ((ref: { collectionPath?: string }) => {
        if (ref.collectionPath === METER_PENDING_CLAIMS_COLLECTION) reads += 1;
        return (txn.get as (r: unknown) => unknown)(ref);
      }) as typeof txn.get,
    }))) as FakeFirestore['runTransaction'];
    return { count: () => reads };
  }

  it('an act mints once every leg\'s claim has settled; RED: with one leg unsettled it waits', async () => {
    const fake = createFakeFirestore();
    const { payouts } = await takenAndRegistered(fake);
    const flipReads = countFlipClaimReads(fake);
    const status = (id: string) => (fake.store.get(`${METER_ACT_KEYS_COLLECTION}/${id}`) as { row: { mint_status: string } }).row.mint_status;
    const agentPayout = payouts.find((p) => p.leg === 'agent')!;
    const humanPayout = payouts.find((p) => p.leg === 'beneficiary')!;
    const one = await settleMeterClaims(db(fake), { claimKeys: [agentPayout.claim_key], batchId: 'b1', txHash: '0x1', nowMs: T0 + W + 16 * HOUR });
    expect(one.acts_partial).toBe(2);
    expect(one.acts_minted).toBe(0);
    expect([status('pe_m_w1'), status('pe_m_w2')]).toEqual(['eligible', 'eligible']);
    // The human leg settles in a later batch: the agent legs (settled earlier) are read through the
    // parent's `moved` to their slice.
    const readsBefore = flipReads.count();
    const two = await settleMeterClaims(db(fake), { claimKeys: [humanPayout.claim_key], batchId: 'b2', txHash: '0x2', nowMs: T0 + W + 17 * HOUR });
    expect(two.acts_minted).toBe(2);
    expect([status('pe_m_w1'), status('pe_m_w2'), status('pe_m_w3')]).toEqual(['minted', 'minted', 'eligible']);
    // The legs settled by the EARLIER writeback were read (the agent parent, then its slice).
    expect(flipReads.count() - readsBefore).toBe(2);
  });

  it('both legs settled in one writeback mint without re-reading the claims it just settled', async () => {
    const fake = createFakeFirestore();
    const { payouts } = await takenAndRegistered(fake);
    const flipReads = countFlipClaimReads(fake);
    const settled = await settleMeterClaims(db(fake), { claimKeys: payouts.map((p) => p.claim_key), batchId: 'b1', txHash: '0x1', nowMs: T0 + W + 16 * HOUR });
    expect(settled.acts_minted).toBe(2);
    expect(settled.acts_partial).toBe(0);
    expect(flipReads.count()).toBe(0);
  });
});

describe('takeover and demotion before registration', () => {
  it('the takeover pre-check: unregistered while every claim carrying the act is pending (RED: taken, missing)', async () => {
    const fake = createFakeFirestore();
    const { parents } = await seedWindowBatch(fake);
    expect(await meterActUnregistered(db(fake), 'pe_m_w1')).toBe(true);
    expect(await meterActUnregistered(db(fake), 'pe_not_metered')).toBeNull();
    await runMeterClaimInlet(db(fake), { nowMs: T0 + W + 15 * HOUR });
    // RED: w1 was cut into a slice a run took — committed to settle.
    expect(await meterActUnregistered(db(fake), 'pe_m_w1')).toBe(false);
    expect(await meterActUnregistered(db(fake), 'pe_m_w3')).toBe(true);
    // RED: a claim gone missing is committed (fail closed), never "unregistered".
    fake.store.delete(`${METER_PENDING_CLAIMS_COLLECTION}/${parents[0].claim_key}`);
    expect(await meterActUnregistered(db(fake), 'pe_m_w3')).toBe(false);
  });

  it('a demotion before registration takes the act\'s points out of its window claims, atomically', async () => {
    const fake = createFakeFirestore();
    const { rows, parents } = await seedWindowBatch(fake);
    const out = await mutatePeHistoryRowWithAggregate(
      db(fake) as unknown as Parameters<typeof mutatePeHistoryRowWithAggregate>[0],
      'pe_m_w1', { mint_status: 'corroborated_duplicate' }, { nowMs: T0 + HOUR },
    );
    expect(out.outcome).toBe('applied');
    for (const p of parents) {
      const leg = p.leg as 'agent' | 'beneficiary';
      const left = fake.store.get(`${METER_PENDING_CLAIMS_COLLECTION}/${p.claim_key}`) as unknown as MeterPendingClaim;
      expect(left.state).toBe('pending');
      expect(left.acts.map((a) => a.relay_pe_id)).toEqual(['pe_m_w2', 'pe_m_w3']);
      expect(BigInt(left.record_points_atomic)).toBe(legPoints(rows[1], leg) + legPoints(rows[2], leg));
      expect(left.ready_at_ms).toBe(rows[1].timestamp + W); // the earliest act left
      expect(pendingClaimIntact(left)).toBe(true);
    }
  });

  it('RED: once a run has cut the act into a slice, its demotion is refused and nothing moves', async () => {
    const fake = createFakeFirestore();
    await seedWindowBatch(fake);
    await runMeterClaimInlet(db(fake), { nowMs: T0 + W + 15 * HOUR });
    const before = JSON.stringify(claimsIn(fake));
    const out = await mutatePeHistoryRowWithAggregate(
      db(fake) as unknown as Parameters<typeof mutatePeHistoryRowWithAggregate>[0],
      'pe_m_w1', { mint_status: 'corroborated_duplicate' }, { nowMs: T0 + W + 16 * HOUR },
    );
    expect(out.outcome).toBe('precondition_failed');
    expect(JSON.stringify(claimsIn(fake))).toBe(before);
    expect((fake.store.get(`${METER_ACT_KEYS_COLLECTION}/pe_m_w1`) as { row: { mint_status: string } }).row.mint_status).toBe('eligible');
  });
});

/** Mark an act an off-chain-witnessed completion (as the resolver seals it), in its act key. */
function asOffchainCompletion(fake: FakeFirestore, peId: string): void {
  const path = `${METER_ACT_KEYS_COLLECTION}/${peId}`;
  const key = fake.store.get(path) as unknown as { row: Record<string, unknown> };
  fake.store.set(path, { ...key, row: { ...key.row, completion_witness: 'counterparty_confirmation' } } as never);
}

const topupsOf = (fake: FakeFirestore, peId: string): MeterPendingClaim[] =>
  claimsIn(fake).filter((c) => c.unit === 'topup' && c.acts.some((a) => a.relay_pe_id === peId));

/** A corroboration lift on every leg of an act, written as `recordMeterIncumbentCorroboration` writes it. */
function seedTopups(fake: FakeFirestore, peId: string, at: number): void {
  const key = fake.store.get(`${METER_ACT_KEYS_COLLECTION}/${peId}`) as unknown as MeterActKeyDoc;
  for (const leg of key.legs ?? []) {
    const delta = (BigInt(leg.points_atomic) / 10n).toString();
    const claim = buildPendingClaim({
      claim_key: meterTopupClaimKey(peId, leg.leg), unit: 'topup', batch_hash: key.batch_hash, device_id: key.device_id,
      actor_id: key.actor_id, leg: leg.leg, contributor: leg.contributor, beneficiary_class: leg.beneficiary_class,
      record_points_atomic: delta, acts: [{ relay_pe_id: peId, points_atomic: delta }],
      claim_id: meterTopupClaimId(actKeyIdentity(key), leg.leg), act_identity: actKeyIdentity(key),
      created_at_ms: at, ready_at_ms: 0,
    });
    fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${claim.claim_key}`, { ...claim } as never);
  }
}

describe('the completion takeover pre-check on a metered incumbent (on the meter)', () => {
  it('an off-chain completion still waiting is taken over by the on-chain release; RED: once a run took it, never', async () => {
    const fake = createFakeFirestore();
    await seedWindowBatch(fake);
    asOffchainCompletion(fake, 'pe_m_w1');
    asOffchainCompletion(fake, 'pe_m_w3');
    const evaluate = (peId: string) => evaluateCompletionWitness(db(fake), { incumbentPeId: peId, newWitness: 'onchain_release' });
    expect(await evaluate('pe_m_w1')).toBe('takeover');
    // A run cuts w1 into a slice and takes it; w3 still waits.
    await runMeterClaimInlet(db(fake), { nowMs: T0 + W + 15 * HOUR });
    // RED: the metered incumbent has no legacy ledger row, so only the meter's own pre-check
    // can see that w1 is committed — without it this reads "unregistered" and answers takeover.
    expect(await evaluate('pe_m_w1')).toBe('none');
    expect(await evaluate('pe_m_w3')).toBe('takeover');
  });
});

describe('an incumbent\'s corroboration top-ups are its earnings too (mint-once across a takeover)', () => {
  it('a pending top-up leaves the act unregistered; RED: a top-up a run has taken makes it registered, in both pre-checks', async () => {
    const fake = createFakeFirestore();
    await seedWindowBatch(fake);
    asOffchainCompletion(fake, 'pe_m_w1');
    seedTopups(fake, 'pe_m_w1', T0 + HOUR);
    expect(topupsOf(fake, 'pe_m_w1').map((t) => t.state)).toEqual(['pending', 'pending']);
    expect(await meterActUnregistered(db(fake), 'pe_m_w1')).toBe(true);
    expect(await evaluateCompletionWitness(db(fake), { incumbentPeId: 'pe_m_w1', newWitness: 'onchain_release' })).toBe('takeover');
    // A run takes the top-ups (ready at once); no window act is ready yet.
    const run = await runMeterClaimInlet(db(fake), { nowMs: T0 + 2 * HOUR });
    expect(run.payouts).toBe(2);
    expect(topupsOf(fake, 'pe_m_w1').map((t) => t.state)).toEqual(['aggregated', 'aggregated']);
    expect(claimsIn(fake).filter((c) => c.unit === 'window').every((c) => c.state === 'pending')).toBe(true);
    // RED: every base claim is still pending, yet the lift is committed to settle.
    expect(await meterActUnregistered(db(fake), 'pe_m_w1')).toBe(false);
    expect(await evaluateCompletionWitness(db(fake), { incumbentPeId: 'pe_m_w1', newWitness: 'onchain_release' })).toBe('none');
    // A voided top-up is no earnings at all.
    for (const t of topupsOf(fake, 'pe_m_w1')) {
      fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${t.claim_key}`, { ...t, state: 'void' } as never);
    }
    expect(await meterActUnregistered(db(fake), 'pe_m_w1')).toBe(true);
  });
});

describe('migration: a pre-fold per-act claim keeps settling beside window claims', () => {
  const LEGACY = 'pe_m_old1';
  async function seedOldActClaims(fake: FakeFirestore, readyAt: number): Promise<{ row: PEHistoryDocument; claims: MeterPendingClaim[] }> {
    const [r] = await seedMeteredRows(fake, [row(LEGACY, T0 - 5 * HOUR)], T0, { withActKeys: false });
    fake.store.set(`${METER_ACT_KEYS_COLLECTION}/${LEGACY}`, actKeyDocFor(r as unknown as Record<string, unknown>, {
      unit: 'act', legs: legsOf(r), batch_hash: 'd'.repeat(64),
    }));
    const identity: SealedEnvelopeIdentity = {
      id: LEGACY, prev_hash: '0'.repeat(64), hash: 'a'.repeat(64), timestamp: r.timestamp, action_type: r.actionType, user_id: 'agent-1',
    };
    const claims = legsOf(r).map((leg) => buildPendingClaim({
      claim_key: meterActClaimKey(LEGACY, leg.leg), unit: 'act', batch_hash: 'd'.repeat(64), device_id: 'dev_1', actor_id: 'agent-1',
      leg: leg.leg, contributor: leg.contributor, beneficiary_class: leg.beneficiary_class, record_points_atomic: leg.points_atomic,
      acts: [{ relay_pe_id: LEGACY, points_atomic: leg.points_atomic }], claim_id: meterActClaimId(identity, leg.leg), act_identity: identity,
      created_at_ms: T0, ready_at_ms: readyAt,
    }));
    for (const c of claims) fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${c.claim_key}`, { ...c });
    return { row: r, claims };
  }

  it('an old act claim is taken, approved and settled in the same payout as window slices, and its act mints', async () => {
    const fake = createFakeFirestore();
    await seedWindowBatch(fake);
    const { claims } = await seedOldActClaims(fake, T0 - 5 * HOUR + W);
    const nowMs = T0 + W + 15 * HOUR;
    await runMeterClaimInlet(db(fake), { nowMs });
    const payouts = claimsIn(fake).filter((c) => c.unit === 'payout');
    expect(payouts).toHaveLength(2);
    for (const c of claims) {
      const payout = payouts.find((p) => p.leg === c.leg)!;
      expect(payout.members!.map((m) => m.claim_key)).toContain(c.claim_key);
      expect(payout.members).toHaveLength(2); // the old act claim + the window slice
    }
    const verdicts = await verifyMeterClaimMembers(db(fake), payouts.map((p) => ({ pe_id: p.claim_key, leg: p.leg as 'agent' | 'beneficiary', claim_id: p.claim_id })));
    expect(payouts.every((p) => verdicts.get(p.claim_key)?.ok === true)).toBe(true);
    const tally = await settleMeterClaims(db(fake), { claimKeys: payouts.map((p) => p.claim_key), batchId: 'b1', txHash: '0x1', nowMs: nowMs + HOUR });
    expect(tally.acts_minted).toBe(3); // the old act + w1 + w2
    expect((fake.store.get(`${METER_ACT_KEYS_COLLECTION}/${LEGACY}`) as { row: { mint_status: string } }).row.mint_status).toBe('minted');
    for (const c of claims) expect((fake.store.get(`${METER_PENDING_CLAIMS_COLLECTION}/${c.claim_key}`) as { state: string }).state).toBe('settled');
  });

  it('RED: an old act claim still inside its window is not taken', async () => {
    const fake = createFakeFirestore();
    const { claims } = await seedOldActClaims(fake, T0 + 10 * W);
    const report = await runMeterClaimInlet(db(fake), { nowMs: T0 + W + 15 * HOUR });
    expect(report.notReady).toBe(2);
    expect(report.payouts).toBe(0);
    for (const c of claims) expect((fake.store.get(`${METER_PENDING_CLAIMS_COLLECTION}/${c.claim_key}`) as { state: string }).state).toBe('pending');
  });
});
