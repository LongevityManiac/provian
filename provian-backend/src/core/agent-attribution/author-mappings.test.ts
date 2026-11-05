/**
 * author-mappings unit tests — the 2026-08-16 forge-account re-key.
 *
 * The defect this suite guards: mapping scope used to digest the EPHEMERAL
 * wallet id, so the 08-13 GitHub reinstall (new installation_id, install row
 * re-pointed to a new wallet) orphaned every mapping and every push dropped
 * `dropped_unmapped_author`. Scope is now the STABLE forge account. Each
 * assertion ships with its violating-input control in-suite (the three
 * named shapes — no empty populations, no self-referential fixtures, no
 * unreachable branches).
 */

import {
  createOwnerCaptureMapping,
  createVerifiedAuthorMapping,
  mappingDocId,
  normalizeAuthorKey,
  resolveAgentAuthorAttribution,
  revokeAuthorMapping,
  type AgentAuthorMappingDocument,
} from './author-mappings';
import { createServiceInstall, stampServiceInstallForgeAccount } from '../witnesses/service-installs';

// -----------------------------------------------------------------------------
// In-memory Firestore mock (doc get/set/update + single-field where + txn)
// -----------------------------------------------------------------------------

interface DocSnap {
  exists: boolean;
  id: string;
  data: () => unknown;
}

function makeFakeDb(): { db: any; store: Map<string, Map<string, Record<string, unknown>>> } {
  const store: Map<string, Map<string, Record<string, unknown>>> = new Map();

  function collectionApi(name: string) {
    if (!store.has(name)) store.set(name, new Map());
    const docs = store.get(name)!;
    return {
      doc: (id: string) => ({
        async get(): Promise<DocSnap> {
          return { exists: docs.has(id), id, data: () => docs.get(id) };
        },
        async set(value: Record<string, unknown>) {
          docs.set(id, value);
        },
        async update(patch: Record<string, unknown>) {
          const cur = docs.get(id) ?? {};
          docs.set(id, { ...cur, ...patch });
        },
      }),
      where: (field: string, _op: string, value: unknown) => ({
        async get() {
          const out: DocSnap[] = [];
          for (const [id, v] of docs) {
            if (v[field] === value) out.push({ exists: true, id, data: () => v });
          }
          return { docs: out };
        },
      }),
    };
  }

  const db = {
    collection: (name: string) => collectionApi(name),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: async (ref: any, value: Record<string, unknown>) => ref.set(value),
        update: async (ref: any, patch: Record<string, unknown>) => ref.update(patch),
      };
      return fn(tx);
    },
  };
  return { db, store };
}

const FORGE_A = '21031067';
const FORGE_B = '999999';

// Seed a `wallets` doc the WS4 owner-capture path resolves for the canonical
// accrual identity. The doc id ≠ user_id ON PURPOSE (`wallet_A` vs `user_A`): a
// regression that stored the doc id where user_id belongs is then a visible
// assertion failure, not a silent pass (the identity the code reads is
// the single source, never a re-typed copy).
function seedWallet(
  store: Map<string, Map<string, Record<string, unknown>>>,
  walletId: string,
  over: Partial<{ user_id: string; address: string; type: string; id: string }> = {},
): { userId: string; address: string } {
  if (!store.has('wallets')) store.set('wallets', new Map());
  const suffix = walletId.replace(/^wallet_/, '');
  const doc = {
    id: over.id ?? walletId,
    type: over.type ?? 'human',
    user_id: over.user_id ?? `user_${suffix}`,
    address: over.address ?? `0x${suffix}`,
  };
  store.get('wallets')!.set(walletId, doc);
  return { userId: doc.user_id as string, address: doc.address as string };
}
const ATLAS_EMAIL = normalizeAuthorKey({ type: 'email', value: 'atlas@example.com' })!;
const OCTOCAT_USER = normalizeAuthorKey({ type: 'username', value: 'octocat' })!;

function explicitParams(overrides: Partial<Parameters<typeof createVerifiedAuthorMapping>[1]> = {}) {
  return {
    provider: 'github' as const,
    forgeAccountId: FORGE_A,
    forgeAccountLogin: 'octocat',
    sourceOwnerWalletId: 'wallet_A',
    agentWalletId: 'wallet_aw_atlas',
    agentId: 'atlas',
    agentAddress: '0xatlas',
    authorKey: ATLAS_EMAIL,
    ...overrides,
  };
}

