import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * git-identity — register an agent's git author identity → its wallet, so the
 * GitHub / GitLab / Bitbucket webhook witness credits the agent's commits on a
 * connected repository (Part 2; relay: routes/agent-attribution.ts).
 *
 * Two flows, one signature primitive:
 *
 * 1. SELF-REGISTRATION (`registerGitIdentity`). The agent, under its own API
 * credentials, asks the relay for a claims-bound challenge scoped to an
 * install it may register on — its OWN install, or (when it is the linked
 * agent of the install's human owner) that human's install — signs the
 * canonical message with its registered secp256k1 key, and posts the
 * mapping. One command, no human lever.
 *
 * 2. OWNER-ISSUED COMPLETION (`completeGitIdentityChallenge`). The repo OWNER
 * issued the challenge from the Provian app (naming this agent as the
 * target); the agent fetches it by id, signs it, and completes it under its
 * own auth. The signature travels through the relay — never pasted into
 * the owner's phone.
 *
 * The signed message is byte-identical to the relay's `canonicalPopMessage`
 * (core/agent-wallet/proof-of-possession.ts) with purpose
 * `agent_author_mapping` the same shape connect-pop.ts and parent-pop.ts
 * sign. THE SDK NEVER SIGNS A RELAY-SUPPLIED STRING BLINDLY: it rebuilds the
 * canonical message from claims it can verify (its own wallet id, the author
 * key it chose, the provider it asked for) and refuses when the relay's
 * `message` differs (`CHALLENGE_BINDING_MISMATCH`).
 *
 * EARNING BOUNDARY: registering is attribution, not activity. It mints nothing.
 * Once mapped, pushes to a connected repo become witnessed PEs on the agent
 * chain; every act of work mints PVT once at its best-supported value.
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { ProvianError } from './errors';
import { signMessage } from './wallet';
import type { GitIdentityProvider } from './git-identity-guidance';

export const AUTHOR_MAPPING_POP_PURPOSE = 'agent_author_mapping' as const;

export type AuthorKeyType = 'email' | 'username' | 'account_id' | 'signature_key';

export interface NormalizedAuthorKey {
  type: AuthorKeyType;
  value: string;
  hash: string;
}

/** The claims the relay binds an author-mapping challenge to (sorted at signing). */
export interface AuthorMappingClaims {
  provider: GitIdentityProvider;
  forge_account_id: string;
  source_owner_wallet_id: string;
  agent_wallet_id: string;
  author_key_type: AuthorKeyType;
  author_key_hash: string;
}

export interface GitIdentityMapping {
  mapping_id: string;
  provider: GitIdentityProvider;
  forge_account_id: string;
  forge_account_login: string | null;
  source_owner_wallet_id: string;
  agent_wallet_id: string;
  agent_id: string;
  author_key_type: AuthorKeyType;
  author_key_hash: string;
  verified_by: 'agent_wallet_signature' | 'repo_owner_capture';
  status: 'active' | 'revoked';
  created_at: number;
  verified_at: number;
  revoked_at: number | null;
}

export interface GitIdentityConfig {
  relayUrl: string;
  apiKey: string;
  apiSecret: string;
  /** This agent's wallet id (wallet_aw_…) — the identity being bound. */
  walletId: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export type GitIdentityErrorCode =
  | 'NO_GIT_AUTHOR_EMAIL'
  | 'INVALID_AUTHOR_KEY'
  | 'CHALLENGE_BINDING_MISMATCH'
  | 'AUTHOR_KEY_ALREADY_MAPPED'
  | 'NO_ACTIVE_INSTALL'
  | 'INSTALL_NOT_FOUND'
  | 'INSTALLATION_ID_REQUIRED'
  | 'INSTALL_FORGE_ACCOUNT_UNKNOWN'
  | 'CHALLENGE_NOT_FOUND'
  | 'AGENT_WALLET_NOT_ACTIVE'
  | 'AUTH_REJECTED'
  | 'RELAY_ERROR'
  | 'NETWORK_ERROR';

export class GitIdentityError extends ProvianError {
  public readonly status: number;
  constructor(message: string, code: GitIdentityErrorCode, status = 0) {
    super(message, code);
    this.name = 'GitIdentityError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Author-key normalization — MIRRORS the relay (author-mappings.ts
// normalizeAuthorKey). Must stay byte-identical: the hash is a signed claim.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeAuthorKey(candidate: { type: AuthorKeyType; value: string }): NormalizedAuthorKey | null {
  if (typeof candidate.value !== 'string') return null;
  let value = candidate.value.trim();
  if (!value) return null;
  if (candidate.type === 'email') {
    value = value.toLowerCase();
    if (!EMAIL_RE.test(value)) return null;
  } else if (candidate.type === 'username') {
    value = value.replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_.-]{1,200}$/.test(value)) return null;
  } else if (candidate.type === 'account_id') {
    value = value.toLowerCase();
    if (value.length > 240) return null;
  } else if (candidate.type === 'signature_key') {
    value = value.toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40,200}$/.test(value)) return null;
  } else {
    return null;
  }
  return {
    type: candidate.type,
    value,
    hash: createHash('sha256').update(`${candidate.type}:${value}`).digest('hex'),
  };
}

