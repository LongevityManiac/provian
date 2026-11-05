import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import stableStringify from 'json-stable-stringify';

import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
} from './__test-helpers__/armed-genesis-policy';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  GENESIS_QUALIFICATION_COLLECTION,
  GENESIS_QUALIFICATION_RETENTION_COLLECTION,
  buildGenesisQualification,
  closeGenesisAdmission,
  genesisQualificationId,
  isRetainedGenesisQualification,
  type RetainedGenesisQualification,
} from './genesis-award-state-machine';
import {
  DEVICE_REGISTRATION_REQUEST_COLLECTION,
  HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION,
  acknowledgeHumanWalletStandardAccrual,
  commitDeviceRegistration,
  commitHumanWalletRegistration,
  deterministicDeviceRegistrationIds,
  humanWalletRegistrationIndexId,
  humanWalletRegistrationRequestFingerprint,
  humanRegistrationDisplaceable,
  deviceRegistrationPeContent,
  GENESIS_HUMAN_SIGNUP_BY_ADDRESS_COLLECTION,
} from './genesis-ingress';
import { METER_RELAY_ACTS_COLLECTION } from '../meter/meter-relay-authored';
import { peHashOf as wirePeHashOf, type PeV2 } from '../meter/meter-wire';
import { backfillRetainedGenesisQualifications } from './genesis-retention-backfill';
import {
  hashGenesisCampaignPolicyManifest,
  type GenesisCampaignActivation,
} from './policy/genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import { hashProposedMonetaryPolicyTemplate } from './policy/runtime-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './policy/pvt9-approval-manifest.generated';
import { createNativeWalletRegistrationFence } from './native-wallet-registration';
import {
  INBOUND_WATCHER_CHECKPOINT_COLLECTION,
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
} from './watcher-address-admission';

installArmedGenesisPolicyForTest();
afterAll(restoreCheckedInGenesisPolicyAfterTest);

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function armedActivation(effectiveAtMs: number): GenesisCampaignActivation {
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
    effective_at_ms: effectiveAtMs,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: 'pvt9-test-manifest',
    ledger_namespace: 'pvt9-genesis-ingress-test',
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'operator-test-activation',
  };
}

function humanInput(
  db: Firestore,
  userId: string,
  walletId: string,
  createdAtMs: number,
) {
  const peId = `pe_${walletId}`;
  const address = '0x1111111111111111111111111111111111111111';
  const qualification = buildGenesisQualification({
    actionType: 'genesis_human_signup',
    walletId,
    economicActorId: userId,
    actorAddress: address,
    immutableAnchorId: walletId,
    qualifyingActEvidenceId: `human-wallet:${walletId}`,
    qualifyingActAtMs: createdAtMs,
    walletCreatedAtMs: createdAtMs,
    walletCreatedEvidenceId: `human-wallet:${walletId}`,
  });
  const nativeWatcherRegistration = createNativeWalletRegistrationFence(130);
  return {
    db,
    userId,
    walletId,
    address,
    publicKey: 'a'.repeat(128),
    requestFingerprint: humanWalletRegistrationRequestFingerprint(
      userId,
      address,
      'a'.repeat(128),
    ),
    economicDeviceId: 'auth-device-original',
    createdAtMs,
    walletDocument: {
      id: walletId,
      user_id: userId,
      type: 'human',
      address,
      public_key: 'a'.repeat(128),
      created_at: createdAtMs,
      native_watcher_registration: nativeWatcherRegistration,
    },
    nativeWatcherRegistration,
    peId,
    buildAccrual: (peHash: string) => ({
      peId,
      userId,
      actionType: 'wallet_created',
      integrationSource: 'human_wallet_registration',
      attestationDepth: 'software',
      peHash,
      timestamp: createdAtMs,
      ownerType: 'human' as const,
      walletAddress: address,
      throwOnError: true,
    }),
    genesisQualification: qualification,
    genesisActivationApprovalVerifier: () => true,
    // the route verified this; the commit binds + consumes it on the creation branch.
    addressProof: testAddressProof(userId, address, `${walletId}:${createdAtMs}`, createdAtMs),
  } as const;
}

/** A route-verified proof as the commit receives it (the EIP-712 check lives in the route). */
function testAddressProof(userId: string, address: string, nonce: string, signedAtMs: number) {
  return {
    digest: hash(`proof:${userId}:${address.toLowerCase()}:${nonce}`),
    signer: address.toLowerCase(),
    user_id: userId,
    device_id: 'auth-device-original',
    signed_at_ms: signedAtMs,
  };
}

