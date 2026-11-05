/**
 * registry-hold sweep — orchestration + the "nothing stays unresolved silently" invariant.
 */

import { describe, it, expect } from '@jest/globals';
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
import {
  sweepRegistryHolds,
  REGISTRY_HOLD_RESOLUTION_COLLECTION,
} from './registry-hold-resolver';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import type { RedisCache } from '../../cache';

const NOW = 6_000_000;

const DEFAULT_ACTION: ActionMonetaryPolicy = {
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

function policy(): MonetaryPolicyVersion {
  return {
    schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION, policyVersion: 'pvt-policy-v1',
    effectiveAtMs: 1_000, effectiveUntilMs: null, basePointsAtomic: atomicUnits(PVT_ATOMIC_SCALE),
    attestationMultipliersBps: { software: 8_000, corroborated: 11_000, software_verified: 12_000, hardware_full: 25_000 },
    linkageMultipliersBps: { unlinked: 10_000, human_linked: 20_000, beneficiary_linked: 20_000, unverifiable: 10_000 },
    actions: { agent_tool_orchestration: DEFAULT_ACTION },
  };
}

function sealed(actorId: string, peId: string, overrides: Partial<RecordCalculationInput> = {}): RecordEconomicSnapshot {
  return computeRecordSnapshot(policy(), {
    peId, economicActorId: actorId, actionType: 'agent_tool_orchestration', recordedAtMs: 1_500,
    occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false,
    attestationTier: 'software', linkageState: 'unverifiable', evidenceState: 'verified',
    canonicalEventId: `agent_tool_orchestration:${peId}`, selfReferencing: false,
    sharedBeneficialOwnership: false, pairChurnDetected: false, sessionLineageId: 'session:root',
    genesisReservation: null, ...overrides,
  });
}

function ownerEvidence(actorId: string, peId: string): Record<string, unknown> {
  return { relation: 'owner', claim: { claim_kind: 'device_occurrence', owner_pe_id: peId, owner_user_id: actorId } };
}

async function seedHold(db: FakeFirestore, actorId: string, peId: string, snap: RecordEconomicSnapshot, ts: number): Promise<void> {
  await db.collection('pe_history').doc(peId).set({
    peId, userId: actorId, economic_actor_id: actorId, actionType: snap.actionType, timestamp: ts,
    mint_status: 'pending_review', mint_disposition: 'pending_review', economic_snapshot: snap,
    economic_snapshot_hash: hashRecordEconomicSnapshot(snap), record_points_atomic: snap.recordPointsAtomic,
    estimated_pvt_atomic: '0', mint_once_claim_evidence: [ownerEvidence(actorId, peId)],
  });
}

const stubCache = { setBeneficiaryStatus: async () => {} } as unknown as RedisCache;
const deps = (db: FakeFirestore) => ({ db: db as never, cache: stubCache });

async function status(db: FakeFirestore, peId: string): Promise<string | undefined> {
  return ((await db.collection('pe_history').doc(peId).get()).data() as { mint_status?: string } | undefined)?.mint_status;
}

describe('sweepRegistryHolds', () => {
  it('resolves an UNLINKED registry hold end to end and records it', async () => {
    const db = createFakeFirestore();
    // no agent_wallet for this actor → resolveBeneficiary returns unlinked (no throw)
    await seedHold(db, 'agent_standalone', 'pe_u1', sealed('agent_standalone', 'pe_u1'), 1_500);

    const result = await sweepRegistryHolds(deps(db), { nowMs: NOW });

    expect(result.resolved_unlinked).toBe(1);
    expect(result.left_pending).toBe(0);
    expect(await status(db, 'pe_u1')).toBe('eligible');
    const record = await db.collection(REGISTRY_HOLD_RESOLUTION_COLLECTION).doc('pe_u1').get();
    expect(record.exists).toBe(true);
    expect(result.cursor_advanced).toBe(true);
  });

  it('SKIPS a pending_review row that is NOT a registry hold (leaves it pending)', async () => {
    const db = createFakeFirestore();
    // A pending_review row whose snapshot is NOT unverifiable → not our population.
    const nonHold = sealed('agent_x', 'pe_skip', { linkageState: 'unlinked' });
    await db.collection('pe_history').doc('pe_skip').set({
      peId: 'pe_skip', userId: 'agent_x', economic_actor_id: 'agent_x', timestamp: 1_500,
      mint_status: 'pending_review', economic_snapshot: nonHold,
      economic_snapshot_hash: hashRecordEconomicSnapshot(nonHold), record_points_atomic: nonHold.recordPointsAtomic,
    });

    const result = await sweepRegistryHolds(deps(db), { nowMs: NOW });

    expect(result.skipped_not_registry_hold).toBe(1);
    expect(result.resolved_unlinked + result.resolved_linked).toBe(0);
    expect(await status(db, 'pe_skip')).toBe('pending_review');
  });

  it('LEAVES PENDING and REPORTS a hold whose beneficiary read throws (directive 3)', async () => {
    const db = createFakeFirestore();
    // Two agent_wallets with the same agent_id → resolveBeneficiary throws duplicate identity.
    await db.collection('agent_wallets').doc('w1').set({ id: 'w1', agent_id: 'agent_dup', address: `0x${'1'.repeat(40)}`, status: 'active' });
    await db.collection('agent_wallets').doc('w2').set({ id: 'w2', agent_id: 'agent_dup', address: `0x${'1'.repeat(40)}`, status: 'active' });
    await seedHold(db, 'agent_dup', 'pe_p1', sealed('agent_dup', 'pe_p1'), 1_500);

    const result = await sweepRegistryHolds(deps(db), { nowMs: NOW });

    expect(result.left_pending).toBe(1);
    expect(result.resolved_unlinked + result.resolved_linked).toBe(0);
    expect(result.pending_rows).toHaveLength(1);
    expect(result.pending_rows[0].pe_id).toBe('pe_p1');
    expect(result.pending_rows[0].reason).toContain('beneficiary_read_failed');
    expect(await status(db, 'pe_p1')).toBe('pending_review');
  });

  it('skips a zero-record-points row (no work to mint)', async () => {
    const db = createFakeFirestore();
    const s = sealed('agent_z', 'pe_zero');
    await seedHold(db, 'agent_z', 'pe_zero', { ...s, recordPointsAtomic: atomicUnits(0n) } as RecordEconomicSnapshot, 1_500);
    const result = await sweepRegistryHolds(deps(db), { nowMs: NOW });
    expect(result.skipped_zero_points).toBe(1);
    expect(result.resolved_unlinked).toBe(0);
  });

  it('resolves under STRICT transaction ordering — reads precede writes (regression)', async () => {
    // Production-only defect the LAX fake hid: the resolver read its audit marker
    // AFTER the promotion had written, which real Firestore rejects ("all reads
    // before all writes"). The strict-order fake reproduces that rule, so this
    // test would THROW (reject) on the pre-fix ordering and passes only when the
    // marker is read before the promoter runs.
    const db = createFakeFirestore({ strictTransactionOrder: true });
    await seedHold(db, 'agent_strict', 'pe_strict1', sealed('agent_strict', 'pe_strict1'), 1_500);
    const result = await sweepRegistryHolds(deps(db), { nowMs: NOW });
    expect(result.resolved_unlinked).toBe(1);
    expect(await status(db, 'pe_strict1')).toBe('eligible');
    // The audit resolution record was still written (after all reads).
    const record = await db.collection(REGISTRY_HOLD_RESOLUTION_COLLECTION).doc('pe_strict1').get();
    expect(record.exists).toBe(true);
  });
});
