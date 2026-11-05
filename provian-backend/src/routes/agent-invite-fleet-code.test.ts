/**
 * fleet onboarding.
 *
 * Any of a user's agents (active, already linked to that user) issues a link code
 * (POST /:wallet_id/fleet-code). Another of the user's agents runs the SAME
 * install line on its own box and, at request-link, a live unconsumed fleet
 * code links it to the code's human DIRECTLY — no human call — through the same
 * bindAgentToHuman path and the same invite_accepted PE the Accept uses.
 *
 * Design choices this suite pins (stated for the run report):
 * - a fleet code is SINGLE-USE for linking: a second agent presenting a
 * consumed code is REFUSED (409 connection_token_already_used), never
 * turned into a pending request; the consuming agent's own retry resumes.
 * - the issuer can never link itself; an agent linked to a different human is
 * refused; a code dies with the issuer's link.
 *
 * Runs the REAL createAgentAuthMiddleware against an in-memory Firestore seeded
 * with real scrypt credentials. bindAgentToHuman is observed (and simulated on
 * the store) so the test proves THIS route calls the Accept's bind with the
 * default share; the bind itself is covered by its own suites.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockGeneratePE = jest.fn<(...args: unknown[]) => Promise<{ peId: string; peHash: string; prevHash: string }>>();
jest.mock('../core/agent-bank/pe-utils', () => ({
  ...(jest.requireActual('../core/agent-bank/pe-utils') as object),
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));
const mockSendPushToUser = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../core/notifications/pushDispatcher', () => ({
  ...(jest.requireActual('../core/notifications/pushDispatcher') as object),
  sendPushToUser: (...args: unknown[]) => mockSendPushToUser(...args),
}));
jest.mock('../email', () => ({
  sendAgentInvite: jest.fn(async () => true),
  sendBeneficiaryInvite: jest.fn(async () => true),
}));
type BindParams = { wallet: { id: string }; humanWalletId: string; humanUserId: string; humanAddress: string | null; agentShareBps: number; fleet?: { code: string } };
const mockBind = jest.fn<(deps: unknown, params: BindParams) => Promise<{ retroTransfer: unknown; newBadgeIds: string[] }>>();
jest.mock('../core/agent-wallet/link-human-binding', () => ({
  ...(jest.requireActual('../core/agent-wallet/link-human-binding') as object),
  bindAgentToHuman: (deps: unknown, params: BindParams) => mockBind(deps, params),
}));

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import { createAgentInviteRouter } from './agent-invite';
import { isValidConnectionTokenFormat } from '../core/connection-token-format';
import { FLEET_CODE_TTL_MS, fleetInviteId } from '../core/agent-wallet/fleet-code';
import { AGENT_BENEFICIARY_RELATIONSHIP_COLLECTION, DEFAULT_AGENT_BENEFICIARY_SHARE_BPS } from '../core/agent-wallet/beneficiary-relationship';
import type { RouterDeps, AgentWalletDocument } from '../core/agent-wallet/types';

type Doc = Record<string, unknown>;
const MOUNT = '/v1/agent/wallet';
const HUMAN_USER = 'user_frank';
const OTHER_HUMAN = 'user_someone_else';
const HUMAN_WALLET_ID = 'wallet_human_frank';
const HUMAN_ADDRESS = `0x${'b'.repeat(40)}`;
const RELATIONSHIPS = AGENT_BENEFICIARY_RELATIONSHIP_COLLECTION;

function makeFirestore(opts: { flipStatusOnRead?: { walletId: string; afterReads: number; status: string } } = {}) {
  const collections = new Map<string, Map<string, Doc>>();
  const col = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };
  const reads = new Map<string, number>();
  const docRef = (name: string, id: string) => ({
    id,
    async get() {
      const key = `${name}/${id}`;
      const n = (reads.get(key) ?? 0) + 1;
      reads.set(key, n);
      let d = col(name).get(id);
      const flip = opts.flipStatusOnRead;
      if (d && flip && name === 'agent_wallets' && id === flip.walletId && n > flip.afterReads) {
        d = { ...d, status: flip.status };
      }
      return { exists: d !== undefined, id, data: () => d };
    },
    async set(data: Doc) { col(name).set(id, data); },
    async update(patch: Doc) { col(name).set(id, { ...(col(name).get(id) ?? {}), ...patch }); },
  });
  const buildQuery = (name: string, filters: Array<[string, unknown]>, lim?: number): any => ({
    where(field: string, _op: string, value: unknown) { return buildQuery(name, [...filters, [field, value]], lim); },
    limit(n: number) { return buildQuery(name, filters, n); },
    async get() {
      let docs = [...col(name).entries()]
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => ({ id, exists: true, data: () => d, ref: docRef(name, id) }));
      if (lim !== undefined) docs = docs.slice(0, lim);
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  });
  const collection = (name: string) => ({
    doc: (id: string) => ({ ...docRef(name, id), __col: name }),
    where(field: string, op: string, value: unknown) { return buildQuery(name, []).where(field, op, value); },
  });
  const runTransaction = async <T>(fn: (txn: unknown) => Promise<T>): Promise<T> => {
    const txn = {
      get: (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (ref: { __col: string; id: string }, data: Doc) => { col(ref.__col).set(ref.id, data); },
      update: (ref: { __col: string; id: string }, patch: Doc) => {
        col(ref.__col).set(ref.id, { ...(col(ref.__col).get(ref.id) ?? {}), ...patch });
      },
    };
    return fn(txn);
  };
  return { db: { collection, runTransaction } as unknown as import('firebase-admin/firestore').Firestore, col };
}

function makeCache(opts: { allowRate?: boolean } = {}) {
  return {
    checkRateLimit: jest.fn(async () => ({ allowed: opts.allowRate !== false, retryAfter: opts.allowRate === false ? 60 : 0 })),
    // A fleet code is never in the connection-token cache: every read goes to Firestore.
    getConnectionToken: jest.fn(async () => null),
    isEnabled: () => true,
  };
}

function makeDeps(db: import('firebase-admin/firestore').Firestore, cache: unknown): RouterDeps {
  return {
    db, cache: cache as RouterDeps['cache'],
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => '0xderived',
  } as unknown as RouterDeps;
}

function seedAgent(col: (n: string) => Map<string, Doc>, walletId: string, overrides: Partial<AgentWalletDocument> = {}) {
  const creds = generateApiCredentials();
  const wallet = {
    id: walletId, agent_id: `agent-${walletId}`, display_name: walletId === 'wallet_aw_main' ? 'Atlas' : 'Scout',
    platform: 'custom', address: `0x${crypto.createHash('sha256').update(walletId).digest('hex').slice(0, 40)}`,
    public_key: 'ab'.repeat(64),
    api_key_hash: creds.api_key_hash, api_key_salt: creds.api_key_salt, api_key_prefix: creds.api_key_prefix,
    status: 'active', pe_count: 3, linked_human_user_id: null, ...overrides,
  } as unknown as AgentWalletDocument;
  col('agent_wallets').set(walletId, wallet as unknown as Doc);
  col('api_key_index').set(creds.api_key_prefix, { wallet_id: walletId });
  // The canonical relationship record: a never-linked agent carries its birth
  // record (revision 1, agent_wallet_created, unlinked); a linked one has moved past it.
  const linked = (wallet as unknown as Doc).linked_human_user_id != null;
  col(RELATIONSHIPS).set(walletId, linked
    ? { wallet_id: walletId, revision: 2, state: 'linked', source_action_type: 'agent_linked_to_human' }
    : { wallet_id: walletId, revision: 1, state: 'unlinked', source_action_type: 'agent_wallet_created' });
  return { walletId, bearer: `Bearer ${creds.api_key}:${creds.api_secret}` };
}

function seedHuman(col: (n: string) => Map<string, Doc>) {
  col('wallets').set(HUMAN_WALLET_ID, { id: HUMAN_WALLET_ID, user_id: HUMAN_USER, type: 'human', address: HUMAN_ADDRESS });
}

function buildApp(deps: RouterDeps) {
  const app = express();
  app.use(express.json());
  app.use(MOUNT, createAgentInviteRouter(deps));
  return app;
}

/** A linked issuing agent + the human; returns the app and the issuing agent's bearer. */
function fleetWorld(cacheOpts: { allowRate?: boolean } = {}) {
  const { db, col } = makeFirestore();
  seedHuman(col);
  const main = seedAgent(col, 'wallet_aw_main', { linked_human_user_id: HUMAN_USER } as Partial<AgentWalletDocument>);
  const app = buildApp(makeDeps(db, makeCache(cacheOpts)));
  return { db, col, app, main };
}

