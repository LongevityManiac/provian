import fs from 'fs';
import path from 'path';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  ACTION_POLICY_AUDIT_COLLECTION,
  ACTION_POLICY_COLLECTION,
  PENDING_POLICY_ALERT_RETRY_MS,
  PENDING_POLICY_ALERT_WORK_LIMIT,
  PENDING_POLICY_COLLECTION,
  PENDING_POLICY_OVERDUE_MS,
  PENDING_POLICY_OVERDUE_REPEAT_MS,
  actionPolicyDocumentId,
  classifyPendingPolicyAction,
  getPendingPolicyAction,
  listPendingPolicyActions,
  listPendingPolicyActionPage,
  observePendingPolicyAction,
  rejectPendingPolicyAction,
  type PendingPolicyAlertMessage,
  type ProspectiveClassificationInput,
} from './pending-policy-queue';

function makeDb(): { fake: ReturnType<typeof createFakeFirestore>; db: Firestore } {
  const fake = createFakeFirestore();
  return { fake, db: fake as unknown as Firestore };
}

function validClassificationInput(
  overrides: Partial<ProspectiveClassificationInput> = {},
): ProspectiveClassificationInput {
  return {
    actionType: 'timestamp_validation_type',
    effectivePolicyVersion: 'policy-v2',
    effectiveAt: 3_000,
    disposition: 'eligible',
    reasonCode: 'VERIFIED_SUBSTANTIVE_OUTCOME',
    category: 'compute',
    baseActionWeightBps: 10_000,
    policyOverrideBps: null,
    evidenceRequirement: 'verified_compute_or_work',
    financialAttestationNeutral: false,
    allowVerifiedAttestationUpgrade: true,
    fixedGrantSource: 'none',
    canonicalEventRequired: true,
    canonicalEventGroup: 'verified_work_artifact',
    beneficialOwnershipPolicy: 'record_only_if_self_shared_or_churn',
    sessionLineagePolicy: 'required',
    linkageTreatment: 'record_time_verified_policy_multiplier',
    evidenceResolutionMode: 'projection_with_verified_evidence',
    operatorId: 'operator:test',
    now: 2_000,
    ...overrides,
  };
}

function sender(
  calls: PendingPolicyAlertMessage[],
  delivered = true,
): (message: PendingPolicyAlertMessage) => Promise<{ delivered: boolean; error?: string }> {
  return async (message) => {
    calls.push(message);
    return delivered
      ? { delivered: true }
      : { delivered: false, error: 'test_delivery_failed' };
  };
}

