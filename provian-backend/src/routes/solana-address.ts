/**
 * follow-up — prove a SOLANA address (ed25519), for an agent or a person.
 *
 * The Solana twin of `routes/external-address.ts` (agent, agent API auth) and
 * `routes/person-external-address.ts` (person, wallet auth). Same shape, same rules; see
 * `core/external-address/solana-proof.ts` for the proof and `solana-link.ts` for the registry.
 *
 * Agent (agent API auth, `Bearer pvn_live_…:pvns_…`), mounted at /v1/agent:
 * POST /v1/agent/solana-address/challenge { address }
 * -> { challenge_id, message, nonce, issued_at, expires_at, address, chain, network }
 * POST /v1/agent/solana-address/verify { address, challenge_id, signature, origin? }
 * -> { ok, proven_address, proven_at, proven_at_slot, origin, proof_method, already_proven, pe_id, pe_hash }
 * GET /v1/agent/solana-addresses -> { addresses: [...] }
 *
 * Person (request-bound wallet auth), mounted at /v1/wallet:
 * POST /v1/wallet/solana-address/challenge, POST /v1/wallet/solana-address/verify,
 * GET /v1/wallet/solana-addresses (same bodies; verify adds `owner: 'person'`)
 *
 * The owner is ALWAYS the authenticated caller — an agent binds an address only to itself, a
 * person only to themself. What binds the address is the ed25519 signature of whoever holds its
 * key, over the server-stored message. `origin` ('native' | 'external', default 'external') is
 * recorded for display only.
 *
 * Refusals: 400 malformed input / unknown or expired challenge / subject or address mismatch;
 * 401 signature that does not verify (the challenge is NOT consumed); 409
 * `address_bound_to_other_owner` / `address_is_provian_service_wallet`; 503 the challenge store or
 * the Solana slot read is unavailable (fail closed).
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import { isSolanaAddress } from '../core/external-address/solana-keys';
import {
  issueSolanaChallengeFor,
  proveSolanaAddress,
  solanaProofReasonToStatus,
  type SolanaProofChainDeps,
  type SolanaProofOwner,
} from '../core/external-address/solana-proof';
import {
  listSolanaProvenAddressesForOwner,
  solanaAddressRefusal,
  type SolanaAddressOrigin,
  type SolanaProvenAddressRecord,
} from '../core/external-address/solana-link';
import { FACILITATOR_SOLANA_NETWORK } from '../core/pvt/x402-facilitator-settlement';
import { isActiveHumanWallet } from '../core/wallet/active-human-wallet';

export const PERSON_SOLANA_CHALLENGE_LIMIT_PER_HOUR = 20;
export const PERSON_SOLANA_VERIFY_LIMIT_PER_HOUR = 20;

const ADDRESS_ERROR = 'address must be a canonical base58 Solana address';

export interface SolanaAddressRouterOptions {
  /** Test seam: the Solana slot read. Production omits it. */
  readonly solanaProofChainDeps?: SolanaProofChainDeps;
  readonly env?: NodeJS.ProcessEnv;
}

function parseOrigin(raw: unknown): SolanaAddressOrigin | null {
  if (raw === undefined || raw === null) return 'external';
  return raw === 'native' || raw === 'external' ? raw : null;
}

function publicRow(r: SolanaProvenAddressRecord) {
  return {
    address: r.address,
    proven_at: r.proven_at_ms,
    proven_at_slot: r.proven_at_slot,
    origin: r.origin,
    proof_method: r.proof_method,
    chain: r.chain,
    network: r.network,
  };
}

function ownerRef(owner: SolanaProofOwner): { ownerType: 'agent' | 'human'; ownerId: string } {
  return owner.ownerType === 'agent'
    ? { ownerType: 'agent', ownerId: owner.agentId }
    : { ownerType: 'human', ownerId: owner.userId };
}

type OwnerGuard = { ok: true; owner: SolanaProofOwner } | { ok: false; status: number; error: string };

