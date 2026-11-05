/**
 * registry-hold promoter — the sanctioned writer + its five money-safety fences.
 * Every fence ships with its RED control.
 */

import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  MONETARY_ACCOUNTING_SCHEMA_VERSION,
  PVT_ATOMIC_SCALE,
  atomicUnits,
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
  type ActionMonetaryPolicy,
  type MonetaryPolicyVersion,
  type RecordCalculationInput,
  type RecordEconomicSnapshot,
} from './policy/monetary-accounting';
import { hashBeneficiaryRoutingSnapshot } from './beneficiary-routing';
import { canonicalAgentBeneficiaryShareBps } from '../agent-wallet/beneficiary-relationship';
import type { BeneficiaryCacheEntry } from './beneficiary';
import type { RegistryHoldVerdict } from './registry-hold-verifier';
import { applyRegistryHoldResolutionInTransaction } from './registry-hold-promotion';
import {
  SPEECH_WINDOW_BUDGETS_COLLECTION,
  SPEECH_WINDOW_RESERVATIONS_COLLECTION,
  reserveSpeechWindowBudget,
} from './speech-window-budget';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';

const NOW = 5_000_000;
const ACTOR = 'agent_x';
const HUMAN_ADDR = `0x${'2'.repeat(40)}`;

const DEFAULT_ACTION: ActionMonetaryPolicy = {
  category: 'compute',
  baseWeightBps: 10_000,
  policyOverrideBps: null,
  mintDisposition: 'eligible',
  mintReasonCode: 'policy_eligible',
  policyReviewState: 'not_required',
  policyReviewReasonCode: 'known_policy_entry',
  financialAttestationNeutral: false,
  allowVerifiedAttestationUpgrade: true,
  evidenceRequirement: 'verified_compute_or_work',
  canonicalEventRequired: true,
  canonicalEventGroup: 'verified_work_artifact',
  beneficialOwnershipPolicy: 'record_only_if_self_shared_or_churn',
  sessionLineagePolicy: 'required',
  fixedGrantSource: 'none',
  evidenceResolutionMode: 'projection_with_verified_evidence',
};

function makePolicy(): MonetaryPolicyVersion {
  return {
    schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION,
    policyVersion: 'pvt-policy-v1',
    effectiveAtMs: 1_000,
    effectiveUntilMs: null,
    basePointsAtomic: atomicUnits(PVT_ATOMIC_SCALE),
    attestationMultipliersBps: { software: 8_000, corroborated: 11_000, software_verified: 12_000, hardware_full: 25_000 },
    linkageMultipliersBps: { unlinked: 10_000, human_linked: 20_000, beneficiary_linked: 20_000, unverifiable: 10_000 },
    actions: { agent_tool_orchestration: DEFAULT_ACTION },
  };
}

function makeSealed(overrides: Partial<RecordCalculationInput> = {}): RecordEconomicSnapshot {
  return computeRecordSnapshot(makePolicy(), {
    peId: 'pe_1',
    economicActorId: ACTOR,
    actionType: 'agent_tool_orchestration',
    recordedAtMs: 1_500,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unverifiable',
    evidenceState: 'verified',
    canonicalEventId: 'agent_tool_orchestration:turn1',
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: 'session:root',
    genesisReservation: null,
    ...overrides,
  });
}

function ownerEvidence(peId: string): Record<string, unknown> {
  return {
    schema_version: 'pvt-mint-once-evidence/v1',
    relation: 'owner',
    claim: { claim_kind: 'device_occurrence', subject_id: ACTOR, owner_pe_id: peId, owner_user_id: ACTOR },
  };
}

async function seedRow(
  db: FakeFirestore,
  peId: string,
  snapshot: RecordEconomicSnapshot,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.collection('pe_history').doc(peId).set({
    peId,
    userId: snapshot.economicActorId,
    economic_actor_id: snapshot.economicActorId,
    actionType: snapshot.actionType,
    timestamp: snapshot.recordedAtMs,
    mint_status: 'pending_review',
    mint_disposition: 'pending_review',
    economic_snapshot: snapshot,
    economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
    record_points_atomic: snapshot.recordPointsAtomic,
    estimated_pvt_atomic: '0',
    mint_once_claim_evidence: [ownerEvidence(peId)],
    ...extra,
  });
}