// ---------------------------------------------------------------------------
// PoP primitives — same shape as connect-pop.ts / parent-pop.ts
// ---------------------------------------------------------------------------

/**
 * Canonical author-mapping message — byte-identical to the relay's
 * `canonicalPopMessage`: `${purpose}\n${challenge}\n${k1=v1|k2=v2|...}` with
 * claim keys SORTED. MUST match the relay or the signature verifies against
 * the wrong bytes.
 */
export function canonicalAuthorMappingMessage(challenge: string, claims: AuthorMappingClaims): string {
  const sortedKeys = Object.keys(claims).sort() as Array<keyof AuthorMappingClaims>;
  const claimsBlob = sortedKeys.map((k) => `${k}=${claims[k]}`).join('|');
  return `${AUTHOR_MAPPING_POP_PURPOSE}\n${challenge}\n${claimsBlob}`;
}

/** Sign the author-mapping PoP. Returns the hex DER ECDSA-SHA256 signature the relay verifies. */
export function signAuthorMapping(privateKeyHex: string, challenge: string, claims: AuthorMappingClaims): string {
  return signMessage(privateKeyHex, canonicalAuthorMappingMessage(challenge, claims));
}

/** The relay's `POST /author-mappings/challenge` response. */
export interface AuthorMappingChallengeResponse {
  challenge_id: string;
  challenge: string;
  expires_at: number;
  purpose: string;
  source_owner_wallet_id: string;
  source_owner_type: 'human' | 'agent';
  forge_account_id: string;
  installation_id: string;
  agent_wallet_id: string;
  agent_id: string;
  author_key_type: AuthorKeyType;
  author_key_hash: string;
  message: string;
}

/**
 * Refuse to sign unless the relay's challenge binds EXACTLY the identity this
 * agent asked to register: this wallet, this author key, this provider — and
 * the relay's `message` is the canonical message over those claims. Returns
 * the verified claims (the only thing that gets signed).
 */
export function assertChallengeBindsToIdentity(
  response: AuthorMappingChallengeResponse,
  expected: { agentWalletId: string; provider: GitIdentityProvider; authorKey: NormalizedAuthorKey },
): AuthorMappingClaims {
  const claims: AuthorMappingClaims = {
    provider: expected.provider,
    forge_account_id: response.forge_account_id,
    source_owner_wallet_id: response.source_owner_wallet_id,
    agent_wallet_id: response.agent_wallet_id,
    author_key_type: response.author_key_type,
    author_key_hash: response.author_key_hash,
  };
  const bound = response.purpose === AUTHOR_MAPPING_POP_PURPOSE
    && response.agent_wallet_id === expected.agentWalletId
    && response.author_key_type === expected.authorKey.type
    && response.author_key_hash === expected.authorKey.hash
    && typeof response.forge_account_id === 'string' && response.forge_account_id.length > 0
    && typeof response.source_owner_wallet_id === 'string' && response.source_owner_wallet_id.length > 0
    && typeof response.challenge === 'string' && response.challenge.length > 0
    && canonicalAuthorMappingMessage(response.challenge, claims) === response.message;
  if (!bound) {
    throw new GitIdentityError(
      'The relay\'s challenge does not bind this agent, author key, and provider; refusing to sign.',
      'CHALLENGE_BINDING_MISMATCH',
    );
  }
  return claims;
}

/** The relay's `GET /author-mappings/challenge/:id` response (owner-issued handoff). */
export interface AuthorMappingChallengeReadResponse {
  challenge_id: string;
  challenge: string;
  purpose: string;
  claims: Record<string, string>;
  message: string;
}

