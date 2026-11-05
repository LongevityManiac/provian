import fs from 'fs';
import path from 'path';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  PROPOSED_ACTION_POLICY_ENTRIES,
  VALIDATED_LAUNCH_EMITTER_ADDITIONS,
} from './proposed-action-policy';
import {
  ACTION_POLICY_COLLECTION,
  PENDING_POLICY_COLLECTION,
  actionPolicyDocumentId,
  getPendingPolicyAction,
  observePendingPolicyAction,
  rejectPendingPolicyAction,
  type PendingPolicyAlertMessage,
  type ProspectiveActionPolicyDocument,
} from './pending-policy-queue';
import {
  KNOWN_LAUNCH_IDENTIFIER_REASON_CODE,
  KNOWN_LAUNCH_EMITTER_IDENTIFIERS,
  PROPOSED_LAUNCH_ACTION_IDENTIFIERS,
  REJECTED_ACTION_POLICY_REASON_CODE,
  UNKNOWN_ACTION_POLICY_REASON_CODE,
  isProposedLaunchActionIdentifier,
  isKnownLaunchEmitterIdentifier,
  resolveActionPolicyAtRecordTime,
  resolveAndObserveActionPolicy,
} from './action-policy-gate';

function makeDb(options?: Parameters<typeof createFakeFirestore>[0]): {
  fake: ReturnType<typeof createFakeFirestore>;
  db: Firestore;
} {
  const fake = createFakeFirestore(options);
  return { fake, db: fake as unknown as Firestore };
}

function prospectivePolicy(
  actionType: string,
  overrides: Partial<ProspectiveActionPolicyDocument> = {},
): ProspectiveActionPolicyDocument {
  return {
    action_type: actionType,
    policy_review_state: 'classified_prospective',
    effective_policy_version: 'pvt-policy-v2',
    effective_at: 2_000,
    mint_disposition: 'eligible',
    disposition_reason_code: 'VERIFIED_SUBSTANTIVE_OUTCOME',
    category: 'compute',
    base_action_weight_bps: 12_000,
    policy_override_bps: null,
    evidence_requirement: 'verified_compute_or_work',
    financial_attestation_neutral: false,
    allow_verified_attestation_upgrade: true,
    amount_independent: true,
    fixed_grant_source: 'none',
    canonical_event_required: true,
    canonical_event_group: 'verified_work_artifact',
    beneficial_ownership_policy: 'record_only_if_self_shared_or_churn',
    session_lineage_policy: 'required',
    linkage_treatment: 'record_time_verified_policy_multiplier',
    evidence_resolution_mode: 'projection_with_verified_evidence',
    created_at: 1_500,
    created_by: 'operator:test',
    prospective_only: true,
    ...overrides,
  };
}

/** The only pointer an unsigned classification may write (): a decline. */
const RECORD_ONLY_POINTER: Partial<ProspectiveActionPolicyDocument> = {
  mint_disposition: 'record_only',
  disposition_reason_code: 'INSUFFICIENT_LAUNCH_JUSTIFICATION_RECORD_ONLY',
  base_action_weight_bps: 0,
  evidence_requirement: 'none',
  allow_verified_attestation_upgrade: false,
  canonical_event_required: false,
  canonical_event_group: 'none',
  beneficial_ownership_policy: 'not_applicable',
  session_lineage_policy: 'not_applicable',
  linkage_treatment: 'none_record_only',
  evidence_resolution_mode: 'not_applicable',
};

