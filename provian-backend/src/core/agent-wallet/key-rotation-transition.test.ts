import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ethers } from 'ethers';
import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';

type RegistrationContext = {
  registration_id: string;
  agent_id: string;
  credential_recovery_generation: number | null;
};
type PopResult =
  | { ok: true; registration_context: RegistrationContext }
  | { ok: false; reason: string };
const verifyPop = jest.fn<(
  challengeId: string,
  expected: Pick<RegistrationContext, 'registration_id' | 'agent_id'>,
) => Promise<PopResult>>(async (challengeId, expected) => ({
  ok: true,
  registration_context: {
    ...expected,
    credential_recovery_generation: challengeId === 'challenge-1' ? null : 0,
  },
}));
const verifyClaimsPop = jest.fn(async () => ({ ok: true as const, claims: {} }));
jest.mock('./proof-of-possession', () => ({
  ...(jest.requireActual('./proof-of-possession') as object),
  verifyAndConsumePopChallenge: (
    _cache: unknown,
    challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: Pick<RegistrationContext, 'registration_id' | 'agent_id'>,
  ) => verifyPop(challengeId, expected),
  verifyAndConsumeClaimsPopChallenge: () => verifyClaimsPop(),
}));

import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  INBOUND_WATCHER_CHECKPOINT_COLLECTION,
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
} from '../pvt/watcher-address-admission';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from '../pvt/native-wallet-registration';
import { generateApiCredentialsAsync } from './api-key';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../pvt/policy/proposed-genesis-policy';
import type { RouterDeps } from './types';
import type { AgentBankDeps } from '../agent-bank/types';
import { createAgentWalletRouter } from '../../routes/agent-wallet';
import {
  IDENTITY_ACTS_COLLECTION,
  peOfIdentityAct,
  validateIdentityAct,
  type IdentityActDoc,
} from '../meter/identity-acts';
import { peHashOf } from '../meter/meter-wire';
import {
  AGENT_DIRECTORY_COLLECTION,
  AGENT_KEY_ROTATED_ACTION_TYPE,
  AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
  KeyRotationTransitionError,
  ROTATION_HISTORY_SUBCOLLECTION,
  executeKeyRotationTransition,
  prepareKeyRotationTransition,
  rotationHistoryId,
  rotationPeId,
} from './key-rotation-transition';

const OLD_ADDRESS = '0x2222222222222222222222222222222222222222';
// Rotation clock: comfortably after the registration's real-time checkpoint
// (Date.now()), so the watcher time-monotonicity guard is satisfied.
const NOW = 10_000_000_000_000;
// Deterministic NEW identity: a fixed private key -> address + uncompressed key.
const NEW_SIGNER = new ethers.Wallet(`0x${'11'.repeat(32)}`);
const NEW_ADDRESS = NEW_SIGNER.address.toLowerCase();
const NEW_PUBLIC_KEY = NEW_SIGNER.signingKey.publicKey.slice(4); // strip 0x04

type Fake = ReturnType<typeof createFakeFirestore>;

function buildRoute(
  fakeOptions?: Parameters<typeof createFakeFirestore>[0],
  // Recovery of a ROTATED wallet presents the ROTATED key: map each request's
  // public key to its address so the create + recovery flows derive the right
  // one. Defaults to the birth stub used by every non-recovery test.
  deriveAddress: (publicKey: string) => string = () => OLD_ADDRESS,
) {
  const fake = createFakeFirestore(fakeOptions);
  fake.store.set(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
    chain_id: 8453,
    last_processed_block: 130,
    membership_generation: 7,
    updated_at: 1,
  });
  const recordPEAccrual = jest.fn(async () => undefined);
  const deps = {
    db: fake as unknown as Firestore,
    cache: {
      isEnabled: () => true,
      checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
    },
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual,
    keccak256: (input: Buffer) => input,
    deriveAddressFromPublicKey: (publicKey: string) => deriveAddress(publicKey),
    readBaseRegistrationHead: async () => 140,
    generateRecoveryApiCredentials: jest.fn(generateApiCredentialsAsync),
  } as unknown as RouterDeps;
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  return { app, fake, recordPEAccrual };
}

