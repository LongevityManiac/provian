/**
 * invariant at the relay (OPEN_ITEMS L381): `POST /v1/agent/wallet/create` hands every new
 * agent whose human is known at birth the PUBLIC key to seal its own wallet key to — including a
 * fleet-onboarded agent whose fleet code carried no anchor, and a parent-spawned child, which
 * inherits its parent's linked human. The agent seals on its own machine and escrows ciphertext
 * (SDK `resumeAgentWalletRegistration`); the relay never sees the key.
 *
 * RED controls are in-suite : each positive case has a twin where the one fact it depends
 * on is absent (the human never published) and the response carries NO anchor, so a route that
 * always attached one, or attached the parent agent's own escrow anchor, fails here.
 */

import { describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import request from 'supertest';

type RegistrationContext = {
  registration_id: string;
  agent_id: string;
  credential_recovery_generation: number | null;
};
jest.mock('../core/agent-wallet/proof-of-possession', () => ({
  ...(jest.requireActual('../core/agent-wallet/proof-of-possession') as object),
  verifyAndConsumePopChallenge: async (
    _cache: unknown,
    challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: Pick<RegistrationContext, 'registration_id' | 'agent_id'>,
  ) => ({
    ok: true,
    registration_context: {
      ...expected,
      // 'challenge-1' is a fresh create; any other challenge is the lost-response replay.
      credential_recovery_generation: challengeId === 'challenge-1' ? null : 0,
    },
  }),
  verifyAndConsumeClaimsPopChallenge: async () => ({ ok: true as const, claims: {} }),
}));

// A LINKED parent: the relationship validators are the only part of the link machinery stubbed
// (the parent's linked_human_* fields and the human wallet are real seeded documents, and the
// route's own in-transaction parent/human re-checks run unchanged).
const linkedParents = new Map<string, Record<string, unknown>>();
jest.mock('../core/agent-wallet/beneficiary-relationship', () => {
  const actual = jest.requireActual('../core/agent-wallet/beneficiary-relationship') as Record<string, unknown>;
  type Params = { wallet: { id?: unknown }; expected?: unknown };
  return {
    ...actual,
    readValidatedBeneficiaryRelationship: async (params: Params) => {
      const linked = linkedParents.get(String(params.wallet.id));
      if (linked) return linked;
      return (actual.readValidatedBeneficiaryRelationship as (p: Params) => Promise<unknown>)(params);
    },
    readValidatedBeneficiaryRelationshipInTransaction: async (params: Params) => {
      const linked = linkedParents.get(String(params.wallet.id));
      if (linked) return linked;
      return (actual.readValidatedBeneficiaryRelationshipInTransaction as (p: Params) => Promise<unknown>)(params);
    },
  };
});

import { INBOUND_WATCHER_CHECKPOINT_COLLECTION } from '../core/pvt/watcher-address-admission';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { HUMAN_RECOVERY_ANCHOR_COLLECTION } from '../core/human-recovery-anchor';
import { AGENT_RECOVERY_ESCROW_COLLECTION } from '../core/agent-recovery-escrow';
import { AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION } from '../core/agent-wallet/escrow-anchor-policy';
import type { RouterDeps } from '../core/agent-wallet/types';
import { createAgentWalletRouter } from './agent-wallet';

const PARENT_ADDRESS = `0x${'2'.repeat(40)}`;
const CHILD_ADDRESS = `0x${'8'.repeat(40)}`;
const HUMAN_USER = 'user_birth_anchor_human';
const HUMAN_WALLET = 'wallet_birth_anchor_human';
const HUMAN_ADDRESS = `0x${'5'.repeat(40)}`;
const HUMAN_ANCHOR = 'gEkuu1Yey4YjCcbdz82ahQU0I0P6_sqcZT8LV7rHoDI';
const PARENT_ESCROW_ANCHOR = 'P'.repeat(43);
const FLEET_CODE = 'PROV-FLTC-6789';

function buildRoute() {
  const fake = createFakeFirestore();
  fake.store.set(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
    chain_id: 8453, last_processed_block: 130, membership_generation: 7, updated_at: 1,
  });
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
    recordPEAccrual: jest.fn(async () => undefined),
    keccak256: (input: Buffer) => input,
    deriveAddressFromPublicKey: (publicKey: string) =>
      (publicKey.toLowerCase().startsWith('b') ? CHILD_ADDRESS : PARENT_ADDRESS),
    readBaseRegistrationHead: async () => 140,
  } as unknown as RouterDeps;
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  return { app, fake };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    registration_id: 'agent-registration-birth-anchor-0001',
    agent_name: 'Birth Anchor Agent',
    agent_id: 'birth-anchor-agent',
    platform: 'sdk',
    constitution_accepted_at: '2026-07-12T00:00:00.000Z',
    public_key: 'a'.repeat(128),
    challenge_id: 'challenge-1',
    signature: 'ab'.repeat(64),
    ...overrides,
  };
}