async function readRow(db: FakeFirestore, peId: string): Promise<Record<string, unknown>> {
  return ((await db.collection('pe_history').doc(peId).get()).data() ?? {}) as Record<string, unknown>;
}

const UNLINKED_VERDICT: RegistryHoldVerdict = { kind: 'resolve', linkage: 'unlinked', beneficiary: null };
function linkedVerdict(): RegistryHoldVerdict {
  const agentShareBps = canonicalAgentBeneficiaryShareBps({ bps: 2_000 });
  if (agentShareBps === null) throw new Error('test agent share invalid');
  const beneficiary: BeneficiaryCacheEntry = {
    linked: true, humanWalletId: 'wallet_h', humanUserId: 'user_h', humanAddress: HUMAN_ADDR, agentShareBps,
  };
  return { kind: 'resolve', linkage: 'beneficiary_linked', beneficiary };
}

async function run(
  db: FakeFirestore,
  peId: string,
  snapshot: RecordEconomicSnapshot,
  verdict: RegistryHoldVerdict,
  hashOverride?: string | null,
): Promise<string> {
  return db.runTransaction(async (txn) =>
    applyRegistryHoldResolutionInTransaction(db as never, txn as never, {
      peId,
      economicActorId: snapshot.economicActorId,
      economicSnapshotHash: hashOverride === undefined ? hashRecordEconomicSnapshot(snapshot) : hashOverride,
      verdict,
      policy: makePolicy(),
      nowMs: NOW,
    })) as Promise<string>;
}

describe('applyRegistryHoldResolutionInTransaction — registry-hold resolution', () => {
  it('REACHABILITY: an unverifiable seal really is pending_review with a registry gate and nonzero points', () => {
    const s = makeSealed();
    expect(s.mintDisposition).toBe('pending_review');
    expect(s.recordTimeFactors.linkageState).toBe('unverifiable');
    expect(s.recordTimeFactors.unresolvedRecordGates).toContain('registry');
    expect(BigInt(s.recordPointsAtomic)).toBeGreaterThan(0n);
  });

  it('UNLINKED: resolves VERBATIM — eligible, record_points == sealed, no routing snapshot', async () => {
    const db = createFakeFirestore();
    const s = makeSealed();
    await seedRow(db, 'pe_1', s);
    const outcome = await run(db, 'pe_1', s, UNLINKED_VERDICT);
    expect(outcome).toBe('resolved');
    const row = await readRow(db, 'pe_1');
    expect(row.mint_status).toBe('eligible');
    expect(row.mint_disposition).toBe('eligible');
    expect(row.record_points_atomic).toBe(s.recordPointsAtomic);
    expect(row.estimated_pvt_atomic).toBe(s.recordPointsAtomic);
    expect(row.beneficiary_routing_snapshot).toBeUndefined();
    // sealed snapshot untouched
    expect(row.economic_snapshot_hash).toBe(hashRecordEconomicSnapshot(s));
  });

  it('BENEFICIARY_LINKED: re-prices to 2.0x and writes routing ATOMICALLY with the eligible flip', async () => {
    const db = createFakeFirestore();
    const s = makeSealed();
    await seedRow(db, 'pe_1', s);
    const outcome = await run(db, 'pe_1', s, linkedVerdict());
    expect(outcome).toBe('resolved');
    const row = await readRow(db, 'pe_1');
    expect(row.mint_status).toBe('eligible');
    // 2.0x re-price (beneficiary_linked 20000 vs unverifiable 10000)
    expect(BigInt(row.record_points_atomic as string)).toBe(2n * BigInt(s.recordPointsAtomic));
    // FENCE #2: routing snapshot present in the SAME resolved row (never eligible-without-routing)
    const routing = row.beneficiary_routing_snapshot as Record<string, unknown> | undefined;
    expect(routing).toBeDefined();
    expect(routing?.agent_share_bps).toBe(2_000);
    expect(routing?.human_address).toBe(HUMAN_ADDR);
    expect(routing?.pe_id).toBe('pe_1');
    expect(row.beneficiary_routing_snapshot_hash).toBe(
      hashBeneficiaryRoutingSnapshot(routing as never),
    );
    // sealed snapshot still untouched
    expect(row.economic_snapshot_hash).toBe(hashRecordEconomicSnapshot(s));
  });

  it('RED (fence #1 belt): a row that is NOT the device_occurrence owner is refused', async () => {
    const db = createFakeFirestore();
    const s = makeSealed();
    await seedRow(db, 'pe_1', s, { mint_once_claim_evidence: [
      { relation: 'duplicate', claim: { claim_kind: 'device_occurrence', owner_pe_id: 'pe_other' } },
    ] });
    const outcome = await run(db, 'pe_1', s, UNLINKED_VERDICT);
    expect(outcome).toBe('refused_not_mint_once_owner');
    expect((await readRow(db, 'pe_1')).mint_status).toBe('pending_review');
  });

  it('RED (CAS one-per-row): a row already flipped to eligible is refused_not_pending', async () => {
    const db = createFakeFirestore();
    const s = makeSealed();
    await seedRow(db, 'pe_1', s, { mint_status: 'eligible' });
    const outcome = await run(db, 'pe_1', s, UNLINKED_VERDICT);
    expect(outcome).toBe('refused_not_pending');
  });

  it('RED (TOCTOU): a mismatched economic_snapshot_hash is refused_snapshot_unbound', async () => {
    const db = createFakeFirestore();
    const s = makeSealed();
    await seedRow(db, 'pe_1', s);
    const outcome = await run(db, 'pe_1', s, UNLINKED_VERDICT, `sha256:${'f'.repeat(64)}`);
    expect(outcome).toBe('refused_snapshot_unbound');
    expect((await readRow(db, 'pe_1')).mint_status).toBe('pending_review');
  });

  it('RED (registry-only): a NON-unverifiable seal is refused_not_registry_hold', async () => {
    const db = createFakeFirestore();
    const s = makeSealed({ linkageState: 'unlinked' });
    await seedRow(db, 'pe_1', s);
    const outcome = await run(db, 'pe_1', s, UNLINKED_VERDICT);
    expect(outcome).toBe('refused_not_registry_hold');
  });

  it('RED (no verdict): a leave_pending verdict never writes', async () => {
    const db = createFakeFirestore();
    const s = makeSealed();
    await seedRow(db, 'pe_1', s);
    const outcome = await run(db, 'pe_1', s, { kind: 'leave_pending', reason: 'beneficiary_read_failed:x' });
    expect(outcome).toBe('refused_no_verdict');
    expect((await readRow(db, 'pe_1')).mint_status).toBe('pending_review');
  });
});

