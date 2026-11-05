import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import crypto from 'crypto';
import express from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import stableStringify from 'json-stable-stringify';
import request from 'supertest';

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
const verifyClaimsPop = jest.fn(async () => ({
  ok: true as const,
  claims: {},
}));
jest.mock('../core/agent-wallet/proof-of-possession', () => ({
  ...(jest.requireActual('../core/agent-wallet/proof-of-possession') as object),
  verifyAndConsumePopChallenge: (
    _cache: unknown,
    challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: Pick<RegistrationContext, 'registration_id' | 'agent_id'>,
  ) => verifyPop(challengeId, expected),
  verifyAndConsumeClaimsPopChallenge: () => verifyClaimsPop(),
}));

import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
} from '../core/pvt/native-wallet-registration';
import {
  INBOUND_WATCHER_CHECKPOINT_COLLECTION,
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
} from '../core/pvt/watcher-address-admission';
import {
  GENESIS_QUALIFICATION_COLLECTION,
  GENESIS_RESERVATION_COLLECTION,
  GENESIS_WALLET_LEDGER_COLLECTION,
} from '../core/pvt/genesis-award-state-machine';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { generateApiCredentialsAsync } from '../core/agent-wallet/api-key';
import { AGENT_BENEFICIARY_RELATIONSHIP_COLLECTION } from '../core/agent-wallet/beneficiary-relationship';
import {
  AGENT_BADGE_AWARD_OUTBOX_COLLECTION,
  badgeAwardOutboxDocumentId,
  badgeEarnedPeId,
} from '../core/agent-wallet/badge-provenance';
import type { RouterDeps } from '../core/agent-wallet/types';
import { NETWORK_CONSTITUTION_VERSION } from '../core/agent-wallet/types';
import {
  AGENT_WALLET_REGISTRATION_COLLECTION,
  createAgentWalletRouter,
} from './agent-wallet';
import {
  IDENTITY_ACTS_COLLECTION,
  validateIdentityAct,
} from '../core/meter/identity-acts';
import {
  AGENT_GOVERNANCE_SOURCE_COLLECTION,
} from '../core/agent-wallet/governance-source';
import {
  appendRelayPe,
  rehashIdentityAct,
  replaceIdentityActMetadata,
  replaceIdentityActPricing,
  replaceIdentityActRecord,
} from '../core/agent-wallet/__test-helpers__/identity-pe-fixture';

const ADDRESS = '0x2222222222222222222222222222222222222222';

function countPrefix(store: Map<string, Record<string, unknown>>, prefix: string): number {
  return [...store.keys()].filter((key) => key.startsWith(`${prefix}/`)).length;
}

function buildRoute(options: {
  readHead?: () => Promise<number>;
  deriveAddressFromPublicKey?: (publicKey: string) => string;
  initialStore?: ReadonlyArray<readonly [string, Record<string, unknown>]>;
  fakeOptions?: Parameters<typeof createFakeFirestore>[0];
} = {}) {
  const fake = createFakeFirestore(options.fakeOptions);
  if (options.initialStore) {
    for (const [key, value] of options.initialStore) {
      fake.store.set(key, structuredClone(value));
    }
  } else {
    fake.store.set(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
      chain_id: 8453,
      last_processed_block: 130,
      membership_generation: 7,
      updated_at: 1,
    });
  }
  const recordPEAccrual = jest.fn(async () => undefined);
  const generateRecoveryApiCredentials = jest.fn(generateApiCredentialsAsync);
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
    deriveAddressFromPublicKey: options.deriveAddressFromPublicKey ?? (() => ADDRESS),
    readBaseRegistrationHead: options.readHead ?? (async () => 140),
    generateRecoveryApiCredentials,
  } as unknown as RouterDeps;
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  return { app, fake, recordPEAccrual, generateRecoveryApiCredentials };
}

function registrationBody(overrides: Record<string, unknown> = {}) {
  return {
    registration_id: 'agent-registration-canonical-agent-0001',
    agent_name: 'Canonical Agent',
    agent_id: 'canonical-agent',
    platform: 'sdk',
    constitution_accepted_at: '2026-07-12T00:00:00.000Z',
    public_key: 'a'.repeat(128),
    challenge_id: 'challenge-1',
    signature: 'ab'.repeat(64),
    ...overrides,
  };
}

type RecoveryMutationContext = {
  walletId: string;
  peId: string;
  apiPrefix: string;
  registrationKey: string;
  walletKey: string;
  trustWalletKey: string;
  agentIndexKey: string;
  addressIndexKey: string;
  admissionKey: string;
  checkpointKey: string;
  birthPeKey: string;
  chainTipKey: string;
  tipPeKey: string;
  apiIndexKey: string;
  relationshipKey: string;
};

function exactlyOneKey(
  store: Map<string, Record<string, unknown>>,
  prefix: string,
): string {
  const keys = [...store.keys()].filter((key) => key.startsWith(`${prefix}/`));
  expect(keys).toHaveLength(1);
  return keys[0];
}

function recoveryMutationContext(
  store: Map<string, Record<string, unknown>>,
  created: Record<string, unknown>,
): RecoveryMutationContext {
  const walletId = created.wallet_id as string;
  const peId = created.pe_chain_root as string;
  const apiPrefix = String(created.api_key).slice(0, 24);
  const chainTipKey = `pe_chain_tips/canonical-agent`;
  const tipHash = store.get(chainTipKey)?.hash;
  // PE METER: the relay keeps the agent's identity PEs as identity acts (no envelopes). Right
  // after creation the tip names the newest of them (the genesis_agent badge PE).
  const tipPeKeys = [...store.entries()]
    .filter(([key, value]) => key.startsWith(`${IDENTITY_ACTS_COLLECTION}/`)
      && (value.act as Record<string, unknown>).pe_hash === tipHash)
    .map(([key]) => key);
  expect(tipPeKeys).toHaveLength(1);
  expect(countPrefix(store, 'provenance_envelopes')).toBe(0);
  return {
    walletId,
    peId,
    apiPrefix,
    registrationKey: exactlyOneKey(store, AGENT_WALLET_REGISTRATION_COLLECTION),
    walletKey: `agent_wallets/${walletId}`,
    trustWalletKey: `wallets/${walletId}`,
    agentIndexKey: exactlyOneKey(store, NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION),
    addressIndexKey: exactlyOneKey(store, NATIVE_WALLET_ADDRESS_INDEX_COLLECTION),
    admissionKey: exactlyOneKey(store, WATCHER_ADDRESS_ADMISSION_COLLECTION),
    checkpointKey: `${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`,
    birthPeKey: `${IDENTITY_ACTS_COLLECTION}/${peId}`,
    chainTipKey,
    tipPeKey: tipPeKeys[0],
    apiIndexKey: `api_key_index/${apiPrefix}`,
    relationshipKey: exactlyOneKey(store, AGENT_BENEFICIARY_RELATIONSHIP_COLLECTION),
  };
}

function replaceField(
  store: Map<string, Record<string, unknown>>,
  key: string,
  field: string,
  value: unknown,
): void {
  const current = store.get(key);
  expect(current).toBeDefined();
  store.set(key, { ...current!, [field]: value });
}

function removeField(
  store: Map<string, Record<string, unknown>>,
  key: string,
  field: string,
): void {
  const current = store.get(key);
  expect(current).toBeDefined();
  const updated = { ...current! };
  delete updated[field];
  store.set(key, updated);
}

function replaceNestedField(
  store: Map<string, Record<string, unknown>>,
  key: string,
  parent: string,
  field: string,
  value: unknown,
): void {
  const current = store.get(key);
  expect(current).toBeDefined();
  const nested = current?.[parent] as Record<string, unknown>;
  store.set(key, { ...current!, [parent]: { ...nested, [field]: value } });
}

function rehashStoredPe(
  store: Map<string, Record<string, unknown>>,
  key: string,
): string {
  const raw = store.get(key);
  expect(raw).toBeDefined();
  const canonical = {
    id: raw!.id,
    wallet_id: raw!.wallet_id,
    agent_id: raw!.agent_id,
    action_type: raw!.action_type,
    actor_address: raw!.actor_address,
    timestamp: raw!.timestamp,
    prev_hash: raw!.prev_hash,
    attestation_type: raw!.attestation_type,
    metadata: raw!.metadata,
    compute: raw!.compute,
    geo: raw!.geo,
    execution_env: raw!.execution_env,
    cited_pe_ids: raw!.cited_pe_ids,
    parent_goal_pe_id: raw!.parent_goal_pe_id,
  };
  const canonicalJson = stableStringify(canonical);
  expect(typeof canonicalJson).toBe('string');
  const hash = crypto.createHash('sha256').update(canonicalJson!, 'utf8').digest('hex');
  store.set(key, { ...raw!, hash });
  return hash;
}

function canonicalStoredPe(params: {
  id: string;
  walletId: string;
  agentId: string;
  actorAddress: string;
  actionType: string;
  policyActionType?: string;
  timestamp: number;
  prevHash: string;
  metadata: Record<string, unknown>;
}): { hash: string; document: Record<string, unknown> } {
  const canonical = {
    id: params.id,
    wallet_id: params.walletId,
    agent_id: params.agentId,
    action_type: params.actionType,
    actor_address: params.actorAddress,
    timestamp: params.timestamp,
    prev_hash: params.prevHash,
    attestation_type: 'software',
    metadata: params.metadata,
    compute: null,
    geo: null,
    execution_env: null,
    cited_pe_ids: null,
    parent_goal_pe_id: null,
  };
  const serialized = stableStringify(canonical);
  expect(typeof serialized).toBe('string');
  const hash = crypto.createHash('sha256').update(serialized!, 'utf8').digest('hex');
  return {
    hash,
    document: {
      ...canonical,
      hash,
      user_id: params.agentId,
      policy_action_type: params.policyActionType ?? params.actionType,
      integration_source: 'agent_bank_generate_pe',
      counterparty_address: null,
      counterparty_type: null,
      session_lineage: null,
      self_referencing: false,
      trust_level_at_creation: null,
      created_at: params.timestamp,
      durability: 'final',
    },
  };
}

/**
 * Append a PE to the agent's chain as the relay does under the PE meter: an identity-bearing PE
 * keeps its identity act; every PE advances the tip; a work PE leaves nothing readable behind.
 */
