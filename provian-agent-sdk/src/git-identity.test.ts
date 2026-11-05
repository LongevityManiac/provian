/**
 * git-identity tests — the PoP primitives verify under the RELAY's algorithm,
 * the author-key normalization matches the relay's byte-for-byte, and the
 * client refuses to sign anything the relay did not bind to this identity.
 *
 * Fake relay: the challenge `message` is built here from an INDEPENDENT
 * template of the relay's format (keys spelled out in sorted order by hand),
 * not by calling the SDK's own canonical function — so the SDK's function is
 * checked against a second statement of the contract, never against itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { createVerify, generateKeyPairSync } from 'crypto';
import {
  AUTHOR_MAPPING_POP_PURPOSE,
  GitIdentityError,
  assertChallengeBindsToIdentity,
  assertOwnerChallengeBindsToIdentity,
  canonicalAuthorMappingMessage,
  completeGitIdentityChallenge,
  listGitIdentities,
  normalizeAuthorKey,
  readGitAuthorEmail,
  registerGitIdentity,
  revokeGitIdentity,
  signAuthorMapping,
  type AuthorMappingClaims,
  type GitIdentityConfig,
  type GitIdentityMapping,
} from './git-identity';
import { gitIdentityGuidanceLines, registerGitIdentityCommand, unmappedAuthorHint } from './git-identity-guidance';

// A real secp256k1 keypair; the relay verifies with createVerify('SHA256')
// against an SPKI built from the 64-byte uncompressed public key.
const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
const PRIV_HEX = (PRIV.export({ type: 'sec1', format: 'der' }) as Buffer).subarray(7, 39).toString('hex');
const SPKI_PEM = PUB.export({ type: 'spki', format: 'pem' }) as string;

function relayVerify(message: string, signatureHex: string): boolean {
  return createVerify('SHA256').update(message).verify(SPKI_PEM, Buffer.from(signatureHex, 'hex'));
}

// Pinned from the RELAY's normalizeAuthorKey (provian-backend
// core/agent-attribution/author-mappings.ts) for `'  Atlas@Example.COM '`.
const RELAY_HASH_ATLAS = '13a8cbed127777304477164739c20c9b6a470fe76779042f7db99f1245612b47';

const WALLET = 'wallet_aw_atlas';
const CLAIMS: AuthorMappingClaims = {
  provider: 'github',
  forge_account_id: '21031067',
  source_owner_wallet_id: 'wallet_frank',
  agent_wallet_id: WALLET,
  author_key_type: 'email',
  author_key_hash: RELAY_HASH_ATLAS,
};

/** Independent statement of the relay's canonical format (sorted keys, by hand). */
function relayMessage(challenge: string, c: AuthorMappingClaims): string {
  return `agent_author_mapping\n${challenge}\n`
    + `agent_wallet_id=${c.agent_wallet_id}|author_key_hash=${c.author_key_hash}|author_key_type=${c.author_key_type}`
    + `|forge_account_id=${c.forge_account_id}|provider=${c.provider}|source_owner_wallet_id=${c.source_owner_wallet_id}`;
}

describe('author-key normalization parity with the relay', () => {
  it('normalizes an email exactly as the relay does (trim, lowercase, sha256 over type:value)', () => {
    const k = normalizeAuthorKey({ type: 'email', value: '  Atlas@Example.COM ' });
    expect(k).toEqual({ type: 'email', value: 'atlas@example.com', hash: RELAY_HASH_ATLAS });
  });
  it('RED: an invalid email is refused, never hashed', () => {
    expect(normalizeAuthorKey({ type: 'email', value: 'not-an-email' })).toBeNull();
    expect(normalizeAuthorKey({ type: 'username', value: 'has space' })).toBeNull();
  });
  it('strips a leading @ from usernames like the relay', () => {
    expect(normalizeAuthorKey({ type: 'username', value: '@Octocat' })?.value).toBe('octocat');
  });
});

describe('PoP primitives verify under the relay algorithm', () => {
  it('canonical message equals the independently spelled relay format', () => {
    expect(canonicalAuthorMappingMessage('abc', CLAIMS)).toBe(relayMessage('abc', CLAIMS));
    expect(AUTHOR_MAPPING_POP_PURPOSE).toBe('agent_author_mapping');
  });
  it('a signature over the canonical message verifies with createVerify(SHA256) + SPKI', () => {
    const sig = signAuthorMapping(PRIV_HEX, 'deadbeef', CLAIMS);
    expect(relayVerify(relayMessage('deadbeef', CLAIMS), sig)).toBe(true);
  });
  it('RED: the same signature does NOT verify over a message with a different forge account', () => {
    const sig = signAuthorMapping(PRIV_HEX, 'deadbeef', CLAIMS);
    expect(relayVerify(relayMessage('deadbeef', { ...CLAIMS, forge_account_id: '999999' }), sig)).toBe(false);
  });
});