/**
 *. The belt released only `device_occurrence` owners, so every chain-witnessed act held at
 * the registry gate (the facilitator lane's x402 acts, the chain-record lane's financial
 * settlements, commit and occurrence owners) was refused forever as not-an-owner. A row that OWNS
 * the mint-once claim of its economic event, of any kind but `artifact`, is now releasable.
 * RED CONTROL RECORD (pre-fix source): the x402 / financial_settlement / commit / occurrence
 * GREEN cases were refused `refused_not_device_occurrence_owner`; the other-gate case RESOLVED (a row
 * also awaiting evidence was released on the registry verdict alone); and a device_occurrence owner
 * held by an operational override (same-owner / receive-authorship / mint-claim) RESOLVED.
 */
describe('the mint-once belt for any economic claim kind', () => {
  function evidence(kind: string, relation: 'owner' | 'duplicate', ownerPeId: string): Record<string, unknown> {
    return {
      schema_version: 'pvt-mint-once-evidence/v1',
      relation,
      claim: { claim_kind: kind, subject_id: ACTOR, owner_pe_id: ownerPeId, owner_user_id: ACTOR },
    };
  }

  it.each(['x402', 'financial_settlement', 'commit', 'occurrence', 'completion', 'device_occurrence'])(
    'GREEN: a row that OWNS its %s claim resolves (beneficiary_linked, re-priced)', async (kind) => {
      const db = createFakeFirestore();
      const s = makeSealed();
      await seedRow(db, 'pe_1', s, { mint_once_claim_evidence: [evidence(kind, 'owner', 'pe_1')] });
      expect(await run(db, 'pe_1', s, linkedVerdict())).toBe('resolved');
      const row = await readRow(db, 'pe_1');
      expect(row.mint_status).toBe('eligible');
      expect(BigInt(row.record_points_atomic as string)).toBeGreaterThan(BigInt(s.recordPointsAtomic));
    });

  it('GREEN: an artifact claim beside the owned economic claim does not matter either way', async () => {
    const db = createFakeFirestore();
    const s = makeSealed();
    await seedRow(db, 'pe_1', s, { mint_once_claim_evidence: [
      evidence('artifact', 'duplicate', 'pe_other'), evidence('x402', 'owner', 'pe_1'),
    ] });
    expect(await run(db, 'pe_1', s, UNLINKED_VERDICT)).toBe('resolved');
  });

  const refused: Array<[string, Record<string, unknown>[]]> = [
    ['a DUPLICATE of another row\'s x402 claim', [evidence('x402', 'duplicate', 'pe_other')]],
    ['an "owner" entry naming ANOTHER pe', [evidence('x402', 'owner', 'pe_other')]],
    ['owner of one kind but a duplicate of another', [evidence('commit', 'duplicate', 'pe_other'), evidence('x402', 'owner', 'pe_1')]],
    ['an artifact claim alone (novelty, not event identity)', [evidence('artifact', 'owner', 'pe_1')]],
    ['no claim evidence at all', []],
    ['malformed evidence', [{ relation: 'owner', claim: { owner_pe_id: 'pe_1' } }]],
  ];
  it.each(refused)('RED: %s is refused_not_mint_once_owner', async (_label, ev) => {
    const db = createFakeFirestore();
    const s = makeSealed();
    await seedRow(db, 'pe_1', s, { mint_once_claim_evidence: ev });
    expect(await run(db, 'pe_1', s, linkedVerdict())).toBe('refused_not_mint_once_owner');
    expect((await readRow(db, 'pe_1')).mint_status).toBe('pending_review');
  });

  it('RED: a sealed exact duplicate is refused even when its evidence says owner', async () => {
    const db = createFakeFirestore();
    const base = makeSealed();
    const s = { ...base, recordTimeFactors: { ...base.recordTimeFactors, exactDuplicate: true } } as RecordEconomicSnapshot;
    await seedRow(db, 'pe_1', s, { mint_once_claim_evidence: [evidence('x402', 'owner', 'pe_1')] });
    expect(await run(db, 'pe_1', s, linkedVerdict())).toBe('refused_not_mint_once_owner');
  });

  it.each(['same_owner_unresolvable', 'receive_authorship_unresolvable', 'mint_claim_unverifiable'] as const)(
    'RED: an operational %s hold (gates look like ["registry"]) is refused_operational_hold — its fence was never decided',
    async (reason) => {
      for (const kind of ['device_occurrence', 'financial_settlement', 'x402']) {
        const db = createFakeFirestore();
        const s = makeSealed({
          operationalDispositionOverride: { mintDisposition: 'pending_review', mintReasonCode: reason, suppressRecordPoints: false },
        });
        // Reachability: by gates alone this IS indistinguishable from a pure registry hold.
        expect(s.recordTimeFactors.unresolvedRecordGates).toEqual(['registry']);
        expect(s.mintReasonCode).toBe(reason);
        await seedRow(db, 'pe_1', s, { mint_once_claim_evidence: [evidence(kind, 'owner', 'pe_1')] });
        expect(await run(db, 'pe_1', s, linkedVerdict())).toBe('refused_operational_hold');
        expect((await readRow(db, 'pe_1')).mint_status).toBe('pending_review');
      }
    });

  it('RED: a LEGACY operational hold (era: override sealed with reason awaiting_review) is refused_operational_hold', async () => {
    // From until the granular codes the same-owner / mint-claim /
    // receive-authorship holds were sealed as override { pending_review, 'awaiting_review' }. Such a
    // row has reason awaiting_review AND gates ["registry"]: only the override itself refuses it.
    for (const kind of ['device_occurrence', 'financial_settlement']) {
      const db = createFakeFirestore();
      const s = makeSealed({
        operationalDispositionOverride: { mintDisposition: 'pending_review', mintReasonCode: 'awaiting_review', suppressRecordPoints: false },
      });
      expect(s.mintReasonCode).toBe('awaiting_review');
      expect(s.recordTimeFactors.unresolvedRecordGates).toEqual(['registry']);
      await seedRow(db, 'pe_1', s, { mint_once_claim_evidence: [evidence(kind, 'owner', 'pe_1')] });
      expect(await run(db, 'pe_1', s, linkedVerdict())).toBe('refused_operational_hold');
      expect((await readRow(db, 'pe_1')).mint_status).toBe('pending_review');
    }
  });

  it('RED: a row ALSO awaiting evidence is refused_other_record_gates (the registry verdict cannot release it)', async () => {
    const db = createFakeFirestore();
    const s = makeSealed({ evidenceState: 'pending' });
    expect(s.recordTimeFactors.unresolvedRecordGates).toEqual(expect.arrayContaining(['registry', 'evidence']));
    await seedRow(db, 'pe_1', s, { mint_once_claim_evidence: [evidence('device_occurrence', 'owner', 'pe_1')] });
    expect(await run(db, 'pe_1', s, linkedVerdict())).toBe('refused_other_record_gates');
    expect((await readRow(db, 'pe_1')).mint_status).toBe('pending_review');
  });
});

