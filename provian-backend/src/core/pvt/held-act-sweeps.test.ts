/**
 * PE METER — every hold sweep covers METERED held acts (`meter_held_acts_v1`) as well as the
 * pre-meter `pe_history` rows, with the same rule.
 *
 * Each sweep gets a POSITIVE case (a metered held act the sweep must transition does: for a
 * promotion its own `ma_<relay_pe_id>_<leg>` pending claim exists and the hold is gone) and a RED
 * negative control (a metered held act the sweep must NOT promote stays held with no claim). The
 * positive cases are the RED controls for the metered branch itself: delete a sweep's held-act
 * walk and its positive case fails (no claim, the hold remains) — recorded below per sweep.
 *
 * Held records are built by hand in the exact shape the batch commit writes
 * (`{ relay_pe_id, held_reason, key: <act key incl. .row>, created_at_ms }`), over rows whose
 * economic snapshots come from the REAL kernel (`computeRecordSnapshot`), never hand-written.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  atomicUnits,
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
  MONETARY_ACCOUNTING_SCHEMA_VERSION,
  PVT_ATOMIC_SCALE,
  type ActionMonetaryPolicy,
  type MonetaryPolicyVersion,
  type RecordCalculationInput,
  type RecordEconomicSnapshot,
} from './policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from './policy/runtime-monetary-policy';
import { listHeldActs, resolveHeldAct } from '../meter/held-acts';
import {
  METER_ACT_KEYS_COLLECTION,
  METER_HELD_ACTS_COLLECTION,
  METER_PENDING_CLAIMS_COLLECTION,
} from '../meter/meter-store';
import {
  PENDING_EVIDENCE_RESOLUTION_COLLECTION,
  applyPendingEvidenceVerdictToHeldAct,
  sweepPendingEvidence,
  type ChainReceiptVerification,
  type HeldPendingEvidenceRow,
  type PendingEvidenceResolverDeps,
  type Verdict,
} from './pending-evidence-resolver';
import { prepareCompletionMintClaim } from './completion-claim';
import { REGISTRY_HOLD_RESOLUTION_COLLECTION, sweepRegistryHolds } from './registry-hold-resolver';
import { applyRegistryHoldResolutionToHeldAct } from './registry-hold-promotion';
import { reserveSpeechWindowBudget } from './speech-window-budget';
import { backfillPendingCachePEs } from './pending-cache-backfill';
import {
  PAYEE_HELD_REASONS,
  recoverBeneficiaryPendingHeldActs,
  retryHeldActPayees,
} from './held-act-recovery';
import { walkHeldActs } from './held-act-sweep';
import { createBeneficiaryRoutingSnapshot, hashBeneficiaryRoutingSnapshot } from './beneficiary-routing';
import { DEFAULT_AGENT_BENEFICIARY_SHARE_BPS } from '../agent-wallet/beneficiary-relationship';
import { EconomicAggregateWriter, ECONOMIC_AGGREGATE_SCHEMA_VERSION } from './policy/economic-aggregate';
import { noteBatchClaimSettlement } from '../meter/batch-economics';
import type { PEHistoryDocument } from '../../pe-history';

// `deferred-release.ts` reads `admin.firestore()`. The factory runs while the imports above are
// still loading, so the fake is parked on `globalThis` rather than in a module `let` (TDZ).
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: make } = require('./__test-helpers__/fake-firestore');
  const db = make();
  (globalThis as { __heldActSweepsFake?: unknown }).__heldActSweepsFake = db;
  return { __esModule: true, default: { firestore: () => db } };
});

// eslint-disable-next-line import/first
import { processDeferredReleaseBatch } from './deferred-release';

const fake = (globalThis as { __heldActSweepsFake?: unknown }).__heldActSweepsFake as FakeFirestore;

const NOW = 1_800_000_000_000;
const AGENT_ADDRESS = `0x${'ab'.repeat(20)}`;

function asDb(db: FakeFirestore): Firestore {
  return db as unknown as Firestore;
}

/**
 * A human-wallet payee for the actor (the registry verifier refuses an agent wallet without its
 * beneficiary-relationship record, so the registry cases pay a human-resolving sole leg).
 */
async function seedHumanPayee(db: FakeFirestore, actorId: string): Promise<void> {
  await db.collection('wallets').doc(`wallet_${actorId}`).set({
    id: `wallet_${actorId}`, user_id: actorId, type: 'human', address: AGENT_ADDRESS,
  });
}

/** The payee every positive case resolves: an active agent wallet for the actor. */
async function seedPayee(db: FakeFirestore, actorId: string): Promise<void> {
  await db.collection('agent_wallets').doc(`w_${actorId}`).set({
    id: `w_${actorId}`, agent_id: actorId, address: AGENT_ADDRESS, status: 'active',
  });
}

function rowOf(
  peId: string,
  snapshot: RecordEconomicSnapshot,
  mintStatus: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    peId,
    userId: snapshot.economicActorId,
    actionType: snapshot.actionType,
    timestamp: snapshot.recordedAtMs,
    peHash: 'e'.repeat(64),
    mint_status: mintStatus,
    mint_disposition: mintStatus,
    economic_snapshot: snapshot,
    economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
    record_points_atomic: snapshot.recordPointsAtomic,
    estimated_pvt_atomic: '0',
    inputSummary: null,
    outputSummary: null,
    ...extra,
  };
}

/** A held record exactly as the batch commit writes it, plus its live 31-day act key. */
function seedHeld(
  db: FakeFirestore,
  relayPeId: string,
  row: Record<string, unknown>,
  heldReason: string,
): void {
  const key = {
    schema: 'provian.meter-act-key.v1',
    relay_pe_id: relayPeId,
    client_pe_id: `client_${relayPeId}`,
    pe_hash: 'b'.repeat(64),
    prev_hash: 'a'.repeat(64),
    device_id: 'dev_1',
    batch_hash: 'c'.repeat(64),
    actor_id: row.userId,
    timestamp: row.timestamp,
    action_type: row.actionType,
    row,
    legs: null,
    unit: 'none',
    held_reason: heldReason,
    side: { statsBump: null, delegation: null, corroborateIncumbentPeId: null, outputDigestsIndexed: false, effect: {} },
    created_at_ms: 1,
    expire_at: null,
  };
  db.store.set(`${METER_HELD_ACTS_COLLECTION}/${relayPeId}`, {
    relay_pe_id: relayPeId, held_reason: heldReason, key, created_at_ms: 1,
  });
  db.store.set(`${METER_ACT_KEYS_COLLECTION}/${relayPeId}`, { ...key });
}

function held(db: FakeFirestore, relayPeId: string): { held_reason: string; key: { row: Record<string, unknown> } } | undefined {
  return db.store.get(`${METER_HELD_ACTS_COLLECTION}/${relayPeId}`) as never;
}