function challengeResponse(over: Partial<Record<string, unknown>> = {}) {
  const base = {
    challenge_id: 'ch_1', challenge: 'c0ffee', expires_at: Date.now() + 300_000,
    purpose: 'agent_author_mapping', source_owner_wallet_id: 'wallet_frank', source_owner_type: 'human',
    forge_account_id: '21031067', installation_id: '777', agent_wallet_id: WALLET, agent_id: 'atlas',
    author_key_type: 'email', author_key_hash: RELAY_HASH_ATLAS,
  };
  const merged = { ...base, ...over };
  return { ...merged, message: over.message ?? relayMessage(String(merged.challenge), {
    provider: 'github', forge_account_id: String(merged.forge_account_id), source_owner_wallet_id: String(merged.source_owner_wallet_id),
    agent_wallet_id: String(merged.agent_wallet_id), author_key_type: 'email', author_key_hash: String(merged.author_key_hash),
  }) };
}

const ATLAS_KEY = normalizeAuthorKey({ type: 'email', value: 'atlas@example.com' })!;

describe('assertChallengeBindsToIdentity — never sign a relay string blindly', () => {
  it('accepts a challenge that binds this wallet, key, and provider', () => {
    const claims = assertChallengeBindsToIdentity(challengeResponse() as never, { agentWalletId: WALLET, provider: 'github', authorKey: ATLAS_KEY });
    expect(claims).toEqual(CLAIMS);
  });
  it('RED: refuses when the relay names a different agent wallet', () => {
    expect(() => assertChallengeBindsToIdentity(challengeResponse({ agent_wallet_id: 'wallet_aw_other' }) as never,
      { agentWalletId: WALLET, provider: 'github', authorKey: ATLAS_KEY })).toThrow(GitIdentityError);
  });
  it('RED: refuses when the relay\'s message carries claims the client cannot reconstruct', () => {
    const tampered = challengeResponse({ message: relayMessage('c0ffee', CLAIMS) + '|extra=1' });
    expect(() => assertChallengeBindsToIdentity(tampered as never, { agentWalletId: WALLET, provider: 'github', authorKey: ATLAS_KEY }))
      .toThrow(/refusing to sign/);
  });
  it('RED: refuses a different author-key hash and a different purpose', () => {
    expect(() => assertChallengeBindsToIdentity(challengeResponse({ author_key_hash: 'ff'.repeat(32) }) as never,
      { agentWalletId: WALLET, provider: 'github', authorKey: ATLAS_KEY })).toThrow(GitIdentityError);
    expect(() => assertChallengeBindsToIdentity(challengeResponse({ purpose: 'agent_connect' }) as never,
      { agentWalletId: WALLET, provider: 'github', authorKey: ATLAS_KEY })).toThrow(GitIdentityError);
  });
  it('RED (owner handoff): refuses a challenge whose claims name another agent', () => {
    const read = { challenge_id: 'ch', challenge: 'c0ffee', purpose: 'agent_author_mapping',
      claims: { ...CLAIMS, agent_wallet_id: 'wallet_aw_other' }, message: relayMessage('c0ffee', { ...CLAIMS, agent_wallet_id: 'wallet_aw_other' }) };
    expect(() => assertOwnerChallengeBindsToIdentity(read as never, { agentWalletId: WALLET, authorKey: ATLAS_KEY })).toThrow(GitIdentityError);
  });
});

// ---------------------------------------------------------------------------
// Fake relay
// ---------------------------------------------------------------------------

interface FakeRelayState {
  mappings: GitIdentityMapping[];
  challenges: Map<string, { challenge: string; claims: AuthorMappingClaims; message: string }>;
  calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
  createStatus?: number;
}

function mappingFor(claims: AuthorMappingClaims): GitIdentityMapping {
  return {
    mapping_id: `github_${claims.author_key_hash.slice(0, 8)}`, provider: claims.provider,
    forge_account_id: claims.forge_account_id, forge_account_login: 'frank',
    source_owner_wallet_id: claims.source_owner_wallet_id, agent_wallet_id: claims.agent_wallet_id, agent_id: 'atlas',
    author_key_type: claims.author_key_type, author_key_hash: claims.author_key_hash,
    verified_by: 'agent_wallet_signature', status: 'active', created_at: 1, verified_at: 1, revoked_at: null,
  };
}

