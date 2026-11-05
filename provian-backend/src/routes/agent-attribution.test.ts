/**
 * /v1/agent-attribution route tests — forge-account registration scoping +
 * revocation authority (2026-08-16 re-key).
 *
 * The load-bearing properties:
 * - a registration binds to the CALLER's own active install's forge account
 * (the re-keyed equivalent of the old owner-wallet scoping — without it,
 * forge-scoped mappings would let any wallet claim identities on someone
 * else's repos);
 * - the agent's PoP signature commits to that forge account (a challenge for
 * one scope can never be consumed to bind another);
 * - a github install can only scope a registration once its forge account is
 * STAMPED from a verified delivery;
 * - revocation is allowed to the VOUCHING WALLET ONLY (the 2026-08-16
 * install-owner extension is removed — a new install owner revoking
 * existing mappings would be orphaning by authority).
 */

import { describe, it, expect } from '@jest/globals';
import crypto from 'crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import type { AgentWalletDocument } from '../core/agent-wallet/types';
import { createAgentAttributionRouter } from './agent-attribution';
import { createFakeFirestore, type FakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import {
  createVerifiedAuthorMapping,
  normalizeAuthorKey,
} from '../core/agent-attribution/author-mappings';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const FORGE_A = '21031067';
const FORGE_B = '999999';

// Real secp256k1 keypair — the PoP create path verifies a REAL ECDSA-SHA256
// signature, so the happy path proves the whole challenge->sign->verify loop.
const { publicKey: PUB_KEY_OBJ, privateKey: PRIV_KEY_OBJ } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'secp256k1',
});
const SPKI = PUB_KEY_OBJ.export({ type: 'spki', format: 'der' });
const PUB_HEX = SPKI.subarray(SPKI.length - 64).toString('hex'); // X||Y, no 04 prefix

function signMessage(message: string): string {
  return crypto.createSign('SHA256').update(message).sign(PRIV_KEY_OBJ).toString('hex');
}

function makeFakeCache(): RedisCache {
  const map = new Map<string, unknown>();
  const cache = {
    isEnabled: () => true,
    set: async (key: string, value: unknown, _ttl: number) => { map.set(key, value); },
    get: async <T,>(key: string): Promise<T | null> =>
      map.has(key) ? (map.get(key) as T) : null,
    del: async (key: string) => { map.delete(key); },
    setNx: async (key: string, value: unknown, _ttl: number) => {
      if (map.has(key)) return false;
      map.set(key, value);
      return true;
    },
  };
  return cache as unknown as RedisCache;
}

function seedAgentWallet(fake: FakeFirestore): void {
  fake.store.set('agent_wallets/wallet_aw_atlas', {
    id: 'wallet_aw_atlas',
    agent_id: 'atlas',
    address: '0xatlas',
    status: 'active',
    public_key: PUB_HEX,
  });
}

function seedInstall(
  fake: FakeFirestore,
  params: {
    provider: 'github' | 'gitlab' | 'bitbucket';
    installationId: string;
    userId: string;
    forgeAccountId?: string | null;
    revokedAt?: number | null;
  },
): void {
  fake.store.set(`service_installs/${params.provider}_${params.installationId}`, {
    user_id: params.userId,
    provider: params.provider,
    installation_id: params.installationId,
    installed_at: Date.now(),
    revoked_at: params.revokedAt ?? null,
    ...(params.forgeAccountId
      ? { forge_account_id: params.forgeAccountId, forge_account_login: 'octocat' }
      : {}),
  });
}

/** App with the caller injected as an agent-wallet source owner. */
function makeApp(fake: FakeFirestore, cache: RedisCache, callerWalletId: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // The route only reads `.id` off the caller identity (resolveSourceOwner).
    req.agentWallet = { id: callerWalletId } as unknown as AgentWalletDocument;
    next();
  });
  app.use('/v1/agent-attribution', createAgentAttributionRouter({
    db: fake as unknown as Firestore,
    cache,
  }));
  return app;
}

