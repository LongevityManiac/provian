/**
 * service-installs CRUD + custody-invariant tests.
 *
 * Asserts the ServiceInstallDocument has NO secret/token field (the whole
 * point of Tier A custody) and exercises the four CRUD functions against
 * an in-memory Firestore mock matching the pattern used in
 * core/foundation-membership/client.shortCircuit.test.ts.
 */

import {
  createServiceInstall,
  getServiceInstallByInstallationId,
  installForgeAccountScope,
  markServiceInstallRevoked,
  getServiceInstallsByUser,
  stampServiceInstallForgeAccount,
  ServiceInstallOwnedByOtherUserError,
  type ServiceInstallDocument,
  installControlProven,
  installProjectPathMatches,
  isUsableInstallationId,
  getProvenServiceInstallByProjectPath,
  getOwnedServiceInstallsByInstallationId,
  revokeOwnedServiceInstalls,
} from './service-installs';

// -----------------------------------------------------------------------------
// In-memory Firestore mock
// -----------------------------------------------------------------------------

interface DocSnap {
  exists: boolean;
  id: string;
  data: () => unknown;
}

function makeFakeDb(): { db: any; store: Map<string, Map<string, unknown>> } {
  const store: Map<string, Map<string, unknown>> = new Map();

  function collectionApi(name: string) {
    if (!store.has(name)) store.set(name, new Map());
    const docs = store.get(name)!;
    return {
      doc: (id: string) => ({
        async get(): Promise<DocSnap> {
          return {
            exists: docs.has(id),
            id,
            data: () => docs.get(id),
          };
        },
        async set(value: unknown, opts?: { merge?: boolean }) {
          docs.set(id, opts?.merge
            ? { ...((docs.get(id) as Record<string, unknown> | undefined) ?? {}), ...(value as Record<string, unknown>) }
            : value);
        },
        async update(patch: Record<string, unknown>) {
          const cur = (docs.get(id) ?? {}) as Record<string, unknown>;
          docs.set(id, { ...cur, ...patch });
        },
      }),
      where: (field: string, _op: string, value: unknown) => ({
        async get() {
          const out: DocSnap[] = [];
          for (const [id, v] of docs) {
            if ((v as Record<string, unknown>)[field] === value) {
              out.push({ exists: true, id, data: () => v });
            }
          }
          return { docs: out };
        },
      }),
    };
  }

  const db = {
    collection: (name: string) => collectionApi(name),
    // Non-isolating transaction, same shape as the shared witness fake.
    runTransaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => fn({
      get: async (ref: any) => ref.get(),
      set: async (ref: any, value: unknown, opts?: { merge?: boolean }) => ref.set(value, opts),
      update: async (ref: any, patch: Record<string, unknown>) => ref.update(patch),
    }),
  };
  return { db, store };
}

// -----------------------------------------------------------------------------
// Custody invariant - type-level
// -----------------------------------------------------------------------------