/**
 * The durable effect of the REAL bind on the store (link-human-binding.ts): the
 * agent is linked and — on a fleet bind — the code is marked bind-completed, in
 * the one transaction.
 */
function linkingBind(col: (n: string) => Map<string, Doc>) {
  return async (_deps: unknown, p: BindParams) => {
    col('agent_wallets').set(p.wallet.id, { ...col('agent_wallets').get(p.wallet.id)!, linked_human_user_id: p.humanUserId });
    if (p.fleet) {
      col('connection_tokens').set(p.fleet.code, { ...col('connection_tokens').get(p.fleet.code)!, bind_completed: true });
    }
    return { retroTransfer: {}, newBadgeIds: [] };
  };
}

async function issue(app: express.Express, main: { walletId: string; bearer: string }) {
  return request(app).post(`${MOUNT}/${main.walletId}/fleet-code`).set('Authorization', main.bearer).send();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGeneratePE.mockResolvedValue({ peId: 'pe_x', peHash: '0xhash', prevHash: '0x0' });
  mockSendPushToUser.mockResolvedValue({ successCount: 1 });
  // Simulate the durable effect of the real bind on the store: the agent is now linked.
  mockBind.mockImplementation(async () => ({ retroTransfer: {}, newBadgeIds: [] }));
});

