/**
 * Wallet-auth GitHub connect routes - POST /github/connect/wallet/start and
 * GET /github/connect/wallet/poll.
 *
 * These are the phone-initiated variants of the DeviceKey connect flow.
 * Covers:
 *  - 401 without a bearer token; auth failures surface the verifier's status
 *  - 409 wallet_required when the authenticated user has no wallet row
 *  - start: 400 on malformed state, 200 with install_url bound to the state,
 *    409 on cross-user state collision
 *  - poll: pending → completed transition, wrong-user reads as 'expired'
 *    (no existence leak), id space is the wallets doc id (matching the
 *    DeviceKey path's owner_wallet_id)
 *
 * verifyWalletAuthToken is stubbed (HMAC verification is covered by its own
 * tests); the fake db implements just enough of Firestore for
 * startPendingConnect / pollAndFinalize.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';

jest.mock('./middleware/wallet-auth', () => ({
  verifyWalletAuthToken: async (token: string) => {
    if (token.startsWith('valid:')) {
      return { ok: true, userId: token.slice('valid:'.length), deviceId: 'dev_test' };
    }
    return { ok: false, status: 401, error: 'invalid_signature' };
  },
}));

// createServiceInstall and generatePE exercise the full Firestore + PE
// pipeline (covered by their own tests); record their calls instead so the
// route + pollAndFinalize logic is what gets exercised here.
const mockInstalls: any[] = [];
jest.mock('../core/witnesses/service-installs', () => ({
  createServiceInstall: async (_db: unknown, doc: any) => {
    mockInstalls.push(doc);
    return { install_id: `si_${mockInstalls.length}` };
  },
  getServiceInstallByInstallationId: async () => null,
  getServiceInstallsByUser: async () => [],
  markServiceInstallRevoked: async () => undefined,
}));

const mockPEs: any[] = [];
jest.mock('../core/agent-bank/pe-utils', () => ({
  generatePE: async (_deps: unknown, params: any) => {
    mockPEs.push(params);
    return { peId: `pe_${mockPEs.length}`, peHash: `hash_${mockPEs.length}` };
  },
}));

import express from 'express';
import request from 'supertest';
import { createWitnessesGitHubRouter } from './witnesses-github';

const STATE_A = 'a'.repeat(64);
const STATE_B = 'b'.repeat(64);
const SECRET = 'f'.repeat(48); // well-formed for loadGitHubAppConfig

interface FakeStore {
  walletsByUser: Record<string, string>; // user_id -> wallet doc id
  pending: Record<string, any>; // state -> PendingConnectDocument
}

function buildApp(store: FakeStore): express.Express {
  const pendingRef = (state: string) => ({
    async get() {
      const doc = store.pending[state];
      return { exists: doc != null, data: () => doc };
    },
    async update(patch: Record<string, unknown>) {
      Object.assign(store.pending[state], patch);
    },
    _state: state,
  });

  const db: any = {
    collection: (name: string) => {
      if (name === 'wallets') {
        return {
          where: (_f: string, _op: string, userId: string) => ({
            limit: () => ({
              async get() {
                const walletId = store.walletsByUser[userId];
                return {
                  empty: walletId == null,
                  docs: walletId == null ? [] : [{ id: walletId, data: () => ({ user_id: userId }) }],
                };
              },
            }),
          }),
        };
      }
      if (name === 'github_connect_pending') {
        return { doc: pendingRef };
      }
      throw new Error(`unexpected collection ${name}`);
    },
    runTransaction: async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, doc: any) => {
          store.pending[ref._state] = doc;
        },
        update: (ref: any, patch: any) => {
          Object.assign(store.pending[ref._state], patch);
        },
      };
      return fn(tx);
    },
  };

  const deps: any = {
    db,
    cache: {},
    peBuffer: { enqueue: () => undefined },
    recordPEAccrual: async () => undefined,
  };
  const app = express();
  app.use(express.json());
  app.use('/v1/witnesses', createWitnessesGitHubRouter(deps));
  return app;
}

function freshStore(): FakeStore {
  return {
    walletsByUser: { user_1: 'wallet_1', user_2: 'wallet_2' },
    pending: {},
  };
}

describe('wallet-auth GitHub connect routes', () => {
  let prevSecret: string | undefined;
  let prevSlug: string | undefined;

  beforeEach(() => {
    mockInstalls.length = 0;
    mockPEs.length = 0;
  });

  beforeAll(() => {
    prevSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
    prevSlug = process.env.GITHUB_APP_SLUG;
    process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
    process.env.GITHUB_APP_SLUG = 'provian-witness';
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    else process.env.GITHUB_APP_WEBHOOK_SECRET = prevSecret;
    if (prevSlug === undefined) delete process.env.GITHUB_APP_SLUG;
    else process.env.GITHUB_APP_SLUG = prevSlug;
  });

  it('401 without a bearer token', async () => {
    const res = await request(buildApp(freshStore()))
      .post('/v1/witnesses/github/connect/wallet/start')
      .send({ state: STATE_A });
    expect(res.status).toBe(401);
  });

  it('surfaces verifier failure status', async () => {
    const res = await request(buildApp(freshStore()))
      .post('/v1/witnesses/github/connect/wallet/start')
      .set('Authorization', 'Bearer nope')
      .send({ state: STATE_A });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_signature' });
  });

  it('409 wallet_required when the user has no wallet row', async () => {
    const store = freshStore();
    const res = await request(buildApp(store))
      .post('/v1/witnesses/github/connect/wallet/start')
      .set('Authorization', 'Bearer valid:user_without_wallet')
      .send({ state: STATE_A });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'wallet_required' });
  });

  it('start: 400 on malformed state', async () => {
    const res = await request(buildApp(freshStore()))
      .post('/v1/witnesses/github/connect/wallet/start')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ state: 'not-hex' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_state' });
  });

  it('start: 200 with install_url carrying the state, session keyed to wallet id', async () => {
    const store = freshStore();
    const res = await request(buildApp(store))
      .post('/v1/witnesses/github/connect/wallet/start')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ state: STATE_A });
    expect(res.status).toBe(200);
    expect(res.body.install_url).toBe(
      `https://github.com/apps/provian-witness/installations/new?state=${STATE_A}`,
    );
    expect(typeof res.body.expires_at).toBe('number');
    // Id space invariant: the pending session is keyed to the WALLET doc id,
    // matching device.owner_wallet_id on the DeviceKey path.
    expect(store.pending[STATE_A].user_id).toBe('wallet_1');
  });

  it('start: 409 when the state is already held by a different user', async () => {
    const store = freshStore();
    const app = buildApp(store);
    await request(app)
      .post('/v1/witnesses/github/connect/wallet/start')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ state: STATE_A });
    const res = await request(app)
      .post('/v1/witnesses/github/connect/wallet/start')
      .set('Authorization', 'Bearer valid:user_2')
      .send({ state: STATE_A });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'state_in_use' });
  });

  it('poll: pending while GitHub has not called back, completed after', async () => {
    const store = freshStore();
    const app = buildApp(store);
    await request(app)
      .post('/v1/witnesses/github/connect/wallet/start')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ state: STATE_B });

    const pending = await request(app)
      .get(`/v1/witnesses/github/connect/wallet/poll?state=${STATE_B}`)
      .set('Authorization', 'Bearer valid:user_1');
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({ status: 'pending' });

    // Simulate GitHub's setup-callback marking completion.
    store.pending[STATE_B].status = 'completed';
    store.pending[STATE_B].installation_id = '424242';

    const done = await request(app)
      .get(`/v1/witnesses/github/connect/wallet/poll?state=${STATE_B}`)
      .set('Authorization', 'Bearer valid:user_1');
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.install_id).toBe('424242');
    // Install row and PE attributed to the wallet id.
    expect(mockInstalls[0].user_id).toBe('wallet_1');
    expect(mockPEs[0].walletId).toBe('wallet_1');
    expect(mockPEs[0].actionType).toBe('service_install_created');
  });

  it('poll: wrong user reads as expired (no existence leak)', async () => {
    const store = freshStore();
    const app = buildApp(store);
    await request(app)
      .post('/v1/witnesses/github/connect/wallet/start')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ state: STATE_A });
    store.pending[STATE_A].status = 'completed';
    store.pending[STATE_A].installation_id = '999';

    const res = await request(app)
      .get(`/v1/witnesses/github/connect/wallet/poll?state=${STATE_A}`)
      .set('Authorization', 'Bearer valid:user_2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'expired' });
  });
});