function appendCanonicalPe(
  store: Map<string, Record<string, unknown>>,
  params: {
    id: string;
    walletId: string;
    agentId: string;
    actorAddress: string;
    actionType: string;
    timestamp: number;
    metadata: Record<string, unknown>;
    keepIdentityAct?: boolean;
  },
): string {
  const currentTip = store.get(`pe_chain_tips/${params.agentId}`);
  expect(currentTip?.hash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
  return appendRelayPe(store, params);
}

function identityActOf(
  store: Map<string, Record<string, unknown>>,
  peId: string,
  agentId: string,
  walletId: string,
): Record<string, unknown> {
  const doc = store.get(`${IDENTITY_ACTS_COLLECTION}/${peId}`);
  return validateIdentityAct({
    raw: doc,
    peId,
    peHash: (doc?.act as Record<string, unknown> | undefined)?.pe_hash as string,
    actorId: agentId,
    walletId,
  });
}

function provenAddressRecord(params: {
  address: string;
  agentId: string;
  walletId: string;
  provenAtMs: number;
}): Record<string, unknown> {
  const signatureHash = `sha256:${'4'.repeat(64)}`;
  return {
    schema_version: 'proven-address/v2',
    economic_eligibility: 'active_go_forward_only',
    address: params.address,
    agent_id: params.agentId,
    wallet_id: params.walletId,
    proven_at_ms: params.provenAtMs,
    proven_at_block: 101,
    proof_observed_head_block: 100,
    proof_block_number: 89,
    proof_block_hash: `0x${'5'.repeat(64)}`,
    proof_min_confirmations: 12,
    proof_rpc_operator_ids: ['operator-a', 'operator-b'],
    chain: 'base',
    chain_id: 8453,
    proof_method: 'eip191_eoa',
    signature_hash: signatureHash,
    proof_evidence: {
      schema_version: 'external-address-control-proof/v1',
      challenge_id_sha256: `sha256:${'1'.repeat(64)}`,
      challenge_message_sha256: `sha256:${'2'.repeat(64)}`,
      signature_sha256: signatureHash,
      proof_method: 'eip191_eoa',
      verified_at_ms: params.provenAtMs,
    },
    initial_reputation_tier: 0,
    baseline_nonce: 0,
    created_at: params.provenAtMs,
  };
}

function seedCanonicalChildAuthority(
  store: Map<string, Record<string, unknown>>,
  parentWalletId: string,
  index: number,
): string {
  const suffix = index.toString().padStart(3, '0');
  const walletId = `wallet_aw_child-${suffix}`;
  const agentId = `child-agent-${suffix}`;
  const address = `0x${(index + 10).toString(16).padStart(40, '0')}`;
  const relationship = {
    state: 'unlinked',
    human_wallet_id: null,
    human_user_id: null,
    human_address: null,
    agent_share_bps: null,
    parent_wallet_id: parentWalletId,
    revision: 1,
  };
  const birth = canonicalStoredPe({
    id: `pe_child_birth_${suffix}`,
    walletId,
    agentId,
    actorAddress: address,
    actionType: 'agent_wallet_created',
    policyActionType: 'wallet_created',
    timestamp: 1,
    prevHash: '0x0000',
    metadata: { beneficiary_relationship: relationship },
  });
  store.set(`agent_wallets/${walletId}`, {
    id: walletId,
    agent_id: agentId,
    address,
    status: 'active',
    parent_wallet_id: parentWalletId,
    linked_human_wallet_id: null,
    linked_human_user_id: null,
    linked_human_address: null,
    operational_reserve_bps: null,
  });
  store.set(`${AGENT_BENEFICIARY_RELATIONSHIP_COLLECTION}/${walletId}`, {
    schema_version: 'agent-beneficiary-relationship/v2',
    wallet_id: walletId,
    agent_id: agentId,
    ...relationship,
    source_action_type: 'agent_wallet_created',
    source_pe_id: `pe_child_birth_${suffix}`,
    source_pe_hash: birth.hash,
    created_at_ms: 1,
    updated_at_ms: 1,
  });
  store.set(`identity_pes_legacy_v1/pe_child_birth_${suffix}`, birth.document);
  store.set(`pe_chain_tips/${agentId}`, {
    hash: birth.hash,
    user_id: agentId,
    updated_at: 1,
  });
  return walletId;
}

describe('test-marker propagation into the wallets mirror (network-stats consignment)', () => {
  beforeEach(() => {
    verifyPop.mockClear();
    verifyClaimsPop.mockClear();
    verifyPop.mockImplementation(async (challengeId, expected) => ({
      ok: true,
      registration_context: {
        ...expected,
        credential_recovery_generation: challengeId === 'challenge-1' ? null : 0,
      },
    }));
  });

  test("platform:'test' registration stamps the wallets mirror so stats exclude it from birth", async () => {
    const { app, fake } = buildRoute();
    const response = await request(app)
      .post('/v1/agent/wallet/create')
      .send(registrationBody({ platform: 'test' }));

    expect(response.status).toBe(201);
    const walletId = response.body.wallet_id as string;
    // Without this propagation a one-time backfill decays: every launch-smoke
    // CI run registers a platform:'test' agent whose wallets mirror would be
    // born unmarked and re-pollute the public aggregates.
    expect(fake.store.get(`wallets/${walletId}`)).toMatchObject({ platform: 'test' });
    expect(fake.store.get(`agent_wallets/${walletId}`)).toMatchObject({ platform: 'test' });
  });
});

describe('canonical native agent registration route', () => {
  beforeEach(() => {
    verifyPop.mockClear();
    verifyClaimsPop.mockClear();
    verifyPop.mockImplementation(async (challengeId, expected) => ({
      ok: true,
      registration_context: {
        ...expected,
        credential_recovery_generation: challengeId === 'challenge-1' ? null : 0,
      },
    }));
  });

  test.each(['share_changed', 'human_released'] as const)('aborts child registration when the parent beneficiary changes during the canonical transaction: %s', async (change) => {
    const parentWalletKey = 'agent_wallets/wallet_aw_parent01';
    const parentWallet = {
      id: 'wallet_aw_parent01',
      agent_id: 'parent-agent',
      display_name: 'Parent Agent',
      address: '0x1111111111111111111111111111111111111111',
      public_key: 'c'.repeat(128),
      status: 'active',
      linked_human_wallet_id: 'wallet_human_parent',
      linked_human_user_id: 'human-parent',
      linked_human_address: '0x3333333333333333333333333333333333333333',
      operational_reserve_bps: 2_000,
      children_wallet_ids: [],
    };
    const parentRelationshipMetadata = {
      state: 'linked',
      human_wallet_id: 'wallet_human_parent',
      human_user_id: 'human-parent',
      human_address: '0x3333333333333333333333333333333333333333',
      agent_share_bps: 2_000,
      parent_wallet_id: null,
      revision: 1,
    };
    const parentBirthPe = canonicalStoredPe({
      id: 'pe_parent_birth',
      walletId: 'wallet_aw_parent01',
      agentId: 'parent-agent',
      actorAddress: '0x1111111111111111111111111111111111111111',
      actionType: 'agent_wallet_created',
      policyActionType: 'wallet_created',
      timestamp: 1,
      prevHash: '0x0000',
      metadata: { beneficiary_relationship: parentRelationshipMetadata },
    });
    const initialStore: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      [`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
        chain_id: 8453,
        last_processed_block: 130,
        membership_generation: 7,
        updated_at: 1,
      }],
      [parentWalletKey, parentWallet],
      [`${AGENT_BENEFICIARY_RELATIONSHIP_COLLECTION}/wallet_aw_parent01`, {
        schema_version: 'agent-beneficiary-relationship/v2',
        wallet_id: 'wallet_aw_parent01',
        agent_id: 'parent-agent',
        state: 'linked',
        human_wallet_id: 'wallet_human_parent',
        human_user_id: 'human-parent',
        human_address: '0x3333333333333333333333333333333333333333',
        agent_share_bps: 2_000,
        parent_wallet_id: null,
        revision: 1,
        source_action_type: 'agent_wallet_created',
        source_pe_id: 'pe_parent_birth',
        source_pe_hash: parentBirthPe.hash,
        created_at_ms: 1,
        updated_at_ms: 1,
      }],
      ['identity_pes_legacy_v1/pe_parent_birth', parentBirthPe.document],
      ['pe_chain_tips/parent-agent', {
        hash: parentBirthPe.hash,
        user_id: 'parent-agent',
        updated_at: 1,
      }],
      ['wallets/wallet_human_parent', {
        id: 'wallet_human_parent',
        type: 'human',
        user_id: 'human-parent',
        address: '0x3333333333333333333333333333333333333333',
      }],
    ];
    const { app, fake, recordPEAccrual } = buildRoute({
      initialStore,
      fakeOptions: {
        retryFirstTxn: {
          beforeRetry: (store) => {
            if (change === 'share_changed') store.set(parentWalletKey, {
              ...store.get(parentWalletKey)!, operational_reserve_bps: 3_000,
            });
            else store.set('wallets/wallet_human_parent', {
              ...store.get('wallets/wallet_human_parent')!, released_at_ms: 10,
            });
          },
        },
      },
    });

    const response = await request(app)
      .post('/v1/agent/wallet/create')
      .send(registrationBody({
        parent_wallet_id: 'wallet_aw_parent01',
        parent_proof_of_authorization: {
          challenge_id: 'parent-challenge',
          signature: 'cd'.repeat(64),
        },
      }));

    expect({ status: response.status, body: response.body }).toEqual({
      status: 503,
      body: { error: 'canonical_agent_wallet_registration_failed' },
    });
    expect(countPrefix(fake.store, 'agent_wallets')).toBe(1);
    expect(fake.store.get(parentWalletKey)!.operational_reserve_bps).toBe(change === 'share_changed' ? 3_000 : 2_000);
    expect(countPrefix(fake.store, AGENT_WALLET_REGISTRATION_COLLECTION)).toBe(0);
    expect(countPrefix(fake.store, NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION)).toBe(0);
    expect(countPrefix(fake.store, NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)).toBe(0);
    expect(countPrefix(fake.store, WATCHER_ADDRESS_ADMISSION_COLLECTION)).toBe(0);
    // Only the seeded pre-meter parent birth PE; the aborted child left no PE anywhere.
    expect(countPrefix(fake.store, 'identity_pes_legacy_v1')).toBe(1);
    expect(countPrefix(fake.store, 'provenance_envelopes')).toBe(0);
    expect(recordPEAccrual).not.toHaveBeenCalled();
    expect(response.body.api_key).toBeUndefined();
    expect(response.body.api_secret).toBeUndefined();
  });

  test('atomically creates identity, indexes, H/H+1 admission, generation fence, first PE, and chain tip', async () => {
    const { app, fake } = buildRoute();
    const response = await request(app)
      .post('/v1/agent/wallet/create')
      .send(registrationBody());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      address: ADDRESS,
      public_key: 'a'.repeat(128),
    });
    const walletId = response.body.wallet_id as string;
    const peId = response.body.pe_chain_root as string;
    expect(fake.store.get(`agent_wallets/${walletId}`)).toMatchObject({
      agent_id: 'canonical-agent',
      address: ADDRESS,
      operational_reserve_bps: null,
      native_watcher_registration: {
        observed_head_block: 140,
        eligibility_start_block: 141,
      },
    });
    expect(fake.store.get(`wallets/${walletId}`)).toMatchObject({
      type: 'agent',
      agent_id: 'canonical-agent',
    });
    // Control for the test-marker propagation below: an ordinary client
    // platform ('sdk') must NOT stamp the wallets mirror — on `wallets`,
    // platform is a pure test marker, never the general client label.
    expect(fake.store.get(`wallets/${walletId}`)).not.toHaveProperty('platform');
    expect(countPrefix(fake.store, NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION)).toBe(1);
    expect(countPrefix(fake.store, NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)).toBe(1);
    expect(countPrefix(fake.store, WATCHER_ADDRESS_ADMISSION_COLLECTION)).toBe(1);
    expect([...fake.store.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        schema_version: 'pvt-watcher-address-admission/v3',
        address: ADDRESS,
        wallet_id: walletId,
        eligibility_start_block: 141,
        state: 'live',
        backfill_next_block: 141,
        catch_up_through_block: 140,
        membership_generation: 8,
        generation_fenced_at_registration: true,
      }),
    ]));
    expect(fake.store.get(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`)).toMatchObject({
      last_processed_block: 130,
      membership_generation: 8,
    });
    // PE METER: the birth PE is kept as the identity act the registration pins (by id + hash);
    // no envelope is written.
    expect(fake.store.has(`provenance_envelopes/${peId}`)).toBe(false);
    const registration = fake.store.get(
      exactlyOneKey(fake.store, AGENT_WALLET_REGISTRATION_COLLECTION),
    )!;
    expect(validateIdentityAct({
      raw: fake.store.get(`${IDENTITY_ACTS_COLLECTION}/${peId}`),
      peId,
      peHash: registration.pe_hash as string,
      actorId: 'canonical-agent',
      walletId,
    })).toMatchObject({
      id: peId,
      wallet_id: walletId,
      agent_id: 'canonical-agent',
      action_type: 'agent_wallet_created',
      policy_action_type: 'wallet_created',
      prev_hash: '0x0000',
      metadata: {
        constitution: {
          accepted: false,
        },
      },
    });
    expect(fake.store.get('pe_chain_tips/canonical-agent')).toMatchObject({
      hash: expect.any(String),
    });
  });

  test('binds optional Constitution acceptance exactly across create and recovery', async () => {
    for (const accepted of [false, true]) {
      const { app, fake } = buildRoute();
      const body = registrationBody({ constitution_accepted: accepted });
      const created = await request(app).post('/v1/agent/wallet/create').send(body);
      expect(created.status).toBe(201);
      expect(identityActOf(
        fake.store, String(created.body.pe_chain_root), 'canonical-agent', String(created.body.wallet_id),
      )).toMatchObject({ metadata: { constitution: { accepted } } });
      const recovered = await request(app).post('/v1/agent/wallet/create').send({
        ...body,
        challenge_id: `challenge-constitution-${accepted}`,
      });
      expect(recovered.status).toBe(200);
    }
  });

  test('an omitted constitution_version records the Network Constitution version on a new wallet', async () => {
    const { app, fake } = buildRoute();
    const created = await request(app).post('/v1/agent/wallet/create').send(registrationBody());
    expect(created.status).toBe(201);
    expect(NETWORK_CONSTITUTION_VERSION).toBe('network-constitution-2026-09-27');
    expect(fake.store.get(`agent_wallets/${String(created.body.wallet_id)}`))
      .toMatchObject({ constitution_version: NETWORK_CONSTITUTION_VERSION });
    expect(identityActOf(
      fake.store, String(created.body.pe_chain_root), 'canonical-agent', String(created.body.wallet_id),
    )).toMatchObject({ metadata: { constitution: { version: NETWORK_CONSTITUTION_VERSION } } });
  });

  test('a registration sealed under the pre-relabel default recovers with the version omitted', async () => {
    // Before the Network Constitution relabel an omitted version defaulted to this
    // literal, so its fingerprint carries it. Recovery that omits the field (MCP and raw
    // clients never send it) must resolve to the sealed value, not the new default.
    const LEGACY = 'human-agentic-constitution-v0.1';
    const { app, fake } = buildRoute();
    const created = await request(app).post('/v1/agent/wallet/create')
      .send(registrationBody({ constitution_version: LEGACY }));
    expect(created.status).toBe(201);
    const walletId = String(created.body.wallet_id);
    expect(fake.store.get(`agent_wallets/${walletId}`)).toMatchObject({ constitution_version: LEGACY });

    const recovered = await request(app).post('/v1/agent/wallet/create').send({
      ...registrationBody(),
      challenge_id: 'challenge-legacy-version-omitted',
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ recovered: true, wallet_id: walletId });
    expect(fake.store.get(`agent_wallets/${walletId}`)).toMatchObject({ constitution_version: LEGACY });

    // Control: the fingerprint really binds the version. Naming the NEW version
    // explicitly for the same legacy registration is refused as an identity mismatch.
    const mismatched = await request(app).post('/v1/agent/wallet/create').send({
      ...registrationBody({ constitution_version: NETWORK_CONSTITUTION_VERSION }),
      challenge_id: 'challenge-legacy-version-explicit-new',
    });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.error).toBe('agent_wallet_registration_recovery_identity_mismatch');
  });

  test('publishes an initial badge only with its PE and refuses recovery if that graph is broken', async () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const { app, fake, generateRecoveryApiCredentials } = buildRoute();
      const body = registrationBody({
        constitution_accepted_at: '2026-05-31T00:00:00.000Z',
      });
      const created = await request(app).post('/v1/agent/wallet/create').send(body);
      expect(created.status).toBe(201);
      const walletId = created.body.wallet_id as string;
      const badgePeId = badgeEarnedPeId(walletId, 'genesis_agent');
      expect(created.body.badges).toEqual([{ id: 'genesis_agent', earned_at: now }]);
      expect(fake.store.get(`agent_wallets/${walletId}`)?.badges)
        .toEqual([{ id: 'genesis_agent', earned_at: now }]);
      expect(countPrefix(fake.store, AGENT_BADGE_AWARD_OUTBOX_COLLECTION)).toBe(1);
      expect(identityActOf(fake.store, badgePeId, 'canonical-agent', walletId))
        .toMatchObject({ action_type: 'badge_earned', metadata: { badge_id: 'genesis_agent' } });

      expect(fake.store.delete(`${IDENTITY_ACTS_COLLECTION}/${badgePeId}`)).toBe(true);
      const callsBeforeRecovery = generateRecoveryApiCredentials.mock.calls.length;
      const recovered = await request(app).post('/v1/agent/wallet/create').send({
        ...body,
        challenge_id: 'challenge-broken-badge-provenance',
      });
      expect(recovered.status).toBe(503);
      expect(recovered.body.error).toBe('agent_wallet_registration_recovery_integrity_failure');
      expect(generateRecoveryApiCredentials).toHaveBeenCalledTimes(callsBeforeRecovery);
      expect(recovered.body.api_key).toBeUndefined();
      expect(recovered.body.api_secret).toBeUndefined();
    } finally {
      dateSpy.mockRestore();
    }
  });

  test('same-key retry recovers the same wallet with rotated credentials and no duplicate side effects', async () => {
    const { app, fake, recordPEAccrual } = buildRoute({
      initialStore: [
        [`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
          chain_id: 8453,
          last_processed_block: 130,
          membership_generation: 7,
          updated_at: 1,
        }],
      ],
    });
    // `agent_session_id` is a RETIRED field — still accepted from older SDK
    // builds, ignored by the relay (nothing to bind), never a recovery input.
    const requestBody = registrationBody({ agent_session_id: 'session-legacy-ignored' });
    const first = await request(app).post('/v1/agent/wallet/create').send(requestBody);
    expect(first.status).toBe(201);
    expect(countPrefix(fake.store, 'agent_sessions')).toBe(0);
    const beforeCounts = {
      agents: countPrefix(fake.store, 'agent_wallets'),
      wallets: countPrefix(fake.store, 'wallets'),
      registrations: countPrefix(fake.store, AGENT_WALLET_REGISTRATION_COLLECTION),
      agentIndexes: countPrefix(fake.store, NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION),
      addressIndexes: countPrefix(fake.store, NATIVE_WALLET_ADDRESS_INDEX_COLLECTION),
      admissions: countPrefix(fake.store, WATCHER_ADDRESS_ADMISSION_COLLECTION),
      envelopes: countPrefix(fake.store, 'provenance_envelopes'),
      chainTips: countPrefix(fake.store, 'pe_chain_tips'),
      genesisQualifications: countPrefix(fake.store, GENESIS_QUALIFICATION_COLLECTION),
      genesisReservations: countPrefix(fake.store, GENESIS_RESERVATION_COLLECTION),
      genesisWalletLedgers: countPrefix(fake.store, GENESIS_WALLET_LEDGER_COLLECTION),
      accrualCalls: recordPEAccrual.mock.calls.length,
    };
    const originalApiPrefix = String(first.body.api_key).slice(0, 24);

    const recovered = await request(app).post('/v1/agent/wallet/create').send(registrationBody({
      agent_session_id: 'session-legacy-ignored',
      challenge_id: 'challenge-2',
      signature: 'cd'.repeat(64),
    }));
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      recovered: true,
      wallet_id: first.body.wallet_id,
      address: first.body.address,
      public_key: first.body.public_key,
      pe_chain_root: first.body.pe_chain_root,
      credential_recovery_generation: 1,
    });
    expect(recovered.body.api_key).not.toBe(first.body.api_key);
    expect(recovered.body.api_secret).not.toBe(first.body.api_secret);
    const persistedJson = JSON.stringify([...fake.store.entries()]);
    expect(persistedJson).not.toContain(first.body.api_secret);
    expect(persistedJson).not.toContain(recovered.body.api_secret);
    expect(countPrefix(fake.store, 'agent_wallets')).toBe(beforeCounts.agents);
    expect(countPrefix(fake.store, 'wallets')).toBe(beforeCounts.wallets);
    expect(countPrefix(fake.store, AGENT_WALLET_REGISTRATION_COLLECTION))
      .toBe(beforeCounts.registrations);
    expect(countPrefix(fake.store, NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION))
      .toBe(beforeCounts.agentIndexes);
    expect(countPrefix(fake.store, NATIVE_WALLET_ADDRESS_INDEX_COLLECTION))
      .toBe(beforeCounts.addressIndexes);
    expect(countPrefix(fake.store, WATCHER_ADDRESS_ADMISSION_COLLECTION))
      .toBe(beforeCounts.admissions);
    expect(countPrefix(fake.store, 'provenance_envelopes')).toBe(beforeCounts.envelopes);
    expect(countPrefix(fake.store, 'pe_chain_tips')).toBe(beforeCounts.chainTips);
    expect(countPrefix(fake.store, GENESIS_QUALIFICATION_COLLECTION))
      .toBe(beforeCounts.genesisQualifications);
    expect(countPrefix(fake.store, GENESIS_RESERVATION_COLLECTION))
      .toBe(beforeCounts.genesisReservations);
    expect(countPrefix(fake.store, GENESIS_WALLET_LEDGER_COLLECTION))
      .toBe(beforeCounts.genesisWalletLedgers);
    expect(recordPEAccrual).toHaveBeenCalledTimes(beforeCounts.accrualCalls);
    expect(fake.store.has(`api_key_index/${originalApiPrefix}`)).toBe(false);
    expect(fake.store.get(`api_key_index/${String(recovered.body.api_key).slice(0, 24)}`))
      .toMatchObject({ wallet_id: first.body.wallet_id });
    expect(fake.store.get(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`))
      .toMatchObject({ membership_generation: 8 });
    expect(countPrefix(fake.store, 'agent_sessions')).toBe(0);
  });

  test('recovers a current-tip-authenticated chain after more than 256 PEs', async () => {
    const { app, fake } = buildRoute();
    const body = registrationBody();
    const created = await request(app).post('/v1/agent/wallet/create').send(body);
    expect(created.status).toBe(201);
    const wallet = fake.store.get(`agent_wallets/${created.body.wallet_id}`)!;
    const currentTip = fake.store.get('pe_chain_tips/canonical-agent')!;
    const timestamp = (currentTip.last_pe_timestamp ?? wallet.created_at) as number;
    for (let index = 0; index < 257; index += 1) {
      appendCanonicalPe(fake.store, {
        id: `pe_long_chain_${index.toString().padStart(3, '0')}`,
        walletId: created.body.wallet_id,
        agentId: 'canonical-agent',
        actorAddress: ADDRESS,
        actionType: 'agent_activity',
        timestamp,
        metadata: { sequence: index },
      });
    }
    // Recovery reads a bounded set of identity records, not the 257 work PEs behind the tip.
    expect(countPrefix(fake.store, IDENTITY_ACTS_COLLECTION)).toBe(2);

    const recovered = await request(app).post('/v1/agent/wallet/create').send({
      ...body,
      challenge_id: 'challenge-long-chain-recovery',
    });

    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      recovered: true,
      wallet_id: created.body.wallet_id,
    });
  });

  test('recovers canonical first-lifetime bond and operational-vote badge graphs', async () => {
    const { app, fake } = buildRoute();
    const body = registrationBody();
    const created = await request(app).post('/v1/agent/wallet/create').send(body);
    expect(created.status).toBe(201);
    const walletId = created.body.wallet_id as string;
    const walletKey = `agent_wallets/${walletId}`;
    const wallet = fake.store.get(walletKey)!;
    const currentTip = fake.store.get('pe_chain_tips/canonical-agent')!;
    const timestamp = (currentTip.last_pe_timestamp ?? wallet.created_at) as number;

    const addCompletedEventBadge = (params: {
      badgeId: 'insured_agent' | 'governance_participant';
      sourcePeId: string;
      sourceAction: 'bond_posted' | 'governance_vote_cast';
      sourceMetadata: Record<string, unknown>;
      trigger: 'agent_bank_event' | 'governance';
    }) => {
      const sourceHash = appendCanonicalPe(fake.store, {
        id: params.sourcePeId,
        walletId,
        agentId: 'canonical-agent',
        actorAddress: ADDRESS,
        actionType: params.sourceAction,
        timestamp,
        metadata: params.sourceMetadata,
      });
      const outboxId = badgeAwardOutboxDocumentId(walletId, params.badgeId);
      const badgePeId = badgeEarnedPeId(walletId, params.badgeId);
      const badgePeHash = appendCanonicalPe(fake.store, {
        id: badgePeId,
        walletId,
        agentId: 'canonical-agent',
        actorAddress: ADDRESS,
        actionType: 'badge_earned',
        timestamp,
        metadata: {
          badge_id: params.badgeId,
          trigger: params.trigger,
          qualification_outbox_id: outboxId,
          source_pe_id: params.sourcePeId,
          source_pe_hash: sourceHash,
        },
      });
      fake.store.set(`${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/${outboxId}`, {
        schema_version: 'agent-badge-award-outbox/v1',
        outbox_id: outboxId,
        wallet_id: walletId,
        agent_id: 'canonical-agent',
        actor_address: ADDRESS,
        badge_id: params.badgeId,
        trigger: params.trigger,
        earned_at_ms: timestamp,
        source_pe_id: params.sourcePeId,
        source_pe_hash: sourceHash,
        state: 'complete',
        badge_pe_id: badgePeId,
        badge_pe_hash: badgePeHash,
        created_at_ms: timestamp,
        completed_at_ms: timestamp,
      });
    };

    addCompletedEventBadge({
      badgeId: 'insured_agent',
      sourcePeId: 'pe_recovery_bond_posted',
      sourceAction: 'bond_posted',
      sourceMetadata: {
        bond_id: 'bond_recovery_event',
        tx_hash: `0x${'a'.repeat(64)}`,
      },
      trigger: 'agent_bank_event',
    });
    addCompletedEventBadge({
      badgeId: 'governance_participant',
      sourcePeId: 'pe_recovery_governance_vote',
      sourceAction: 'governance_vote_cast',
      sourceMetadata: {
        proposal_id: 7,
        support: true,
        weight: '1',
        tx_hash: `0x${'b'.repeat(64)}`,
        governance_layer: 'operational',
      },
      trigger: 'governance',
    });
    fake.store.set(walletKey, {
      ...wallet,
      badges: [
        ...(wallet.badges as Array<{ id: string; earned_at: number }>),
        { id: 'insured_agent', earned_at: timestamp },
        { id: 'governance_participant', earned_at: timestamp },
      ],
      updated_at: timestamp,
    });

    const recovered = await request(app).post('/v1/agent/wallet/create').send({
      ...body,
      challenge_id: 'challenge-event-badge-recovery',
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ recovered: true, wallet_id: walletId });
  });

  // PE METER: the relay no longer holds the agent's work PEs, so a WORK PE authored by an external
  // address (a receive, say) is the owner's to prove; recovery validates the bounded identity
  // records. Every identity PE it reads must be authored by the wallet's lineage or by an address
  // the agent has proven (`proven_addresses`), and an unknown actor on one is refused before any
  // secret is generated.
  test('accepts proven external actors and rejects an unknown actor on an identity PE before secret generation', async () => {
    const validRoute = buildRoute();
    const body = registrationBody();
    const created = await request(validRoute.app)
      .post('/v1/agent/wallet/create')
      .send(body);
    expect(created.status).toBe(201);
    const externalAddress = `0x${'6'.repeat(40)}`;
    const wallet = validRoute.fake.store.get(`agent_wallets/${created.body.wallet_id}`)!;
    const provenAtMs = wallet.created_at as number;
    const record = provenAddressRecord({
      address: externalAddress,
      agentId: 'canonical-agent',
      walletId: created.body.wallet_id,
      provenAtMs,
    });
    validRoute.fake.store.set(`proven_addresses/${externalAddress}`, record);
    appendCanonicalPe(validRoute.fake.store, {
      id: 'pe_external_address_proven_recovery',
      walletId: created.body.wallet_id,
      agentId: 'canonical-agent',
      actorAddress: externalAddress,
      actionType: 'external_address_proven',
      timestamp: provenAtMs,
      metadata: {
        external_proven: true,
        proven_address: externalAddress,
        attributed_agent_id: 'canonical-agent',
        proven_at_block: record.proven_at_block,
        proof_observed_head_block: record.proof_observed_head_block,
        proof_block_number: record.proof_block_number,
        proof_block_hash: record.proof_block_hash,
        proof_method: record.proof_method,
        signature_hash: record.signature_hash,
      },
    });
    appendCanonicalPe(validRoute.fake.store, {
      id: 'pe_external_receive_recovery',
      walletId: created.body.wallet_id,
      agentId: 'canonical-agent',
      actorAddress: externalAddress,
      actionType: 'receive',
      timestamp: provenAtMs,
      metadata: {
        external_proven: true,
        proven_address: externalAddress,
        attributed_agent_id: 'canonical-agent',
        proven_at_block: 101,
      },
    });
    const validRecovery = await request(validRoute.app)
      .post('/v1/agent/wallet/create')
      .send({ ...body, challenge_id: 'challenge-external-actor' });
    expect(validRecovery.status).toBe(200);

    // RED: an identity PE recovery reads (the genesis_agent badge PE the outbox pins) re-authored
    // by an address that is neither the wallet's lineage nor proven. Re-hashed and re-pinned, so
    // only the actor-authority binding can refuse it.
    const invalidRoute = buildRoute();
    const invalidCreated = await request(invalidRoute.app)
      .post('/v1/agent/wallet/create')
      .send(body);
    expect(invalidCreated.status).toBe(201);
    const unknownActor = `0x${'7'.repeat(40)}`;
    const badgePeId = badgeEarnedPeId(invalidCreated.body.wallet_id, 'genesis_agent');
    const badgeKey = `${IDENTITY_ACTS_COLLECTION}/${badgePeId}`;
    const outboxKey = `${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/${
      badgeAwardOutboxDocumentId(invalidCreated.body.wallet_id, 'genesis_agent')}`;
    expect(invalidRoute.fake.store.has(badgeKey)).toBe(true);
    replaceIdentityActPricing(invalidRoute.fake.store, badgeKey, 'actor_address', unknownActor);
    const forgedHash = rehashIdentityAct(invalidRoute.fake.store, badgeKey);
    replaceField(invalidRoute.fake.store, outboxKey, 'badge_pe_hash', forgedHash);
    replaceField(invalidRoute.fake.store, 'pe_chain_tips/canonical-agent', 'hash', forgedHash);
    const callsBefore = invalidRoute.generateRecoveryApiCredentials.mock.calls.length;
    const invalidRecovery = await request(invalidRoute.app)
      .post('/v1/agent/wallet/create')
      .send({ ...body, challenge_id: 'challenge-unknown-actor' });
    expect(invalidRecovery.status).toBe(503);
    expect(invalidRoute.generateRecoveryApiCredentials).toHaveBeenCalledTimes(callsBefore);
    expect(invalidRecovery.body.api_key).toBeUndefined();
    expect(invalidRecovery.body.api_secret).toBeUndefined();

    // Control: the same re-authoring by the PROVEN external address passes the actor-authority
    // binding (and is then refused only by the badge outbox's lineage binding — a badge is never
    // awarded to an external address), so the refusal above is the unknown actor.
    const provenRoute = buildRoute();
    const provenCreated = await request(provenRoute.app)
      .post('/v1/agent/wallet/create')
      .send(body);
    expect(provenCreated.status).toBe(201);
    provenRoute.fake.store.set(`proven_addresses/${externalAddress}`, provenAddressRecord({
      address: externalAddress,
      agentId: 'canonical-agent',
      walletId: provenCreated.body.wallet_id,
      provenAtMs,
    }));
    const provenBadgeKey = `${IDENTITY_ACTS_COLLECTION}/${
      badgeEarnedPeId(provenCreated.body.wallet_id, 'genesis_agent')}`;
    const provenOutboxKey = `${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/${
      badgeAwardOutboxDocumentId(provenCreated.body.wallet_id, 'genesis_agent')}`;
    replaceIdentityActPricing(provenRoute.fake.store, provenBadgeKey, 'actor_address', externalAddress);
    const provenHash = rehashIdentityAct(provenRoute.fake.store, provenBadgeKey);
    replaceField(provenRoute.fake.store, provenOutboxKey, 'badge_pe_hash', provenHash);
    replaceField(provenRoute.fake.store, 'pe_chain_tips/canonical-agent', 'hash', provenHash);
    const provenRecovery = await request(provenRoute.app)
      .post('/v1/agent/wallet/create')
      .send({ ...body, challenge_id: 'challenge-proven-actor-badge' });
    expect(provenRecovery.status).toBe(503);
  });

  test('authenticates every reciprocal child through its canonical relationship and birth chain', async () => {
    const route = buildRoute({
      deriveAddressFromPublicKey: (publicKey) => (
        publicKey.toLowerCase().startsWith('b')
          ? `0x${'8'.repeat(40)}`
          : ADDRESS
      ),
    });
    const parentBody = registrationBody();
    const parent = await request(route.app)
      .post('/v1/agent/wallet/create')
      .send(parentBody);
    expect(parent.status).toBe(201);
    const child = await request(route.app)
      .post('/v1/agent/wallet/create')
      .send(registrationBody({
        registration_id: 'child-registration-canonical-agent-0001',
        agent_name: 'Canonical Child',
        agent_id: 'canonical-child',
        public_key: 'b'.repeat(128),
        parent_wallet_id: parent.body.wallet_id,
        parent_proof_of_authorization: {
          challenge_id: 'parent-child-authority',
          signature: 'cd'.repeat(64),
        },
      }));
    expect(child.status).toBe(201);
    expect(route.fake.store.get(`agent_wallets/${parent.body.wallet_id}`)?.children_wallet_ids)
      .toEqual([child.body.wallet_id]);
    const recovery = await request(route.app)
      .post('/v1/agent/wallet/create')
      .send({ ...parentBody, challenge_id: 'challenge-parent-with-real-child' });
    expect(recovery.status).toBe(200);

    const forgedRoute = buildRoute();
    const forgedParent = await request(forgedRoute.app)
      .post('/v1/agent/wallet/create')
      .send(parentBody);
    expect(forgedParent.status).toBe(201);
    const forgedChildId = 'wallet_aw_forged-child';
    const parentWalletKey = `agent_wallets/${forgedParent.body.wallet_id}`;
    forgedRoute.fake.store.set(parentWalletKey, {
      ...forgedRoute.fake.store.get(parentWalletKey)!,
      children_wallet_ids: [forgedChildId],
    });
    forgedRoute.fake.store.set(`agent_wallets/${forgedChildId}`, {
      id: forgedChildId,
      agent_id: 'forged-child-agent',
      address: `0x${'9'.repeat(40)}`,
      status: 'active',
      parent_wallet_id: forgedParent.body.wallet_id,
      linked_human_wallet_id: null,
      linked_human_user_id: null,
      linked_human_address: null,
      operational_reserve_bps: null,
    });
    const callsBefore = forgedRoute.generateRecoveryApiCredentials.mock.calls.length;
    const forgedRecovery = await request(forgedRoute.app)
      .post('/v1/agent/wallet/create')
      .send({ ...parentBody, challenge_id: 'challenge-parent-forged-child' });
    expect(forgedRecovery.status).toBe(503);
    expect(forgedRoute.generateRecoveryApiCredentials).toHaveBeenCalledTimes(callsBefore);
  });

  test('rejects the 129th child atomically and leaves the 128-child parent recoverable', async () => {
    const route = buildRoute({
      deriveAddressFromPublicKey: (publicKey) => (
        publicKey.toLowerCase().startsWith('b')
          ? `0x${'a1'.repeat(20)}`
          : ADDRESS
      ),
    });
    const parentBody = registrationBody();
    const parent = await request(route.app)
      .post('/v1/agent/wallet/create')
      .send(parentBody);
    expect(parent.status).toBe(201);
    const children = Array.from({ length: 128 }, (_, index) =>
      seedCanonicalChildAuthority(route.fake.store, parent.body.wallet_id, index));
    const parentWalletKey = `agent_wallets/${parent.body.wallet_id}`;
    route.fake.store.set(parentWalletKey, {
      ...route.fake.store.get(parentWalletKey)!,
      children_wallet_ids: children,
    });
    const before = {
      wallets: countPrefix(route.fake.store, 'agent_wallets'),
      registrations: countPrefix(route.fake.store, AGENT_WALLET_REGISTRATION_COLLECTION),
      envelopes: countPrefix(route.fake.store, 'provenance_envelopes'),
      admissions: countPrefix(route.fake.store, WATCHER_ADDRESS_ADMISSION_COLLECTION),
    };
    const rejected = await request(route.app)
      .post('/v1/agent/wallet/create')
      .send(registrationBody({
        registration_id: 'child-registration-canonical-agent-0129',
        agent_name: 'Canonical Child 129',
        agent_id: 'canonical-child-129',
        public_key: 'b'.repeat(128),
        parent_wallet_id: parent.body.wallet_id,
        parent_proof_of_authorization: {
          challenge_id: 'parent-child-limit',
          signature: 'cd'.repeat(64),
        },
      }));
    expect(rejected.status).toBe(503);
    expect(rejected.body.api_key).toBeUndefined();
    expect(rejected.body.api_secret).toBeUndefined();
    expect(countPrefix(route.fake.store, 'agent_wallets')).toBe(before.wallets);
    expect(countPrefix(route.fake.store, AGENT_WALLET_REGISTRATION_COLLECTION))
      .toBe(before.registrations);
    expect(countPrefix(route.fake.store, 'provenance_envelopes')).toBe(before.envelopes);
    expect(countPrefix(route.fake.store, WATCHER_ADDRESS_ADMISSION_COLLECTION))
      .toBe(before.admissions);
    expect(route.fake.store.get(parentWalletKey)?.children_wallet_ids).toEqual(children);

    const recovered = await request(route.app)
      .post('/v1/agent/wallet/create')
      .send({ ...parentBody, challenge_id: 'challenge-parent-after-child-limit' });
    expect(recovered.status).toBe(200);
  });

  test('governance changes are PE-backed and remain recoverable while malformed updates are denied', async () => {
    const { app, fake } = buildRoute();
    const body = registrationBody();
    const created = await request(app).post('/v1/agent/wallet/create').send(body);
    expect(created.status).toBe(201);
    const authorization = `Bearer ${created.body.api_key}:${created.body.api_secret}`;
    const walletKey = `agent_wallets/${created.body.wallet_id}`;
    const canonicalWallet = structuredClone(fake.store.get(walletKey)!);
    const beforeForged = {
      envelopes: countPrefix(fake.store, 'provenance_envelopes'),
      outboxes: countPrefix(fake.store, AGENT_BADGE_AWARD_OUTBOX_COLLECTION),
    };
    fake.store.set(walletKey, {
      ...canonicalWallet,
      linked_human_wallet_id: 'wallet_human_forged_governance',
      linked_human_user_id: 'human-forged-governance',
      linked_human_address: `0x${'c'.repeat(40)}`,
      operational_reserve_bps: 2_000,
    });
    fake.store.set('devices/device-forged-governance', {
      owner_wallet_id: created.body.wallet_id,
      status: 'active',
      attestation_capability: 'hardware_tpm',
    });
    const forgedLinkUpdate = await request(app)
      .post(`/v1/agent/wallet/${created.body.wallet_id}/governance`)
      .set('Authorization', authorization)
      .send({ spending_limits_enabled: true });
    expect(forgedLinkUpdate.status).toBe(409);
    expect(forgedLinkUpdate.body.error).toBe('agent_beneficiary_relationship_invalid');
    expect(countPrefix(fake.store, 'provenance_envelopes')).toBe(beforeForged.envelopes);
    expect(countPrefix(fake.store, AGENT_BADGE_AWARD_OUTBOX_COLLECTION))
      .toBe(beforeForged.outboxes);
    expect(fake.store.get(walletKey)?.governance).toEqual(canonicalWallet.governance);
    fake.store.set(walletKey, canonicalWallet);

    const malformed = await request(app)
      .post(`/v1/agent/wallet/${created.body.wallet_id}/governance`)
      .set('Authorization', authorization)
      .send({ pe_coverage_enabled: 'true' });
    expect(malformed.status).toBe(400);

    const changed = await request(app)
      .post(`/v1/agent/wallet/${created.body.wallet_id}/governance`)
      .set('Authorization', authorization)
      .send({ pe_coverage_enabled: true });
    expect(changed.status).toBe(200);
    expect(changed.body.governance).toMatchObject({ pe_coverage_enabled: true });
    // PE METER: the governance in force names the identity act that set it.
    const governanceSource = fake.store.get(
      `${AGENT_GOVERNANCE_SOURCE_COLLECTION}/${created.body.wallet_id}`,
    )!;
    expect(governanceSource).toMatchObject({
      schema_version: 'agent-governance-source/v1',
      wallet_id: created.body.wallet_id,
      agent_id: 'canonical-agent',
      governance: expect.objectContaining({ pe_coverage_enabled: true }),
    });
    expect(validateIdentityAct({
      raw: fake.store.get(`${IDENTITY_ACTS_COLLECTION}/${String(governanceSource.source_pe_id)}`),
      peId: governanceSource.source_pe_id as string,
      peHash: governanceSource.source_pe_hash as string,
      actorId: 'canonical-agent',
      walletId: created.body.wallet_id,
    })).toMatchObject({
      action_type: 'policy_updated',
      metadata: expect.objectContaining({
        policy_key: 'agent_governance_settings',
        new_governance: expect.objectContaining({ pe_coverage_enabled: true }),
      }),
    });

    const beforeRecovery = structuredClone([...fake.store.entries()]);
    const recovered = await request(app).post('/v1/agent/wallet/create').send({
      ...body,
      challenge_id: 'challenge-after-governance-update',
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      recovered: true,
      wallet_id: created.body.wallet_id,
    });

    // RED: the pointer names a policy act whose governance is not the wallet's (re-hashed and
    // re-pinned, so only the governance binding can refuse it); and a pointer that is removed
    // while the wallet's governance differs from its registration.
    for (const tamper of ['policy_act_governance', 'pointer_missing'] as const) {
      const route = buildRoute({ initialStore: beforeRecovery });
      const sourceKey = `${AGENT_GOVERNANCE_SOURCE_COLLECTION}/${created.body.wallet_id}`;
      if (tamper === 'pointer_missing') {
        expect(route.fake.store.delete(sourceKey)).toBe(true);
      } else {
        const pointer = route.fake.store.get(sourceKey)!;
        const actKey = `${IDENTITY_ACTS_COLLECTION}/${String(pointer.source_pe_id)}`;
        replaceIdentityActMetadata(route.fake.store, actKey, 'new_governance', {
          ...(pointer.governance as Record<string, unknown>),
          attestation_enabled: true,
        });
        const hash = rehashIdentityAct(route.fake.store, actKey);
        replaceField(route.fake.store, sourceKey, 'source_pe_hash', hash);
        for (const [key, value] of route.fake.store) {
          if (key.startsWith(`${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/`) && value.source_pe_id === pointer.source_pe_id) {
            route.fake.store.set(key, { ...value, source_pe_hash: hash });
          }
        }
      }
      const denied = await request(route.app).post('/v1/agent/wallet/create').send({
        ...body,
        challenge_id: `challenge-governance-tamper-${tamper}`,
      });
      expect({ tamper, status: denied.status }).toEqual({ tamper, status: 503 });
      expect(route.generateRecoveryApiCredentials).not.toHaveBeenCalled();
    }
  });

  test('rolls back the complete registration when an atomic write fails (address index)', async () => {
    // removed the relay-session binding that this rollback proof used to
    // fail on; the same all-or-nothing property is proven against a write that
    // still lives inside the creation transaction.
    const { app, fake, recordPEAccrual } = buildRoute({
      initialStore: [
        [`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
          chain_id: 8453,
          last_processed_block: 130,
          membership_generation: 7,
          updated_at: 1,
        }],
      ],
      fakeOptions: { failTxnWriteTo: NATIVE_WALLET_ADDRESS_INDEX_COLLECTION },
    });

    const response = await request(app)
      .post('/v1/agent/wallet/create')
      .send(registrationBody());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'canonical_agent_wallet_registration_failed' });
    expect(countPrefix(fake.store, 'agent_wallets')).toBe(0);
    expect(countPrefix(fake.store, AGENT_WALLET_REGISTRATION_COLLECTION)).toBe(0);
    expect(countPrefix(fake.store, NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION)).toBe(0);
    expect(countPrefix(fake.store, NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)).toBe(0);
    expect(countPrefix(fake.store, WATCHER_ADDRESS_ADMISSION_COLLECTION)).toBe(0);
    expect(countPrefix(fake.store, 'provenance_envelopes')).toBe(0);
    expect(countPrefix(fake.store, 'pe_chain_tips')).toBe(0);
    expect(recordPEAccrual).not.toHaveBeenCalled();
    expect(response.body.api_key).toBeUndefined();
    expect(response.body.api_secret).toBeUndefined();
  });

  test('requires a caller-pinned timestamp and preserves a no-prefix public key beginning 04', async () => {
    const { app, fake } = buildRoute();
    const missingTimestamp = await request(app)
      .post('/v1/agent/wallet/create')
      .send(registrationBody({ constitution_accepted_at: undefined }));
    expect(missingTimestamp.status).toBe(400);
    expect(missingTimestamp.body.error).toContain('durably retained');
    expect(countPrefix(fake.store, 'agent_wallets')).toBe(0);

    const leading04Key = `04${'a'.repeat(126)}`;
    const challenge = await request(app)
      .get('/v1/agent/wallet/challenge')
      .query({
        public_key: leading04Key,
        registration_id: 'agent-registration-leading-04-key-0001',
        agent_id: 'leading-04-agent',
      });
    expect(challenge.status).toBe(200);

    const created = await request(app)
      .post('/v1/agent/wallet/create')
      .send(registrationBody({
        registration_id: 'agent-registration-leading-04-key-0001',
        agent_id: 'leading-04-agent',
        public_key: leading04Key,
      }));
    expect(created.status).toBe(201);
    expect(created.body.public_key).toBe(leading04Key);
  });

  test('the challenge says whether the registration is already on record (installer re-run)', async () => {
    const { app } = buildRoute();
    const key = `${'b'.repeat(128)}`;
    const ids = { public_key: key, registration_id: 'agent-registration-exists-flag-0001', agent_id: 'exists-flag-agent' };
    const before = await request(app).get('/v1/agent/wallet/challenge').query(ids);
    expect(before.status).toBe(200);
    expect(before.body.registration_exists).toBe(false);

    const created = await request(app).post('/v1/agent/wallet/create').send(registrationBody({
      registration_id: ids.registration_id, agent_id: ids.agent_id, public_key: key,
    }));
    expect(created.status).toBe(201);

    const after = await request(app).get('/v1/agent/wallet/challenge').query(ids);
    expect(after.status).toBe(200);
    expect(after.body.registration_exists).toBe(true);
  });

  test('rejects registration shapes that would create unrecoverable durable state', async () => {
    const invalidBodies = [
      registrationBody({ constitution_accepted: 'true' }),
      registrationBody({ constitution_accepted_at: '2999-01-01T00:00:00.000Z' }),
      registrationBody({ constitution_version: '' }),
      registrationBody({ constitution_version: null }),
      registrationBody({ chains: [] }),
      registrationBody({ chains: null }),
      registrationBody({ chains: ['base', 'base'] }),
      // `agent_session_id` is tolerated and ignored (legacy SDKs still send it), so it
      // is no longer a rejection shape — see the 'legacy session id is ignored' test below.
      registrationBody({ parent_wallet_id: '' }),
      registrationBody({ parent_wallet_id: 7 }),
      registrationBody({ parent_proof_of_authorization: { challenge_id: 'x', signature: 'aa' } }),
      registrationBody({ governance: { pe_coverage_enabled: 'true' } }),
      registrationBody({ governance: { full_governance: true } }),
      registrationBody({ governance: { unknown: false } }),
    ];
    for (const body of invalidBodies) {
      const { app, fake } = buildRoute();
      const response = await request(app).post('/v1/agent/wallet/create').send(body);
      expect(response.status).toBe(400);
      expect(countPrefix(fake.store, 'agent_wallets')).toBe(0);
      expect(countPrefix(fake.store, AGENT_WALLET_REGISTRATION_COLLECTION)).toBe(0);
    }
  });

  test('wrong key, agent id, or malformed proof cannot recover a committed wallet (a legacy session id is ignored)', async () => {
    const { app, fake } = buildRoute({
      initialStore: [
        [`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
          chain_id: 8453,
          last_processed_block: 130,
          membership_generation: 7,
          updated_at: 1,
        }],
        ['agents/canonical-agent', {
          id: 'canonical-agent',
          user_id: 'human-owner',
          status: 'active',
        }],
      ],
    });
    const original = registrationBody({ agent_session_id: 'session-original' });
    const first = await request(app).post('/v1/agent/wallet/create').send(original);
    expect(first.status).toBe(201);
    const before = new Map(fake.store);

    const wrongKey = await request(app).post('/v1/agent/wallet/create').send({
      ...original,
      public_key: 'b'.repeat(128),
      challenge_id: 'challenge-wrong-key',
    });
    expect(wrongKey.status).toBe(409);
    expect(wrongKey.body.error).toBe('agent_wallet_registration_recovery_identity_mismatch');

    const wrongAgent = await request(app).post('/v1/agent/wallet/create').send({
      ...original,
      agent_id: 'different-agent',
      challenge_id: 'challenge-wrong-agent',
    });
    expect(wrongAgent.status).toBe(409);


    verifyPop.mockResolvedValueOnce({ ok: false, reason: 'signature_invalid' });
    const malformedProof = await request(app).post('/v1/agent/wallet/create').send({
      ...original,
      challenge_id: 'challenge-malformed-proof',
      signature: 'ef'.repeat(64),
    });
    expect(malformedProof.status).toBe(400);
    expect(malformedProof.body.reason).toBe('signature_invalid');
    expect(fake.store).toEqual(before);

    // addendum 3: `agent_session_id` binds nothing, but it STAYS in the retry
    // fingerprint exactly as sent — so a pre-retirement registration keeps its
    // byte-identical fingerprint across the deploy. RED half: a different value is
    // therefore still an identity mismatch (the fingerprint moved)...
    const differentLegacySession = await request(app).post('/v1/agent/wallet/create').send({
      ...original,
      agent_session_id: 'session-different',
      challenge_id: 'challenge-legacy-session',
    });
    expect(differentLegacySession.status).toBe(409);
    expect(differentLegacySession.body.error).toBe('agent_wallet_registration_recovery_identity_mismatch');
    expect(fake.store).toEqual(before);

    // ...and the SAME value (what an older SDK re-sends from its durable snapshot)
    // recovers cleanly. Last, because a recovery legitimately rotates credentials.
    const sameLegacySession = await request(app).post('/v1/agent/wallet/create').send({
      ...original,
      challenge_id: 'challenge-legacy-session-same',
    });
    expect(sameLegacySession.status).toBe(200);
    expect(sameLegacySession.body.recovered).toBe(true);
    expect(sameLegacySession.body.wallet_id).toBe(first.body.wallet_id);
  });

  test('actual-route identity mutation matrix rejects every load-bearing field without side effects', async () => {
    const fixture = buildRoute();
    const createdResponse = await request(fixture.app)
      .post('/v1/agent/wallet/create')
      .send(registrationBody());
    expect(createdResponse.status).toBe(201);
    const created = createdResponse.body as Record<string, unknown>;
    const baseEntries = structuredClone([...fixture.fake.store.entries()]);
    const context = recoveryMutationContext(fixture.fake.store, created);
    // Non-vacuity for the tip mutations: the tip names an identity PE that chains onto the birth.
    expect(context.tipPeKey).not.toBe(context.birthPeKey);
    expect((fixture.fake.store.get(context.tipPeKey)?.act as Record<string, unknown>).prev_hash)
      .toBe((fixture.fake.store.get(context.birthPeKey)?.act as Record<string, unknown>).pe_hash);
    // Control: the unmutated graph recovers (so every denial below is the mutation's).
    {
      const control = buildRoute({ initialStore: baseEntries });
      const recovered = await request(control.app)
        .post('/v1/agent/wallet/create')
        .send(registrationBody({ challenge_id: 'challenge-matrix-control', signature: 'cd'.repeat(64) }));
      expect(recovered.status).toBe(200);
    }
    const otherWallet = 'wallet_aw_11111111-1111-4111-8111-111111111111';
    const otherAddress = `0x${'3'.repeat(40)}`;
    const otherPublicKey = 'b'.repeat(128);
    const otherSha = 'b'.repeat(64);
    const otherPrefix = `pvn_live_${'b'.repeat(15)}`;
    type Mutation = {
      name: string;
      mutate: (
        store: Map<string, Record<string, unknown>>,
        ctx: RecoveryMutationContext,
      ) => void;
    };
    const mutations: Mutation[] = [
      { name: 'registration missing', mutate: (store, ctx) => { store.delete(ctx.registrationKey); } },
      { name: 'registration unknown field', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'unknown', true) },
      { name: 'registration schema', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'schema_version', 'agent-wallet-registration/v0') },
      { name: 'registration id', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'registration_id', 'agent-registration-different-0001') },
      { name: 'registration fingerprint', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'request_fingerprint_sha256', otherSha) },
      { name: 'registration wallet', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'wallet_id', otherWallet) },
      { name: 'registration agent', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'agent_id', 'different-agent') },
      { name: 'registration address', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'address', otherAddress) },
      { name: 'registration public key', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'public_key', otherPublicKey) },
      { name: 'registration birth PE', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'pe_id', 'pe_different_birth') },
      { name: 'registration birth PE hash', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'pe_hash', otherSha) },
      { name: 'registration API prefix', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'api_key_prefix', otherPrefix) },
      { name: 'registration created timestamp', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'created_at_ms', 1) },
      { name: 'registration generation', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'credential_recovery_generation', 1) },
      { name: 'registration unexpected recovery timestamp', mutate: (store, ctx) => replaceField(store, ctx.registrationKey, 'last_credential_recovered_at_ms', 1) },

      { name: 'agent wallet missing', mutate: (store, ctx) => { store.delete(ctx.walletKey); } },
      { name: 'agent wallet unknown field', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'unknown', true) },
      { name: 'agent wallet id', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'id', otherWallet) },
      { name: 'agent wallet agent', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'agent_id', 'different-agent') },
      { name: 'agent wallet address', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'address', otherAddress) },
      { name: 'agent wallet public key', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'public_key', otherPublicKey) },
      { name: 'agent wallet API prefix', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'api_key_prefix', otherPrefix) },
      { name: 'agent wallet malformed API hash', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'api_key_hash', '00') },
      { name: 'agent wallet malformed API salt', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'api_key_salt', '00') },
      { name: 'agent wallet status', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'status', 'suspended') },
      { name: 'agent wallet rotation count', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'rotation_count', 1) },
      { name: 'agent wallet legacy rotation timestamp', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'last_rotated_at', 1) },
      { name: 'agent wallet created timestamp', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'created_at', 1) },
      { name: 'agent wallet updated timestamp', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'updated_at', 1) },
      { name: 'agent wallet constitution timestamp', mutate: (store, ctx) => replaceField(store, ctx.walletKey, 'constitution_accepted_at', 1) },
      { name: 'agent wallet fence schema', mutate: (store, ctx) => replaceNestedField(store, ctx.walletKey, 'native_watcher_registration', 'schema_version', 'native-wallet-base-registration/v0') },
      { name: 'agent wallet fence chain', mutate: (store, ctx) => replaceNestedField(store, ctx.walletKey, 'native_watcher_registration', 'chain_id', 84532) },
      { name: 'agent wallet fence head', mutate: (store, ctx) => replaceNestedField(store, ctx.walletKey, 'native_watcher_registration', 'observed_head_block', 139) },
      { name: 'agent wallet fence H+1', mutate: (store, ctx) => replaceNestedField(store, ctx.walletKey, 'native_watcher_registration', 'eligibility_start_block', 142) },
      { name: 'agent wallet governance shape', mutate: (store, ctx) => replaceNestedField(store, ctx.walletKey, 'governance', 'unknown', true) },
      { name: 'agent wallet governance change without policy provenance', mutate: (store, ctx) => replaceNestedField(store, ctx.walletKey, 'governance', 'pe_coverage_enabled', true) },
      { name: 'agent wallet forged linked beneficiary without relationship provenance', mutate: (store, ctx) => {
        replaceField(store, ctx.walletKey, 'linked_human_wallet_id', 'wallet_human_forged');
        replaceField(store, ctx.walletKey, 'linked_human_user_id', 'human-forged');
        replaceField(store, ctx.walletKey, 'linked_human_address', `0x${'4'.repeat(40)}`);
        replaceField(store, ctx.walletKey, 'operational_reserve_bps', 2_000);
        store.set('wallets/wallet_human_forged', {
          id: 'wallet_human_forged',
          type: 'human',
          user_id: 'human-forged',
          address: `0x${'4'.repeat(40)}`,
        });
      } },

      { name: 'beneficiary relationship missing', mutate: (store, ctx) => { store.delete(ctx.relationshipKey); } },
      { name: 'beneficiary relationship unknown field', mutate: (store, ctx) => replaceField(store, ctx.relationshipKey, 'unknown', true) },
      { name: 'beneficiary relationship schema', mutate: (store, ctx) => replaceField(store, ctx.relationshipKey, 'schema_version', 'agent-beneficiary-relationship/v0') },
      { name: 'beneficiary relationship wallet', mutate: (store, ctx) => replaceField(store, ctx.relationshipKey, 'wallet_id', otherWallet) },
      { name: 'beneficiary relationship agent', mutate: (store, ctx) => replaceField(store, ctx.relationshipKey, 'agent_id', 'different-agent') },
      { name: 'beneficiary relationship revision', mutate: (store, ctx) => replaceField(store, ctx.relationshipKey, 'revision', 0) },
      { name: 'beneficiary relationship source action', mutate: (store, ctx) => replaceField(store, ctx.relationshipKey, 'source_action_type', 'policy_updated') },
      { name: 'beneficiary relationship source PE', mutate: (store, ctx) => replaceField(store, ctx.relationshipKey, 'source_pe_id', 'pe_different_relationship') },
      { name: 'beneficiary relationship source hash', mutate: (store, ctx) => replaceField(store, ctx.relationshipKey, 'source_pe_hash', otherSha) },
      { name: 'beneficiary relationship update timestamp', mutate: (store, ctx) => replaceField(store, ctx.relationshipKey, 'updated_at_ms', 1) },

      { name: 'trust wallet missing', mutate: (store, ctx) => { store.delete(ctx.trustWalletKey); } },
      { name: 'trust wallet unknown field', mutate: (store, ctx) => replaceField(store, ctx.trustWalletKey, 'unknown', true) },
      { name: 'trust wallet type', mutate: (store, ctx) => replaceField(store, ctx.trustWalletKey, 'type', 'human') },
      { name: 'trust wallet id', mutate: (store, ctx) => replaceField(store, ctx.trustWalletKey, 'id', otherWallet) },
      { name: 'trust wallet agent', mutate: (store, ctx) => replaceField(store, ctx.trustWalletKey, 'agent_id', 'different-agent') },
      { name: 'trust wallet address', mutate: (store, ctx) => replaceField(store, ctx.trustWalletKey, 'address', otherAddress) },
      { name: 'trust wallet public key', mutate: (store, ctx) => replaceField(store, ctx.trustWalletKey, 'public_key', otherPublicKey) },
      { name: 'trust wallet created timestamp', mutate: (store, ctx) => replaceField(store, ctx.trustWalletKey, 'created_at', 1) },
      { name: 'trust wallet constitution timestamp', mutate: (store, ctx) => replaceField(store, ctx.trustWalletKey, 'constitution_accepted_at', 1) },
      { name: 'trust wallet fence', mutate: (store, ctx) => replaceNestedField(store, ctx.trustWalletKey, 'native_watcher_registration', 'eligibility_start_block', 142) },

      { name: 'native agent index missing', mutate: (store, ctx) => { store.delete(ctx.agentIndexKey); } },
      { name: 'native agent index unknown field', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'unknown', true) },
      { name: 'native agent index schema', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'schema_version', 'native-agent-registration/v0') },
      { name: 'native agent index registration', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'registration_id', 'agent-registration-different-0001') },
      { name: 'native agent index fingerprint', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'request_fingerprint_sha256', otherSha) },
      { name: 'native agent index agent', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'agent_id', 'different-agent') },
      { name: 'native agent index wallet', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'wallet_id', otherWallet) },
      { name: 'native agent index address', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'address', otherAddress) },
      { name: 'native agent index birth PE', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'pe_id', 'pe_different_birth') },
      { name: 'native agent index birth PE hash', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'pe_hash', otherSha) },
      { name: 'native agent index API prefix', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'api_key_prefix', otherPrefix) },
      { name: 'native agent index generation', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'credential_recovery_generation', 1) },
      { name: 'native agent index created timestamp', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'created_at_ms', 1) },
      { name: 'native agent index updated timestamp', mutate: (store, ctx) => replaceField(store, ctx.agentIndexKey, 'updated_at_ms', 1) },

      { name: 'native address index missing', mutate: (store, ctx) => { store.delete(ctx.addressIndexKey); } },
      { name: 'native address index unknown field', mutate: (store, ctx) => replaceField(store, ctx.addressIndexKey, 'unknown', true) },
      { name: 'native address index schema', mutate: (store, ctx) => replaceField(store, ctx.addressIndexKey, 'schema_version', 'native-wallet-address-index/v0') },
      { name: 'native address index chain', mutate: (store, ctx) => replaceField(store, ctx.addressIndexKey, 'chain_id', 84532) },
      { name: 'native address index address', mutate: (store, ctx) => replaceField(store, ctx.addressIndexKey, 'address', otherAddress) },
      { name: 'native address index wallet', mutate: (store, ctx) => replaceField(store, ctx.addressIndexKey, 'wallet_id', otherWallet) },
      { name: 'native address index owner type', mutate: (store, ctx) => replaceField(store, ctx.addressIndexKey, 'owner_type', 'human') },
      { name: 'native address index owner id', mutate: (store, ctx) => replaceField(store, ctx.addressIndexKey, 'owner_id', 'different-agent') },
      { name: 'native address index created timestamp', mutate: (store, ctx) => replaceField(store, ctx.addressIndexKey, 'created_at_ms', 1) },

      { name: 'watcher admission missing', mutate: (store, ctx) => { store.delete(ctx.admissionKey); } },
      { name: 'watcher admission unknown field', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'unknown', true) },
      { name: 'watcher admission schema', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'schema_version', 'pvt-watcher-address-admission/v2') },
      { name: 'watcher admission direction', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'direction', 'outbound') },
      { name: 'watcher admission chain', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'chain_id', 84532) },
      { name: 'watcher admission address', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'address', otherAddress) },
      { name: 'watcher admission wallet', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'wallet_id', otherWallet) },
      { name: 'watcher admission agent', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'agent_id', 'different-agent') },
      { name: 'watcher admission fence', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'eligibility_start_block', 142) },
      { name: 'watcher admission state', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'state', 'backfilling') },
      { name: 'watcher admission membership', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'membership_generation', 9) },
      { name: 'watcher admission registration binding', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'generation_fenced_at_registration', false) },
      { name: 'watcher admission revision', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'revision', 0) },
      { name: 'watcher admission created timestamp', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'created_at_ms', 1) },
      { name: 'watcher admission updated timestamp', mutate: (store, ctx) => replaceField(store, ctx.admissionKey, 'updated_at_ms', 1) },

      { name: 'watcher checkpoint missing', mutate: (store, ctx) => { store.delete(ctx.checkpointKey); } },
      { name: 'watcher checkpoint block field missing', mutate: (store, ctx) => removeField(store, ctx.checkpointKey, 'last_processed_block') },
      { name: 'watcher checkpoint unknown field', mutate: (store, ctx) => replaceField(store, ctx.checkpointKey, 'unknown', true) },
      { name: 'watcher checkpoint chain', mutate: (store, ctx) => replaceField(store, ctx.checkpointKey, 'chain_id', 84532) },
      { name: 'watcher checkpoint membership', mutate: (store, ctx) => replaceField(store, ctx.checkpointKey, 'membership_generation', 7) },
      { name: 'watcher checkpoint block', mutate: (store, ctx) => replaceField(store, ctx.checkpointKey, 'last_processed_block', '130') },
      { name: 'watcher checkpoint timestamp', mutate: (store, ctx) => replaceField(store, ctx.checkpointKey, 'updated_at', -1) },

      // PE METER: the birth PE is the identity act the registration pins (`identity_acts_v1`).
      // Every field of the PE is covered by its v2 hash; a mutation that re-hashes the act to stay
      // self-consistent is refused by the registration's pin or by the birth binding itself.
      { name: 'birth PE missing', mutate: (store, ctx) => { store.delete(ctx.birthPeKey); } },
      { name: 'birth PE unknown document field', mutate: (store, ctx) => replaceField(store, ctx.birthPeKey, 'unknown', true) },
      { name: 'birth PE unknown act-record field', mutate: (store, ctx) => replaceNestedField(store, ctx.birthPeKey, 'act', 'unknown', true) },
      { name: 'birth PE unknown PE field', mutate: (store, ctx) => replaceIdentityActPricing(store, ctx.birthPeKey, 'unknown', true) },
      { name: 'birth PE id', mutate: (store, ctx) => { replaceIdentityActRecord(store, ctx.birthPeKey, 'pe_id', 'pe_different_birth'); rehashIdentityAct(store, ctx.birthPeKey); } },
      { name: 'birth PE document actor', mutate: (store, ctx) => replaceField(store, ctx.birthPeKey, 'actor_id', 'different-agent') },
      { name: 'birth PE document wallet', mutate: (store, ctx) => replaceField(store, ctx.birthPeKey, 'wallet_id', otherWallet) },
      { name: 'birth PE wallet', mutate: (store, ctx) => { replaceIdentityActPricing(store, ctx.birthPeKey, 'wallet_id', otherWallet); rehashIdentityAct(store, ctx.birthPeKey); } },
      { name: 'birth PE agent', mutate: (store, ctx) => { replaceIdentityActPricing(store, ctx.birthPeKey, 'agent_id', 'different-agent'); rehashIdentityAct(store, ctx.birthPeKey); } },
      { name: 'birth PE actor', mutate: (store, ctx) => { replaceIdentityActPricing(store, ctx.birthPeKey, 'actor_address', otherAddress); rehashIdentityAct(store, ctx.birthPeKey); } },
      { name: 'birth PE action', mutate: (store, ctx) => { replaceIdentityActRecord(store, ctx.birthPeKey, 'action_type', 'different_action'); rehashIdentityAct(store, ctx.birthPeKey); } },
      { name: 'birth PE policy action', mutate: (store, ctx) => replaceField(store, ctx.birthPeKey, 'policy_action_type', 'different_action') },
      { name: 'birth PE predecessor', mutate: (store, ctx) => { replaceIdentityActRecord(store, ctx.birthPeKey, 'prev_hash', otherSha); rehashIdentityAct(store, ctx.birthPeKey); } },
      { name: 'birth PE timestamp', mutate: (store, ctx) => { replaceIdentityActRecord(store, ctx.birthPeKey, 'timestamp', 1); rehashIdentityAct(store, ctx.birthPeKey); } },
      { name: 'birth PE hash', mutate: (store, ctx) => replaceIdentityActRecord(store, ctx.birthPeKey, 'pe_hash', otherSha) },
      { name: 'birth PE content without re-hash', mutate: (store, ctx) => replaceIdentityActMetadata(store, ctx.birthPeKey, 'platform', 'different-platform') },
      { name: 'birth PE self-consistent root rewrite', mutate: (store, ctx) => {
        replaceIdentityActMetadata(store, ctx.birthPeKey, 'governance_score', 77);
        const hash = rehashIdentityAct(store, ctx.birthPeKey);
        replaceField(store, ctx.chainTipKey, 'hash', hash);
      } },
      { name: 'birth PE self-consistent root rewrite with every pin moved', mutate: (store, ctx) => {
        replaceIdentityActMetadata(store, ctx.birthPeKey, 'platform', 'different-platform');
        const hash = rehashIdentityAct(store, ctx.birthPeKey);
        replaceField(store, ctx.registrationKey, 'pe_hash', hash);
        replaceField(store, ctx.agentIndexKey, 'pe_hash', hash);
        replaceField(store, ctx.relationshipKey, 'source_pe_hash', hash);
        for (const [key, value] of store) {
          if (key.startsWith(`${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/`) && value.source_pe_id === ctx.peId) {
            store.set(key, { ...value, source_pe_hash: hash });
          }
        }
      } },
      { name: 'birth PE metadata public key', mutate: (store, ctx) => { replaceIdentityActMetadata(store, ctx.birthPeKey, 'public_key', otherPublicKey); rehashIdentityAct(store, ctx.birthPeKey); } },
      { name: 'birth PE metadata wallet type', mutate: (store, ctx) => { replaceIdentityActMetadata(store, ctx.birthPeKey, 'wallet_type', 'human'); rehashIdentityAct(store, ctx.birthPeKey); } },
      { name: 'birth PE Constitution acceptance', mutate: (store, ctx) => {
        const doc = store.get(ctx.birthPeKey) as Record<string, unknown>;
        const metadata = (doc.act as { pricing: { metadata: Record<string, unknown> } }).pricing.metadata;
        replaceIdentityActMetadata(store, ctx.birthPeKey, 'constitution', {
          ...(metadata.constitution as Record<string, unknown>),
          accepted: true,
        });
        rehashIdentityAct(store, ctx.birthPeKey);
      } },

      // The relay keeps only the agent's chain-tip HASH: the PEs behind it are the owner's to hold
      // and prove. The tip is still bound to the identity records recovery holds.
      { name: 'chain tip missing', mutate: (store, ctx) => { store.delete(ctx.chainTipKey); } },
      { name: 'chain tip unknown field', mutate: (store, ctx) => replaceField(store, ctx.chainTipKey, 'unknown', true) },
      { name: 'chain tip owner', mutate: (store, ctx) => replaceField(store, ctx.chainTipKey, 'user_id', 'different-agent') },
      { name: 'chain tip malformed hash', mutate: (store, ctx) => replaceField(store, ctx.chainTipKey, 'hash', 'not-a-hash') },
      { name: 'chain tip rewound to an earlier identity PE', mutate: (store, ctx) => {
        const birth = store.get(ctx.birthPeKey) as { act: { pe_hash: string } };
        replaceField(store, ctx.chainTipKey, 'hash', birth.act.pe_hash);
      } },
      { name: 'chain tip timestamp', mutate: (store, ctx) => replaceField(store, ctx.chainTipKey, 'updated_at', 1) },
      { name: 'chain tip PE timestamp contradicts the identity PE it names', mutate: (store, ctx) => {
        const tipPe = store.get(ctx.tipPeKey) as { act: { timestamp: number } };
        replaceField(store, ctx.chainTipKey, 'last_pe_timestamp', tipPe.act.timestamp + 1);
      } },
      { name: 'tip PE missing', mutate: (store, ctx) => { store.delete(ctx.tipPeKey); } },
      { name: 'tip PE self-consistent wrong wallet', mutate: (store, ctx) => { replaceIdentityActPricing(store, ctx.tipPeKey, 'wallet_id', otherWallet); const hash = rehashIdentityAct(store, ctx.tipPeKey); replaceField(store, ctx.chainTipKey, 'hash', hash); } },
      { name: 'tip PE self-consistent orphaned predecessor', mutate: (store, ctx) => {
        replaceIdentityActRecord(store, ctx.tipPeKey, 'prev_hash', otherSha);
        const hash = rehashIdentityAct(store, ctx.tipPeKey);
        replaceField(store, ctx.chainTipKey, 'hash', hash);
      } },

      // Governance provenance is the pointer to the identity act that set the governance.
      { name: 'governance source pointer to a missing policy act', mutate: (store, ctx) => {
        store.set(`${AGENT_GOVERNANCE_SOURCE_COLLECTION}/${ctx.walletId}`, {
          schema_version: 'agent-governance-source/v1',
          wallet_id: ctx.walletId,
          agent_id: 'canonical-agent',
          source_pe_id: 'pe_missing_governance_policy',
          source_pe_hash: otherSha,
          governance: (store.get(ctx.walletKey) as Record<string, unknown>).governance,
          updated_at_ms: 1,
        });
      } },
      { name: 'governance source pointer to a non-policy identity act', mutate: (store, ctx) => {
        const birth = store.get(ctx.birthPeKey) as { act: { pe_hash: string; timestamp: number } };
        store.set(`${AGENT_GOVERNANCE_SOURCE_COLLECTION}/${ctx.walletId}`, {
          schema_version: 'agent-governance-source/v1',
          wallet_id: ctx.walletId,
          agent_id: 'canonical-agent',
          source_pe_id: ctx.peId,
          source_pe_hash: birth.act.pe_hash,
          governance: (store.get(ctx.walletKey) as Record<string, unknown>).governance,
          updated_at_ms: birth.act.timestamp,
        });
      } },

      { name: 'old API index missing', mutate: (store, ctx) => { store.delete(ctx.apiIndexKey); } },
      { name: 'old API index unknown field', mutate: (store, ctx) => replaceField(store, ctx.apiIndexKey, 'unknown', true) },
      { name: 'old API index prefix', mutate: (store, ctx) => replaceField(store, ctx.apiIndexKey, 'api_key_prefix', otherPrefix) },
      { name: 'old API index wallet', mutate: (store, ctx) => replaceField(store, ctx.apiIndexKey, 'wallet_id', otherWallet) },
      { name: 'old API index timestamp', mutate: (store, ctx) => replaceField(store, ctx.apiIndexKey, 'created_at', 1) },
    ];

    for (const mutation of mutations) {
      const route = buildRoute({ initialStore: baseEntries });
      mutation.mutate(route.fake.store, context);
      const before = structuredClone([...route.fake.store.entries()]);

      const recovered = await request(route.app)
        .post('/v1/agent/wallet/create')
        .send(registrationBody({
          challenge_id: `challenge-matrix-${mutation.name.replace(/[^a-z0-9]+/gi, '-')}`,
          signature: 'cd'.repeat(64),
        }));

      expect({ mutation: mutation.name, denied: [409, 503].includes(recovered.status) })
        .toEqual({ mutation: mutation.name, denied: true });
      expect(recovered.body).not.toHaveProperty('api_key');
      expect(recovered.body).not.toHaveProperty('api_secret');
      expect([...route.fake.store.entries()]).toEqual(before);
      expect(route.recordPEAccrual).not.toHaveBeenCalled();
      expect(route.generateRecoveryApiCredentials).not.toHaveBeenCalled();
    }
    expect(mutations.length).toBeGreaterThanOrEqual(100);
  });

  test('concurrent recovery fences one credential rotation without duplicate registration economics', async () => {
    const { app, fake, recordPEAccrual } = buildRoute();
    const first = await request(app).post('/v1/agent/wallet/create').send(registrationBody());
    expect(first.status).toBe(201);
    const beforeEnvelopeCount = countPrefix(fake.store, 'provenance_envelopes');
    const beforeAccrualCalls = recordPEAccrual.mock.calls.length;

    const [left, right] = await Promise.all([
      request(app).post('/v1/agent/wallet/create').send(registrationBody({
        challenge_id: 'challenge-recovery-left',
      })),
      request(app).post('/v1/agent/wallet/create').send(registrationBody({
        challenge_id: 'challenge-recovery-right',
      })),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    expect([left.body, right.body]).toEqual(expect.arrayContaining([
      expect.objectContaining({ recovered: true, wallet_id: first.body.wallet_id }),
      expect.objectContaining({ error: 'agent_wallet_registration_recovery_in_progress' }),
    ]));
    expect(countPrefix(fake.store, 'agent_wallets')).toBe(1);
    expect(countPrefix(fake.store, 'wallets')).toBe(1);
    expect(countPrefix(fake.store, AGENT_WALLET_REGISTRATION_COLLECTION)).toBe(1);
    expect(countPrefix(fake.store, NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION)).toBe(1);
    expect(countPrefix(fake.store, NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)).toBe(1);
    expect(countPrefix(fake.store, WATCHER_ADDRESS_ADMISSION_COLLECTION)).toBe(1);
    expect(countPrefix(fake.store, 'provenance_envelopes')).toBe(beforeEnvelopeCount);
    expect(recordPEAccrual).toHaveBeenCalledTimes(beforeAccrualCalls);
    expect(fake.store.get(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`))
      .toMatchObject({ membership_generation: 8 });
  });

  test('two-operator birth-head failure creates no wallet or watcher state', async () => {
    const { app, fake } = buildRoute({
      readHead: async () => { throw new Error('economic_discovery_rpc_disagreement:head'); },
    });
    const response = await request(app)
      .post('/v1/agent/wallet/create')
      .send(registrationBody());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'agent_wallet_registration_fence_unavailable' });
    expect(countPrefix(fake.store, 'agent_wallets')).toBe(0);
    expect(countPrefix(fake.store, 'wallets')).toBe(0);
    expect(countPrefix(fake.store, WATCHER_ADDRESS_ADMISSION_COLLECTION)).toBe(0);
    expect(countPrefix(fake.store, 'provenance_envelopes')).toBe(0);
    expect(fake.store.get(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`))
      .toMatchObject({ membership_generation: 7 });
  });
});

