import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
} from './policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from './policy/runtime-monetary-policy';

let fake: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: make } = require('./__test-helpers__/fake-firestore');
  fake = make();
  return { __esModule: true, default: { firestore: () => fake } };
});

import { processDeferredReleaseBatch } from './deferred-release';

const TIMESTAMP = 1_000;

function exactSnapshot(peId: string) {
  return computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId,
    economicActorId: 'user-1',
    actionType: 'wallet_created',
    recordedAtMs: TIMESTAMP,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'not_required',
    canonicalEventId: null,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: null,
    genesisReservation: null,
  });
}

describe('deferred release exact economics', () => {
  beforeEach(() => {
    fake.store.clear();
    fake.ops.length = 0;
  });

  test('releases only the committed snapshot value and restores explicit disposition', async () => {
    const snapshot = exactSnapshot('pe_valid');
    fake.store.set('pe_history/pe_valid', {
      peId: 'pe_valid',
      userId: 'user-1',
      peHash: 'hash',
      actionType: 'wallet_created',
      timestamp: TIMESTAMP,
      jurisdiction_context: 'US',
      mint_status: 'deferred',
      mint_disposition: 'jurisdiction_deferred',
      economic_snapshot: snapshot,
      economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
      estimatedPVT: 0,
      estimated_pvt_atomic: '0',
    });

    await expect(processDeferredReleaseBatch({
      jurisdiction: 'US',
      daily_ceiling_percent: 100,
      re_attestation_required: true,
      activated_at: 1,
      active: true,
    }, 1)).resolves.toBe(1);

    expect(fake.store.get('pe_history/pe_valid')).toMatchObject({
      mint_status: 'eligible',
      mint_disposition: 'eligible',
      estimated_pvt_atomic: '10000000000000000000',
      deferred_release_outcome: 'eligible_exact_snapshot',
    });
  });

  test('turns a deferred legacy row without a snapshot into record-only zero', async () => {
    fake.store.set('pe_history/pe_legacy', {
      peId: 'pe_legacy',
      userId: 'user-1',
      peHash: 'hash',
      actionType: 'wallet_created',
      timestamp: TIMESTAMP,
      jurisdiction_context: 'US',
      mint_status: 'deferred',
    });

    await expect(processDeferredReleaseBatch({
      jurisdiction: 'US',
      daily_ceiling_percent: 100,
      re_attestation_required: false,
      activated_at: 1,
      active: true,
    }, 1)).resolves.toBe(0);

    expect(fake.store.get('pe_history/pe_legacy')).toMatchObject({
      mint_status: 'record_only',
      mint_disposition: 'record_only',
      estimated_pvt_atomic: '0',
      deferred_release_outcome: 'invalid_snapshot_record_only',
    });
  });
});
