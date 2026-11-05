import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import type { AgentWalletDocument } from '../core/agent-wallet/types';
import {
  canonicalPopMessage,
  issueClaimsPopChallenge,
  peekClaimsPopChallenge,
  verifyAndConsumeClaimsPopChallenge,
} from '../core/agent-wallet/proof-of-possession';
import {
  createVerifiedAuthorMapping,
  isAuthorKeyType,
  isServiceInstallProvider,
  listAuthorMappingsForAgent,
  listAuthorMappingsForSourceOwner,
  mappingClaims,
  normalizeAuthorKey,
  revokeAuthorMapping,
  type AgentAuthorMappingDocument,
  type AuthorKeyType,
  type NormalizedAuthorKey,
} from '../core/agent-attribution/author-mappings';
import {
  getServiceInstallByInstallationId,
  getServiceInstallsByUser,
  installForgeAccountScope,
  type ServiceInstallDocument,
  type ServiceInstallProvider,
} from '../core/witnesses/service-installs';

interface AgentAttributionRouterDeps {
  db: Firestore;
  cache: RedisCache;
}

interface SourceOwner {
  walletId: string;
  ownerType: 'human' | 'agent';
}

const PURPOSE = 'agent_author_mapping' as const;

function stringBodyField(body: unknown, field: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
}

async function resolveSourceOwner(req: Request, db: Firestore): Promise<SourceOwner | null> {
  const agentWallet = req.agentWallet;
  if (agentWallet?.id) {
    return { walletId: agentWallet.id, ownerType: 'agent' };
  }

  const userId = req.user?.id;
  if (typeof userId !== 'string' || userId.length === 0) return null;

  const walletSnap = await db.collection('wallets')
    .where('user_id', '==', userId)
    .limit(1)
    .get();
  if (walletSnap.empty) return null;
  return { walletId: walletSnap.docs[0].id, ownerType: 'human' };
}

async function loadActiveAgentWallet(
  db: Firestore,
  agentWalletId: string,
): Promise<AgentWalletDocument | null> {
  if (!agentWalletId) return null;
  const doc = await db.collection('agent_wallets').doc(agentWalletId).get();
  if (!doc.exists) return null;
  const wallet = doc.data() as AgentWalletDocument;
  if (wallet.status !== 'active') return null;
  if (typeof wallet.public_key !== 'string' || wallet.public_key.length === 0) return null;
  return wallet;
}

function publicMapping(doc: AgentAuthorMappingDocument): Record<string, unknown> {
  return {
    mapping_id: doc.mapping_id,
    provider: doc.provider,
    forge_account_id: doc.forge_account_id,
    forge_account_login: doc.forge_account_login,
    source_owner_wallet_id: doc.source_owner_wallet_id,
    agent_wallet_id: doc.agent_wallet_id,
    agent_id: doc.agent_id,
    author_key_type: doc.author_key_type,
    author_key_hash: doc.author_key_hash,
    verified_by: doc.verified_by,
    status: doc.status,
    created_at: doc.created_at,
    verified_at: doc.verified_at,
    revoked_at: doc.revoked_at,
  };
}

function parseMappingBody(req: Request): {
  provider: ReturnType<typeof normalizeProvider>;
  agentWalletId: string;
  authorKey: NormalizedAuthorKey | null;
  authorKeyType: AuthorKeyType | null;
  installationId: string;
} {
  const provider = normalizeProvider(stringBodyField(req.body, 'provider'));
  const agentWalletId = stringBodyField(req.body, 'agent_wallet_id');
  const authorKeyTypeRaw = stringBodyField(req.body, 'author_key_type');
  const authorKeyType = isAuthorKeyType(authorKeyTypeRaw) ? authorKeyTypeRaw : null;
  const authorKeyValue = stringBodyField(req.body, 'author_key');
  const authorKey = authorKeyType
    ? normalizeAuthorKey({ type: authorKeyType, value: authorKeyValue })
    : null;
  const installationId = stringBodyField(req.body, 'installation_id');
  return { provider, agentWalletId, authorKey, authorKeyType, installationId };
}