function claim(db: FakeFirestore, relayPeId: string, leg = 'sole'): Record<string, unknown> | undefined {
  return db.store.get(`${METER_PENDING_CLAIMS_COLLECTION}/ma_${relayPeId}_${leg}`);
}

function claimsOf(db: FakeFirestore): string[] {
  return [...db.store.keys()].filter((k) => k.startsWith(`${METER_PENDING_CLAIMS_COLLECTION}/`));
}

// ─────────────────────────────────────────────────────────────────────────────
// The held-act engine: the two defects fixed in `held-acts.ts`.
// ─────────────────────────────────────────────────────────────────────────────

const PROPOSED = materializeProposedMonetaryPolicy(0);

function walletCreatedSnapshot(peId: string, actorId: string, overrides: Partial<RecordCalculationInput> = {}): RecordEconomicSnapshot {
  return computeRecordSnapshot(PROPOSED, {
    peId, economicActorId: actorId, actionType: 'wallet_created', recordedAtMs: 1_000,
    occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false,
    attestationTier: 'software', linkageState: 'unlinked', evidenceState: 'not_required',
    canonicalEventId: null, selfReferencing: false, sharedBeneficialOwnership: false,
    pairChurnDetected: false, sessionLineageId: null, genesisReservation: null, ...overrides,
  });
}