function deviceInput(
  db: Firestore,
  ownerId: string,
  registrationId: string,
  createdAtMs: number,
) {
  const ids = deterministicDeviceRegistrationIds(ownerId, registrationId);
  const qualification = buildGenesisQualification({
    actionType: 'genesis_device_link',
    walletId: 'wallet-owner',
    economicActorId: ownerId,
    actorAddress: '0x2222222222222222222222222222222222222222',
    immutableAnchorId: ids.deviceId,
    qualifyingActEvidenceId: `registered-device:${ids.deviceId}`,
    qualifyingActAtMs: createdAtMs,
    walletCreatedAtMs: createdAtMs - 1_000,
    walletCreatedEvidenceId: 'human-wallet:wallet-owner',
  });
  const peContent = deviceRegistrationPeContent({
    ownerWalletId: 'wallet-owner',
    ownerAddress: '0x2222222222222222222222222222222222222222',
    ownerType: 'human',
    deviceId: ids.deviceId,
    deviceName: 'Test device',
    deviceType: 'coding_workstation',
    platform: 'linux',
    attestationCapability: 'software',
  });
  return {
    db,
    requestDocumentId: ids.requestDocumentId,
    registrationId,
    requestFingerprint: hash(`request:${ownerId}:${registrationId}`),
    ownerId,
    ownerWalletId: 'wallet-owner',
    ownerType: 'human' as const,
    deviceId: ids.deviceId,
    deviceDocument: {
      device_id: ids.deviceId,
      owner_user_id: ownerId,
      owner_wallet_id: 'wallet-owner',
      owner_type: 'human',
      owner_address: '0x2222222222222222222222222222222222222222',
      device_name: 'Test device',
      device_type: 'coding_workstation',
      platform: 'linux',
      attestation_capability: 'software',
      status: 'active',
      created_at: createdAtMs,
      device_key_prefix: `pdk_${hash(registrationId).slice(0, 16)}`,
    },
    deviceKeyPrefix: `pdk_${hash(registrationId).slice(0, 16)}`,
    peId: ids.peId,
    createdAtMs,
    maxActiveDevices: 10,
    peContent,
    buildAccrual: (peHash: string) => ({
      peId: ids.peId,
      userId: ownerId,
      actionType: 'device_register',
      integrationSource: 'device_registration',
      attestationDepth: 'software',
      peHash,
      timestamp: createdAtMs,
      isDevicePE: true,
      throwOnError: true,
    }),
    genesisQualification: qualification,
    genesisActivationApprovalVerifier: () => true,
  } as const;
}

async function arm(fake: ReturnType<typeof createFakeFirestore>, effectiveAtMs: number): Promise<void> {
  await fake.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT)
    .set(armedActivation(effectiveAtMs) as unknown as Record<string, unknown>);
}

function countCollection(store: Map<string, Record<string, unknown>>, collection: string): number {
  return [...store.keys()].filter((key) => key.startsWith(`${collection}/`)).length;
}