const MAPPING_BODY = {
  provider: 'github',
  agent_wallet_id: 'wallet_aw_atlas',
  author_key_type: 'email',
  author_key: 'atlas@example.com',
};

// =============================================================================
// Challenge — registration scope resolution
// =============================================================================

describe('POST /author-mappings/challenge - forge-account scoping', () => {
  it('scopes to the caller\'s single active stamped github install', async () => {
    const fake = createFakeFirestore();
    seedAgentWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: 'wallet_B', forgeAccountId: FORGE_A });
    const app = makeApp(fake, makeFakeCache(), 'wallet_B');

    const res = await request(app).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    expect(res.status).toBe(200);
    expect(res.body.forge_account_id).toBe(FORGE_A);
    expect(res.body.installation_id).toBe('777');
    expect(typeof res.body.message).toBe('string');
    // The signed message commits to the forge scope.
    expect(res.body.message).toContain(`forge_account_id=${FORGE_A}`);
  });

  it('scopes a gitlab registration by installation_id directly (no stamp needed)', async () => {
    const fake = createFakeFirestore();
    seedAgentWallet(fake);
    seedInstall(fake, { provider: 'gitlab', installationId: 'proj_9', userId: 'wallet_B' });
    const app = makeApp(fake, makeFakeCache(), 'wallet_B');

    const res = await request(app).post('/v1/agent-attribution/author-mappings/challenge')
      .send({ ...MAPPING_BODY, provider: 'gitlab' });
    expect(res.status).toBe(200);
    expect(res.body.forge_account_id).toBe('proj_9');
  });

  // RED controls — every refusal is a constructible violating input:

  it('refuses an UNSTAMPED github install (self-explanatory bootstrap error)', async () => {
    const fake = createFakeFirestore();
    seedAgentWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: 'wallet_B' }); // no stamp
    const app = makeApp(fake, makeFakeCache(), 'wallet_B');

    const res = await request(app).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('install_forge_account_unknown');
    expect(res.body.detail).toContain('push once');
  });

  it('refuses when the caller has NO active install for the provider', async () => {
    const fake = createFakeFirestore();
    seedAgentWallet(fake);
    const app = makeApp(fake, makeFakeCache(), 'wallet_B');
    const res = await request(app).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_active_install_for_provider');
  });

  it('refuses an installation_id the caller does NOT own (uniform not-found, no existence oracle)', async () => {
    const fake = createFakeFirestore();
    seedAgentWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '888', userId: 'wallet_someone_else', forgeAccountId: FORGE_A });
    const app = makeApp(fake, makeFakeCache(), 'wallet_B');

    const res = await request(app).post('/v1/agent-attribution/author-mappings/challenge')
      .send({ ...MAPPING_BODY, installation_id: '888' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('install_not_found');
  });

  it('requires an explicit installation_id when multiple active installs exist, and honors it', async () => {
    const fake = createFakeFirestore();
    seedAgentWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: 'wallet_B', forgeAccountId: FORGE_A });
    seedInstall(fake, { provider: 'github', installationId: '888', userId: 'wallet_B', forgeAccountId: FORGE_B });
    const app = makeApp(fake, makeFakeCache(), 'wallet_B');

    const ambiguous = await request(app).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toBe('installation_id_required');

    const explicit = await request(app).post('/v1/agent-attribution/author-mappings/challenge')
      .send({ ...MAPPING_BODY, installation_id: '888' });
    expect(explicit.status).toBe(200);
    expect(explicit.body.forge_account_id).toBe(FORGE_B);
  });
});

// =============================================================================
// Create — PoP commits to the forge scope
// =============================================================================