function bankDeps(fake: Fake) {
  const recordPEAccrual = jest.fn(async () => undefined);
  const enqueue = jest.fn();
  const deps = {
    db: fake as unknown as Firestore,
    cache: {
      isEnabled: () => true,
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
    },
    peBuffer: { enqueue },
    recordPEAccrual,
  } as unknown as AgentBankDeps;
  return { deps, recordPEAccrual, enqueue };
}

async function createWallet(app: express.Express): Promise<string> {
  const response = await request(app)
    .post('/v1/agent/wallet/create')
    .send({
      registration_id: 'agent-registration-canonical-agent-0001',
      agent_name: 'Canonical Agent',
      agent_id: 'canonical-agent',
      platform: 'sdk',
      constitution_accepted_at: '2026-07-12T00:00:00.000Z',
      public_key: 'a'.repeat(128),
      challenge_id: 'challenge-1',
      signature: 'ab'.repeat(64),
    });
  expect(response.status).toBe(201);
  expect(response.body.address).toBe(OLD_ADDRESS);
  return response.body.wallet_id as string;
}

async function newIdentity() {
  return {
    newAddress: NEW_ADDRESS,
    newPublicKey: NEW_PUBLIC_KEY,
    newApiCredentials: await generateApiCredentialsAsync(),
  };
}

async function planFor(fake: Fake, walletId: string, overrides: {
  rotationId?: string;
  now?: number;
  identity?: Awaited<ReturnType<typeof newIdentity>>;
  readBaseHead?: () => Promise<number>;
} = {}) {
  return prepareKeyRotationTransition({
    db: fake as unknown as Firestore,
    walletId,
    newIdentity: overrides.identity ?? (await newIdentity()),
    rotationId: overrides.rotationId ?? 'rotation-0001',
    now: overrides.now ?? NOW,
    readBaseHead: overrides.readBaseHead ?? (async () => 500),
  });
}

