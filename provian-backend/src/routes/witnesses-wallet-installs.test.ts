/**
 * Wallet-auth forge install surfaces (B3,) - the phone's registration,
 * list, and revoke paths:
 *
 * POST /gitlab/wallet/installs (witnesses-gitlab.ts)
 * POST /bitbucket/wallet/installs (witnesses-bitbucket.ts)
 * GET /installs (witnesses-installs.ts, cross-provider)
 * POST /installs/:provider/:installation_id/revoke (witnesses-installs.ts)
 *
 * Unlike witnesses-github.wallet-connect.test.ts (which mocks
 * service-installs), these tests run the REAL service-installs module over a
 * fake Firestore so the one-time webhook_secret semantics (B2) are exercised
 * for the wallet variants:
 * - fresh registration discloses the secret exactly once
 * - re-POST on an active install returns null + already_issued
 * - revoke + re-register mints a NEW secret (the rotation path)
 * - the cross-provider list NEVER carries webhook_secret (masking), proven
 * against a store row that demonstrably HAS one (non-vacuous: the test
 * asserts the row's secret exists and the list is non-empty first)
 *
 * verifyWalletAuthToken is stubbed (HMAC verification has its own tests);
 * generatePE is recorded, not executed.
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

const mockPEs: any[] = [];
jest.mock('../core/agent-bank/pe-utils', () => ({
  generatePE: async (_deps: unknown, params: any) => {
    mockPEs.push(params);
    return { peId: `pe_${mockPEs.length}`, peHash: `hash_${mockPEs.length}` };
  },
}));

import express from 'express';
import request from 'supertest';
import { installForgeAccountScope } from '../core/witnesses/service-installs';
import { createWitnessesGitLabRouter } from './witnesses-gitlab';
import { createWitnessesBitbucketRouter } from './witnesses-bitbucket';
import { createWitnessesInstallsRouter } from './witnesses-installs';

const SECRET = 'f'.repeat(48); // well-formed app-wide secret for the config gates

interface FakeStore {
  walletsByUser: Record<string, string>; // user_id -> wallet doc id
  installs: Record<string, any>; // doc id ({provider}_{installation_id}) -> row
}

function buildApp(store: FakeStore): express.Express {
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
      if (name === 'service_installs') {
        return {
          doc: (id: string) => ({
            async get() {
              const row = store.installs[id];
              return { exists: row != null, data: () => row };
            },
            async set(doc: any) {
              store.installs[id] = doc;
            },
            async update(patch: Record<string, unknown>) {
              Object.assign(store.installs[id], patch);
            },
          }),
          where: (_f: string, _op: string, userId: string) => ({
            async get() {
              const rows = Object.values(store.installs).filter(
                (r: any) => r.user_id === userId,
              );
              return { docs: rows.map((r) => ({ data: () => r })) };
            },
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };

  db.runTransaction = async (fn: (tx: any) => Promise<any>) => fn({
    get: async (ref: any) => ref.get(),
    set: async (ref: any, value: unknown, opts?: { merge?: boolean }) => ref.set(value, opts),
    update: async (ref: any, patch: Record<string, unknown>) => ref.update(patch),
  });

  const deps: any = {
    db,
    cache: {},
    peBuffer: { enqueue: () => undefined },
    recordPEAccrual: async () => undefined,
  };
  const app = express();
  app.use(express.json());
  app.use('/v1/witnesses', createWitnessesGitLabRouter(deps));
  app.use('/v1/witnesses', createWitnessesBitbucketRouter(deps));
  app.use('/v1/witnesses', createWitnessesInstallsRouter(deps));
  return app;
}

function freshStore(): FakeStore {
  return {
    walletsByUser: { user_1: 'wallet_1', user_2: 'wallet_2' },
    installs: {},
  };
}

const REPO_UUID = '{A1B2C3D4-1111-2222-3333-444455556666}';
const REPO_UUID_NORM = 'a1b2c3d4-1111-2222-3333-444455556666';

describe('wallet-auth forge install routes', () => {
  let prevGitLab: string | undefined;
  let prevBitbucket: string | undefined;

  beforeAll(() => {
    prevGitLab = process.env.GITLAB_WEBHOOK_SECRET;
    prevBitbucket = process.env.BITBUCKET_WEBHOOK_SECRET;
    process.env.GITLAB_WEBHOOK_SECRET = SECRET;
    process.env.BITBUCKET_WEBHOOK_SECRET = SECRET;
  });

  afterAll(() => {
    if (prevGitLab === undefined) delete process.env.GITLAB_WEBHOOK_SECRET;
    else process.env.GITLAB_WEBHOOK_SECRET = prevGitLab;
    if (prevBitbucket === undefined) delete process.env.BITBUCKET_WEBHOOK_SECRET;
    else process.env.BITBUCKET_WEBHOOK_SECRET = prevBitbucket;
  });

  beforeEach(() => {
    mockPEs.length = 0;
  });

  it('401 without a bearer token', async () => {
    const res = await request(buildApp(freshStore()))
      .post('/v1/witnesses/gitlab/wallet/installs')
      .send({ project_id: '123' });
    expect(res.status).toBe(401);
  });

  it('409 wallet_required when the user has no wallet row', async () => {
    const res = await request(buildApp(freshStore()))
      .post('/v1/witnesses/gitlab/wallet/installs')
      .set('Authorization', 'Bearer valid:user_without_wallet')
      .send({ project_id: '123' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'wallet_required' });
  });

  it('400 on a malformed project id', async () => {
    const res = await request(buildApp(freshStore()))
      .post('/v1/witnesses/gitlab/wallet/installs')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ project_id: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_project_id' });
  });

  it('gitlab: fresh registration discloses the one-time secret; re-POST does not', async () => {
    const store = freshStore();
    const app = buildApp(store);

    const first = await request(app)
      .post('/v1/witnesses/gitlab/wallet/installs')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ project_id: '123' });
    expect(first.status).toBe(200);
    expect(first.body.linked).toBe(true);
    expect(first.body.project_id).toBe('123');
    expect(first.body.webhook_secret_already_issued).toBe(false);
    expect(first.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(first.body.setup).toContain('/v1/witnesses/gitlab/webhook');
    // Attribution is the WALLET doc id (same id space as the DeviceKey path).
    expect(store.installs['gitlab_123'].user_id).toBe('wallet_1');
    expect(mockPEs[0].walletId).toBe('wallet_1');
    expect(mockPEs[0].actionType).toBe('service_install_created');

    const second = await request(app)
      .post('/v1/witnesses/gitlab/wallet/installs')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ project_id: '123' });
    expect(second.status).toBe(200);
    expect(second.body.webhook_secret).toBeNull();
    expect(second.body.webhook_secret_already_issued).toBe(true);
    expect(second.body.setup).toContain('revoke');
    // The stored secret was PRESERVED (no silent rotation).
    expect(store.installs['gitlab_123'].webhook_secret).toBe(first.body.webhook_secret);
  });

  it('409 when the project is already linked to a different wallet', async () => {
    const store = freshStore();
    const app = buildApp(store);
    await request(app)
      .post('/v1/witnesses/gitlab/wallet/installs')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ project_id: '777' });
    const res = await request(app)
      .post('/v1/witnesses/gitlab/wallet/installs')
      .set('Authorization', 'Bearer valid:user_2')
      .send({ project_id: '777' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'project_already_linked' });
  });

  it('bitbucket: fresh registration normalizes the repo uuid and discloses the secret once', async () => {
    const store = freshStore();
    const app = buildApp(store);
    const res = await request(app)
      .post('/v1/witnesses/bitbucket/wallet/installs')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ repo_uuid: REPO_UUID });
    expect(res.status).toBe(200);
    expect(res.body.repo_uuid).toBe(REPO_UUID_NORM);
    expect(res.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.webhook_secret_already_issued).toBe(false);
    expect(store.installs[`bitbucket_${REPO_UUID_NORM}`].user_id).toBe('wallet_1');
  });

  it('GET /installs lists across providers and NEVER carries webhook_secret', async () => {
    const store = freshStore();
    const app = buildApp(store);
    await request(app)
      .post('/v1/witnesses/gitlab/wallet/installs')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ project_id: '123' });
    await request(app)
      .post('/v1/witnesses/bitbucket/wallet/installs')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ repo_uuid: REPO_UUID });

    // Non-vacuous masking control: the stored rows really do hold secrets.
    expect(store.installs['gitlab_123'].webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(store.installs[`bitbucket_${REPO_UUID_NORM}`].webhook_secret).toMatch(/^[0-9a-f]{64}$/);

    const res = await request(app)
      .get('/v1/witnesses/installs')
      .set('Authorization', 'Bearer valid:user_1');
    expect(res.status).toBe(200);
    expect(res.body.installs.length).toBe(2);
    const providers = res.body.installs.map((i: any) => i.provider).sort();
    expect(providers).toEqual(['bitbucket', 'gitlab']);
    for (const install of res.body.installs) {
      expect(Object.keys(install).sort()).toEqual(
        ['forge_account_id', 'forge_account_login', 'installation_id', 'installed_at', 'provider', 'revoked_at'],
      );
      expect(install.revoked_at).toBeNull();
      // Part 2: the list carries the STABLE mapping scope, derived by the
      // ONE scope rule (installForgeAccountScope) — for these self-serve
      // providers that is the installation id itself. Bound to the rule, not
      // re-declared: a github row would read the stamped account or null.
      expect(install.forge_account_id).toBe(installForgeAccountScope({
        user_id: 'x', provider: install.provider, installation_id: install.installation_id,
        installed_at: 0, revoked_at: null,
      }));
      expect(install.forge_account_id).toBe(install.installation_id);
    }
    // Other users see none of it.
    const other = await request(app)
      .get('/v1/witnesses/installs')
      .set('Authorization', 'Bearer valid:user_2');
    expect(other.status).toBe(200);
    expect(other.body.installs).toEqual([]);
  });

  it('revoke is owner-scoped (404 for another wallet), idempotent, and validates provider', async () => {
    const store = freshStore();
    const app = buildApp(store);
    await request(app)
      .post('/v1/witnesses/gitlab/wallet/installs')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ project_id: '123' });

    const bad = await request(app)
      .post('/v1/witnesses/installs/svn/123/revoke')
      .set('Authorization', 'Bearer valid:user_1');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_provider' });

    const foreign = await request(app)
      .post('/v1/witnesses/installs/gitlab/123/revoke')
      .set('Authorization', 'Bearer valid:user_2');
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: 'install_not_found' });

    const revoked = await request(app)
      .post('/v1/witnesses/installs/gitlab/123/revoke')
      .set('Authorization', 'Bearer valid:user_1');
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(store.installs['gitlab_123'].revoked_at).toEqual(expect.any(Number));
    const revokePE = mockPEs.find((p) => p.actionType === 'service_install_revoked');
    expect(revokePE.metadata.provider).toBe('gitlab');

    const again = await request(app)
      .post('/v1/witnesses/installs/gitlab/123/revoke')
      .set('Authorization', 'Bearer valid:user_1');
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ revoked: true, idempotent: true });
  });

  it('503 with the connector error code when the app-wide secret is unset', async () => {
    // Config is read at router-factory time, so unset env before buildApp.
    delete process.env.GITLAB_WEBHOOK_SECRET;
    try {
      const res = await request(buildApp(freshStore()))
        .post('/v1/witnesses/gitlab/wallet/installs')
        .set('Authorization', 'Bearer valid:user_1')
        .send({ project_id: '123' });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'gitlab_webhook_not_configured' });
    } finally {
      process.env.GITLAB_WEBHOOK_SECRET = SECRET;
    }
  });

  it('revoke + re-register mints a NEW secret (the rotation path)', async () => {
    const store = freshStore();
    const app = buildApp(store);
    const first = await request(app)
      .post('/v1/witnesses/gitlab/wallet/installs')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ project_id: '123' });
    await request(app)
      .post('/v1/witnesses/installs/gitlab/123/revoke')
      .set('Authorization', 'Bearer valid:user_1');
    const second = await request(app)
      .post('/v1/witnesses/gitlab/wallet/installs')
      .set('Authorization', 'Bearer valid:user_1')
      .send({ project_id: '123' });
    expect(second.status).toBe(200);
    expect(second.body.webhook_secret_already_issued).toBe(false);
    expect(second.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(second.body.webhook_secret).not.toBe(first.body.webhook_secret);
    // Re-registration reactivated the install.
    expect(store.installs['gitlab_123'].revoked_at).toBeNull();
  });
});
