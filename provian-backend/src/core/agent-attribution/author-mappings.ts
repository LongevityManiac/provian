import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { type ServiceInstallProvider } from '../witnesses/service-installs';

export type AuthorKeyType = 'email' | 'username' | 'account_id' | 'signature_key';
export type AuthorMappingStatus = 'active' | 'revoked';
// `agent_wallet_signature` — the contributor's agent proved consent by signing a
//   PoP challenge (routes/agent-attribution.ts). Used for anyone crediting an
//   identity to an AGENT wallet.
// `repo_owner_capture` — the repo OWNER's own identity, auto-bound from a signed
//   webhook payload with no PoP signature. The proof is external: the
//   wallet-authenticated connect bound the installation to the owner's wallet, and
//   the HMAC-signed install payload asserts the owner's GitHub account. This exists
//   only so the owner's OWN commits stay attributable after the install-owner
//   fallback was removed (the owner never signs a challenge for their own identity).
export type AuthorMappingVerifiedBy = 'agent_wallet_signature' | 'repo_owner_capture';

export interface AuthorKeyCandidate {
  type: AuthorKeyType;
  value: string;
}

export interface NormalizedAuthorKey {
  type: AuthorKeyType;
  value: string;
  hash: string;
}

export interface AgentAuthorMappingDocument {
  mapping_id: string;
  provider: ServiceInstallProvider;
  /**
   * 2026-08-16 re-key: the STABLE scope of the mapping — the forge account
   * (GitHub account databaseId / GitLab project id / Bitbucket repo uuid) the
   * identity is registered under. The mapping doc id digests THIS, never a
   * wallet id, so a GitHub-side reinstall (new installation_id) or a wallet
   * re-point can never orphan a mapping (the 08-13 production orphan
   * mechanism). `source_owner_wallet_id` remains as vouching PROVENANCE only
   * — who authorized the registration — and no resolution path conditions
   * on it.
   */
  forge_account_id: string;
  /** Display-only login for the forge account; null when unknown. */
  forge_account_login: string | null;
  source_owner_wallet_id: string;
  agent_wallet_id: string;
  agent_id: string;
  agent_address: string;
  author_key_type: AuthorKeyType;
  author_key: string;
  author_key_hash: string;
  key_fingerprint: string | null;
  verified_by: AuthorMappingVerifiedBy;
  status: AuthorMappingStatus;
  created_at: number;
  verified_at: number;
  revoked_at: number | null;
}

export interface ResolvedAuthorAttribution {
  mode: 'verified_author_mapping';
  mappingId: string;
  provider: ServiceInstallProvider;
  /** The stable forge-account scope the match was found under. */
  forgeAccountId: string;
  /** Pass-through of the CURRENT install owner (metadata provenance only). */
  sourceOwnerWalletId: string;
  agentWalletId: string;
  agentId: string;
  agentAddress: string;
  authorKeyType: AuthorKeyType;
  authorKeyHash: string;
  verifiedBy: AuthorMappingVerifiedBy;
}

export interface AttributionMetadata {
  mode: 'installation_owner' | 'verified_author_mapping';
  provider: ServiceInstallProvider;
  source_owner_wallet_id: string;
  forge_account_id?: string;
  agent_wallet_id?: string;
  agent_id?: string;
  mapping_id?: string;
  author_key_type?: AuthorKeyType;
  author_key_hash?: string;
  verified_by?: AuthorMappingVerifiedBy;
}

const COLLECTION = 'agent_author_mappings';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SUPPORTED_PROVIDERS: ServiceInstallProvider[] = ['github', 'gitlab', 'bitbucket'];
const SUPPORTED_KEY_TYPES: AuthorKeyType[] = ['email', 'username', 'account_id', 'signature_key'];

export function isServiceInstallProvider(value: unknown): value is ServiceInstallProvider {
  return typeof value === 'string' && SUPPORTED_PROVIDERS.includes(value as ServiceInstallProvider);
}

