import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { peHashOf, type PeV2 } from '../core/meter/meter-wire';
import type { Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';

import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import {
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
} from '../core/pvt/__test-helpers__/armed-genesis-policy';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  GENESIS_QUALIFICATION_COLLECTION,
} from '../core/pvt/genesis-award-state-machine';
import { HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION } from '../core/pvt/genesis-ingress';
import { backfillRetainedGenesisQualifications } from '../core/pvt/genesis-retention-backfill';
import { hashGenesisCampaignPolicyManifest } from '../core/pvt/policy/genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../core/pvt/policy/proposed-genesis-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from '../core/pvt/policy/pvt9-approval-manifest.generated';
import { hashProposedMonetaryPolicyTemplate } from '../core/pvt/policy/runtime-monetary-policy';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION } from '../core/pvt/native-wallet-registration';
import {
  INBOUND_WATCHER_CHECKPOINT_COLLECTION,
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
} from '../core/pvt/watcher-address-admission';
import type { RecordPEAccrualParams } from '../pvt-accrual';
import { createHumanWalletRegistrationHandler } from './human-wallet-registration';
import { humanWalletReclaimPEId } from '../core/wallet-registration/human-wallet-displacement-pe';
import { relayIntakes } from '../core/pvt/__test-helpers__/meter-acts';
import { proofForAddress, signAddressProof, testSigner } from '../core/wallet-registration/__test-helpers__/address-proof';
import {
  HUMAN_WALLET_ADDRESS_PROOF_COLLECTION,
  humanWalletRegistrationDigest,
} from '../core/wallet-registration/human-wallet-address-proof';

// every NEW registration proves control of its address, so the fixture addresses are
// real keys' addresses (lowercased, as the relay stores them).
const SIGNER_1 = testSigner('11');
const SIGNER_A = testSigner('aa');
const SIGNER_B = testSigner('bb');
const ADDR_1 = SIGNER_1.address.toLowerCase();
const ADDR_A = SIGNER_A.address.toLowerCase();
const ADDR_B = SIGNER_B.address.toLowerCase();
const TEST_SIGNERS = [SIGNER_1, SIGNER_A, SIGNER_B];

const TEST_GENESIS_CAMPAIGN_POLICY = installArmedGenesisPolicyForTest();
afterAll(restoreCheckedInGenesisPolicyAfterTest);

function countCollection(store: Map<string, Record<string, unknown>>, collection: string): number {
  return [...store.keys()].filter((key) => key.startsWith(`${collection}/`)).length;
}