describe('POST /author-mappings - PoP-bound registration', () => {
  it('registers a mapping scoped to the forge account after a REAL signature verifies', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedAgentWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: 'wallet_B', forgeAccountId: FORGE_A });
    const app = makeApp(fake, cache, 'wallet_B');

    const challenge = await request(app).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    expect(challenge.status).toBe(200);

    const res = await request(app).post('/v1/agent-attribution/author-mappings').send({
      ...MAPPING_BODY,
      challenge_id: challenge.body.challenge_id,
      signature: signMessage(challenge.body.message),
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.mapping.forge_account_id).toBe(FORGE_A);
    expect(res.body.mapping.agent_wallet_id).toBe('wallet_aw_atlas');
    expect(res.body.mapping.verified_by).toBe('agent_wallet_signature');
  });

  // RED control (the claims commit CAN fail and does): a challenge issued for
  // one forge account cannot be consumed to register under another — swap the
  // scope between challenge and create and the PoP claims check refuses.
  it('refuses a signature whose challenge was issued for a DIFFERENT forge account', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedAgentWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: 'wallet_B', forgeAccountId: FORGE_A });
    seedInstall(fake, { provider: 'github', installationId: '888', userId: 'wallet_B', forgeAccountId: FORGE_B });
    const app = makeApp(fake, cache, 'wallet_B');

    const challenge = await request(app).post('/v1/agent-attribution/author-mappings/challenge')
      .send({ ...MAPPING_BODY, installation_id: '777' }); // scope FORGE_A
    expect(challenge.status).toBe(200);

    const res = await request(app).post('/v1/agent-attribution/author-mappings').send({
      ...MAPPING_BODY,
      installation_id: '888', // scope FORGE_B — different claims
      challenge_id: challenge.body.challenge_id,
      signature: signMessage(challenge.body.message),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Agent key proof failed');
    // Nothing persisted.
    const mappings = [...fake.store.keys()].filter((k) => k.startsWith('agent_author_mappings/'));
    expect(mappings).toHaveLength(0);
  });

  it('refuses registration when the caller owns no install (ownership is load-bearing)', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedAgentWallet(fake);
    // The install exists but belongs to someone else.
    seedInstall(fake, { provider: 'github', installationId: '777', userId: 'wallet_owner', forgeAccountId: FORGE_A });
    const app = makeApp(fake, cache, 'wallet_intruder');

    const res = await request(app).post('/v1/agent-attribution/author-mappings').send({
      ...MAPPING_BODY,
      installation_id: '777',
      challenge_id: 'irrelevant',
      signature: 'aa'.repeat(32),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('install_not_found');
  });
});

// =============================================================================
// Revoke — authority extension
// =============================================================================

describe('DELETE /author-mappings/:mapping_id - authority', () => {
  async function seedMappingVouchedByDeadWallet(fake: FakeFirestore): Promise<string> {
    const doc = await createVerifiedAuthorMapping(fake as unknown as Firestore, {
      provider: 'github',
      forgeAccountId: FORGE_A,
      forgeAccountLogin: 'octocat',
      sourceOwnerWalletId: 'wallet_dead',
      agentWalletId: 'wallet_aw_atlas',
      agentId: 'atlas',
      agentAddress: '0xatlas',
      authorKey: normalizeAuthorKey({ type: 'email', value: 'atlas@example.com' })!,
    });
    return doc.mapping_id;
  }

  it('the vouching wallet may revoke', async () => {
    const fake = createFakeFirestore();
    const mappingId = await seedMappingVouchedByDeadWallet(fake);
    const app = makeApp(fake, makeFakeCache(), 'wallet_dead');
    const res = await request(app).delete(`/v1/agent-attribution/author-mappings/${mappingId}`);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
  });

  // THE 08-13 REPLAY : wallet_dead is gone; wallet_B owns the
  // re-installed row on the same forge account. The removed extension honored
  // exactly this claim; it must now be REFUSED — removal by a new install
  // owner is orphaning by authority.
  it('the new owner of the re-installed row on the same forge account may NOT revoke', async () => {
    const fake = createFakeFirestore();
    const mappingId = await seedMappingVouchedByDeadWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: 'wallet_B', forgeAccountId: FORGE_A });
    const app = makeApp(fake, makeFakeCache(), 'wallet_B');
    const res = await request(app).delete(`/v1/agent-attribution/author-mappings/${mappingId}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_mapping_owner');
    expect(fake.store.get(`agent_author_mappings/${mappingId}`)?.status).toBe('active');
  });

  // RED control: an unrelated wallet — even one with an active install on a
  // DIFFERENT forge account — is refused.
  it('an unrelated wallet may NOT revoke', async () => {
    const fake = createFakeFirestore();
    const mappingId = await seedMappingVouchedByDeadWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '888', userId: 'wallet_stranger', forgeAccountId: FORGE_B });
    const app = makeApp(fake, makeFakeCache(), 'wallet_stranger');
    const res = await request(app).delete(`/v1/agent-attribution/author-mappings/${mappingId}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_mapping_owner');
    expect(fake.store.get(`agent_author_mappings/${mappingId}`)?.status).toBe('active');
  });
});

