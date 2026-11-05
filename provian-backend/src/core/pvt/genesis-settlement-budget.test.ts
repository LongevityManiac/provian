import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Firestore } from 'firebase-admin/firestore';

jest.mock('./policy/pvt9-approval-manifest.generated', () => {
  // Exercise the settlement kernel against the exact, approvable OpenSSH
  // fixture-A bytes without changing the repository's non-signable manifest.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixtureFs = require('fs') as typeof fs;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixtureCrypto = require('crypto') as typeof crypto;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixturePath = require('path') as typeof path;
  const bytes = fixtureFs.readFileSync(fixturePath.join(
    process.cwd(),
    'src/core/pvt/policy/__fixtures__/approval/manifest-a.json',
  ));
  return {
    PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256:
      `sha256:${fixtureCrypto.createHash('sha256').update(bytes).digest('hex')}`,
    PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64: bytes.toString('base64'),
    PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED: true,
    PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS: 'approvable_after_independent_review',
  };
});

jest.mock('./policy/genesis-settlement-approval-manifest', () => {
  // The epoch-ZERO settlement pin names the SETTLEMENT approval manifest, not the
  // Gate 1 one. This suite substitutes the same approvable OpenSSH fixture-A bytes
  // for it, inside this isolated module only; the repository's real settlement
  // manifest and the non-signable Gate 1 manifest are both untouched.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixtureFs = require('fs') as typeof fs;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixtureCrypto = require('crypto') as typeof crypto;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixturePath = require('path') as typeof path;
  const bytes = fixtureFs.readFileSync(fixturePath.join(
    process.cwd(),
    'src/core/pvt/policy/__fixtures__/approval/manifest-a.json',
  ));
  return {
    GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256:
      `sha256:${fixtureCrypto.createHash('sha256').update(bytes).digest('hex')}`,
    GENESIS_SETTLEMENT_APPROVAL_MANIFEST_UTF8_BASE64: bytes.toString('base64'),
    GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SIGNING_PERMITTED: true,
    GENESIS_SETTLEMENT_APPROVAL_MANIFEST_APPROVAL_STATUS: 'approvable_after_independent_review',
    genesisSettlementApprovalManifestBytes: () => bytes,
  };
});

jest.mock('./policy/proposed-genesis-policy', () => {
  const actual = jest.requireActual<typeof import('./policy/proposed-genesis-policy')>(
    './policy/proposed-genesis-policy',
  );
  return {
    ...actual,
    // Fixture A is a genuinely signed historical test manifest. Keep its
    // signed subject exact instead of rewriting or re-signing the fixture when
    // the checked-in, non-signable proposal version advances.
    PROPOSED_GENESIS_CAMPAIGN_POLICY: {
      ...actual.PROPOSED_GENESIS_CAMPAIGN_POLICY,
      policy_version: 'base-mainnet-genesis-proposal-2026-07-11.3',
    },
  };
});

import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  GENESIS_SETTLEMENT_EPOCH_COLLECTION,
  GENESIS_SETTLEMENT_POLICY_EVENT_COLLECTION,
  GENESIS_SETTLEMENT_RESERVATION_COLLECTION,
  INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC,
  commitGenesisSettlementReservation,
  createGenesisSettlementBudgetPolicyEvent,
  genesisSettlementReservationId,
  loadAuthorizedGenesisSettlementPolicyEvent,
  releaseGenesisSettlementReservation,
  reserveGenesisSettlementBudget as reserveGenesisSettlementBudgetRaw,
  resizeGenesisSettlementReservation,
  type GenesisSettlementBudgetPolicyEvent,
} from './genesis-settlement-budget';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import { GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256 } from './policy/genesis-settlement-approval-manifest';
import { REJECTED_PVT_APPROVAL_MANIFEST_SHA256 } from './policy/rejected-approval-manifests';
import {
  GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
  GENESIS_SETTLEMENT_CAMPAIGN_ID,
  GENESIS_SETTLEMENT_CHAIN_ID,
  GENESIS_SETTLEMENT_KERNEL_ID,
  createGenesisSettlementAuthorizationSubject,
  genesisSettlementAuthorizationSubjectSha256,
} from './policy/genesis-settlement-authorization';
import { approvalManifestSha256 } from './policy/current-approval';