function installPointer(
  fake: ReturnType<typeof createFakeFirestore>,
  document: ProspectiveActionPolicyDocument,
): void {
  fake.store.set(
    `${ACTION_POLICY_COLLECTION}/${actionPolicyDocumentId(document.action_type)}`,
    { ...document },
  );
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('proposed launch identifier recognition', () => {
  test('uses every proposed manifest identifier exactly once', () => {
    const proposedIdentifiers = PROPOSED_ACTION_POLICY_ENTRIES.map((entry) => entry.action_type);
    expect(PROPOSED_LAUNCH_ACTION_IDENTIFIERS).toHaveLength(proposedIdentifiers.length);
    expect(new Set(PROPOSED_LAUNCH_ACTION_IDENTIFIERS).size).toBe(proposedIdentifiers.length);
    for (const actionType of proposedIdentifiers) {
      expect(isProposedLaunchActionIdentifier(actionType)).toBe(true);
    }
    expect(isProposedLaunchActionIdentifier('thirdparty:new_action')).toBe(false);
  });

  test('runtime known-set is limited to the live cut line plus verified emitters', () => {
    expect(KNOWN_LAUNCH_EMITTER_IDENTIFIERS).toHaveLength(241); // +5 Commons communication emitters
    expect(new Set(KNOWN_LAUNCH_EMITTER_IDENTIFIERS).size).toBe(241); // +link_spend; +5
    const proposalOnly = PROPOSED_LAUNCH_ACTION_IDENTIFIERS.find(
      (actionType) => !KNOWN_LAUNCH_EMITTER_IDENTIFIERS.includes(actionType),
    );
    expect(proposalOnly).toBeDefined();
    expect(isProposedLaunchActionIdentifier(proposalOnly!)).toBe(true);
    expect(isKnownLaunchEmitterIdentifier(proposalOnly!)).toBe(false);
    expect(isKnownLaunchEmitterIdentifier('thirdparty:new_action')).toBe(false);
  });

  test('every source-verified addition is present in both proposal and inert runtime recognition', () => {
    expect(VALIDATED_LAUNCH_EMITTER_ADDITIONS).toHaveLength(79); // +5 Commons communication emitters
    for (const actionType of VALIDATED_LAUNCH_EMITTER_ADDITIONS) {
      expect(isProposedLaunchActionIdentifier(actionType)).toBe(true);
      expect(isKnownLaunchEmitterIdentifier(actionType)).toBe(true);
    }
  });

  test('`agent_linked` is an INERT catalog row — no emitter on the relay or in the CLI', () => {
    // moved the emitter from `provian init` into the relay's connect
    // handler; removed the relay agent-session channel (connect, sessions,
    // the challenge PoP), so the row now has NO emitter anywhere — the same
    // treatment as the governance rows (`goal_envelope_*` etc.): the catalog
    // entry stays, pinned by the matrix, and nothing writes it. The human↔agent
    // link's record is `agent_linked_to_human` (core/agent-wallet/link-human-binding.ts).
    const server = fs.readFileSync(
      path.resolve(__dirname, '../../../server.ts'),
      'utf8',
    );
    expect(server).not.toContain("actionType: 'agent_linked'");
    expect(server).not.toContain("integrationSource: 'relay_agent_connect'");
    expect(server).not.toContain("'/v1/relay/agent/connect'");

    const cliDir = path.resolve(__dirname, '../../../../../provian-cli/src/cli');
    for (const f of fs.readdirSync(cliDir)) {
      if (!f.endsWith('.ts')) continue;
      expect(fs.readFileSync(path.join(cliDir, f), 'utf8')).not.toContain("actionType: 'agent_linked'");
    }

    expect(isProposedLaunchActionIdentifier('agent_linked')).toBe(true);
    expect(isKnownLaunchEmitterIdentifier('agent_linked')).toBe(true);
    // The retained link record keeps its emitter.
    const binding = fs.readFileSync(
      path.resolve(__dirname, '../../../core/agent-wallet/link-human-binding.ts'),
      'utf8',
    );
    expect(binding).toContain('agent_linked_to_human');
  });

  test('the cross-repository launch-emitter additions are source-backed', () => {
    const readSource = (relativePath: string): string => fs.readFileSync(
      path.resolve(__dirname, '../../../../../', relativePath),
      'utf8',
    );
    const exactEmitters = [
      ['ai_conversation', 'src/core/capture/ChatPEEmitter.ts'],
      ['promise_deleted', 'src/core/promises/PromiseService.ts'],
      ['commons_post_created', 'provian-backend/src/core/commons/forum.ts'],
      ['agent_tool_orchestration', 'provian-agent-sdk/src/observer/plugins/OTelPlugin.ts'],
      ['inference_session', 'provian-agent-sdk/src/observer/ProvianObserver.ts'],
      ['compute_session', 'provian-agent-sdk/src/observer/ProvianObserver.ts'],
    ] as const;

    for (const [actionType, relativePath] of exactEmitters) {
      expect(readSource(relativePath)).toContain(`'${actionType}'`);
      expect(isKnownLaunchEmitterIdentifier(actionType)).toBe(true);
    }

    // the SDK governance interceptor (the live emitter that mapped these
    // categories onto reported actions) was removed with the wallet's agent
    // governance. The categories remain the SDK's `ActionReport.actionType`
    // vocabulary and inert catalog rows (seam 6a: no matrix regeneration), so
    // the source-backing pin now reads the type block alone.
    const categorySource = readSource('provian-agent-sdk/src/types.ts');
    const dynamicCategories = [
      'spending',
      'communicate',
      'commit',
      'share_data',
      'public_post',
      'system_access',
      'uncategorized',
      'egress_data',
    ] as const;
    const categoryBlock = categorySource.match(
      /export type ActionCategory\s*=([\s\S]*?);/,
    )?.[1];
    expect(categoryBlock).toBeDefined();
    const categoriesFromSource = [...categoryBlock!.matchAll(/'([^']+)'/g)]
      .map((match) => match[1])
      .sort((left, right) => left.localeCompare(right));
    expect(categoriesFromSource).toEqual([...dynamicCategories].sort());
    for (const actionType of dynamicCategories) {
      expect(isKnownLaunchEmitterIdentifier(actionType)).toBe(true);
    }

    // PE meter (2026-10-03): the relay work-product recorder that composed
    // `agent_work_product_${product_type}` (`POST /v1/relay/work-product` in
    // server.ts) is retired and its handler deleted. The seven identifiers stay
    // recognized launch identifiers and inert catalog rows (no matrix
    // regeneration), so the pin now names them directly and asserts the deleted
    // composer is gone rather than reading a product-type list from server.ts.
    const backendSource = readSource('provian-backend/src/server.ts');
    expect(backendSource.length).toBeGreaterThan(1000);
    expect(backendSource).not.toContain(
      'const compositeActionType = `agent_work_product_${product_type}`',
    );
    const productTypes = ['analysis', 'code', 'data', 'design', 'document', 'other', 'research'];
    for (const productType of productTypes) {
      expect(isKnownLaunchEmitterIdentifier(`agent_work_product_${productType}`)).toBe(true);
    }
    // RED control: an identifier outside the set is not recognized.
    expect(isKnownLaunchEmitterIdentifier('agent_work_product_not_a_product_type')).toBe(false);
  });

  test('recognizes a known identifier without reading policy storage or activating proposal economics', async () => {
    const noReadDb = {
      collection: (): never => {
        throw new Error('policy storage must not be read for a launch identifier');
      },
    } as unknown as Firestore;

    const result = await resolveActionPolicyAtRecordTime(noReadDb, {
      actionType: 'pvt_batch_minted',
      recordedAtMs: 2_000,
    });

    expect(result).toEqual({
      status: 'known_launch_identifier',
      actionType: 'pvt_batch_minted',
      recordedAtMs: 2_000,
      knownLaunchIdentifier: true,
      policyActivated: false,
      pointerState: 'not_read_for_known_identifier',
      mintDisposition: null,
      policyReviewState: 'not_required',
      reasonCode: KNOWN_LAUNCH_IDENTIFIER_REASON_CODE,
      effectivePolicyVersion: null,
      effectiveAt: null,
      category: null,
      baseActionWeightBps: null,
      policyOverrideBps: null,
      actionWeightBps: null,
      evidenceRequirement: null,
      financialAttestationNeutral: null,
      allowVerifiedAttestationUpgrade: null,
      amountIndependent: null,
      fixedGrantSource: null,
      canonicalEventRequired: null,
      canonicalEventGroup: null,
      beneficialOwnershipPolicy: null,
      sessionLineagePolicy: null,
      linkageTreatment: null,
      evidenceResolutionMode: null,
    });
  });
});

describe('prospective action-policy pointer resolution', () => {
  test('uses the same deterministic pointer ID as the queue classifier', () => {
    expect(actionPolicyDocumentId('thirdparty:new_action')).toMatch(/^[a-f0-9]{64}$/);
    expect(actionPolicyDocumentId('thirdparty:new_action')).toBe(
      actionPolicyDocumentId('thirdparty:new_action'),
    );
    expect(actionPolicyDocumentId('thirdparty:new_action')).not.toBe(
      actionPolicyDocumentId('thirdparty:other_action'),
    );
  });

  test('classifies only when effective_at is at or before the PE record time', async () => {
    const { fake, db } = makeDb();
    installPointer(fake, prospectivePolicy('thirdparty:new_action', RECORD_ONLY_POINTER));

    const before = await resolveActionPolicyAtRecordTime(db, {
      actionType: 'thirdparty:new_action',
      recordedAtMs: 1_999,
    });
    const atBoundary = await resolveActionPolicyAtRecordTime(db, {
      actionType: 'thirdparty:new_action',
      recordedAtMs: 2_000,
    });
    const after = await resolveActionPolicyAtRecordTime(db, {
      actionType: 'thirdparty:new_action',
      recordedAtMs: 2_001,
    });

    expect(before).toMatchObject({
      status: 'pending_policy',
      pointerState: 'not_yet_effective',
      mintDisposition: 'record_only',
      policyReviewState: 'pending_policy',
      reasonCode: UNKNOWN_ACTION_POLICY_REASON_CODE,
    });
    expect(atBoundary).toEqual({
      status: 'classified_prospective',
      actionType: 'thirdparty:new_action',
      recordedAtMs: 2_000,
      knownLaunchIdentifier: false,
      policyActivated: true,
      pointerState: 'effective',
      mintDisposition: 'record_only',
      policyReviewState: 'classified_prospective',
      reasonCode: 'INSUFFICIENT_LAUNCH_JUSTIFICATION_RECORD_ONLY',
      effectivePolicyVersion: 'pvt-policy-v2',
      effectiveAt: 2_000,
      category: 'compute',
      baseActionWeightBps: 0,
      policyOverrideBps: null,
      actionWeightBps: 0,
      evidenceRequirement: 'none',
      financialAttestationNeutral: false,
      allowVerifiedAttestationUpgrade: false,
      amountIndependent: true,
      fixedGrantSource: 'none',
      canonicalEventRequired: false,
      canonicalEventGroup: 'none',
      beneficialOwnershipPolicy: 'not_applicable',
      sessionLineagePolicy: 'not_applicable',
      linkageTreatment: 'none_record_only',
      evidenceResolutionMode: 'not_applicable',
    });
    expect(after).toMatchObject({
      status: 'classified_prospective',
      policyActivated: true,
      effectiveAt: 2_000,
    });
  });

  test('post-an unsigned MINTING pointer is invalid at every record time (signature gates earning)', async () => {
    const { fake, db } = makeDb();
    for (const mint_disposition of ['eligible', 'pending_evidence', 'pending_review'] as const) {
      installPointer(fake, prospectivePolicy('thirdparty:unsigned_mint', { mint_disposition }));
      for (const recordedAtMs of [1_999, 2_000, 2_001]) {
        const resolved = await resolveActionPolicyAtRecordTime(db, {
          actionType: 'thirdparty:unsigned_mint',
          recordedAtMs,
        });
        expect(resolved).toMatchObject({
          status: 'pending_policy',
          pointerState: 'invalid',
          mintDisposition: 'record_only',
          reasonCode: UNKNOWN_ACTION_POLICY_REASON_CODE,
        });
      }
    }
    // Control: the same pointer as a decline resolves classified at its effective time.
    installPointer(fake, prospectivePolicy('thirdparty:unsigned_mint', RECORD_ONLY_POINTER));
    expect(await resolveActionPolicyAtRecordTime(db, {
      actionType: 'thirdparty:unsigned_mint',
      recordedAtMs: 2_000,
    })).toMatchObject({ status: 'classified_prospective', mintDisposition: 'record_only' });
  });

  test('uses one stable fail-closed result for missing, invalid, and unreadable pointers', async () => {
    const { fake, db } = makeDb();
    const missing = await resolveActionPolicyAtRecordTime(db, {
      actionType: 'thirdparty:missing',
      recordedAtMs: 2_000,
    });

    fake.store.set(
      `${ACTION_POLICY_COLLECTION}/${actionPolicyDocumentId('thirdparty:invalid')}`,
      {
        ...prospectivePolicy('thirdparty:invalid'),
        prospective_only: false,
      },
    );
    const invalid = await resolveActionPolicyAtRecordTime(db, {
      actionType: 'thirdparty:invalid',
      recordedAtMs: 2_000,
    });

    const readFailureDb = {
      collection: (): never => {
        throw new Error('Firestore unavailable');
      },
    } as unknown as Firestore;
    const unreadable = await resolveActionPolicyAtRecordTime(readFailureDb, {
      actionType: 'thirdparty:unreadable',
      recordedAtMs: 2_000,
    });

    for (const result of [missing, invalid, unreadable]) {
      expect(result).toMatchObject({
        status: 'pending_policy',
        policyActivated: false,
        mintDisposition: 'record_only',
        policyReviewState: 'pending_policy',
        reasonCode: UNKNOWN_ACTION_POLICY_REASON_CODE,
        actionWeightBps: null,
      });
    }
    expect(missing.pointerState).toBe('missing');
    expect(invalid.pointerState).toBe('invalid');
    expect(unreadable.pointerState).toBe('read_failed');
  });

  test('treats an out-of-enum policy category as a corrupt fail-closed pointer', async () => {
    const { fake, db } = makeDb();
    fake.store.set(
      `${ACTION_POLICY_COLLECTION}/${actionPolicyDocumentId('thirdparty:bad_category')}`,
      {
        ...prospectivePolicy('thirdparty:bad_category'),
        category: 'evil',
      },
    );

    await expect(resolveActionPolicyAtRecordTime(db, {
      actionType: 'thirdparty:bad_category',
      recordedAtMs: 2_000,
    })).resolves.toMatchObject({
      status: 'pending_policy',
      pointerState: 'invalid',
      mintDisposition: 'record_only',
      policyActivated: false,
    });
  });

  test('rejects a stored policy whose effective boundary is not prospective to creation', async () => {
    const { fake, db } = makeDb();
    fake.store.set(
      `${ACTION_POLICY_COLLECTION}/${actionPolicyDocumentId('thirdparty:retroactive_pointer')}`,
      {
        ...prospectivePolicy('thirdparty:retroactive_pointer'),
        created_at: 2_000,
        effective_at: 2_000,
      },
    );

    await expect(resolveActionPolicyAtRecordTime(db, {
      actionType: 'thirdparty:retroactive_pointer',
      recordedAtMs: 3_000,
    })).resolves.toMatchObject({
      status: 'pending_policy',
      pointerState: 'invalid',
      mintDisposition: 'record_only',
      policyActivated: false,
    });
  });

  test('applies an audited rejection only prospectively and does not requeue it', async () => {
    const { db } = makeDb();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await observePendingPolicyAction(db, {
      actionType: 'thirdparty:rejected_action',
      peId: 'pe-before-rejection',
      integrationSource: 'sdk:test',
      now: 1_000,
    }, async () => ({ delivered: true }));
    await rejectPendingPolicyAction(db, {
      actionType: 'thirdparty:rejected_action',
      reasonCode: 'duplicate_of_existing_type',
      effectivePolicyVersion: 'pvt-policy-v2',
      effectiveAt: 2_000,
      operatorId: 'operator:test',
      now: 1_500,
    });

    expect(await resolveActionPolicyAtRecordTime(db, {
      actionType: 'thirdparty:rejected_action',
      recordedAtMs: 1_999,
    })).toMatchObject({ status: 'pending_policy', pointerState: 'not_yet_effective' });

    const rejected = await resolveAndObserveActionPolicy(db, {
      actionType: 'thirdparty:rejected_action',
      recordedAtMs: 2_000,
      peId: 'pe-after-rejection',
      integrationSource: 'sdk:test',
      now: 2_000,
    });
    expect(rejected.queueAttempted).toBe(false);
    expect(rejected.resolution).toEqual({
      status: 'rejected',
      actionType: 'thirdparty:rejected_action',
      recordedAtMs: 2_000,
      knownLaunchIdentifier: false,
      policyActivated: true,
      pointerState: 'effective',
      mintDisposition: 'record_only',
      policyReviewState: 'rejected',
      reasonCode: REJECTED_ACTION_POLICY_REASON_CODE,
      rejectionReasonCode: 'duplicate_of_existing_type',
      effectivePolicyVersion: 'pvt-policy-v2',
      effectiveAt: 2_000,
      category: null,
      baseActionWeightBps: null,
      policyOverrideBps: null,
      actionWeightBps: null,
      evidenceRequirement: null,
      financialAttestationNeutral: null,
      allowVerifiedAttestationUpgrade: null,
      amountIndependent: true,
      fixedGrantSource: null,
      canonicalEventRequired: null,
      canonicalEventGroup: null,
      beneficialOwnershipPolicy: null,
      sessionLineagePolicy: null,
      linkageTreatment: null,
      evidenceResolutionMode: null,
    });
  });

  test('treats a corrupt rejection reason as pending instead of closing the type', async () => {
    const { fake, db } = makeDb();
    fake.store.set(
      `${PENDING_POLICY_COLLECTION}/${actionPolicyDocumentId('thirdparty:bad_rejection')}`,
      {
        action_type: 'thirdparty:bad_rejection',
        policy_review_state: 'rejected',
        mint_disposition: 'record_only',
        effective_at: 3_000,
        effective_policy_version: 'policy-v2',
        rejection_reason_code: 'evil',
        rejected_at: 2_000,
        rejected_by: 'operator:test',
      },
    );

    await expect(resolveActionPolicyAtRecordTime(db, {
      actionType: 'thirdparty:bad_rejection',
      recordedAtMs: 3_000,
    })).resolves.toMatchObject({
      status: 'pending_policy',
      pointerState: 'invalid',
      mintDisposition: 'record_only',
    });
  });

  test('rejects invalid identifiers and non-integer record timestamps before storage access', async () => {
    const { db } = makeDb();
    await expect(resolveActionPolicyAtRecordTime(db, {
      actionType: ' ',
      recordedAtMs: 2_000,
    })).rejects.toThrow('actionType_required');
    await expect(resolveActionPolicyAtRecordTime(db, {
      actionType: 'thirdparty:new_action',
      recordedAtMs: 2_000.5,
    })).rejects.toThrow('recordedAtMs_must_be_a_non_negative_safe_integer');
  });
});

describe('unknown observation helper', () => {
  test('queues an unknown action for private delivery while retaining record_only', async () => {
    const { db } = makeDb();
    const alerts: PendingPolicyAlertMessage[] = [];
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failedSender = async (
      message: PendingPolicyAlertMessage,
    ): Promise<{ delivered: boolean; error?: string }> => {
      alerts.push(message);
      return { delivered: false, error: 'operator_channel_unavailable' };
    };

    const result = await resolveAndObserveActionPolicy(db, {
      actionType: 'thirdparty:queued_action',
      recordedAtMs: 2_000,
      peId: 'pe-queued',
      integrationSource: 'sdk:test',
      observedUnderPolicyVersion: 'pvt-policy-v1',
      now: 2_000,
    }, failedSender);

    expect(result.resolution).toMatchObject({
      status: 'pending_policy',
      mintDisposition: 'record_only',
      policyReviewState: 'pending_policy',
      reasonCode: UNKNOWN_ACTION_POLICY_REASON_CODE,
    });
    expect(result.queueAttempted).toBe(true);
    expect(result.observationError).toBeNull();
    expect(alerts).toHaveLength(0);
    expect(await getPendingPolicyAction(db, 'thirdparty:queued_action')).toMatchObject({
      mint_disposition: 'record_only',
      policy_review_state: 'pending_policy',
      alert_status: 'pending',
      last_alert_error: null,
    });
  });

  test('returns fail-closed even when the durable queue write itself fails', async () => {
    const { db } = makeDb({ failTxnWriteTo: PENDING_POLICY_COLLECTION });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await resolveAndObserveActionPolicy(db, {
      actionType: 'thirdparty:queue_failure',
      recordedAtMs: 2_000,
      peId: 'pe-failed',
      integrationSource: 'sdk:test',
      now: 2_000,
    });

    expect(result.resolution).toMatchObject({
      status: 'pending_policy',
      policyActivated: false,
      mintDisposition: 'record_only',
      reasonCode: UNKNOWN_ACTION_POLICY_REASON_CODE,
    });
    expect(result.queueAttempted).toBe(true);
    expect(result.observation).toBeNull();
    expect(result.observationError).toContain('Injected transaction write failure');
  });

  test('does not queue a known identifier or an already-effective prospective policy', async () => {
    const { fake, db } = makeDb();
    const alerts: PendingPolicyAlertMessage[] = [];
    const sender = async (
      message: PendingPolicyAlertMessage,
    ): Promise<{ delivered: boolean }> => {
      alerts.push(message);
      return { delivered: true };
    };

    const known = await resolveAndObserveActionPolicy(db, {
      actionType: 'x402_payment',
      recordedAtMs: 2_000,
      peId: 'pe-known',
      integrationSource: 'sdk:test',
    }, sender);

    installPointer(fake, prospectivePolicy('thirdparty:classified', RECORD_ONLY_POINTER));
    const classified = await resolveAndObserveActionPolicy(db, {
      actionType: 'thirdparty:classified',
      recordedAtMs: 2_000,
      peId: 'pe-classified',
      integrationSource: 'sdk:test',
    }, sender);

    expect(known.queueAttempted).toBe(false);
    expect(known.resolution.status).toBe('known_launch_identifier');
    expect(classified.queueAttempted).toBe(false);
    expect(classified.resolution.status).toBe('classified_prospective');
    expect(alerts).toHaveLength(0);
    expect(
      [...fake.store.keys()].filter((key) => key.startsWith(`${PENDING_POLICY_COLLECTION}/`)),
    ).toHaveLength(0);
  });
});
