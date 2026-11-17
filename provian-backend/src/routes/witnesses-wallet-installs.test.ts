/**
 * Wallet-auth forge install surfaces - the phone's registration, list, and
 * revoke paths:
 *
 * POST /gitlab/wallet/installs/begin + /verify (witnesses-gitlab.ts)
 * POST /bitbucket/wallet/installs/begin + /verify (witnesses-bitbucket.ts)
 * GET /installs (witnesses-installs.ts, cross-provider)
 * POST /installs/:provider/:installation_id/revoke (witnesses-installs.ts)
 *
 * Registration proves control of the project by deploy key: begin returns a
 * public key the relay generated, the registrant adds it to the project, and
 * verify has the relay read the project with it. The forge is a stand-in
 * reached through the REAL proof (core/witnesses/forge-deploy-key.ts); only
 * the ls-remote run is replaced, so nothing reaches the network.
 *
 * These tests run the REAL service-installs module over a fake Firestore so
 * the one-time webhook_secret semantics are exercised for the wallet variants:
 * - fresh registration discloses the secret exactly once
 * - registering again on an active install returns null + already_issued
 * - revoke + register again mints a NEW secret (the rotation path)
 * - the cross-provider list NEVER carries webhook_secret (masking), proven
 * against a store row that demonstrably HAS one
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
import {
  DEPLOY_KEY_ATTEMPT_TTL_MS,
  BITBUCKET_CANARIES,
  type ProbeRequest,
  type ProbeRunner,
} from '../core/witnesses/forge-deploy-key';
import { fingerprintOfPrivateKey } from '../core/witnesses/__test-helpers__/openssh-key';
import { createWitnessesGitLabRouter } from './witnesses-gitlab';
import { createWitnessesBitbucketRouter } from './witnesses-bitbucket';
import { createWitnessesInstallsRouter } from './witnesses-installs';

const SECRET = 'f'.repeat(48); // well-formed app-wide secret for the config gates

/**
 * A stand-in forge at the probe level. GitLab answers the write probe: a
 * deploy key with write access on the project, or an account key with push
 * rights on it, is granted — a read-only key is not. Bitbucket answers the read
 * probe: an access key on the repository, or any account key on a public one.
 */
class FakeForge {
  readonly reads: ProbeRequest[] = [];
  private readonly deployKeys = new Map<string, Map<string, 'read' | 'write'>>();
  private readonly userKeys = new Map<string, Set<string>>(); // fingerprint -> GitLab paths its account may push to
  private readonly publicProjects = new Set<string>(BITBUCKET_CANARIES.map((p) => `bitbucket:${p}`));
  unavailable = false;

  readonly runner: ProbeRunner = async (req) => {
    this.reads.push(req);
    if (this.unavailable) return { kind: 'unavailable', reason: 'network' };
    const where = `${req.provider}:${req.repoPath}`;
    const fingerprint = fingerprintOfPrivateKey(req.privateKeyOpenSsh);
    const access = this.deployKeys.get(where)?.get(fingerprint);
    if (req.provider === 'gitlab') {
      return access === 'write' || this.userKeys.get(fingerprint)?.has(req.repoPath) ? { kind: 'granted' } : { kind: 'denied' };
    }
    if (access !== undefined) return { kind: 'granted' };
    if (this.userKeys.has(fingerprint) && this.publicProjects.has(where)) return { kind: 'granted' };
    return { kind: 'denied' };
  };

  addDeployKey(provider: string, path: string, fingerprint: string, access: 'read' | 'write' = provider === 'gitlab' ? 'write' : 'read'): void {
    const where = `${provider}:${path}`;
    if (!this.deployKeys.has(where)) this.deployKeys.set(where, new Map());
    this.deployKeys.get(where)!.set(fingerprint, access);
  }
  addUserKey(fingerprint: string, pushPaths: string[] = []): void { this.userKeys.set(fingerprint, new Set(pushPaths)); }
  makePublic(provider: string, path: string): void { this.publicProjects.add(`${provider}:${path}`); }
}

interface FakeStore {
  walletsByUser: Record<string, string>; // user_id -> wallet doc id
  installs: Record<string, any>; // doc id ({provider}_{installation_id}) -> row
  attempts: Record<string, any>; // deploy-key attempts by doc id
}