// the legacy per-wallet callback_url delivery is RETIRED. A new registration
// still ACCEPTS a callback_url (no error) but STORES null; existing wallets whose
// stored callback_url carries a value are untouched and still recover by matching it.
describe(' callback_url is accepted but stored null (delivery retired)', () => {
  beforeEach(() => {
    verifyPop.mockClear();
    verifyClaimsPop.mockClear();
    verifyPop.mockImplementation(async (challengeId, expected) => ({
      ok: true,
      registration_context: {
        ...expected,
        credential_recovery_generation: challengeId === 'challenge-1' ? null : 0,
      },
    }));
  });

  test('a registration carrying callback_url is ACCEPTED (201) but persists callback_url === null', async () => {
    const { app, fake } = buildRoute();
    const response = await request(app)
      .post('/v1/agent/wallet/create')
      .send(registrationBody({ callback_url: 'https://legacy.example/hook' }));

    // Accepted, not rejected — the field is honored at the wire but does nothing.
    expect(response.status).toBe(201);
    const walletId = response.body.wallet_id as string;
    const wallet = fake.store.get(`agent_wallets/${walletId}`)!;
    // Non-vacuity: the store DOES reflect the body (display_name/agent_id are the
    // sent values), so a null callback_url is the deliberate coercion — not a dead
    // write or a rejected request. A request that carried "https://legacy.example/hook"
    // was accepted, yet the stored value is null.
    expect(wallet).toMatchObject({ display_name: 'Canonical Agent', agent_id: 'canonical-agent' });
    expect(wallet.callback_url).toBeNull();
  });

  test('an EXISTING wallet whose stored callback_url carries a value still recovers by matching it; a tampered value fails (non-vacuous)', async () => {
    const body = registrationBody({ callback_url: 'https://legacy.example/hook' });

    // MATCH: simulate a wallet created BEFORE this change — its stored callback_url
    // carries the value the caller sent (the pre-change store behavior). A faithful
    // retry (same body, same callback_url) recovers: the recovery-integrity identity
    // (still derived as-sent) equals the stored value, so the fingerprint matches.
    const match = buildRoute();
    const createdMatch = await request(match.app).post('/v1/agent/wallet/create').send(body);
    expect(createdMatch.status).toBe(201);
    const matchWalletId = createdMatch.body.wallet_id as string;
    replaceField(match.fake.store, `agent_wallets/${matchWalletId}`, 'callback_url', 'https://legacy.example/hook');
    const recoveredMatch = await request(match.app).post('/v1/agent/wallet/create')
      .send({ ...body, challenge_id: 'challenge-2', signature: 'cd'.repeat(64) });
    expect(recoveredMatch.status).toBe(200);
    expect(recoveredMatch.body).toMatchObject({ recovered: true, wallet_id: matchWalletId });

    // MISMATCH (RED / non-vacuity): same faithful retry body (so the REQUEST
    // fingerprint still matches — the failure is isolated to the wallet doc), but the
    // stored callback_url is tampered to a DIFFERENT value. Recovery now FAILS,
    // proving the recovery-integrity callback comparison is live, not vacuous.
    const mismatch = buildRoute();
    const createdMismatch = await request(mismatch.app).post('/v1/agent/wallet/create').send(body);
    expect(createdMismatch.status).toBe(201);
    const mismatchWalletId = createdMismatch.body.wallet_id as string;
    replaceField(mismatch.fake.store, `agent_wallets/${mismatchWalletId}`, 'callback_url', 'https://tampered.example/hook');
    const recoveredMismatch = await request(mismatch.app).post('/v1/agent/wallet/create')
      .send({ ...body, challenge_id: 'challenge-2', signature: 'cd'.repeat(64) });
    expect(recoveredMismatch.status).not.toBe(200);
    expect(recoveredMismatch.body.error).toBe('agent_wallet_registration_recovery_integrity_failure');
  });
});

