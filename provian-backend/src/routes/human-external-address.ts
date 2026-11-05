/**
 * Human-initiated external-address linking for a linked agent.
 *
 * The linked human can, from the Agent Hub, link a third-party wallet (MetaMask,
 * Coinbase Wallet, Rainbow, a Safe …) to ANY agent linked to them, so that
 * address's go-forward on-chain activity on Base is chain-witnessed work of that
 * agent. The proof itself is unchanged: the challenge is bound to the AGENT's
 * `agent_id` and the address, and the SAME `proveExternalAddress` runs — the
 * operator-agreed H / H-11 / H+1 fence, one-address-one-agent
 * (`proven_addresses`), EIP-191 for an EOA and EIP-1271 for a contract wallet,
 * the record_only `external_address_proven` PE, and no Genesis qualification.
 *
 * POST /v1/agent/wallet/:wallet_id/external-address/challenge { address }
 * POST /v1/agent/wallet/:wallet_id/external-address/verify { address, challenge_id, signature }
 * GET /v1/agent/wallet/:wallet_id/external-addresses
 *
 * Authority. Every route takes the human's request-bound v2 wallet-auth token
 * and requires `agent_wallets.linked_human_user_id === caller` (else 403
 * `not_your_linked_agent`, the same answer for an unknown wallet id) and an
 * active agent. Initiating a proof is the human's to do because the beneficiary
 * relationship is the human's (Security Invariant #2): an agent credential still
 * cannot reach these routes. What binds the address is not the human's say-so —
 * it is the signature of whoever controls that address over the exact
 * server-issued message, verified on-chain state at the proof block.
 *
 * Refusals (409, before any challenge is issued or any proof runs):
 * - `address_is_your_provian_wallet` the human's own Provian wallet address
 * (every `wallets` doc of the caller, plus the agent's recorded
 * `linked_human_address`). The human's Provian wallet is not a third-party
 * wallet, and the app never signs a "Provian proof of control" message with
 * it (walletconnect/provianReserved.ts).
 * - `address_is_agent_native_wallet` the agent's own native address (its
 * wallet `address` and reported `chain_addresses.evm`), which is already
 * chain-witnessed as the agent.
 */

import { Router, type Request, type Response } from 'express';
import { ethers } from 'ethers';
import type { AgentBankDeps } from '../core/agent-bank/types';
import type { AgentWalletDocument } from '../core/agent-wallet/types';
import { verifyWalletAuthToken } from './middleware/wallet-auth';
import {
  issueChallenge,
  proveExternalAddress,
  PROOF_CHAIN,
  PROOF_CHAIN_ID,
  PROVEN_ADDRESSES_COLLECTION,
  type ProofChainDeps,
} from '../core/external-address';
import { isEconomicallyActiveProvenAddress } from '../core/external-address/link';
import { proveReasonToStatus } from './external-address';

/** Per-human transport limits (fail CLOSED on a Redis outage). */
export const HUMAN_EXTERNAL_CHALLENGE_LIMIT_PER_HOUR = 20;
export const HUMAN_EXTERNAL_VERIFY_LIMIT_PER_HOUR = 20;

export interface HumanExternalAddressRouterOptions {
  /** Test seam: the chain reads `proveExternalAddress` uses. Production omits it. */
  proofChainDeps?: ProofChainDeps;
}

type GuardResult =
  | { ok: true; userId: string; agentWallet: AgentWalletDocument }
  | { ok: false; status: number; error: string };

async function authorizeLinkedHuman(
  deps: AgentBankDeps,
  req: Request,
): Promise<GuardResult> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Missing wallet auth token' };
  }
  const authResult = await verifyWalletAuthToken(authHeader.slice(7), req, {
    db: deps.db,
    cache: deps.cache,
  });
  if (!authResult.ok) {
    return { ok: false, status: authResult.status, error: authResult.error };
  }
  const userId = authResult.userId;
  const walletId = String(req.params.wallet_id ?? '');
  if (!walletId) return { ok: false, status: 403, error: 'not_your_linked_agent' };
  const snap = await deps.db.collection('agent_wallets').doc(walletId).get();
  const agentWallet = snap.exists ? (snap.data() as AgentWalletDocument) : null;
  if (!agentWallet
    || agentWallet.id !== walletId
    || typeof agentWallet.linked_human_user_id !== 'string'
    || agentWallet.linked_human_user_id !== userId) {
    return { ok: false, status: 403, error: 'not_your_linked_agent' };
  }
  if (agentWallet.status !== 'active') {
    return { ok: false, status: 409, error: 'agent_not_active' };
  }
  if (typeof agentWallet.agent_id !== 'string' || agentWallet.agent_id.length === 0) {
    return { ok: false, status: 409, error: 'agent_identity_unavailable' };
  }
  return { ok: true, userId, agentWallet };
}

/**
 * The address may not be the human's own Provian wallet or the agent's own
 * native wallet. Compared lowercase; a read failure refuses (unknown = block).
 */
