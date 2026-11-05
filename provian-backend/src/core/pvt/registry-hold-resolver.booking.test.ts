/**
 * registry-hold sweep: a beneficiary-linked claimless Commons speech act held at `pending_review`
 * is released at the points its speech-window budget booked, once, and one whose booking cannot
 * vouch for its points stays held and is reported as `refused_booking_unverified`.
 *
 * The verifier is replaced by a linked verdict (the beneficiary read itself is covered by
 * `registry-hold-resolver.test.ts`); the promoter, the booking and the sweep are real.
 *
 * RED CONTROL RECORD (in the commit): against the prior source the booked case was refused
 * `refused_not_mint_once_owner` and stayed pending; with the resolver's `refused_booking_unverified`
 * tally removed the unbooked case reports nothing for the held row.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  MONETARY_ACCOUNTING_SCHEMA_VERSION,
  PVT_ATOMIC_SCALE,
  atomicUnits,
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
  type ActionMonetaryPolicy,
  type MonetaryPolicyVersion,
  type RecordEconomicSnapshot,
} from './policy/monetary-accounting';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import type { RedisCache } from '../../cache';
import type { RegistryHoldVerdict } from './registry-hold-verifier';

const HUMAN_ADDR = `0x${'2'.repeat(40)}`;

jest.mock('./registry-hold-verifier', () => ({
  verifyRegistryHold: async (): Promise<RegistryHoldVerdict> => ({
    kind: 'resolve',
    linkage: 'beneficiary_linked',
    beneficiary: {
      linked: true, humanWalletId: 'wallet_h', humanUserId: 'user_h',
      humanAddress: `0x${'2'.repeat(40)}`, agentShareBps: 2_000,
    } as never,
  }),
}));

// eslint-disable-next-line import/first
import { REGISTRY_HOLD_RESOLVER_RUN_COLLECTION, sweepRegistryHolds } from './registry-hold-resolver';
// eslint-disable-next-line import/first
import { reserveSpeechWindowBudget } from './speech-window-budget';

const NOW = 7_000_000;
const ACTOR = 'agent_speaker';
const SPEECH = 'commons_thread_message';
const PE_HASH = 'a'.repeat(64);

const SPEECH_ACTION: ActionMonetaryPolicy = {
  category: 'compute', baseWeightBps: 10_000, policyOverrideBps: null,
  mintDisposition: 'eligible', mintReasonCode: 'policy_eligible',
  policyReviewState: 'not_required', policyReviewReasonCode: 'known_policy_entry',
  financialAttestationNeutral: false, allowVerifiedAttestationUpgrade: true,
  evidenceRequirement: 'verified_witness_class', canonicalEventRequired: true,
  canonicalEventGroup: `witness_class:${SPEECH}`,
  beneficialOwnershipPolicy: 'record_only_if_self_shared_or_churn',
  sessionLineagePolicy: 'optional', fixedGrantSource: 'none',
  evidenceResolutionMode: 'projection_with_verified_evidence',
};

function policy(): MonetaryPolicyVersion {
  return {
    schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION, policyVersion: 'pvt-policy-v1',
    effectiveAtMs: 1_000, effectiveUntilMs: null, basePointsAtomic: atomicUnits(PVT_ATOMIC_SCALE),
    attestationMultipliersBps: { software: 8_000, corroborated: 11_000, software_verified: 12_000, hardware_full: 25_000 },
    linkageMultipliersBps: { unlinked: 10_000, human_linked: 20_000, beneficiary_linked: 20_000, unverifiable: 10_000 },
    actions: { [SPEECH]: SPEECH_ACTION },
  };
}

function sealed(peId: string): RecordEconomicSnapshot {
  return computeRecordSnapshot(policy(), {
    peId, economicActorId: ACTOR, actionType: SPEECH, recordedAtMs: 1_500,
    occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false,
    attestationTier: 'software', linkageState: 'unverifiable', evidenceState: 'verified',
    canonicalEventId: `${SPEECH}:${PE_HASH}`, selfReferencing: false, sharedBeneficialOwnership: false,
    pairChurnDetected: false, sessionLineageId: null, genesisReservation: null,
  });
}

async function seedSpeech(db: FakeFirestore, peId: string, booked: boolean): Promise<RecordEconomicSnapshot> {
  const snap = sealed(peId);
  await db.collection('pe_history').doc(peId).set({
    peId, userId: ACTOR, economic_actor_id: ACTOR, actionType: SPEECH, timestamp: 1_500, peHash: PE_HASH,
    mint_status: 'pending_review', mint_disposition: 'pending_review', economic_snapshot: snap,
    economic_snapshot_hash: hashRecordEconomicSnapshot(snap), record_points_atomic: snap.recordPointsAtomic,
    estimated_pvt_atomic: '0', mint_once_claim_evidence: [], mint_once_claim_evidence_hash: null,
  });
  if (booked) {
    await reserveSpeechWindowBudget(db as never, {
      peId, walletId: ACTOR, actionType: SPEECH, burnId: 'burn_1',
      burnAmountAtomic: (100n * PVT_ATOMIC_SCALE).toString(), pointsAtomic: snap.recordPointsAtomic, timestampMs: 1_500,
    });
  }
  return snap;
}

const stubCache = { setBeneficiaryStatus: async () => {} } as unknown as RedisCache;
const deps = (db: FakeFirestore) => ({ db: db as never, cache: stubCache });

async function row(db: FakeFirestore, peId: string): Promise<Record<string, unknown>> {
  return ((await db.collection('pe_history').doc(peId).get()).data() ?? {}) as Record<string, unknown>;
}

describe('sweepRegistryHolds: linked claimless speech releases at its booked points', () => {
  it('releases once at the booked points with the linked split; the next pass releases nothing', async () => {
    const db = createFakeFirestore({ strictTransactionOrder: true });
    const snap = await seedSpeech(db, 'pe_sp', true);

    const first = await sweepRegistryHolds(deps(db), { nowMs: NOW });
    expect(first.resolved_linked).toBe(1);
    expect(first.refused_booking_unverified).toBe(0);
    const released = await row(db, 'pe_sp');
    expect(released.mint_status).toBe('eligible');
    expect(released.record_points_atomic).toBe(snap.recordPointsAtomic);
    expect((released.beneficiary_routing_snapshot as Record<string, unknown>).human_address).toBe(HUMAN_ADDR);

    const second = await sweepRegistryHolds(deps(db), { nowMs: NOW + 1 });
    expect(second.resolved_linked + second.resolved_unlinked).toBe(0);
    expect(await row(db, 'pe_sp')).toEqual(released);
  });

  it('RED (Unknown = Block): an unbooked act stays held, is listed, and the run summary counts it', async () => {
    const db = createFakeFirestore();
    await seedSpeech(db, 'pe_nb', false);

    const result = await sweepRegistryHolds(deps(db), { nowMs: NOW });
    expect(result.scanned).toBe(1);
    expect(result.resolved_linked).toBe(0);
    expect(result.refused_booking_unverified).toBe(1);
    expect(result.pending_rows).toEqual([{ pe_id: 'pe_nb', reason: 'refused_booking_unverified' }]);
    expect((await row(db, 'pe_nb')).mint_status).toBe('pending_review');
    const summary = await db.collection(REGISTRY_HOLD_RESOLVER_RUN_COLLECTION).doc(String(NOW)).get();
    expect((summary.data() as Record<string, unknown>).refused_booking_unverified).toBe(1);
  });
});