describe(' the welcome never points a new agent at a dark MCP descriptor pre-flip', () => {
  const saved = process.env.PUBLIC_LAUNCH;
  beforeEach(() => {
    verifyPop.mockClear();
    verifyClaimsPop.mockClear();
    verifyPop.mockImplementation(async (challengeId, expected) => ({
      ok: true,
      registration_context: {
        ...expected,
        credential_recovery_generation: challengeId === 'challenge-1' ? null : 0,
      },
    }));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PUBLIC_LAUNCH; else process.env.PUBLIC_LAUNCH = saved;
  });

  test('pre-flip the MCP descriptor link is marked opens_at_launch, like its dark siblings', async () => {
    process.env.PUBLIC_LAUNCH = 'false';
    const { app } = buildRoute();
    const response = await request(app).post('/v1/agent/wallet/create').send(registrationBody({}));
    expect(response.status).toBe(201);
    const startHere = response.body.welcome.start_here;
    expect(startHere.mcp_descriptor).toEqual({ url: expect.stringMatching(/\/\.well-known\/mcp\.json$/), opens_at_launch: true });
    expect(startHere.openapi_spec).toMatchObject({ opens_at_launch: true });
  });

  test('POSITIVE PAIR — at the flip the same link is a plain live URL', async () => {
    process.env.PUBLIC_LAUNCH = 'true';
    const { app } = buildRoute();
    const response = await request(app).post('/v1/agent/wallet/create').send(registrationBody({}));
    expect(response.status).toBe(201);
    expect(response.body.welcome.start_here.mcp_descriptor).toEqual(expect.stringMatching(/\/\.well-known\/mcp\.json$/));
  });
});