// =============================================================================
// mappingDocId — the stable-scope keying rule
// =============================================================================

describe('mappingDocId', () => {
  it('is deterministic per (provider, forge account, key) and DIFFERS across forge accounts', () => {
    const a1 = mappingDocId({ provider: 'github', forgeAccountId: FORGE_A, authorKey: ATLAS_EMAIL });
    const a2 = mappingDocId({ provider: 'github', forgeAccountId: FORGE_A, authorKey: ATLAS_EMAIL });
    const b = mappingDocId({ provider: 'github', forgeAccountId: FORGE_B, authorKey: ATLAS_EMAIL });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b); // scope containment starts at the doc id
    expect(a1.startsWith('github_')).toBe(true);
  });
});

// =============================================================================
// createVerifiedAuthorMapping — conflict granularity
// =============================================================================

describe('createVerifiedAuthorMapping', () => {
  it('persists the forge scope on the doc', async () => {
    const { db } = makeFakeDb();
    const doc = await createVerifiedAuthorMapping(db, explicitParams());
    expect(doc.forge_account_id).toBe(FORGE_A);
    expect(doc.forge_account_login).toBe('octocat');
    expect(doc.verified_by).toBe('agent_wallet_signature');
    expect(doc.status).toBe('active');
  });

  // RED control (the guard CAN fail and does): one active wallet per identity
  // per forge account — the conflict throw preserved verbatim at the re-keyed
  // granularity.
  it('rejects binding the same identity on the same forge account to a different wallet', async () => {
    const { db } = makeFakeDb();
    await createVerifiedAuthorMapping(db, explicitParams());
    await expect(
      createVerifiedAuthorMapping(db, explicitParams({ agentWalletId: 'wallet_other' })),
    ).rejects.toThrow('author_key_already_mapped');
  });

  it('allows the same identity on a DIFFERENT forge account (scope is per forge account)', async () => {
    const { db, store } = makeFakeDb();
    await createVerifiedAuthorMapping(db, explicitParams());
    await createVerifiedAuthorMapping(db, explicitParams({
      forgeAccountId: FORGE_B, agentWalletId: 'wallet_other', agentId: 'other',
    }));
    expect(store.get('agent_author_mappings')!.size).toBe(2);
  });
});

// =============================================================================
// createOwnerCaptureMapping — precedence + rebind
// =============================================================================