describe('agent wallet key-rotation transition (beneficiary routing machinery)', () => {
  beforeEach(() => {
    verifyPop.mockClear();
    verifyClaimsPop.mockClear();
  });

  test('atomically moves the full identity to the new address and seals a record_only PE', async () => {
    const { app, fake } = buildRoute();
    const walletId = await createWallet(app);
    const oldPrefix = (fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>)
      .api_key_prefix as string;
    const tipBefore = fake.store.get('pe_chain_tips/canonical-agent') as Record<string, unknown>;
    const genBefore = (fake.store.get(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`) as Record<string, unknown>)
      .membership_generation as number;

    const { deps, recordPEAccrual } = bankDeps(fake);
    const plan = await planFor(fake, walletId);
    const result = await executeKeyRotationTransition(deps, plan);

    // Wallet identity cut.
    const wallet = fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>;
    expect(wallet.address).toBe(NEW_ADDRESS);
    expect(wallet.public_key).toBe(NEW_PUBLIC_KEY);
    expect(wallet.api_key_prefix).toBe(plan.newIdentity.newApiCredentials.api_key_prefix);
    expect(wallet.rotation_count).toBe(1);
    expect(wallet.last_rotated_at).toBe(NOW);
    // Fresh H+1 fence (head 500 -> eligibility 501), distinct from birth (140/141).
    expect(wallet.native_watcher_registration).toEqual({
      schema_version: 'native-wallet-base-registration/v1',
      chain_id: 8453,
      observed_head_block: 500,
      eligibility_start_block: 501,
    });

    // Trust-graph mirror.
    const trust = fake.store.get(`wallets/${walletId}`) as Record<string, unknown>;
    expect(trust.address).toBe(NEW_ADDRESS);
    expect(trust.public_key).toBe(NEW_PUBLIC_KEY);

    // Native address index: NEW present, OLD gone, retirement tombstone written.
    expect(fake.store.has(
      `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(NEW_ADDRESS)}`,
    )).toBe(true);
    expect(fake.store.has(
      `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(OLD_ADDRESS)}`,
    )).toBe(false);
    expect(fake.store.get(`${AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${OLD_ADDRESS}`))
      .toMatchObject({ address: OLD_ADDRESS, new_address: NEW_ADDRESS, wallet_id: walletId });

    // Agent registration index re-pointed to the NEW live address/prefix.
    const agentIdx = [...fake.store.entries()]
      .find(([k]) => k.startsWith(`${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/`))![1];
    expect(agentIdx.address).toBe(NEW_ADDRESS);
    expect(agentIdx.api_key_prefix).toBe(plan.newIdentity.newApiCredentials.api_key_prefix);

    // API prefix swap.
    expect(fake.store.has(`api_key_index/${plan.newIdentity.newApiCredentials.api_key_prefix}`))
      .toBe(true);
    expect(fake.store.has(`api_key_index/${oldPrefix}`)).toBe(false);

    // Watcher admission: NEW fenced admission (membership bumped 7 -> 8), OLD retired.
    const admissions = [...fake.store.entries()]
      .filter(([k]) => k.startsWith(`${WATCHER_ADDRESS_ADMISSION_COLLECTION}/`))
      .map(([, v]) => v);
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({
      schema_version: 'pvt-watcher-address-admission/v3',
      generation_fenced_at_registration: true,
      address: NEW_ADDRESS,
      eligibility_start_block: 501,
    });
    const checkpoint = fake.store.get(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`) as Record<string, unknown>;
    expect(checkpoint.membership_generation).toBe(genBefore + 1);
    expect(admissions[0]).toMatchObject({ membership_generation: genBefore + 1 });

    // rotation_history entry with a NON-NULL pe_id (sealed in the same txn).
    const historyKey = `agent_wallets/${walletId}/${ROTATION_HISTORY_SUBCOLLECTION}/${rotationHistoryId(result.rotationPeId)}`;
    expect(fake.store.get(historyKey)).toMatchObject({
      old_address: OLD_ADDRESS,
      new_address: NEW_ADDRESS,
      rotation_count: 1,
      pe_id: result.rotationPeId,
    });
    expect((fake.store.get(historyKey) as Record<string, unknown>).pe_id).not.toBeNull();

    // agent_key_rotated PE sealed + chain tip advanced (append-only). PE METER: the relay keeps
    // the rotation PE as an IDENTITY ACT (it is what rotation_history pins), never an envelope.
    expect(fake.store.has(`provenance_envelopes/${result.rotationPeId}`)).toBe(false);
    const actDoc = fake.store.get(`${IDENTITY_ACTS_COLLECTION}/${result.rotationPeId}`);
    expect(actDoc).toBeDefined();
    const pe = validateIdentityAct({
      raw: actDoc,
      peId: result.rotationPeId,
      peHash: (fake.store.get(historyKey) as Record<string, unknown>).pe_hash as string,
      actorId: 'canonical-agent',
      walletId,
    });
    expect(pe.action_type).toBe(AGENT_KEY_ROTATED_ACTION_TYPE);
    expect(pe.actor_address).toBe(NEW_ADDRESS);
    expect(pe.prev_hash).toBe(tipBefore.hash);
    expect(pe.metadata).toMatchObject({ old_address: OLD_ADDRESS, new_address: NEW_ADDRESS, rotation_count: 1 });
    const tipAfter = fake.store.get('pe_chain_tips/canonical-agent') as Record<string, unknown>;
    expect(tipAfter.hash).toBe(pe.hash);
    expect(tipAfter.hash).not.toBe(tipBefore.hash);

    // record_only accrual: dispatched under agent_key_rotated (mints 0).
    expect(recordPEAccrual).toHaveBeenCalledTimes(1);
    expect(recordPEAccrual).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: AGENT_KEY_ROTATED_ACTION_TYPE }),
    );
  });

  test('deterministic PE id is bound to the specific old->new cut', async () => {
    const { app, fake } = buildRoute();
    const walletId = await createWallet(app);
    const plan = await planFor(fake, walletId);
    expect(plan.rotationPeId).toBe(rotationPeId('canonical-agent', OLD_ADDRESS, NEW_ADDRESS));
  });

  test('a mid-transition write failure rolls the WHOLE transition back (old identity intact)', async () => {
    // Fail the new api_key_index create — a write that happens partway through
    // writeTransition. Firestore atomicity must discard every other write too.
    // The retirement tombstone is written partway through the rotation (step 3
    // of 8) and registration never writes it, so failing every write to it
    // fails mid-transition without disturbing wallet creation.
    const { app, fake } = buildRoute({
      failTxnWriteTo: AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
    });
    const walletId = await createWallet(app);
    const walletBefore = structuredClone(fake.store.get(`agent_wallets/${walletId}`));
    const oldPrefix = (walletBefore as Record<string, unknown>).api_key_prefix as string;
    const tipBefore = structuredClone(fake.store.get('pe_chain_tips/canonical-agent'));
    const checkpointBefore = structuredClone(fake.store.get(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`));

    const { deps } = bankDeps(fake);
    const plan = await planFor(fake, walletId);
    await expect(executeKeyRotationTransition(deps, plan)).rejects.toThrow();

    // Nothing moved: old identity fully intact.
    expect(fake.store.get(`agent_wallets/${walletId}`)).toEqual(walletBefore);
    expect(fake.store.get('pe_chain_tips/canonical-agent')).toEqual(tipBefore);
    expect(fake.store.get(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`)).toEqual(checkpointBefore);
    // No new-address subsystem, no retirement, no rotation PE, no history.
    expect(fake.store.has(
      `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(NEW_ADDRESS)}`,
    )).toBe(false);
    expect(fake.store.has(
      `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(OLD_ADDRESS)}`,
    )).toBe(true);
    expect(fake.store.has(`api_key_index/${oldPrefix}`)).toBe(true);
    expect(fake.store.has(`${AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${OLD_ADDRESS}`)).toBe(false);
    expect(fake.store.has(`provenance_envelopes/${plan.rotationPeId}`)).toBe(false);
    expect(fake.store.has(`${IDENTITY_ACTS_COLLECTION}/${plan.rotationPeId}`)).toBe(false);
    expect([...fake.store.keys()].some((k) => k.includes(`/${ROTATION_HISTORY_SUBCOLLECTION}/`)))
      .toBe(false);
  });

  test('rejects when the new address is already claimed by any native wallet', async () => {
    const { app, fake } = buildRoute();
    const walletId = await createWallet(app);
    fake.store.set(
      `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(NEW_ADDRESS)}`,
      { schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: NEW_ADDRESS,
        wallet_id: 'wallet_aw_other', owner_type: 'agent', owner_id: 'other', created_at_ms: 1 },
    );
    const { deps } = bankDeps(fake);
    const plan = await planFor(fake, walletId);
    await expect(executeKeyRotationTransition(deps, plan)).rejects.toThrow(
      /new_address_in_use/,
    );
    // Untouched.
    expect((fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>).address)
      .toBe(OLD_ADDRESS);
  });

  test('rejects when the new API prefix is already in use', async () => {
    const { app, fake } = buildRoute();
    const walletId = await createWallet(app);
    const identity = await newIdentity();
    fake.store.set(`api_key_index/${identity.newApiCredentials.api_key_prefix}`, {
      api_key_prefix: identity.newApiCredentials.api_key_prefix,
      wallet_id: 'wallet_aw_other',
      created_at: 1,
    });
    const { deps } = bankDeps(fake);
    const plan = await planFor(fake, walletId, { identity });
    await expect(executeKeyRotationTransition(deps, plan)).rejects.toThrow(/new_api_prefix_in_use/);
  });

  test('rejects when the wallet state changed after planning (optimistic concurrency)', async () => {
    const { app, fake } = buildRoute();
    const walletId = await createWallet(app);
    const { deps } = bankDeps(fake);
    const plan = await planFor(fake, walletId);
    // A concurrent rotation lands first, changing the live address.
    fake.store.set(`agent_wallets/${walletId}`, {
      ...(fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>),
      address: '0x9999999999999999999999999999999999999999',
    });
    await expect(executeKeyRotationTransition(deps, plan)).rejects.toThrow(/wallet_state_changed/);
  });

  test('rejects a public key that does not derive to the new address', async () => {
    const { app, fake } = buildRoute();
    const walletId = await createWallet(app);
    await expect(planFor(fake, walletId, {
      identity: {
        newAddress: NEW_ADDRESS,
        newPublicKey: 'b'.repeat(128),
        newApiCredentials: await generateApiCredentialsAsync(),
      },
    })).rejects.toThrow(/new_public_key_derivation_mismatch/);
  });

  test('rejects rotating to the same address', async () => {
    const { app, fake } = buildRoute();
    const walletId = await createWallet(app);
    await expect(planFor(fake, walletId, {
      identity: {
        newAddress: OLD_ADDRESS,
        newPublicKey: 'a'.repeat(128),
        newApiCredentials: await generateApiCredentialsAsync(),
      },
    })).rejects.toThrow(/new_public_key_derivation_mismatch|new_address_equals_old/);
  });

  test('rejects a replay once the address is already retired', async () => {
    const { app, fake } = buildRoute();
    const walletId = await createWallet(app);
    const { deps } = bankDeps(fake);
    await executeKeyRotationTransition(deps, await planFor(fake, walletId));
    // The wallet is now on NEW_ADDRESS; a stale plan bound to OLD_ADDRESS must
    // not re-run. Build a stale plan by hand-restoring the wallet's old address
    // is unnecessary — the retirement tombstone + wallet-state guard both fire.
    const stale = await planFor(fake, walletId).catch((e) => e as Error);
    // prepare now reads the NEW address as current, so a same-target plan fails
    // derivation/equality or later the wallet-state guard.
    expect(stale).toBeInstanceOf(Error);
  });

  test('KeyRotationTransitionError carries a stable reason prefix', () => {
    expect(new KeyRotationTransitionError('x').message).toBe('key_rotation_transition:x');
  });

  test('directory address follows the live address when a directory doc exists', async () => {
    const { app, fake } = buildRoute();
    const walletId = await createWallet(app);
    fake.store.set(`${AGENT_DIRECTORY_COLLECTION}/${walletId}`, {
      wallet_id: walletId,
      address: OLD_ADDRESS,
      display_name: 'Canonical Agent',
    });
    const { deps } = bankDeps(fake);
    await executeKeyRotationTransition(deps, await planFor(fake, walletId));
    expect((fake.store.get(`${AGENT_DIRECTORY_COLLECTION}/${walletId}`) as Record<string, unknown>).address)
      .toBe(NEW_ADDRESS);
  });

  // launch-stop #7: the LIVE native-wallet registration uniqueness gate must
  // reject any address carrying a retirement tombstone (rotated away from), so a
  // retired address can never be re-registered by any agent — one address maps
  // to exactly one agent, permanently.
  async function registerSecondAgent(app: express.Express) {
    return request(app)
      .post('/v1/agent/wallet/create')
      .send({
        registration_id: 'agent-registration-second-agent-0002',
        agent_name: 'Second Agent',
        agent_id: 'second-agent',
        platform: 'sdk',
        constitution_accepted_at: '2026-07-12T00:00:00.000Z',
        public_key: 'c'.repeat(128),
        // challenge-1 => the mock's PoP returns credential_recovery_generation
        // null, i.e. a FRESH registration (not a credential-recovery attempt).
        challenge_id: 'challenge-1',
        signature: 'cd'.repeat(64),
      });
  }

  test('registration gate: an otherwise-valid agent registers at a fresh address (control)', async () => {
    const { app, fake } = buildRoute();
    // No tombstone present. The deriveAddressFromPublicKey stub yields OLD_ADDRESS.
    const response = await registerSecondAgent(app);
    expect(response.status).toBe(201);
    expect(response.body.address).toBe(OLD_ADDRESS);
    expect(fake.store.has(
      `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(OLD_ADDRESS)}`,
    )).toBe(true);
  });

  test('registration gate: a retirement tombstone blocks re-registration of that address (launch-stop #7)', async () => {
    const { app, fake } = buildRoute();
    // Seed ONLY a retirement tombstone for the address the agent would derive —
    // the tombstone is the single variable versus the control above.
    fake.store.set(`${AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${OLD_ADDRESS}`, {
      schema_version: 'agent-wallet-address-retirement/v1',
      chain_id: 8453,
      address: OLD_ADDRESS,
      wallet_id: 'wallet_aw_prior',
      agent_id: 'prior-agent',
      new_address: NEW_ADDRESS,
      retired_at_ms: 1,
      rotation_pe_id: 'pe_agent_key_rotated_x',
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const response = await registerSecondAgent(app);
    expect(response.status).toBe(503);
    // The retirement gate is the specific cause (route logs the thrown reason).
    expect(errorSpy.mock.calls.some((call) => {
      const err = call[1];
      return err instanceof Error && /agent_wallet_registration_address_retired/.test(err.message);
    })).toBe(true);
    errorSpy.mockRestore();
    // No wallet was created for the second agent.
    expect(fake.store.has(
      `${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId('second-agent')}`,
    )).toBe(false);
  });

  // review defect 1: one address, one owner. An address an agent or a person
  // proved as an outside wallet can never become a Provian wallet, by creation or by
  // rotation. Each RED differs from its control above only in the proven doc.
  for (const registry of ['proven_addresses', 'human_proven_addresses'] as const) {
    test(`registration gate: an address in ${registry} cannot be registered as an agent wallet`, async () => {
      const { app, fake } = buildRoute();
      fake.store.set(`${registry}/${OLD_ADDRESS}`, { address: OLD_ADDRESS });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const response = await registerSecondAgent(app);
      expect(response.status).toBe(503);
      expect(errorSpy.mock.calls.some((call) => {
        const err = call[1];
        return err instanceof Error && /agent_wallet_registration_address_in_use/.test(err.message);
      })).toBe(true);
      errorSpy.mockRestore();
      expect(fake.store.has(
        `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(OLD_ADDRESS)}`,
      )).toBe(false);
    });

    test(`rotation refuses a new address in ${registry}`, async () => {
      const { app, fake } = buildRoute();
      const walletId = await createWallet(app);
      fake.store.set(`${registry}/${NEW_ADDRESS}`, { address: NEW_ADDRESS });
      const { deps } = bankDeps(fake);
      const plan = await planFor(fake, walletId);
      await expect(executeKeyRotationTransition(deps, plan)).rejects.toThrow(/new_address_in_use/);
      expect((fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>).address).toBe(OLD_ADDRESS);
    });
  }

  test('end-to-end: rotating away from an address retires it against re-registration (launch-stop #7)', async () => {
    const { app, fake } = buildRoute();
    const walletId = await createWallet(app);
    // A real rotation writes the tombstone for OLD_ADDRESS and frees the index.
    const { deps } = bankDeps(fake);
    await executeKeyRotationTransition(deps, await planFor(fake, walletId));
    expect(fake.store.has(`${AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${OLD_ADDRESS}`)).toBe(true);
    // The OLD address index is gone (freed) AND no wallet holds it, so ONLY the
    // retirement tombstone can block a colliding registration.
    expect(fake.store.has(
      `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(OLD_ADDRESS)}`,
    )).toBe(false);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const response = await registerSecondAgent(app);
    expect(response.status).toBe(503);
    expect(errorSpy.mock.calls.some((call) => {
      const err = call[1];
      return err instanceof Error && /agent_wallet_registration_address_retired/.test(err.message);
    })).toBe(true);
    errorSpy.mockRestore();
  });

  // launch-stop #8/#9: recovery of an already-rotated wallet must pass
  // end-to-end, presenting the ROTATED key — the credential-recovery read-path
  // rebinds every address/prefix-keyed check to the current identity, proven
  // against the sealed rotation_history lineage.
  function rotatedRecoveryRoute() {
    // The recovery request presents the ROTATED key, so map each public key to
    // its address: the birth key derives OLD (create), the rotated key NEW.
    return buildRoute(undefined, (pk) =>
      pk.toLowerCase() === NEW_PUBLIC_KEY.toLowerCase() ? NEW_ADDRESS : OLD_ADDRESS);
  }

  async function recoverWithRotatedKey(app: express.Express) {
    return request(app)
      .post('/v1/agent/wallet/create')
      .send({
        registration_id: 'agent-registration-canonical-agent-0001',
        agent_name: 'Canonical Agent',
        agent_id: 'canonical-agent',
        platform: 'sdk',
        constitution_accepted_at: '2026-07-12T00:00:00.000Z',
        public_key: NEW_PUBLIC_KEY,
        // challenge != 'challenge-1' => the mock PoP reports a recovery (gen 0).
        challenge_id: 'challenge-recover',
        signature: 'ef'.repeat(64),
      });
  }

  test('a rotated wallet recovers credentials end-to-end with its ROTATED key (launch-stop #8/#9)', async () => {
    const { app, fake } = rotatedRecoveryRoute();
    const walletId = await createWallet(app);
    // Rotate to the NEW identity via the REAL transition machinery, producing a
    // genuinely-consistent rotated graph. The rotation clock must be real time
    // (>= birth, <= the recovery's Date.now()) so last_rotated_at is not in the
    // future relative to the recovery.
    const { deps } = bankDeps(fake);
    const identity = await newIdentity();
    const rotationNow = Date.now();
    await executeKeyRotationTransition(deps, await planFor(fake, walletId, { identity, now: rotationNow }));
    expect((fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>).address)
      .toBe(NEW_ADDRESS);
    const oldPrefixAfterRotation = (fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>)
      .api_key_prefix as string;

    const recovered = await recoverWithRotatedKey(app);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      recovered: true,
      wallet_id: walletId,
      address: NEW_ADDRESS,
      public_key: NEW_PUBLIC_KEY,
      credential_recovery_generation: 1,
    });
    expect(recovered.body.api_key).toBeTruthy();
    // this recovery only meaningfully exercises the rotation-aware
    // badge-outbox binding when the wallet CARRIES a creation-time badge whose
    // outbox is bound to the (post-rotation, non-current) BIRTH address.
    // genesis_agent — the only badge earned at birth — is awarded iff the wallet's
    // created_at is at or before the approved Genesis admission close. createWallet
    // stamps created_at from the wall clock, so the expectation is bound to that
    // SAME window source rather than a bare `toContain`: it stays CORRECT after the
    // window closes (asserting absence) instead of becoming a false RED, and is
    // non-vacuous throughout the launch window (it asserts the badge IS present,
    // and thus exercises the binding). RED control recorded in -ADDENDUM:
    // reverting the binding to `outbox.actor_address === wallet.address` turns THIS
    // test 503 `badge_outbox_binding` — the birth address ≠ the rotated address.
    const genesisEarned = Date.now() <= (PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms as number);
    expect((recovered.body.badges as Array<{ id: string }>).map((b) => b.id).includes('genesis_agent'))
      .toBe(genesisEarned);
    // The wallet stays on the ROTATED identity; only the credentials rotate.
    const walletAfter = fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>;
    expect(walletAfter.address).toBe(NEW_ADDRESS);
    expect(walletAfter.rotation_count).toBe(1);
    expect(walletAfter.api_key_prefix).toBe(String(recovered.body.api_key).slice(0, 24));
    // The rotated prefix index was retired; the new recovery prefix is live.
    expect(fake.store.has(`api_key_index/${oldPrefixAfterRotation}`)).toBe(false);
    expect(fake.store.has(`api_key_index/${walletAfter.api_key_prefix as string}`)).toBe(true);
  });

  test('recovery of a rotated wallet fails closed if the rotation_history evidence is tampered (launch-stop #8/#9)', async () => {
    const { app, fake } = rotatedRecoveryRoute();
    const walletId = await createWallet(app);
    const { deps } = bankDeps(fake);
    const identity = await newIdentity();
    const result = await executeKeyRotationTransition(deps, await planFor(fake, walletId, { identity, now: Date.now() }));
    // Corrupt the sealed rotation_history entry's new_address so it no longer
    // proves the wallet's current address.
    const historyKey = `agent_wallets/${walletId}/${ROTATION_HISTORY_SUBCOLLECTION}/${rotationHistoryId(result.rotationPeId)}`;
    fake.store.set(historyKey, {
      ...(fake.store.get(historyKey) as Record<string, unknown>),
      new_address: '0x9999999999999999999999999999999999999999',
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const recovered = await recoverWithRotatedKey(app);
    // Fail CLOSED: no replacement secret is issued.
    expect(recovered.status).not.toBe(200);
    expect(recovered.body.api_key).toBeUndefined();
    expect(recovered.body.api_secret).toBeUndefined();
    errorSpy.mockRestore();
  });

  // PE METER: recovery binds each rotation_history entry to its sealed `agent_key_rotated`
  // identity act by one point read (it no longer walks the chain). RED controls: a missing
  // rotation act, and a self-consistent rotation act whose cut disagrees with its history entry
  // (re-hashed, and the entry re-pinned to it, so ONLY the content binding can refuse it).
  test('recovery of a rotated wallet fails closed if its rotation identity act is missing or re-cut', async () => {
    for (const tamper of ['missing', 'recut'] as const) {
      const { app, fake } = rotatedRecoveryRoute();
      const walletId = await createWallet(app);
      const { deps } = bankDeps(fake);
      const identity = await newIdentity();
      const result = await executeKeyRotationTransition(deps, await planFor(fake, walletId, { identity, now: Date.now() }));
      const actKey = `${IDENTITY_ACTS_COLLECTION}/${result.rotationPeId}`;
      const historyKey = `agent_wallets/${walletId}/${ROTATION_HISTORY_SUBCOLLECTION}/${rotationHistoryId(result.rotationPeId)}`;
      if (tamper === 'missing') {
        expect(fake.store.delete(actKey)).toBe(true);
      } else {
        const doc = structuredClone(fake.store.get(actKey)) as unknown as IdentityActDoc;
        const pricing = { ...doc.act.pricing, metadata: { ...(doc.act.pricing.metadata as Record<string, unknown>), rotation_count: 2 } };
        const recut: IdentityActDoc = { ...doc, act: { ...doc.act, pricing } };
        const hash = peHashOf(peOfIdentityAct(recut));
        fake.store.set(actKey, { ...recut, act: { ...recut.act, pe_hash: hash } });
        fake.store.set(historyKey, { ...(fake.store.get(historyKey) as Record<string, unknown>), pe_hash: hash });
      }
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const recovered = await recoverWithRotatedKey(app);
      expect({ tamper, status: recovered.status }).toEqual({ tamper, status: 503 });
      expect(recovered.body.api_key).toBeUndefined();
      expect(recovered.body.api_secret).toBeUndefined();
      errorSpy.mockRestore();
    }
  });
});