function fakeRelay(state: FakeRelayState): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace('https://relay.test', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    state.calls.push({ method, path, body });
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth !== 'Bearer pvn_live_k:pvns_s') return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 });

    if (method === 'POST' && path === '/v1/agent-attribution/author-mappings/challenge') {
      const claims: AuthorMappingClaims = {
        provider: body!.provider as AuthorMappingClaims['provider'], forge_account_id: '21031067', source_owner_wallet_id: 'wallet_frank',
        agent_wallet_id: String(body!.agent_wallet_id), author_key_type: 'email', author_key_hash: RELAY_HASH_ATLAS,
      };
      const challenge = 'c0ffee'; const message = relayMessage(challenge, claims);
      state.challenges.set('ch_1', { challenge, claims, message });
      return new Response(JSON.stringify({ ...challengeResponse({ agent_wallet_id: claims.agent_wallet_id }), message }), { status: 200 });
    }
    if (method === 'GET' && path === '/v1/agent-attribution/author-mappings') {
      return new Response(JSON.stringify({ mappings: state.mappings, count: state.mappings.length }), { status: 200 });
    }
    if (method === 'POST' && path === '/v1/agent-attribution/author-mappings') {
      const ch = state.challenges.get(String(body!.challenge_id));
      if (!ch) return new Response(JSON.stringify({ error: 'Agent key proof failed', reason: 'challenge_not_found' }), { status: 400 });
      if (!relayVerify(ch.message, String(body!.signature))) return new Response(JSON.stringify({ error: 'Agent key proof failed', reason: 'signature_invalid' }), { status: 400 });
      if (state.createStatus === 409) return new Response(JSON.stringify({ error: 'author_key_already_mapped' }), { status: 409 });
      const mapping = mappingFor(ch.claims); state.mappings.push(mapping);
      return new Response(JSON.stringify({ ok: true, mapping }), { status: 201 });
    }
    if (method === 'GET' && path.startsWith('/v1/agent-attribution/author-mappings/challenge/')) {
      const ch = state.challenges.get(path.split('/').pop()!);
      if (!ch || ch.claims.agent_wallet_id !== WALLET) return new Response(JSON.stringify({ error: 'challenge_not_found' }), { status: 404 });
      return new Response(JSON.stringify({ challenge_id: 'ch_1', challenge: ch.challenge, purpose: 'agent_author_mapping', claims: ch.claims, message: ch.message }), { status: 200 });
    }
    if (method === 'POST' && path === '/v1/agent-attribution/author-mappings/complete') {
      const ch = state.challenges.get(String(body!.challenge_id));
      if (!ch) return new Response(JSON.stringify({ error: 'challenge_not_found' }), { status: 404 });
      if (!relayVerify(ch.message, String(body!.signature))) return new Response(JSON.stringify({ error: 'Agent key proof failed' }), { status: 400 });
      const mapping = mappingFor(ch.claims); state.mappings.push(mapping);
      return new Response(JSON.stringify({ ok: true, mapping }), { status: 201 });
    }
    if (method === 'DELETE' && path.startsWith('/v1/agent-attribution/author-mappings/')) {
      const id = path.split('/').pop();
      const m = state.mappings.find((x) => x.mapping_id === id);
      if (!m) return new Response(JSON.stringify({ error: 'mapping_not_found' }), { status: 404 });
      m.status = 'revoked';
      return new Response(JSON.stringify({ revoked: true, mapping_id: id }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
  }) as unknown as typeof fetch;
}

function configWith(state: FakeRelayState, walletId = WALLET): GitIdentityConfig {
  return { relayUrl: 'https://relay.test/', apiKey: 'pvn_live_k', apiSecret: 'pvns_s', walletId, fetchImpl: fakeRelay(state) };
}

function freshState(): FakeRelayState {
  return { mappings: [], challenges: new Map(), calls: [] };
}