describe('createOwnerCaptureMapping', () => {
  function capture(db: any, ownerWalletId: string) {
    return createOwnerCaptureMapping(db, {
      provider: 'github',
      forgeAccountId: FORGE_A,
      forgeAccountLogin: 'octocat',
      ownerWalletId,
      authorKey: OCTOCAT_USER,
    });
  }

  it('creates a mapping that stores the wallet USER_ID + address, not the doc id (WS4)', async () => {
    const { db, store } = makeFakeDb();
    const { userId, address } = seedWallet(store, 'wallet_A');
    const doc = await capture(db, 'wallet_A');
    expect(doc).not.toBeNull();
    expect(doc!.verified_by).toBe('repo_owner_capture');
    expect(doc!.forge_account_id).toBe(FORGE_A);
    // agent_wallet_id (the scope/rebind key) stays the DOC id...
    expect(doc!.agent_wallet_id).toBe('wallet_A');
    expect(doc!.source_owner_wallet_id).toBe('wallet_A');
    // ...but the accrual identity is the wallet's user_id FIELD + address.
    expect(doc!.agent_id).toBe(userId);
    expect(doc!.agent_id).not.toBe('wallet_A');
    expect(doc!.agent_address).toBe(address);
  });

  // RED CONTROL: the WS4 fail-closed path fires. No resolvable owner wallet →
  // null, and NO mapping is written (Unknown = Block). Before the fix this
  // returned a mis-keyed mapping.
  it('FAILS CLOSED (returns null, writes nothing) when the owner wallet is unresolvable', async () => {
    const { db, store } = makeFakeDb();
    const result = await capture(db, 'wallet_missing'); // never seeded
    expect(result).toBeNull();
    expect(store.get('agent_author_mappings') ?? new Map()).toEqual(new Map());
  });

  // RED CONTROL: a non-human / id-mismatched wallet doc also fails closed.
  it('FAILS CLOSED for a non-human wallet doc', async () => {
    const { db, store } = makeFakeDb();
    seedWallet(store, 'wallet_agentish', { type: 'agent' });
    expect(await capture(db, 'wallet_agentish')).toBeNull();
  });

  it('is idempotent under the same owner', async () => {
    const { db, store } = makeFakeDb();
    seedWallet(store, 'wallet_A');
    const first = await capture(db, 'wallet_A');
    const second = await capture(db, 'wallet_A');
    expect(second).toEqual(first);
    expect(store.get('agent_author_mappings')!.size).toBe(1);
  });

  // RED CONTROL: a legacy doc-id-keyed mapping (agent_id == doc id, empty
  // address — the exact production shape) is HEALED in place on re-capture.
  // Before the WS4 heal this returned the broken mapping untouched.
  it('HEALS a legacy doc-id-keyed mapping to the wallet user_id/address', async () => {
    const { db, store } = makeFakeDb();
    const { userId, address } = seedWallet(store, 'wallet_A');
    const mappingId = mappingDocId({ provider: 'github', forgeAccountId: FORGE_A, authorKey: OCTOCAT_USER });
    // Pre-store the broken production shape under the same deterministic doc id.
    if (!store.has('agent_author_mappings')) store.set('agent_author_mappings', new Map());
    store.get('agent_author_mappings')!.set(mappingId, {
      mapping_id: mappingId, provider: 'github', forge_account_id: FORGE_A,
      forge_account_login: 'octocat', source_owner_wallet_id: 'wallet_A',
      agent_wallet_id: 'wallet_A', agent_id: 'wallet_A', agent_address: '',
      author_key_type: OCTOCAT_USER.type, author_key: OCTOCAT_USER.value,
      author_key_hash: OCTOCAT_USER.hash, key_fingerprint: null,
      verified_by: 'repo_owner_capture', status: 'active',
      created_at: 1, verified_at: 1, revoked_at: null,
    });
    const healed = await capture(db, 'wallet_A');
    expect(healed).not.toBeNull();
    expect(healed!.agent_id).toBe(userId);
    expect(healed!.agent_address).toBe(address);
    expect(healed!.agent_wallet_id).toBe('wallet_A'); // scope key untouched
    expect(store.get('agent_author_mappings')!.size).toBe(1); // healed in place
  });

  it('REBINDS to the current owner when the install was re-pointed (owner-capture follows install ownership)', async () => {
    const { db, store } = makeFakeDb();
    seedWallet(store, 'wallet_A');
    const bIdentity = seedWallet(store, 'wallet_B');
    await capture(db, 'wallet_A');
    const rebound = await capture(db, 'wallet_B');
    expect(rebound).not.toBeNull();
    expect(rebound!.agent_wallet_id).toBe('wallet_B');
    expect(rebound!.source_owner_wallet_id).toBe('wallet_B');
    expect(rebound!.agent_id).toBe(bIdentity.userId);
    expect(rebound!.agent_address).toBe(bIdentity.address);
    expect(rebound!.verified_by).toBe('repo_owner_capture');
    expect(rebound!.status).toBe('active');
    expect(store.get('agent_author_mappings')!.size).toBe(1); // same doc, rebound
  });

  it('rebind re-activates a capture revoked under the PREVIOUS ownership era', async () => {
    const { db, store } = makeFakeDb();
    seedWallet(store, 'wallet_A');
    seedWallet(store, 'wallet_B');
    const doc = await capture(db, 'wallet_A');
    await revokeAuthorMapping(db, { mappingId: doc!.mapping_id, callerWalletId: 'wallet_A' });
    const rebound = await capture(db, 'wallet_B');
    expect(rebound!.status).toBe('active');
    expect(rebound!.revoked_at).toBeNull();
    expect(rebound!.agent_wallet_id).toBe('wallet_B');
  });

  // NEGATIVE CONTROL: a SAME-owner revocation is respected — re-capture must
  // not resurrect a mapping its own owner deliberately revoked.
  it('does NOT re-activate a capture the CURRENT owner revoked', async () => {
    const { db, store } = makeFakeDb();
    seedWallet(store, 'wallet_A');
    const doc = await capture(db, 'wallet_A');
    await revokeAuthorMapping(db, { mappingId: doc!.mapping_id, callerWalletId: 'wallet_A' });
    const again = await capture(db, 'wallet_A');
    expect(again!.status).toBe('revoked');
  });

  // NEGATIVE CONTROL: explicit outranks capture — an agent_wallet_signature
  // mapping for the same identity is returned untouched, never rebound.
  it('never clobbers or rebinds an explicit agent_wallet_signature mapping', async () => {
    const { db, store } = makeFakeDb();
    seedWallet(store, 'wallet_B');
    const explicit = await createVerifiedAuthorMapping(db, explicitParams({ authorKey: OCTOCAT_USER }));
    const fromCapture = await capture(db, 'wallet_B');
    expect(fromCapture).toEqual(explicit);
    expect(fromCapture!.verified_by).toBe('agent_wallet_signature');
    expect(fromCapture!.agent_wallet_id).toBe('wallet_aw_atlas');
  });
});