function isProvider(value: unknown): value is GitIdentityProvider {
  return value === 'github' || value === 'gitlab' || value === 'bitbucket';
}

/**
 * Same refusal rule for an owner-issued challenge: the claims must name THIS
 * wallet and THIS author key, and the message must be canonical over them.
 */
export function assertOwnerChallengeBindsToIdentity(
  response: AuthorMappingChallengeReadResponse,
  expected: { agentWalletId: string; authorKey: NormalizedAuthorKey },
): AuthorMappingClaims {
  const c = response.claims ?? {};
  const provider = c.provider;
  if (!isProvider(provider)) {
    throw new GitIdentityError('The owner\'s challenge names no supported provider; refusing to sign.', 'CHALLENGE_BINDING_MISMATCH');
  }
  const claims: AuthorMappingClaims = {
    provider,
    forge_account_id: c.forge_account_id,
    source_owner_wallet_id: c.source_owner_wallet_id,
    agent_wallet_id: c.agent_wallet_id,
    author_key_type: c.author_key_type as AuthorKeyType,
    author_key_hash: c.author_key_hash,
  };
  const bound = response.purpose === AUTHOR_MAPPING_POP_PURPOSE
    && Object.keys(c).sort().join(',') === Object.keys(claims).sort().join(',')
    && claims.agent_wallet_id === expected.agentWalletId
    && claims.author_key_type === expected.authorKey.type
    && claims.author_key_hash === expected.authorKey.hash
    && typeof claims.forge_account_id === 'string' && claims.forge_account_id.length > 0
    && typeof claims.source_owner_wallet_id === 'string' && claims.source_owner_wallet_id.length > 0
    && typeof response.challenge === 'string' && response.challenge.length > 0
    && canonicalAuthorMappingMessage(response.challenge, claims) === response.message;
  if (!bound) {
    throw new GitIdentityError(
      'The owner\'s challenge does not bind this agent and author key; refusing to sign.',
      'CHALLENGE_BINDING_MISMATCH',
    );
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Relay client
// ---------------------------------------------------------------------------

async function relayJson(
  config: GitIdentityConfig,
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: Record<string, unknown> },
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> {
  const doFetch = guardedFetcher(config.fetchImpl);
  const url = `${config.relayUrl.replace(/\/+$/, '')}${path}`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        // Agent API-key auth — the relay's authenticateDeviceOwner routes the
        // pvn_live_ prefix to agent auth, which is what scopes the registration.
        Authorization: `Bearer ${config.apiKey}:${config.apiSecret}`,
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    throw new GitIdentityError(`Could not reach the relay: ${(err as Error).message}`, 'NETWORK_ERROR');
  }
  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { body = {}; }
  return { status: response.status, ok: response.ok, body };
}

function relayFailure(status: number, body: Record<string, unknown>, fallback: string): GitIdentityError {
  const error = typeof body.error === 'string' ? body.error : '';
  const detail = typeof body.detail === 'string' ? ` ${body.detail}` : '';
  if (status === 401 || status === 403) {
    return new GitIdentityError('The relay rejected this agent\'s credentials.', 'AUTH_REJECTED', status);
  }
  switch (error) {
    case 'no_active_install_for_provider':
      return new GitIdentityError('No connected repository for this provider is registrable by this agent.', 'NO_ACTIVE_INSTALL', status);
    case 'install_not_found':
      return new GitIdentityError('That installation is not connected, or this agent may not register on it.', 'INSTALL_NOT_FOUND', status);
    case 'installation_id_required':
      return new GitIdentityError(`More than one connected repository matches; name one with --installation.${detail}`, 'INSTALLATION_ID_REQUIRED', status);
    case 'install_forge_account_unknown':
      return new GitIdentityError(`The connected repository has not delivered a push yet.${detail}`, 'INSTALL_FORGE_ACCOUNT_UNKNOWN', status);
    case 'author_key_already_mapped':
      return new GitIdentityError('That git identity is already registered to a different wallet on this repository.', 'AUTHOR_KEY_ALREADY_MAPPED', status);
    case 'challenge_not_found':
      return new GitIdentityError('That challenge does not exist, has expired, or was issued for another agent.', 'CHALLENGE_NOT_FOUND', status);
    case 'author_key_mismatch':
      return new GitIdentityError('The author key does not match the one the owner registered for this challenge.', 'CHALLENGE_BINDING_MISMATCH', status);
    default:
      if (error === 'active agent_wallet_id with public_key is required') {
        return new GitIdentityError('This agent wallet is not active on the relay.', 'AGENT_WALLET_NOT_ACTIVE', status);
      }
      return new GitIdentityError(`${fallback} (${error || `HTTP ${status}`})${detail}`, 'RELAY_ERROR', status);
  }
}

/** Every mapping this agent vouched or is named in (the relay's union view). */
export async function listGitIdentities(config: GitIdentityConfig): Promise<GitIdentityMapping[]> {
  const res = await relayJson(config, '/v1/agent-attribution/author-mappings', { method: 'GET' });
  if (!res.ok) throw relayFailure(res.status, res.body, 'Listing git identities failed');
  const mappings = res.body.mappings;
  return Array.isArray(mappings) ? (mappings as GitIdentityMapping[]) : [];
}

/** Revoke a mapping this agent vouched or is named in. Idempotent on an already-revoked row. */
export async function revokeGitIdentity(config: GitIdentityConfig, mappingId: string): Promise<{ revoked: true; mappingId: string }> {
  const res = await relayJson(config, `/v1/agent-attribution/author-mappings/${encodeURIComponent(mappingId)}`, { method: 'DELETE' });
  if (!res.ok) {
    if (res.status === 404) throw new GitIdentityError('No such mapping.', 'CHALLENGE_NOT_FOUND', 404);
    if (res.status === 403) throw new GitIdentityError('Only the wallet that vouched a mapping, or the agent it names, may revoke it.', 'AUTH_REJECTED', 403);
    throw relayFailure(res.status, res.body, 'Revoking the git identity failed');
  }
  return { revoked: true, mappingId };
}

export interface RegisterGitIdentityParams {
  provider: GitIdentityProvider;
  authorKeyType: AuthorKeyType;
  authorKey: string;
  /** Name an install explicitly when the owner has several for the provider. */
  installationId?: string;
  /** Hex secp256k1 private key of THIS agent's registered wallet key. Only read to sign. */
  privateKeyHex: string;
}

export interface RegisterGitIdentityResult {
  status: 'registered' | 'already_registered';
  mapping: GitIdentityMapping;
  installationId?: string;
  forgeAccountId: string;
  sourceOwnerWalletId: string;
}

function findActiveMatch(
  mappings: GitIdentityMapping[],
  match: { provider: GitIdentityProvider; forgeAccountId: string; authorKeyHash: string; agentWalletId: string },
): GitIdentityMapping | undefined {
  return mappings.find((m) =>
    m.status === 'active'
    && m.provider === match.provider
    && m.forge_account_id === match.forgeAccountId
    && m.author_key_hash === match.authorKeyHash
    && m.agent_wallet_id === match.agentWalletId);
}

/**
 * Self-registration: challenge → verify binding → sign with the agent's key →
 * post. IDEMPOTENT: an existing ACTIVE mapping for the same provider + forge
 * account + author key + this agent returns `already_registered` without a
 * second signature (the unused challenge simply expires).
 */
export async function registerGitIdentity(
  config: GitIdentityConfig,
  params: RegisterGitIdentityParams,
): Promise<RegisterGitIdentityResult> {
  const authorKey = normalizeAuthorKey({ type: params.authorKeyType, value: params.authorKey });
  if (!authorKey) {
    throw new GitIdentityError(`"${params.authorKey}" is not a valid ${params.authorKeyType}.`, 'INVALID_AUTHOR_KEY');
  }

  const body: Record<string, unknown> = {
    provider: params.provider,
    agent_wallet_id: config.walletId,
    author_key_type: authorKey.type,
    author_key: authorKey.value,
  };
  if (params.installationId) body.installation_id = params.installationId;

  const challenge = await relayJson(config, '/v1/agent-attribution/author-mappings/challenge', { method: 'POST', body });
  if (!challenge.ok) throw relayFailure(challenge.status, challenge.body, 'Requesting the registration challenge failed');
  const response = challenge.body as unknown as AuthorMappingChallengeResponse;
  const claims = assertChallengeBindsToIdentity(response, {
    agentWalletId: config.walletId, provider: params.provider, authorKey,
  });

  // Idempotency: the challenge resolved the forge account, so the match is exact.
  const existing = findActiveMatch(await listGitIdentities(config), {
    provider: params.provider, forgeAccountId: claims.forge_account_id,
    authorKeyHash: authorKey.hash, agentWalletId: config.walletId,
  });
  if (existing) {
    return {
      status: 'already_registered',
      mapping: existing,
      installationId: response.installation_id,
      forgeAccountId: claims.forge_account_id,
      sourceOwnerWalletId: claims.source_owner_wallet_id,
    };
  }

  const signature = signAuthorMapping(params.privateKeyHex, response.challenge, claims);
  const created = await relayJson(config, '/v1/agent-attribution/author-mappings', {
    method: 'POST',
    body: { ...body, challenge_id: response.challenge_id, signature },
  });
  if (!created.ok) throw relayFailure(created.status, created.body, 'Registering the git identity failed');
  return {
    status: 'registered',
    mapping: created.body.mapping as unknown as GitIdentityMapping,
    installationId: response.installation_id,
    forgeAccountId: claims.forge_account_id,
    sourceOwnerWalletId: claims.source_owner_wallet_id,
  };
}

export interface CompleteGitIdentityParams {
  /** The challenge id the owner's app displayed. */
  challengeId: string;
  authorKeyType: AuthorKeyType;
  authorKey: string;
  privateKeyHex: string;
}

/**
 * Owner-issued handoff: read the challenge by id (the relay returns it only to
 * the agent it names), verify it binds THIS wallet + THIS author key, sign,
 * and complete under this agent's own auth.
 */
export async function completeGitIdentityChallenge(
  config: GitIdentityConfig,
  params: CompleteGitIdentityParams,
): Promise<RegisterGitIdentityResult> {
  const authorKey = normalizeAuthorKey({ type: params.authorKeyType, value: params.authorKey });
  if (!authorKey) {
    throw new GitIdentityError(`"${params.authorKey}" is not a valid ${params.authorKeyType}.`, 'INVALID_AUTHOR_KEY');
  }
  const read = await relayJson(
    config,
    `/v1/agent-attribution/author-mappings/challenge/${encodeURIComponent(params.challengeId)}`,
    { method: 'GET' },
  );
  if (!read.ok) throw relayFailure(read.status, read.body, 'Reading the owner\'s challenge failed');
  const response = read.body as unknown as AuthorMappingChallengeReadResponse;
  const claims = assertOwnerChallengeBindsToIdentity(response, { agentWalletId: config.walletId, authorKey });

  const signature = signAuthorMapping(params.privateKeyHex, response.challenge, claims);
  const done = await relayJson(config, '/v1/agent-attribution/author-mappings/complete', {
    method: 'POST',
    body: {
      challenge_id: params.challengeId,
      signature,
      author_key_type: authorKey.type,
      author_key: authorKey.value,
    },
  });
  if (!done.ok) throw relayFailure(done.status, done.body, 'Completing the owner\'s challenge failed');
  return {
    status: 'registered',
    mapping: done.body.mapping as unknown as GitIdentityMapping,
    forgeAccountId: claims.forge_account_id,
    sourceOwnerWalletId: claims.source_owner_wallet_id,
  };
}

// ---------------------------------------------------------------------------
// Local git identity
// ---------------------------------------------------------------------------

export type ExecFileSyncLike = (file: string, args: string[], options: { cwd?: string; encoding: 'utf-8'; timeout: number; stdio: 'pipe' }) => string;

/**
 * The git author email configured on this machine (`git config user.email`),
 * or null when git is absent / nothing is configured. Never throws.
 */
export function readGitAuthorEmail(options: { cwd?: string; execImpl?: ExecFileSyncLike } = {}): string | null {
  const run: ExecFileSyncLike = options.execImpl
    ?? ((file, args, opts) => execFileSync(file, args, opts) as unknown as string);
  try {
    const out = run('git', ['config', 'user.email'], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
    }).trim();
    return normalizeAuthorKey({ type: 'email', value: out })?.value ?? null;
  } catch {
    return null;
  }
}

/** Prove GitHub account control independently of Git Witness installations. Tokens never reach the agent. */
export async function githubIdentityLink(config: GitIdentityConfig, state?: string): Promise<Record<string, unknown>> {
  const result = await relayJson(config, `/v1/github-identity/${state ? 'poll' : 'start'}`, { method: 'POST', body: state ? { state } : {} });
  if (!result.ok) throw relayFailure(result.status, result.body, 'GitHub identity link failed');
  return result.body;
}
