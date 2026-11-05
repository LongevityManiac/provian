/**
 * A PERSON proves a wallet they already hold (carried
 * 2026-10-01). The person's counterpart of `routes/external-address.ts` (an
 * agent proving its own outside wallet) and `routes/human-external-address.ts`
 * (a person linking a wallet TO their agent).
 *
 * POST /v1/wallet/external-address/challenge { address }
 * POST /v1/wallet/external-address/verify { address, challenge_id, signature }
 * GET /v1/wallet/external-addresses
 *
 * Authority: the person's request-bound wallet-auth token (`req.user`), never an
 * agent credential. The binding is the person's own: the challenge names
 * `person:<user_id>`, and what binds the address is the signature of whoever
 * controls it, verified against chain state at the proof block (EIP-191 / EIP-1271).
 *
 * The proof pays nothing (a record_only receipt on the person's chain); only the
 * address's activity from the H+1 fence forward can ever count, and it counts as
 * the person's own (every watcher reads `human_proven_addresses`). One address,
 * one owner: a Provian wallet's address (`address_is_provian_wallet`) and an
 * address an agent or another person proved (`address_bound_to_other_owner`) are
 * refused with 409, both before a challenge is issued and inside the binding
 * transaction.
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { ethers } from 'ethers';
import type { AgentBankDeps } from '../core/agent-bank/types';
import {
  issuePersonChallenge,
  provePersonExternalAddress,
  PROOF_CHAIN,
  PROOF_CHAIN_ID,
  type ProofChainDeps,
} from '../core/external-address';
import { PROVEN_ADDRESSES_COLLECTION } from '../core/external-address/link';
import {
  HUMAN_PROVEN_ADDRESSES_COLLECTION,
  listHumanProvenAddressesForUser,
} from '../core/external-address/human-link';
import {
  AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
} from '../core/pvt/native-wallet-registration';
import { isActiveHumanWallet } from '../core/wallet/active-human-wallet';
import { proveReasonToStatus } from './external-address';

export const PERSON_EXTERNAL_CHALLENGE_LIMIT_PER_HOUR = 20;
export const PERSON_EXTERNAL_VERIFY_LIMIT_PER_HOUR = 20;

export interface PersonExternalAddressRouterDeps {
  readonly agentBankDeps: AgentBankDeps;
  readonly authenticate: RequestHandler;
  /** Test seam: the chain reads the proof uses. Production omits it. */
  readonly proofChainDeps?: ProofChainDeps;
}

type PersonGuard =
  | { ok: true; userId: string; walletId: string }
  | { ok: false; status: number; error: string };

/** The caller's OWN single active human wallet: exactly one, or the request is refused. */
async function resolvePerson(deps: AgentBankDeps, req: Request): Promise<PersonGuard> {
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
  return { ok: true, userId, walletId: active[0].id };
}

/**
 * Early refusal (the binding transaction refuses again, authoritatively): any
 * Provian wallet's own address (or one an agent rotated away from), or an address already proven by an agent or by
 * another person. The person's own existing binding is not refused (idempotent).
 */
export async function personAddressRefusal(
  deps: AgentBankDeps,
  userId: string,
  address: string,
): Promise<string | null> {
  const target = address.toLowerCase();
  const [native, retired, agentProven, personProven] = await Promise.all([
    deps.db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(nativeWalletAddressIndexId(target)).get(),
    deps.db.collection(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION).doc(target).get(),
    deps.db.collection(PROVEN_ADDRESSES_COLLECTION).doc(target).get(),
    deps.db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(target).get(),
  ]);
  if (native.exists || retired.exists) return 'address_is_provian_wallet';
  if (agentProven.exists) return 'address_bound_to_other_owner';
  if (personProven.exists && (personProven.data() as { user_id?: unknown }).user_id !== userId) {
    return 'address_bound_to_other_owner';
  }
  return null;
}

async function strictLimit(
  deps: AgentBankDeps,
  key: string,
  limit: number,
  res: Response,
): Promise<boolean> {
  const rl = await deps.cache.checkRateLimitStrict(key, limit, 3600);
  if (rl.error === 'rate_limit_unavailable') {
    res.status(503).json({ error: 'temporarily_unavailable' });
    return false;
  }
  if (!rl.allowed) {
    res.status(429).json({ error: 'Rate limit exceeded.', retry_after: rl.retryAfter });
    return false;
  }
  return true;
}