// =============================================================================
// resolveAgentAuthorAttribution — the orphan core
// =============================================================================

describe('resolveAgentAuthorAttribution', () => {
  it('resolves by forge account with NO owner-wallet condition (a re-point cannot orphan)', async () => {
    const { db } = makeFakeDb();
    await createVerifiedAuthorMapping(db, explicitParams()); // vouched by wallet_A
    // The delivering install is now owned by wallet_B — the mapping still matches.
    const resolved = await resolveAgentAuthorAttribution(db, {
      provider: 'github',
      forgeAccountId: FORGE_A,
      sourceOwnerWalletId: 'wallet_B',
      candidates: [{ type: 'email', value: 'Atlas@Example.com' }],
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.agentWalletId).toBe('wallet_aw_atlas');
    expect(resolved!.forgeAccountId).toBe(FORGE_A);
    expect(resolved!.sourceOwnerWalletId).toBe('wallet_B'); // pass-through provenance
  });

  // RED control (scope containment — the guard CAN fail): the same identity
  // does NOT resolve under a different forge account.
  it('does NOT resolve under a different forge account', async () => {
    const { db } = makeFakeDb();
    await createVerifiedAuthorMapping(db, explicitParams());
    const resolved = await resolveAgentAuthorAttribution(db, {
      provider: 'github',
      forgeAccountId: FORGE_B,
      sourceOwnerWalletId: 'wallet_A',
      candidates: [{ type: 'email', value: 'atlas@example.com' }],
    });
    expect(resolved).toBeNull();
  });

  // Defensive self-consistency: a hand-written doc parked at the right doc id
  // but carrying a MISMATCHED forge_account_id field is refused (Unknown = Block).
  it('rejects a doc whose forge_account_id field mismatches its doc-id scope', async () => {
    const { db } = makeFakeDb();
    const docId = mappingDocId({ provider: 'github', forgeAccountId: FORGE_A, authorKey: ATLAS_EMAIL });
    await db.collection('agent_author_mappings').doc(docId).set({
      mapping_id: docId,
      provider: 'github',
      forge_account_id: FORGE_B, // inconsistent with the id derivation
      forge_account_login: null,
      source_owner_wallet_id: 'wallet_A',
      agent_wallet_id: 'wallet_aw_atlas',
      agent_id: 'atlas',
      agent_address: '0xatlas',
      author_key_type: 'email',
      author_key: 'atlas@example.com',
      author_key_hash: ATLAS_EMAIL.hash,
      key_fingerprint: null,
      verified_by: 'agent_wallet_signature',
      status: 'active',
      created_at: 1,
      verified_at: 1,
      revoked_at: null,
    });
    const resolved = await resolveAgentAuthorAttribution(db, {
      provider: 'github',
      forgeAccountId: FORGE_A,
      sourceOwnerWalletId: 'wallet_A',
      candidates: [{ type: 'email', value: 'atlas@example.com' }],
    });
    expect(resolved).toBeNull();
  });

  // Cross-provider containment (the shared resolver serves github, gitlab AND
  // bitbucket): the same scope VALUE under a different provider never matches
  // — provider is part of both the doc-id digest and the field checks. This
  // stands in for per-provider suites on the healthy-idle gitlab/bitbucket
  // surfaces (no controls added there per the run constraints).
  it('does NOT cross-match the same forge id under a different provider', async () => {
    const { db } = makeFakeDb();
    await createVerifiedAuthorMapping(db, explicitParams({ forgeAccountId: 'proj_9' }));
    const resolved = await resolveAgentAuthorAttribution(db, {
      provider: 'gitlab',
      forgeAccountId: 'proj_9',
      sourceOwnerWalletId: 'wallet_A',
      candidates: [{ type: 'email', value: 'atlas@example.com' }],
    });
    expect(resolved).toBeNull();
  });

  it('skips revoked mappings', async () => {
    const { db } = makeFakeDb();
    const doc = await createVerifiedAuthorMapping(db, explicitParams());
    await revokeAuthorMapping(db, { mappingId: doc.mapping_id, callerWalletId: 'wallet_A' });
    const resolved = await resolveAgentAuthorAttribution(db, {
      provider: 'github',
      forgeAccountId: FORGE_A,
      sourceOwnerWalletId: 'wallet_A',
      candidates: [{ type: 'email', value: 'atlas@example.com' }],
    });
    expect(resolved).toBeNull();
  });
});

// =============================================================================
// revokeAuthorMapping — voucher-only authority (, extension removed)
// =============================================================================

describe('revokeAuthorMapping authority', () => {
  async function seedMappingVouchedByDeadWallet(db: any): Promise<AgentAuthorMappingDocument> {
    // wallet_dead vouched the mapping, then the install was re-pointed away.
    return createVerifiedAuthorMapping(db, explicitParams({ sourceOwnerWalletId: 'wallet_dead' }));
  }

  it('the original vouching wallet may revoke', async () => {
    const { db, store } = makeFakeDb();
    const doc = await seedMappingVouchedByDeadWallet(db);
    const ok = await revokeAuthorMapping(db, { mappingId: doc.mapping_id, callerWalletId: 'wallet_dead' });
    expect(ok).toBe(true);
    expect(store.get('agent_author_mappings')!.get(doc.mapping_id)!.status).toBe('revoked');
  });

  // THE 08-13 REPLAY : a re-install re-points install ownership
  // to wallet_B, which now holds an ACTIVE, STAMPED install on the mapping's
  // forge account — the strongest claim the removed extension honored. It must
  // be REFUSED: removal by a new install owner is orphaning by authority.
  it('the new owner of an active stamped install on the mapping\'s forge account may NOT revoke', async () => {
    const { db, store } = makeFakeDb();
    const doc = await seedMappingVouchedByDeadWallet(db);
    await createServiceInstall(db, { user_id: 'wallet_B', provider: 'github', installation_id: '777' });
    await stampServiceInstallForgeAccount(db, 'github', '777', { id: FORGE_A, login: 'octocat' });
    await expect(
      revokeAuthorMapping(db, { mappingId: doc.mapping_id, callerWalletId: 'wallet_B' }),
    ).rejects.toThrow('not_mapping_owner');
    expect(store.get('agent_author_mappings')!.get(doc.mapping_id)!.status).toBe('active');
  });

  it('the gitlab installation_id-scope claim is refused the same way', async () => {
    const { db } = makeFakeDb();
    const doc = await createVerifiedAuthorMapping(db, explicitParams({
      provider: 'gitlab', forgeAccountId: 'proj_9', sourceOwnerWalletId: 'wallet_dead',
    }));
    await createServiceInstall(db, { user_id: 'wallet_B', provider: 'gitlab', installation_id: 'proj_9' });
    await expect(
      revokeAuthorMapping(db, { mappingId: doc.mapping_id, callerWalletId: 'wallet_B' }),
    ).rejects.toThrow('not_mapping_owner');
  });

  it('an unrelated wallet may NOT revoke', async () => {
    const { db } = makeFakeDb();
    const doc = await seedMappingVouchedByDeadWallet(db);
    await expect(
      revokeAuthorMapping(db, { mappingId: doc.mapping_id, callerWalletId: 'wallet_stranger' }),
    ).rejects.toThrow('not_mapping_owner');
  });

  it('returns false for a missing mapping', async () => {
    const { db } = makeFakeDb();
    const ok = await revokeAuthorMapping(db, { mappingId: 'github_nope', callerWalletId: 'wallet_A' });
    expect(ok).toBe(false);
  });
});