describe('atomic accounting transactional Genesis ingress', () => {
  test('the current corrections-pending activation cannot persist a human qualification', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now);
    const {
      genesisActivationApprovalVerifier: _testOnlyVerifier,
      ...productionInput
    } = humanInput(db, 'user-current-digest', 'wallet-current-digest', now);

    const result = await commitHumanWalletRegistration(productionInput);
    expect(result.created).toBe(true);
    expect(result.marker.genesis_qualification_id).toBeNull();
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(0);
  });

  test('two simultaneous first human registrations produce one wallet, PE, and outbox', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    const [first, second] = await Promise.all([
      commitHumanWalletRegistration(humanInput(db, 'user-one', 'wallet-a', now)),
      commitHumanWalletRegistration(humanInput(db, 'user-one', 'wallet-b', now)),
    ]);

    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.marker.wallet_id).toBe(second.marker.wallet_id);
    expect(first.marker.pe_id).toBe(second.marker.pe_id);
    expect(first.marker.pe_hash).toBe(second.marker.pe_hash);
    expect(first.marker.prev_hash).toBe(second.marker.prev_hash);
    expect(countCollection(fake.store, 'wallets')).toBe(1);
    expect(countCollection(fake.store, METER_RELAY_ACTS_COLLECTION)).toBe(1);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
    expect(countCollection(fake.store, HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION)).toBe(1);
  });

  test('human replay returns the exact original PE/economic marker and accrual acknowledgement is idempotent', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    const original = humanInput(db, 'user-replay', 'wallet-original', now);
    const first = await commitHumanWalletRegistration(original);
    const replay = await commitHumanWalletRegistration({
      ...humanInput(db, 'user-replay', 'wallet-discarded', now + 5_000),
      // A retry reconstructs the same client key/address identity even though
      // its newly proposed wallet/PE ids and wall clock are discarded.
      publicKey: original.publicKey,
      requestFingerprint: original.requestFingerprint,
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.marker).toEqual(first.marker);
    // PE METER: the relay keeps no copy; the replay rebuilds the PE, which hashes to the marker.
    expect(replay.peDocument).toMatchObject({
      pe_id: first.marker.pe_id,
      prev_hash: first.marker.prev_hash,
      action_type: 'wallet_created',
    });
    expect(wirePeHashOf(replay.peDocument as unknown as PeV2)).toBe(first.marker.pe_hash);
    expect(replay.peDocument).toEqual(first.peDocument);
    expect(replay.peMetered).toBe(true);
    expect(replay.marker.economic_device_id).toBe('auth-device-original');

    const acknowledged = await acknowledgeHumanWalletStandardAccrual({
      db,
      userId: 'user-replay',
      peId: first.marker.pe_id,
      peHash: first.marker.pe_hash,
      acknowledgedAtMs: now + 10_000,
    });
    const replayedAck = await acknowledgeHumanWalletStandardAccrual({
      db,
      userId: 'user-replay',
      peId: first.marker.pe_id,
      peHash: first.marker.pe_hash,
      acknowledgedAtMs: now + 20_000,
    });
    expect(acknowledged.standard_accrual_status).toBe('complete');
    expect(replayedAck.standard_accrual_acknowledged_at_ms).toBe(now + 10_000);
  });

  test('human replay with a different key/address identity fails closed without a second artifact', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    await commitHumanWalletRegistration(humanInput(db, 'user-mismatch', 'wallet-a', now));
    const changed = humanInput(db, 'user-mismatch', 'wallet-b', now + 1);

    await expect(commitHumanWalletRegistration({
      ...changed,
      address: '0x2222222222222222222222222222222222222222',
      walletDocument: {
        ...changed.walletDocument,
        address: '0x2222222222222222222222222222222222222222',
      },
      requestFingerprint: humanWalletRegistrationRequestFingerprint(
        'user-mismatch',
        '0x2222222222222222222222222222222222222222',
        changed.publicKey,
      ),
    })).rejects.toMatchObject({ code: 'human_wallet_registration_index_invalid' });
    expect(countCollection(fake.store, 'wallets')).toBe(1);
    expect(countCollection(fake.store, METER_RELAY_ACTS_COLLECTION)).toBe(1);
  });

  test('RED: human replay rejects a marker whose pe hash no longer rebuilds from the registration', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    const original = humanInput(db, 'user-pe-rewrite', 'wallet-pe-rewrite', now);
    await commitHumanWalletRegistration(original);
    const markerKey = `${HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION}/${humanWalletRegistrationIndexId('user-pe-rewrite')}`;
    fake.store.set(markerKey, { ...fake.store.get(markerKey)!, pe_hash: 'f'.repeat(64) });

    await expect(commitHumanWalletRegistration({
      ...humanInput(db, 'user-pe-rewrite', 'wallet-discarded', now + 1),
      publicKey: original.publicKey,
      requestFingerprint: original.requestFingerprint,
    })).rejects.toMatchObject({ code: 'human_wallet_registration_pe_invalid' });
    expect(countCollection(fake.store, 'wallets')).toBe(1);
    expect(countCollection(fake.store, METER_RELAY_ACTS_COLLECTION)).toBe(1);
  });

  test('human replay rejects an unknown registration-marker field', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    const original = humanInput(db, 'user-marker-rewrite', 'wallet-marker-rewrite', now);
    await commitHumanWalletRegistration(original);
    const markerKey = `${HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION}/${humanWalletRegistrationIndexId('user-marker-rewrite')}`;
    fake.store.set(markerKey, { ...fake.store.get(markerKey)!, unexpected: true });

    await expect(commitHumanWalletRegistration({
      ...humanInput(db, 'user-marker-rewrite', 'wallet-discarded', now + 1),
      publicKey: original.publicKey,
      requestFingerprint: original.requestFingerprint,
    })).rejects.toMatchObject({ code: 'human_wallet_registration_index_invalid' });
  });

  test.each([
    ['admission schema', (store: Map<string, Record<string, unknown>>) => {
      const key = [...store.keys()].find((candidate) =>
        candidate.startsWith(`${WATCHER_ADDRESS_ADMISSION_COLLECTION}/`))!;
      store.set(key, { ...store.get(key)!, unexpected: true });
    }],
    ['checkpoint schema', (store: Map<string, Record<string, unknown>>) => {
      const key = `${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`;
      store.set(key, { ...store.get(key)!, unexpected: true });
    }],
    ['membership binding', (store: Map<string, Record<string, unknown>>) => {
      const key = [...store.keys()].find((candidate) =>
        candidate.startsWith(`${WATCHER_ADDRESS_ADMISSION_COLLECTION}/`))!;
      store.set(key, { ...store.get(key)!, membership_generation: 2 });
    }],
  ])('human replay rejects a corrupted watcher %s', async (_label, mutate) => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    const original = humanInput(db, `user-watcher-${_label.replace(/\s+/g, '-')}`, 'wallet-watcher', now);
    await commitHumanWalletRegistration(original);
    mutate(fake.store);

    await expect(commitHumanWalletRegistration({
      ...humanInput(
        db,
        `user-watcher-${_label.replace(/\s+/g, '-')}`,
        'wallet-discarded',
        now + 1,
      ),
      publicKey: original.publicKey,
      requestFingerprint: original.requestFingerprint,
    })).rejects.toMatchObject({ code: 'human_wallet_watcher_registration_invalid' });
  });

  test('human accrual acknowledgement rejects a timestamp before wallet creation', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    const committed = await commitHumanWalletRegistration(
      humanInput(db, 'user-ack-time', 'wallet-ack-time', now),
    );

    await expect(acknowledgeHumanWalletStandardAccrual({
      db,
      userId: 'user-ack-time',
      peId: committed.marker.pe_id,
      peHash: committed.marker.pe_hash,
      acknowledgedAtMs: now - 1,
    })).rejects.toMatchObject({ code: 'human_wallet_registration_ack_timestamp_invalid' });
  });

  test('a transaction crash rolls back every device artifact and the same retry creates exactly one', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    let fail = true;
    const base = deviceInput(db, 'owner-crash', 'registration-crash-0001', now);
    const injected = {
      ...base,
      // The accrual is built inside the tip transaction; a throw there rolls everything back.
      buildAccrual: (peHash: string) => {
        if (fail) {
          fail = false;
          throw new Error('injected-before-atomic-commit');
        }
        return base.buildAccrual(peHash);
      },
    };
    await expect(commitDeviceRegistration(injected)).rejects.toThrow(
      'injected-before-atomic-commit',
    );
    expect(fake.store.size).toBe(1); // signed activation only; transaction writes rolled back

    const retried = await commitDeviceRegistration(injected);
    expect(retried.created).toBe(true);
    expect(countCollection(fake.store, 'devices')).toBe(1);
    expect(countCollection(fake.store, METER_RELAY_ACTS_COLLECTION)).toBe(1);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
    expect(countCollection(fake.store, DEVICE_REGISTRATION_REQUEST_COLLECTION)).toBe(1);
  });

  test('simultaneous retries of one device request return one stable anchor/outbox', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const input = deviceInput(db, 'owner-retry', 'registration-retry-0001', Date.now());
    await arm(fake, input.createdAtMs - 1);
    const [first, second] = await Promise.all([
      commitDeviceRegistration(input),
      commitDeviceRegistration(input),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.marker.device_id).toBe(second.marker.device_id);
    expect(first.marker.pe_id).toBe(second.marker.pe_id);
    expect(countCollection(fake.store, 'devices')).toBe(1);
    expect(countCollection(fake.store, METER_RELAY_ACTS_COLLECTION)).toBe(1);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
  });

  test('RED: device replay rejects a device record whose PE inputs were rewritten (the PE no longer rebuilds)', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const input = deviceInput(db, 'owner-pe-rewrite', 'registration-pe-rewrite', Date.now());
    await arm(fake, input.createdAtMs - 1);
    const committed = await commitDeviceRegistration(input);
    const deviceKey = `devices/${committed.marker.device_id}`;
    fake.store.set(deviceKey, { ...fake.store.get(deviceKey)!, platform: 'rewritten' });

    await expect(commitDeviceRegistration(input))
      .rejects.toMatchObject({ code: 'device_registration_pe_invalid' });
    expect(countCollection(fake.store, 'devices')).toBe(1);
    expect(countCollection(fake.store, METER_RELAY_ACTS_COLLECTION)).toBe(1);
  });

  test('device replay rejects an unknown registration-marker field', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const input = deviceInput(db, 'owner-marker-rewrite', 'registration-marker-rewrite', Date.now());
    await arm(fake, input.createdAtMs - 1);
    await commitDeviceRegistration(input);
    const markerKey = `${DEVICE_REGISTRATION_REQUEST_COLLECTION}/${input.requestDocumentId}`;
    fake.store.set(markerKey, { ...fake.store.get(markerKey)!, unexpected: true });

    await expect(commitDeviceRegistration(input))
      .rejects.toMatchObject({ code: 'device_registration_request_invalid' });
  });

  test('the active-device limit is serialized across simultaneous distinct registrations', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    for (let index = 0; index < 9; index += 1) {
      await fake.collection('devices').doc(`existing-${index}`).set({
        owner_user_id: 'owner-limit',
        status: 'active',
      });
    }
    const now = Date.now();
    await arm(fake, now - 1);
    const results = await Promise.allSettled([
      commitDeviceRegistration(deviceInput(
        db,
        'owner-limit',
        'registration-limit-a001',
        now,
      )),
      commitDeviceRegistration(deviceInput(
        db,
        'owner-limit',
        'registration-limit-b001',
        now + 1,
      )),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(countCollection(fake.store, 'devices')).toBe(10);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
  });

  test('evented close admits a pre-cutoff act, rejects a later outbox, and never flips kill', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const cutoff = Date.now();
    await fake.collection(GENESIS_ACTIVATION_COLLECTION)
      .doc(GENESIS_ACTIVATION_DOCUMENT)
      .set(armedActivation(cutoff - 5_000) as unknown as Record<string, unknown>);

    const closed = await closeGenesisAdmission(db, {
      admissionCloseAuditId: 'close-ingress-test-001',
      closedBy: 'operator-test',
      now: cutoff,
      approvalVerifier: () => true,
    });
    expect(closed.idempotent).toBe(false);
    const activation = fake.store.get(
      `${GENESIS_ACTIVATION_COLLECTION}/${GENESIS_ACTIVATION_DOCUMENT}`,
    );
    expect(activation).toMatchObject({
      grants_enabled: false,
      genesis_kill_switch_active: false,
      admission_closed_at_ms: cutoff,
    });

    await commitDeviceRegistration(deviceInput(
      db,
      'owner-close',
      'registration-before-cutoff',
      cutoff - 1,
    ));
    await commitDeviceRegistration(deviceInput(
      db,
      'owner-close',
      'registration-after-cutoff0',
      cutoff + 1,
    ));
    expect(countCollection(fake.store, 'devices')).toBe(2);
    expect(countCollection(fake.store, METER_RELAY_ACTS_COLLECTION)).toBe(2);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);

    const replay = await closeGenesisAdmission(db, {
      admissionCloseAuditId: 'close-ingress-test-001',
      closedBy: 'operator-test',
      now: cutoff + 5_000,
      approvalVerifier: () => true,
    });
    expect(replay).toMatchObject({ idempotent: true, cutoffAtMs: cutoff });
  });
});

