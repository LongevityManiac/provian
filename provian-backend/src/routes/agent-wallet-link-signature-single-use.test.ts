/**
 * link, unlink and share-change signatures are SINGLE-USE.
 *
 * End to end through the real routes AND the real bind / unbind / share helpers (only PE generation
 * and badge evaluation are stubbed; the relationship revision, its in-transaction compare, and the
 * consumed-signature record are all real). Before each route verified the human's EIP-191
 * signature over `{action, agent_wallet_id, human_wallet_id, [operational_reserve_bps], timestamp}`
 * with a ±5 min window and nothing else, so inside the window:
 * - link → unlink → REPLAY the link signature → re-linked;
 * - share A → share B → REPLAY A → share reverted to A;
 * - an unlink signed earlier, applied AFTER a relink → the new link ended.
 *
 * Now every payload names `link_epoch` (the relationship revision; `GET /:wallet_id/link-epoch`),
 * every transition advances it in the same transaction, and the signed payload is consumed in that
 * transaction. RED controls below: each replay is refused 409 and the state does not move.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../core/agent-bank/pe-utils', () => ({
  generatePE: jest.fn(async (
    deps: {
      db: {
        collection: (name: string) => { doc: (id: string) => unknown };
        store: Map<string, Record<string, unknown>>;
        runTransaction: <T>(fn: (txn: unknown) => Promise<T>) => Promise<T>;
      };
    },
    params: {
      atomicEntityPrecondition?: (txn: unknown, context: { prevHash: string }) => Promise<void>;
      atomicEntityWrite?: (txn: unknown, peId: string, context: { prevHash: string; newHash: string; timestamp: number }) => void;
      timestampOverride?: number;
      walletId: string;
      agentId: string;
      actorAddress: string;
      actionType: string;
      metadata: Record<string, unknown>;
    },
  ) => {
    const crypto = jest.requireActual<typeof import('crypto')>('crypto');
    const stableStringify = jest.requireActual<typeof import('json-stable-stringify')>('json-stable-stringify');
    const counter = (deps.db.store.get('__pe_counter') as { n?: number } | undefined)?.n ?? 0;
    deps.db.store.set('__pe_counter', { n: counter + 1 });
    const peId = `pe_${params.actionType}_${counter + 1}`;
    const timestamp = params.timestampOverride ?? Date.now();
    const tip = deps.db.store.get(`pe_chain_tips/${params.agentId}`);
    const prevHash = typeof tip?.hash === 'string' ? tip.hash : '0x0000';
    const canonical = {
      id: peId, wallet_id: params.walletId, agent_id: params.agentId, action_type: params.actionType,
      actor_address: params.actorAddress.toLowerCase(), timestamp, prev_hash: prevHash,
      attestation_type: 'software', metadata: params.metadata, compute: null, geo: null,
      execution_env: null, cited_pe_ids: null, parent_goal_pe_id: null,
    };
    const peHash = crypto.createHash('sha256').update(stableStringify(canonical) || '', 'utf8').digest('hex');
    await deps.db.runTransaction(async (txn: any) => {
      await params.atomicEntityPrecondition?.(txn, { prevHash });
      txn.set(deps.db.collection('identity_pes_legacy_v1').doc(peId), {
        ...canonical, hash: peHash, user_id: params.agentId, policy_action_type: params.actionType,
        integration_source: 'agent_bank_generate_pe', counterparty_address: null, counterparty_type: null,
        session_lineage: null, self_referencing: false, trust_level_at_creation: null, created_at: timestamp,
        durability: 'final',
      });
      txn.set(deps.db.collection('pe_chain_tips').doc(params.agentId), { hash: peHash, user_id: params.agentId, updated_at: timestamp, last_pe_timestamp: timestamp });
      params.atomicEntityWrite?.(txn, peId, { prevHash, newHash: peHash, timestamp });
    });
    return { peId, peHash, prevHash };
  }),
}));
jest.mock('../core/agent-wallet/badges', () => ({
  ...(jest.requireActual('../core/agent-wallet/badges') as object),
  evaluateBadges: jest.fn(() => []),
}));

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-key';

import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import stableStringify from 'json-stable-stringify';
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import { canonicalAgentPeHash } from '../core/agent-wallet/canonical-agent-pe-chain';
import { canonicalLinkSignaturePayload, LINK_SIGNATURE_CONSUMPTIONS_COLLECTION } from '../core/agent-wallet/link-signature';
import { createAgentWalletRouter } from './agent-wallet';
import type { RouterDeps } from '../core/agent-wallet/types';

type Doc = Record<string, unknown>;

function applyUpdate(current: Doc, update: Doc): Doc {
  const next = { ...current };
  for (const [key, value] of Object.entries(update)) {
    if (value && typeof value === 'object' && value.constructor.name === 'DeleteTransform') delete next[key];
    else next[key] = value;
  }
  return next;
}

class StubFirestore {
  store = new Map<string, Doc>();
  collection(name: string) {
    return {
      where: (field: string, _op: string, value: unknown) => ({
        limit: () => this.collection(name).where(field, _op, value),
        get: async () => {
          const prefix = `${name}/`;
          const docs = [...this.store.entries()]
            .filter(([key, data]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/') && data[field] === value)
            .map(([key, data]) => ({ id: key.slice(prefix.length), exists: true, data: () => data }));
          return { empty: docs.length === 0, size: docs.length, docs };
        },
      }),
      doc: (id: string) => ({
        id,
        __path: `${name}/${id}`,
        get: async () => {
          const data = this.store.get(`${name}/${id}`);
          return { id, exists: data !== undefined, data: () => data };
        },
        set: async (data: Doc) => { this.store.set(`${name}/${id}`, { ...data }); },
        update: async (data: Doc) => { this.store.set(`${name}/${id}`, applyUpdate(this.store.get(`${name}/${id}`) ?? {}, data)); },
        collection: (sub: string) => this.collection(`${name}/${id}/${sub}`),
      }),
    };
  }
  async runTransaction<T>(fn: (txn: StubTxn) => Promise<T>): Promise<T> {
    // All-or-nothing: writes land only if the callback resolves.
    const txn = new StubTxn(this.store);
    const out = await fn(txn);
    txn.commit();
    return out;
  }
}

class StubTxn {
  private pending: Array<() => void> = [];
  constructor(private store: Map<string, Doc>) {}
  async get(ref: { __path: string }) {
    const data = this.store.get(ref.__path);
    return { id: ref.__path.slice(ref.__path.lastIndexOf('/') + 1), exists: data !== undefined, data: () => data };
  }
  update(ref: { __path: string }, data: Doc) { this.pending.push(() => this.store.set(ref.__path, applyUpdate(this.store.get(ref.__path) ?? {}, data))); }
  set(ref: { __path: string }, data: Doc) { this.pending.push(() => this.store.set(ref.__path, { ...data })); }
  create(ref: { __path: string }, data: Doc) {
    this.pending.push(() => {
      if (this.store.has(ref.__path)) throw new Error('ALREADY_EXISTS');
      this.store.set(ref.__path, { ...data });
    });
  }
  commit() { for (const w of this.pending) w(); }
}

const AGENT_ADDRESS = `0x${'a'.repeat(40)}`;
const WALLET_ID = 'wallet_aw_link';
const AGENT_ID = 'agent_link';
const HUMAN_WALLET_ID = 'wallet_human_link';
const HUMAN_USER_ID = 'user_human_link';

function seed(db: StubFirestore, humanAddress: string): string {
  const creds = generateApiCredentials();
  db.store.set(`agent_wallets/${WALLET_ID}`, {
    id: WALLET_ID, agent_id: AGENT_ID, address: AGENT_ADDRESS, status: 'active', badges: [],
    linked_human_wallet_id: null, linked_human_user_id: null, linked_human_address: null,
    operational_reserve_ratio: null, parent_wallet_id: null, attestation_count: 1, streak_days: 0, updated_at: 1,
    api_key_hash: creds.api_key_hash, api_key_salt: creds.api_key_salt, api_key_prefix: creds.api_key_prefix,
  });
  db.store.set(`api_key_index/${creds.api_key_prefix}`, { wallet_id: WALLET_ID });
  db.store.set(`wallets/${HUMAN_WALLET_ID}`, { id: HUMAN_WALLET_ID, type: 'human', user_id: HUMAN_USER_ID, address: humanAddress });
  const relationship = {
    schema_version: 'agent-beneficiary-relationship/v1', wallet_id: WALLET_ID, agent_id: AGENT_ID, state: 'unlinked',
    human_wallet_id: null, human_user_id: null, human_address: null, operational_reserve_ratio: null,
    parent_wallet_id: null, revision: 1, source_action_type: 'agent_wallet_created', source_pe_id: 'pe_birth',
    source_pe_hash: '', created_at_ms: 1, updated_at_ms: 1,
  };
  const canonical = {
    id: 'pe_birth', wallet_id: WALLET_ID, agent_id: AGENT_ID, action_type: 'agent_wallet_created',
    actor_address: AGENT_ADDRESS, timestamp: 1, prev_hash: '0x0000', attestation_type: 'software',
    metadata: { beneficiary_relationship: { state: 'unlinked', human_wallet_id: null, human_user_id: null, human_address: null, operational_reserve_ratio: null, parent_wallet_id: null, revision: 1 } },
    compute: null, geo: null, execution_env: null, cited_pe_ids: null, parent_goal_pe_id: null,
  };
  const sourceHash = canonicalAgentPeHash(canonical);
  relationship.source_pe_hash = sourceHash;
  db.store.set(`agent_beneficiary_relationships_v1/${WALLET_ID}`, relationship);
  db.store.set('identity_pes_legacy_v1/pe_birth', {
    ...canonical, hash: sourceHash, user_id: AGENT_ID, policy_action_type: 'wallet_created', integration_source: 'agent_bank_generate_pe',
    counterparty_address: null, counterparty_type: null, session_lineage: null, self_referencing: false,
    trust_level_at_creation: null, created_at: 1, durability: 'final',
  });
  db.store.set(`pe_chain_tips/${AGENT_ID}`, { hash: sourceHash, user_id: AGENT_ID, updated_at: 1 });
  return `Bearer ${creds.api_key}:${creds.api_secret}`;
}

function build() {
  const db = new StubFirestore();
  const human = ethers.Wallet.createRandom();
  const bearer = seed(db, human.address);
  const deps = {
    db,
    cache: {
      checkRateLimit: jest.fn(async () => ({ allowed: true, retryAfter: 0 })),
      checkRateLimitStrict: jest.fn(async () => ({ allowed: true, current: 0, limit: 5 })),
      isEnabled: () => true,
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
      del: jest.fn(async () => undefined),
      invalidateBeneficiaryStatus: jest.fn(async () => undefined),
    },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => '0xderived',
  } as unknown as RouterDeps;
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  return { app, db, human, bearer };
}

type Ctx = ReturnType<typeof build>;

async function epoch(ctx: Ctx): Promise<number> {
  const res = await request(ctx.app).get(`/v1/agent/wallet/${WALLET_ID}/link-epoch`).set('Authorization', ctx.bearer);
  expect(res.status).toBe(200);
  return res.body.link_epoch as number;
}

async function sign(ctx: Ctx, payload: Record<string, unknown>): Promise<string> {
  return ctx.human.signMessage(stableStringify(payload) || '');
}

async function signedLink(ctx: Ctx, linkEpoch: number) {
  const timestamp = Date.now();
  const signature = await sign(ctx, { action: 'link_agent', agent_wallet_id: WALLET_ID, human_wallet_id: HUMAN_WALLET_ID, link_epoch: linkEpoch, timestamp });
  return { human_wallet_id: HUMAN_WALLET_ID, signature, timestamp, link_epoch: linkEpoch };
}
async function signedUnlink(ctx: Ctx, linkEpoch: number) {
  const timestamp = Date.now();
  const signature = await sign(ctx, { action: 'unlink_agent', agent_wallet_id: WALLET_ID, human_wallet_id: HUMAN_WALLET_ID, link_epoch: linkEpoch, timestamp });
  return { signature, timestamp, link_epoch: linkEpoch };
}
async function signedShare(ctx: Ctx, linkEpoch: number, bps: number) {
  const timestamp = Date.now();
  const signature = await sign(ctx, { action: 'update_beneficiary_share', agent_wallet_id: WALLET_ID, human_wallet_id: HUMAN_WALLET_ID, link_epoch: linkEpoch, operational_reserve_bps: bps, timestamp });
  return { signature, timestamp, link_epoch: linkEpoch, operational_reserve_bps: bps };
}

const post = (ctx: Ctx, path: string, body: object) => request(ctx.app).post(`/v1/agent/wallet/${WALLET_ID}/${path}`).set('Authorization', ctx.bearer).send(body);
const put = (ctx: Ctx, body: object) => request(ctx.app).put(`/v1/agent/wallet/${WALLET_ID}/link-human`).set('Authorization', ctx.bearer).send(body);
const agentDoc = (ctx: Ctx) => ctx.db.store.get(`agent_wallets/${WALLET_ID}`) as Doc;
const consumptions = (ctx: Ctx) => [...ctx.db.store.keys()].filter((k) => k.startsWith(`${LINK_SIGNATURE_CONSUMPTIONS_COLLECTION}/`));

describe('link / unlink / share-change signatures are single-use', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = build(); });

  it('a fresh signature over the current epoch links; the epoch advances and the payload is consumed', async () => {
    expect(await epoch(ctx)).toBe(1);
    const res = await post(ctx, 'link-human', await signedLink(ctx, 1));
    expect(res.status).toBe(200);
    expect(agentDoc(ctx).linked_human_wallet_id).toBe(HUMAN_WALLET_ID);
    expect(await epoch(ctx)).toBe(2);
    expect(consumptions(ctx)).toHaveLength(1);
  });

  it('RED: the same link signature twice → 409 the second time', async () => {
    const body = await signedLink(ctx, 1);
    expect((await post(ctx, 'link-human', body)).status).toBe(200);
    expect((await post(ctx, 'link-human', body)).status).toBe(409);
  });

  it('RED: link → unlink → REPLAY the link signature → refused; the agent stays unlinked', async () => {
    const link = await signedLink(ctx, 1);
    expect((await post(ctx, 'link-human', link)).status).toBe(200);
    expect((await post(ctx, 'unlink-human', await signedUnlink(ctx, 2))).status).toBe(200);
    expect(agentDoc(ctx).linked_human_wallet_id).toBeNull();

    const replay = await post(ctx, 'link-human', link);
    expect(replay.status).toBe(409);
    expect(['link_epoch_stale', 'link_signature_already_used']).toContain(replay.body.error);
    expect(agentDoc(ctx).linked_human_wallet_id).toBeNull();
    // A FRESH signature over the current epoch still links.
    expect(await epoch(ctx)).toBe(3);
    expect((await post(ctx, 'link-human', await signedLink(ctx, 3))).status).toBe(200);
    expect(agentDoc(ctx).linked_human_wallet_id).toBe(HUMAN_WALLET_ID);
  });

  it('RED: an unlink signed earlier cannot end a LATER link (old unlink after relink → refused)', async () => {
    expect((await post(ctx, 'link-human', await signedLink(ctx, 1))).status).toBe(200);
    const staleUnlink = await signedUnlink(ctx, 2); // signed while linked at epoch 2, held back
    expect((await post(ctx, 'unlink-human', await signedUnlink(ctx, 2))).status).toBe(200); // a different unlink lands first
    expect((await post(ctx, 'link-human', await signedLink(ctx, 3))).status).toBe(200); // relink (epoch 4)

    const res = await post(ctx, 'unlink-human', staleUnlink);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('link_epoch_stale');
    expect(agentDoc(ctx).linked_human_wallet_id).toBe(HUMAN_WALLET_ID);
  });

  it('RED: share A → share B → REPLAY A → refused; the share stays B', async () => {
    expect((await post(ctx, 'link-human', await signedLink(ctx, 1))).status).toBe(200);
    const shareA = await signedShare(ctx, 2, 3000);
    expect((await put(ctx, shareA)).status).toBe(200);
    expect(agentDoc(ctx).operational_reserve_bps).toBe(3000);
    expect((await put(ctx, await signedShare(ctx, 3, 4000))).status).toBe(200);
    expect(agentDoc(ctx).operational_reserve_bps).toBe(4000);

    const replay = await put(ctx, shareA);
    expect(replay.status).toBe(409);
    expect(agentDoc(ctx).operational_reserve_bps).toBe(4000);
  });

  it('RED: a no-op share signature (the share already in force) is consumed too — its replay is 409, though the epoch never moved', async () => {
    expect((await post(ctx, 'link-human', await signedLink(ctx, 1))).status).toBe(200);
    const bps = agentDoc(ctx).operational_reserve_bps as number;
    const noop = await signedShare(ctx, 2, bps);
    expect((await put(ctx, noop)).status).toBe(200);
    expect(await epoch(ctx)).toBe(2); // nothing moved: only the consumed record can refuse the replay
    const replay = await put(ctx, noop);
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe('link_signature_already_used');
  });

  it('RED: a pre- payload (no link_epoch) is refused 400 on all three routes, and nothing moves', async () => {
    const timestamp = Date.now();
    const legacyLink = await sign(ctx, { action: 'link_agent', agent_wallet_id: WALLET_ID, human_wallet_id: HUMAN_WALLET_ID, timestamp });
    const res = await post(ctx, 'link-human', { human_wallet_id: HUMAN_WALLET_ID, signature: legacyLink, timestamp });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/link_epoch/);
    expect(agentDoc(ctx).linked_human_wallet_id).toBeNull();

    expect((await post(ctx, 'link-human', await signedLink(ctx, 1))).status).toBe(200);
    const legacyUnlink = await sign(ctx, { action: 'unlink_agent', agent_wallet_id: WALLET_ID, human_wallet_id: HUMAN_WALLET_ID, timestamp });
    expect((await post(ctx, 'unlink-human', { signature: legacyUnlink, timestamp })).status).toBe(400);
    const legacyShare = await sign(ctx, { action: 'update_beneficiary_share', agent_wallet_id: WALLET_ID, human_wallet_id: HUMAN_WALLET_ID, operational_reserve_bps: 4000, timestamp });
    expect((await put(ctx, { signature: legacyShare, timestamp, operational_reserve_bps: 4000 })).status).toBe(400);
    expect(agentDoc(ctx).linked_human_wallet_id).toBe(HUMAN_WALLET_ID);
  });

  it('a signature naming a FUTURE epoch is stale too, and consumes nothing', async () => {
    const res = await post(ctx, 'link-human', await signedLink(ctx, 7));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('link_epoch_stale');
    expect(consumptions(ctx)).toHaveLength(0);
    expect(agentDoc(ctx).linked_human_wallet_id).toBeNull();
  });

  it('canonical bytes are pinned to the SDK signer (provian-agent-sdk/src/link-signing.test.ts pins the same string)', () => {
    expect(canonicalLinkSignaturePayload({
      action: 'update_beneficiary_share', agent_wallet_id: 'wallet_atlas', human_wallet_id: 'wallet_frank',
      link_epoch: 5, operational_reserve_bps: 3000, timestamp: 1730000000000,
    })).toBe('{"action":"update_beneficiary_share","agent_wallet_id":"wallet_atlas","human_wallet_id":"wallet_frank","link_epoch":5,"operational_reserve_bps":3000,"timestamp":1730000000000}');
  });

  it('the epoch read is own-wallet only', async () => {
    const res = await request(ctx.app).get('/v1/agent/wallet/wallet_aw_other/link-epoch').set('Authorization', ctx.bearer);
    expect(res.status).toBe(403);
  });
});