/** The three handlers, shared by both routers; only how the owner is resolved differs. */
function solanaHandlers(
  deps: AgentBankDeps,
  resolveOwner: (req: Request) => Promise<OwnerGuard>,
  options: SolanaAddressRouterOptions & {
    readonly limit?: (owner: SolanaProofOwner, kind: 'challenge' | 'verify', res: Response) => Promise<boolean>;
    readonly label: string;
    readonly verifyExtra?: Record<string, unknown>;
  },
) {
  const challenge = async (req: Request, res: Response): Promise<void> => {
    try {
      const guard = await resolveOwner(req);
      if (!guard.ok) { res.status(guard.status).json({ error: guard.error }); return; }
      const address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
      if (!isSolanaAddress(address)) { res.status(400).json({ error: ADDRESS_ERROR }); return; }
      const refusal = await solanaAddressRefusal(deps.db, ownerRef(guard.owner), address, options.env);
      if (refusal) { res.status(409).json({ error: refusal }); return; }
      if (options.limit && !await options.limit(guard.owner, 'challenge', res)) return;
      const issued = await issueSolanaChallengeFor(deps.cache, guard.owner, address);
      res.json({ ...issued, address, chain: 'solana', network: FACILITATOR_SOLANA_NETWORK });
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'CACHE_UNAVAILABLE') { res.status(503).json({ error: 'cache_unavailable' }); return; }
      if (message === 'invalid_address') { res.status(400).json({ error: ADDRESS_ERROR }); return; }
      console.error(`[${options.label}] challenge error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  const verify = async (req: Request, res: Response): Promise<void> => {
    try {
      const guard = await resolveOwner(req);
      if (!guard.ok) { res.status(guard.status).json({ error: guard.error }); return; }
      const address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
      const challengeId = typeof req.body?.challenge_id === 'string' ? req.body.challenge_id : '';
      const signature = typeof req.body?.signature === 'string' ? req.body.signature.trim() : '';
      const origin = parseOrigin(req.body?.origin);
      if (!isSolanaAddress(address)) { res.status(400).json({ error: ADDRESS_ERROR }); return; }
      if (!challengeId) { res.status(400).json({ error: 'challenge_id is required' }); return; }
      if (!signature) { res.status(400).json({ error: 'signature is required' }); return; }
      if (origin === null) { res.status(400).json({ error: "origin must be 'native' or 'external'" }); return; }
      const refusal = await solanaAddressRefusal(deps.db, ownerRef(guard.owner), address, options.env);
      if (refusal) { res.status(409).json({ ok: false, error: refusal }); return; }
      if (options.limit && !await options.limit(guard.owner, 'verify', res)) return;
      const result = await proveSolanaAddress(
        deps,
        { owner: guard.owner, address, challengeId, signature, origin, ...(options.env ? { env: options.env } : {}) },
        ...(options.solanaProofChainDeps ? [options.solanaProofChainDeps] : []),
      );
      if (!result.ok) {
        res.status(solanaProofReasonToStatus(result.reason)).json({ ok: false, error: result.reason });
        return;
      }
      res.json({ ...result, ...(options.verifyExtra ?? {}) });
    } catch (err) {
      console.error(`[${options.label}] verify error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  const list = async (req: Request, res: Response): Promise<void> => {
    try {
      const guard = await resolveOwner(req);
      if (!guard.ok) { res.status(guard.status).json({ error: guard.error }); return; }
      const records = await listSolanaProvenAddressesForOwner(deps.db, ownerRef(guard.owner));
      res.json({ addresses: records.map(publicRow).sort((a, b) => b.proven_at - a.proven_at) });
    } catch (err) {
      console.error(`[${options.label}] list error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  return { challenge, verify, list };
}

// =============================================================================
// AGENT — mounted at /v1/agent
// =============================================================================

export function createAgentSolanaAddressRouter(
  deps: AgentBankDeps,
  options: SolanaAddressRouterOptions & { readonly authenticateAgent?: RequestHandler } = {},
): Router {
  const router = Router();
  const authenticateAgent = options.authenticateAgent ?? createAgentAuthMiddleware(deps.db);
  const resolveOwner = async (req: Request): Promise<OwnerGuard> => {
    const wallet = req.agentWallet;
    if (!wallet || req.user) return { ok: false, status: 401, error: 'Agent authentication required' };
    return {
      ok: true,
      owner: { ownerType: 'agent', agentId: wallet.agent_id, walletId: wallet.id, ownerEvmAddress: wallet.address },
    };
  };
  const h = solanaHandlers(deps, resolveOwner, { ...options, label: 'agent-solana-address' });
  router.post('/solana-address/challenge', authenticateAgent, h.challenge);
  router.post('/solana-address/verify', authenticateAgent, h.verify);
  router.get('/solana-addresses', authenticateAgent, h.list);
  return router;
}

// =============================================================================
// PERSON — mounted at /v1/wallet
// =============================================================================

export interface PersonSolanaAddressRouterDeps extends SolanaAddressRouterOptions {
  readonly agentBankDeps: AgentBankDeps;
  readonly authenticate: RequestHandler;
}

/** The caller's OWN single active human wallet (the same rule as the person EVM proof). */
async function resolvePersonOwner(deps: AgentBankDeps, req: Request): Promise<OwnerGuard> {
  const userId = req.user?.id;
  if (!userId || req.agentWallet) return { ok: false, status: 401, error: 'Authentication required' };
  const walletsSnap = await deps.db.collection('wallets')
    .where('user_id', '==', userId)
    .where('type', '==', 'human')
    .limit(10)
    .get();
  if (walletsSnap.empty) return { ok: false, status: 404, error: 'no_human_wallet' };
  const active = walletsSnap.docs.filter((doc) => isActiveHumanWallet(doc.data()));
  if (active.length === 0) return { ok: false, status: 403, error: 'human_wallet_not_active' };
  if (active.length > 1) return { ok: false, status: 409, error: 'human_wallet_ambiguous' };
  const data = active[0].data() as { address: string };
  return {
    ok: true,
    owner: { ownerType: 'human', userId, walletId: active[0].id, ownerEvmAddress: data.address },
  };
}

export function createPersonSolanaAddressRouter(options: PersonSolanaAddressRouterDeps): Router {
  const deps = options.agentBankDeps;
  const router = Router();
  const limit = async (owner: SolanaProofOwner, kind: 'challenge' | 'verify', res: Response): Promise<boolean> => {
    const id = owner.ownerType === 'human' ? owner.userId : owner.agentId;
    const rl = await deps.cache.checkRateLimitStrict(
      `rl:person-sol-addr-${kind}:${id}`,
      kind === 'challenge' ? PERSON_SOLANA_CHALLENGE_LIMIT_PER_HOUR : PERSON_SOLANA_VERIFY_LIMIT_PER_HOUR,
      3600,
    );
    if (rl.error === 'rate_limit_unavailable') {
      res.status(503).json({ error: 'temporarily_unavailable' });
      return false;
    }
    if (!rl.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded.', retry_after: rl.retryAfter });
      return false;
    }
    return true;
  };
  const h = solanaHandlers(deps, (req) => resolvePersonOwner(deps, req), {
    ...options, limit, label: 'person-solana-address', verifyExtra: { owner: 'person' },
  });
  router.post('/solana-address/challenge', options.authenticate, h.challenge);
  router.post('/solana-address/verify', options.authenticate, h.verify);
  router.get('/solana-addresses', options.authenticate, h.list);
  return router;
}