describe('H1 durable retention for the human and device legs', () => {
  test('human: an in-window act with NO activation is retained, not dropped', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    // No arm(): the activation doc is absent — exactly the window-open-before-doc gap.
    const result = await commitHumanWalletRegistration(
      humanInput(db, 'user-retain-h', 'wallet-retain-h', now),
    );
    expect(result.created).toBe(true);
    expect(result.genesisDisposition).toBe('retained');
    // Product action committed; the grant is NOT dropped.
    expect(result.marker.genesis_qualification_id).toBeNull();
    // Fail-closed: the mint-readable outbox has NO row for this act.
    const id = genesisQualificationId('genesis_human_signup', 'wallet-retain-h');
    expect(fake.store.has(`${GENESIS_QUALIFICATION_COLLECTION}/${id}`)).toBe(false);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(0);
    // Durably retained with the ORIGINAL qualifying timestamp.
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_RETENTION_COLLECTION)).toBe(1);
    const retained = fake.store.get(`${GENESIS_QUALIFICATION_RETENTION_COLLECTION}/${id}`);
    expect(isRetainedGenesisQualification(retained)).toBe(true);
    const doc = retained as unknown as RetainedGenesisQualification;
    expect(doc.qualification.qualifying_act_evidence.qualifying_act_at_ms).toBe(now);
    expect(doc.retention_reason).toBe('persist_gate_refused_in_window');
    expect(doc.promoted_at_ms).toBeNull();
  });

  test('human: a KILLED activation retains an in-window act (the H0.1 fix)', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await fake.collection(GENESIS_ACTIVATION_COLLECTION)
      .doc(GENESIS_ACTIVATION_DOCUMENT)
      .set({
        ...armedActivation(now - 1),
        grants_enabled: false,
        genesis_kill_switch_active: true,
      } as unknown as Record<string, unknown>);
    const result = await commitHumanWalletRegistration(
      humanInput(db, 'user-kill-h', 'wallet-kill-h', now),
    );
    expect(result.genesisDisposition).toBe('retained');
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(0);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_RETENTION_COLLECTION)).toBe(1);
  });

  // Paired positive control : SAME input shape, gate ADMITS -> outbox, never
  // retention. This makes every "outbox is empty" assertion above non-vacuous — the
  // outbox path demonstrably works, the refusal path simply routes elsewhere.
  test('human control: a valid activation persists to the OUTBOX and writes NO retention', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    const result = await commitHumanWalletRegistration(
      humanInput(db, 'user-persist-h', 'wallet-persist-h', now),
    );
    expect(result.genesisDisposition).toBe('persisted');
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_RETENTION_COLLECTION)).toBe(0);
  });

  test('device: an in-window act with NO activation is retained, not dropped', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    const input = deviceInput(db, 'owner-retain-d', 'reg-retain-d', now);
    const result = await commitDeviceRegistration(input);
    expect(result.created).toBe(true);
    expect(result.genesisDisposition).toBe('retained');
    expect(result.marker.genesis_qualification_id).toBeNull();
    const id = genesisQualificationId('genesis_device_link', input.deviceId);
    expect(fake.store.has(`${GENESIS_QUALIFICATION_COLLECTION}/${id}`)).toBe(false);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(0);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_RETENTION_COLLECTION)).toBe(1);
    const retained = fake.store.get(`${GENESIS_QUALIFICATION_RETENTION_COLLECTION}/${id}`);
    expect(isRetainedGenesisQualification(retained)).toBe(true);
    expect(
      (retained as unknown as RetainedGenesisQualification)
        .qualification.qualifying_act_evidence.qualifying_act_at_ms,
    ).toBe(now);
  });

  test('device control: a valid activation persists to the OUTBOX and writes NO retention', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    const result = await commitDeviceRegistration(
      deviceInput(db, 'owner-persist-d', 'reg-persist-d', now),
    );
    expect(result.genesisDisposition).toBe('persisted');
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_RETENTION_COLLECTION)).toBe(0);
  });

  // The third disposition: an act that never qualified writes neither outbox nor retention.
  // This is the ONLY case that legitimately maps to `not_qualified` in the routes.
  test('human: a non-qualifying act (no genesisQualification) is not_qualified', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    const result = await commitHumanWalletRegistration({
      ...humanInput(db, 'user-nq', 'wallet-nq', now),
      genesisQualification: null,
    });
    expect(result.genesisDisposition).toBe('not_qualified');
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(0);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_RETENTION_COLLECTION)).toBe(0);
  });
});