// =============================================================================
// Part 2 — linked-agent self-registration (per-owner scope preserved)
// =============================================================================
//
// The human's accepted beneficiary link is the owner's standing authorization
// for THAT agent to bind ITS OWN git identity on the owner's install. Every
// refusal below is a constructible violating caller — an unlinked agent, an
// agent linked to a different human, a linked agent naming a different target,
// a half-set link — so each guard has been observed RED.

const HUMAN_USER = 'frank';
const HUMAN_WALLET = 'wallet_frank';

function seedHumanWallet(fake: FakeFirestore, walletId = HUMAN_WALLET, userId = HUMAN_USER): void {
  fake.store.set(`wallets/${walletId}`, {
    id: walletId, user_id: userId, type: 'human', address: `0x${walletId}`,
  });
}

type Caller =
  | { kind: 'agent'; wallet: Partial<AgentWalletDocument> & { id: string } }
  | { kind: 'human'; userId: string };

function makeCallerApp(fake: FakeFirestore, cache: RedisCache, caller: Caller): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (caller.kind === 'agent') {
      req.agentWallet = caller.wallet as unknown as AgentWalletDocument;
    } else {
      req.user = { id: caller.userId } as unknown as NonNullable<Request['user']>;
    }
    next();
  });
  app.use('/v1/agent-attribution', createAgentAttributionRouter({
    db: fake as unknown as Firestore,
    cache,
  }));
  return app;
}

const ATLAS_LINKED: Caller = {
  kind: 'agent',
  wallet: { id: 'wallet_aw_atlas', linked_human_wallet_id: HUMAN_WALLET, linked_human_user_id: HUMAN_USER },
};
const ATLAS_UNLINKED: Caller = {
  kind: 'agent',
  wallet: { id: 'wallet_aw_atlas', linked_human_wallet_id: null, linked_human_user_id: null },
};
const ATLAS_LINKED_ELSEWHERE: Caller = {
  kind: 'agent',
  wallet: { id: 'wallet_aw_atlas', linked_human_wallet_id: 'wallet_other_human', linked_human_user_id: 'other' },
};
const ATLAS_HALF_LINKED: Caller = {
  kind: 'agent',
  wallet: { id: 'wallet_aw_atlas', linked_human_wallet_id: HUMAN_WALLET, linked_human_user_id: null },
};

function mappingKeys(fake: FakeFirestore): string[] {
  return [...fake.store.keys()].filter((k) => k.startsWith('agent_author_mappings/'));
}