describe('POST /:wallet_id/fleet-code — a linked agent issues a link code', () => {
  it('mints a normal PROV-XXXX-XXXX code for the issuer\'s human: kind fleet, one hour, unused; returns GET install lines', async () => {
    const { app, col, main } = fleetWorld();
    const before = Date.now();
    const res = await issue(app, main);
    expect(res.status).toBe(201);
    expect(isValidConnectionTokenFormat(res.body.code)).toBe(true);
    expect(res.body.expires_at).toBeGreaterThanOrEqual(before + FLEET_CODE_TTL_MS);
    expect(res.body.expires_at).toBeLessThanOrEqual(Date.now() + FLEET_CODE_TTL_MS);
    expect(col('connection_tokens').get(res.body.code)).toMatchObject({
      token: res.body.code, user_id: HUMAN_USER, kind: 'fleet',
      issued_by_agent_wallet_id: main.walletId, used: false, expires_at: res.body.expires_at,
    });
    expect(res.body.install_line.sh).toBe(`curl -sSL -H 'x-provian-token: ${res.body.code}' "https://api.provian.ai/v1/bootstrap/agent" | sh`);
    expect(res.body.install_line.powershell).toContain(`'x-provian-token'='${res.body.code}'`);
    expect(res.body.install_line.sh).not.toContain('-X POST');
    // Nothing in the response is key material: the new agent's key is generated on its own box.
    expect(JSON.stringify(res.body)).not.toMatch(/private|secret|mnemonic|api_key/i);
  });

  it('item 11: the code carries the HUMAN\'s published recovery anchor — read from the human\'s record, never from the issuing agent\'s request', async () => {
    const { app, col, main } = fleetWorld();
    const HUMAN_ANCHOR = 'E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20';
    col('human_recovery_anchors').set(HUMAN_USER, { user_id: HUMAN_USER, recovery_anchor_pubkey: HUMAN_ANCHOR });
    const res = await request(app).post(`${MOUNT}/${main.walletId}/fleet-code`).set('Authorization', main.bearer)
      .send({ recovery_anchor_pubkey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }); // an agent-supplied key is ignored
    expect(res.status).toBe(201);
    expect(col('connection_tokens').get(res.body.code)?.recovery_anchor_pubkey).toBe(HUMAN_ANCHOR);
    expect(JSON.stringify(res.body)).not.toContain(HUMAN_ANCHOR); // the issuer is never handed it
  });

  it('item 11 RED CONTROL: a human who has not published an anchor gets a code with none (the agent escrows once one appears)', async () => {
    const { app, col, main } = fleetWorld();
    const res = await issue(app, main);
    expect(res.status).toBe(201);
    expect(col('connection_tokens').get(res.body.code)).not.toHaveProperty('recovery_anchor_pubkey');
  });

  it('RED CONTROL: an agent with NO linked human → 403 not_linked, nothing minted', async () => {
    const { db, col } = makeFirestore();
    seedHuman(col);
    const lone = seedAgent(col, 'wallet_aw_lone');
    const res = await issue(buildApp(makeDeps(db, makeCache())), lone);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_linked');
    expect(col('connection_tokens').size).toBe(0);
  });

  it('ownership: the path wallet must be the authenticated wallet (403), and no auth is 401', async () => {
    const { app, col, main } = fleetWorld();
    const mismatch = await request(app).post(`${MOUNT}/wallet_aw_other/fleet-code`).set('Authorization', main.bearer).send();
    expect(mismatch.status).toBe(403);
    const noAuth = await request(app).post(`${MOUNT}/${main.walletId}/fleet-code`).send();
    expect(noAuth.status).toBe(401);
    expect(col('connection_tokens').size).toBe(0);
  });

  it('not active (the authoritative read, past a cached active wallet) → 409 agent_not_active', async () => {
    const { db, col } = makeFirestore({ flipStatusOnRead: { walletId: 'wallet_aw_main', afterReads: 1, status: 'suspended' } });
    seedHuman(col);
    const main = seedAgent(col, 'wallet_aw_main', { linked_human_user_id: HUMAN_USER } as Partial<AgentWalletDocument>);
    const res = await issue(buildApp(makeDeps(db, makeCache())), main);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('agent_not_active');
    expect(col('connection_tokens').size).toBe(0);
  });

  it('a transport rate limit per issuing wallet → 429', async () => {
    const { app, col, main } = fleetWorld({ allowRate: false });
    const res = await issue(app, main);
    expect(res.status).toBe(429);
    expect(col('connection_tokens').size).toBe(0);
  });
});