/**
 * human wallet registration proves control of the address before it binds, so the real
 * key holder can never be locked out. Every RED control below failed on the pre- commit
 * (which bound any address with no proof and answered the key holder 409 address_in_use forever).
 */
describe(' address proof + displacement of an unproven registration', () => {
  const ADDRESS_LC = '0x1111111111111111111111111111111111111111';
  const walletDoc = (fake: ReturnType<typeof createFakeFirestore>, id: string) =>
    fake.store.get(`wallets/${id}`) as Record<string, unknown> | undefined;
  /** Rewind a committed registration to its pre- (unproven) shape. */
  const unprove = (fake: ReturnType<typeof createFakeFirestore>, id: string) => {
    const doc = { ...walletDoc(fake, id) };
    delete doc.address_proven_at_ms;
    fake.store.set(`wallets/${id}`, doc);
  };

  test('RED: a NEW registration without an address proof is refused and binds nothing (old: bound the address)', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    await expect(commitHumanWalletRegistration({
      ...humanInput(db, 'user-squatter', 'wallet-squat', now),
      addressProof: null,
    })).rejects.toMatchObject({ code: 'human_wallet_address_proof_required' });
    expect(countCollection(fake.store, 'wallets')).toBe(0);
    expect(countCollection(fake.store, 'native_wallet_address_index_v1')).toBe(0);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(0);
    // A proof signed by (or bound to) someone else is refused the same way.
    await expect(commitHumanWalletRegistration({
      ...humanInput(db, 'user-squatter', 'wallet-squat', now),
      addressProof: { ...humanInput(db, 'user-squatter', 'wallet-squat', now).addressProof, signer: '0x2222222222222222222222222222222222222222' },
    })).rejects.toMatchObject({ code: 'human_wallet_address_proof_invalid' });
    await expect(commitHumanWalletRegistration({
      ...humanInput(db, 'user-squatter', 'wallet-squat', now),
      addressProof: { ...humanInput(db, 'user-squatter', 'wallet-squat', now).addressProof, user_id: 'user-other' },
    })).rejects.toMatchObject({ code: 'human_wallet_address_proof_invalid' });
  });

  test('a proof-carrying registration stamps address_proven_at_ms and consumes its digest single-use', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    const input = humanInput(db, 'user-a', 'wallet-a', now);
    await commitHumanWalletRegistration(input);
    expect(walletDoc(fake, 'wallet-a')?.address_proven_at_ms).toBe(now);
    expect(fake.store.get(`human_wallet_address_proofs_v1/${input.addressProof.digest}`)).toMatchObject({ user_id: 'user-a', address: ADDRESS_LC, wallet_id: 'wallet-a' });
    // RED: the SAME proof cannot bind again (another account presenting the consumed digest).
    await expect(commitHumanWalletRegistration({
      ...humanInput(db, 'user-b', 'wallet-b', now + 1),
      addressProof: { ...input.addressProof, user_id: 'user-b' },
    })).rejects.toMatchObject({ code: 'human_wallet_address_proof_replayed' });
  });

  test('RED: the real key holder DISPLACES an unproven squat — index, watcher admission and users bind re-point; the address keeps ONE Genesis grant', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    // A pre- squat: another account registered the victim's address with no proof.
    await commitHumanWalletRegistration(humanInput(db, 'user-squatter', 'wallet-squat', now));
    unprove(fake, 'wallet-squat');
    await fake.collection('users').doc('user-squatter').set({ id: 'user-squatter', wallet_address: ADDRESS_LC });
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);

    const victim = await commitHumanWalletRegistration(humanInput(db, 'user-victim', 'wallet-victim', now + 1_000));
    expect(victim.created).toBe(true);
    expect(victim.displacement).toEqual({
      displacedWalletId: 'wallet-squat',
      displacedUserId: 'user-squatter',
      genesisAlreadyGrantedForAddress: true,
    });
    const index = [...fake.store.entries()].find(([k]) => k.startsWith('native_wallet_address_index_v1/'))?.[1];
    expect(index).toMatchObject({ wallet_id: 'wallet-victim', owner_id: 'user-victim', owner_type: 'human', address: ADDRESS_LC });
    expect(walletDoc(fake, 'wallet-squat')).toMatchObject({ displaced_at_ms: now + 1_000, displaced_by_user_id: 'user-victim', displaced_by_wallet_id: 'wallet-victim' });
    expect(walletDoc(fake, 'wallet-victim')?.address_proven_at_ms).toBe(now + 1_000);
    const admissions = [...fake.store.entries()].filter(([k]) => k.startsWith(`${WATCHER_ADDRESS_ADMISSION_COLLECTION}/`));
    expect(admissions).toHaveLength(1);
    expect(admissions[0][1]).toMatchObject({ wallet_id: 'wallet-victim', agent_id: 'user-victim', address: ADDRESS_LC });
    expect(fake.store.get('users/user-squatter')?.wallet_address).toBeNull();
    // Once per ADDRESS: the squat's grant already pays this address (the key holder); no second grant.
    expect(victim.marker.genesis_qualification_id).toBeNull();
    expect(victim.genesisDisposition).toBe('not_qualified');
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_RETENTION_COLLECTION)).toBe(0);

    // The victim's own replay is proof-free (existing registrations keep working)…
    const replay = await commitHumanWalletRegistration({ ...humanInput(db, 'user-victim', 'wallet-x', now + 2_000), addressProof: null });
    expect(replay.created).toBe(false);
    expect(replay.marker.wallet_id).toBe('wallet-victim');
    // …and the displaced squatter learns it was displaced.
    await expect(commitHumanWalletRegistration({ ...humanInput(db, 'user-squatter', 'wallet-y', now + 3_000), addressProof: null }))
      .rejects.toMatchObject({ code: 'human_wallet_registration_displaced' });
  });

  test('a squat that never qualified for Genesis leaves the address its one grant: the displacing key holder takes it', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    await commitHumanWalletRegistration({ ...humanInput(db, 'user-squatter', 'wallet-squat', now), genesisQualification: null });
    unprove(fake, 'wallet-squat');
    const victim = await commitHumanWalletRegistration(humanInput(db, 'user-victim', 'wallet-victim', now + 1));
    expect(victim.displacement?.genesisAlreadyGrantedForAddress).toBe(false);
    expect(victim.genesisDisposition).toBe('persisted');
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
  });

  test('RED: a PROVEN, live registration is never displaceable — a second proof holder gets address_in_use', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    await commitHumanWalletRegistration(humanInput(db, 'user-owner', 'wallet-owner', now));
    await fake.collection('users').doc('user-owner').set({ id: 'user-owner' });
    await expect(commitHumanWalletRegistration(humanInput(db, 'user-thief', 'wallet-thief', now + 1)))
      .rejects.toMatchObject({ code: 'human_wallet_address_in_use' });
    expect(walletDoc(fake, 'wallet-owner')?.displaced_at_ms).toBeUndefined();
    expect(countCollection(fake.store, 'wallets')).toBe(1);
  });

  // review defect 1: an address an agent or a person proved as an outside wallet
  // can never also become a Provian wallet (one address, one owner). The only variable
  // versus a fresh registration (which succeeds in the tests above) is the proven doc.
  for (const registry of ['proven_addresses', 'human_proven_addresses'] as const) {
    test(`RED: an address in ${registry} cannot be registered as a human wallet`, async () => {
      const fake = createFakeFirestore();
      const db = fake as unknown as Firestore;
      const now = Date.now();
      await arm(fake, now - 1);
      const address = '0x1111111111111111111111111111111111111111';
      await fake.collection(registry).doc(address).set({ address });
      await expect(commitHumanWalletRegistration(humanInput(db, 'user-a', 'wallet-a', now)))
        .rejects.toMatchObject({ code: 'human_wallet_address_in_use' });
      expect(countCollection(fake.store, 'wallets')).toBe(0);
    });
  }

  test('a registration RELEASED by its owner\'s data deletion (or orphaned) is displaceable by the key holder', async () => {
    for (const shape of ['released', 'orphaned'] as const) {
      const fake = createFakeFirestore();
      const db = fake as unknown as Firestore;
      const now = Date.now();
      await arm(fake, now - 1);
      await commitHumanWalletRegistration(humanInput(db, 'user-old', 'wallet-old', now));
      if (shape === 'released') {
        await fake.collection('users').doc('user-old').set({ id: 'user-old' });
        fake.store.set('wallets/wallet-old', { ...walletDoc(fake, 'wallet-old'), released_at_ms: now + 1 });
      }
      // orphaned: users/user-old never exists.
      const next = await commitHumanWalletRegistration(humanInput(db, 'user-new', 'wallet-new', now + 2));
      expect(next.displacement?.displacedWalletId).toBe('wallet-old');
      // The address already carried its one grant (wallet-old's) — none formed for the new wallet.
      expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
    }
  });

  test('the displacement rule is exact (pure)', () => {
    const base = {
      addressIndex: { owner_type: 'human', owner_id: 'u-old', wallet_id: 'w-old', address: ADDRESS_LC },
      wallet: { id: 'w-old', type: 'human', user_id: 'u-old', address: ADDRESS_LC },
      walletId: 'w-old',
      ownerUserExists: true,
      claimantUserId: 'u-new',
      address: ADDRESS_LC,
    };
    expect(humanRegistrationDisplaceable(base)).toBe(true);
    expect(humanRegistrationDisplaceable({ ...base, wallet: { ...base.wallet, address_proven_at_ms: 1 } })).toBe(false);
    expect(humanRegistrationDisplaceable({ ...base, wallet: { ...base.wallet, address_proven_at_ms: 1, released_at_ms: 2 } })).toBe(true);
    expect(humanRegistrationDisplaceable({ ...base, ownerUserExists: false, wallet: { ...base.wallet, address_proven_at_ms: 1 } })).toBe(true);
    expect(humanRegistrationDisplaceable({ ...base, claimantUserId: 'u-old' })).toBe(false);
    expect(humanRegistrationDisplaceable({ ...base, addressIndex: { ...base.addressIndex, owner_type: 'agent' } })).toBe(false);
    expect(humanRegistrationDisplaceable({ ...base, wallet: { ...base.wallet, displaced_at_ms: 1 } })).toBe(false);
    expect(humanRegistrationDisplaceable({ ...base, wallet: { ...base.wallet, address: '0x2222222222222222222222222222222222222222' } })).toBe(false);
  });
});