describe('held-act engine', () => {
  async function relayHold(db: FakeFirestore, id: string, frozen: boolean, output = false) {
    const actor = `actor_${id}`;
    await seedHumanPayee(db, actor);
    const snapshot = walletCreatedSnapshot(id, actor, { actionType: 'ai_conversation', evidenceState: 'verified', canonicalEventId:id });
    expect(snapshot.mintDisposition).toBe('eligible');
    expect(BigInt(snapshot.recordPointsAtomic)).toBeGreaterThan(0n);
    const row = rowOf(id, snapshot, 'deferred', { economic_aggregate_applied: ECONOMIC_AGGREGATE_SCHEMA_VERSION,
      ...(output ? { output_digests: ['a'.repeat(64)] } : {}) });
    seedHeld(db, id, row, 'deferred');
    const h = db.store.get(`${METER_HELD_ACTS_COLLECTION}/${id}`)!;
    const key = { ...(h.key as Record<string, unknown>), device_id: `relay:${actor}` };
    db.store.set(`${METER_HELD_ACTS_COLLECTION}/${id}`, { ...h, key });
    db.store.set(`${METER_ACT_KEYS_COLLECTION}/${id}`, key);
    db.store.set(`meter_batches_v1/${'c'.repeat(64)}`, { act_count: 1, per_batch_pricing: true, relay_single_lane: true,
      claim_keys: [], economic_totals: [], retained_act_ids: [id], anchored: true, settlement_complete: false, expire_at: null });
    await asDb(db).runTransaction(async txn => {
      const writer = new EconomicAggregateWriter(asDb(db), txn, NOW);
      await writer.load([actor]);
      if (frozen) writer.setRoleAggregate(actor, 'contributor', { ...writer.roleAggregate(actor,'contributor'), frozen_through_ms: NOW });
      writer.applyRow(row as unknown as PEHistoryDocument, 1); writer.commit();
    });
    return { actor, snapshot, row };
  }

  it.each([false,true])('new relay outputless hold compacts exactly once, including frozen projections (%s)', async frozen => {
    const db = createFakeFirestore(), id = `pe_relay_${frozen}`;
    const {actor,snapshot} = await relayHold(db,id,frozen);
    const patch = { mint_status:'eligible', mint_disposition:'eligible', estimated_pvt_atomic:snapshot.recordPointsAtomic };
    expect((await resolveHeldAct(asDb(db),id,patch,{nowMs:NOW})).outcome).toBe('promoted');
    expect(held(db,id)).toBeUndefined(); expect(db.store.has(`${METER_ACT_KEYS_COLLECTION}/${id}`)).toBe(false);
    const batch = db.store.get(`meter_batches_v1/${'c'.repeat(64)}`)!;
    const keys = batch.claim_keys as string[];
    expect(keys).toHaveLength(1); expect(claimsOf(db)).toHaveLength(1);
    const pending = db.store.get(`${METER_PENDING_CLAIMS_COLLECTION}/${keys[0]}`)!;
    expect(pending).toMatchObject({unit:'batch',record_points_atomic:snapshot.recordPointsAtomic});
    expect(pending.acts).toEqual([{relay_pe_id:id,points_atomic:snapshot.recordPointsAtomic}]);
    const aggregate = () => (db.store.get(`pe_economic_aggregates/${actor}`)!.roles as Record<string,Record<string,unknown>>).contributor;
    expect(aggregate().total_pes).toBe(1); expect(aggregate().frozen_pes).toBe(0);
    expect(aggregate().frozen_projection_rated_atomic).toBe('0');
    expect(BigInt(String(aggregate().batch_pending_rated_atomic))).toBeGreaterThan(0n);
    expect((await resolveHeldAct(asDb(db),id,patch,{nowMs:NOW})).outcome).toBe('missing');
    await noteBatchClaimSettlement(asDb(db),pending as never,true,NOW);
    expect(aggregate().batch_pending_rated_atomic).toBe('0');
    expect(aggregate().pes_by_mint_status).toEqual({minted:1});
    await noteBatchClaimSettlement(asDb(db),pending as never,true,NOW);
    expect(aggregate().pes_by_mint_status).toEqual({minted:1});
    await noteBatchClaimSettlement(asDb(db),pending as never,false,NOW);
    expect(BigInt(String(aggregate().batch_pending_rated_atomic))).toBeGreaterThan(0n);
    expect(aggregate().pes_by_mint_status).toEqual({eligible:1});
  });

  it('new relay payee refusal retains the sealed pricing inputs until a valid payee resolves', async () => {
    const db=createFakeFirestore(),id='pe_relay_refusal';
    const {actor,snapshot}=await relayHold(db,id,false);
    db.store.delete(`wallets/wallet_${actor}`);
    const patch={mint_status:'eligible',mint_disposition:'eligible',estimated_pvt_atomic:snapshot.recordPointsAtomic};
    expect((await resolveHeldAct(asDb(db),id,patch,{nowMs:NOW})).outcome).toBe('promotion_refused');
    expect(held(db,id)?.key.row.economic_snapshot).toEqual(snapshot);
    expect(db.store.has(`${METER_ACT_KEYS_COLLECTION}/${id}`)).toBe(true); expect(claimsOf(db)).toHaveLength(0);
    expect(db.store.get(`meter_batches_v1/${'c'.repeat(64)}`)?.settlement_complete).toBe(false);
    await seedHumanPayee(db,actor);
    expect((await resolveHeldAct(asDb(db),id,{}, {nowMs:NOW+1})).outcome).toBe('promoted');
    expect(db.store.has(`${METER_ACT_KEYS_COLLECTION}/${id}`)).toBe(false);expect(claimsOf(db)).toHaveLength(1);
  });

  it('new relay holds keep recovery inputs until resolved; output resolution keeps only the trust key', async () => {
    const db = createFakeFirestore(),id='pe_relay_output';
    const {snapshot} = await relayHold(db,id,false,true);
    expect((await resolveHeldAct(asDb(db),id,{mint_status:'pending_evidence'},{nowMs:NOW})).outcome).toBe('still_held');
    expect(held(db,id)?.key.row.economic_snapshot).toEqual(snapshot); expect(claimsOf(db)).toHaveLength(0);
    expect((await resolveHeldAct(asDb(db),id,{mint_status:'eligible',mint_disposition:'eligible',estimated_pvt_atomic:snapshot.recordPointsAtomic},{nowMs:NOW})).outcome).toBe('promoted');
    expect(held(db,id)).toBeUndefined();
    const key=db.store.get(`${METER_ACT_KEYS_COLLECTION}/${id}`)!;
    expect((key.row as Record<string,unknown>).economic_snapshot).toEqual(snapshot);
    expect(key.expire_at).toBeNull();
    expect(claimsOf(db)).toHaveLength(1);
    expect(db.store.get(`meter_batches_v1/${'c'.repeat(64)}`)?.economic_totals).toEqual([]);
  });

  it('new relay terminal resolution removes the recovery row without claims, and invalid batch state refuses atomically', async () => {
    const db=createFakeFirestore(),id='pe_relay_terminal'; await relayHold(db,id,true);
    db.store.get(`meter_batches_v1/${'c'.repeat(64)}`)!.act_count=2;
    await expect(resolveHeldAct(asDb(db),id,{mint_status:'record_only',mint_disposition:'record_only'},{nowMs:NOW})).rejects.toThrow('relay_held_batch_state_invalid');
    expect(held(db,id)).toBeDefined(); expect(claimsOf(db)).toHaveLength(0);
    db.store.get(`meter_batches_v1/${'c'.repeat(64)}`)!.act_count=1;
    expect((await resolveHeldAct(asDb(db),id,{mint_status:'record_only',mint_disposition:'record_only'},{nowMs:NOW})).outcome).toBe('released_terminal');
    expect(held(db,id)).toBeUndefined();expect(db.store.has(`${METER_ACT_KEYS_COLLECTION}/${id}`)).toBe(false);
    expect(claimsOf(db)).toHaveLength(0);
    expect(db.store.get(`meter_batches_v1/${'c'.repeat(64)}`)?.settlement_complete).toBe(true);
  });

  it('RED (listHeldActs clamp): a full page at the 500 clamp still reports a next page', async () => {
    const db = createFakeFirestore();
    const snap = walletCreatedSnapshot('pe_x', 'agent_page');
    for (let i = 0; i < 501; i += 1) {
      const id = `pe_page_${String(i).padStart(4, '0')}`;
      seedHeld(db, id, rowOf(id, { ...snap, peId: id } as RecordEconomicSnapshot, 'deferred'), 'deferred');
    }
    // A caller asking for more than the clamp: the query returns 500; the pre-fix code compared
    // against the REQUESTED 1000 and reported `next: null`, ending every walk after one page.
    const page = await listHeldActs(asDb(db), 'deferred', { limit: 1000 });
    expect(page.rows).toHaveLength(500);
    expect(page.next).toBe('pe_page_0499');
    const rest = await listHeldActs(asDb(db), 'deferred', { limit: 1000, startAfter: page.next });
    expect(rest.rows.map((r) => r.relayPeId)).toEqual(['pe_page_0500']);
    expect(rest.next).toBeNull();
  });

  it('RED (refused promotion): the patch lands, the act waits under payee_*, and a no-op retry promotes it', async () => {
    const db = createFakeFirestore();
    const snap = walletCreatedSnapshot('pe_refused', 'agent_late');
    seedHeld(db, 'pe_refused', rowOf('pe_refused', snap, 'deferred'), 'deferred');

    // No payee yet: the promotion is refused.
    const first = await resolveHeldAct(asDb(db), 'pe_refused', {
      mint_status: 'eligible', mint_disposition: 'eligible', estimated_pvt_atomic: snap.recordPointsAtomic,
    }, { nowMs: NOW, expect: (b) => b.mint_status === 'deferred' });
    expect(first.outcome).toBe('promotion_refused');
    // Pre-fix: the patch was dropped (the row stayed `deferred`) and a no-op retry could only
    // flip the hold back to `deferred`. Now the row IS eligible and waits for its payee.
    expect(held(db, 'pe_refused')?.held_reason).toBe('payee_payee_wallet_not_found');
    expect(held(db, 'pe_refused')?.key.row.mint_status).toBe('eligible');
    expect(held(db, 'pe_refused')?.key.row.peHash).toBe('e'.repeat(64)); // the rest of the row survived
    expect((db.store.get(`${METER_ACT_KEYS_COLLECTION}/pe_refused`) as { row: Record<string, unknown> }).row.mint_status)
      .toBe('eligible');
    expect(claim(db, 'pe_refused')).toBeUndefined();

    // Still no payee: the retry leaves it held, with no claim.
    const stillRefused = await retryHeldActPayees(asDb(db), { nowMs: NOW });
    expect(stillRefused).toMatchObject({ scanned: 1, promoted: 0, still_refused: 1 });
    expect(claim(db, 'pe_refused')).toBeUndefined();

    await seedPayee(db, 'agent_late');
    const retried = await retryHeldActPayees(asDb(db), { nowMs: NOW + 1 });
    expect(retried).toMatchObject({ promoted: 1 });
    expect(claim(db, 'pe_refused')).toMatchObject({
      unit: 'act', contributor: AGENT_ADDRESS, record_points_atomic: snap.recordPointsAtomic,
    });
    expect(held(db, 'pe_refused')).toBeUndefined();
  });

  it('every payee refusal reason is retried (no reason left without a walk)', () => {
    expect(PAYEE_HELD_REASONS).toContain('payee_payee_wallet_not_found');
    expect(PAYEE_HELD_REASONS).toContain('payee_actor_unresolvable');
    expect(PAYEE_HELD_REASONS.length).toBe(7);
  });

  it('the walk is resumable: successive bounded passes cover the population, then wrap', async () => {
    const db = createFakeFirestore();
    const snap = walletCreatedSnapshot('pe_w', 'agent_w');
    for (let i = 0; i < 5; i += 1) {
      const id = `pe_w${i}`;
      seedHeld(db, id, rowOf(id, { ...snap, peId: id } as RecordEconomicSnapshot, 'deferred'), 'deferred');
    }
    const seen: string[] = [];
    const pass = () => walkHeldActs(asDb(db), 'deferred', {
      cursor: { collection: 'test_cursor', docId: 'd' }, nowMs: NOW, limit: 2, maxPages: 1,
    }, async (row) => { seen.push(row.relayPeId); });
    const results = [await pass(), await pass(), await pass()];
    expect(results.map((r) => r.scanned)).toEqual([2, 2, 1]);
    expect(seen).toEqual(['pe_w0', 'pe_w1', 'pe_w2', 'pe_w3', 'pe_w4']);
    expect(results[2].reached_end).toBe(true);
    await pass();
    expect(seen.slice(5)).toEqual(['pe_w0', 'pe_w1']); // the next cycle starts at the head
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pending-evidence resolver
// ─────────────────────────────────────────────────────────────────────────────

function evidenceSnapshot(overrides: Partial<RecordCalculationInput>): RecordEconomicSnapshot {
  return computeRecordSnapshot(PROPOSED, {
    peId: 'pe_default', economicActorId: 'agent_ev', actionType: 'send', recordedAtMs: NOW - 60_000,
    occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: true,
    attestationTier: 'software', linkageState: 'unlinked', evidenceState: 'pending',
    canonicalEventId: null, selfReferencing: false, sharedBeneficialOwnership: false,
    pairChurnDetected: false, sessionLineageId: null, genesisReservation: null,
    beneficiaryAgentShareBps: 10_000, operationalDispositionOverride: null, ...overrides,
  });
}

/** The pre-F-A7 mode-(a) institution draft shape (see pending-evidence-resolver.test.ts). */
function linkedEvidenceSnapshot(peId: string): RecordEconomicSnapshot {
  const base = evidenceSnapshot({ peId, actionType: 'job_posted', sessionLineageId: 'pesl2_deadbeef' });
  return {
    ...base,
    mintDisposition: 'pending_evidence',
    recordTimeFactors: {
      ...base.recordTimeFactors,
      evidenceRequirement: 'verified_institution_lifecycle',
      evidenceResolutionMode: 'linked_evidence_pe_only',
    },
  } as RecordEconomicSnapshot;
}

function resolverDeps(db: FakeFirestore, verify: ChainReceiptVerification = { ok: false, reason: 'n/a' }): PendingEvidenceResolverDeps {
  return {
    db: db as unknown as PendingEvidenceResolverDeps['db'],
    verifyChainReceipt: async () => verify,
    resolveActorAddress: async () => AGENT_ADDRESS,
  };
}

describe('pending-evidence resolver over metered held acts', () => {
  it('records linked-evidence ARRIVAL for a metered act (never promotes it)', async () => {
    const db = createFakeFirestore();
    const snap = linkedEvidenceSnapshot('pe_arrival');
    seedHeld(db, 'pe_arrival', rowOf('pe_arrival', snap, 'pending_evidence', {
      corroboration_status: 'on_chain_verified', corroboration_source: '0xabc', corroboration_received_at: NOW - 1,
    }), 'pending_evidence');

    const result = await sweepPendingEvidence(resolverDeps(db), { nowMs: NOW });

    // RED for the metered branch: without the held-act walk, scanned is 0 and no record exists.
    expect(result.held_acts_scanned).toBe(1);
    expect(result.linked_evidence_recorded).toBe(1);
    expect(result.population).toBe(1);
    expect(db.store.get(`${PENDING_EVIDENCE_RESOLUTION_COLLECTION}/pe_arrival`)).toMatchObject({
      outcome: 'linked_evidence_recorded', pe_id: 'pe_arrival',
    });
    expect(held(db, 'pe_arrival')?.held_reason).toBe('pending_evidence');
    expect(claimsOf(db)).toEqual([]);

    const again = await sweepPendingEvidence(resolverDeps(db), { nowMs: NOW + 1 });
    expect(again.already_resolved).toBe(1);
  });

  it('RED: an unverified chain receipt leaves the metered act held, unrecorded, with no claim', async () => {
    const db = createFakeFirestore();
    const snap = evidenceSnapshot({ peId: 'pe_unverified' });
    expect(snap.mintDisposition).toBe('pending_evidence');
    seedHeld(db, 'pe_unverified', rowOf('pe_unverified', snap, 'pending_evidence', { tx_hash: `0x${'1'.repeat(64)}` }), 'pending_evidence');
    await seedPayee(db, 'agent_ev');

    const result = await sweepPendingEvidence(resolverDeps(db, { ok: false, reason: 'not_final' }), { nowMs: NOW });
    expect(result.held_acts_scanned).toBe(1);
    expect(result.awaiting_verified_evidence).toBe(1);
    expect(held(db, 'pe_unverified')?.key.row.mint_status).toBe('pending_evidence');
    expect(db.store.has(`${PENDING_EVIDENCE_RESOLUTION_COLLECTION}/pe_unverified`)).toBe(false);
    expect(claimsOf(db)).toEqual([]);
  });

  async function promotedVerdict(db: FakeFirestore, peId: string, actorId: string): Promise<Verdict> {
    const claimPlan = await prepareCompletionMintClaim(asDb(db), actorId, 'human_job:hjob_1', peId, NOW);
    return {
      outcome: 'promoted',
      reason: 'counterparty_completion_confirmed_by_pe_confirm',
      evidence: {
        kind: 'counterparty_completion_confirmation',
        evidence_id: 'pe_confirm',
        source: 'provenance_envelopes.human_job_completed',
        as_of: String(NOW - 10),
        canonical_event_id: 'human_job:hjob_1',
      },
      promotion: {
        jobId: 'hjob_1', posterWalletId: 'w_poster', canonicalId: 'human_job:hjob_1',
        confirmationPeId: 'pe_confirm', confirmationTimestampMs: NOW - 10, claim: claimPlan,
      },
    };
  }

  it('a PROMOTED verdict claims the slot, creates the act claim, removes the hold, records once', async () => {
    const db = createFakeFirestore();
    const snap = evidenceSnapshot({ peId: 'pe_promote' });
    const row = rowOf('pe_promote', snap, 'pending_evidence');
    seedHeld(db, 'pe_promote', row, 'pending_evidence');
    await seedPayee(db, 'agent_ev');
    const verdict = await promotedVerdict(db, 'pe_promote', 'agent_ev');

    const outcome = await applyPendingEvidenceVerdictToHeldAct(
      asDb(db), row as unknown as HeldPendingEvidenceRow, verdict, { nowMs: NOW }, 'sha256:x',
    );
    expect(outcome).toBe('promoted');
    expect(claim(db, 'pe_promote')).toMatchObject({
      unit: 'act', contributor: AGENT_ADDRESS, record_points_atomic: snap.recordPointsAtomic,
    });
    expect(held(db, 'pe_promote')).toBeUndefined();
    const key = db.store.get(`${METER_ACT_KEYS_COLLECTION}/pe_promote`) as { row: Record<string, unknown> };
    expect(key.row).toMatchObject({ mint_status: 'eligible', corroboration_status: 'peer_verified', completion_witness: 'counterparty_confirmation' });
    expect(key.row.economic_snapshot_hash).toBe(row.economic_snapshot_hash); // the seal is untouched
    const slot = [...db.store.entries()].find(([k, v]) => k.startsWith('completion_mint_claims/')
      || (v as { claim_kind?: string }).claim_kind === 'completion');
    expect(slot?.[1]).toMatchObject({ owner_pe_id: 'pe_promote' });
    expect(db.store.get(`${PENDING_EVIDENCE_RESOLUTION_COLLECTION}/pe_promote`)).toMatchObject({ outcome: 'promoted' });

    // Exactly once: the hold is gone, so a replay finds the resolution and writes nothing.
    const replay = await applyPendingEvidenceVerdictToHeldAct(
      asDb(db), row as unknown as HeldPendingEvidenceRow, verdict, { nowMs: NOW + 1 }, 'sha256:x',
    );
    expect(replay).toBe('already_resolved');
    expect(claimsOf(db)).toHaveLength(1);
  });

  it('RED: a completion slot another witness took meanwhile refuses BY NAME — held, no act claim', async () => {
    const db = createFakeFirestore();
    const snap = evidenceSnapshot({ peId: 'pe_raced' });
    const row = rowOf('pe_raced', snap, 'pending_evidence');
    seedHeld(db, 'pe_raced', row, 'pending_evidence');
    await seedPayee(db, 'agent_ev');
    const verdict = await promotedVerdict(db, 'pe_raced', 'agent_ev');
    // The on-chain release takes the slot between the verifier's preparation and the promotion.
    const theirs = await prepareCompletionMintClaim(asDb(db), 'agent_ev', 'human_job:hjob_1', 'pe_onchain', NOW);
    db.store.set(`${theirs.claim_collection}/${theirs.evidence.claim.claim_id}`, { ...theirs.evidence.claim });

    const outcome = await applyPendingEvidenceVerdictToHeldAct(
      asDb(db), row as unknown as HeldPendingEvidenceRow, verdict, { nowMs: NOW }, 'sha256:x',
    );
    expect(outcome).toBe('refused_canonical_event_already_minted');
    expect(held(db, 'pe_raced')?.key.row.mint_status).toBe('pending_evidence');
    expect(claimsOf(db)).toEqual([]);
    expect(db.store.has(`${PENDING_EVIDENCE_RESOLUTION_COLLECTION}/pe_raced`)).toBe(false);
  });

  it('RED: a re-bound snapshot hash is refused inside the transition — held, no claim', async () => {
    const db = createFakeFirestore();
    const snap = evidenceSnapshot({ peId: 'pe_rebound' });
    const row = rowOf('pe_rebound', snap, 'pending_evidence');
    seedHeld(db, 'pe_rebound', { ...row, economic_snapshot_hash: 'f'.repeat(64) }, 'pending_evidence');
    await seedPayee(db, 'agent_ev');
    const verdict = await promotedVerdict(db, 'pe_rebound', 'agent_ev');

    const outcome = await applyPendingEvidenceVerdictToHeldAct(
      asDb(db), row as unknown as HeldPendingEvidenceRow, verdict, { nowMs: NOW }, 'sha256:x',
    );
    expect(outcome).toBe('refused_snapshot_unbound');
    expect(held(db, 'pe_rebound')).toBeDefined();
    expect(claimsOf(db)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// registry-hold resolver
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY_ACTION: ActionMonetaryPolicy = {
  category: 'compute', baseWeightBps: 10_000, policyOverrideBps: null,
  mintDisposition: 'eligible', mintReasonCode: 'policy_eligible',
  policyReviewState: 'not_required', policyReviewReasonCode: 'known_policy_entry',
  financialAttestationNeutral: false, allowVerifiedAttestationUpgrade: true,
  evidenceRequirement: 'verified_compute_or_work', canonicalEventRequired: true,
  canonicalEventGroup: 'verified_work_artifact',
  beneficialOwnershipPolicy: 'record_only_if_self_shared_or_churn',
  sessionLineagePolicy: 'required', fixedGrantSource: 'none',
  evidenceResolutionMode: 'projection_with_verified_evidence',
};

function registryPolicy(): MonetaryPolicyVersion {
  return {
    schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION, policyVersion: 'pvt-policy-v1',
    effectiveAtMs: 1_000, effectiveUntilMs: null, basePointsAtomic: atomicUnits(PVT_ATOMIC_SCALE),
    attestationMultipliersBps: { software: 8_000, corroborated: 11_000, software_verified: 12_000, hardware_full: 25_000 },
    linkageMultipliersBps: { unlinked: 10_000, human_linked: 20_000, beneficiary_linked: 20_000, unverifiable: 10_000 },
    actions: { agent_tool_orchestration: REGISTRY_ACTION },
  };
}

function registrySnapshot(actorId: string, peId: string, overrides: Partial<RecordCalculationInput> = {}): RecordEconomicSnapshot {
  return computeRecordSnapshot(registryPolicy(), {
    peId, economicActorId: actorId, actionType: 'agent_tool_orchestration', recordedAtMs: 1_500,
    occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false,
    attestationTier: 'software', linkageState: 'unverifiable', evidenceState: 'verified',
    canonicalEventId: `agent_tool_orchestration:${peId}`, selfReferencing: false,
    sharedBeneficialOwnership: false, pairChurnDetected: false, sessionLineageId: 'session:root',
    genesisReservation: null, ...overrides,
  });
}

function registryRow(actorId: string, peId: string, snap: RecordEconomicSnapshot): Record<string, unknown> {
  return rowOf(peId, snap, 'pending_review', {
    economic_actor_id: actorId,
    mint_once_claim_evidence: [{ relation: 'owner', claim: { claim_kind: 'device_occurrence', owner_pe_id: peId, owner_user_id: actorId } }],
  });
}

const stubCache = { setBeneficiaryStatus: async () => {} } as unknown as RedisCache;

describe('registry-hold resolver over metered held acts', () => {
  it('resolves a metered registry hold: act claim created, hold removed, audit record written', async () => {
    const db = createFakeFirestore();
    await seedHumanPayee(db, 'agent_reg');
    seedHeld(db, 'pe_reg', registryRow('agent_reg', 'pe_reg', registrySnapshot('agent_reg', 'pe_reg')), 'pending_review');

    const result = await sweepRegistryHolds({ db: asDb(db), cache: stubCache }, { nowMs: NOW });

    // RED for the metered branch: without the held-act walk, nothing is scanned or resolved.
    expect(result.held_acts_scanned).toBe(1);
    expect(result.resolved_unlinked).toBe(1);
    expect(claim(db, 'pe_reg')).toMatchObject({ unit: 'act', contributor: AGENT_ADDRESS });
    expect(held(db, 'pe_reg')).toBeUndefined();
    expect(db.store.get(`${REGISTRY_HOLD_RESOLUTION_COLLECTION}/pe_reg`)).toMatchObject({ pe_id: 'pe_reg', linkage: 'unlinked' });
  });

  it('RED: a metered pending_review act that is NOT a registry hold stays held with no claim', async () => {
    const db = createFakeFirestore();
    await seedHumanPayee(db, 'agent_nr');
    seedHeld(db, 'pe_nr', registryRow('agent_nr', 'pe_nr', registrySnapshot('agent_nr', 'pe_nr', { linkageState: 'unlinked' })), 'pending_review');

    const result = await sweepRegistryHolds({ db: asDb(db), cache: stubCache }, { nowMs: NOW });
    expect(result.held_acts_scanned).toBe(1);
    expect(result.skipped_not_registry_hold).toBe(1);
    expect(held(db, 'pe_nr')?.key.row.mint_status).toBe('pending_review');
    expect(claimsOf(db)).toEqual([]);
  });

  it('a metered registry hold that OWNS its x402 claim (a facilitator act) resolves end to end', async () => {
    const db = createFakeFirestore();
    await seedHumanPayee(db, 'agent_x402');
    const row = {
      ...registryRow('agent_x402', 'pe_x402fac_1', registrySnapshot('agent_x402', 'pe_x402fac_1')),
      mint_once_claim_evidence: [{ relation: 'owner', claim: { claim_kind: 'x402', owner_pe_id: 'pe_x402fac_1', owner_user_id: 'agent_x402' } }],
    };
    seedHeld(db, 'pe_x402fac_1', row, 'pending_review');

    const result = await sweepRegistryHolds({ db: asDb(db), cache: stubCache }, { nowMs: NOW });
    // RED (pre-fix source): refused_not_device_occurrence_owner, the act stayed held with no claim.
    expect(result.resolved_unlinked).toBe(1);
    expect(claim(db, 'pe_x402fac_1')).toMatchObject({ unit: 'act' });
    expect(held(db, 'pe_x402fac_1')).toBeUndefined();
  });

  it('RED : a metered x402 DUPLICATE (another act owns the claim) is refused, stays held', async () => {
    const db = createFakeFirestore();
    await seedHumanPayee(db, 'agent_x402d');
    const row = {
      ...registryRow('agent_x402d', 'pe_x402fac_2', registrySnapshot('agent_x402d', 'pe_x402fac_2')),
      mint_once_claim_evidence: [{ relation: 'duplicate', claim: { claim_kind: 'x402', owner_pe_id: 'pe_watcher', owner_user_id: 'agent_x402d' } }],
    };
    seedHeld(db, 'pe_x402fac_2', row, 'pending_review');

    const result = await sweepRegistryHolds({ db: asDb(db), cache: stubCache }, { nowMs: NOW });
    expect(result.refused_not_mint_once_owner).toBe(1);
    expect(held(db, 'pe_x402fac_2')).toBeDefined();
    expect(claimsOf(db)).toEqual([]);
  });

  /*
   * A metered linked claimless speech act releases at its BOOKED points, split across the agent
   * and beneficiary legs. RED CONTROL RECORD (in the commit): against the prior source it was
   * refused `refused_not_mint_once_owner` and stayed held with no claim; with the booked branch
   * removed (the linked 2.0x re-price) the leg sum is 2× the booked points.
   */
  const SPEECH = 'commons_thread_message';
  const SPEECH_ACTION: ActionMonetaryPolicy = {
    ...REGISTRY_ACTION, evidenceRequirement: 'verified_witness_class',
    canonicalEventGroup: `witness_class:${SPEECH}`, sessionLineagePolicy: 'optional',
  };
  function speechPolicy(): MonetaryPolicyVersion {
    const p = registryPolicy();
    return { ...p, actions: { ...p.actions, [SPEECH]: SPEECH_ACTION } };
  }
  const SPEECH_PE_HASH = 'e'.repeat(64); // rowOf's peHash
  function speechSnapshot(actorId: string, peId: string): RecordEconomicSnapshot {
    return computeRecordSnapshot(speechPolicy(), {
      peId, economicActorId: actorId, actionType: SPEECH, recordedAtMs: 1_500,
      occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false,
      attestationTier: 'software', linkageState: 'unverifiable', evidenceState: 'verified',
      canonicalEventId: `${SPEECH}:${SPEECH_PE_HASH}`, selfReferencing: false,
      sharedBeneficialOwnership: false, pairChurnDetected: false, sessionLineageId: null, genesisReservation: null,
    });
  }
  async function seedLinkedSpeech(db: FakeFirestore, actorId: string, peId: string, booked: boolean): Promise<RecordEconomicSnapshot> {
    const snap = speechSnapshot(actorId, peId);
    seedHeld(db, peId, rowOf(peId, snap, 'pending_review', {
      economic_actor_id: actorId, mint_once_claim_evidence: [], mint_once_claim_evidence_hash: null,
    }), 'pending_review');
    await seedPayee(db, actorId);
    await db.collection('wallets').doc('wallet_h').set({ id: 'wallet_h', user_id: 'user_h', type: 'human', address: `0x${'cd'.repeat(20)}` });
    if (booked) {
      await reserveSpeechWindowBudget(asDb(db), {
        peId, walletId: actorId, actionType: SPEECH, burnId: 'burn_1',
        burnAmountAtomic: (100n * PVT_ATOMIC_SCALE).toString(), pointsAtomic: snap.recordPointsAtomic, timestampMs: 1_500,
      });
    }
    return snap;
  }
  function linkedSpeechInput(actorId: string, peId: string, snap: RecordEconomicSnapshot) {
    return {
      peId, economicActorId: actorId, economicSnapshotHash: hashRecordEconomicSnapshot(snap), policy: speechPolicy(), nowMs: NOW,
      verdict: {
        kind: 'resolve' as const, linkage: 'beneficiary_linked' as const,
        beneficiary: {
          linked: true as const, humanWalletId: 'wallet_h', humanUserId: 'user_h',
          humanAddress: `0x${'cd'.repeat(20)}`, agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
        },
      },
    };
  }

  it('a metered LINKED claimless speech act releases at its booked points across the agent and beneficiary legs', async () => {
    const db = createFakeFirestore();
    const snap = await seedLinkedSpeech(db, 'agent_sp', 'pe_sp', true);

    expect(await applyRegistryHoldResolutionToHeldAct(asDb(db), linkedSpeechInput('agent_sp', 'pe_sp', snap))).toBe('resolved');
    const agent = claim(db, 'pe_sp', 'agent');
    const beneficiary = claim(db, 'pe_sp', 'beneficiary');
    expect(agent).toBeDefined();
    expect(beneficiary).toBeDefined();
    expect(claim(db, 'pe_sp', 'sole')).toBeUndefined();
    const legSum = BigInt(agent?.record_points_atomic as string) + BigInt(beneficiary?.record_points_atomic as string);
    expect(legSum.toString()).toBe(snap.recordPointsAtomic);
    expect(held(db, 'pe_sp')).toBeUndefined();

    // MINT-ONCE: a second pass finds no held act and creates nothing.
    const before = claimsOf(db);
    expect(await applyRegistryHoldResolutionToHeldAct(asDb(db), linkedSpeechInput('agent_sp', 'pe_sp', snap))).toBe('refused_not_pending');
    expect(claimsOf(db)).toEqual(before);
  });

  it('RED (Unknown = Block): a metered linked claimless speech act with no booking stays held with no claim', async () => {
    const db = createFakeFirestore();
    const snap = await seedLinkedSpeech(db, 'agent_sp2', 'pe_sp2', false);
    expect(await applyRegistryHoldResolutionToHeldAct(asDb(db), linkedSpeechInput('agent_sp2', 'pe_sp2', snap))).toBe('refused_booking_unverified');
    expect(held(db, 'pe_sp2')?.key.row.mint_status).toBe('pending_review');
    expect(claimsOf(db)).toEqual([]);
  });

  it('RED: a metered registry hold that is not its occurrence owner is refused, stays held', async () => {
    const db = createFakeFirestore();
    await seedHumanPayee(db, 'agent_dup');
    const row = { ...registryRow('agent_dup', 'pe_dupe', registrySnapshot('agent_dup', 'pe_dupe')), mint_once_claim_evidence: [] };
    seedHeld(db, 'pe_dupe', row, 'pending_review');

    const result = await sweepRegistryHolds({ db: asDb(db), cache: stubCache }, { nowMs: NOW });
    expect(result.refused_not_mint_once_owner).toBe(1);
    expect(held(db, 'pe_dupe')).toBeDefined();
    expect(claimsOf(db)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deferred release (module-level `admin.firestore()` → the mocked `fake`)
// ─────────────────────────────────────────────────────────────────────────────

describe('deferred release over metered held acts', () => {
  beforeEach(() => {
    fake.store.clear();
  });
  const config = { jurisdiction: 'US', daily_ceiling_percent: 100, re_attestation_required: true, activated_at: 1, active: true };

  it('releases a metered act of the jurisdiction (claim + hold removed); another jurisdiction stays held', async () => {
    await seedPayee(fake, 'user-1');
    const us = walletCreatedSnapshot('pe_us', 'user-1');
    const de = walletCreatedSnapshot('pe_de', 'user-1');
    seedHeld(fake, 'pe_us', rowOf('pe_us', us, 'deferred', { jurisdiction_context: 'US' }), 'deferred');
    seedHeld(fake, 'pe_de', rowOf('pe_de', de, 'deferred', { jurisdiction_context: 'DE' }), 'deferred');

    // RED for the metered branch: without the held-act walk this resolves to 0 with no claim.
    await expect(processDeferredReleaseBatch(config, 5)).resolves.toBe(1);
    expect(claim(fake, 'pe_us')).toMatchObject({ unit: 'act', record_points_atomic: us.recordPointsAtomic });
    expect(held(fake, 'pe_us')).toBeUndefined();
    expect(held(fake, 'pe_de')?.key.row.mint_status).toBe('deferred');
    expect(claim(fake, 'pe_de')).toBeUndefined();
  });

  it('RED: the per-run ceiling binds metered acts too, and the pre-meter rows take it first', async () => {
    await seedPayee(fake, 'user-1');
    const legacy = walletCreatedSnapshot('pe_legacy', 'user-1');
    fake.store.set('pe_history/pe_legacy', rowOf('pe_legacy', legacy, 'deferred', { jurisdiction_context: 'US' }));
    const m = walletCreatedSnapshot('pe_m', 'user-1');
    seedHeld(fake, 'pe_m', rowOf('pe_m', m, 'deferred', { jurisdiction_context: 'US' }), 'deferred');

    // Ceiling 1: the pre-meter row is released; the metered act waits for the next run.
    await expect(processDeferredReleaseBatch(config, 1)).resolves.toBe(1);
    expect((fake.store.get('pe_history/pe_legacy') as { mint_status: string }).mint_status).toBe('eligible');
    expect(held(fake, 'pe_m')).toBeDefined();
    expect(claim(fake, 'pe_m')).toBeUndefined();

    await expect(processDeferredReleaseBatch(config, 1)).resolves.toBe(1);
    expect(held(fake, 'pe_m')).toBeUndefined();
    expect(claim(fake, 'pe_m')).toBeDefined();
  });

  it('RED: a metered act whose snapshot does not bind becomes record-only, never eligible', async () => {
    const snap = walletCreatedSnapshot('pe_bad', 'user-1');
    seedHeld(fake, 'pe_bad', rowOf('pe_bad', snap, 'deferred', { jurisdiction_context: 'US', economic_snapshot_hash: 'f'.repeat(64) }), 'deferred');
    await expect(processDeferredReleaseBatch(config, 5)).resolves.toBe(0);
    expect(held(fake, 'pe_bad')).toBeUndefined();
    expect((fake.store.get(`${METER_ACT_KEYS_COLLECTION}/pe_bad`) as { row: Record<string, unknown> }).row.mint_status).toBe('record_only');
    expect(claimsOf(fake)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pending-cache backfill (pitfall #45: the Redis-atomic consume precedes every eligible)
// ─────────────────────────────────────────────────────────────────────────────

function pendingCacheSnapshot(peId: string, actorId: string, recordedAtMs: number): RecordEconomicSnapshot {
  return walletCreatedSnapshot(peId, actorId, {
    recordedAtMs,
    operationalDispositionOverride: { mintDisposition: 'pending_cache', mintReasonCode: 'cache_unavailable', suppressRecordPoints: false },
  });
}

function recoveringCache(options: { fail?: boolean } = {}): { cache: RedisCache; consumed: string[] } {
  const consumed: string[] = [];
  const cache = {
    isEnabled: () => true,
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    consumeRecoveredPECounterSlot: async (_userId: string, peId: string) => {
      if (options.fail) throw new Error('redis unavailable');
      consumed.push(peId);
      return {
        hourlyCountBefore: 0, dailyCountBefore: 0, hourlyCountAfter: 1, dailyCountAfter: 1,
        occurrenceCountBefore: 0, occurrenceCountAfter: 1, idempotent: false,
      };
    },
  } as unknown as RedisCache;
  return { cache, consumed };
}

describe('pending-cache backfill over metered held acts', () => {
  it('recovers a metered act after the Redis-atomic consume: claim created, hold removed', async () => {
    const db = createFakeFirestore();
    await seedPayee(db, 'user-c');
    const snap = pendingCacheSnapshot('pe_cache', 'user-c', 1_000_000);
    expect(snap.mintDisposition).toBe('pending_cache');
    seedHeld(db, 'pe_cache', rowOf('pe_cache', snap, 'pending_cache'), 'pending_cache');
    const { cache, consumed } = recoveringCache();

    const result = await backfillPendingCachePEs(cache, asDb(db), { now: () => NOW });

    // RED for the metered branch: without the held-act walk nothing is consumed or recovered.
    expect(result.held_acts_scanned).toBe(1);
    expect(result.reclassified_eligible).toBe(1);
    expect(consumed).toEqual(['pe_cache']);
    expect(claim(db, 'pe_cache')).toMatchObject({ unit: 'act', contributor: AGENT_ADDRESS });
    expect(held(db, 'pe_cache')).toBeUndefined();
    const key = db.store.get(`${METER_ACT_KEYS_COLLECTION}/pe_cache`) as { row: Record<string, unknown> };
    expect(key.row).toMatchObject({ mint_status: 'eligible', pending_cache_outcome: 'eligible_novelty_corrected' });
  });

  it('RED (pitfall #45): a Redis failure leaves the metered act held, unconsumed, with no claim', async () => {
    const db = createFakeFirestore();
    await seedPayee(db, 'user-c');
    seedHeld(db, 'pe_nocache', rowOf('pe_nocache', pendingCacheSnapshot('pe_nocache', 'user-c', 1_000_000), 'pending_cache'), 'pending_cache');
    const { cache } = recoveringCache({ fail: true });

    const result = await backfillPendingCachePEs(cache, asDb(db), { now: () => NOW });
    expect(result.errors).toBe(1);
    expect(result.reclassified_eligible).toBe(0);
    expect(held(db, 'pe_nocache')?.key.row.mint_status).toBe('pending_cache');
    expect(claimsOf(db)).toEqual([]);
  });

  it('RED: a metered act younger than the 5-minute age gate is not touched', async () => {
    const db = createFakeFirestore();
    await seedPayee(db, 'user-c');
    seedHeld(db, 'pe_young', rowOf('pe_young', pendingCacheSnapshot('pe_young', 'user-c', NOW - 1_000), 'pending_cache'), 'pending_cache');
    const { cache, consumed } = recoveringCache();

    const result = await backfillPendingCachePEs(cache, asDb(db), { now: () => NOW });
    expect(result.held_acts_scanned).toBe(0);
    expect(consumed).toEqual([]);
    expect(held(db, 'pe_young')).toBeDefined();
    expect(claimsOf(db)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// beneficiary-pending recovery (the rule the retired PVTv8 minting engine applied)
// ─────────────────────────────────────────────────────────────────────────────

const HUMAN_ADDRESS = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function parkedLinkedRow(peId: string): Record<string, unknown> {
  const snap = walletCreatedSnapshot(peId, 'agent-1', {
    recordedAtMs: Date.UTC(2026, 6, 4, 12, 0), linkageState: 'beneficiary_linked', beneficiaryAgentShareBps: 2_000,
  });
  const route = createBeneficiaryRoutingSnapshot({
    peId, economicActorId: 'agent-1', recordedAtMs: snap.recordedAtMs,
    beneficiary: {
      linked: true, humanWalletId: 'wallet-human', humanUserId: 'human-1',
      humanAddress: HUMAN_ADDRESS, agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    },
  })!;
  return rowOf(peId, snap, 'beneficiary_pending', {
    disposition_reason_code: 'beneficiary_unresolved',
    beneficiary_wallet_id: 'human-1',
    pvt_split: { total: 10, agent_share: 2, human_share: 8, ratio: 0.2 },
    beneficiary_routing_snapshot: route,
    beneficiary_routing_snapshot_hash: hashBeneficiaryRoutingSnapshot(route),
  });
}

describe('beneficiary-pending recovery over metered held acts', () => {
  it('restores a metered act once its committed human address resolves: both legs claimed, hold removed', async () => {
    const db = createFakeFirestore();
    await seedPayee(db, 'agent-1');
    seedHeld(db, 'pe_linked', parkedLinkedRow('pe_linked'), 'beneficiary_pending');

    // Unresolved first: stays parked, no claim.
    const parkedPass = await recoverBeneficiaryPendingHeldActs(asDb(db), { nowMs: NOW });
    expect(parkedPass).toMatchObject({ scanned: 1, still_pending: 1, restored_eligible: 0 });
    expect(held(db, 'pe_linked')?.held_reason).toBe('beneficiary_pending');
    expect(claimsOf(db)).toEqual([]);

    db.store.set('wallets/wallet-human', { id: 'wallet-human', type: 'human', user_id: 'human-1', address: HUMAN_ADDRESS });
    // RED for the metered branch: without the walk the act is never restored and no claim exists.
    const restored = await recoverBeneficiaryPendingHeldActs(asDb(db), { nowMs: NOW + 1 });
    expect(restored).toMatchObject({ restored_eligible: 1 });
    expect(claim(db, 'pe_linked', 'agent')).toMatchObject({ contributor: AGENT_ADDRESS });
    expect(claim(db, 'pe_linked', 'beneficiary')).toMatchObject({ contributor: HUMAN_ADDRESS });
    expect(held(db, 'pe_linked')).toBeUndefined();
  });

  it('RED: an act whose economic binding is invalid becomes record-only — never eligible, no claim', async () => {
    const db = createFakeFirestore();
    await seedPayee(db, 'agent_bp');
    const snap = walletCreatedSnapshot('pe_bp', 'agent_bp');
    seedHeld(db, 'pe_bp', rowOf('pe_bp', snap, 'beneficiary_pending', { economic_snapshot_hash: 'f'.repeat(64) }), 'beneficiary_pending');

    const result = await recoverBeneficiaryPendingHeldActs(asDb(db), { nowMs: NOW });
    // Without the metered walk, scanned is 0 and the act stays parked.
    expect(result).toMatchObject({ scanned: 1, record_only: 1, restored_eligible: 0 });
    expect(held(db, 'pe_bp')).toBeUndefined();
    expect((db.store.get(`${METER_ACT_KEYS_COLLECTION}/pe_bp`) as { row: Record<string, unknown> }).row.mint_status).toBe('record_only');
    expect(claimsOf(db)).toEqual([]);
  });

  it('RED: an unlinked act (no committed route) is invalid for this hold and never promoted', async () => {
    const db = createFakeFirestore();
    await seedPayee(db, 'agent_bp2');
    const snap = walletCreatedSnapshot('pe_bp2', 'agent_bp2');
    seedHeld(db, 'pe_bp2', rowOf('pe_bp2', snap, 'beneficiary_pending'), 'beneficiary_pending');
    const result = await recoverBeneficiaryPendingHeldActs(asDb(db), { nowMs: NOW });
    expect(result.restored_eligible).toBe(0);
    expect(claimsOf(db)).toEqual([]);
  });
});