function buildApp(store: FakeStore, forge: FakeForge = new FakeForge(), now: () => number = Date.now): express.Express {
  const mapCollection = (rows: Record<string, any>) => ({
    doc: (id: string) => ({
      async get() {
        const row = rows[id];
        return { exists: row != null, data: () => row };
      },
      async set(doc: any) {
        rows[id] = doc;
      },
      async update(patch: Record<string, unknown>) {
        Object.assign(rows[id], patch);
      },
      async delete() {
        delete rows[id];
      },
    }),
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
      if (name === 'service_installs') {
        return {
          ...mapCollection(store.installs),
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
      if (name === 'forge_deploy_key_attempts_v1') return mapCollection(store.attempts);
      throw new Error(`unexpected collection ${name}`);
    },
  };

  db.runTransaction = async (fn: (tx: any) => Promise<any>) => fn({
    get: async (ref: any) => ref.get(),
    set: async (ref: any, value: unknown, opts?: { merge?: boolean }) => ref.set(value, opts),
    update: async (ref: any, patch: Record<string, unknown>) => ref.update(patch),
    delete: async (ref: any) => ref.delete(),
  });

  const deps: any = {
    db,
    cache: {},
    peBuffer: { enqueue: () => undefined },
    recordPEAccrual: async () => undefined,
  };
  const app = express();
  app.use(express.json());
  app.use('/v1/witnesses', createWitnessesGitLabRouter(deps, { runProbe: forge.runner, now }));
  app.use('/v1/witnesses', createWitnessesBitbucketRouter(deps, { runProbe: forge.runner, now }));
  app.use('/v1/witnesses', createWitnessesInstallsRouter(deps));
  return app;
}

function freshStore(): FakeStore {
  return {
    walletsByUser: { user_1: 'wallet_1', user_2: 'wallet_2' },
    installs: {},
    attempts: {},
  };
}

const REPO_UUID = '{A1B2C3D4-1111-2222-3333-444455556666}';
const REPO_UUID_NORM = 'a1b2c3d4-1111-2222-3333-444455556666';

type Provider = 'gitlab' | 'bitbucket';
const idBody = (provider: Provider, id: string) => (provider === 'gitlab' ? { project_id: id } : { repo_uuid: id });
const begin = (app: express.Express, user: string, provider: Provider, id: string) =>
  request(app).post(`/v1/witnesses/${provider}/wallet/installs/begin`).set('Authorization', `Bearer valid:${user}`).send(idBody(provider, id));
const verify = (app: express.Express, user: string, provider: Provider, id: string, projectPath: unknown) =>
  request(app).post(`/v1/witnesses/${provider}/wallet/installs/verify`).set('Authorization', `Bearer valid:${user}`)
    .send({ ...idBody(provider, id), project_path: projectPath });

/** The honest flow: begin, add the returned key to the project as a deploy key, verify. */
async function register(app: express.Express, forge: FakeForge, user: string, provider: Provider, id: string, projectPath: string) {
  const started = await begin(app, user, provider, id);
  expect(started.status).toBe(200);
  forge.addDeployKey(provider, projectPath.toLowerCase(), started.body.key_fingerprint);
  return verify(app, user, provider, id, projectPath);
}

/** The stored install row for a proven path (rows are keyed by the proven path, not the id). */
function installFor(store: FakeStore, provider: Provider, projectPath: string): any {
  const rows = Object.entries(store.installs)
    .filter(([key, row]) => key.startsWith(`${provider}@path_`) && row.control_proof?.project_path === projectPath);
  expect(rows).toHaveLength(1);
  return rows[0][1];
}

function withConnectorSecrets(): void {
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
}

describe('wallet-auth forge install routes', () => {
  withConnectorSecrets();

  it('401 without a bearer token', async () => {
    const res = await request(buildApp(freshStore()))
      .post('/v1/witnesses/gitlab/wallet/installs/begin')
      .send({ project_id: '123' });
    expect(res.status).toBe(401);
  });

  it('409 wallet_required when the user has no wallet row', async () => {
    const res = await begin(buildApp(freshStore()), 'user_without_wallet', 'gitlab', '123');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'wallet_required' });
  });

  it('400 on a malformed project id, at begin and at verify', async () => {
    const app = buildApp(freshStore());
    const res = await begin(app, 'user_1', 'gitlab', 'not-a-number');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_project_id' });
    expect((await verify(app, 'user_1', 'gitlab', 'not-a-number', 'group/project')).status).toBe(400);
  });

  it('gitlab: fresh registration discloses the one-time secret; registering again does not', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);

    const first = await register(app, forge, 'user_1', 'gitlab', '123', 'group/project');
    expect(first.status).toBe(200);
    expect(first.body.linked).toBe(true);
    expect(first.body.project_id).toBe('123');
    expect(first.body.webhook_secret_already_issued).toBe(false);
    expect(first.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(first.body.setup).toContain('/v1/witnesses/gitlab/webhook');
    // Attribution is the WALLET doc id (same id space as the DeviceKey path).
    expect(installFor(store, 'gitlab', 'group/project').user_id).toBe('wallet_1');
    expect(mockPEs[0].walletId).toBe('wallet_1');
    expect(mockPEs[0].actionType).toBe('service_install_created');

    const second = await register(app, forge, 'user_1', 'gitlab', '123', 'group/project');
    expect(second.status).toBe(200);
    expect(second.body.webhook_secret).toBeNull();
    expect(second.body.webhook_secret_already_issued).toBe(true);
    expect(second.body.setup).toContain('revoke');
    // The stored secret was PRESERVED (no silent rotation).
    expect(installFor(store, 'gitlab', 'group/project').webhook_secret).toBe(first.body.webhook_secret);
  });

  it('409 when the project path is already linked to a different wallet', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    expect((await register(app, forge, 'user_1', 'gitlab', '777', 'group/project')).status).toBe(200);
    expect((await begin(app, 'user_2', 'gitlab', '777')).status).toBe(200);
    const res = await verify(app, 'user_2', 'gitlab', '777', 'group/project');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'project_already_linked' });
  });

  it('bitbucket: fresh registration normalizes the repo uuid and discloses the secret once', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    const res = await register(app, forge, 'user_1', 'bitbucket', REPO_UUID, 'workspace/repo');
    expect(res.status).toBe(200);
    expect(res.body.repo_uuid).toBe(REPO_UUID_NORM);
    expect(res.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.webhook_secret_already_issued).toBe(false);
    expect(installFor(store, 'bitbucket', 'workspace/repo').user_id).toBe('wallet_1');
  });

  it('GET /installs lists across providers and NEVER carries webhook_secret', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    await register(app, forge, 'user_1', 'gitlab', '123', 'group/project');
    await register(app, forge, 'user_1', 'bitbucket', REPO_UUID, 'workspace/repo');

    // Non-vacuous masking control: the stored rows really do hold secrets.
    expect(installFor(store, 'gitlab', 'group/project').webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(installFor(store, 'bitbucket', 'workspace/repo').webhook_secret).toMatch(/^[0-9a-f]{64}$/);

    const res = await request(app)
      .get('/v1/witnesses/installs')
      .set('Authorization', 'Bearer valid:user_1');
    expect(res.status).toBe(200);
    expect(res.body.installs.length).toBe(2);
    const providers = res.body.installs.map((i: any) => i.provider).sort();
    expect(providers).toEqual(['bitbucket', 'gitlab']);
    for (const install of res.body.installs) {
      expect(Object.keys(install).sort()).toEqual(
        ['control_proven', 'forge_account_id', 'forge_account_login', 'installation_id', 'installed_at', 'provider', 'revoked_at'],
      );
      expect(install.revoked_at).toBeNull();
      // The list carries the STABLE mapping scope, derived by the ONE scope
      // rule (installForgeAccountScope) — for these self-serve providers that
      // is the proven project path, never the unproven id.
      const path = install.provider === 'gitlab' ? 'group/project' : 'workspace/repo';
      expect(install.forge_account_id).toBe(installForgeAccountScope(installFor(store, install.provider, path)));
      expect(install.forge_account_id).toBe(path);
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
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    await register(app, forge, 'user_1', 'gitlab', '123', 'group/project');

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
    expect(installFor(store, 'gitlab', 'group/project').revoked_at).toEqual(expect.any(Number));
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
      const app = buildApp(freshStore());
      const res = await begin(app, 'user_1', 'gitlab', '123');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'gitlab_webhook_not_configured' });
      expect((await verify(app, 'user_1', 'gitlab', '123', 'group/project')).status).toBe(503);
    } finally {
      process.env.GITLAB_WEBHOOK_SECRET = SECRET;
    }
  });

  it('revoke + register again mints a NEW secret (the rotation path)', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    const first = await register(app, forge, 'user_1', 'gitlab', '123', 'group/project');
    await request(app)
      .post('/v1/witnesses/installs/gitlab/123/revoke')
      .set('Authorization', 'Bearer valid:user_1');
    const second = await register(app, forge, 'user_1', 'gitlab', '123', 'group/project');
    expect(second.status).toBe(200);
    expect(second.body.webhook_secret_already_issued).toBe(false);
    expect(second.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(second.body.webhook_secret).not.toBe(first.body.webhook_secret);
    // Registering again reactivated the install.
    expect(installFor(store, 'gitlab', 'group/project').revoked_at).toBeNull();
  });
});