describe('linked agent self-registration on its human\'s install (F59: no longer permitted alone)', () => {
  // F59 (S2 2026-09-10) RED control (inverts the former Part 2 grant): a
  // LINKED agent's OWN /challenge no longer reaches its human's install. Nothing
  // here can verify the caller-supplied author_key IS the agent's own git
  // identity, so a linked agent could otherwise bind ANY key (e.g. the human's
  // top contributor's email) on the human's install. The scope is the caller's
  // own installs only; binding on the human's install requires the two-party
  // handoff (human issues, agent completes) exercised in the describe below.
  it('a LINKED agent\'s own challenge does NOT reach its human\'s install (implicit → no install; explicit → 404), and binds nothing', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedAgentWallet(fake);
    seedHumanWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: HUMAN_WALLET, forgeAccountId: FORGE_A });
    const app = makeCallerApp(fake, cache, ATLAS_LINKED);

    // Implicit: the agent owns no install of its own → no candidate resolves.
    const implicit = await request(app).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    expect(implicit.status).toBe(404);
    expect(implicit.body.error).toBe('no_active_install_for_provider');

    // Explicit: naming the human's install id is a uniform 404 (not owned by the
    // agent) — never mints a challenge with the human as source_owner.
    const explicit = await request(app).post('/v1/agent-attribution/author-mappings/challenge')
      .send({ ...MAPPING_BODY, installation_id: '777' });
    expect(explicit.status).toBe(404);
    expect(explicit.body.error).toBe('install_not_found');

    // The create leg is equally scoped — no mapping is ever written.
    const create = await request(app).post('/v1/agent-attribution/author-mappings').send({
      ...MAPPING_BODY, installation_id: '777', challenge_id: 'x', signature: 'aa'.repeat(32),
    });
    expect(create.status).toBe(404);
    expect(mappingKeys(fake)).toHaveLength(0);
  });

  it('RED: an UNLINKED agent cannot register on that install (implicit → no install; explicit → uniform 404)', async () => {
    const fake = createFakeFirestore();
    seedAgentWallet(fake);
    seedHumanWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: HUMAN_WALLET, forgeAccountId: FORGE_A });
    const app = makeCallerApp(fake, makeFakeCache(), ATLAS_UNLINKED);

    const implicit = await request(app).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    expect(implicit.status).toBe(404);
    expect(implicit.body.error).toBe('no_active_install_for_provider');

    const explicit = await request(app).post('/v1/agent-attribution/author-mappings/challenge')
      .send({ ...MAPPING_BODY, installation_id: '777' });
    expect(explicit.status).toBe(404);
    expect(explicit.body.error).toBe('install_not_found');
  });

  it('RED: an agent linked to a DIFFERENT human cannot register on this human\'s install', async () => {
    const fake = createFakeFirestore();
    seedAgentWallet(fake);
    seedHumanWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: HUMAN_WALLET, forgeAccountId: FORGE_A });
    const app = makeCallerApp(fake, makeFakeCache(), ATLAS_LINKED_ELSEWHERE);

    const res = await request(app).post('/v1/agent-attribution/author-mappings/challenge')
      .send({ ...MAPPING_BODY, installation_id: '777' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('install_not_found');
  });

  it('RED: a linked agent may NOT use the link to register ANOTHER agent on the human\'s install', async () => {
    const fake = createFakeFirestore();
    seedAgentWallet(fake);
    fake.store.set('agent_wallets/wallet_aw_other', {
      id: 'wallet_aw_other', agent_id: 'other', address: '0xother', status: 'active', public_key: PUB_HEX,
    });
    seedHumanWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: HUMAN_WALLET, forgeAccountId: FORGE_A });
    const app = makeCallerApp(fake, makeFakeCache(), ATLAS_LINKED);

    const res = await request(app).post('/v1/agent-attribution/author-mappings/challenge')
      .send({ ...MAPPING_BODY, agent_wallet_id: 'wallet_aw_other', installation_id: '777' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('install_not_found');
  });

  it('RED: a half-set link (wallet id without user id) authorizes nothing', async () => {
    const fake = createFakeFirestore();
    seedAgentWallet(fake);
    seedHumanWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: HUMAN_WALLET, forgeAccountId: FORGE_A });
    const app = makeCallerApp(fake, makeFakeCache(), ATLAS_HALF_LINKED);

    const res = await request(app).post('/v1/agent-attribution/author-mappings/challenge')
      .send({ ...MAPPING_BODY, installation_id: '777' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('install_not_found');
  });

  it('the create leg enforces the same scope: an unlinked agent is refused before any signature check', async () => {
    const fake = createFakeFirestore();
    seedAgentWallet(fake);
    seedHumanWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: HUMAN_WALLET, forgeAccountId: FORGE_A });
    const app = makeCallerApp(fake, makeFakeCache(), ATLAS_UNLINKED);

    const res = await request(app).post('/v1/agent-attribution/author-mappings').send({
      ...MAPPING_BODY, installation_id: '777', challenge_id: 'x', signature: 'aa'.repeat(32),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('install_not_found');
    expect(mappingKeys(fake)).toHaveLength(0);
  });
});