async function requestResponse(
  userId = 'human-registration-user',
  address = ADDR_1,
  options: { proof?: 'auto' | 'none'; nowMs?: number } = {},
) {
  const addressProof = options.proof === 'none'
    ? undefined
    : await proofForAddress(address, TEST_SIGNERS, {
      userId,
      deviceId: 'physical-auth-device-1',
      nowMs: options.nowMs ?? Date.now(),
    });
  const req = {
    user: { id: userId, device_id: 'physical-auth-device-1' },
    body: {
      publicKey: 'a'.repeat(128),
      address,
      ...(addressProof === undefined ? {} : { address_proof: addressProof }),
    },
  } as unknown as Request;
  const captured: { status: number; body?: Record<string, unknown> } = { status: 0 };
  const res = {
    status(status: number) {
      captured.status = status;
      return this;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return { req, res, captured };
}

function completeGenesisResult(qualificationId: string) {
  return {
    qualificationId,
    status: 'pending_activation' as const,
    reason: 'activation_missing',
    peId: null,
    reservedAtomic: '0',
  };
}

async function armGenesis(
  fake: ReturnType<typeof createFakeFirestore>,
): Promise<void> {
  await fake.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT)
    .set({
      approval_status: 'approved_by_frank',
      approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
      approval_signature: {
        scheme: 'sshsig-ed25519',
        signer_identity: 'frank',
        namespace: 'provian-pvt-policy',
        public_key_sha256: `sha256:${'a'.repeat(64)}`,
        armored_signature: 'test-only-structured-signature',
      },
      frank_approval_audit_id: 'human-route-test-approval',
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
      canonical_pvt_manifest_id: 'pvt9-human-route-test',
      ledger_namespace: 'pvt9-human-route-test-ledger',
      prior_reservations_reconciled: true,
      operator_activation_audit_id: 'human-route-test-operator',
    });
}

describe('human wallet registration recovery', () => {
  let consoleError: jest.SpiedFunction<typeof console.error>;
  let consoleWarn: jest.SpiedFunction<typeof console.warn>;

  afterEach(() => {
    consoleError?.mockRestore();
    consoleWarn?.mockRestore();
  });

  test('a malformed wallet address fails before the Base-head read or any write', async () => {
    const fake = createFakeFirestore();
    const readBaseRegistrationHead = jest.fn(async () => 130);
    const handler = createHumanWalletRegistrationHandler({
      db: fake as unknown as Firestore,
      peBuffer: { enqueue: jest.fn() },
      recordPEAccrual: jest.fn(async () => {}),
      processGenesisQualification: jest.fn(async (qualificationId: string) =>
        completeGenesisResult(qualificationId)),
      readBaseRegistrationHead,
    });
    const request = await requestResponse('human-malformed-address', 'not-an-address');

    await handler(request.req, request.res, () => {});
    expect(request.captured).toMatchObject({
      status: 400,
      body: { error: 'address must be a canonical EVM address' },
    });
    expect(readBaseRegistrationHead).not.toHaveBeenCalled();
    expect(fake.store.size).toBe(0);
  });

  test('a retry after standard-accrual failure resumes one original wallet/PE/outbox marker', async () => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const fixedNow = Date.now();
    await armGenesis(fake);
    const enqueued: Array<{ id: string; doc: Record<string, unknown> }> = [];
    const accruals: RecordPEAccrualParams[] = [];
    let failAccrual = true;
    let id = 0;
    const processGenesis = jest.fn(async (qualificationId: string) =>
      completeGenesisResult(qualificationId));
    const readBaseRegistrationHead = jest.fn(async () => 130);
    const handler = createHumanWalletRegistrationHandler({
      db,
      peBuffer: {
        enqueue: (docId: string, doc: object) => {
          enqueued.push({ id: docId, doc: doc as Record<string, unknown> });
        },
      },
      recordPEAccrual: async (params) => {
        accruals.push(params);
        if (failAccrual) {
          failAccrual = false;
          throw new Error('injected-after-registration-commit');
        }
      },
      processGenesisQualification: processGenesis,
      readBaseRegistrationHead,
      genesisActivationApprovalVerifier: () => true,
      now: () => fixedNow,
      makeId: () => `deterministic-${++id}`,
    });

    const first = await requestResponse();
    await handler(first.req, first.res, () => {});
    expect(first.captured.status).toBe(503);
    expect(first.captured.body).toMatchObject({
      error: 'human_wallet_registration_accrual_pending',
      retryWithSameWalletIdentity: true,
    });
    const originalWalletId = first.captured.body?.walletId;
    const originalPeId = first.captured.body?.firstEnvelopeId;
    expect(typeof originalWalletId).toBe('string');
    expect(typeof originalPeId).toBe('string');

    const retry = await requestResponse();
    await handler(retry.req, retry.res, () => {});
    expect(retry.captured.status).toBe(200);
    expect(retry.captured.body).toMatchObject({
      walletId: originalWalletId,
      firstEnvelopeId: originalPeId,
      idempotentReplay: true,
      standardAccrualAcknowledged: true,
    });

    expect(countCollection(fake.store, 'wallets')).toBe(1);
    // PE METER: no readable PE is stored; the act is staged once (the stub accrual seals nothing,
    // so it stays staged) and the owner receives the PE itself in the response.
    expect(countCollection(fake.store, 'provenance_envelopes')).toBe(0);
    expect(countCollection(fake.store, 'meter_relay_acts_v1')).toBe(1);
    expect(countCollection(fake.store, 'pe_chain_tips')).toBe(1);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
    expect(countCollection(fake.store, HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION)).toBe(1);
    expect(countCollection(fake.store, NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)).toBe(1);
    expect(countCollection(fake.store, WATCHER_ADDRESS_ADMISSION_COLLECTION)).toBe(1);
    expect(fake.store.get(`wallets/${String(originalWalletId)}`)).toMatchObject({
      native_watcher_registration: {
        schema_version: 'native-wallet-base-registration/v1',
        chain_id: 8453,
        observed_head_block: 130,
        eligibility_start_block: 131,
      },
    });
    expect([...fake.store.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        schema_version: 'pvt-watcher-address-admission/v3',
        direction: 'inbound',
        address: ADDR_1,
        wallet_id: originalWalletId,
        agent_id: 'human-registration-user',
        eligibility_start_block: 131,
        backfill_next_block: 131,
        catch_up_through_block: 130,
        state: 'live',
        membership_generation: 1,
        generation_fenced_at_registration: true,
      }),
    ]));
    expect(fake.store.get(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`)).toMatchObject({
      membership_generation: 1,
    });
    expect(enqueued).toHaveLength(0);
    const firstEnvelope = retry.captured.body?.firstEnvelope as Record<string, unknown> | undefined;
    expect(firstEnvelope).toMatchObject({ pe_id: originalPeId, action_type: 'wallet_created' });
    expect(peHashOf(firstEnvelope as unknown as PeV2)).toBe(accruals[0].peHash);
    expect(accruals).toHaveLength(2);
    expect(accruals[0]).toMatchObject({
      peId: originalPeId,
      deviceId: 'physical-auth-device-1',
      throwOnError: true,
      ownerType: 'human',
      attestationDepth: 'software',
    });
    expect(accruals[1]).toMatchObject({
      peId: originalPeId,
      peHash: accruals[0].peHash,
      timestamp: accruals[0].timestamp,
      deviceId: accruals[0].deviceId,
    });
    expect(processGenesis).toHaveBeenCalledTimes(1);
    expect(readBaseRegistrationHead).toHaveBeenCalledTimes(1);

    const marker = [...fake.store.entries()].find(([key]) =>
      key.startsWith(`${HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION}/`))?.[1];
    expect(marker).toMatchObject({
      wallet_id: originalWalletId,
      pe_id: originalPeId,
      standard_accrual_status: 'complete',
      economic_device_id: 'physical-auth-device-1',
    });
  });

  test('a Genesis-processing crash returns the same marker and retry does not repeat completed accrual', async () => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = createFakeFirestore();
    const fixedNow = Date.now();
    await armGenesis(fake);
    const accrual = jest.fn(async (_params: RecordPEAccrualParams) => undefined);
    let failGenesis = true;
    const processGenesis = jest.fn(async (qualificationId: string) => {
      if (failGenesis) {
        failGenesis = false;
        throw new Error('injected-genesis-resume-crash');
      }
      return completeGenesisResult(qualificationId);
    });
    let id = 0;
    const handler = createHumanWalletRegistrationHandler({
      db: fake as unknown as Firestore,
      peBuffer: { enqueue: () => undefined },
      recordPEAccrual: accrual,
      processGenesisQualification: processGenesis,
      readBaseRegistrationHead: async () => 130,
      genesisActivationApprovalVerifier: () => true,
      now: () => fixedNow,
      makeId: () => `genesis-retry-${++id}`,
    });

    const first = await requestResponse('human-genesis-retry');
    await handler(first.req, first.res, () => {});
    expect(first.captured.status).toBe(503);
    expect(first.captured.body).toMatchObject({
      error: 'human_wallet_genesis_qualification_pending',
      standardAccrualAcknowledged: true,
    });

    const retry = await requestResponse('human-genesis-retry');
    await handler(retry.req, retry.res, () => {});
    expect(retry.captured.status).toBe(200);
    expect(retry.captured.body?.firstEnvelopeId).toBe(first.captured.body?.firstEnvelopeId);
    expect(accrual).toHaveBeenCalledTimes(1);
    expect(processGenesis).toHaveBeenCalledTimes(2);
    expect(countCollection(fake.store, 'wallets')).toBe(1);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
  });

  test('a successful response replay always returns the original firstEnvelopeId', async () => {
    const fake = createFakeFirestore();
    const fixedNow = Date.now();
    let id = 0;
    const handler = createHumanWalletRegistrationHandler({
      db: fake as unknown as Firestore,
      peBuffer: { enqueue: () => undefined },
      recordPEAccrual: async () => undefined,
      processGenesisQualification: async (qualificationId) =>
        completeGenesisResult(qualificationId),
      readBaseRegistrationHead: async () => 130,
      now: () => fixedNow,
      makeId: () => `response-replay-${++id}`,
    });

    const first = await requestResponse('human-response-replay');
    await handler(first.req, first.res, () => {});
    const replay = await requestResponse('human-response-replay');
    await handler(replay.req, replay.res, () => {});

    expect(first.captured.status).toBe(201);
    expect(replay.captured.status).toBe(200);
    expect(first.captured.body?.firstEnvelopeId).toEqual(expect.any(String));
    expect(replay.captured.body?.firstEnvelopeId).toBe(first.captured.body?.firstEnvelopeId);
    expect(replay.captured.body?.firstEnvelopeId).not.toBeNull();
    expect(fake.store.get(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`)).toMatchObject({
      membership_generation: 1,
    });
  });

  test('two-operator birth-head failure creates no human wallet, PE, admission, or generation change', async () => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeFirestore();
    const handler = createHumanWalletRegistrationHandler({
      db: fake as unknown as Firestore,
      peBuffer: { enqueue: () => undefined },
      recordPEAccrual: async () => undefined,
      processGenesisQualification: async (qualificationId) =>
        completeGenesisResult(qualificationId),
      readBaseRegistrationHead: async () => {
        throw new Error('economic_discovery_rpc_disagreement:head');
      },
      now: () => Date.now(),
      makeId: () => 'uncommitted',
    });
    const attempt = await requestResponse('human-head-failure');
    await handler(attempt.req, attempt.res, () => {});

    expect(attempt.captured.status).toBe(503);
    expect(attempt.captured.body).toEqual({
      error: 'human_wallet_registration_fence_unavailable',
    });
    expect(countCollection(fake.store, 'wallets')).toBe(0);
    expect(countCollection(fake.store, 'provenance_envelopes')).toBe(0);
    expect(countCollection(fake.store, WATCHER_ADDRESS_ADMISSION_COLLECTION)).toBe(0);
    expect(countCollection(fake.store, INBOUND_WATCHER_CHECKPOINT_COLLECTION)).toBe(0);
  });

  test('concurrent registrations preserve monotonic generation increments and independent catch-up obligations', async () => {
    const fake = createFakeFirestore();
    fake.store.set(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
      chain_id: 8453,
      last_processed_block: 200,
      membership_generation: 5,
      updated_at: 1,
    });
    let id = 0;
    const handler = createHumanWalletRegistrationHandler({
      db: fake as unknown as Firestore,
      peBuffer: { enqueue: () => undefined },
      recordPEAccrual: async () => undefined,
      processGenesisQualification: async (qualificationId) =>
        completeGenesisResult(qualificationId),
      readBaseRegistrationHead: async () => 140,
      now: () => Date.now(),
      makeId: () => `concurrent-human-${++id}`,
    });
    const first = await requestResponse(
      'concurrent-human-a',
      ADDR_A,
    );
    const second = await requestResponse(
      'concurrent-human-b',
      ADDR_B,
    );

    await Promise.all([
      handler(first.req, first.res, () => undefined),
      handler(second.req, second.res, () => undefined),
    ]);

    expect(first.captured.status).toBe(201);
    expect(second.captured.status).toBe(201);
    expect(fake.store.get(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`)).toMatchObject({
      last_processed_block: 200,
      membership_generation: 7,
    });
    const admissions = [...fake.store.entries()]
      .filter(([key]) => key.startsWith(`${WATCHER_ADDRESS_ADMISSION_COLLECTION}/`))
      .map(([, value]) => value);
    expect(admissions).toHaveLength(2);
    expect(admissions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        address: ADDR_A,
        state: 'backfilling',
        backfill_next_block: 141,
        catch_up_through_block: 200,
        generation_fenced_at_registration: true,
      }),
      expect.objectContaining({
        address: ADDR_B,
        state: 'backfilling',
        backfill_next_block: 141,
        catch_up_through_block: 200,
        generation_fenced_at_registration: true,
      }),
    ]));
    expect(new Set(admissions.map((row) => row.membership_generation))).toEqual(new Set([6, 7]));
  });

  test('H3: a refused in-window signup reports retained_pending_activation, not not_qualified', async () => {
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    // No armGenesis(): the activation doc is absent, so the persist gate refuses.
    const processGenesis = jest.fn(async (qualificationId: string) =>
      completeGenesisResult(qualificationId));
    const handler = createHumanWalletRegistrationHandler({
      db,
      peBuffer: { enqueue: jest.fn() },
      recordPEAccrual: jest.fn(async () => {}),
      processGenesisQualification: processGenesis,
      readBaseRegistrationHead: jest.fn(async () => 130),
      genesisActivationApprovalVerifier: () => true,
    });
    const request = await requestResponse('user-h3-retained');
    await handler(request.req, request.res, () => {});

    // Wallet still created (product action succeeds)...
    expect(request.captured.status).toBe(201);
    // ...but the grant is honestly reported as retained, NOT silently not_qualified.
    expect(request.captured.body?.genesisQualificationStatus).toBe('retained_pending_activation');
    expect(request.captured.body?.genesisQualificationStatus).not.toBe('not_qualified');
    // Retained, not processed: the grant was not settled.
    expect(processGenesis).not.toHaveBeenCalled();
    // Fail-closed: nothing in the mint-readable outbox.
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(0);
  });

  test('H3: a backfill-promoted grant reports queued on replay, never not_qualified', async () => {
    // Reviewer defect 1: after a retained grant is promoted by the H2 backfill, the
    // registration marker still carries a null qualification id (the backfill cannot
    // touch it), so an idempotent replay must map disposition 'persisted' directly to
    // an honest status — NOT fall through to the dishonest 'not_qualified'.
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const handler = createHumanWalletRegistrationHandler({
      db,
      peBuffer: { enqueue: jest.fn() },
      recordPEAccrual: jest.fn(async () => {}),
      processGenesisQualification: jest.fn(async (qualificationId: string) =>
        completeGenesisResult(qualificationId)),
      readBaseRegistrationHead: jest.fn(async () => 130),
      genesisActivationApprovalVerifier: () => true,
    });

    // 1. Register while the activation is absent → retained.
    const first = await requestResponse();
    await handler(first.req, first.res, () => {});
    expect(first.captured.status).toBe(201);
    expect(first.captured.body?.genesisQualificationStatus).toBe('retained_pending_activation');

    // 2. Arm the activation and run the H2 backfill → the retained grant is promoted.
    await armGenesis(fake);
    const report = await backfillRetainedGenesisQualifications(
      { db, verifyGenesisActivationApproval: () => true },
    );
    expect(report.promoted).toHaveLength(1);
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);

    // 3. Idempotent replay → honest 'queued' (persisted, pending settlement), never 'not_qualified'.
    const replay = await requestResponse();
    await handler(replay.req, replay.res, () => {});
    expect(replay.captured.status).toBe(200);
    expect(replay.captured.body?.idempotentReplay).toBe(true);
    expect(replay.captured.body?.genesisQualificationStatus).toBe('queued');
    expect(replay.captured.body?.genesisQualificationStatus).not.toBe('not_qualified');
  });

});

/**
 * POST /v1/wallet/human/register proves control of the address before it binds.
 * RED controls: each failed on the pre- route (which bound ANY regex-valid address, with
 * no signature, and answered the real key holder 409 human_wallet_address_in_use forever).
 */
describe(' human wallet registration address proof', () => {
  let consoleError: jest.SpiedFunction<typeof console.error>;
  let consoleWarn: jest.SpiedFunction<typeof console.warn>;
  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  function makeHandler(fake: ReturnType<typeof createFakeFirestore>, prefix: string) {
    let id = 0;
    return createHumanWalletRegistrationHandler({
      db: fake as unknown as Firestore,
      peBuffer: { enqueue: () => undefined },
      recordPEAccrual: async () => undefined,
      processGenesisQualification: async (qualificationId) => completeGenesisResult(qualificationId),
      readBaseRegistrationHead: async () => 130,
      genesisActivationApprovalVerifier: () => true,
      now: () => Date.now(),
      makeId: () => `${prefix}-${++id}`,
    });
  }
  const humanWallets = (fake: ReturnType<typeof createFakeFirestore>) => [...fake.store.entries()]
    .filter(([k, v]) => k.startsWith('wallets/') && (v as Record<string, unknown>).type === 'human');

  test('RED: a squat WITHOUT proof is refused 428 and binds nothing (old: bound the victim\'s address)', async () => {
    const fake = createFakeFirestore();
    const handler = makeHandler(fake, 'squat');
    const squat = await requestResponse('user-squatter', ADDR_1, { proof: 'none' });
    await handler(squat.req, squat.res, () => {});
    expect(squat.captured).toEqual({ status: 428, body: { error: 'address_proof_required' } });
    expect(fake.store.size).toBe(0);
  });

  test('RED: a forged proof (another key), a stale proof and a reused proof are refused', async () => {
    const fake = createFakeFirestore();
    const handler = makeHandler(fake, 'forged');
    // Another key signs for ADDR_1.
    const forged = await requestResponse('user-forger', ADDR_1, { proof: 'none' });
    (forged.req.body as Record<string, unknown>).address_proof = await signAddressProof(SIGNER_A, {
      userId: 'user-forger', deviceId: 'physical-auth-device-1', nowMs: Date.now(), address: ADDR_1,
    });
    await handler(forged.req, forged.res, () => {});
    expect(forged.captured).toEqual({ status: 403, body: { error: 'address_proof_invalid', reason: 'address_proof_signer_mismatch' } });
    // The real key, but signed 10 minutes ago.
    const stale = await requestResponse('user-owner', ADDR_1, { nowMs: Date.now() - 10 * 60_000 });
    await handler(stale.req, stale.res, () => {});
    expect(stale.captured).toEqual({ status: 400, body: { error: 'address_proof_invalid', reason: 'address_proof_stale' } });
    // A proof whose digest was already consumed.
    const reused = await requestResponse('user-owner', ADDR_1);
    const { timestamp } = (reused.req.body as { address_proof: { timestamp: number } }).address_proof;
    fake.store.set(`${HUMAN_WALLET_ADDRESS_PROOF_COLLECTION}/${humanWalletRegistrationDigest({
      user_id: 'user-owner', address: ADDR_1, device_id: 'physical-auth-device-1', timestamp,
    })}`, { consumed: true });
    await handler(reused.req, reused.res, () => {});
    expect(reused.captured).toEqual({ status: 409, body: { error: 'human_wallet_address_proof_replayed' } });
    expect(humanWallets(fake)).toHaveLength(0);
  });

  test('the key holder registers with proof; the replay of that EXISTING registration needs no proof', async () => {
    const fake = createFakeFirestore();
    const handler = makeHandler(fake, 'owner');
    const first = await requestResponse('user-owner', ADDR_1);
    await handler(first.req, first.res, () => {});
    expect(first.captured.status).toBe(201);
    expect(humanWallets(fake)[0][1]).toMatchObject({ address: ADDR_1, address_proven_at_ms: expect.any(Number) });
    const replay = await requestResponse('user-owner', ADDR_1, { proof: 'none' });
    await handler(replay.req, replay.res, () => {});
    expect(replay.captured.status).toBe(200);
    expect(replay.captured.body).toMatchObject({ walletId: first.captured.body?.walletId, idempotentReplay: true, addressReclaimed: false });
  });

  test('RED: the real key holder DISPLACES an unproven squat (old: 409 address_in_use forever) and the reclaim is sealed record_only', async () => {
    const fake = createFakeFirestore();
    await armGenesis(fake);
    const handler = makeHandler(fake, 'reclaim');
    // A pre- squat on ADDR_1 (registered, then rewound to the unproven legacy shape).
    const squat = await requestResponse('user-squatter', ADDR_1);
    await handler(squat.req, squat.res, () => {});
    expect(squat.captured.status).toBe(201);
    const squatWalletId = String(squat.captured.body?.walletId);
    const squatDoc = { ...fake.store.get(`wallets/${squatWalletId}`) };
    delete squatDoc.address_proven_at_ms;
    fake.store.set(`wallets/${squatWalletId}`, squatDoc);
    await fake.collection('users').doc('user-squatter').set({ id: 'user-squatter', wallet_address: ADDR_1 });

    const victim = await requestResponse('user-victim', ADDR_1);
    await handler(victim.req, victim.res, () => {});
    expect(victim.captured.status).toBe(201);
    expect(victim.captured.body).toMatchObject({ addressReclaimed: true, genesisQualificationStatus: 'not_qualified' });
    const victimWalletId = String(victim.captured.body?.walletId);
    expect(fake.store.get(`wallets/${squatWalletId}`)).toMatchObject({ displaced_by_user_id: 'user-victim', displaced_by_wallet_id: victimWalletId });
    // One Genesis human-signup grant for the address — the squat's, which pays ADDR_1 (the key holder).
    expect(countCollection(fake.store, GENESIS_QUALIFICATION_COLLECTION)).toBe(1);
    // PE METER: the relay keeps no readable PE. The receipt is staged in the displacer's chain-tip
    // transaction as a relay-act intake (the stub accrual never prices it), under its deterministic
    // id — exactly one, in the victim's chain, carrying the receipt's pricing projection.
    const receipts = relayIntakes(fake.store).filter((i) => i.act.action_type === 'recovery_action'
      && (i.act.pricing.metadata as Record<string, unknown> | undefined)?.recovery_kind === 'human_wallet_address_reclaimed');
    expect(receipts).toHaveLength(1);
    const [receipt] = receipts;
    expect(receipt.pe_id).toBe(humanWalletReclaimPEId(victimWalletId));
    expect(receipt.actor_id).toBe('user-victim');
    expect(receipt.act.pricing).toMatchObject({ metadata: { displaced_wallet_id: squatWalletId, address: ADDR_1, mints: 'nothing_record_only' } });
    // The displaced squatter's replay is told so.
    const squatReplay = await requestResponse('user-squatter', ADDR_1, { proof: 'none' });
    await handler(squatReplay.req, squatReplay.res, () => {});
    expect(squatReplay.captured).toEqual({ status: 409, body: { error: 'human_wallet_registration_displaced' } });
  });

  test('RED: a PROVEN registration cannot be displaced, even by a valid proof from another account', async () => {
    const fake = createFakeFirestore();
    const handler = makeHandler(fake, 'proven');
    const owner = await requestResponse('user-owner', ADDR_1);
    await handler(owner.req, owner.res, () => {});
    await fake.collection('users').doc('user-owner').set({ id: 'user-owner' });
    const other = await requestResponse('user-second-account', ADDR_1);
    await handler(other.req, other.res, () => {});
    expect(other.captured).toEqual({ status: 409, body: { error: 'human_wallet_address_in_use' } });
    expect(humanWallets(fake)).toHaveLength(1);
  });
});