describe('registration requires a deploy key on exactly that project', () => {
  withConnectorSecrets();

  it('RED: the single-call registration registers nothing and names the two steps', async () => {
    const store = freshStore();
    const app = buildApp(store);
    for (const provider of ['gitlab', 'bitbucket'] as const) {
      const res = await request(app)
        .post(`/v1/witnesses/${provider}/wallet/installs`)
        .set('Authorization', 'Bearer valid:user_1')
        .send(idBody(provider, provider === 'gitlab' ? '123' : REPO_UUID));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('deploy_key_proof_required');
      expect(res.body.hint).toContain(`/v1/witnesses/${provider}/installs/begin`);
    }
    expect(store.installs).toEqual({});
    expect(store.attempts).toEqual({});
    expect(mockPEs).toHaveLength(0);
  });

  it('begin returns only the public half and the forge steps; the private key stays in the relay\'s store', async () => {
    const store = freshStore();
    const res = await begin(buildApp(store), 'user_1', 'gitlab', '123');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['expires_at', 'instructions', 'key_fingerprint', 'project_id', 'public_key']);
    expect(res.body.public_key).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ provian-deploy-key$/);
    expect(res.body.instructions).toContain('Settings > Repository > Deploy keys');
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
    const attempts = Object.values(store.attempts);
    expect(attempts).toHaveLength(1);
    expect(fingerprintOfPrivateKey(attempts[0].private_key)).toBe(res.body.key_fingerprint);
    // No install and no secret until verify.
    expect(store.installs).toEqual({});
  });

  it('RED: verify before the key is added → 403 deploy_key_not_found; no install, no secret, no PE; the attempt stays for a retry', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    await begin(app, 'user_1', 'gitlab', '123');
    const res = await verify(app, 'user_1', 'gitlab', '123', 'group/project');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'deploy_key_not_found' });
    expect(store.installs).toEqual({});
    expect(mockPEs).toHaveLength(0);
    expect(Object.keys(store.attempts)).toHaveLength(1);
  });

  it('RED: the key on a DIFFERENT project than the one named does not register it', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    const started = await begin(app, 'user_1', 'gitlab', '123');
    forge.addDeployKey('gitlab', 'attacker/own-project', started.body.key_fingerprint);
    const res = await verify(app, 'user_1', 'gitlab', '123', 'victim/project');
    expect(res.status).toBe(403);
    expect(store.installs).toEqual({});
  });

  it('RED: GitLab: a READ-ONLY deploy key on the named project does not register it', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    const started = await begin(app, 'user_1', 'gitlab', '123');
    forge.addDeployKey('gitlab', 'group/project', started.body.key_fingerprint, 'read');
    const res = await verify(app, 'user_1', 'gitlab', '123', 'group/project');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'deploy_key_not_found' });
    expect(store.installs).toEqual({});
    // One probe, on the named project only: GitLab has no canary.
    expect(forge.reads.map((r) => `${r.provider}:${r.repoPath}`)).toEqual(['gitlab:group/project']);
  });

  it('RED: GitLab: the key on the registrant\'s own account (which can read any public project) cannot push to it — refused', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    forge.makePublic('gitlab', 'popular/oss-project');
    const app = buildApp(store, forge);
    const started = await begin(app, 'user_1', 'gitlab', '278964');
    forge.addUserKey(started.body.key_fingerprint);
    const res = await verify(app, 'user_1', 'gitlab', '278964', 'popular/oss-project');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'deploy_key_not_found' });
    expect(store.installs).toEqual({});
  });

  it('GitLab: an account key with push rights on the project is accepted as control', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    const started = await begin(app, 'user_1', 'gitlab', '123');
    forge.addUserKey(started.body.key_fingerprint, ['group/project']);
    const res = await verify(app, 'user_1', 'gitlab', '123', 'group/project');
    expect(res.status).toBe(200);
    expect(res.body.control_proven).toBe(true);
  });

  it('RED: Bitbucket: the key on the registrant\'s own account reads a public repository it does not control — refused by the canary, and the attempt ends', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    forge.makePublic('bitbucket', 'popular/oss-repo');
    const app = buildApp(store, forge);
    const started = await begin(app, 'user_1', 'bitbucket', REPO_UUID);
    forge.addUserKey(started.body.key_fingerprint);
    const res = await verify(app, 'user_1', 'bitbucket', REPO_UUID, 'popular/oss-repo');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'deploy_key_not_project_specific' });
    expect(store.installs).toEqual({});
    expect(store.attempts).toEqual({});
  });

  it('RED: an attempt past its window is refused 410 and deleted, and the forge is never asked', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    let clock = 5_000_000;
    const app = buildApp(store, forge, () => clock);
    const started = await begin(app, 'user_1', 'gitlab', '123');
    forge.addDeployKey('gitlab', 'group/project', started.body.key_fingerprint);
    clock += DEPLOY_KEY_ATTEMPT_TTL_MS + 1;
    const res = await verify(app, 'user_1', 'gitlab', '123', 'group/project');
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'attempt_expired' });
    expect(store.attempts).toEqual({});
    expect(store.installs).toEqual({});
    expect(forge.reads).toHaveLength(0);
  });

  it('verify without a begin is 404; another wallet cannot verify this wallet\'s attempt', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    expect((await verify(app, 'user_1', 'gitlab', '123', 'group/project')).status).toBe(404);
    const started = await begin(app, 'user_1', 'gitlab', '123');
    forge.addDeployKey('gitlab', 'group/project', started.body.key_fingerprint);
    expect((await verify(app, 'user_2', 'gitlab', '123', 'group/project')).status).toBe(404);
    expect(store.installs).toEqual({});
  });

  it('RED: a malformed or hostile project path is 400 and never reaches the forge', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    await begin(app, 'user_1', 'gitlab', '123');
    for (const projectPath of [undefined, '', 'project', '-oProxyCommand=x/y', 'group/../x', 'group/project.git', 'a/b;id', 12]) {
      const res = await verify(app, 'user_1', 'gitlab', '123', projectPath);
      expect([projectPath, res.status, res.body.error]).toEqual([projectPath, 400, 'invalid_project_path']);
    }
    expect(forge.reads).toHaveLength(0);
  });

  it('success: the private key is deleted, the proof (fingerprint + path) is recorded, the user is told to remove the key', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    const started = await begin(app, 'user_1', 'gitlab', '123');
    forge.addDeployKey('gitlab', 'group/project', started.body.key_fingerprint);
    const res = await verify(app, 'user_1', 'gitlab', '123', 'Group/Project');
    expect(res.status).toBe(200);
    expect(res.body.control_proven).toBe(true);
    expect(res.body.project_path).toBe('group/project');
    expect(res.body.setup).toContain('The relay has deleted its private key. Remove the deploy key from the project now');
    expect(store.attempts).toEqual({});
    expect(installFor(store, 'gitlab', 'group/project').control_proof).toEqual({
      method: 'deploy_key', key_fingerprint: started.body.key_fingerprint, verified_at: expect.any(Number), project_path: 'group/project',
    });
    // The relay probed the named project once, on the fixed forge only (GitLab has no canary).
    expect(forge.reads.map((r) => `${r.provider}:${r.repoPath}`)).toEqual(['gitlab:group/project']);
    for (const blob of [JSON.stringify(store.installs), JSON.stringify(res.body), JSON.stringify(mockPEs)]) {
      expect(blob).not.toContain('PRIVATE KEY');
    }
  });

  it('a forge that cannot be asked is 503 and the attempt stays for a retry', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    forge.unavailable = true;
    const app = buildApp(store, forge);
    await begin(app, 'user_1', 'bitbucket', REPO_UUID);
    const res = await verify(app, 'user_1', 'bitbucket', REPO_UUID, 'workspace/repo');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'forge_unavailable' });
    expect(Object.keys(store.attempts)).toHaveLength(1);
  });

  it('RED: an existing registration with no proof does not hold the project against a registrant who proves control', async () => {
    const store = freshStore();
    // user_2 registered project 555 before proof was required: active, secret issued, no proof.
    store.installs['gitlab_555'] = {
      user_id: 'wallet_2', provider: 'gitlab', installation_id: '555', installed_at: 1, revoked_at: null,
      webhook_secret: 'a'.repeat(64),
    };
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    // Without the key on the project the newcomer gets nothing and the row is untouched.
    await begin(app, 'user_1', 'gitlab', '555');
    expect((await verify(app, 'user_1', 'gitlab', '555', 'group/project')).status).toBe(403);
    expect(store.installs['gitlab_555'].user_id).toBe('wallet_2');

    const res = await register(app, forge, 'user_1', 'gitlab', '555', 'group/project');
    expect(res.status).toBe(200);
    // The proven registration lives at its path; the earlier id-keyed row is
    // untouched and authenticates nothing.
    expect(installFor(store, 'gitlab', 'group/project').user_id).toBe('wallet_1');
    expect(store.installs['gitlab_555'].user_id).toBe('wallet_2');
    // A fresh secret: the earlier holder's secret no longer verifies anything.
    expect(res.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.webhook_secret).not.toBe('a'.repeat(64));
    expect(installFor(store, 'gitlab', 'group/project').webhook_secret).toBe(res.body.webhook_secret);
    expect(mockPEs.map((p) => p.actionType)).toEqual(['service_install_created']);
  });

  it('a proven registration holds its path against a second wallet at verify, before any forge read, whatever id it names', async () => {
    const store = freshStore();
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    expect((await register(app, forge, 'user_1', 'gitlab', '777', 'group/project')).status).toBe(200);
    const readsBefore = forge.reads.length;
    for (const id of ['777', '888']) {
      expect((await begin(app, 'user_2', 'gitlab', id)).status).toBe(200);
      expect((await verify(app, 'user_2', 'gitlab', id, 'group/project')).status).toBe(409);
    }
    expect(installFor(store, 'gitlab', 'group/project').user_id).toBe('wallet_1');
    expect(forge.reads).toHaveLength(readsBefore);
  });

  for (const [provider, victimId, victimPath, attackerPath] of [
    ['gitlab', '4242', 'victim/project', 'attacker/x'],
    ['bitbucket', REPO_UUID, 'victim/repo', 'attacker/x'],
  ] as const) {
    it(`RED: ${provider}: naming the victim's id while proving attacker/x locks nothing — the victim registers its own path`, async () => {
      const store = freshStore();
      const forge = new FakeForge();
      const app = buildApp(store, forge);
      // The attacker begins with the victim's id, adds the key (write, on GitLab) to its own project, verifies that path.
      const attacker = await register(app, forge, 'user_2', provider, victimId, attackerPath);
      expect(attacker.status).toBe(200);
      // The victim, real maintainer of victimPath, registers it under its own id.
      const victim = await register(app, forge, 'user_1', provider, victimId, victimPath);
      expect(victim.status).toBe(200);
      expect(victim.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
      expect(installFor(store, provider, victimPath).user_id).toBe('wallet_1');
      // The attacker's row covers only its own path.
      expect(installFor(store, provider, attackerPath).user_id).toBe('wallet_2');
      expect(Object.keys(store.installs).filter((k) => k.startsWith(`${provider}_`))).toEqual([]);
      // Revoking by the shared id revokes only the caller's own row.
      const idParam = provider === 'gitlab' ? victimId : REPO_UUID_NORM;
      expect((await request(app).post(`/v1/witnesses/installs/${provider}/${encodeURIComponent(idParam)}/revoke`)
        .set('Authorization', 'Bearer valid:user_2')).status).toBe(200);
      expect(installFor(store, provider, attackerPath).revoked_at).toEqual(expect.any(Number));
      expect(installFor(store, provider, victimPath).revoked_at).toBeNull();
    });
  }

  it('the list shows which installs still need to be registered with proof', async () => {
    const store = freshStore();
    store.installs['gitlab_900'] = { user_id: 'wallet_1', provider: 'gitlab', installation_id: '900', installed_at: 1, revoked_at: null, webhook_secret: 'b'.repeat(64) };
    const forge = new FakeForge();
    const app = buildApp(store, forge);
    await register(app, forge, 'user_1', 'gitlab', '123', 'group/project');
    const res = await request(app).get('/v1/witnesses/installs').set('Authorization', 'Bearer valid:user_1');
    const byId = Object.fromEntries(res.body.installs.map((i: any) => [i.installation_id, i.control_proven]));
    expect(byId).toEqual({ '900': false, '123': true });
  });
});