/**
 * review defects 1 + 2 — ONE human-signup grant per ADDRESS, whatever else shares the
 * address. Every Genesis leg (one `genesis_device_link` row per device, written even when denied)
 * carries the same `actor_address`; the first guard scanned `.where(actor_address).limit(10)` and
 * filtered action_type in memory, so ≥10 other rows hid the signup row and a second 75-PVT grant
 * formed. The marker (`genesis_human_signup_by_address_v1/<addr>`) is sealed with the grant; a
 * pre-marker grant is found by an unbounded action-type-filtered query, outbox AND retention.
 */
describe(' once-per-address human signup marker', () => {
  const ADDRESS_LC = '0x1111111111111111111111111111111111111111';
  const markerKey = `${GENESIS_HUMAN_SIGNUP_BY_ADDRESS_COLLECTION}/${ADDRESS_LC}`;
  const signupRows = (fake: ReturnType<typeof createFakeFirestore>) => [...fake.store.entries()]
    .filter(([k, v]) => (k.startsWith(`${GENESIS_QUALIFICATION_COLLECTION}/`)
      && (v as Record<string, unknown>).action_type === 'genesis_human_signup')
      || (k.startsWith(`${GENESIS_QUALIFICATION_RETENTION_COLLECTION}/`)
      && ((v as { qualification?: Record<string, unknown> }).qualification?.action_type === 'genesis_human_signup')));
  const unproveWallet = (fake: ReturnType<typeof createFakeFirestore>, id: string) => {
    const doc = { ...(fake.store.get(`wallets/${id}`) as Record<string, unknown>) };
    delete doc.address_proven_at_ms;
    fake.store.set(`wallets/${id}`, doc);
  };
  /** Ten device-link Genesis rows on the SAME address, ids sorting BEFORE any signup row. */
  const seedDeviceLinkRows = (fake: ReturnType<typeof createFakeFirestore>) => {
    for (let i = 0; i < 10; i += 1) {
      fake.store.set(`${GENESIS_QUALIFICATION_COLLECTION}/gq_0000${i}`, {
        qualification_id: `gq_0000${i}`,
        action_type: 'genesis_device_link',
        actor_address: ADDRESS_LC,
        status: 'denied',
      });
    }
  };

  test('a signup grant seals the address marker in the same transaction', async () => {
    const fake = createFakeFirestore();
    const now = Date.now();
    await arm(fake, now - 1);
    await commitHumanWalletRegistration(humanInput(fake as unknown as Firestore, 'user-a', 'wallet-a', now));
    expect(fake.store.get(markerKey)).toMatchObject({ address: ADDRESS_LC, wallet_id: 'wallet-a', source: 'sealed_outbox' });
  });

  test('RED: ten device-link rows on the address + displacement of a PRE-MARKER grant → exactly ONE signup grant (old: two)', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    seedDeviceLinkRows(fake); // written first, so an address-only bounded scan returns only these
    await commitHumanWalletRegistration(humanInput(db, 'user-squatter', 'wallet-squat', now));
    unproveWallet(fake, 'wallet-squat');
    fake.store.delete(markerKey); // a grant sealed before the marker existed
    const victim = await commitHumanWalletRegistration(humanInput(db, 'user-victim', 'wallet-victim', now + 1));
    expect(victim.displacement?.genesisAlreadyGrantedForAddress).toBe(true);
    expect(victim.genesisDisposition).toBe('not_qualified');
    expect(signupRows(fake)).toHaveLength(1);
    // The marker was materialized for the pre-marker grant.
    expect(fake.store.get(markerKey)).toMatchObject({ source: 'derived_from_outbox' });
  });

  test('RED: release → re-register with proof, repeatedly, never mints a second signup grant (with the marker)', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    await arm(fake, now - 1);
    seedDeviceLinkRows(fake);
    await commitHumanWalletRegistration(humanInput(db, 'user-1', 'wallet-1', now));
    for (let round = 2; round <= 4; round += 1) {
      const prev = `wallet-${round - 1}`;
      fake.store.set(`wallets/${prev}`, { ...(fake.store.get(`wallets/${prev}`) as Record<string, unknown>), released_at_ms: now + round });
      const next = await commitHumanWalletRegistration(humanInput(db, `user-${round}`, `wallet-${round}`, now + round * 10));
      expect(next.displacement?.displacedWalletId).toBe(prev);
      expect(next.genesisDisposition).toBe('not_qualified');
    }
    expect(signupRows(fake)).toHaveLength(1);
  });

  test('RED (retention leg): a displaced squat holding a RETAINED pre-marker grant → the key holder gets none, and the retention backfill leaves exactly ONE', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const now = Date.now();
    seedDeviceLinkRows(fake);
    // No activation yet: the squat's in-window grant is RETAINED, not in the outbox.
    const squat = await commitHumanWalletRegistration(humanInput(db, 'user-squatter', 'wallet-squat', now));
    expect(squat.genesisDisposition).toBe('retained');
    unproveWallet(fake, 'wallet-squat');
    fake.store.delete(markerKey); // pre-marker retained grant
    await arm(fake, now - 1);
    const victim = await commitHumanWalletRegistration(humanInput(db, 'user-victim', 'wallet-victim', now + 1));
    expect(victim.displacement?.genesisAlreadyGrantedForAddress).toBe(true);
    expect(victim.genesisDisposition).toBe('not_qualified');
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_RETENTION_COLLECTION)).toBe(1);
    expect(fake.store.get(markerKey)).toMatchObject({ source: 'derived_from_retention' });
    // Promote the retained grant: exactly one signup row lands in the outbox.
    const report = await backfillRetainedGenesisQualifications({ db, verifyGenesisActivationApproval: () => true });
    expect(report.promoted).toHaveLength(1);
    expect(signupRows(fake).filter(([k]) => k.startsWith(`${GENESIS_QUALIFICATION_COLLECTION}/`))).toHaveLength(1);
  });
});