function normalizeProvider(value: unknown) {
  return isServiceInstallProvider(value) ? value : null;
}

interface RegistrationScope {
  install: ServiceInstallDocument;
  forgeAccountId: string;
}

type RegistrationScopeResult =
  | { ok: true; scope: RegistrationScope }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * The wallet ids whose ACTIVE installs the caller may register an identity
 * under — always the caller's OWN wallet only.
 *
 * F59 (S2 2026-09-10): Part 2 had extended this to add the LINKED HUMAN's
 * wallet whenever an agent self-registered (`target === caller`), on the theory
 * that the human's accepted beneficiary link is standing authorization for the
 * agent to bind "its OWN git identity" on the human's repos. But nothing in this
 * router can verify that the caller-supplied `author_key` IS the agent's own git
 * identity — so the extension let a linked agent bind ANY author key (e.g. the
 * human's most prolific third-party contributor's email) on the human's install,
 * crediting that contributor's commits to the agent's wallet (20% to the agent,
 * 80% to the human, for work neither performed). Worse, it broke the /complete
 * handoff's core invariant ("only the OWNER's authenticated call can mint a
 * challenge with its wallet as source_owner") — an agent's /challenge call could
 * mint a challenge naming the human as source_owner, then the agent completed it
 * alone.
 *
 * The scope is now the caller's own installs only. Binding an author key on the
 * HUMAN's install therefore requires the two-party handoff this same commit
 * built: the HUMAN issues the challenge under its own wallet auth (so
 * source_owner is the human, vouched by the human), and the AGENT completes it
 * via /author-mappings/complete with its key signature. No unproven key binds.
 */
function registrationOwnerCandidates(sourceOwner: SourceOwner): string[] {
  return [sourceOwner.walletId];
}

/**
 * Resolve the forge-account scope a mapping registration binds to, from an
 * active install owned by one of `ownerCandidates` (2026-08-16 re-key; the
 * candidate set is the Part 2 extension of the previous single-caller
 * scoping, not a new gate: without it, forge-account-scoped mappings would let
 * any wallet claim identities on someone else's repos (Unknown = Block). The
 * caller may name `installation_id` explicitly; when omitted and exactly one
 * active install exists for the provider across the candidates, that one is
 * used deterministically.
 */
async function resolveRegistrationScope(
  db: Firestore,
  ownerCandidates: readonly string[],
  provider: ServiceInstallProvider,
  installationId: string,
): Promise<RegistrationScopeResult> {
  let install: ServiceInstallDocument | null = null;
  if (installationId) {
    const found = await getServiceInstallByInstallationId(db, provider, installationId);
    // Uniform refusal for missing-or-not-owned: naming someone else's install
    // id must not act as an existence oracle.
    if (!found || !ownerCandidates.includes(found.user_id)) {
      return { ok: false, status: 404, error: 'install_not_found' };
    }
    if (found.revoked_at !== null) {
      return { ok: false, status: 410, error: 'install_revoked' };
    }
    install = found;
  } else {
    const actives: ServiceInstallDocument[] = [];
    for (const owner of ownerCandidates) {
      const owned = (await getServiceInstallsByUser(db, owner))
        .filter((doc) => doc.provider === provider && doc.revoked_at === null);
      actives.push(...owned);
    }
    if (actives.length === 0) {
      return { ok: false, status: 404, error: 'no_active_install_for_provider' };
    }
    if (actives.length > 1) {
      return {
        ok: false,
        status: 400,
        error: 'installation_id_required',
        detail: 'multiple active installs for this provider; name installation_id explicitly',
      };
    }
    install = actives[0];
  }

  const forgeAccountId = installForgeAccountScope(install);
  if (!forgeAccountId) {
    // github only: the install learns its forge account from the first
    // HMAC-verified delivery (stampServiceInstallForgeAccount). A
    // never-pushed install cannot scope a registration yet.
    return {
      ok: false,
      status: 409,
      error: 'install_forge_account_unknown',
      detail: 'push once from the connected repository so the install learns its GitHub account, then retry',
    };
  }
  return { ok: true, scope: { install, forgeAccountId } };
}