export const personProofReasonToStatus = proveReasonToStatus;

export function createPersonExternalAddressRouter(options: PersonExternalAddressRouterDeps): Router {
  const deps = options.agentBankDeps;
  const router = Router();

  router.post('/external-address/challenge', options.authenticate, async (req: Request, res: Response) => {
    try {
      const person = await resolvePerson(deps, req);
      if (!person.ok) {
        res.status(person.status).json({ error: person.error });
        return;
      }
      const address = typeof req.body?.address === 'string' ? req.body.address : '';
      if (!ethers.isAddress(address)) {
        res.status(400).json({ error: 'address must be a valid EVM address' });
        return;
      }
      const refusal = await personAddressRefusal(deps, person.userId, address);
      if (refusal) {
        res.status(409).json({ error: refusal });
        return;
      }
      if (!await strictLimit(deps, `rl:person-ext-addr-challenge:${person.userId}`,
        PERSON_EXTERNAL_CHALLENGE_LIMIT_PER_HOUR, res)) return;
      const challenge = await issuePersonChallenge(deps.cache, { userId: person.userId, address });
      res.json({
        ...challenge,
        address: address.toLowerCase(),
        chain: PROOF_CHAIN,
        chain_id: PROOF_CHAIN_ID,
      });
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'CACHE_UNAVAILABLE') {
        res.status(503).json({ error: 'cache_unavailable' });
        return;
      }
      if (message === 'invalid_address' || message === 'EXTERNAL_PROOF_CHALLENGE_INPUT_INVALID') {
        res.status(400).json({ error: 'address must be a valid EVM address' });
        return;
      }
      console.error('[person-external-address] challenge error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/external-address/verify', options.authenticate, async (req: Request, res: Response) => {
    try {
      const person = await resolvePerson(deps, req);
      if (!person.ok) {
        res.status(person.status).json({ error: person.error });
        return;
      }
      const address = typeof req.body?.address === 'string' ? req.body.address : '';
      const challengeId = typeof req.body?.challenge_id === 'string' ? req.body.challenge_id : '';
      const signature = typeof req.body?.signature === 'string' ? req.body.signature.trim() : '';
      if (!ethers.isAddress(address)) {
        res.status(400).json({ error: 'address must be a valid EVM address' });
        return;
      }
      if (!challengeId) {
        res.status(400).json({ error: 'challenge_id is required' });
        return;
      }
      if (!signature) {
        res.status(400).json({ error: 'signature is required' });
        return;
      }
      const refusal = await personAddressRefusal(deps, person.userId, address);
      if (refusal) {
        res.status(409).json({ error: refusal });
        return;
      }
      if (!await strictLimit(deps, `rl:person-ext-addr-verify:${person.userId}`,
        PERSON_EXTERNAL_VERIFY_LIMIT_PER_HOUR, res)) return;
      const result = await provePersonExternalAddress(
        deps,
        { userId: person.userId, humanWalletId: person.walletId, address, challengeId, signature },
        ...(options.proofChainDeps ? [options.proofChainDeps] : []),
      );
      if (!result.ok) {
        res.status(personProofReasonToStatus(result.reason)).json({ ok: false, error: result.reason });
        return;
      }
      res.json({ ...result, owner: 'person' });
    } catch (err) {
      console.error('[person-external-address] verify error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/external-addresses', options.authenticate, async (req: Request, res: Response) => {
    try {
      const person = await resolvePerson(deps, req);
      if (!person.ok) {
        res.status(person.status).json({ error: person.error });
        return;
      }
      const records = await listHumanProvenAddressesForUser(deps.db, person.userId);
      const addresses = records
        .map((r) => ({
          address: r.address,
          proven_at: r.proven_at_ms,
          proven_at_block: r.proven_at_block,
          proof_method: r.proof_method,
          chain: r.chain,
        }))
        .sort((a, b) => b.proven_at - a.proven_at);
      res.json({ addresses });
    } catch (err) {
      console.error('[person-external-address] list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
