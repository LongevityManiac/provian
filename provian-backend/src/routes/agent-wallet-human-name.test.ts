/**
 * The human names their agent (agent-path close-out, item 5).
 *
 *  A. POST /v1/agent/wallet/:wallet_id/human-name (wallet auth): only the linked human, only an
 *     active agent, the creation name rule; writes agent_wallets.display_name (+ set_by/set_at)
 *     and the Commons-profile / directory mirrors that exist; seals NO PE.
 *  B. The agent's own Commons profile update refuses a different display_name while the human's
 *     name holds (`display_name_set_by_human`); a Commons (re)join takes the human's name.
 *  C. Credential recovery's integrity check tolerates a human-set name (and only a well-formed one).
 *
 * Every guard ships with a RED control (a violating input the guard must refuse).
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockGeneratePE = jest.fn(async (..._args: unknown[]) => ({ peId: 'pe_x', peHash: '0xh', prevHash: '0x0' }));
jest.mock('../core/agent-bank/pe-utils', () => ({
  ...(jest.requireActual('../core/agent-bank/pe-utils') as object),
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));
jest.mock('./middleware/wallet-auth', () => ({
  ...(jest.requireActual('./middleware/wallet-auth') as object),
  verifyWalletAuthToken: async (token: string) => (token.startsWith('human:')
    ? { ok: true, userId: token.slice('human:'.length), deviceId: 'dev_1' }
    : { ok: false, status: 401, error: 'invalid_wallet_auth' }),
}));

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-key';

import express from 'express';
import request from 'supertest';
import { createAgentWalletRouter } from './agent-wallet';
import type { RouterDeps } from '../core/agent-wallet/types';
import { updateProfile, registerForCommons } from '../core/commons/profiles';
import { ValidationError } from '../core/agent-bank/errors';
import { displayNameMatchesRecoveryIdentity } from '../core/agent-wallet/registration-recovery-integrity';
import { validateAgentDisplayName } from '../core/agent-wallet/human-agent-name';

type Doc = Record<string, unknown>;

function makeFirestore() {
  const collections = new Map<string, Map<string, Doc>>();
  const col = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };
  const docRef = (name: string, id: string) => ({
    async get() {
      const d = col(name).get(id);
      return { exists: d !== undefined, id, data: () => d, ref: docRef(name, id) };
    },
    async set(data: Doc) { col(name).set(id, { ...data }); },
    async update(patch: Doc) {
      if (!col(name).has(id)) throw new Error(`no_document_to_update:${name}/${id}`);
      col(name).set(id, { ...(col(name).get(id) ?? {}), ...patch });
    },
  });
  const query = (name: string, filters: Array<[string, unknown]>): Record<string, unknown> => ({
    where: (f: string, _op: string, v: unknown) => query(name, [...filters, [f, v]]),
    orderBy: () => query(name, filters),
    limit: (_n: number) => query(name, filters),
    async get() {
      const docs = [...col(name).entries()]
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => ({ id, data: () => d, ref: docRef(name, id) }));
      return { size: docs.length, empty: docs.length === 0, docs };
    },
  });
  const collection = (name: string) => ({
    doc: (id: string) => docRef(name, id),
    where: (f: string, _op: string, v: unknown) => query(name, [[f, v]]),
    orderBy: () => query(name, []),
    limit: () => query(name, []),
    get: () => (query(name, []) as { get: () => Promise<unknown> }).get(),
  });
  const db = {
    collection,
    async runTransaction<T>(fn: (txn: unknown) => Promise<T>): Promise<T> {
      return fn({
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        update: (ref: { update: (p: Doc) => Promise<void> }, patch: Doc) => { void ref.update(patch); },
        set: (ref: { set: (d: Doc) => Promise<void> }, data: Doc) => { void ref.set(data); },
      });
    },
    batch() {
      const ops: Array<() => Promise<void>> = [];
      return {
        update: (ref: { update: (p: Doc) => Promise<void> }, p: Doc) => { ops.push(() => ref.update(p)); },
        set: (ref: { set: (d: Doc) => Promise<void> }, d: Doc) => { ops.push(() => ref.set(d)); },
        async commit() { for (const op of ops) await op(); },
      };
    },
  };
  return { db: db as unknown as import('firebase-admin/firestore').Firestore, col };
}

function makeDeps(db: import('firebase-admin/firestore').Firestore): RouterDeps {
  return {
    db,
    cache: {
      checkRateLimit: jest.fn(async () => ({ allowed: true, retryAfter: 0 })),
      isEnabled: () => true,
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
      del: jest.fn(async () => undefined),
    } as unknown as RouterDeps['cache'],
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => '0xderived',
  } as unknown as RouterDeps;
}

const HUMAN = 'human_user_1';
const OTHER = 'human_user_2';
const AGENT = 'wallet_aw_1';
const MOUNT = '/v1/agent/wallet';

function build(opts: { profile?: boolean; directory?: boolean; wallet?: Doc } = {}) {
  const { db, col } = makeFirestore();
  col('agent_wallets').set(AGENT, {
    id: AGENT, agent_id: 'agent-1', display_name: 'agent-7f3a', address: '0xAGENT',
    status: 'active', linked_human_user_id: HUMAN, linked_human_wallet_id: 'hw_1',
    created_at: 1, updated_at: 1,
    ...(opts.wallet ?? {}),
  });
  if (opts.profile) col('commons_profiles').set(AGENT, { wallet_id: AGENT, display_name: 'agent-7f3a', participant_type: 'agent', status: 'active' });
  if (opts.directory) col('agent_directory').set(AGENT, { wallet_id: AGENT, display_name: 'agent-7f3a' });
  const deps = makeDeps(db);
  const app = express();
  app.use(express.json());
  app.use(MOUNT, createAgentWalletRouter(deps));
  return { app, col, db, deps };
}

const rename = (app: express.Express, auth: string | null, body: unknown, id = AGENT) => {
  const r = request(app).post(`${MOUNT}/${id}/human-name`);
  return (auth ? r.set('Authorization', auth) : r).send(body as object);
};

beforeEach(() => { jest.clearAllMocks(); });

describe('A. POST /:wallet_id/human-name', () => {
  it('the linked human names the agent: canonical doc + both mirrors, trimmed, NO PE sealed', async () => {
    const { app, col } = build({ profile: true, directory: true });
    const res = await rename(app, `Bearer human:${HUMAN}`, { agent_name: '  Atlas  ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ wallet_id: AGENT, display_name: 'Atlas', display_name_set_by: 'linked_human' });
    const w = col('agent_wallets').get(AGENT)!;
    expect(w.display_name).toBe('Atlas');
    expect(w.display_name_set_by).toBe('linked_human');
    expect(w.display_name_set_at).toBe(res.body.display_name_set_at);
    expect(col('commons_profiles').get(AGENT)!.display_name).toBe('Atlas');
    expect(col('agent_directory').get(AGENT)!.display_name).toBe('Atlas');
    // Display metadata only: the identity fields are untouched and no PE is generated.
    expect(w.address).toBe('0xAGENT');
    expect(w.agent_id).toBe('agent-1');
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('a mirror that does not exist is not created', async () => {
    const { app, col } = build();
    const res = await rename(app, `Bearer human:${HUMAN}`, { agent_name: 'Atlas' });
    expect(res.status).toBe(200);
    expect(col('commons_profiles').has(AGENT)).toBe(false);
    expect(col('agent_directory').has(AGENT)).toBe(false);
  });

  it('RED: no wallet auth → 401, nothing written', async () => {
    const { app, col } = build({ profile: true });
    const res = await rename(app, null, { agent_name: 'Atlas' });
    expect(res.status).toBe(401);
    expect(col('agent_wallets').get(AGENT)!.display_name).toBe('agent-7f3a');
  });

  it('RED: the agent\'s own API key is not wallet auth → 401', async () => {
    const { app } = build();
    const res = await rename(app, 'Bearer pvn_live_x:pvns_y', { agent_name: 'Atlas' });
    expect(res.status).toBe(401);
  });

  it('RED: a DIFFERENT human → 403 not_your_linked_agent, nothing written', async () => {
    const { app, col } = build({ profile: true, directory: true });
    const res = await rename(app, `Bearer human:${OTHER}`, { agent_name: 'Hijack' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_your_linked_agent');
    expect(col('agent_wallets').get(AGENT)!.display_name).toBe('agent-7f3a');
    expect(col('agent_wallets').get(AGENT)!.display_name_set_by).toBeUndefined();
    expect(col('commons_profiles').get(AGENT)!.display_name).toBe('agent-7f3a');
  });

  it('RED: an unlinked agent → 403; an unknown wallet id → the same 403', async () => {
    const { app } = build({ wallet: { linked_human_user_id: null } });
    expect((await rename(app, `Bearer human:${HUMAN}`, { agent_name: 'Atlas' })).status).toBe(403);
    expect((await rename(app, `Bearer human:${HUMAN}`, { agent_name: 'Atlas' }, 'wallet_aw_nope')).status).toBe(403);
  });

  it('RED: an inactive agent → 409 agent_not_active', async () => {
    const { app, col } = build({ wallet: { status: 'suspended' } });
    const res = await rename(app, `Bearer human:${HUMAN}`, { agent_name: 'Atlas' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('agent_not_active');
    expect(col('agent_wallets').get(AGENT)!.display_name).toBe('agent-7f3a');
  });

  it.each([
    [{}, 'agent_name_required'],
    [{ agent_name: '   ' }, 'agent_name_required'],
    [{ agent_name: 42 }, 'agent_name_required'],
    [{ agent_name: 'x'.repeat(101) }, 'agent_name_too_long'],
    [{ agent_name: '<script>' }, 'agent_name_markup'],
  ])('RED: invalid name %j → 400 %s, nothing written', async (body, code) => {
    const { app, col } = build();
    const res = await rename(app, `Bearer human:${HUMAN}`, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(code);
    expect(col('agent_wallets').get(AGENT)!.display_name).toBe('agent-7f3a');
  });

  it('the name rule accepts exactly 100 characters (boundary)', () => {
    expect(validateAgentDisplayName('x'.repeat(100))).toEqual({ ok: true, value: 'x'.repeat(100) });
  });
});

describe('B. the human\'s name holds in the Commons', () => {
  it('the agent\'s own profile update refuses a different display_name while the human\'s name holds', async () => {
    const { app, db, deps, col } = build({ profile: true });
    await rename(app, `Bearer human:${HUMAN}`, { agent_name: 'Atlas' });
    await expect(updateProfile(deps as never, AGENT, { display_name: 'Renamed by agent' } as never))
      .rejects.toThrow(new ValidationError('display_name_set_by_human'));
    expect(col('commons_profiles').get(AGENT)!.display_name).toBe('Atlas');
    // Re-sending the SAME name, or changing other fields, is not a rename and is allowed.
    const same = await updateProfile({ db } as never, AGENT, { display_name: 'Atlas', bio: 'hi' } as never);
    expect(same.display_name).toBe('Atlas');
    expect((same as unknown as Doc).bio).toBe('hi');
  });

  it('RED control: without the human flag the agent may rename its own profile (the guard keys on the flag)', async () => {
    const { deps, col } = build({ profile: true });
    const updated = await updateProfile(deps as never, AGENT, { display_name: 'Renamed by agent' } as never);
    expect(updated.display_name).toBe('Renamed by agent');
    expect(col('commons_profiles').get(AGENT)!.display_name).toBe('Renamed by agent');
  });

  it('a human wallet (no agent_wallets doc) renames its own profile freely', async () => {
    const { deps, col } = build();
    col('commons_profiles').set('hw_1', { wallet_id: 'hw_1', display_name: 'the operator', participant_type: 'human', status: 'active' });
    const updated = await updateProfile(deps as never, 'hw_1', { display_name: 'the operator D' } as never);
    expect(updated.display_name).toBe('the operator D');
  });

  it('an agent the human named joins the Commons under the human\'s name, whatever it sends', async () => {
    const { app, deps, col } = build();
    await rename(app, `Bearer human:${HUMAN}`, { agent_name: 'Atlas' });
    const { profile } = await registerForCommons(deps as never, AGENT, 'agent-1', '0xAGENT', {
      display_name: 'Something else', participant_type: 'agent', message_pubkey: 'A'.repeat(43),
    } as never);
    expect(profile.display_name).toBe('Atlas');
    expect(col('commons_profiles').get(AGENT)!.display_name).toBe('Atlas');
  });

  it('RED control: an agent the human has NOT named joins under the name it sends', async () => {
    const { deps } = build();
    const { profile } = await registerForCommons(deps as never, AGENT, 'agent-1', '0xAGENT', {
      display_name: 'Something else', participant_type: 'agent', message_pubkey: 'A'.repeat(43),
    } as never);
    expect(profile.display_name).toBe('Something else');
  });
});

describe('C. credential-recovery integrity tolerates a human-set name (and only a well-formed one)', () => {
  const base = { display_name: 'Registered' };
  it('no flag: the name must equal the registration name', () => {
    expect(displayNameMatchesRecoveryIdentity(base, 'Registered', 10, 20)).toBe(true);
    // RED: a changed name with no human flag is tampering.
    expect(displayNameMatchesRecoveryIdentity({ display_name: 'Changed' }, 'Registered', 10, 20)).toBe(false);
  });
  it('human flag: a well-formed name set inside the wallet\'s span is accepted', () => {
    expect(displayNameMatchesRecoveryIdentity(
      { display_name: 'Atlas', display_name_set_by: 'linked_human', display_name_set_at: 15 }, 'Registered', 10, 20,
    )).toBe(true);
  });
  it.each([
    [{ display_name: 'Atlas', display_name_set_by: 'linked_human' }, 'set_by without set_at'],
    [{ display_name: 'Atlas', display_name_set_at: 15 }, 'set_at without set_by'],
    [{ display_name: 'Atlas', display_name_set_by: 'agent', display_name_set_at: 15 }, 'unknown setter'],
    [{ display_name: 'Atlas', display_name_set_by: 'linked_human', display_name_set_at: 25 }, 'set after updated_at'],
    [{ display_name: 'Atlas', display_name_set_by: 'linked_human', display_name_set_at: 5 }, 'set before created_at'],
    [{ display_name: '<b>x</b>', display_name_set_by: 'linked_human', display_name_set_at: 15 }, 'markup'],
    [{ display_name: '', display_name_set_by: 'linked_human', display_name_set_at: 15 }, 'empty'],
    [{ display_name: 'y'.repeat(101), display_name_set_by: 'linked_human', display_name_set_at: 15 }, 'too long'],
  ])('RED: %j (%s) fails integrity', (raw, _why) => {
    expect(displayNameMatchesRecoveryIdentity(raw as Doc, 'Registered', 10, 20)).toBe(false);
  });
});
