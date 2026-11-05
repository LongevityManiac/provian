import crypto from 'crypto';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { ResourcePath } from '@google-cloud/firestore/build/src/path';

import {
  compareFirestoreDocumentIds,
  createFakeFirestore,
} from './__test-helpers__/fake-firestore';
import {
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
} from './__test-helpers__/armed-genesis-policy';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  GENESIS_QUALIFICATION_COLLECTION,
  buildGenesisQualification,
  drainGenesisQualifications,
  type GenesisProcessResult,
  type GenesisStateMachineDeps,
} from './genesis-award-state-machine';
import {
  MINT_BATCH_CLAIM_COLLECTION,
  listOutstandingMintBatchClaims,
  type MintBatchClaimDocument,
} from './mint-worker-coordination';
import { hashGenesisCampaignPolicyManifest } from './policy/genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import { hashProposedMonetaryPolicyTemplate } from './policy/runtime-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './policy/pvt9-approval-manifest.generated';

const TEST_GENESIS_CAMPAIGN_POLICY = installArmedGenesisPolicyForTest();
afterAll(restoreCheckedInGenesisPolicyAfterTest);

function bytes32(label: string): string {
  return `0x${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function claim(
  index: number,
  state: MintBatchClaimDocument['state'] = 'claimed',
): MintBatchClaimDocument {
  const claimId = `0x${index.toString(16).padStart(64, '0')}`;
  const submissionAuthorized = state === 'submission_authorized';
  return {
    schema_version: 'pvt-mint-claim/v1',
    claim_id: claimId,
    batch_id: bytes32(`pagination-batch-${index}`),
    lease_owner_id: 'pagination-worker',
    fencing_token: 1,
    epoch: 0,
    pe_ids: [`pe_${index}`],
    combined_reserved_atomic: '1',
    genesis_reserved_atomic: '0',
    genesis_settlement_reservation_id: null,
    economic_contract_address: '0x1111111111111111111111111111111111111111',
    anchor_contract_address: '0x2222222222222222222222222222222222222222',
    economic_state_snapshot_hash: bytes32(`snapshot-${index}`),
    economic_state_block_number: 100,
    economic_state_block_hash: bytes32('block'),
    economic_state_agreed_head_number: 111,
    economic_state_agreed_head_hash: bytes32('head'),
    economic_state_confirmation_depth: 12,
    economic_state_operator_ids: ['operator-a', 'operator-b'],
    economic_factor_fingerprint: bytes32(`factor-${index}`),
    badge_projection_input_commitment: 'a'.repeat(64),
    authorization_economic_state_snapshot_hash: submissionAuthorized
      ? bytes32(`authorization-${index}`)
      : null,
    mint_broadcast_protocol: null,
    mint_payload_hash: null,
    anchor_payload_hash: bytes32(`anchor-payload-${index}`),
    state,
    submission_authorized_until_ms: submissionAuthorized ? 10_000 : null,
    mint_tx_hash: null,
    mint_prepared_transaction: null,
    anchor_tx_hash: null,
    anchor_prepared_transaction: null,
    mint_finality: null,
    anchor_finality: null,
    anchor_event: null,
    actual_minted_atomic: null,
    reservation_delta_atomic: null,
    created_at_ms: 1,
    updated_at_ms: 1,
  };
}

async function armGenesisRecovery(fake: ReturnType<typeof createFakeFirestore>): Promise<void> {
  await fake.collection(GENESIS_ACTIVATION_COLLECTION).doc(GENESIS_ACTIVATION_DOCUMENT).set({
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
    approval_signature: {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace: 'provian-pvt-policy',
      public_key_sha256: `sha256:${'a'.repeat(64)}`,
      armored_signature: 'test-only-structured-signature',
    },
    frank_approval_audit_id: 'pagination-test-approval',
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
    ),
    approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: 'pvt9-pagination-test',
    ledger_namespace: 'pvt9-pagination-test-ledger',
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'pagination-test-operator',
  });
}

describe('deterministic recovery pagination', () => {
  test('FakeFirestore document ordering and cursors match the production comparator', async () => {
    const bmpPrivateUse = '\uE000';
    const astral = '\u{10000}';
    const corpus = [
      'plain-ascii',
      'z'.repeat(1_400),
      bmpPrivateUse,
      astral,
      '\uE001',
      '\u{10001}',
      '__id2__',
      '__id10__',
    ];
    const productionOrder = [...corpus].sort((left, right) =>
      new ResourcePath('claims', left).compareTo(new ResourcePath('claims', right)));
    const fakeComparatorOrder = [...corpus].sort(compareFirestoreDocumentIds);
    expect(fakeComparatorOrder).toEqual(productionOrder);
    expect(compareFirestoreDocumentIds(bmpPrivateUse, astral)).toBeLessThan(0);
    expect(bmpPrivateUse > astral).toBe(true); // Demonstrates why JS ordering is unsafe.

    const fake = createFakeFirestore();
    for (const id of corpus) {
      await fake.collection('ordering_corpus').doc(id).set({ id });
    }
    const ordered = await fake.collection('ordering_corpus')
      .orderBy(FieldPath.documentId(), 'asc')
      .get();
    expect(ordered.docs.map((doc) => doc.id)).toEqual(productionOrder);

    const upper = astral;
    const bounded = await fake.collection('ordering_corpus')
      .orderBy(FieldPath.documentId(), 'asc')
      .endAt(upper)
      .get();
    expect(bounded.docs.map((doc) => doc.id)).toEqual(
      productionOrder.filter((id) =>
        new ResourcePath('claims', id).compareTo(new ResourcePath('claims', upper)) <= 0),
    );
    const resumed = await fake.collection('ordering_corpus')
      .orderBy(FieldPath.documentId(), 'asc')
      .startAfter(upper)
      .get();
    expect(resumed.docs.map((doc) => doc.id)).toEqual(
      productionOrder.filter((id) =>
        new ResourcePath('claims', id).compareTo(new ResourcePath('claims', upper)) > 0),
    );
  });

  test('malformed first-page mint claims cannot hide valid claims after document 100', async () => {
    const fake = createFakeFirestore();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let index = 0; index < 205; index += 1) {
        const value = claim(index);
        await fake.collection(MINT_BATCH_CLAIM_COLLECTION).doc(value.claim_id).set(
          index < 100
            ? { ...value, schema_version: 'malformed-first-page' }
            : value as unknown as Record<string, unknown>,
        );
      }

      const discovered = await listOutstandingMintBatchClaims(
        fake as unknown as Firestore,
      );
      expect(discovered).toHaveLength(105);
      expect(discovered[0].claim_id).toBe(claim(100).claim_id);
      expect(discovered[104].claim_id).toBe(claim(204).claim_id);
      expect(consoleError).toHaveBeenCalledTimes(100);
    } finally {
      consoleError.mockRestore();
    }
  });

  test('failed first 100 Genesis qualifications rotate behind untouched later pages', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await armGenesisRecovery(fake);
    const ids: string[] = [];
    for (let index = 0; index < 205; index += 1) {
      const observedAt = 1;
      const qualification = buildGenesisQualification({
        actionType: 'genesis_human_signup',
        walletId: `wallet-pagination-${index}`,
        economicActorId: `owner-pagination-${index}`,
        actorAddress: '0x1111111111111111111111111111111111111111',
        immutableAnchorId: `wallet-pagination-${index}`,
        qualifyingActEvidenceId: `human-wallet:wallet-pagination-${index}`,
        qualifyingActAtMs: observedAt,
        walletCreatedAtMs: observedAt,
        walletCreatedEvidenceId: `human-wallet:wallet-pagination-${index}`,
      });
      ids.push(qualification.qualification_id);
      await fake.collection(GENESIS_QUALIFICATION_COLLECTION)
        .doc(qualification.qualification_id)
        .set(qualification as unknown as Record<string, unknown>);
    }
    const orderedIds = [...ids].sort();
    const permanentlyFailing = new Set(orderedIds.slice(0, 100));
    const processed: string[] = [];
    const processor = async (
      _deps: GenesisStateMachineDeps,
      qualificationId: string,
    ): Promise<GenesisProcessResult> => {
      processed.push(qualificationId);
      if (permanentlyFailing.has(qualificationId)) {
        throw new Error('permanent-first-page-fixture');
      }
      // This pure scheduling seam does not synthesize the reservation/PE
      // bindings required by a real terminal row. Remove successful fixtures
      // so the next full integrity scan sees only structurally valid records.
      await db.collection(GENESIS_QUALIFICATION_COLLECTION).doc(qualificationId).delete();
      return {
        qualificationId,
        status: 'complete',
        reason: 'fixture_complete',
        peId: null,
        reservedAtomic: '0',
      };
    };
    const deps = {
      db,
      verifyGenesisActivationApproval: () => true,
    } as unknown as GenesisStateMachineDeps;

    const first = await drainGenesisQualifications(deps, {
      limit: 100,
      now: 100,
      processQualification: processor,
    });
    const second = await drainGenesisQualifications(deps, {
      limit: 100,
      now: 101,
      processQualification: processor,
    });
    const third = await drainGenesisQualifications(deps, {
      limit: 100,
      now: 102,
      processQualification: processor,
    });

    expect(first).toHaveLength(100);
    expect(first.every((result) => result.status === 'in_progress')).toBe(true);
    expect(second).toHaveLength(100);
    expect(second.every((result) => result.status === 'complete')).toBe(true);
    expect(third).toHaveLength(100);
    expect(third.slice(0, 5).every((result) => result.status === 'complete')).toBe(true);
    expect(third.slice(5).every((result) => result.status === 'in_progress')).toBe(true);
    // All 105 untouched later-page records run before any permanently failing
    // first-page record receives a second attempt.
    expect(processed.slice(100, 205).some((id) => permanentlyFailing.has(id))).toBe(false);
    expect(new Set(processed.slice(100, 205))).toEqual(new Set(orderedIds.slice(100)));

    for (const id of permanentlyFailing) {
      const persisted = fake.store.get(`${GENESIS_QUALIFICATION_COLLECTION}/${id}`);
      expect(persisted).toMatchObject({ status: 'pending_reservation' });
      expect(persisted?.recovery_attempts).toEqual(expect.any(Number));
      expect(persisted!.recovery_attempts as number).toBeGreaterThanOrEqual(1);
      expect(persisted!.recovery_attempts as number).toBeLessThanOrEqual(2);
    }
  });

  test('a non-candidate Genesis row beyond page one is SKIPPED, not thrown on — the rest still drain (landing RED control)', async () => {
    // RED on pre-fix: the scan threw `genesis_recovery_candidate_invalid:${malformedId}` on
    // the first row the live-qualification guard rejected and mutated nothing — which 500'd the
    // production 30-min drain cron on a legitimately-denied row and starved every stranded grant
    // behind it. GREEN post-fix: the row is skipped and the valid candidates drain. The malformed
    // row sits at sorted position 150 — on page TWO of the 100-doc scan — so this also proves the
    // scan pages the whole collection and skips (not throws) across page boundaries.
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await armGenesisRecovery(fake);
    const ids: string[] = [];
    for (let index = 0; index < 205; index += 1) {
      const qualification = buildGenesisQualification({
        actionType: 'genesis_human_signup',
        walletId: `wallet-malformed-pagination-${index}`,
        economicActorId: `owner-malformed-pagination-${index}`,
        actorAddress: '0x1111111111111111111111111111111111111111',
        immutableAnchorId: `wallet-malformed-pagination-${index}`,
        qualifyingActEvidenceId: `human-wallet:wallet-malformed-pagination-${index}`,
        qualifyingActAtMs: 1,
        walletCreatedAtMs: 1,
        walletCreatedEvidenceId: `human-wallet:wallet-malformed-pagination-${index}`,
      });
      ids.push(qualification.qualification_id);
      await fake.collection(GENESIS_QUALIFICATION_COLLECTION)
        .doc(qualification.qualification_id)
        .set(qualification as unknown as Record<string, unknown>);
    }
    const malformedId = [...ids].sort(compareFirestoreDocumentIds)[150];
    const malformedKey = `${GENESIS_QUALIFICATION_COLLECTION}/${malformedId}`;
    fake.store.set(malformedKey, {
      ...fake.store.get(malformedKey)!,
      status: 'unknown_terminal_state',
    });
    const processor = jest.fn();

    const results = await drainGenesisQualifications({
      db,
      verifyGenesisActivationApproval: () => true,
    } as unknown as GenesisStateMachineDeps, {
      limit: 100,
      now: 100,
      processQualification: processor,
    });

    // Did NOT throw; drained a full page (limit=100) of the 204 valid candidates.
    expect(results).toHaveLength(100);
    expect(processor).toHaveBeenCalledTimes(100);
    // The non-candidate row was never selected: never processed, never marked.
    const processedIds = processor.mock.calls.map((call) => call[1]);
    expect(processedIds).not.toContain(malformedId);
    expect(fake.store.get(malformedKey)).not.toHaveProperty('recovery_attempts');
    expect(fake.store.get(malformedKey)).toMatchObject({ status: 'unknown_terminal_state' });
    // Every processed row is a valid candidate that got marked for recovery.
    for (const id of processedIds) {
      expect(fake.store.get(`${GENESIS_QUALIFICATION_COLLECTION}/${id}`))
        .toMatchObject({ recovery_attempts: 1 });
    }
  });

  test('a late-DENIED terminal row (reserved + PE + denied, the production shape) does not block the drain of a live candidate (landing)', async () => {
    // The exact production incident: gq_7770da4b… was a test_platform_wallet genesis_human_signup
    // denied AFTER it had reserved and emitted a PE, so it carries reservation_id/reserved_atomic/
    // pe_hash — a shape the `denied` case of isQualification (which models early denial only)
    // rejects. Pre-fix the scan threw on it; post-fix it is skipped and a genuine pending_reservation
    // candidate still drains.
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await armGenesisRecovery(fake);

    const denied = buildGenesisQualification({
      actionType: 'genesis_human_signup',
      walletId: 'wallet-late-denied',
      economicActorId: 'owner-late-denied',
      actorAddress: '0x2222222222222222222222222222222222222222',
      immutableAnchorId: 'wallet-late-denied',
      qualifyingActEvidenceId: 'human-wallet:wallet-late-denied',
      qualifyingActAtMs: 1,
      walletCreatedAtMs: 1,
      walletCreatedEvidenceId: 'human-wallet:wallet-late-denied',
    });
    const deniedKey = `${GENESIS_QUALIFICATION_COLLECTION}/${denied.qualification_id}`;
    await fake.collection(GENESIS_QUALIFICATION_COLLECTION)
      .doc(denied.qualification_id).set(denied as unknown as Record<string, unknown>);
    // Mutate into the late-denied production shape: denied, but with reservation + PE state left in place.
    fake.store.set(deniedKey, {
      ...fake.store.get(deniedKey)!,
      status: 'denied',
      denial_reason: 'test_platform_wallet',
      reservation_id: 'genesis-reservation:late-denied',
      reserved_atomic: '75000000000000000000',
      pe_hash: 'a'.repeat(64),
      prev_hash: 'b'.repeat(64),
      completed_at_ms: 2,
    });

    const live = buildGenesisQualification({
      actionType: 'genesis_human_signup',
      walletId: 'wallet-live-candidate',
      economicActorId: 'owner-live-candidate',
      actorAddress: '0x3333333333333333333333333333333333333333',
      immutableAnchorId: 'wallet-live-candidate',
      qualifyingActEvidenceId: 'human-wallet:wallet-live-candidate',
      qualifyingActAtMs: 1,
      walletCreatedAtMs: 1,
      walletCreatedEvidenceId: 'human-wallet:wallet-live-candidate',
    });
    await fake.collection(GENESIS_QUALIFICATION_COLLECTION)
      .doc(live.qualification_id).set(live as unknown as Record<string, unknown>);

    const processor = jest.fn();
    const results = await drainGenesisQualifications({
      db,
      verifyGenesisActivationApproval: () => true,
    } as unknown as GenesisStateMachineDeps, {
      limit: 100,
      now: 100,
      processQualification: processor,
    });

    // No throw; only the live candidate drained; the denied terminal row was skipped and untouched.
    expect(results).toHaveLength(1);
    expect(processor).toHaveBeenCalledTimes(1);
    expect(processor.mock.calls[0][1]).toBe(live.qualification_id);
    expect(fake.store.get(deniedKey)).not.toHaveProperty('recovery_attempts');
    expect(fake.store.get(deniedKey)).toMatchObject({ status: 'denied' });
  });
});
