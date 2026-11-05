import type { Firestore } from 'firebase-admin/firestore';

import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  TEST_GENESIS_WINDOW_START_MS,
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
} from './__test-helpers__/armed-genesis-policy';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  GENESIS_QUALIFICATION_COLLECTION,
  GENESIS_QUALIFICATION_RETENTION_COLLECTION,
  buildGenesisQualification,
  genesisQualificationId,
  writeRetainedGenesisQualification,
  type GenesisQualificationDocument,
} from './genesis-award-state-machine';
import { backfillRetainedGenesisQualifications } from './genesis-retention-backfill';
import {
  hashGenesisCampaignPolicyManifest,
  type GenesisCampaignActivation,
} from './policy/genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import { hashProposedMonetaryPolicyTemplate } from './policy/runtime-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './policy/pvt9-approval-manifest.generated';

installArmedGenesisPolicyForTest();
afterAll(restoreCheckedInGenesisPolicyAfterTest);

// A distinct instant per stage proves the promoted outbox carries the ORIGINAL
// qualifying time, never the retention time or the backfill time.
const ORIGINAL_ACT_MS = TEST_GENESIS_WINDOW_START_MS + 5_000;
const RETAINED_AT_MS = ORIGINAL_ACT_MS + 1_000_000;
const BACKFILL_NOW = RETAINED_AT_MS + 1_000_000;

function armedActivation(overrides: Partial<GenesisCampaignActivation> = {}): GenesisCampaignActivation {
  return {
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
    approval_signature: {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace: 'provian-pvt-policy',
      public_key_sha256: `sha256:${'a'.repeat(64)}`,
      armored_signature: 'test-only-structured-signature',
    },
    frank_approval_audit_id: 'frank-test-approval',
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
    ),
    approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: ORIGINAL_ACT_MS - 1,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: 'pvt9-test-manifest',
    ledger_namespace: 'pvt9-genesis-backfill-test',
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'operator-test-activation',
    ...overrides,
  };
}

function humanQual(walletId: string, actMs = ORIGINAL_ACT_MS): GenesisQualificationDocument {
  return buildGenesisQualification({
    actionType: 'genesis_human_signup',
    walletId,
    economicActorId: `user-${walletId}`,
    actorAddress: '0x1111111111111111111111111111111111111111',
    immutableAnchorId: walletId,
    qualifyingActEvidenceId: `human-wallet:${walletId}`,
    qualifyingActAtMs: actMs,
    walletCreatedAtMs: actMs,
    walletCreatedEvidenceId: `human-wallet:${walletId}`,
  });
}

async function seedRetention(
  db: Firestore,
  qual: GenesisQualificationDocument,
): Promise<void> {
  await db.runTransaction(async (txn) => {
    writeRetainedGenesisQualification(txn, db, qual, RETAINED_AT_MS);
  });
}

async function setActivation(
  fake: ReturnType<typeof createFakeFirestore>,
  activation: GenesisCampaignActivation,
): Promise<void> {
  await fake.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT)
    .set(activation as unknown as Record<string, unknown>);
}

const acceptVerifier = { verifyGenesisActivationApproval: () => true };