// =============================================================================
// Part 2 — two-party completion (owner issues, agent signs via the relay)
// =============================================================================

describe('owner-issued challenge completed by the target agent', () => {
  const { publicKey: OTHER_PUB, privateKey: OTHER_PRIV } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
  });
  const OTHER_SPKI = OTHER_PUB.export({ type: 'spki', format: 'der' });
  const OTHER_PUB_HEX = OTHER_SPKI.subarray(OTHER_SPKI.length - 64).toString('hex');
  const signWithOther = (message: string): string =>
    crypto.createSign('SHA256').update(message).sign(OTHER_PRIV).toString('hex');

  function seedTwoParty(fake: FakeFirestore): void {
    seedAgentWallet(fake);
    seedHumanWallet(fake);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: HUMAN_WALLET, forgeAccountId: FORGE_A });
    fake.store.set('agent_wallets/wallet_aw_other', {
      id: 'wallet_aw_other', agent_id: 'other', address: '0xother', status: 'active', public_key: OTHER_PUB_HEX,
    });
  }

  const COMPLETE_BODY = { author_key_type: 'email', author_key: 'atlas@example.com' };

  it('the owner issues; the (unlinked) target agent reads the challenge and completes under its OWN auth', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedTwoParty(fake);
    const ownerApp = makeCallerApp(fake, cache, { kind: 'human', userId: HUMAN_USER });
    const issued = await request(ownerApp).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    expect(issued.status).toBe(200);
    expect(issued.body.source_owner_type).toBe('human');

    const agentApp = makeCallerApp(fake, cache, ATLAS_UNLINKED);
    const read = await request(agentApp).get(`/v1/agent-attribution/author-mappings/challenge/${issued.body.challenge_id}`);
    expect(read.status).toBe(200);
    expect(read.body.message).toBe(issued.body.message);
    expect(read.body.claims.source_owner_wallet_id).toBe(HUMAN_WALLET);
    expect(read.body.claims.agent_wallet_id).toBe('wallet_aw_atlas');

    const done = await request(agentApp).post('/v1/agent-attribution/author-mappings/complete').send({
      ...COMPLETE_BODY,
      challenge_id: issued.body.challenge_id,
      signature: signMessage(read.body.message),
    });
    expect(done.status).toBe(201);
    expect(done.body.mapping.source_owner_wallet_id).toBe(HUMAN_WALLET);
    expect(done.body.mapping.agent_wallet_id).toBe('wallet_aw_atlas');
    expect(done.body.mapping.forge_account_id).toBe(FORGE_A);
    // The stored key is the normalized VALUE the agent supplied, hashed to the commitment.
    const stored = fake.store.get(`agent_author_mappings/${done.body.mapping.mapping_id}`);
    expect(stored?.author_key).toBe('atlas@example.com');
    expect(stored?.author_key_hash).toBe(issued.body.author_key_hash);

    // Single-use: the challenge is consumed.
    const again = await request(agentApp).post('/v1/agent-attribution/author-mappings/complete').send({
      ...COMPLETE_BODY, challenge_id: issued.body.challenge_id, signature: signMessage(read.body.message),
    });
    expect(again.status).toBe(404);
  });

  it('RED: a DIFFERENT agent can neither read nor complete the owner\'s challenge (uniform 404)', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedTwoParty(fake);
    const ownerApp = makeCallerApp(fake, cache, { kind: 'human', userId: HUMAN_USER });
    const issued = await request(ownerApp).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);

    const otherApp = makeCallerApp(fake, cache, { kind: 'agent', wallet: { id: 'wallet_aw_other' } });
    const read = await request(otherApp).get(`/v1/agent-attribution/author-mappings/challenge/${issued.body.challenge_id}`);
    expect(read.status).toBe(404);
    const done = await request(otherApp).post('/v1/agent-attribution/author-mappings/complete').send({
      ...COMPLETE_BODY, challenge_id: issued.body.challenge_id, signature: signWithOther(issued.body.message),
    });
    expect(done.status).toBe(404);
    expect(mappingKeys(fake)).toHaveLength(0);
  });

  it('RED: an author key VALUE that does not hash to the committed hash is refused, nothing persisted', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedTwoParty(fake);
    const ownerApp = makeCallerApp(fake, cache, { kind: 'human', userId: HUMAN_USER });
    const issued = await request(ownerApp).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    const agentApp = makeCallerApp(fake, cache, ATLAS_UNLINKED);
    const done = await request(agentApp).post('/v1/agent-attribution/author-mappings/complete').send({
      author_key_type: 'email', author_key: 'someone-else@example.com',
      challenge_id: issued.body.challenge_id, signature: signMessage(issued.body.message),
    });
    expect(done.status).toBe(400);
    expect(done.body.error).toBe('author_key_mismatch');
    expect(mappingKeys(fake)).toHaveLength(0);
  });

  it('RED: the owner\'s install revoked between issue and completion → uniform 404, nothing persisted', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedTwoParty(fake);
    const ownerApp = makeCallerApp(fake, cache, { kind: 'human', userId: HUMAN_USER });
    const issued = await request(ownerApp).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    seedInstall(fake, { provider: 'github', installationId: '777', userId: HUMAN_WALLET, forgeAccountId: FORGE_A, revokedAt: Date.now() });
    const agentApp = makeCallerApp(fake, cache, ATLAS_UNLINKED);
    const done = await request(agentApp).post('/v1/agent-attribution/author-mappings/complete').send({
      ...COMPLETE_BODY, challenge_id: issued.body.challenge_id, signature: signMessage(issued.body.message),
    });
    expect(done.status).toBe(404);
    expect(done.body.error).toBe('install_not_found');
    expect(mappingKeys(fake)).toHaveLength(0);
  });

  it('RED: a signature by the wrong key fails the proof, nothing persisted', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedTwoParty(fake);
    const ownerApp = makeCallerApp(fake, cache, { kind: 'human', userId: HUMAN_USER });
    const issued = await request(ownerApp).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    const agentApp = makeCallerApp(fake, cache, ATLAS_UNLINKED);
    const done = await request(agentApp).post('/v1/agent-attribution/author-mappings/complete').send({
      ...COMPLETE_BODY, challenge_id: issued.body.challenge_id, signature: signWithOther(issued.body.message),
    });
    expect(done.status).toBe(400);
    expect(done.body.error).toBe('Agent key proof failed');
    expect(mappingKeys(fake)).toHaveLength(0);
  });

  it('RED: a human caller cannot read or complete (agent-auth surface only)', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedTwoParty(fake);
    const ownerApp = makeCallerApp(fake, cache, { kind: 'human', userId: HUMAN_USER });
    const issued = await request(ownerApp).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    const read = await request(ownerApp).get(`/v1/agent-attribution/author-mappings/challenge/${issued.body.challenge_id}`);
    expect(read.status).toBe(401);
    const done = await request(ownerApp).post('/v1/agent-attribution/author-mappings/complete').send({
      ...COMPLETE_BODY, challenge_id: issued.body.challenge_id, signature: signMessage(issued.body.message),
    });
    expect(done.status).toBe(401);
  });

  // Once a mapping exists (created through the F59-valid two-party handoff), the
  // visibility and revocation surfaces behave as before — these formerly rode the
  // now-removed linked-agent self-registration path (F59) and were re-based here.
  async function createViaTwoParty(fake: FakeFirestore, cache: RedisCache): Promise<string> {
    const ownerApp = makeCallerApp(fake, cache, { kind: 'human', userId: HUMAN_USER });
    const issued = await request(ownerApp).post('/v1/agent-attribution/author-mappings/challenge').send(MAPPING_BODY);
    const agentApp = makeCallerApp(fake, cache, ATLAS_UNLINKED);
    const read = await request(agentApp).get(`/v1/agent-attribution/author-mappings/challenge/${issued.body.challenge_id}`);
    const created = await request(agentApp).post('/v1/agent-attribution/author-mappings/complete').send({
      ...COMPLETE_BODY, challenge_id: issued.body.challenge_id, signature: signMessage(read.body.message),
    });
    expect(created.status).toBe(201);
    return created.body.mapping.mapping_id;
  }

  it('the human sees the mapping in its Contributors list; the agent sees it under the named-agent leg', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedTwoParty(fake);
    const mappingId = await createViaTwoParty(fake, cache);

    const humanApp = makeCallerApp(fake, cache, { kind: 'human', userId: HUMAN_USER });
    const humanList = await request(humanApp).get('/v1/agent-attribution/author-mappings');
    expect(humanList.status).toBe(200);
    expect(humanList.body.source_owner_wallet_id).toBe(HUMAN_WALLET);
    expect(humanList.body.mappings.map((m: { mapping_id: string }) => m.mapping_id)).toEqual([mappingId]);

    const agentApp = makeCallerApp(fake, cache, ATLAS_UNLINKED);
    const agentList = await request(agentApp).get('/v1/agent-attribution/author-mappings');
    expect(agentList.body.count).toBe(1);
    expect(agentList.body.mappings[0].agent_wallet_id).toBe('wallet_aw_atlas');

    // RED: a stranger agent sees neither leg.
    const strangerApp = makeCallerApp(fake, cache, { kind: 'agent', wallet: { id: 'wallet_aw_stranger' } });
    const strangerList = await request(strangerApp).get('/v1/agent-attribution/author-mappings');
    expect(strangerList.body.count).toBe(0);
  });

  it('revocation: the named agent may withdraw its own binding; another agent may NOT; the vouching human may', async () => {
    const fake = createFakeFirestore();
    const cache = makeFakeCache();
    seedTwoParty(fake);
    const mappingId = await createViaTwoParty(fake, cache);

    // RED: a different agent (not named, not vouching) is refused.
    const otherApp = makeCallerApp(fake, cache, { kind: 'agent', wallet: { id: 'wallet_aw_other' } });
    const refused = await request(otherApp).delete(`/v1/agent-attribution/author-mappings/${mappingId}`);
    expect(refused.status).toBe(403);
    expect(fake.store.get(`agent_author_mappings/${mappingId}`)?.status).toBe('active');

    // RED: a HUMAN caller whose wallets doc id happens to equal the agent_wallet_id
    // gets no self-revocation leg — the named-agent leg is agent-auth only.
    fake.store.set('wallets/wallet_aw_atlas', { id: 'wallet_aw_atlas', user_id: 'impostor', type: 'human' });
    const impostorApp = makeCallerApp(fake, cache, { kind: 'human', userId: 'impostor' });
    const impostor = await request(impostorApp).delete(`/v1/agent-attribution/author-mappings/${mappingId}`);
    expect(impostor.status).toBe(403);
    expect(fake.store.get(`agent_author_mappings/${mappingId}`)?.status).toBe('active');

    const agentApp = makeCallerApp(fake, cache, ATLAS_UNLINKED);
    const selfRevoke = await request(agentApp).delete(`/v1/agent-attribution/author-mappings/${mappingId}`);
    expect(selfRevoke.status).toBe(200);
    expect(fake.store.get(`agent_author_mappings/${mappingId}`)?.status).toBe('revoked');

    // The vouching human may revoke too (idempotent on an already-revoked row).
    const humanApp = makeCallerApp(fake, cache, { kind: 'human', userId: HUMAN_USER });
    const humanRevoke = await request(humanApp).delete(`/v1/agent-attribution/author-mappings/${mappingId}`);
    expect(humanRevoke.status).toBe(200);
  });
});