export async function ownAddressRefusal(
  deps: AgentBankDeps,
  userId: string,
  agentWallet: AgentWalletDocument,
  address: string,
): Promise<string | null> {
  const target = address.toLowerCase();
  const agentOwn = [agentWallet.address, agentWallet.chain_addresses?.evm]
    .filter((a): a is string => typeof a === 'string')
    .map((a) => a.toLowerCase());
  if (agentOwn.includes(target)) return 'address_is_agent_native_wallet';

  const humanOwn = new Set<string>();
  if (typeof agentWallet.linked_human_address === 'string') {
    humanOwn.add(agentWallet.linked_human_address.toLowerCase());
  }
  const humanWallets = await deps.db.collection('wallets').where('user_id', '==', userId).get();
  for (const doc of humanWallets.docs) {
    const data = doc.data() as { address?: unknown };
    if (typeof data.address === 'string') humanOwn.add(data.address.toLowerCase());
  }
  if (humanOwn.has(target)) return 'address_is_your_provian_wallet';
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

export function createHumanExternalAddressRouter(
  deps: AgentBankDeps,
  options: HumanExternalAddressRouterOptions = {},
): Router {
  const router = Router();

  // POST /:wallet_id/external-address/challenge — issue the one-time proof
  // challenge, bound to the AGENT's agent_id and the address.
  router.post('/:wallet_id/external-address/challenge', async (req: Request, res: Response) => {
    try {
      const guard = await authorizeLinkedHuman(deps, req);
      if (!guard.ok) {
        res.status(guard.status).json({ error: guard.error });
        return;
      }
      const address = typeof req.body?.address === 'string' ? req.body.address : '';
      if (!ethers.isAddress(address)) {
        res.status(400).json({ error: 'address must be a valid EVM address' });
        return;
      }
      const refusal = await ownAddressRefusal(deps, guard.userId, guard.agentWallet, address);
      if (refusal) {
        res.status(409).json({ error: refusal });
        return;
      }
      if (!await strictLimit(
        deps,
        `rl:human-ext-addr-challenge:${guard.userId}`,
        HUMAN_EXTERNAL_CHALLENGE_LIMIT_PER_HOUR,
        res,
      )) return;
      const challenge = await issueChallenge(deps.cache, {
        agentId: guard.agentWallet.agent_id,
        address,
      });
      res.json({
        ...challenge,
        address: address.toLowerCase(),
        wallet_id: guard.agentWallet.id,
        chain: PROOF_CHAIN,
        chain_id: PROOF_CHAIN_ID,
      });
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'CACHE_UNAVAILABLE') {
        res.status(503).json({ error: 'Challenge store unavailable' });
        return;
      }
      if (message === 'invalid_address' || message === 'EXTERNAL_PROOF_CHALLENGE_INPUT_INVALID') {
        res.status(400).json({ error: 'address must be a valid EVM address' });
        return;
      }
      console.error('[human-external-address] challenge error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /:wallet_id/external-address/verify — verify the third-party wallet's
  // signature over the exact message; verify IS the link.
  router.post('/:wallet_id/external-address/verify', async (req: Request, res: Response) => {
    try {
      const guard = await authorizeLinkedHuman(deps, req);
      if (!guard.ok) {
        res.status(guard.status).json({ error: guard.error });
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
      const refusal = await ownAddressRefusal(deps, guard.userId, guard.agentWallet, address);
      if (refusal) {
        res.status(409).json({ error: refusal });
        return;
      }
      if (!await strictLimit(
        deps,
        `rl:human-ext-addr-verify:${guard.userId}`,
        HUMAN_EXTERNAL_VERIFY_LIMIT_PER_HOUR,
        res,
      )) return;
      const result = await proveExternalAddress(
        deps,
        {
          agentId: guard.agentWallet.agent_id,
          agentWalletId: guard.agentWallet.id,
          address,
          challengeId,
          signature,
        },
        ...(options.proofChainDeps ? [options.proofChainDeps] : []),
      );
      if (!result.ok) {
        res.status(proveReasonToStatus(result.reason)).json({ ok: false, error: result.reason });
        return;
      }
      res.json({ ...result, wallet_id: guard.agentWallet.id, initiated_by: 'linked_human' });
    } catch (err) {
      console.error('[human-external-address] verify error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /:wallet_id/external-addresses — the linked addresses the human sees.
  router.get('/:wallet_id/external-addresses', async (req: Request, res: Response) => {
    try {
      const guard = await authorizeLinkedHuman(deps, req);
      if (!guard.ok) {
        res.status(guard.status).json({ error: guard.error });
        return;
      }
      const snap = await deps.db
        .collection(PROVEN_ADDRESSES_COLLECTION)
        .where('agent_id', '==', guard.agentWallet.agent_id)
        .get();
      const addresses = snap.docs
        .filter((doc) => isEconomicallyActiveProvenAddress(doc.data(), doc.id))
        .map((doc) => {
          const d = doc.data() as {
            address: string; proven_at_ms: number; proven_at_block: number; proof_method: string; chain: string;
          };
          return {
            address: d.address,
            proven_at: d.proven_at_ms,
            proven_at_block: d.proven_at_block,
            proof_method: d.proof_method,
            chain: d.chain,
          };
        })
        .sort((a, b) => b.proven_at - a.proven_at);
      res.json({ wallet_id: guard.agentWallet.id, addresses });
    } catch (err) {
      console.error('[human-external-address] list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