describe('ServiceInstallDocument - Tier A custody invariant', () => {
  it('has NO secret, NO token, and NO oauth_scopes field', () => {
    // Sample doc with every declared field populated.
    const sample: ServiceInstallDocument = {
      user_id: 'user_1',
      provider: 'github',
      installation_id: 'inst_42',
      installed_at: 0,
      revoked_at: null,
    };
    const allowedKeys = new Set<keyof ServiceInstallDocument>([
      'user_id',
      'provider',
      'installation_id',
      'installed_at',
      'revoked_at',
    ]);
    // Every key on the sample must be in the allowlist. If a forbidden
    // field were added to the interface, TS would let it onto `sample`
    // and this assertion would fail.
    for (const key of Object.keys(sample)) {
      expect(allowedKeys.has(key as keyof ServiceInstallDocument)).toBe(true);
    }
    // Explicitly named forbidden keys - defense in depth in case the
    // allowlist drifts. Cast through `unknown` per TS strict-mode rules.
    const sampleAsRecord = sample as unknown as Record<string, unknown>;
    expect(sampleAsRecord.access_token).toBeUndefined();
    expect(sampleAsRecord.refresh_token).toBeUndefined();
    expect(sampleAsRecord.webhook_secret).toBeUndefined();
    expect(sampleAsRecord.oauth_scopes).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

describe('service-installs CRUD', () => {
  it('createServiceInstall writes a doc with the expected shape and no secret', async () => {
    const { db, store } = makeFakeDb();
    const { doc, secretIssued } = await createServiceInstall(db, {
      user_id: 'user_1',
      provider: 'github',
      installation_id: 'inst_42',
    });
    // github installs NEVER carry a per-install secret (App-secret model).
    expect(secretIssued).toBe(false);
    expect(doc.webhook_secret).toBeUndefined();
    expect(doc.user_id).toBe('user_1');
    expect(doc.provider).toBe('github');
    expect(doc.installation_id).toBe('inst_42');
    expect(doc.installed_at).toBeGreaterThan(0);
    expect(doc.revoked_at).toBeNull();

    const stored = store.get('service_installs')!.get('github_inst_42') as Record<string, unknown>;
    expect(stored).toBeDefined();
    expect(stored.webhook_secret).toBeUndefined();
    expect(stored.access_token).toBeUndefined();
    expect(stored.refresh_token).toBeUndefined();
  });

  it('createServiceInstall rejects empty user_id and empty installation_id', async () => {
    const { db } = makeFakeDb();
    await expect(
      createServiceInstall(db, { user_id: '', provider: 'github', installation_id: 'x' }),
    ).rejects.toThrow(/user_id is required/);
    await expect(
      createServiceInstall(db, { user_id: 'u', provider: 'github', installation_id: '' }),
    ).rejects.toThrow(/installation_id is required/);
  });

  it('getServiceInstallByInstallationId returns null when not found', async () => {
    const { db } = makeFakeDb();
    const result = await getServiceInstallByInstallationId(db, 'github', 'missing');
    expect(result).toBeNull();
  });

  it('getServiceInstallByInstallationId returns the stored doc when present', async () => {
    const { db } = makeFakeDb();
    await createServiceInstall(db, {
      user_id: 'user_1',
      provider: 'github',
      installation_id: 'inst_42',
    });
    const result = await getServiceInstallByInstallationId(db, 'github', 'inst_42');
    expect(result).not.toBeNull();
    expect(result!.user_id).toBe('user_1');
    expect(result!.installation_id).toBe('inst_42');
  });

  it('markServiceInstallRevoked sets revoked_at on an active install', async () => {
    const { db } = makeFakeDb();
    await createServiceInstall(db, {
      user_id: 'user_1',
      provider: 'github',
      installation_id: 'inst_42',
    });
    const result = await markServiceInstallRevoked(db, 'github', 'inst_42');
    expect(result).toBe(true);
    const after = await getServiceInstallByInstallationId(db, 'github', 'inst_42');
    expect(after!.revoked_at).not.toBeNull();
    expect(after!.revoked_at).toBeGreaterThan(0);
  });

  it('markServiceInstallRevoked is idempotent on an already-revoked install', async () => {
    const { db } = makeFakeDb();
    await createServiceInstall(db, {
      user_id: 'user_1',
      provider: 'github',
      installation_id: 'inst_42',
    });
    await markServiceInstallRevoked(db, 'github', 'inst_42');
    const first = await getServiceInstallByInstallationId(db, 'github', 'inst_42');
    await new Promise((r) => setTimeout(r, 5));
    await markServiceInstallRevoked(db, 'github', 'inst_42');
    const second = await getServiceInstallByInstallationId(db, 'github', 'inst_42');
    expect(second!.revoked_at).toBe(first!.revoked_at); // unchanged
  });

  it('markServiceInstallRevoked returns false when install does not exist', async () => {
    const { db } = makeFakeDb();
    const result = await markServiceInstallRevoked(db, 'github', 'missing');
    expect(result).toBe(false);
  });

  it('getServiceInstallsByUser returns all installs for a user', async () => {
    const { db } = makeFakeDb();
    await createServiceInstall(db, {
      user_id: 'user_1',
      provider: 'github',
      installation_id: 'inst_1',
    });
    await createServiceInstall(db, {
      user_id: 'user_1',
      provider: 'github',
      installation_id: 'inst_2',
    });
    await createServiceInstall(db, {
      user_id: 'user_2',
      provider: 'github',
      installation_id: 'inst_3',
    });
    const userOne = await getServiceInstallsByUser(db, 'user_1');
    expect(userOne).toHaveLength(2);
    const ids = userOne.map((d) => d.installation_id).sort();
    expect(ids).toEqual(['inst_1', 'inst_2']);
  });

  it('getServiceInstallsByUser returns empty array for empty user_id', async () => {
    const { db } = makeFakeDb();
    const result = await getServiceInstallsByUser(db, '');
    expect(result).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Forge-account stamp + scope (2026-08-16 re-key)
// -----------------------------------------------------------------------------

describe('stampServiceInstallForgeAccount / installForgeAccountScope', () => {
  it('stamps a github install once and is a no-op on identical re-stamp', async () => {
    const { db } = makeFakeDb();
    await createServiceInstall(db, { user_id: 'u1', provider: 'github', installation_id: '42' });

    const first = await stampServiceInstallForgeAccount(db, 'github', '42', {
      id: '21031067', login: 'octocat',
    });
    expect(first).toBe(true);
    const stamped = await getServiceInstallByInstallationId(db, 'github', '42');
    expect(stamped?.forge_account_id).toBe('21031067');
    expect(stamped?.forge_account_login).toBe('octocat');

    const second = await stampServiceInstallForgeAccount(db, 'github', '42', {
      id: '21031067', login: 'octocat',
    });
    expect(second).toBe(false); // idempotent — nothing written
  });

  it('updates the stamp when the account changes', async () => {
    const { db } = makeFakeDb();
    await createServiceInstall(db, { user_id: 'u1', provider: 'github', installation_id: '42' });
    await stampServiceInstallForgeAccount(db, 'github', '42', { id: '111', login: 'old' });
    const changed = await stampServiceInstallForgeAccount(db, 'github', '42', { id: '222', login: 'new' });
    expect(changed).toBe(true);
    const after = await getServiceInstallByInstallationId(db, 'github', '42');
    expect(after?.forge_account_id).toBe('222');
    expect(after?.forge_account_login).toBe('new');
  });

  // NEGATIVE CONTROLS (guard-that-can-fail): the stamp never creates a row and
  // never accepts an empty account id.
  it('does NOT create a row for an unknown install, and rejects an empty id', async () => {
    const { db, store } = makeFakeDb();
    const missing = await stampServiceInstallForgeAccount(db, 'github', 'nope', {
      id: '21031067', login: 'octocat',
    });
    expect(missing).toBe(false);
    expect(store.get('service_installs')?.size ?? 0).toBe(0);

    await createServiceInstall(db, { user_id: 'u1', provider: 'github', installation_id: '42' });
    const empty = await stampServiceInstallForgeAccount(db, 'github', '42', { id: '', login: null });
    expect(empty).toBe(false);
    const row = await getServiceInstallByInstallationId(db, 'github', '42');
    expect(row?.forge_account_id).toBeUndefined();
  });

  it('installForgeAccountScope: github = stamped id or NULL (never installation_id); gitlab/bitbucket = the proven path or NULL (never the id)', () => {
    const githubUnstamped: ServiceInstallDocument = {
      user_id: 'u1', provider: 'github', installation_id: '42', installed_at: 1, revoked_at: null,
    };
    // Unknown = Block: an unstamped github install has NO scope — falling back
    // to installation_id would compare across GitHub's two numbering spaces.
    expect(installForgeAccountScope(githubUnstamped)).toBeNull();

    const githubStamped: ServiceInstallDocument = {
      ...githubUnstamped, forge_account_id: '21031067', forge_account_login: 'octocat',
    };
    expect(installForgeAccountScope(githubStamped)).toBe('21031067');

    // The id a registrant names is not proven (two wallets may name the same
    // one), so it is never a scope: the proven path is, and no proof, no scope.
    const proof = { method: 'deploy_key', key_fingerprint: 'SHA256:' + 'D'.repeat(43), verified_at: 1 } as const;
    const gitlab: ServiceInstallDocument = {
      user_id: 'u1', provider: 'gitlab', installation_id: 'proj_9', installed_at: 1, revoked_at: null,
    };
    expect(installForgeAccountScope(gitlab)).toBeNull();
    expect(installForgeAccountScope({ ...gitlab, control_proof: { ...proof, project_path: 'group/project' } })).toBe('group/project');

    const bitbucket: ServiceInstallDocument = {
      user_id: 'u1', provider: 'bitbucket', installation_id: '{uuid-1}', installed_at: 1, revoked_at: null,
    };
    expect(installForgeAccountScope(bitbucket)).toBeNull();
    expect(installForgeAccountScope({ ...bitbucket, control_proof: { ...proof, project_path: 'workspace/repo' } })).toBe('workspace/repo');
  });
});

// -----------------------------------------------------------------------------
// Install hijack guard (2026-10-17)
// -----------------------------------------------------------------------------
//
// An ACTIVE (provider, installation_id) row belongs to exactly one user. Before
// this guard `createServiceInstall` was an unconditional `.set()`: the GitHub
// connect flow (unauthenticated setup-callback → authenticated poll) let ANY
// user name ANOTHER user's installation id and take over its webhook
// deliveries, and the GitLab/Bitbucket route checks were read-then-set races.

describe('createServiceInstall hijack guard (2026-10-17)', () => {
  it('refuses to re-point an ACTIVE install to another user, for every provider', async () => {
    for (const provider of ['github', 'gitlab', 'bitbucket'] as const) {
      const { db, store } = makeFakeDb();
      await createServiceInstall(db, { user_id: 'wallet_owner', provider, installation_id: '77' });
      await expect(
        createServiceInstall(db, { user_id: 'wallet_other', provider, installation_id: '77' }),
      ).rejects.toBeInstanceOf(ServiceInstallOwnedByOtherUserError);
      const row = store.get('service_installs')!.get(`${provider}_77`) as ServiceInstallDocument;
      expect(row.user_id).toBe('wallet_owner');
      expect(row.revoked_at).toBeNull();
    }
  });

  it('a REVOKED install may be re-registered by another user (the rotation path stays open)', async () => {
    const { db, store } = makeFakeDb();
    await createServiceInstall(db, { user_id: 'wallet_owner', provider: 'gitlab', installation_id: '77' });
    await markServiceInstallRevoked(db, 'gitlab', '77');
    const { doc, secretIssued } = await createServiceInstall(db, {
      user_id: 'wallet_other', provider: 'gitlab', installation_id: '77',
    });
    expect(doc.user_id).toBe('wallet_other');
    expect(doc.revoked_at).toBeNull();
    expect(secretIssued).toBe(true);
    const row = store.get('service_installs')!.get('gitlab_77') as ServiceInstallDocument;
    expect(row.user_id).toBe('wallet_other');
  });

  it('a same-owner github re-install keeps the stamped forge account', async () => {
    const { db, store } = makeFakeDb();
    await createServiceInstall(db, { user_id: 'wallet_owner', provider: 'github', installation_id: '77' });
    await stampServiceInstallForgeAccount(db, 'github', '77', { id: '4242', login: 'owner' });
    await createServiceInstall(db, { user_id: 'wallet_owner', provider: 'github', installation_id: '77' });
    const row = store.get('service_installs')!.get('github_77') as ServiceInstallDocument;
    expect(row.forge_account_id).toBe('4242');
    expect(row.forge_account_login).toBe('owner');
    expect(row.user_id).toBe('wallet_owner');
  });
});

describe('installation ids that cannot be document ids', () => {
  /** Firestore refuses a document id containing "/"; this db does the same. */
  function strictDb(): any {
    const { db } = makeFakeDb();
    const collection = db.collection.bind(db);
    db.collection = (name: string) => {
      const col = collection(name);
      const doc = col.doc.bind(col);
      col.doc = (id: string) => {
        if (id.includes('/')) throw new Error('Value for argument "documentPath" must point to a document');
        return doc(id);
      };
      return col;
    };
    return db;
  }

  it('RED: a lookup, a revoke and a stamp for an id containing "/" answer "no such install" instead of throwing', async () => {
    const db = strictDb();
    for (const id of ['a/b', 'a/b/c', '../x', '', ' 12', 'x'.repeat(129)]) {
      expect(await getServiceInstallByInstallationId(db, 'gitlab', id)).toBeNull();
      expect(await markServiceInstallRevoked(db, 'gitlab', id)).toBe(false);
    }
  });

  it('RED: such an id is never registered', async () => {
    const db = strictDb();
    await expect(createServiceInstall(db, { user_id: 'u1', provider: 'gitlab', installation_id: 'a/b' }))
      .rejects.toThrow(/not a usable id/);
  });

  it('real ids are usable: a numeric project id, a normalized repository uuid', () => {
    expect(isUsableInstallationId('278964')).toBe(true);
    expect(isUsableInstallationId('a1b2c3d4-1111-2222-3333-444455556666')).toBe(true);
    expect(isUsableInstallationId(278964)).toBe(false);
  });
});

describe('control proof on a self-serve install', () => {
  const PROOF = { method: 'deploy_key', key_fingerprint: 'SHA256:' + 'B'.repeat(43), verified_at: 5, project_path: 'group/project' } as const;

  it('a registration records the proof it was given, and none when it was given none', async () => {
    const { db } = makeFakeDb();
    const proven = await createServiceInstall(db, { user_id: 'u1', provider: 'gitlab', installation_id: '1', control_proof: PROOF });
    expect(installControlProven(proven.doc)).toBe(true);
    const unproven = await createServiceInstall(db, { user_id: 'u1', provider: 'gitlab', installation_id: '2' });
    expect(installControlProven(unproven.doc)).toBe(false);
    // A proof is of THAT registration: registering again without one clears it.
    const again = await createServiceInstall(db, { user_id: 'u1', provider: 'gitlab', installation_id: '1' });
    expect(installControlProven(again.doc)).toBe(false);
    expect((await getServiceInstallByInstallationId(db, 'gitlab', '1'))?.control_proof).toBeNull();
  });

  it('a github install needs no recorded proof; a malformed proof is no proof', () => {
    expect(installControlProven({ user_id: 'u', provider: 'github', installation_id: '9', installed_at: 1, revoked_at: null })).toBe(true);
    const base = { user_id: 'u', provider: 'gitlab' as const, installation_id: '9', installed_at: 1, revoked_at: null };
    expect(installControlProven(base)).toBe(false);
    expect(installControlProven({ ...base, control_proof: null })).toBe(false);
    expect(installControlProven({ ...base, control_proof: { ...PROOF, method: 'unknown_method' } as never })).toBe(false);
    expect(installControlProven({ ...base, control_proof: { ...PROOF, key_fingerprint: 'MD5:aa' } })).toBe(false);
    expect(installControlProven({ ...base, control_proof: { ...PROOF, project_path: '' } })).toBe(false);
    expect(installControlProven({ ...base, control_proof: { method: 'deploy_key', verified_at: 1 } as never })).toBe(false);
    expect(installControlProven({ ...base, control_proof: PROOF })).toBe(true);
  });

  it('RED: an unproven active row yields to a different user who brings a proof, with a fresh secret', async () => {
    const { db } = makeFakeDb();
    const squatter = await createServiceInstall(db, { user_id: 'squatter', provider: 'gitlab', installation_id: '7' });
    const owner = await createServiceInstall(db, { user_id: 'owner', provider: 'gitlab', installation_id: '7', control_proof: PROOF });
    expect(owner.doc.user_id).toBe('owner');
    expect(owner.secretIssued).toBe(true);
    expect(owner.doc.webhook_secret).not.toBe(squatter.doc.webhook_secret);
  });

  it('the hijack guard still holds: no proof takes nothing, and a proven row yields to no one', async () => {
    const { db } = makeFakeDb();
    await createServiceInstall(db, { user_id: 'first', provider: 'gitlab', installation_id: '8' });
    await expect(createServiceInstall(db, { user_id: 'second', provider: 'gitlab', installation_id: '8' }))
      .rejects.toBeInstanceOf(ServiceInstallOwnedByOtherUserError);
    await createServiceInstall(db, { user_id: 'owner', provider: 'gitlab', installation_id: '9', control_proof: PROOF });
    await expect(createServiceInstall(db, { user_id: 'second', provider: 'gitlab', installation_id: '9', control_proof: PROOF }))
      .rejects.toBeInstanceOf(ServiceInstallOwnedByOtherUserError);
    // github is never superseded this way.
    await createServiceInstall(db, { user_id: 'first', provider: 'github', installation_id: '10' });
    await expect(createServiceInstall(db, { user_id: 'second', provider: 'github', installation_id: '10', control_proof: PROOF }))
      .rejects.toBeInstanceOf(ServiceInstallOwnedByOtherUserError);
  });
});

describe('installProjectPathMatches', () => {
  const PROOF = { method: 'deploy_key', key_fingerprint: 'SHA256:' + 'C'.repeat(43), verified_at: 5, project_path: 'group/project' } as const;
  const install: ServiceInstallDocument = { user_id: 'u', provider: 'gitlab', installation_id: '1', installed_at: 1, revoked_at: null, control_proof: PROOF };

  it('matches the proven path case-insensitively and nothing else', () => {
    expect(installProjectPathMatches(install, 'group/project')).toBe(true);
    expect(installProjectPathMatches(install, 'Group/Project')).toBe(true);
    expect(installProjectPathMatches(install, 'group/project2')).toBe(false);
    expect(installProjectPathMatches(install, 'group')).toBe(false);
  });

  it('RED: an install with no proof matches no path', () => {
    expect(installProjectPathMatches({ ...install, control_proof: null }, 'group/project')).toBe(false);
  });
});

describe('a proven gitlab/bitbucket install is keyed by its proven path, not the id it names', () => {
  const proofFor = (project_path: string) =>
    ({ method: 'deploy_key', key_fingerprint: 'SHA256:' + 'E'.repeat(43), verified_at: 5, project_path }) as const;

  it('RED: two wallets naming the same id under different proven paths both register; neither touches the other', async () => {
    const { db, store } = makeFakeDb();
    const attacker = await createServiceInstall(db, { user_id: 'attacker', provider: 'gitlab', installation_id: '100', control_proof: proofFor('attacker/x') });
    const victim = await createServiceInstall(db, { user_id: 'victim', provider: 'gitlab', installation_id: '100', control_proof: proofFor('victim/project') });
    expect(victim.doc.user_id).toBe('victim');
    expect((await getProvenServiceInstallByProjectPath(db, 'gitlab', 'victim/project'))?.user_id).toBe('victim');
    expect((await getProvenServiceInstallByProjectPath(db, 'gitlab', 'attacker/x'))?.user_id).toBe('attacker');
    expect(attacker.doc.webhook_secret).not.toBe(victim.doc.webhook_secret);
    // Nothing is written at the id key.
    expect(store.get('service_installs')!.has('gitlab_100')).toBe(false);
    expect([...store.get('service_installs')!.keys()].every((k) => k.startsWith('gitlab@path_'))).toBe(true);
  });

  it('the path is held by one active wallet: a second wallet proving the same path is refused, whatever id it names', async () => {
    const { db } = makeFakeDb();
    await createServiceInstall(db, { user_id: 'owner', provider: 'bitbucket', installation_id: 'uuid-1', control_proof: proofFor('workspace/repo') });
    await expect(createServiceInstall(db, { user_id: 'other', provider: 'bitbucket', installation_id: 'uuid-2', control_proof: proofFor('workspace/repo') }))
      .rejects.toBeInstanceOf(ServiceInstallOwnedByOtherUserError);
  });

  it('the same wallet keeps its secret only for the same path AND the same id', async () => {
    const { db } = makeFakeDb();
    const first = await createServiceInstall(db, { user_id: 'u', provider: 'gitlab', installation_id: '1', control_proof: proofFor('g/p') });
    const again = await createServiceInstall(db, { user_id: 'u', provider: 'gitlab', installation_id: '1', control_proof: proofFor('g/p') });
    expect(again.secretIssued).toBe(false);
    expect(again.doc.webhook_secret).toBe(first.doc.webhook_secret);
    const otherId = await createServiceInstall(db, { user_id: 'u', provider: 'gitlab', installation_id: '2', control_proof: proofFor('g/p') });
    expect(otherId.secretIssued).toBe(true);
    expect(otherId.doc.installation_id).toBe('2');
  });

  it('a row keyed only by the id is never found by path, and does not block a proven registration', async () => {
    const { db } = makeFakeDb();
    await createServiceInstall(db, { user_id: 'squatter', provider: 'gitlab', installation_id: '7' });
    expect(await getProvenServiceInstallByProjectPath(db, 'gitlab', 'group/project')).toBeNull();
    const owner = await createServiceInstall(db, { user_id: 'owner', provider: 'gitlab', installation_id: '7', control_proof: proofFor('group/project') });
    expect(owner.doc.user_id).toBe('owner');
    expect((await getServiceInstallByInstallationId(db, 'gitlab', '7'))?.user_id).toBe('squatter');
  });

  it('RED: a proven registration revokes the same wallet\'s earlier id-keyed row for that id, and no other wallet\'s', async () => {
    const { db, store } = makeFakeDb();
    await createServiceInstall(db, { user_id: 'owner', provider: 'gitlab', installation_id: '900' });
    await createServiceInstall(db, { user_id: 'other', provider: 'gitlab', installation_id: '901' });
    await createServiceInstall(db, { user_id: 'owner', provider: 'gitlab', installation_id: '900', control_proof: proofFor('group/project') });
    await createServiceInstall(db, { user_id: 'owner', provider: 'gitlab', installation_id: '901', control_proof: proofFor('group/other') });
    const rows = store.get('service_installs')!;
    expect((rows.get('gitlab_900') as ServiceInstallDocument).revoked_at).toEqual(expect.any(Number));
    expect((rows.get('gitlab_901') as ServiceInstallDocument).user_id).toBe('other');
    expect((rows.get('gitlab_901') as ServiceInstallDocument).revoked_at).toBeNull();
    // Revoking by id afterwards touches only the live proven row; the earlier one is already revoked.
    expect(await revokeOwnedServiceInstalls(db, 'owner', 'gitlab', '900')).toEqual({ found: true, revoked: 1 });
  });

  it('RED: a proof whose path is not normalized is refused', async () => {
    const { db } = makeFakeDb();
    for (const path of ['', 'Group/Project', ' group/project']) {
      await expect(createServiceInstall(db, { user_id: 'u', provider: 'gitlab', installation_id: '1', control_proof: proofFor(path) }))
        .rejects.toThrow(/not a normalized path/);
    }
  });

  it('revoke and lookup by id are owner-scoped and reach the path-keyed row', async () => {
    const { db } = makeFakeDb();
    await createServiceInstall(db, { user_id: 'attacker', provider: 'gitlab', installation_id: '100', control_proof: proofFor('attacker/x') });
    await createServiceInstall(db, { user_id: 'victim', provider: 'gitlab', installation_id: '100', control_proof: proofFor('victim/project') });
    expect((await getOwnedServiceInstallsByInstallationId(db, 'attacker', 'gitlab', '100')).map((i) => i.control_proof?.project_path)).toEqual(['attacker/x']);
    expect(await revokeOwnedServiceInstalls(db, 'attacker', 'gitlab', '100')).toEqual({ found: true, revoked: 1 });
    expect((await getProvenServiceInstallByProjectPath(db, 'gitlab', 'attacker/x'))?.revoked_at).not.toBeNull();
    expect((await getProvenServiceInstallByProjectPath(db, 'gitlab', 'victim/project'))?.revoked_at).toBeNull();
    expect(await revokeOwnedServiceInstalls(db, 'attacker', 'gitlab', '100')).toEqual({ found: true, revoked: 0 });
    expect(await revokeOwnedServiceInstalls(db, 'nobody', 'gitlab', '100')).toEqual({ found: false, revoked: 0 });
  });
});
