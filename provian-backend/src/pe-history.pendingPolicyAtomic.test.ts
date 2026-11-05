import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';
import {
  PENDING_POLICY_COLLECTION,
  actionPolicyDocumentId,
} from './core/pvt/policy/pending-policy-queue';
import { writePEHistory, type WritePEHistoryParams } from './pe-history';

jest.mock('./core/jurisdiction/jurisdiction-policy', () => ({
  getJurisdictionPolicy: jest.fn().mockResolvedValue('immediate'),
}));

const baseParams: WritePEHistoryParams = {
  peId: 'pe_unknown_1',
  userId: 'user_1',
  timestamp: 2_000,
  actionType: 'thirdparty:new_atomic_action',
  category: 'agent',
  attestationDepth: 'software',
  estimatedPVT: 0,
  peHash: 'sha256:pe_unknown_1',
  jurisdiction_context: 'US',
  mint_disposition: 'record_only',
  disposition_reason_code: 'unknown_action_type',
  policy_review_state: 'pending_policy',
  policy_review_reason_code: 'unknown_action_type',
  economic_policy_version: 'pvt-action-policy/v1:unclassified',
  pending_policy_observation: {
    actionType: 'thirdparty:new_atomic_action',
    peId: 'pe_unknown_1',
    integrationSource: 'integration:test',
    policyVersion: 'pvt-action-policy/v1',
    now: 2_100,
  },
  pending_policy_alert_sender: async () => ({ delivered: true }),
};

describe('pe_history + unknown-type queue atomicity', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('commits the sealed record-only PE and its visible queue row together', async () => {
    const fake = createFakeFirestore();
    const didWrite = await writePEHistory(
      baseParams,
      fake as unknown as Firestore,
    );

    expect(didWrite).toBe(true);
    expect(fake.store.get('pe_history/pe_unknown_1')).toMatchObject({
      mint_status: 'record_only',
      mint_disposition: 'record_only',
      policy_review_state: 'pending_policy',
      estimatedPVT: 0,
    });
    expect(fake.store.get(
      `${PENDING_POLICY_COLLECTION}/${actionPolicyDocumentId('thirdparty:new_atomic_action')}`,
    )).toMatchObject({
      action_type: 'thirdparty:new_atomic_action',
      observation_count: 1,
      sample_pe_ids: ['pe_unknown_1'],
      alert_status: 'pending',
    });
  });

  test('a queue-write failure rolls back pe_history instead of creating an invisible unknown PE', async () => {
    const fake = createFakeFirestore({ failTxnWriteTo: PENDING_POLICY_COLLECTION });

    await expect(writePEHistory(
      baseParams,
      fake as unknown as Firestore,
    )).rejects.toThrow('Injected transaction write failure');

    expect(fake.store.has('pe_history/pe_unknown_1')).toBe(false);
    expect(fake.store.has(
      `${PENDING_POLICY_COLLECTION}/${actionPolicyDocumentId('thirdparty:new_atomic_action')}`,
    )).toBe(false);
  });

  test('a duplicate PE retry neither rewrites history nor increments the queue count', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    expect(await writePEHistory(baseParams, db)).toBe(true);
    expect(await writePEHistory(baseParams, db)).toBe(false);
    expect(fake.store.get(
      `${PENDING_POLICY_COLLECTION}/${actionPolicyDocumentId('thirdparty:new_atomic_action')}`,
    )).toMatchObject({ observation_count: 1 });
  });
});