describe('request-link with a fleet code — the other agent links with NO human call', () => {
  it('links directly: consumes the code, calls the Accept\'s bind at the default share, records an accepted invite, emits invite_accepted on the human chain, pushes agent_linked', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    const scout = seedAgent(col, 'wallet_aw_scout');

    const res = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'linked', linked_via: 'fleet_code', request_id: fleetInviteId(code) });

    // Single-use flip, stamped with the consumer.
    expect(col('connection_tokens').get(code)).toMatchObject({ used: true, used_by_wallet_id: scout.walletId });

    // The SAME bind the Accept uses, to the code's human, at the default share.
    expect(mockBind).toHaveBeenCalledTimes(1);
    const bindParams = mockBind.mock.calls[0][1];
    expect(bindParams.wallet.id).toBe(scout.walletId);
    expect(bindParams).toMatchObject({
      humanWalletId: HUMAN_WALLET_ID, humanUserId: HUMAN_USER, humanAddress: HUMAN_ADDRESS,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });

    // One accepted link record.
    expect(col('agent_invites').get(fleetInviteId(code))).toMatchObject({
      status: 'accepted', agent_wallet_id: scout.walletId, for_human_user_id: HUMAN_USER,
      accepted_by_user_id: HUMAN_USER, accepted_by_wallet_id: HUMAN_WALLET_ID,
      accepted_via: 'fleet_code', issued_by_agent_wallet_id: main.walletId,
    });

    // The SAME invite_accepted PE, on the HUMAN's chain, deterministic id.
    const pes = mockGeneratePE.mock.calls.map((c) => c[1] as { actionType: string; walletId: string; agentId: string; peIdOverride: string; metadata: Doc });
    expect(pes.map((p) => p.actionType)).toEqual(['invite_accepted']);
    expect(pes[0]).toMatchObject({ walletId: HUMAN_WALLET_ID, agentId: HUMAN_USER });
    expect(pes[0].peIdOverride).toBe(`pe_invite_accepted_${crypto.createHash('sha256').update(fleetInviteId(code), 'utf8').digest('hex')}`);
    expect(pes[0].metadata).toMatchObject({
      invite_id: fleetInviteId(code), agent_wallet_id: scout.walletId, no_pvt: 'link_is_ignition_not_earning',
      accepted_via: 'fleet_code', issued_by_agent_wallet_id: main.walletId,
    });

    // The human hears about it (agent_linked → Agent Hub); no link-request card.
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    const [, pushedUser, message] = mockSendPushToUser.mock.calls[0] as [unknown, string, { data: Doc }];
    expect(pushedUser).toBe(HUMAN_USER);
    expect(message.data).toMatchObject({ type: 'agent_linked', agent_wallet_id: scout.walletId, linked_via: 'fleet_code' });
  });

  it('SINGLE-USE: a second agent presenting the consumed code is REFUSED (409), never linked or queued', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    const scout = seedAgent(col, 'wallet_aw_scout');
    const second = seedAgent(col, 'wallet_aw_second');
    expect((await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code })).status).toBe(201);
    mockBind.mockClear(); mockGeneratePE.mockClear();

    const res = await request(app).post(`${MOUNT}/${second.walletId}/request-link`).set('Authorization', second.bearer).send({ connection_token: code });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('connection_token_already_used');
    expect(mockBind).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect([...col('agent_invites').values()].filter((d) => d.agent_wallet_id === second.walletId)).toHaveLength(0);
    expect(col('connection_tokens').get(code)).toMatchObject({ used_by_wallet_id: scout.walletId });
  });

  it('the consuming agent\'s RETRY resumes the same link: same record, same PE id, no second bind', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    const scout = seedAgent(col, 'wallet_aw_scout');
    const first = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    // The real bind made the agent linked; reflect that on the store.
    col('agent_wallets').set(scout.walletId, { ...col('agent_wallets').get(scout.walletId)!, linked_human_user_id: HUMAN_USER });
    mockBind.mockClear();
    const retry = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(retry.status).toBe(201);
    expect(retry.body.request_id).toBe(first.body.request_id);
    expect(mockBind).not.toHaveBeenCalled();
    const ids = mockGeneratePE.mock.calls.map((c) => (c[1] as { peIdOverride: string }).peIdOverride);
    expect(new Set(ids).size).toBe(1);
    expect(col('agent_invites').size).toBe(1);
  });

  it('a RESUME while the agent is still linked to the code\'s human finishes idempotently (the PE-retry path)', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    const scout = seedAgent(col, 'wallet_aw_scout');
    // First attempt: consume + bind land, the invite_accepted PE fails -> 503.
    mockGeneratePE.mockRejectedValueOnce(new Error('firestore blip'));
    const first = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(first.status).toBe(503);
    col('agent_wallets').set(scout.walletId, { ...col('agent_wallets').get(scout.walletId)!, linked_human_user_id: HUMAN_USER });
    mockBind.mockClear();
    const retry = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(retry.status).toBe(201);
    expect(mockBind).not.toHaveBeenCalled();
  });

  it('REVIEW 2 #5: the consume committed but the bind threw — the SAME agent\'s retry completes the bind (201, linked); a different agent is still refused', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    const scout = seedAgent(col, 'wallet_aw_scout');
    const other = seedAgent(col, 'wallet_aw_other');
    mockBind.mockRejectedValueOnce(new Error('firestore blip'));
    const first = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(first.status).toBe(500);
    expect(col('connection_tokens').get(code)).toMatchObject({ used: true, used_by_wallet_id: scout.walletId });
    expect(col('agent_wallets').get(scout.walletId)!.linked_human_user_id).toBeNull();

    // Another agent can never take the half-used code.
    const stranger = await request(app).post(`${MOUNT}/${other.walletId}/request-link`).set('Authorization', other.bearer).send({ connection_token: code });
    expect(stranger.status).toBe(409);
    expect(stranger.body.error).toBe('connection_token_already_used');

    mockBind.mockClear();
    mockBind.mockImplementation(linkingBind(col));
    const retry = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ status: 'linked', linked_via: 'fleet_code', request_id: fleetInviteId(code) });
    expect(mockBind).toHaveBeenCalledTimes(1);
    expect(mockBind.mock.calls[0][1]).toMatchObject({ humanUserId: HUMAN_USER, fleet: { code } });
    expect(col('agent_wallets').get(scout.walletId)!.linked_human_user_id).toBe(HUMAN_USER);
    expect(col('connection_tokens').get(code)).toMatchObject({ used_by_wallet_id: scout.walletId, bind_completed: true });
    expect(col('agent_invites').get(fleetInviteId(code))).toMatchObject({ status: 'accepted', agent_wallet_id: scout.walletId });

    // Once bound, the code binds nothing again — even for its consumer.
    col('agent_wallets').set(scout.walletId, { ...col('agent_wallets').get(scout.walletId)!, linked_human_user_id: null });
    mockBind.mockClear();
    const again = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('connection_token_already_used');
    expect(mockBind).not.toHaveBeenCalled();
  });

  it('REVIEW 2 #5: the issuer unlinks between a 503\'d invite_accepted and the retry — the retry still completes the bookkeeping (record, PE, push)', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    const scout = seedAgent(col, 'wallet_aw_scout');
    mockBind.mockImplementation(linkingBind(col));
    mockGeneratePE.mockRejectedValueOnce(new Error('firestore blip'));
    const first = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(first.status).toBe(503);
    // The issuing agent's link ends before the retry.
    col('agent_wallets').set(main.walletId, { ...col('agent_wallets').get(main.walletId)!, linked_human_user_id: null });
    mockBind.mockClear(); mockGeneratePE.mockClear(); mockSendPushToUser.mockClear();

    const retry = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(retry.status).toBe(201);
    expect(mockBind).not.toHaveBeenCalled();
    expect(col('agent_invites').get(fleetInviteId(code))).toMatchObject({
      status: 'accepted', agent_wallet_id: scout.walletId, issued_by_agent_wallet_id: main.walletId,
    });
    expect(mockGeneratePE.mock.calls.map((c) => (c[1] as { actionType: string }).actionType)).toEqual(['invite_accepted']);
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
  });

  it('INVARIANT: after the human UNLINKS the agent, re-presenting its consumed fleet code is REFUSED (409) and never binds', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    const scout = seedAgent(col, 'wallet_aw_scout');
    expect((await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code })).status).toBe(201);
    // The human ended the link (human-unlink): the wallet is unlinked, the relationship moved on.
    col('agent_wallets').set(scout.walletId, { ...col('agent_wallets').get(scout.walletId)!, linked_human_user_id: null });
    col(RELATIONSHIPS).set(scout.walletId, { wallet_id: scout.walletId, revision: 3, state: 'unlinked', source_action_type: 'agent_unlinked_from_human' });
    mockBind.mockClear(); mockGeneratePE.mockClear(); mockSendPushToUser.mockClear();

    const res = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('connection_token_already_used');
    expect(mockBind).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it('INVARIANT: a FRESH fleet code refuses an agent its human previously unlinked (409 fleet_code_requires_new_agent), unconsumed', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    const former = seedAgent(col, 'wallet_aw_former');
    col(RELATIONSHIPS).set(former.walletId, { wallet_id: former.walletId, revision: 3, state: 'unlinked', source_action_type: 'agent_unlinked_from_human' });
    const res = await request(app).post(`${MOUNT}/${former.walletId}/request-link`).set('Authorization', former.bearer).send({ connection_token: code });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('fleet_code_requires_new_agent');
    expect(col('connection_tokens').get(code)).toMatchObject({ used: false });
    expect(mockBind).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('INVARIANT: any other durable link marker also refuses a fresh fleet code: a past accepted invite, or no relationship record at all', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    const invited = seedAgent(col, 'wallet_aw_invited');
    col('agent_invites').set('inv_past', { id: 'inv_past', agent_wallet_id: invited.walletId, status: 'accepted', for_human_user_id: OTHER_HUMAN });
    const r1 = await request(app).post(`${MOUNT}/${invited.walletId}/request-link`).set('Authorization', invited.bearer).send({ connection_token: code });
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe('fleet_code_requires_new_agent');
    const legacy = seedAgent(col, 'wallet_aw_legacy');
    col(RELATIONSHIPS).delete(legacy.walletId);
    const r2 = await request(app).post(`${MOUNT}/${legacy.walletId}/request-link`).set('Authorization', legacy.bearer).send({ connection_token: code });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('fleet_code_requires_new_agent');
    expect(col('connection_tokens').get(code)).toMatchObject({ used: false });
    expect(mockBind).not.toHaveBeenCalled();
  });

  it('the ISSUER cannot link itself with its own code (409), and the code stays unconsumed', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    const res = await request(app).post(`${MOUNT}/${main.walletId}/request-link`).set('Authorization', main.bearer).send({ connection_token: code });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('fleet_code_issuer_cannot_link_itself');
    expect(col('connection_tokens').get(code)).toMatchObject({ used: false });
    expect(mockBind).not.toHaveBeenCalled();
  });

  it('an agent ALREADY linked to a DIFFERENT human is refused (409), the code stays unconsumed', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    const taken = seedAgent(col, 'wallet_aw_taken', { linked_human_user_id: OTHER_HUMAN } as Partial<AgentWalletDocument>);
    const res = await request(app).post(`${MOUNT}/${taken.walletId}/request-link`).set('Authorization', taken.bearer).send({ connection_token: code });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('agent_already_linked');
    expect(col('connection_tokens').get(code)).toMatchObject({ used: false });
    expect(mockBind).not.toHaveBeenCalled();
  });

  it('an EXPIRED fleet code → 410 connection_token_expired, unconsumed, no bind', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    col('connection_tokens').set(code, { ...col('connection_tokens').get(code)!, expires_at: Date.now() - 1 });
    const scout = seedAgent(col, 'wallet_aw_scout');
    const res = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('connection_token_expired');
    expect(col('connection_tokens').get(code)).toMatchObject({ used: false });
    expect(mockBind).not.toHaveBeenCalled();
  });

  it('a code dies with the issuer\'s link: an issuer no longer linked to that human → 409, unconsumed', async () => {
    const { app, col, main } = fleetWorld();
    const code = (await issue(app, main)).body.code as string;
    col('agent_wallets').set(main.walletId, { ...col('agent_wallets').get(main.walletId)!, linked_human_user_id: null });
    const scout = seedAgent(col, 'wallet_aw_scout');
    const res = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: code });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('fleet_code_issuer_not_linked');
    expect(col('connection_tokens').get(code)).toMatchObject({ used: false });
    expect(mockBind).not.toHaveBeenCalled();
  });

  it('RED CONTROL: a HUMAN code (no kind) never takes the fleet path — it files a pending request, binds nothing', async () => {
    const { app, col } = fleetWorld();
    const HUMAN_CODE = 'PROV-HJKM-2345';
    col('connection_tokens').set(HUMAN_CODE, { token: HUMAN_CODE, user_id: HUMAN_USER, used: false, expires_at: Date.now() + 60_000 });
    const scout = seedAgent(col, 'wallet_aw_scout');
    const res = await request(app).post(`${MOUNT}/${scout.walletId}/request-link`).set('Authorization', scout.bearer).send({ connection_token: HUMAN_CODE });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(mockBind).not.toHaveBeenCalled();
    expect((mockGeneratePE.mock.calls[0][1] as { actionType: string }).actionType).toBe('agent_invite_sent');
  });
});