function childBody(parentWalletId: string, overrides: Record<string, unknown> = {}) {
  return body({
    registration_id: 'agent-registration-birth-anchor-child1',
    agent_name: 'Birth Anchor Child',
    agent_id: 'birth-anchor-child',
    public_key: 'b'.repeat(128),
    parent_wallet_id: parentWalletId,
    parent_proof_of_authorization: { challenge_id: 'parent-authority', signature: 'cd'.repeat(64) },
    ...overrides,
  });
}

function seedFleetCode(fake: ReturnType<typeof createFakeFirestore>, extra: Record<string, unknown> = {}) {
  fake.store.set(`connection_tokens/${FLEET_CODE}`, {
    token: FLEET_CODE, user_id: HUMAN_USER, kind: 'fleet',
    issued_by_agent_wallet_id: 'wallet_aw_main-agent', created_at: 1, expires_at: 2, used: false,
    ...extra,
  });
}

function publishHumanAnchor(fake: ReturnType<typeof createFakeFirestore>) {
  fake.store.set(`${HUMAN_RECOVERY_ANCHOR_COLLECTION}/${HUMAN_USER}`, {
    user_id: HUMAN_USER, recovery_anchor_pubkey: HUMAN_ANCHOR,
  });
}

/** Turn a freshly created (unlinked) parent into one linked to HUMAN_USER, with its own escrow. */
function linkParent(fake: ReturnType<typeof createFakeFirestore>, parentWalletId: string) {
  const key = `agent_wallets/${parentWalletId}`;
  const parent = fake.store.get(key)!;
  fake.store.set(key, {
    ...parent,
    linked_human_wallet_id: HUMAN_WALLET,
    linked_human_user_id: HUMAN_USER,
    linked_human_address: HUMAN_ADDRESS,
    operational_reserve_bps: 2000,
  });
  fake.store.set(`wallets/${HUMAN_WALLET}`, {
    id: HUMAN_WALLET, user_id: HUMAN_USER, type: 'human', address: HUMAN_ADDRESS, created_at: 1,
  });
  // The parent's OWN escrow — sealed to a key the parent supplied. Must never be the child's anchor.
  fake.store.set(`${AGENT_RECOVERY_ESCROW_COLLECTION}/${parentWalletId}`, {
    wallet_id: parentWalletId, sealed_key_blob: 'AQ'.repeat(40), recovery_anchor_pubkey: PARENT_ESCROW_ANCHOR,
  });
  const relationship = fake.store.get(`agent_beneficiary_relationships_v1/${parentWalletId}`) ?? {};
  linkedParents.set(parentWalletId, {
    ...relationship,
    wallet_id: parentWalletId,
    state: 'linked',
    human_wallet_id: HUMAN_WALLET,
    human_user_id: HUMAN_USER,
    human_address: HUMAN_ADDRESS,
    agent_share_bps: 2000,
  });
}

describe('fleet-onboarded agent: the create response carries its human\'s anchor at birth', () => {
  test('a fleet code that carried NO anchor (minted before the human published) → the human\'s published anchor', async () => {
    const { app, fake } = buildRoute();
    seedFleetCode(fake);
    publishHumanAnchor(fake);
    const res = await request(app).post('/v1/agent/wallet/create').send(body({ connection_token: FLEET_CODE }));
    expect(res.status).toBe(201);
    expect(res.body.recovery_anchor_pubkey).toBe(HUMAN_ANCHOR);
    // Read-only: the code is neither consumed nor rewritten.
    expect(fake.store.get(`connection_tokens/${FLEET_CODE}`)).toMatchObject({ used: false });
    expect(fake.store.get(`connection_tokens/${FLEET_CODE}`)).not.toHaveProperty('recovery_anchor_pubkey');
  });

  test('RED CONTROL: the human never published and the code carries none → no anchor (the agent waits for escrow)', async () => {
    const { app, fake } = buildRoute();
    seedFleetCode(fake);
    const res = await request(app).post('/v1/agent/wallet/create').send(body({ connection_token: FLEET_CODE }));
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('recovery_anchor_pubkey');
  });

  test('a lost create response (the replay, 200) returns the SAME birth anchor so the agent can still escrow', async () => {
    const { app, fake } = buildRoute();
    seedFleetCode(fake);
    publishHumanAnchor(fake);
    const first = await request(app).post('/v1/agent/wallet/create').send(body({ connection_token: FLEET_CODE }));
    expect(first.status).toBe(201);
    const replay = await request(app).post('/v1/agent/wallet/create')
      .send(body({ connection_token: FLEET_CODE, challenge_id: 'challenge-replay' }));
    expect(replay.status).toBe(200);
    expect(replay.body.recovered).toBe(true);
    expect(replay.body.recovery_anchor_pubkey).toBe(HUMAN_ANCHOR);
  });
});