export function isAuthorKeyType(value: unknown): value is AuthorKeyType {
  return typeof value === 'string' && SUPPORTED_KEY_TYPES.includes(value as AuthorKeyType);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function extractEmail(value: string): string | null {
  const direct = normalizeAuthorKey({ type: 'email', value });
  if (direct) return direct.value;

  const match = value.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/);
  if (!match) return null;
  return normalizeAuthorKey({ type: 'email', value: match[1] })?.value ?? null;
}

function pushCandidate(candidates: AuthorKeyCandidate[], type: AuthorKeyType, value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    candidates.push({ type, value: String(value) });
    return;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return;
  candidates.push({ type, value });
}

function dedupeCandidates(candidates: AuthorKeyCandidate[]): AuthorKeyCandidate[] {
  const seen = new Set<string>();
  const result: AuthorKeyCandidate[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeAuthorKey(candidate);
    if (!normalized) continue;
    const key = `${normalized.type}:${normalized.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ type: normalized.type, value: normalized.value });
  }
  return result;
}

export function normalizeAuthorKey(candidate: AuthorKeyCandidate): NormalizedAuthorKey | null {
  if (!isAuthorKeyType(candidate.type) || typeof candidate.value !== 'string') return null;
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
  }

  return {
    type: candidate.type,
    value,
    hash: sha256(`${candidate.type}:${value}`),
  };
}

export function mappingClaims(params: {
  provider: ServiceInstallProvider;
  forgeAccountId: string;
  sourceOwnerWalletId: string;
  agentWalletId: string;
  authorKey: NormalizedAuthorKey;
}): Record<string, string> {
  return {
    provider: params.provider,
    // The agent's PoP signature commits to the STABLE scope the identity is
    // registered under, so a challenge issued for one forge account can never
    // be replayed to bind the identity on another.
    forge_account_id: params.forgeAccountId,
    source_owner_wallet_id: params.sourceOwnerWalletId,
    agent_wallet_id: params.agentWalletId,
    author_key_type: params.authorKey.type,
    author_key_hash: params.authorKey.hash,
  };
}

/**
 * Deterministic mapping doc id. Digests the STABLE forge-account scope —
 * never a wallet id — so re-installs and wallet re-points land on the same
 * doc (the 2026-08-16 re-key; the prior wallet-keyed digest is what orphaned
 * every mapping on the 08-13 re-install). Exported so tests and consumers
 * bind to this single derivation instead of re-declaring it.
 */
export function mappingDocId(params: {
  provider: ServiceInstallProvider;
  forgeAccountId: string;
  authorKey: NormalizedAuthorKey;
}): string {
  const digest = sha256([
    params.provider,
    params.forgeAccountId,
    params.authorKey.type,
    params.authorKey.value,
  ].join('|')).slice(0, 40);
  return `${params.provider}_${digest}`;
}

export async function createVerifiedAuthorMapping(
  db: Firestore,
  params: {
    provider: ServiceInstallProvider;
    forgeAccountId: string;
    forgeAccountLogin?: string | null;
    sourceOwnerWalletId: string;
    agentWalletId: string;
    agentId: string;
    agentAddress: string;
    authorKey: NormalizedAuthorKey;
    keyFingerprint?: string | null;
  },
): Promise<AgentAuthorMappingDocument> {
  const mappingId = mappingDocId({
    provider: params.provider,
    forgeAccountId: params.forgeAccountId,
    authorKey: params.authorKey,
  });
  const ref = db.collection(COLLECTION).doc(mappingId);
  const now = Date.now();

  return await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const existing = snap.data() as Partial<AgentAuthorMappingDocument>;
      // One active wallet per identity per forge account — preserved verbatim
      // at the re-keyed granularity.
      if (
        existing.status === 'active' &&
        existing.agent_wallet_id &&
        existing.agent_wallet_id !== params.agentWalletId
      ) {
        throw new Error('author_key_already_mapped');
      }
    }

    const doc: AgentAuthorMappingDocument = {
      mapping_id: mappingId,
      provider: params.provider,
      forge_account_id: params.forgeAccountId,
      forge_account_login: params.forgeAccountLogin ?? null,
      source_owner_wallet_id: params.sourceOwnerWalletId,
      agent_wallet_id: params.agentWalletId,
      agent_id: params.agentId,
      agent_address: params.agentAddress,
      author_key_type: params.authorKey.type,
      author_key: params.authorKey.value,
      author_key_hash: params.authorKey.hash,
      key_fingerprint: params.keyFingerprint ?? null,
      verified_by: 'agent_wallet_signature',
      status: 'active',
      created_at: snap.exists
        ? (snap.data() as Partial<AgentAuthorMappingDocument>).created_at ?? now
        : now,
      verified_at: now,
      revoked_at: null,
    };
    tx.set(ref, doc);
    return doc;
  });
}

/**
 * Resolve the human owner's CANONICAL accrual identity from the `wallets` DOC id
 * the forge witness seals as the actor (`service_installs.user_id` is a wallets
 * doc id, not a user_id).
 *
 * WS4: an owner-capture mapping must store the wallet's `user_id` FIELD — the key
 * `pvt_accrual` / `wallets.pe_count` / the leaderboard read — and its on-chain
 * `address`, NOT the wallets doc id. A doc id keyed into `resolveWalletRef`
 * (accrual) matches nothing, so a doc-id-keyed PE landed in a phantom
 * `pvt_accrual/<walletDocId>` and never incremented pe_count, and `agent_address`
 * stayed empty. Id-bound + human-typed, mirroring the / doc-id fallback
 * discipline. Returns null (fail-closed, Unknown = Block) when the wallet cannot
 * be resolved — the caller then declines to create a mis-keyed mapping and the
 * commit drops unmapped, exactly as an unresolved author does today.
 */
async function resolveOwnerWalletIdentity(
  db: Firestore,
  ownerWalletId: string,
): Promise<{ userId: string; address: string } | null> {
  // Handle whichever id-space `service_installs.user_id` is in (the class-fix
  // discipline of resolveMintRecipientAddress: query the spaces, don't assume).
  // (1) Already a canonical user_id — the `user_id` FIELD names it; keep it as the
  // accrual key and only resolve the address.
  const byUser = await db.collection('wallets').where('user_id', '==', ownerWalletId).get();
  const byUserDocs = byUser.docs ?? [];
  if (byUserDocs.length > 0) {
    const data = (byUserDocs[0].data() ?? {}) as Record<string, unknown>;
    const address = typeof data.address === 'string' ? data.address : '';
    return { userId: ownerWalletId, address };
  }
  // (2) The forge-witness shape — a wallets DOC id. Resolve by doc id, id-bound +
  // human-typed, and CONVERT to the wallet's user_id field (the accrual key).
  if (ownerWalletId.startsWith('wallet_')) {
    const snap = await db.collection('wallets').doc(ownerWalletId).get();
    if (snap.exists) {
      const data = (snap.data() ?? {}) as Record<string, unknown>;
      const userId = typeof data.user_id === 'string' ? data.user_id : '';
      if (data.id === ownerWalletId && data.type === 'human' && userId) {
        const address = typeof data.address === 'string' ? data.address : '';
        return { userId, address };
      }
    }
  }
  return null;
}

/**
 * Auto-create a repo-OWNER author mapping (verified_by 'repo_owner_capture') with
 * NO PoP signature. Called from the GitHub webhook when a User-account install's
 * push arrives and the owner's own identity is not yet mapped, so the owner's own
 * commits remain attributable after the install-owner fallback was removed.
 *
 * The mapping's `agent_wallet_id` stays the wallets DOC id (the scope/rebind key),
 * but `agent_id` (the accrual key) and `agent_address` are resolved to the
 * wallet's `user_id` field and on-chain address via `resolveOwnerWalletIdentity`
 * (WS4). Returns null when that resolution fails — fail-closed, so a mis-keyed
 * mapping is never created.
 *
 * Precedence rules (2026-08-16 re-key):
 *  - An existing `agent_wallet_signature` mapping is ALWAYS returned untouched —
 *    explicit registration (including its revocation) outranks auto-capture.
 *  - An existing `repo_owner_capture` mapping pointing at the CURRENT install
 *    owner is returned untouched — EXCEPT when its stored `agent_id`/`agent_address`
 *    are stale (a legacy doc-id-keyed mapping), which is HEALED in place to the
 *    resolved user_id/address (WS4 self-heal; a same-owner revocation still stays
 *    respected — status is not touched by the heal).
 *  - An existing `repo_owner_capture` mapping pointing at a DIFFERENT wallet is
 *    REBOUND to the current install owner: owner-capture mappings are
 *    derivative of install ownership and follow it (conductor decision 4 —
 *    this is what makes a re-install self-healing for the owner's own
 *    identity with zero setup). The rebind re-activates: a revocation made
 *    under the PREVIOUS ownership era does not bind the new owner, whose
 *    authenticated connect + this HMAC-signed delivery are fresh consent.
 */
export async function createOwnerCaptureMapping(
  db: Firestore,
  params: {
    provider: ServiceInstallProvider;
    forgeAccountId: string;
    forgeAccountLogin?: string | null;
    ownerWalletId: string;
    authorKey: NormalizedAuthorKey;
  },
): Promise<AgentAuthorMappingDocument | null> {
  // Resolve the owner's canonical accrual identity BEFORE the transaction — the
  // wallet's user_id/address are stable, so this needs no txn isolation. A failure
  // here fails the whole capture closed (Unknown = Block); no mis-keyed mapping is
  // ever written.
  const identity = await resolveOwnerWalletIdentity(db, params.ownerWalletId);
  if (!identity) return null;

  const mappingId = mappingDocId({
    provider: params.provider,
    forgeAccountId: params.forgeAccountId,
    authorKey: params.authorKey,
  });
  const ref = db.collection(COLLECTION).doc(mappingId);
  const now = Date.now();

  return await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const existing = snap.data() as AgentAuthorMappingDocument;
      if (existing.verified_by === 'agent_wallet_signature') {
        // Never clobber an explicit signed mapping; auto-capture is additive.
        return existing;
      }
      if (existing.agent_wallet_id === params.ownerWalletId) {
        // Idempotent re-capture under the same owner — but HEAL a legacy mapping
        // whose agent_id/agent_address were the wallets doc id / empty (WS4). Only
        // the two accrual-identity fields move; status/revocation is untouched so a
        // same-owner revocation stays respected.
        if (existing.agent_id === identity.userId
          && existing.agent_address === identity.address) {
          return existing;
        }
        const healed: AgentAuthorMappingDocument = {
          ...existing,
          agent_id: identity.userId,
          agent_address: identity.address,
        };
        tx.set(ref, healed);
        return healed;
      }
      // Owner-capture follows the CURRENT install owner (rebind).
      const rebound: AgentAuthorMappingDocument = {
        ...existing,
        forge_account_id: params.forgeAccountId,
        forge_account_login: params.forgeAccountLogin ?? existing.forge_account_login ?? null,
        source_owner_wallet_id: params.ownerWalletId,
        agent_wallet_id: params.ownerWalletId,
        agent_id: identity.userId,
        agent_address: identity.address,
        verified_by: 'repo_owner_capture',
        status: 'active',
        verified_at: now,
        revoked_at: null,
      };
      tx.set(ref, rebound);
      return rebound;
    }
    const doc: AgentAuthorMappingDocument = {
      mapping_id: mappingId,
      provider: params.provider,
      forge_account_id: params.forgeAccountId,
      forge_account_login: params.forgeAccountLogin ?? null,
      source_owner_wallet_id: params.ownerWalletId,
      // The owner IS the credited party. agent_wallet_id stays the wallets DOC id
      // (the scope/rebind key), but agent_id is the wallet's user_id FIELD (the
      // accrual key) and agent_address its on-chain address (WS4).
      agent_wallet_id: params.ownerWalletId,
      agent_id: identity.userId,
      agent_address: identity.address,
      author_key_type: params.authorKey.type,
      author_key: params.authorKey.value,
      author_key_hash: params.authorKey.hash,
      key_fingerprint: null,
      verified_by: 'repo_owner_capture',
      status: 'active',
      created_at: now,
      verified_at: now,
      revoked_at: null,
    };
    tx.set(ref, doc);
    return doc;
  });
}

/**
 * Revoke a mapping. Sole authorized caller: the original vouching wallet
 * (`source_owner_wallet_id`).
 *
 * The 2026-08-16 authority extension — "the CURRENT owner of an ACTIVE install
 * on the mapping's forge account may also revoke" is REMOVED by the operator’s
 * ruling. Replaying the 08-13 scenario against it: a re-install that
 * re-points install ownership to a new wallet handed that new wallet the power
 * to revoke every existing mapping on the forge account, including explicit
 * PoP-signed `agent_wallet_signature` mappings it never vouched. That is
 * orphaning by authority, and "a re-install can never orphan existing author
 * mappings" binds the revocation surface exactly as it binds resolution.
 * The consequence the extension tried to avoid is accepted deliberately: a
 * mapping vouched by a dead/replaced wallet stays active and irrevocable by
 * anyone else — a standing attribution, not a dangling capability. Owner-
 * capture mappings still follow install ownership through the REBIND path in
 * `createOwnerCaptureMapping`, which re-points rather than removes.
 */
export async function revokeAuthorMapping(
  db: Firestore,
  params: {
    mappingId: string;
    callerWalletId: string;
    /**
     * Part 2: an AGENT caller may also revoke a mapping that NAMES it as
     * the credited wallet — withdrawing its own signed consent. This only ever
     * reduces the caller's own attribution (its commits stop mapping to it and
     * drop unmapped); it can never move credit to anyone else, so it is not the
     * authority rejected. A human caller never gets this leg: human
     * wallets are credited only through owner-capture, which follows install
     * ownership (the rebind path), not this revocation surface.
     */
    callerIsAgent?: boolean;
  },
): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(params.mappingId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data() as Partial<AgentAuthorMappingDocument>;

  const isVouchingWallet = data.source_owner_wallet_id === params.callerWalletId;
  const isNamedAgent = params.callerIsAgent === true
    && data.verified_by === 'agent_wallet_signature'
    && data.agent_wallet_id === params.callerWalletId;
  if (!isVouchingWallet && !isNamedAgent) {
    throw new Error('not_mapping_owner');
  }

  if (data.status === 'revoked') return true;
  await ref.update({ status: 'revoked', revoked_at: Date.now() });
  return true;
}

export async function listAuthorMappingsForSourceOwner(
  db: Firestore,
  sourceOwnerWalletId: string,
): Promise<AgentAuthorMappingDocument[]> {
  const snap = await db.collection(COLLECTION)
    .where('source_owner_wallet_id', '==', sourceOwnerWalletId)
    .get();
  return snap.docs.map((doc) => doc.data() as AgentAuthorMappingDocument);
}

/**
 * Every mapping that NAMES `agentWalletId` as the credited wallet, whatever
 * wallet vouched it (Part 2: a linked agent's self-registration on its
 * human's install is vouched by the human, so the agent's own view needs
 * this leg). Active and revoked alike — status is on the row.
 */
export async function listAuthorMappingsForAgent(
  db: Firestore,
  agentWalletId: string,
): Promise<AgentAuthorMappingDocument[]> {
  if (!agentWalletId) return [];
  const snap = await db.collection(COLLECTION)
    .where('agent_wallet_id', '==', agentWalletId)
    .get();
  return snap.docs.map((doc) => doc.data() as AgentAuthorMappingDocument);
}

export async function countActiveAuthorMappingsForAgent(
  db: Firestore,
  agentWalletId: string | null,
): Promise<number> {
  if (!agentWalletId) return 0;
  const snap = await db.collection(COLLECTION)
    .where('agent_wallet_id', '==', agentWalletId)
    .where('status', '==', 'active')
    .get();
  return typeof snap.size === 'number' ? snap.size : snap.docs.length;
}

/**
 * Resolve a delivery's author candidates to a verified mapping under the
 * STABLE forge-account scope (2026-08-16 re-key). Deliberately NO owner-wallet
 * condition: attribution matches whatever wallet the mapping names, however
 * many times the install has been reinstalled or re-pointed since the mapping
 * was vouched — that is exactly what "a re-install never orphans existing
 * author mappings" means. `sourceOwnerWalletId` is a pass-through recorded in
 * the PE's attribution metadata (who owns the delivering install today).
 * Direct doc gets per candidate replace the prior per-candidate full
 * owner-collection rescan.
 */
export async function resolveAgentAuthorAttribution(
  db: Firestore,
  params: {
    provider: ServiceInstallProvider;
    forgeAccountId: string;
    sourceOwnerWalletId: string;
    candidates: AuthorKeyCandidate[];
  },
): Promise<ResolvedAuthorAttribution | null> {
  const normalized = dedupeCandidates(params.candidates)
    .map(normalizeAuthorKey)
    .filter((key): key is NormalizedAuthorKey => key !== null);

  for (const authorKey of normalized) {
    const docId = mappingDocId({
      provider: params.provider,
      forgeAccountId: params.forgeAccountId,
      authorKey,
    });
    const doc = await db.collection(COLLECTION).doc(docId).get();
    if (!doc.exists) continue;
    const data = doc.data() as Partial<AgentAuthorMappingDocument>;
    // Field checks are defensive self-consistency against hand-written docs;
    // the doc id already encodes provider + forge account + key.
    if (data.provider !== params.provider) continue;
    if (stringField(data.forge_account_id) !== params.forgeAccountId) continue;
    if (data.author_key_type !== authorKey.type) continue;
    if (data.author_key !== authorKey.value) continue;
    if (data.status !== 'active') continue;
    if (data.verified_by !== 'agent_wallet_signature' && data.verified_by !== 'repo_owner_capture') continue;
    const agentWalletId = stringField(data.agent_wallet_id);
    const agentId = stringField(data.agent_id) || agentWalletId;
    if (!agentWalletId || !agentId) continue;

    return {
      mode: 'verified_author_mapping',
      mappingId: stringField(data.mapping_id) || doc.id,
      provider: params.provider,
      forgeAccountId: params.forgeAccountId,
      sourceOwnerWalletId: params.sourceOwnerWalletId,
      agentWalletId,
      agentId,
      agentAddress: stringField(data.agent_address) || '',
      authorKeyType: authorKey.type,
      authorKeyHash: stringField(data.author_key_hash) || authorKey.hash,
      verifiedBy: data.verified_by,
    };
  }

  return null;
}

export function attributionMetadata(
  provider: ServiceInstallProvider,
  sourceOwnerWalletId: string,
  resolved: ResolvedAuthorAttribution | null,
): AttributionMetadata {
  if (!resolved) {
    return {
      mode: 'installation_owner',
      provider,
      source_owner_wallet_id: sourceOwnerWalletId,
    };
  }

  return {
    mode: 'verified_author_mapping',
    provider,
    source_owner_wallet_id: sourceOwnerWalletId,
    forge_account_id: resolved.forgeAccountId,
    agent_wallet_id: resolved.agentWalletId,
    agent_id: resolved.agentId,
    mapping_id: resolved.mappingId,
    author_key_type: resolved.authorKeyType,
    author_key_hash: resolved.authorKeyHash,
    verified_by: resolved.verifiedBy,
  };
}

/**
 * Author-ONLY earning candidates from a GitHub payload: the commit author(s) on a
 * push, and the PR author on a merged PR — the parties who did the work.
 *
 * DELIBERATELY EXCLUDES the pusher (`payload.pusher`) and the event sender
 * (`payload.sender`). Merely PUSHING someone else's commit (a merge, a rebase, an
 * integration) must NEVER credit the pusher — that was a residual double-mint path
 * (the pusher's webhook PE + the author's own daemon PE). Attribution follows the
 * git author, full stop. GitHub stamps `author.username` on any commit whose email
 * is linked to a GitHub account (the normal case), so this needs nothing from the
 * user; a commit made with an unlinked email carries no username and correctly does
 * not attribute (GitHub itself would not link it to an account either).
 */
export function extractGitHubAuthorKeyCandidates(payload: Record<string, unknown>): AuthorKeyCandidate[] {
  const candidates: AuthorKeyCandidate[] = [];
  const headCommit = asRecord(payload.head_commit);
  const headAuthor = asRecord(headCommit.author);
  pushCandidate(candidates, 'email', headAuthor.email);
  pushCandidate(candidates, 'username', headAuthor.username);

  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  for (const commit of commits) {
    const author = asRecord(asRecord(commit).author);
    pushCandidate(candidates, 'email', author.email);
    pushCandidate(candidates, 'username', author.username);
  }

  // PR-merged events carry no `commits[]`; the PR opener is the work-doer.
  const pr = asRecord(payload.pull_request);
  const prUser = asRecord(pr.user);
  pushCandidate(candidates, 'username', prUser.login);

  return dedupeCandidates(candidates);
}

/**
 * SENDER-only candidates for a GENERIC (non-commit) GitHub event — the account that performed the
 * act (opened the issue, cut the release, reviewed the PR). Used ONLY by the generic synthesizer
 * path (`commitSha === null`); it is a SEPARATE function so the author-only list above can never
 * fall through to the sender on a push/PR (1 on the Trust Layer build: appending the
 * sender "last" still credited the pusher whenever the author was unmapped — first-mapped wins).
 */
export function extractGitHubSenderKeyCandidates(payload: Record<string, unknown>): AuthorKeyCandidate[] {
  const candidates: AuthorKeyCandidate[] = [];
  const sender = asRecord(payload.sender);
  pushCandidate(candidates, 'username', sender.login);
  pushCandidate(candidates, 'account_id', sender.id);
  return dedupeCandidates(candidates);
}

export function extractGitLabAuthorKeyCandidates(payload: Record<string, unknown>): AuthorKeyCandidate[] {
  const candidates: AuthorKeyCandidate[] = [];
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  for (const commit of commits) {
    const cm = asRecord(commit);
    pushCandidate(candidates, 'email', cm.author_email);
    pushCandidate(candidates, 'username', cm.author_name);
    const author = asRecord(cm.author);
    pushCandidate(candidates, 'email', author.email);
    pushCandidate(candidates, 'username', author.name);
  }

  pushCandidate(candidates, 'email', payload.user_email);
  pushCandidate(candidates, 'username', payload.user_username);
  pushCandidate(candidates, 'username', payload.user_name);

  const attrs = asRecord(payload.object_attributes);
  pushCandidate(candidates, 'username', attrs.author_username);
  pushCandidate(candidates, 'account_id', attrs.author_id);
  return dedupeCandidates(candidates);
}

export function extractBitbucketAuthorKeyCandidates(payload: Record<string, unknown>): AuthorKeyCandidate[] {
  const candidates: AuthorKeyCandidate[] = [];
  const push = asRecord(payload.push);
  const changes = Array.isArray(push.changes) ? push.changes : [];
  for (const change of changes) {
    const commits = Array.isArray(asRecord(change).commits) ? asRecord(change).commits as unknown[] : [];
    for (const commit of commits) {
      const cm = asRecord(commit);
      const author = asRecord(cm.author);
      pushCandidate(candidates, 'account_id', asRecord(author.user).account_id);
      pushCandidate(candidates, 'account_id', asRecord(author.user).uuid);
      pushCandidate(candidates, 'username', asRecord(author.user).nickname);
      const raw = stringField(author.raw);
      if (raw) {
        const email = extractEmail(raw);
        if (email) pushCandidate(candidates, 'email', email);
      }
    }
  }

  const pr = asRecord(payload.pullrequest);
  const author = asRecord(pr.author);
  pushCandidate(candidates, 'account_id', author.account_id);
  pushCandidate(candidates, 'account_id', author.uuid);
  pushCandidate(candidates, 'username', author.nickname);
  return dedupeCandidates(candidates);
}