const PVT = 10n ** 18n;
const TEST_SIGNATURE = {
  scheme: 'sshsig-ed25519' as const,
  signer_identity: 'frank',
  namespace: 'provian-pvt-policy',
  public_key_sha256: `sha256:${'a'.repeat(64)}`,
  armored_signature: 'test-only-structural-signature',
};
const fixtureDir = path.join(__dirname, 'policy', '__fixtures__', 'approval');
const fixtureAManifest = fs.readFileSync(path.join(fixtureDir, 'manifest-a.json'));
const TEST_APPROVED_MANIFESTS = new Map<string, Buffer>([
  [approvalManifestSha256(fixtureAManifest), fixtureAManifest],
]);
const TEST_APPROVAL_VERIFIER = (hash: string) => TEST_APPROVED_MANIFESTS.get(hash) ?? null;

function reserveGenesisSettlementBudget(
  db: Firestore,
  params: Parameters<typeof reserveGenesisSettlementBudgetRaw>[1],
) {
  return reserveGenesisSettlementBudgetRaw(db, {
    ...params,
    approvalVerifier: TEST_APPROVAL_VERIFIER,
  });
}

function binding(label: string) {
  const digest = crypto.createHash('sha256').update(label).digest('hex');
  return {
    claimId: `0x${digest}`,
    batchId: `0x${crypto.createHash('sha256').update(`batch:${label}`).digest('hex')}`,
    leaseOwnerId: `worker-${label}`,
    fencingToken: 1,
  };
}

function initialPolicyEvent() {
  return createGenesisSettlementBudgetPolicyEvent({
    event_id: 'fixture-initial',
    policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    authorized_at_epoch: 0,
    effective_epoch: 0,
    cap_atomic: INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC,
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256,
    approval_signature: TEST_SIGNATURE,
    approval_audit_id: 'initial-policy-test-audit',
    authorization_scope: GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
    chain_id: GENESIS_SETTLEMENT_CHAIN_ID,
    campaign_id: GENESIS_SETTLEMENT_CAMPAIGN_ID,
    settlement_kernel_id: GENESIS_SETTLEMENT_KERNEL_ID,
    automation_generated: false,
    previous_event_hash: null,
    evented_at_ms: 1,
    evented_by: 'test-operator',
  });
}