describe('ops follow-up 2026-10-07 — a witness-class act owns its own event (no claim document)', () => {
  const PE_HASH = 'a'.repeat(64);
  const SPEECH = 'commons_thread_message';
  const WITNESS_ACTION: ActionMonetaryPolicy = {
    ...DEFAULT_ACTION,
    evidenceRequirement: 'verified_witness_class',
    canonicalEventGroup: `witness_class:${SPEECH}`,
    sessionLineagePolicy: 'optional',
  };
  function witnessPolicy(): MonetaryPolicyVersion {
    const policy = makePolicy();
    return { ...policy, actions: { ...policy.actions, [SPEECH]: WITNESS_ACTION } };
  }
  function sealedSpeech(overrides: Partial<RecordCalculationInput> = {}): RecordEconomicSnapshot {
    return computeRecordSnapshot(witnessPolicy(), {
      peId: 'pe_s', economicActorId: ACTOR, actionType: SPEECH, recordedAtMs: 1_500,
      occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false,
      attestationTier: 'software', linkageState: 'unverifiable', evidenceState: 'verified',
      canonicalEventId: `${SPEECH}:${PE_HASH}`, selfReferencing: false, sharedBeneficialOwnership: false,
      pairChurnDetected: false, sessionLineageId: null, genesisReservation: null, ...overrides,
    });
  }
  async function seedSpeech(db: FakeFirestore, s: RecordEconomicSnapshot, extra: Record<string, unknown> = {}): Promise<void> {
    await seedRow(db, 'pe_s', s, { peHash: PE_HASH, mint_once_claim_evidence: [], mint_once_claim_evidence_hash: null, ...extra });
  }
  async function runSpeech(db: FakeFirestore, s: RecordEconomicSnapshot): Promise<string> {
    return db.runTransaction(async (txn) => applyRegistryHoldResolutionInTransaction(db as never, txn as never, {
      peId: 'pe_s', economicActorId: ACTOR, economicSnapshotHash: hashRecordEconomicSnapshot(s),
      verdict: UNLINKED_VERDICT, policy: witnessPolicy(), nowMs: NOW,
    })) as Promise<string>;
  }

  it('REACHABILITY: the seal is a pure registry hold on the witness-class group', () => {
    const s = sealedSpeech();
    expect(s.mintDisposition).toBe('pending_review');
    expect(s.recordTimeFactors.unresolvedRecordGates).toEqual(['registry']);
    expect(s.recordTimeFactors.canonicalEventGroup).toBe(`witness_class:${SPEECH}`);
  });

  it('GREEN: empty evidence + event id bound to its own hash resolves at the sealed points', async () => {
    const db = createFakeFirestore();
    const s = sealedSpeech();
    await seedSpeech(db, s);
    expect(await runSpeech(db, s)).toBe('resolved');
    const row = await readRow(db, 'pe_s');
    expect(row.mint_status).toBe('eligible');
    expect(row.record_points_atomic).toBe(s.recordPointsAtomic);
  });

  const refused: Array<[string, Partial<RecordCalculationInput>, Record<string, unknown>]> = [
    ['an event id naming ANOTHER pe hash', { canonicalEventId: `${SPEECH}:${'b'.repeat(64)}` }, {}],
    ['an emitter-passed event (a chain log) with no claim', { canonicalEventId: '8453:0xabc:1' }, {}],
    ['a row with no pe hash', {}, { peHash: undefined }],
    ['a row carrying an evidence commitment', {}, { mint_once_claim_evidence_hash: `sha256:${'c'.repeat(64)}` }],
  ];
  it.each(refused)('RED: %s stays refused_not_mint_once_owner', async (_label, sealOverrides, rowOverrides) => {
    const db = createFakeFirestore();
    const s = sealedSpeech(sealOverrides);
    await seedSpeech(db, s, rowOverrides);
    expect(await runSpeech(db, s)).toBe('refused_not_mint_once_owner');
    expect((await readRow(db, 'pe_s')).mint_status).toBe('pending_review');
  });

  /*
   * A beneficiary-linked claimless speech act releases at the points its speech-window budget
   * booked, with the linked split, and nothing re-books the budget.
   * RED CONTROL RECORD (recorded in the commit): against the prior source, which refused every
   * linked claimless act, the GREEN, second-pass and concurrent cases fail (outcome
   * `refused_not_mint_once_owner`, row still pending_review); with the booked branch removed (the
   * linked 2.0x re-price) the GREEN case fails on `record_points_atomic` (2× the booked points);
   * with the booking check made to accept anything, every "stays held" case below resolves.
   */
  const BURN_ID = 'burn_window_1';
  // A window wide enough that the booking is admitted (budget = burn at the 1.0x rate).
  const BURN_ATOMIC = (100n * PVT_ATOMIC_SCALE).toString();

  async function book(db: FakeFirestore, s: RecordEconomicSnapshot, pointsAtomic = s.recordPointsAtomic): Promise<void> {
    // The REAL booking writer, so the reservation has exactly the shape the seal writes.
    const decision = await reserveSpeechWindowBudget(db as never, {
      peId: 'pe_s', walletId: ACTOR, actionType: SPEECH, burnId: BURN_ID,
      burnAmountAtomic: BURN_ATOMIC, pointsAtomic, timestampMs: 1_500,
    });
    expect(decision.exhausted).toBe(false);
  }
  function linkedRun(db: FakeFirestore, s: RecordEconomicSnapshot, verdict: RegistryHoldVerdict = linkedVerdict()): Promise<string> {
    return db.runTransaction(async (txn) => applyRegistryHoldResolutionInTransaction(db as never, txn as never, {
      peId: 'pe_s', economicActorId: ACTOR, economicSnapshotHash: hashRecordEconomicSnapshot(s),
      verdict, policy: witnessPolicy(), nowMs: NOW,
    })) as Promise<string>;
  }
  function ledger(db: FakeFirestore): Record<string, unknown> | undefined {
    return db.store.get(`${SPEECH_WINDOW_BUDGETS_COLLECTION}/${BURN_ID}`);
  }
  function reservation(db: FakeFirestore): Record<string, unknown> | undefined {
    return db.store.get(`${SPEECH_WINDOW_RESERVATIONS_COLLECTION}/pe_s`);
  }

  it('GREEN: a linked claimless speech act releases at its BOOKED points with the linked split; the budget is not re-booked', async () => {
    const db = createFakeFirestore();
    const s = sealedSpeech();
    await seedSpeech(db, s);
    await book(db, s);
    const ledgerBefore = structuredClone(ledger(db));
    const reservationBefore = structuredClone(reservation(db));
    expect(reservationBefore?.points_atomic).toBe(s.recordPointsAtomic);

    expect(await linkedRun(db, s)).toBe('resolved');
    const row = await readRow(db, 'pe_s');
    expect(row.mint_status).toBe('eligible');
    expect(row.mint_disposition).toBe('eligible');
    // Exactly the booked points, never the linked 2.0x re-price.
    expect(row.record_points_atomic).toBe(reservationBefore?.points_atomic);
    expect(row.estimated_pvt_atomic).toBe(reservationBefore?.points_atomic);
    expect(BigInt(row.record_points_atomic as string)).not.toBe(2n * BigInt(s.recordPointsAtomic));
    expect(row.registry_hold_resolution_linkage).toBe('beneficiary_linked');
    // The linked split, from the same routing snapshot settlement reads for every linked act.
    const routing = row.beneficiary_routing_snapshot as Record<string, unknown> | undefined;
    expect(routing?.agent_share_bps).toBe(2_000);
    expect(routing?.human_address).toBe(HUMAN_ADDR);
    expect(routing?.pe_id).toBe('pe_s');
    expect(row.beneficiary_routing_snapshot_hash).toBe(hashBeneficiaryRoutingSnapshot(routing as never));
    const projection = row.economic_eligibility_projection as { resolutionEvidence: Array<{ source: string }> };
    expect(projection.resolutionEvidence[0].source).toBe('registry-hold-resolver:beneficiary_reverified_at_booked_points');
    // Nothing re-books: the window ledger and the booking are byte-for-byte unchanged.
    expect(ledger(db)).toEqual(ledgerBefore);
    expect(reservation(db)).toEqual(reservationBefore);
    // The seal is never touched.
    expect(row.economic_snapshot_hash).toBe(hashRecordEconomicSnapshot(s));
  });

  it('MINT-ONCE: a second pass releases nothing and changes nothing', async () => {
    const db = createFakeFirestore();
    const s = sealedSpeech();
    await seedSpeech(db, s);
    await book(db, s);
    expect(await linkedRun(db, s)).toBe('resolved');
    const afterFirst = structuredClone(await readRow(db, 'pe_s'));
    expect(await linkedRun(db, s)).toBe('refused_not_pending');
    expect(await readRow(db, 'pe_s')).toEqual(afterFirst);
  });

  it('MINT-ONCE: two concurrent passes release exactly once', async () => {
    const db = createFakeFirestore();
    const s = sealedSpeech();
    await seedSpeech(db, s);
    await book(db, s);
    const outcomes = await Promise.all([linkedRun(db, s), linkedRun(db, s)]);
    expect(outcomes.filter((o) => o === 'resolved')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'refused_not_pending')).toHaveLength(1);
  });

  it('MINT-ONCE: a pass that loses a commit race to another pass re-reads and releases nothing', async () => {
    const s = sealedSpeech();
    // The first attempt is discarded; the competing pass's release commits before the retry.
    const db = createFakeFirestore({ retryFirstTxn: { beforeRetry: (store) => {
      const key = 'pe_history/pe_s';
      store.set(key, { ...store.get(key), mint_status: 'eligible', mint_disposition: 'eligible' });
    } } });
    await seedSpeech(db, s);
    await book(db, s);
    expect(await linkedRun(db, s)).toBe('refused_not_pending');
  });

  it('RED (Unknown = Block): no booking on record stays held', async () => {
    const db = createFakeFirestore();
    const s = sealedSpeech();
    await seedSpeech(db, s);
    expect(await linkedRun(db, s)).toBe('refused_booking_unverified');
    const row = await readRow(db, 'pe_s');
    expect(row.mint_status).toBe('pending_review');
    expect(row.beneficiary_routing_snapshot).toBeUndefined();
  });

  it('RED (Unknown = Block): an unreadable booking stays held', async () => {
    const db = createFakeFirestore();
    const s = sealedSpeech();
    await seedSpeech(db, s);
    await book(db, s);
    // The booking exists, but reading it fails.
    const flaky = Object.create(db) as FakeFirestore;
    flaky.collection = ((name: string) => {
      const real = db.collection(name);
      if (name !== SPEECH_WINDOW_RESERVATIONS_COLLECTION) return real;
      return { ...real, doc: (id: string) => ({ ...real.doc(id), get: async () => { throw new Error('unavailable'); } }) };
    }) as FakeFirestore['collection'];
    const outcome = await db.runTransaction(async (txn) => applyRegistryHoldResolutionInTransaction(flaky as never, txn as never, {
      peId: 'pe_s', economicActorId: ACTOR, economicSnapshotHash: hashRecordEconomicSnapshot(s),
      verdict: linkedVerdict(), policy: witnessPolicy(), nowMs: NOW,
    }));
    expect(outcome).toBe('refused_booking_unverified');
    expect((await readRow(db, 'pe_s')).mint_status).toBe('pending_review');
  });

  it('RED (Unknown = Block): an unreadable link (leave_pending verdict) stays held', async () => {
    const db = createFakeFirestore();
    const s = sealedSpeech();
    await seedSpeech(db, s);
    await book(db, s);
    expect(await linkedRun(db, s, { kind: 'leave_pending', reason: 'beneficiary_read_failed:x' })).toBe('refused_no_verdict');
    expect((await readRow(db, 'pe_s')).mint_status).toBe('pending_review');
  });

  const badBookings: Array<[string, (s: RecordEconomicSnapshot) => Record<string, unknown>]> = [
    ['an exhausted booking', () => ({ exhausted: true })],
    ['a booking of a DIFFERENT amount (the linked 2.0x)', (s) => ({ points_atomic: (2n * BigInt(s.recordPointsAtomic)).toString() })],
    ['a booking naming another pe', () => ({ pe_id: 'pe_other' })],
    ['a booking of another action type', () => ({ action_type: 'commons_post_created' })],
    ['a booking of another wallet', () => ({ wallet_id: 'agent_other' })],
    ['a booking with no burn id', () => ({ burn_id: '' })],
    ['a booking with non-string points', (s) => ({ points_atomic: Number(s.recordPointsAtomic) })],
    ['a booking with no points field', () => ({ points_atomic: undefined })],
  ];
  it.each(badBookings)('RED (Unknown = Block): %s stays held', async (_label, mutate) => {
    const db = createFakeFirestore();
    const s = sealedSpeech();
    await seedSpeech(db, s);
    await book(db, s);
    const key = `${SPEECH_WINDOW_RESERVATIONS_COLLECTION}/pe_s`;
    const patched: Record<string, unknown> = { ...db.store.get(key), ...mutate(s) };
    for (const k of Object.keys(patched)) if (patched[k] === undefined) delete patched[k];
    db.store.set(key, patched);
    expect(await linkedRun(db, s)).toBe('refused_booking_unverified');
    const row = await readRow(db, 'pe_s');
    expect(row.mint_status).toBe('pending_review');
    expect(row.record_points_atomic).toBe(s.recordPointsAtomic);
  });

  it('RED: a linked claimless act that is NOT speech has no booking to release at and stays held', async () => {
    const NOT_SPEECH = 'human_approval';
    const policy = witnessPolicy();
    const notSpeechPolicy: MonetaryPolicyVersion = {
      ...policy,
      actions: { ...policy.actions, [NOT_SPEECH]: { ...WITNESS_ACTION, canonicalEventGroup: `witness_class:${NOT_SPEECH}` } },
    };
    const s = computeRecordSnapshot(notSpeechPolicy, {
      peId: 'pe_s', economicActorId: ACTOR, actionType: NOT_SPEECH, recordedAtMs: 1_500,
      occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false,
      attestationTier: 'software', linkageState: 'unverifiable', evidenceState: 'verified',
      canonicalEventId: `${NOT_SPEECH}:${PE_HASH}`, selfReferencing: false, sharedBeneficialOwnership: false,
      pairChurnDetected: false, sessionLineageId: null, genesisReservation: null,
    });
    const db = createFakeFirestore();
    await seedSpeech(db, s);
    expect(await linkedRun(db, s)).toBe('refused_not_mint_once_owner');
    expect((await readRow(db, 'pe_s')).mint_status).toBe('pending_review');
  });

  it('RED: a sealed exact duplicate with empty evidence stays refused', async () => {
    const db = createFakeFirestore();
    const base = sealedSpeech();
    const s = { ...base, recordTimeFactors: { ...base.recordTimeFactors, exactDuplicate: true } } as RecordEconomicSnapshot;
    await seedSpeech(db, s);
    expect(await runSpeech(db, s)).toBe('refused_not_mint_once_owner');
  });

  it('RED: a non-witness-class act with empty evidence stays refused (unchanged)', async () => {
    const db = createFakeFirestore();
    const s = makeSealed({ canonicalEventId: `agent_tool_orchestration:${PE_HASH}` });
    await seedRow(db, 'pe_1', s, { peHash: PE_HASH, mint_once_claim_evidence: [] });
    expect(await run(db, 'pe_1', s, UNLINKED_VERDICT)).toBe('refused_not_mint_once_owner');
  });
});

describe('no SECOND registry-hold promoter (source guard)', () => {
  // The sentinel field only the sanctioned promoter writes. If a second module ever
  // flips a registry-held pending_review row to eligible, it will carry this marker and
  // this guard fails — the static analogue of FC-014's "one promoter" for pending_review
  // (FC-013/FC-014 themselves key on the pending_evidence literal, not pending_review).
  const SENTINEL = 'registry_hold_resolution_linkage';

  function tsFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
      .map((p) => join(dir, p));
  }

  it('exactly one production module writes the registry-hold resolution marker', () => {
    const src = join(__dirname, '..', '..'); // provian-backend/src
    const writers = tsFiles(src).filter((f) => {
      try { return readFileSync(f, 'utf8').includes(SENTINEL); } catch { return false; }
    }).map((f) => f.replace(`${src}/`, ''));
    // Print the evaluated population so a pass over zero is not silent.
    // eslint-disable-next-line no-console
    console.log(`[registry-promoter-guard] files writing ${SENTINEL}:`, writers);
    expect(writers).toEqual(['core/pvt/registry-hold-promotion.ts']);
  });
});
