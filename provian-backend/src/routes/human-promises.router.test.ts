/**
 * human-promise router auth boundary.
 *
 * The router is mounted BEHIND the top-level `authenticate` middleware in
 * server.ts; its own `resolveCaller` is the second line of defense — it returns
 * 401 when no wallet identity is present and resolves the caller's OWN human
 * wallet (never client-supplied) otherwise. This suite proves the negative
 * control "an unauthenticated call cannot" and that a resolved caller can create.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

const resolveHumanWalletMock = jest.fn();
jest.mock('../core/presentation/principal', () => ({
  resolveHumanWallet: (...args: unknown[]) => (resolveHumanWalletMock as (...a: unknown[]) => unknown)(...args),
}));
// Push is best-effort; stub it so a create never depends on FCM.
jest.mock('../core/notifications/pushDispatcher', () => ({
  sendPushToUser: jest.fn(async () => ({ successCount: 0, failureCount: 0, invalidTokens: [], expoCount: 0, fcmCount: 0, hadTokens: false })),
}));

// eslint-disable-next-line import/first
import { createHumanPromisesRouter } from './human-promises';
// eslint-disable-next-line import/first
import { humanPromiseSignMessage } from '../core/human-promises/promise-signing';

const WALLET = new ethers.Wallet(`0x${'11'.repeat(32)}`);
const PROMISE = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'a'.repeat(64);

/** A minimal in-memory db that supports create's transaction path. */
function makeDb() {
  const store = new Map<string, Record<string, unknown>>();
  const docRef = (col: string, id: string) => ({
    id,
    collectionPath: col,
    async get() { const d = store.get(`${col}/${id}`); return { exists: d !== undefined, data: () => d }; },
    async set(data: Record<string, unknown>) { store.set(`${col}/${id}`, data); },
  });
  return {
    store,
    collection: (col: string) => ({ doc: (id: string) => docRef(col, id) }),
    async runTransaction<T>(fn: (txn: unknown) => Promise<T>): Promise<T> {
      const pending: Array<() => void> = [];
      const txn = {
        async get(ref: { get: () => Promise<unknown> }) { return ref.get(); },
        set(ref: { collectionPath: string; id: string }, data: Record<string, unknown>) {
          pending.push(() => store.set(`${ref.collectionPath}/${ref.id}`, data));
        },
      };
      const result = await fn(txn);
      pending.forEach((p) => p());
      return result;
    },
  };
}

const cache = { checkRateLimitStrict: jest.fn(async () => ({ allowed: true })) };

function makeApp(withUser: boolean) {
  const db = makeDb();
  const app = express();
  app.use(express.json());
  if (withUser) {
    // Simulate the `authenticate` middleware setting req.user.
    app.use((req, _res, next) => { (req as express.Request & { user?: unknown }).user = { id: 'user_1', device_id: 'dev_1' }; next(); });
  }
  app.use('/v1/human-promises', createHumanPromisesRouter({ db: db as never, cache: cache as never }));
  return { app, db };
}

beforeEach(() => {
  resolveHumanWalletMock.mockReset();
  cache.checkRateLimitStrict.mockClear();
});

describe('human-promise router — auth boundary', () => {
  it('RED — an UNAUTHENTICATED create is refused with 401 (no wallet identity)', async () => {
    const { app } = makeApp(false); // no req.user
    const res = await request(app).post('/v1/human-promises/create').send({
      promise_id: PROMISE, digest: DIGEST, signature: '0xdeadbeef', terms_ciphertext: 'ct',
    });
    expect(res.status).toBe(401);
  });

  it('RED — an authenticated account with NO human wallet is refused (fail-closed)', async () => {
    resolveHumanWalletMock.mockResolvedValue({ ok: false, status: 404, error: 'no first-party human wallet found for this account' } as never);
    const { app } = makeApp(true);
    const res = await request(app).post('/v1/human-promises/create').send({
      promise_id: PROMISE, digest: DIGEST, signature: '0xdeadbeef', terms_ciphertext: 'ct',
    });
    expect(res.status).toBe(404);
  });

  it('a resolved caller with a valid signature creates the promise (non-vacuity)', async () => {
    resolveHumanWalletMock.mockResolvedValue({ ok: true, walletId: 'w1', address: WALLET.address.toLowerCase() } as never);
    const signature = await WALLET.signMessage(humanPromiseSignMessage('create', PROMISE, DIGEST));
    const { app, db } = makeApp(true);
    const res = await request(app).post('/v1/human-promises/create').send({
      promise_id: PROMISE, digest: DIGEST, signature, terms_ciphertext: 'ct',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(db.store.get(`human_promises/${PROMISE}`)).toBeDefined();
  });
});