function createTestApprovedEvent(input: Omit<
  GenesisSettlementBudgetPolicyEvent,
  'schema_version' | 'event_hash' | 'approval_manifest_sha256'
>): GenesisSettlementBudgetPolicyEvent {
  const subject = createGenesisSettlementAuthorizationSubject(input);
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schema_version: 'pvt9-policy-approval-manifest/v1',
    approval_status: 'approvable_after_independent_review',
    signing_permitted: true,
    fixture: `synthetic-${input.event_id}`,
    genesis_settlement_authorization_subject: subject,
    genesis_settlement_authorization_subject_sha256:
      genesisSettlementAuthorizationSubjectSha256(subject),
  })}\n`, 'utf8');
  const manifestHash = approvalManifestSha256(manifestBytes);
  TEST_APPROVED_MANIFESTS.set(manifestHash, manifestBytes);
  return createGenesisSettlementBudgetPolicyEvent({
    ...input,
    approval_manifest_sha256: manifestHash,
  });
}

async function armInitialPolicy(fake: ReturnType<typeof createFakeFirestore>) {
  const event = initialPolicyEvent();
  await fake.collection(GENESIS_SETTLEMENT_POLICY_EVENT_COLLECTION)
    .doc(event.event_id)
    .set(event as unknown as Record<string, unknown>);
  return event;
}

describe('exact weekly Genesis settlement budget', () => {
  test('declares the decided 7.5M PVT weekly sub-budget', () => {
    expect(INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC).toBe((7_500_000n * PVT).toString());
  });

  test('fails closed until the exact initial policy event is installed', async () => {
    const fake = createFakeFirestore();
    await expect(reserveGenesisSettlementBudget(fake as unknown as Firestore, {
      epoch: 0,
      reservationId: genesisSettlementReservationId(0, ['pe_missing_policy']),
      requestedAtomic: PVT.toString(),
      binding: binding('missing-policy'),
    })).rejects.toThrow('Genesis settlement policy is not authorized');
  });

  test('does not accept a structurally non-empty signature without cryptographic verification', async () => {
    const fake = createFakeFirestore();
    await armInitialPolicy(fake);
    await expect(reserveGenesisSettlementBudgetRaw(fake as unknown as Firestore, {
      epoch: 0,
      reservationId: genesisSettlementReservationId(0, ['pe_unsigned_policy']),
      requestedAtomic: PVT.toString(),
      binding: binding('unsigned-policy'),
    })).rejects.toThrow('approval signature is invalid');
  });

  test('a permissive verifier cannot authorize a rejected manifest ledger entry', async () => {
    for (const rejectedHash of REJECTED_PVT_APPROVAL_MANIFEST_SHA256) {
      const fake = createFakeFirestore();
      const {
        schema_version: _schemaVersion,
        event_hash: _eventHash,
        ...initialEventInput
      } = initialPolicyEvent();
      const rejected = createGenesisSettlementBudgetPolicyEvent({
        ...initialEventInput,
        approval_manifest_sha256: rejectedHash,
      });
      await fake.collection(GENESIS_SETTLEMENT_POLICY_EVENT_COLLECTION)
        .doc(rejected.event_id)
        .set(rejected as unknown as Record<string, unknown>);
      await expect(loadAuthorizedGenesisSettlementPolicyEvent(
        fake as unknown as Firestore,
        0,
        TEST_APPROVAL_VERIFIER,
      )).rejects.toThrow('names a rejected approval manifest');
    }
  });

  test('reserves atomically, clamps to remaining capacity, and is idempotent', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await armInitialPolicy(fake);
    const firstId = genesisSettlementReservationId(0, ['pe_a']);
    const firstBinding = binding('first');
    const first = await reserveGenesisSettlementBudget(db, {
      epoch: 0,
      reservationId: firstId,
      requestedAtomic: (7_000_000n * PVT).toString(),
      binding: firstBinding,
      now: 1,
    });
    expect(first.reservedAtomic).toBe((7_000_000n * PVT).toString());
    expect((await reserveGenesisSettlementBudget(db, {
      epoch: 0,
      reservationId: firstId,
      requestedAtomic: (7_000_000n * PVT).toString(),
      binding: firstBinding,
      now: 2,
    })).idempotent).toBe(true);

    const second = await reserveGenesisSettlementBudget(db, {
      epoch: 0,
      reservationId: genesisSettlementReservationId(0, ['pe_b']),
      requestedAtomic: (1_000_000n * PVT).toString(),
      binding: binding('second'),
      now: 3,
    });
    expect(second.reservedAtomic).toBe((500_000n * PVT).toString());
    expect(second.remainingAtomic).toBe('0');
  });

  test('shrinks unused capacity, releases on pre-mint failure, and commits once', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await armInitialPolicy(fake);
    const id = genesisSettlementReservationId(3, ['pe_a', 'pe_b']);
    const owner = binding('shrink');
    await reserveGenesisSettlementBudget(db, {
      epoch: 3,
      reservationId: id,
      requestedAtomic: (100n * PVT).toString(),
      binding: owner,
      now: 1,
    });
    await resizeGenesisSettlementReservation(db, {
      reservationId: id,
      targetAtomic: (75n * PVT).toString(),
      binding: owner,
      now: 2,
    });
    await commitGenesisSettlementReservation(db, id, owner, 3);
    await commitGenesisSettlementReservation(db, id, owner, 4);
    const epoch = fake.store.get(`${GENESIS_SETTLEMENT_EPOCH_COLLECTION}/3`);
    expect(epoch).toMatchObject({
      reserved_atomic: (75n * PVT).toString(),
      committed_atomic: (75n * PVT).toString(),
    });
    await expect(releaseGenesisSettlementReservation(db, id, owner))
      .rejects.toThrow('committed Genesis settlement budget cannot be released');

    const releasedId = genesisSettlementReservationId(3, ['pe_c']);
    const releasedOwner = binding('released');
    await reserveGenesisSettlementBudget(db, {
      epoch: 3,
      reservationId: releasedId,
      requestedAtomic: (25n * PVT).toString(),
      binding: releasedOwner,
    });
    await releaseGenesisSettlementReservation(db, releasedId, releasedOwner);
    expect(fake.store.get(`${GENESIS_SETTLEMENT_EPOCH_COLLECTION}/3`))
      .toMatchObject({ reserved_atomic: (75n * PVT).toString() });
  });

  test('reacquires capacity for the same deterministic reservation after pre-mint release', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await armInitialPolicy(fake);
    const id = genesisSettlementReservationId(4, ['pe_retry_after_release']);
    const owner = binding('retry');
    const requestedAtomic = (100n * PVT).toString();
    await reserveGenesisSettlementBudget(db, {
      epoch: 4,
      reservationId: id,
      requestedAtomic,
      binding: owner,
      now: 1,
    });
    await releaseGenesisSettlementReservation(db, id, owner);

    const retried = await reserveGenesisSettlementBudget(db, {
      epoch: 4,
      reservationId: id,
      requestedAtomic,
      binding: owner,
      now: 3,
    });
    expect(retried).toMatchObject({
      reservedAtomic: requestedAtomic,
      idempotent: false,
    });
    expect(fake.store.get(`${GENESIS_SETTLEMENT_EPOCH_COLLECTION}/4`))
      .toMatchObject({ reserved_atomic: requestedAtomic, committed_atomic: '0' });
  });

  test('an idempotent pending reservation must still be covered by uncommitted epoch capacity', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await armInitialPolicy(fake);
    const id = genesisSettlementReservationId(5, ['pe_coverage_drift']);
    const owner = binding('coverage-drift');
    const amount = (100n * PVT).toString();
    await reserveGenesisSettlementBudget(db, {
      epoch: 5,
      reservationId: id,
      requestedAtomic: amount,
      binding: owner,
      now: 1,
    });
    const epochKey = `${GENESIS_SETTLEMENT_EPOCH_COLLECTION}/5`;
    fake.store.set(epochKey, {
      ...fake.store.get(epochKey)!,
      reserved_atomic: '0',
    });

    await expect(reserveGenesisSettlementBudget(db, {
      epoch: 5,
      reservationId: id,
      requestedAtomic: amount,
      binding: owner,
      now: 2,
    })).rejects.toThrow('epoch does not cover its reservation');
    expect(fake.store.get(`${GENESIS_SETTLEMENT_RESERVATION_COLLECTION}/${id}`))
      .toMatchObject({ state: 'pending', reserved_atomic: amount });
    expect(fake.store.get(epochKey)).toMatchObject({ reserved_atomic: '0' });
  });

  test('a pending reservation cannot be committed twice through drifted epoch accounting', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await armInitialPolicy(fake);
    const id = genesisSettlementReservationId(6, ['pe_commit_coverage']);
    const owner = binding('commit-coverage');
    const amount = (100n * PVT).toString();
    await reserveGenesisSettlementBudget(db, {
      epoch: 6,
      reservationId: id,
      requestedAtomic: amount,
      binding: owner,
      now: 1,
    });
    const epochKey = `${GENESIS_SETTLEMENT_EPOCH_COLLECTION}/6`;
    fake.store.set(epochKey, {
      ...fake.store.get(epochKey)!,
      committed_atomic: amount,
    });

    await expect(commitGenesisSettlementReservation(db, id, owner, 2))
      .rejects.toThrow('epoch does not cover its reservation');
    expect(fake.store.get(`${GENESIS_SETTLEMENT_RESERVATION_COLLECTION}/${id}`))
      .toMatchObject({ state: 'pending' });
    expect(fake.store.get(epochKey)).toMatchObject({ committed_atomic: amount });
  });

  test.each([
    ['epoch ledger', GENESIS_SETTLEMENT_EPOCH_COLLECTION],
    ['reservation ledger', GENESIS_SETTLEMENT_RESERVATION_COLLECTION],
  ])('unknown fields in the %s fail closed', async (_label, collection) => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await armInitialPolicy(fake);
    const id = genesisSettlementReservationId(7, [`pe_exact_${collection}`]);
    const owner = binding(`exact-${collection}`);
    await reserveGenesisSettlementBudget(db, {
      epoch: 7,
      reservationId: id,
      requestedAtomic: PVT.toString(),
      binding: owner,
      now: 1,
    });
    const key = collection === GENESIS_SETTLEMENT_EPOCH_COLLECTION
      ? `${collection}/7`
      : `${collection}/${id}`;
    fake.store.set(key, { ...fake.store.get(key)!, unexpected: true });
    await expect(commitGenesisSettlementReservation(db, id, owner, 2))
      .rejects.toThrow(/invalid Genesis settlement (epoch|reservation) ledger/);
  });

  test('applies a separately approved event prospectively and snapshots its audit hash', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const initial = await armInitialPolicy(fake);
    const changed = createTestApprovedEvent({
      event_id: 'genesis-settlement-change-test',
      policy_version: 'base-mainnet-genesis-budget-test-change-1',
      authorized_at_epoch: 0,
      effective_epoch: 2,
      cap_atomic: (8_000_000n * PVT).toString(),
      approval_status: 'approved_by_frank',
      approval_signature: TEST_SIGNATURE,
      approval_audit_id: 'future-policy-test-audit',
      authorization_scope: GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
      chain_id: GENESIS_SETTLEMENT_CHAIN_ID,
      campaign_id: GENESIS_SETTLEMENT_CAMPAIGN_ID,
      settlement_kernel_id: GENESIS_SETTLEMENT_KERNEL_ID,
      automation_generated: false,
      previous_event_hash: initial.event_hash,
      evented_at_ms: 2,
      evented_by: 'test-operator',
    });
    await fake.collection(GENESIS_SETTLEMENT_POLICY_EVENT_COLLECTION)
      .doc(changed.event_id)
      .set(changed as unknown as Record<string, unknown>);

    const before = await reserveGenesisSettlementBudget(db, {
      epoch: 1,
      reservationId: genesisSettlementReservationId(1, ['pe_before_change']),
      requestedAtomic: (9_000_000n * PVT).toString(),
      binding: binding('before-change'),
    });
    expect(before.reservedAtomic).toBe(INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC);

    const after = await reserveGenesisSettlementBudget(db, {
      epoch: 2,
      reservationId: genesisSettlementReservationId(2, ['pe_after_change']),
      requestedAtomic: (9_000_000n * PVT).toString(),
      binding: binding('after-change'),
    });
    expect(after.reservedAtomic).toBe((8_000_000n * PVT).toString());
    expect(fake.store.get(`${GENESIS_SETTLEMENT_EPOCH_COLLECTION}/2`)).toMatchObject({
      cap_atomic: (8_000_000n * PVT).toString(),
      policy_event_id: changed.event_id,
      policy_event_hash: changed.event_hash,
      approval_manifest_sha256: changed.approval_manifest_sha256,
    });
  });

  test('the current launch approval hash cannot authorize different cap economics', async () => {
    const fake = createFakeFirestore();
    const initial = await armInitialPolicy(fake);
    const unauthorized = createGenesisSettlementBudgetPolicyEvent({
      event_id: 'genesis-settlement-unauthorized-change',
      policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
      authorized_at_epoch: 0,
      effective_epoch: 1,
      cap_atomic: (8_000_000n * PVT).toString(),
      approval_status: 'approved_by_frank',
      approval_manifest_sha256: GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256,
      approval_signature: TEST_SIGNATURE,
      approval_audit_id: 'reused-launch-approval-audit',
      authorization_scope: GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
      chain_id: GENESIS_SETTLEMENT_CHAIN_ID,
      campaign_id: GENESIS_SETTLEMENT_CAMPAIGN_ID,
      settlement_kernel_id: GENESIS_SETTLEMENT_KERNEL_ID,
      automation_generated: false,
      previous_event_hash: initial.event_hash,
      evented_at_ms: 2,
      evented_by: 'test-operator',
    });
    await fake.collection(GENESIS_SETTLEMENT_POLICY_EVENT_COLLECTION)
      .doc(unauthorized.event_id)
      .set(unauthorized as unknown as Record<string, unknown>);
    await expect(reserveGenesisSettlementBudget(fake as unknown as Firestore, {
      epoch: 1,
      reservationId: genesisSettlementReservationId(1, ['pe_unauthorized_change']),
      requestedAtomic: PVT.toString(),
      binding: binding('unauthorized-change'),
    })).rejects.toThrow('signed authorization does not match policy event');
  });

  test('a later policy event must take effect strictly after its authorization epoch', async () => {
    const fake = createFakeFirestore();
    const initial = await armInitialPolicy(fake);
    const retroactive = createTestApprovedEvent({
      event_id: 'genesis-settlement-retroactive-change',
      policy_version: 'base-mainnet-genesis-budget-retroactive-test',
      authorized_at_epoch: 2,
      effective_epoch: 2,
      cap_atomic: (8_000_000n * PVT).toString(),
      approval_status: 'approved_by_frank',
      approval_signature: TEST_SIGNATURE,
      approval_audit_id: 'retroactive-policy-test-audit',
      authorization_scope: GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
      chain_id: GENESIS_SETTLEMENT_CHAIN_ID,
      campaign_id: GENESIS_SETTLEMENT_CAMPAIGN_ID,
      settlement_kernel_id: GENESIS_SETTLEMENT_KERNEL_ID,
      automation_generated: false,
      previous_event_hash: initial.event_hash,
      evented_at_ms: 3,
      evented_by: 'test-operator',
    });
    await fake.collection(GENESIS_SETTLEMENT_POLICY_EVENT_COLLECTION)
      .doc(retroactive.event_id)
      .set(retroactive as unknown as Record<string, unknown>);
    await expect(reserveGenesisSettlementBudget(fake as unknown as Firestore, {
      epoch: 2,
      reservationId: genesisSettlementReservationId(2, ['pe_retroactive_change']),
      requestedAtomic: PVT.toString(),
      binding: binding('retroactive-change'),
    })).rejects.toThrow('Genesis settlement policy event chain is invalid');
  });
});