describe('pending PVT action-policy queue', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('transactionally creates a first-sight item for private notification delivery', async () => {
    const { db } = makeDb();
    const calls: PendingPolicyAlertMessage[] = [];

    const result = await observePendingPolicyAction(db, {
      actionType: 'thirdparty:new_action',
      peId: 'pe_first',
      integrationSource: 'device_submit',
      policyVersion: 'policy-v1',
      now: 1_000,
    }, sender(calls));

    expect(result.firstSight).toBe(true);
    expect(result.alertKind).toBe('first_sight');
    expect(calls).toHaveLength(0);
    const stored = await getPendingPolicyAction(db, 'thirdparty:new_action');
    expect(stored).toMatchObject({
      action_type: 'thirdparty:new_action',
      observation_count: 1,
      sample_pe_ids: ['pe_first'],
      mint_disposition: 'record_only',
      disposition_reason_code: 'unknown_action_type',
      policy_review_state: 'pending_policy',
      alert_status: 'pending',
      alert_attempts: 0,
      next_alert_due_at: 1_000 + PENDING_POLICY_ALERT_RETRY_MS,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('pvt_pending_policy_first_sight'),
    );
  });

  it('deduplicates the queue item while retaining bounded samples and sources', async () => {
    const { db } = makeDb();
    const calls: PendingPolicyAlertMessage[] = [];
    await observePendingPolicyAction(db, {
      actionType: 'new_flat_type', peId: 'pe_1', integrationSource: 'mobile', now: 1_000,
    }, sender(calls));
    const second = await observePendingPolicyAction(db, {
      actionType: 'new_flat_type', peId: 'pe_2', integrationSource: 'sdk', now: 2_000,
    }, sender(calls));

    expect(second.firstSight).toBe(false);
    expect(second.alertKind).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await getPendingPolicyAction(db, 'new_flat_type')).toMatchObject({
      observation_count: 2,
      sample_pe_ids: ['pe_1', 'pe_2'],
      integration_sources: ['mobile', 'sdk'],
    });
    expect(await listPendingPolicyActions(db, { state: 'pending_policy' })).toHaveLength(1);
  });

  it('does not count the same PE observation twice', async () => {
    const { db } = makeDb();
    const observation = {
      actionType: 'idempotent_type',
      peId: 'pe_same',
      integrationSource: 'sdk',
      now: 1_000,
    };
    await observePendingPolicyAction(db, observation, sender([]));
    const repeated = await observePendingPolicyAction(
      db,
      { ...observation, now: 2_000 },
      sender([]),
    );
    expect(repeated).toMatchObject({ firstSight: false, alertKind: null });
    expect(await getPendingPolicyAction(db, 'idempotent_type')).toMatchObject({
      observation_count: 1,
      sample_pe_ids: ['pe_same'],
    });
  });

  it('paginates the complete operator-visible queue with a stable cursor', async () => {
    const { db } = makeDb();
    const actionTypes = ['page_a', 'page_b', 'page_c'];
    for (const [index, actionType] of actionTypes.entries()) {
      await observePendingPolicyAction(db, {
        actionType,
        peId: `pe_page_${index}`,
        integrationSource: 'sdk',
        now: 1_000,
      }, sender([]));
    }
    const expectedOrder = [...actionTypes].sort((left, right) => (
      actionPolicyDocumentId(left).localeCompare(actionPolicyDocumentId(right))
    ));
    const first = await listPendingPolicyActionPage(db, { limit: 2 });
    expect(first.items.map((item) => item.action_type)).toEqual(expectedOrder.slice(0, 2));
    expect(first.total).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await listPendingPolicyActionPage(db, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.action_type)).toEqual(expectedOrder.slice(2));
    expect(second.total).toBe(3);
    expect(second.nextCursor).toBeNull();
    await expect(listPendingPolicyActionPage(db, {
      state: 'pending_policy',
      cursor: first.nextCursor!,
    })).rejects.toThrow('pending_policy_cursor_invalid');
    await expect(listPendingPolicyActionPage(db, { cursor: 'not-a-cursor' }))
      .rejects.toThrow('pending_policy_cursor_invalid');
  });

  it('declares the composite indexes required by bounded operator and due-alert queries', () => {
    const config = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../firestore.indexes.json'),
      'utf8',
    )) as {
      indexes: Array<{
        collectionGroup: string;
        queryScope: string;
        fields: Array<{ fieldPath: string; order: string }>;
      }>;
    };
    const queueIndexes = config.indexes.filter((index) => (
      index.collectionGroup === PENDING_POLICY_COLLECTION
      && index.queryScope === 'COLLECTION'
    ));
    // Firestore appends document ID (__name__) as the final deterministic field
    // in each composite index, matching both explicit document-ID orderBy calls.
    expect(queueIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fields: [
          { fieldPath: 'policy_review_state', order: 'ASCENDING' },
          { fieldPath: 'first_seen_at', order: 'ASCENDING' },
        ],
      }),
      expect.objectContaining({
        fields: [
          { fieldPath: 'policy_review_state', order: 'ASCENDING' },
          { fieldPath: 'next_alert_due_at', order: 'ASCENDING' },
        ],
      }),
    ]));
  });

  // ── Slice 3: ruling suppression (a ruled type stops re-alerting daily) ────────
  const overdueNow = 1_000 + PENDING_POLICY_OVERDUE_MS + PENDING_POLICY_OVERDUE_REPEAT_MS;

  it('classifies only prospectively and never rewrites a sealed PE', async () => {
    const { fake, db } = makeDb();
    await observePendingPolicyAction(db, {
      actionType: 'classify_type', peId: 'pe_waiting', integrationSource: 'sdk', now: 1_000,
    }, sender([]));
    fake.store.set('pe_history/pe_waiting', {
      peId: 'pe_waiting', mint_disposition: 'record_only', policy_review_state: 'pending_policy',
    });

    const eligibleInput = validClassificationInput({ actionType: 'classify_type' });
    // / an unsigned classification can only decline. RED: a minting
    // disposition is refused before any write (no pointer, queue row still pending_policy).
    await expect(classifyPendingPolicyAction(db, eligibleInput))
      .rejects.toThrow('unsigned_classification_cannot_mint');
    expect([...fake.store.keys()].filter((key) => key.startsWith(`${ACTION_POLICY_COLLECTION}/`))).toHaveLength(0);

    const policy = await classifyPendingPolicyAction(db, {
      ...eligibleInput,
      disposition: 'record_only',
      reasonCode: 'INSUFFICIENT_LAUNCH_JUSTIFICATION_RECORD_ONLY',
      baseActionWeightBps: 0,
      evidenceRequirement: 'none',
      allowVerifiedAttestationUpgrade: false,
      canonicalEventRequired: false,
      canonicalEventGroup: 'none',
      beneficialOwnershipPolicy: 'not_applicable',
      sessionLineagePolicy: 'not_applicable',
      linkageTreatment: 'none_record_only',
      evidenceResolutionMode: 'not_applicable',
    });

    expect(policy).toMatchObject({
      prospective_only: true,
      effective_at: 3_000,
      mint_disposition: 'record_only',
      evidence_requirement: 'none',
      allow_verified_attestation_upgrade: false,
      amount_independent: true,
      fixed_grant_source: 'none',
    });
    expect(fake.store.get('pe_history/pe_waiting')).toMatchObject({
      mint_disposition: 'record_only',
      policy_review_state: 'pending_policy',
    });
    expect([...fake.store.keys()].filter((key) => key.startsWith(`${ACTION_POLICY_COLLECTION}/`))).toHaveLength(1);
    expect([...fake.store.keys()].filter((key) => key.startsWith(`${ACTION_POLICY_AUDIT_COLLECTION}/`))).toHaveLength(1);
    expect(await getPendingPolicyAction(db, 'classify_type')).toMatchObject({
      policy_review_state: 'classified_prospective',
      effective_policy_version: 'policy-v2',
    });
  });

  it('rejects non-finite, fractional, and unsafe classification or rejection timestamps', async () => {
    const { db } = makeDb();
    const invalidTimestamps = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      3_000.5,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    for (const effectiveAt of invalidTimestamps) {
      await expect(classifyPendingPolicyAction(
        db,
        validClassificationInput({ effectiveAt }),
      )).rejects.toThrow('effective_at_invalid');
      await expect(rejectPendingPolicyAction(db, {
        actionType: 'timestamp_validation_type',
        reasonCode: 'duplicate_of_existing_type',
        effectivePolicyVersion: 'policy-v2',
        effectiveAt,
        operatorId: 'operator:test',
        now: 2_000,
      })).rejects.toThrow('effective_at_invalid');
    }

    for (const now of invalidTimestamps) {
      await expect(classifyPendingPolicyAction(
        db,
        validClassificationInput({ now }),
      )).rejects.toThrow('now_invalid');
      await expect(rejectPendingPolicyAction(db, {
        actionType: 'timestamp_validation_type',
        reasonCode: 'duplicate_of_existing_type',
        effectivePolicyVersion: 'policy-v2',
        effectiveAt: 3_000,
        operatorId: 'operator:test',
        now,
      })).rejects.toThrow('now_invalid');
    }
  });

  it('requires an audited operator identity at the core classification boundary', async () => {
    const { db } = makeDb();
    await expect(classifyPendingPolicyAction(
      db,
      validClassificationInput({ operatorId: ' ' }),
    )).rejects.toThrow('operator_id_required');
    await expect(rejectPendingPolicyAction(db, {
      actionType: 'timestamp_validation_type',
      reasonCode: 'duplicate_of_existing_type',
      effectivePolicyVersion: 'policy-v2',
      effectiveAt: 3_000,
      operatorId: ' ',
      now: 2_000,
    })).rejects.toThrow('operator_id_required');
  });

  it('refuses an unsigned pending_review classification and rejects semantic mismatches', async () => {
    const { db } = makeDb();
    await observePendingPolicyAction(db, {
      actionType: 'registry_review_type', peId: 'pe_waiting', integrationSource: 'sdk', now: 1_000,
    }, sender([]));
    await expect(classifyPendingPolicyAction(db, {
      actionType: 'registry_review_type',
      effectivePolicyVersion: 'policy-v2',
      effectiveAt: 3_000,
      disposition: 'record_only',
      reasonCode: 'VERIFIED_SUBSTANTIVE_OUTCOME',
      category: 'institutional',
      baseActionWeightBps: 0,
      policyOverrideBps: null,
      evidenceRequirement: 'none',
      financialAttestationNeutral: false,
      allowVerifiedAttestationUpgrade: false,
      fixedGrantSource: 'none',
      canonicalEventRequired: false,
      canonicalEventGroup: 'record_only:registry_review_type',
      beneficialOwnershipPolicy: 'not_applicable',
      sessionLineagePolicy: 'not_applicable',
      linkageTreatment: 'none_record_only',
      evidenceResolutionMode: 'not_applicable',
      operatorId: 'operator:test',
      now: 2_000,
    })).rejects.toThrow('reason_disposition_mismatch');

    await expect(classifyPendingPolicyAction(db, {
      actionType: 'registry_review_type',
      effectivePolicyVersion: 'policy-v2',
      effectiveAt: 3_000,
      disposition: 'pending_review',
      reasonCode: 'NON_POLICY_REGISTRY_REVIEW_REQUIRED',
      category: 'institutional',
      baseActionWeightBps: 10_000,
      policyOverrideBps: null,
      evidenceRequirement: 'operator_policy_review',
      financialAttestationNeutral: false,
      allowVerifiedAttestationUpgrade: false,
      fixedGrantSource: 'none',
      canonicalEventRequired: true,
      canonicalEventGroup: 'verified_registry_resolution',
      beneficialOwnershipPolicy: 'record_only_if_self_shared_or_churn',
      sessionLineagePolicy: 'required',
      linkageTreatment: 'record_time_verified_policy_multiplier',
      evidenceResolutionMode: 'projection_with_verified_evidence',
      operatorId: 'operator:test',
      now: 2_000,
    })).rejects.toThrow('unsigned_classification_cannot_mint'); // post-only a signed row can open review-to-mint
  });

  it('generic unseen-type classification cannot arm a Genesis fixed grant', async () => {
    const { db } = makeDb();
    await observePendingPolicyAction(db, {
      actionType: 'thirdparty:genesis_attempt', peId: 'pe_1', integrationSource: 'sdk', now: 1_000,
    }, sender([]));
    await expect(classifyPendingPolicyAction(db, {
      actionType: 'thirdparty:genesis_attempt',
      effectivePolicyVersion: 'policy-v2',
      effectiveAt: 3_000,
      disposition: 'eligible',
      reasonCode: 'GENESIS_VALID_RESERVATION_FIXED_GRANT',
      category: 'infrastructure',
      baseActionWeightBps: 10_000,
      policyOverrideBps: null,
      evidenceRequirement: 'valid_genesis_reservation',
      financialAttestationNeutral: false,
      allowVerifiedAttestationUpgrade: false,
      fixedGrantSource: 'genesis_campaign_reservation',
      canonicalEventRequired: true,
      canonicalEventGroup: 'genesis_campaign_reservation',
      beneficialOwnershipPolicy: 'not_applicable',
      sessionLineagePolicy: 'not_applicable',
      linkageTreatment: 'genesis_contributor_only_no_linked_beneficiary_routing',
      evidenceResolutionMode: 'linked_evidence_pe_only',
      operatorId: 'operator:test',
      now: 2_000,
    })).rejects.toThrow('generic_classification_cannot_arm_genesis');
  });

  it('rejects retroactive classification and supports an audited rejection', async () => {
    const { fake, db } = makeDb();
    await observePendingPolicyAction(db, {
      actionType: 'reject_type', peId: 'pe_1', integrationSource: 'sdk', now: 1_000,
    }, sender([]));
    await expect(classifyPendingPolicyAction(db, {
      actionType: 'reject_type',
      effectivePolicyVersion: 'policy-v2',
      effectiveAt: 2_000,
      disposition: 'eligible',
      reasonCode: 'VERIFIED_SUBSTANTIVE_OUTCOME',
      category: 'compute',
      baseActionWeightBps: 10_000,
      policyOverrideBps: null,
      evidenceRequirement: 'verified_compute_or_work',
      financialAttestationNeutral: false,
      allowVerifiedAttestationUpgrade: true,
      fixedGrantSource: 'none',
      canonicalEventRequired: true,
      canonicalEventGroup: 'verified_work_artifact',
      beneficialOwnershipPolicy: 'record_only_if_self_shared_or_churn',
      sessionLineagePolicy: 'required',
      linkageTreatment: 'record_time_verified_policy_multiplier',
      evidenceResolutionMode: 'projection_with_verified_evidence',
      operatorId: 'operator:test',
      now: 2_000,
    })).rejects.toThrow('effective_at_must_be_future');

    await rejectPendingPolicyAction(db, {
      actionType: 'reject_type', reasonCode: 'duplicate_of_existing_type',
      effectivePolicyVersion: 'policy-v2', effectiveAt: 3_000,
      operatorId: 'operator:test', now: 2_000,
    });
    expect(await getPendingPolicyAction(db, 'reject_type')).toMatchObject({
      policy_review_state: 'rejected',
      mint_disposition: 'record_only',
      rejection_reason_code: 'duplicate_of_existing_type',
      effective_policy_version: 'policy-v2',
      effective_at: 3_000,
    });
    expect([...fake.store.keys()].filter((key) => key.startsWith(`${PENDING_POLICY_COLLECTION}/`))).toHaveLength(1);
  });
});