/**
 * Re-check, at completion time, that the owner who issued a challenge still
 * holds an ACTIVE install on the forge account the claims name. The owner's
 * authorization must be standing when the mapping is written, not only when
 * the challenge was minted. Uniform null on any miss (no oracle).
 */
async function findStandingOwnerInstall(
  db: Firestore,
  ownerWalletId: string,
  provider: ServiceInstallProvider,
  forgeAccountId: string,
): Promise<ServiceInstallDocument | null> {
  const owned = await getServiceInstallsByUser(db, ownerWalletId);
  return owned.find((doc) =>
    doc.provider === provider
    && doc.revoked_at === null
    && installForgeAccountScope(doc) === forgeAccountId) ?? null;
}

export function createAgentAttributionRouter(deps: AgentAttributionRouterDeps): Router {
  const router = Router();

  /**
   * POST /author-mappings/challenge
   *
   * The authenticated source owner (human wallet or agent wallet) chooses a
   * provider+author key to bind. The target agent wallet signs the returned
   * claims-bound message with its own registered key before /author-mappings
   * (same caller) or /author-mappings/complete (the target agent itself)
   * persists the setting. Attribution is therefore set once and automatic.
   */
  router.post('/author-mappings/challenge', async (req: Request, res: Response) => {
    try {
      const sourceOwner = await resolveSourceOwner(req, deps.db);
      if (!sourceOwner) {
        res.status(401).json({ error: 'Wallet authentication required' });
        return;
      }

      const parsed = parseMappingBody(req);
      if (!parsed.provider) {
        res.status(400).json({ error: 'provider must be github, gitlab, or bitbucket' });
        return;
      }
      if (!parsed.authorKeyType || !parsed.authorKey) {
        res.status(400).json({ error: 'author_key_type and valid author_key are required' });
        return;
      }

      const agentWallet = await loadActiveAgentWallet(deps.db, parsed.agentWalletId);
      if (!agentWallet) {
        res.status(404).json({ error: 'active agent_wallet_id with public_key is required' });
        return;
      }

      const scoped = await resolveRegistrationScope(
        deps.db,
        registrationOwnerCandidates(sourceOwner),
        parsed.provider,
        parsed.installationId,
      );
      if (!scoped.ok) {
        res.status(scoped.status).json({ error: scoped.error, detail: scoped.detail });
        return;
      }

      // The vouching owner is the INSTALL owner. For a human or an agent
      // registering on its own install this is the caller; for a linked agent
      // self-registering on its human's install it is the human, so the
      // human's Contributors view lists it and the human may revoke it.
      const claims = mappingClaims({
        provider: parsed.provider,
        forgeAccountId: scoped.scope.forgeAccountId,
        sourceOwnerWalletId: scoped.scope.install.user_id,
        agentWalletId: parsed.agentWalletId,
        authorKey: parsed.authorKey,
      });
      const challenge = await issueClaimsPopChallenge(deps.cache, {
        purpose: PURPOSE,
        public_key_hex: agentWallet.public_key,
        claims,
      });
      const message = canonicalPopMessage({
        purpose: PURPOSE,
        challenge: challenge.challenge,
        claims,
      });

      res.json({
        ...challenge,
        purpose: PURPOSE,
        source_owner_wallet_id: scoped.scope.install.user_id,
        source_owner_type: sourceOwner.ownerType,
        forge_account_id: scoped.scope.forgeAccountId,
        installation_id: scoped.scope.install.installation_id,
        agent_wallet_id: parsed.agentWalletId,
        agent_id: agentWallet.agent_id,
        author_key_type: parsed.authorKey.type,
        author_key_hash: parsed.authorKey.hash,
        message,
      });
    } catch (err) {
      if ((err as Error).message === 'CACHE_UNAVAILABLE') {
        res.status(503).json({ error: 'Challenge store unavailable' });
        return;
      }
      console.error('[AgentAttribution] challenge error:', err);
      res.status(500).json({ error: 'Failed to issue author mapping challenge' });
    }
  });

  /**
   * GET /author-mappings/challenge/:challenge_id — the TARGET agent reads an
   * owner-issued challenge (nonce + claims + canonical message) so it can sign
   * it in its own process. Agent auth only, and only the agent the claims
   * name; every other case is a uniform 404.
   */
  router.get('/author-mappings/challenge/:challenge_id', async (req: Request, res: Response) => {
    try {
      const callerAgent = req.agentWallet;
      if (!callerAgent?.id) {
        res.status(401).json({ error: 'Agent wallet authentication required' });
        return;
      }
      const challengeId = req.params.challenge_id;
      const stored = challengeId
        ? await peekClaimsPopChallenge(deps.cache, { challenge_id: challengeId, purpose: PURPOSE })
        : null;
      if (!stored || stored.claims.agent_wallet_id !== callerAgent.id) {
        res.status(404).json({ error: 'challenge_not_found' });
        return;
      }
      res.json({
        challenge_id: challengeId,
        challenge: stored.challenge,
        purpose: PURPOSE,
        claims: stored.claims,
        message: canonicalPopMessage({ purpose: PURPOSE, challenge: stored.challenge, claims: stored.claims }),
      });
    } catch (err) {
      console.error('[AgentAttribution] challenge read error:', err);
      res.status(500).json({ error: 'Failed to read author mapping challenge' });
    }
  });

  router.post('/author-mappings', async (req: Request, res: Response) => {
    try {
      const sourceOwner = await resolveSourceOwner(req, deps.db);
      if (!sourceOwner) {
        res.status(401).json({ error: 'Wallet authentication required' });
        return;
      }

      const parsed = parseMappingBody(req);
      const challengeId = stringBodyField(req.body, 'challenge_id');
      const signature = stringBodyField(req.body, 'signature');
      if (!parsed.provider) {
        res.status(400).json({ error: 'provider must be github, gitlab, or bitbucket' });
        return;
      }
      if (!parsed.authorKeyType || !parsed.authorKey) {
        res.status(400).json({ error: 'author_key_type and valid author_key are required' });
        return;
      }
      if (!challengeId || !signature) {
        res.status(400).json({ error: 'challenge_id and signature are required' });
        return;
      }

      const agentWallet = await loadActiveAgentWallet(deps.db, parsed.agentWalletId);
      if (!agentWallet) {
        res.status(404).json({ error: 'active agent_wallet_id with public_key is required' });
        return;
      }

      const scoped = await resolveRegistrationScope(
        deps.db,
        registrationOwnerCandidates(sourceOwner),
        parsed.provider,
        parsed.installationId,
      );
      if (!scoped.ok) {
        res.status(scoped.status).json({ error: scoped.error, detail: scoped.detail });
        return;
      }

      const claims = mappingClaims({
        provider: parsed.provider,
        forgeAccountId: scoped.scope.forgeAccountId,
        sourceOwnerWalletId: scoped.scope.install.user_id,
        agentWalletId: parsed.agentWalletId,
        authorKey: parsed.authorKey,
      });
      const pop = await verifyAndConsumeClaimsPopChallenge(deps.cache, {
        challenge_id: challengeId,
        purpose: PURPOSE,
        public_key_hex: agentWallet.public_key,
        expected_claims: claims,
        signature_hex: signature,
      });
      if (!pop.ok) {
        res.status(400).json({
          error: 'Agent key proof failed',
          reason: pop.reason,
        });
        return;
      }

      const mapping = await createVerifiedAuthorMapping(deps.db, {
        provider: parsed.provider,
        forgeAccountId: scoped.scope.forgeAccountId,
        forgeAccountLogin: scoped.scope.install.forge_account_login ?? null,
        sourceOwnerWalletId: scoped.scope.install.user_id,
        agentWalletId: parsed.agentWalletId,
        agentId: agentWallet.agent_id,
        agentAddress: agentWallet.address,
        authorKey: parsed.authorKey,
      });

      res.status(201).json({
        ok: true,
        mapping: publicMapping(mapping),
      });
    } catch (err) {
      if ((err as Error).message === 'author_key_already_mapped') {
        res.status(409).json({ error: 'author_key_already_mapped' });
        return;
      }
      console.error('[AgentAttribution] verify error:', err);
      res.status(500).json({ error: 'Failed to register author mapping' });
    }
  });

  /**
   * POST /author-mappings/complete — the two-party handoff. The repo OWNER
   * issued a challenge (under its own wallet auth) naming this agent as the
   * target; the AGENT now submits its signature under its OWN agent auth, so
   * the signature travels through the relay and is never pasted into the
   * owner's phone. Auth paths are not merged: the owner's authority is proven
   * by the challenge's existence (only the owner's authenticated call can
   * mint one with its wallet as source_owner), and re-verified here by
   * requiring that owner to STILL hold an active install on the forge
   * account the claims name. The agent supplies the author key VALUE, which
   * must hash to the committed `author_key_hash` — the claims themselves come
   * from the relay's own store, never from this request.
   */
  router.post('/author-mappings/complete', async (req: Request, res: Response) => {
    try {
      const callerAgent = req.agentWallet;
      if (!callerAgent?.id) {
        res.status(401).json({ error: 'Agent wallet authentication required' });
        return;
      }
      const challengeId = stringBodyField(req.body, 'challenge_id');
      const signature = stringBodyField(req.body, 'signature');
      const authorKeyTypeRaw = stringBodyField(req.body, 'author_key_type');
      const authorKeyType = isAuthorKeyType(authorKeyTypeRaw) ? authorKeyTypeRaw : null;
      const authorKey = authorKeyType
        ? normalizeAuthorKey({ type: authorKeyType, value: stringBodyField(req.body, 'author_key') })
        : null;
      if (!challengeId || !signature) {
        res.status(400).json({ error: 'challenge_id and signature are required' });
        return;
      }
      if (!authorKeyType || !authorKey) {
        res.status(400).json({ error: 'author_key_type and valid author_key are required' });
        return;
      }

      const stored = await peekClaimsPopChallenge(deps.cache, { challenge_id: challengeId, purpose: PURPOSE });
      if (!stored || stored.claims.agent_wallet_id !== callerAgent.id) {
        res.status(404).json({ error: 'challenge_not_found' });
        return;
      }
      const claims = stored.claims;
      const provider = normalizeProvider(claims.provider);
      if (!provider || typeof claims.forge_account_id !== 'string' || typeof claims.source_owner_wallet_id !== 'string') {
        res.status(404).json({ error: 'challenge_not_found' });
        return;
      }
      if (claims.author_key_type !== authorKey.type || claims.author_key_hash !== authorKey.hash) {
        res.status(400).json({ error: 'author_key_mismatch' });
        return;
      }

      // The signer must be the ACTIVE wallet the claims name, with the key the
      // challenge was bound to. Load fresh — never trust a cached doc for a
      // write that binds identity.
      const agentWallet = await loadActiveAgentWallet(deps.db, callerAgent.id);
      if (!agentWallet) {
        res.status(404).json({ error: 'active agent_wallet_id with public_key is required' });
        return;
      }

      const install = await findStandingOwnerInstall(
        deps.db, claims.source_owner_wallet_id, provider, claims.forge_account_id,
      );
      if (!install) {
        res.status(404).json({ error: 'install_not_found' });
        return;
      }

      const pop = await verifyAndConsumeClaimsPopChallenge(deps.cache, {
        challenge_id: challengeId,
        purpose: PURPOSE,
        public_key_hex: agentWallet.public_key,
        expected_claims: claims,
        signature_hex: signature,
      });
      if (!pop.ok) {
        res.status(400).json({ error: 'Agent key proof failed', reason: pop.reason });
        return;
      }

      const mapping = await createVerifiedAuthorMapping(deps.db, {
        provider,
        forgeAccountId: claims.forge_account_id,
        forgeAccountLogin: install.forge_account_login ?? null,
        sourceOwnerWalletId: claims.source_owner_wallet_id,
        agentWalletId: agentWallet.id,
        agentId: agentWallet.agent_id,
        agentAddress: agentWallet.address,
        authorKey,
      });
      res.status(201).json({ ok: true, mapping: publicMapping(mapping) });
    } catch (err) {
      if ((err as Error).message === 'author_key_already_mapped') {
        res.status(409).json({ error: 'author_key_already_mapped' });
        return;
      }
      console.error('[AgentAttribution] complete error:', err);
      res.status(500).json({ error: 'Failed to complete author mapping' });
    }
  });

  /**
   * GET /author-mappings — every mapping the caller VOUCHED (source owner)
   * plus, for an agent caller, every mapping that NAMES it as the credited
   * wallet (a linked agent's self-registration is vouched by its human, so
   * without the second leg the agent could never see its own binding).
   */
  router.get('/author-mappings', async (req: Request, res: Response) => {
    try {
      const sourceOwner = await resolveSourceOwner(req, deps.db);
      if (!sourceOwner) {
        res.status(401).json({ error: 'Wallet authentication required' });
        return;
      }

      const vouched = await listAuthorMappingsForSourceOwner(deps.db, sourceOwner.walletId);
      const named = sourceOwner.ownerType === 'agent'
        ? await listAuthorMappingsForAgent(deps.db, sourceOwner.walletId)
        : [];
      const seen = new Set<string>();
      const mappings: AgentAuthorMappingDocument[] = [];
      for (const doc of [...vouched, ...named]) {
        if (seen.has(doc.mapping_id)) continue;
        seen.add(doc.mapping_id);
        mappings.push(doc);
      }
      res.json({
        source_owner_wallet_id: sourceOwner.walletId,
        mappings: mappings.map(publicMapping),
        count: mappings.length,
      });
    } catch (err) {
      console.error('[AgentAttribution] list error:', err);
      res.status(500).json({ error: 'Failed to list author mappings' });
    }
  });

  router.delete('/author-mappings/:mapping_id', async (req: Request, res: Response) => {
    try {
      const sourceOwner = await resolveSourceOwner(req, deps.db);
      if (!sourceOwner) {
        res.status(401).json({ error: 'Wallet authentication required' });
        return;
      }

      const mappingId = req.params.mapping_id;
      if (!mappingId) {
        res.status(400).json({ error: 'mapping_id is required' });
        return;
      }
      // Authority (, replacing the 2026-08-16 extension): the original
      // vouching wallet — or, Part 2, the AGENT the mapping credits
      // withdrawing its own signed consent. Never a new install owner, which
      // would be orphaning by authority. See revokeAuthorMapping.
      const existed = await revokeAuthorMapping(deps.db, {
        mappingId,
        callerWalletId: sourceOwner.walletId,
        callerIsAgent: sourceOwner.ownerType === 'agent',
      });
      if (!existed) {
        res.status(404).json({ error: 'mapping_not_found' });
        return;
      }
      res.json({ revoked: true, mapping_id: mappingId });
    } catch (err) {
      if ((err as Error).message === 'not_mapping_owner') {
        res.status(403).json({ error: 'not_mapping_owner' });
        return;
      }
      console.error('[AgentAttribution] revoke error:', err);
      res.status(500).json({ error: 'Failed to revoke author mapping' });
    }
  });

  return router;
}