describe('committed registration historical context', () => {
  beforeEach(() => { verifyPop.mockClear(); });
  test('fresh creation rejects historical context before writing any wallet', async()=>{
    const {app,fake}=buildRoute();
    const response=await request(app).post('/v1/agent/wallet/create').send(registrationBody({prior_request_context:{archived_option:'old-anchor'}}));
    expect(response.status).toBe(400);
    expect(countPrefix(fake.store,'agent_wallets')).toBe(0);
    expect(countPrefix(fake.store,AGENT_WALLET_REGISTRATION_COLLECTION)).toBe(0);
  });
  test('exact old bytes recover the same committed identity; changes and collisions refuse',async()=>{
    const {app,fake}=buildRoute();const body=registrationBody();
    const created=await request(app).post('/v1/agent/wallet/create').send(body);
    expect(created.status).toBe(201);
    const wallet=fake.store.get('agent_wallets/'+created.body.wallet_id)!;
    const context={archived_option:'old-anchor'};
    const canonical={schema_version:'agent-wallet-registration-request/v1',registration_id:body.registration_id,
      agent_name:body.agent_name,agent_id:body.agent_id,platform:body.platform,chains:['base'],callback_url:null,
      governance:wallet.governance,constitution_accepted:false,constitution_version:wallet.constitution_version,
      constitution_accepted_at:Date.parse(String(body.constitution_accepted_at)),agent_session_id:null,parent_wallet_id:null,...context};
    const digest=crypto.createHash('sha256').update(stableStringify(canonical)!).digest('hex');
    for(const [key,row]of fake.store){if(key.startsWith(AGENT_WALLET_REGISTRATION_COLLECTION+'/')||key.startsWith(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION+'/'))fake.store.set(key,{...row,request_fingerprint_sha256:digest});}
    const before=JSON.stringify([...fake.store]);
    for(const bad of [{archived_option:'different'}, {connection_token:'PROV-ABCD-2345'}, {constructor:'bad'}, {public_key:'bad'}]){
      const refused=await request(app).post('/v1/agent/wallet/create').send({...body,challenge_id:'challenge-2',prior_request_context:bad});
      expect([400,409]).toContain(refused.status);
      expect(JSON.stringify([...fake.store])).toBe(before);
    }
    const recovered=await request(app).post('/v1/agent/wallet/create').send({...body,challenge_id:'challenge-2',prior_request_context:context});
    expect(recovered.status).toBe(200);
    expect(recovered.body.wallet_id).toBe(created.body.wallet_id);
    expect(recovered.body.public_key).toBe(created.body.public_key);
    expect(countPrefix(fake.store,'agent_wallets')).toBe(1);
    expect(recovered.body.credential_recovery_generation).toBe(1);
  });
});