describe('registerGitIdentity (self-registration)', () => {
  it('challenge → verify binding → sign → post, and the relay verifies the real signature', async () => {
    const state = freshState();
    const result = await registerGitIdentity(configWith(state), {
      provider: 'github', authorKeyType: 'email', authorKey: '  Atlas@Example.COM ', privateKeyHex: PRIV_HEX,
    });
    expect(result.status).toBe('registered');
    expect(result.forgeAccountId).toBe('21031067');
    expect(result.sourceOwnerWalletId).toBe('wallet_frank');
    expect(result.installationId).toBe('777');
    expect(result.mapping.agent_wallet_id).toBe(WALLET);
    expect(state.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/agent-attribution/author-mappings/challenge',
      'GET /v1/agent-attribution/author-mappings',
      'POST /v1/agent-attribution/author-mappings',
    ]);
    // The normalized key value went over the wire, never the raw input.
    expect(state.calls[0].body?.author_key).toBe('atlas@example.com');
  });

  it('is idempotent: an existing active mapping returns already_registered with NO signature post', async () => {
    const state = freshState();
    state.mappings.push(mappingFor(CLAIMS));
    const result = await registerGitIdentity(configWith(state), {
      provider: 'github', authorKeyType: 'email', authorKey: 'atlas@example.com', privateKeyHex: PRIV_HEX,
    });
    expect(result.status).toBe('already_registered');
    expect(state.calls.some((c) => c.method === 'POST' && c.path === '/v1/agent-attribution/author-mappings')).toBe(false);
  });

  it('RED: a REVOKED prior mapping is not "already registered" — it re-registers', async () => {
    const state = freshState();
    state.mappings.push({ ...mappingFor(CLAIMS), status: 'revoked', revoked_at: 5 });
    const result = await registerGitIdentity(configWith(state), {
      provider: 'github', authorKeyType: 'email', authorKey: 'atlas@example.com', privateKeyHex: PRIV_HEX,
    });
    expect(result.status).toBe('registered');
  });

  it('RED: a relay challenge naming another wallet is refused before any signature is made', async () => {
    const state = freshState();
    // Ask as wallet_aw_atlas, but the fake relay echoes what the CLIENT sends —
    // so send as a different wallet id to make the relay bind the other wallet.
    const config = configWith(state);
    const badFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const r = await (config.fetchImpl as typeof fetch)(input, init);
      if (String(input).endsWith('/challenge')) {
        const j = await r.json() as Record<string, unknown>;
        return new Response(JSON.stringify({ ...j, agent_wallet_id: 'wallet_aw_other' }), { status: 200 });
      }
      return r;
    }) as unknown as typeof fetch;
    await expect(registerGitIdentity({ ...config, fetchImpl: badFetch }, {
      provider: 'github', authorKeyType: 'email', authorKey: 'atlas@example.com', privateKeyHex: PRIV_HEX,
    })).rejects.toMatchObject({ code: 'CHALLENGE_BINDING_MISMATCH' });
    expect(state.calls.some((c) => c.method === 'POST' && c.path === '/v1/agent-attribution/author-mappings')).toBe(false);
  });

  it('maps a relay 409 to AUTHOR_KEY_ALREADY_MAPPED', async () => {
    const state = { ...freshState(), createStatus: 409 };
    await expect(registerGitIdentity(configWith(state), {
      provider: 'github', authorKeyType: 'email', authorKey: 'atlas@example.com', privateKeyHex: PRIV_HEX,
    })).rejects.toMatchObject({ code: 'AUTHOR_KEY_ALREADY_MAPPED', status: 409 });
  });

  it('maps relay refusals to typed codes and rejects invalid keys locally', async () => {
    const state = freshState();
    await expect(registerGitIdentity(configWith(state), {
      provider: 'github', authorKeyType: 'email', authorKey: 'nope', privateKeyHex: PRIV_HEX,
    })).rejects.toMatchObject({ code: 'INVALID_AUTHOR_KEY' });
    expect(state.calls).toHaveLength(0);

    const refusing = vi.fn(async () => new Response(JSON.stringify({ error: 'no_active_install_for_provider' }), { status: 404 })) as unknown as typeof fetch;
    await expect(registerGitIdentity({ ...configWith(state), fetchImpl: refusing }, {
      provider: 'gitlab', authorKeyType: 'email', authorKey: 'atlas@example.com', privateKeyHex: PRIV_HEX,
    })).rejects.toMatchObject({ code: 'NO_ACTIVE_INSTALL', status: 404 });

    const rejecting = vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 })) as unknown as typeof fetch;
    await expect(listGitIdentities({ ...configWith(state), fetchImpl: rejecting })).rejects.toMatchObject({ code: 'AUTH_REJECTED' });
  });
});