describe('H2 Genesis retention backfill', () => {
  test('promotes a retained record when the activation now admits, preserving the original timestamp', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const walletId = 'wallet-promote';
    await seedRetention(db, humanQual(walletId));
    await setActivation(fake, armedActivation());

    const report = await backfillRetainedGenesisQualifications(
      { db, ...acceptVerifier },
      { now: BACKFILL_NOW },
    );

    const id = genesisQualificationId('genesis_human_signup', walletId);
    expect(report.promoted).toEqual([id]);
    expect(report.still_refused).toEqual([]);
    // Now in the mint-readable outbox, byte-faithful to a first-try persist.
    const outbox = fake.store.get(`${GENESIS_QUALIFICATION_COLLECTION}/${id}`) as
      unknown as GenesisQualificationDocument;
    expect(outbox.qualification_id).toBe(id);
    // ORIGINAL act time, NOT the retention time and NOT the backfill time.
    expect(outbox.qualifying_act_evidence.qualifying_act_at_ms).toBe(ORIGINAL_ACT_MS);
    expect(outbox.created_at_ms).toBe(ORIGINAL_ACT_MS);
    // Retention record stamped promoted for audit.
    const retained = fake.store.get(`${GENESIS_QUALIFICATION_RETENTION_COLLECTION}/${id}`) as
      unknown as { promoted_at_ms: number };
    expect(retained.promoted_at_ms).toBe(BACKFILL_NOW);
  });

  // RED CONTROL: a retained record ALONE is not a grant. No activation => no promote.
  test('does NOT promote when the activation is absent (fail-closed)', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const walletId = 'wallet-noactivation';
    await seedRetention(db, humanQual(walletId));
    // No activation doc.

    const report = await backfillRetainedGenesisQualifications(
      { db, ...acceptVerifier },
      { now: BACKFILL_NOW },
    );

    const id = genesisQualificationId('genesis_human_signup', walletId);
    expect(report.promoted).toEqual([]);
    expect(report.still_refused).toEqual([id]);
    expect(fake.store.has(`${GENESIS_QUALIFICATION_COLLECTION}/${id}`)).toBe(false);
  });

  // RED CONTROL: a KILLED activation must not resurrect a grant.
  test('does NOT promote when the activation is killed (fail-closed)', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const walletId = 'wallet-killed';
    await seedRetention(db, humanQual(walletId));
    await setActivation(fake, armedActivation({
      grants_enabled: false,
      genesis_kill_switch_active: true,
    }));

    const report = await backfillRetainedGenesisQualifications(
      { db, ...acceptVerifier },
      { now: BACKFILL_NOW },
    );

    const id = genesisQualificationId('genesis_human_signup', walletId);
    expect(report.still_refused).toEqual([id]);
    expect(fake.store.has(`${GENESIS_QUALIFICATION_COLLECTION}/${id}`)).toBe(false);
  });

  // RED CONTROL: an activation carrying the WRONG approval manifest hash is invalid
  // regardless of signature — it must not promote.
  test('does NOT promote when the activation manifest hash is wrong (fail-closed)', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const walletId = 'wallet-wronghash';
    await seedRetention(db, humanQual(walletId));
    await setActivation(fake, armedActivation({
      approval_manifest_sha256: `sha256:${'b'.repeat(64)}`,
    }));

    const report = await backfillRetainedGenesisQualifications(
      { db, ...acceptVerifier },
      { now: BACKFILL_NOW },
    );

    const id = genesisQualificationId('genesis_human_signup', walletId);
    expect(report.still_refused).toEqual([id]);
    expect(fake.store.has(`${GENESIS_QUALIFICATION_COLLECTION}/${id}`)).toBe(false);
  });

  test('is idempotent — a second run promotes nothing and never double-writes', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const walletId = 'wallet-idem';
    await seedRetention(db, humanQual(walletId));
    await setActivation(fake, armedActivation());
    const id = genesisQualificationId('genesis_human_signup', walletId);

    const first = await backfillRetainedGenesisQualifications(
      { db, ...acceptVerifier },
      { now: BACKFILL_NOW },
    );
    expect(first.promoted).toEqual([id]);

    const second = await backfillRetainedGenesisQualifications(
      { db, ...acceptVerifier },
      { now: BACKFILL_NOW + 10 },
    );
    expect(second.promoted).toEqual([]);
    expect(second.already_present).toEqual([id]);
    // Exactly one outbox row, never a second write.
    expect(
      [...fake.store.keys()].filter((k) => k.startsWith(`${GENESIS_QUALIFICATION_COLLECTION}/`)),
    ).toHaveLength(1);
  });

  test('dry-run reports what it would promote but writes nothing', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const walletId = 'wallet-dry';
    await seedRetention(db, humanQual(walletId));
    await setActivation(fake, armedActivation());
    const id = genesisQualificationId('genesis_human_signup', walletId);

    const report = await backfillRetainedGenesisQualifications(
      { db, ...acceptVerifier },
      { dryRun: true, now: BACKFILL_NOW },
    );

    expect(report.dry_run).toBe(true);
    expect(report.promoted).toEqual([id]);
    // Nothing written: no outbox row, retention still unpromoted.
    expect(fake.store.has(`${GENESIS_QUALIFICATION_COLLECTION}/${id}`)).toBe(false);
    const retained = fake.store.get(`${GENESIS_QUALIFICATION_RETENTION_COLLECTION}/${id}`) as
      unknown as { promoted_at_ms: number | null };
    expect(retained.promoted_at_ms).toBeNull();
  });
});