describe('parent-spawned child: the create response carries its INHERITED human\'s anchor at birth', () => {
  test('a child of a linked parent gets the linked human\'s published anchor — never the parent\'s own escrow anchor', async () => {
    const { app, fake } = buildRoute();
    publishHumanAnchor(fake);
    const parent = await request(app).post('/v1/agent/wallet/create').send(body());
    expect(parent.status).toBe(201);
    expect(parent.body).not.toHaveProperty('recovery_anchor_pubkey'); // bare create: no human at birth
    linkParent(fake, parent.body.wallet_id);

    const child = await request(app).post('/v1/agent/wallet/create').send(childBody(parent.body.wallet_id));
    expect(child.status).toBe(201);
    expect(fake.store.get(`agent_wallets/${child.body.wallet_id}`)).toMatchObject({
      parent_wallet_id: parent.body.wallet_id,
      linked_human_user_id: HUMAN_USER,
    });
    expect(child.body.recovery_anchor_pubkey).toBe(HUMAN_ANCHOR);
    expect(child.body.recovery_anchor_pubkey).not.toBe(PARENT_ESCROW_ANCHOR);
    expect(fake.store.get(`${AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION}/${child.body.wallet_id}`)).toMatchObject({
      recovery_anchor_pubkey: HUMAN_ANCHOR, source: 'inherited_human_published',
    });

    // The child's lost-response replay resolves the same custodian.
    const replay = await request(app).post('/v1/agent/wallet/create')
      .send(childBody(parent.body.wallet_id, { challenge_id: 'challenge-child-replay' }));
    expect(replay.status).toBe(200);
    expect(replay.body.recovery_anchor_pubkey).toBe(HUMAN_ANCHOR);
  });

  test('RED CONTROL: the inherited human never published → the child gets no anchor (and never the parent\'s)', async () => {
    const { app, fake } = buildRoute();
    const parent = await request(app).post('/v1/agent/wallet/create').send(body());
    linkParent(fake, parent.body.wallet_id);
    const child = await request(app).post('/v1/agent/wallet/create').send(childBody(parent.body.wallet_id));
    expect(child.status).toBe(201);
    expect(fake.store.get(`agent_wallets/${child.body.wallet_id}`)).toMatchObject({ linked_human_user_id: HUMAN_USER });
    expect(child.body).not.toHaveProperty('recovery_anchor_pubkey');
  });

  test('RED CONTROL: a child of an UNLINKED parent with no code has no custodian at birth → no anchor', async () => {
    const { app, fake } = buildRoute();
    publishHumanAnchor(fake);
    const parent = await request(app).post('/v1/agent/wallet/create').send(body());
    const child = await request(app).post('/v1/agent/wallet/create').send(childBody(parent.body.wallet_id));
    expect(child.status).toBe(201);
    expect(fake.store.get(`agent_wallets/${child.body.wallet_id}`)).toMatchObject({ linked_human_user_id: null });
    expect(child.body).not.toHaveProperty('recovery_anchor_pubkey');
  });
});