describe('completeGitIdentityChallenge (owner-issued handoff)', () => {
  it('reads the owner\'s challenge, verifies binding, signs, and completes under agent auth', async () => {
    const state = freshState();
    state.challenges.set('ch_1', { challenge: 'c0ffee', claims: CLAIMS, message: relayMessage('c0ffee', CLAIMS) });
    const result = await completeGitIdentityChallenge(configWith(state), {
      challengeId: 'ch_1', authorKeyType: 'email', authorKey: 'Atlas@example.com', privateKeyHex: PRIV_HEX,
    });
    expect(result.status).toBe('registered');
    expect(result.sourceOwnerWalletId).toBe('wallet_frank');
    const complete = state.calls.find((c) => c.path.endsWith('/complete'));
    expect(complete?.body).toMatchObject({ challenge_id: 'ch_1', author_key_type: 'email', author_key: 'atlas@example.com' });
  });

  it('RED: a challenge issued for another agent → CHALLENGE_NOT_FOUND, no completion attempted', async () => {
    const state = freshState();
    state.challenges.set('ch_1', { challenge: 'c0ffee', claims: { ...CLAIMS, agent_wallet_id: 'wallet_aw_other' }, message: 'x' });
    await expect(completeGitIdentityChallenge(configWith(state), {
      challengeId: 'ch_1', authorKeyType: 'email', authorKey: 'atlas@example.com', privateKeyHex: PRIV_HEX,
    })).rejects.toMatchObject({ code: 'CHALLENGE_NOT_FOUND' });
    expect(state.calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
  });

  it('RED: the local author key must match the owner\'s commitment (no signing a mismatched key)', async () => {
    const state = freshState();
    state.challenges.set('ch_1', { challenge: 'c0ffee', claims: CLAIMS, message: relayMessage('c0ffee', CLAIMS) });
    await expect(completeGitIdentityChallenge(configWith(state), {
      challengeId: 'ch_1', authorKeyType: 'email', authorKey: 'someone-else@example.com', privateKeyHex: PRIV_HEX,
    })).rejects.toMatchObject({ code: 'CHALLENGE_BINDING_MISMATCH' });
    expect(state.calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
  });
});

describe('list / revoke', () => {
  it('lists and revokes through the relay', async () => {
    const state = freshState();
    state.mappings.push(mappingFor(CLAIMS));
    const list = await listGitIdentities(configWith(state));
    expect(list).toHaveLength(1);
    const revoked = await revokeGitIdentity(configWith(state), list[0].mapping_id);
    expect(revoked.revoked).toBe(true);
    expect(state.mappings[0].status).toBe('revoked');
    await expect(revokeGitIdentity(configWith(state), 'nope')).rejects.toMatchObject({ code: 'CHALLENGE_NOT_FOUND' });
  });
});

describe('readGitAuthorEmail', () => {
  it('reads and normalizes git config user.email', () => {
    const exec = vi.fn(() => '  Atlas@Example.COM\n');
    expect(readGitAuthorEmail({ execImpl: exec })).toBe('atlas@example.com');
    expect(exec).toHaveBeenCalledWith('git', ['config', 'user.email'], expect.objectContaining({ encoding: 'utf-8' }));
  });
  it('RED: returns null (never throws) when git is missing or the value is not an email', () => {
    expect(readGitAuthorEmail({ execImpl: () => { throw new Error('ENOENT'); } })).toBeNull();
    expect(readGitAuthorEmail({ execImpl: () => 'not an email' })).toBeNull();
    expect(readGitAuthorEmail({ execImpl: () => '' })).toBeNull();
  });
});

describe('guidance (single copy source)', () => {
  it('pins the exact command shape the docs and screens hand out', () => {
    expect(registerGitIdentityCommand({ authorEmail: 'atlas@example.com' }))
      .toBe('npx @provian/agent-sdk register-git-identity --email atlas@example.com');
    expect(registerGitIdentityCommand({ authorEmail: 'a@b.co', provider: 'gitlab', installationId: '42' }))
      .toBe('npx @provian/agent-sdk register-git-identity --email a@b.co --provider gitlab --installation 42');
  });
  it('states eligibility, never "every commit earns"', () => {
    for (const has of [true, false, null]) {
      const text = gitIdentityGuidanceLines({ authorEmail: 'a@b.co' }, has).join('\n');
      expect(text).toContain('register-git-identity --email a@b.co');
      expect(text).not.toMatch(/every (commit|push|action) (earns|mints)/i);
    }
    expect(unmappedAuthorHint('a@b.co')).toContain('register-git-identity --email a@b.co');
  });
});