describe('the birth anchor is recorded WITH the wallet, so the agent\'s escrow to it is accepted — and no other', () => {
  const SEALED = `AQ${'A'.repeat(100)}`;
  const OWN_KEY = 'K'.repeat(43);
  const escrow = (app: express.Express, created: request.Response, anchor: string) => request(app)
    .post(`/v1/agent/wallet/${created.body.wallet_id}/recovery-escrow`)
    .set('Authorization', `Bearer ${created.body.api_key}:${created.body.api_secret}`)
    .send({ sealed_key_blob: SEALED, recovery_anchor_pubkey: anchor });

  test('fleet-onboarded: create → birth record → escrow to that anchor is stored (the MCP / SDK birth path)', async () => {
    const { app, fake } = buildRoute();
    seedFleetCode(fake);
    publishHumanAnchor(fake);
    const created = await request(app).post('/v1/agent/wallet/create').send(body({ connection_token: FLEET_CODE }));
    expect(created.status).toBe(201);
    expect(fake.store.get(`${AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION}/${created.body.wallet_id}`)).toMatchObject({
      recovery_anchor_pubkey: HUMAN_ANCHOR, source: 'code_issuer_published',
    });
    const res = await escrow(app, created, HUMAN_ANCHOR);
    expect(res.status).toBe(200);
    expect(fake.store.get(`${AGENT_RECOVERY_ESCROW_COLLECTION}/${created.body.wallet_id}`))
      .toMatchObject({ recovery_anchor_pubkey: HUMAN_ANCHOR });
  });

  test('RED CONTROL: the same new agent escrowing to a key of its own choosing is refused (403), nothing stored', async () => {
    const { app, fake } = buildRoute();
    seedFleetCode(fake);
    publishHumanAnchor(fake);
    const created = await request(app).post('/v1/agent/wallet/create').send(body({ connection_token: FLEET_CODE }));
    const res = await escrow(app, created, OWN_KEY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('recovery_anchor_not_recognized');
    expect(fake.store.has(`${AGENT_RECOVERY_ESCROW_COLLECTION}/${created.body.wallet_id}`)).toBe(false);
  });

  test('RED CONTROL: no human at birth → no birth record, and an unlinked agent cannot self-escrow', async () => {
    const { app, fake } = buildRoute();
    const created = await request(app).post('/v1/agent/wallet/create').send(body());
    expect(created.status).toBe(201);
    expect(fake.store.has(`${AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION}/${created.body.wallet_id}`)).toBe(false);
    expect((await escrow(app, created, OWN_KEY)).status).toBe(403);
  });

  test('a replay of a wallet created before the record existed records it once (first write wins)', async () => {
    const { app, fake } = buildRoute();
    seedFleetCode(fake);
    publishHumanAnchor(fake);
    const created = await request(app).post('/v1/agent/wallet/create').send(body({ connection_token: FLEET_CODE }));
    const key = `${AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION}/${created.body.wallet_id}`;
    fake.store.delete(key); // as for a wallet born before this record
    const replay = await request(app).post('/v1/agent/wallet/create')
      .send(body({ connection_token: FLEET_CODE, challenge_id: 'challenge-replay-2' }));
    expect(replay.status).toBe(200);
    expect(fake.store.get(key)).toMatchObject({ recovery_anchor_pubkey: HUMAN_ANCHOR });
    const recorded = JSON.stringify(fake.store.get(key));
    fake.store.set(`${HUMAN_RECOVERY_ANCHOR_COLLECTION}/${HUMAN_USER}`, { user_id: HUMAN_USER, recovery_anchor_pubkey: OWN_KEY });
    await request(app).post('/v1/agent/wallet/create')
      .send(body({ connection_token: FLEET_CODE, challenge_id: 'challenge-replay-3' }));
    expect(JSON.stringify(fake.store.get(key))).toBe(recorded); // never moved by a later replay
  });
});

describe('GET /challenge?connection_token= previews the birth anchor (so a hosted agent seals before create)', () => {
  const challengeUrl = (extra: string) => '/v1/agent/wallet/challenge?public_key=' + 'a'.repeat(128)
    + '&registration_id=agent-registration-birth-anchor-0001&agent_id=birth-anchor-agent' + extra;

  test('with a code whose human published → the same anchor the create will name and record', async () => {
    const { app, fake } = buildRoute();
    seedFleetCode(fake);
    publishHumanAnchor(fake);
    const res = await request(app).get(challengeUrl(`&connection_token=${FLEET_CODE}`));
    expect(res.status).toBe(200);
    expect(typeof res.body.challenge).toBe('string');
    expect(res.body.recovery_anchor_pubkey).toBe(HUMAN_ANCHOR);
    const created = await request(app).post('/v1/agent/wallet/create').send(body({ connection_token: FLEET_CODE }));
    expect(created.body.recovery_anchor_pubkey).toBe(res.body.recovery_anchor_pubkey);
    expect(fake.store.get(`connection_tokens/${FLEET_CODE}`)).toMatchObject({ used: false }); // never consumed
  });

  test('RED CONTROL: no code, or a code whose human has not published → no anchor field', async () => {
    const { app, fake } = buildRoute();
    seedFleetCode(fake);
    const withCode = await request(app).get(challengeUrl(`&connection_token=${FLEET_CODE}`));
    expect(withCode.status).toBe(200);
    expect(withCode.body).not.toHaveProperty('recovery_anchor_pubkey');
    publishHumanAnchor(fake);
    const noCode = await request(app).get(challengeUrl(''));
    expect(noCode.status).toBe(200);
    expect(noCode.body).not.toHaveProperty('recovery_anchor_pubkey');
  });
});
