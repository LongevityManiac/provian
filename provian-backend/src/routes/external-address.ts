/**
 * External-address proof-of-control routes (Unit 2).
 *
 * SDK/API-first: an agent proves it controls an arbitrary external EVM address
 * by signing a one-time challenge with that address's key. No mobile screen is
 * required - the agent path is fully API-callable, which fits autonomous
 * agent-linking. A human-signed authorization (Case 2) uses the SAME verify
 * endpoint: the signature simply comes from whoever controls the claimed
 * address (EOA key or, for a smart-contract wallet, an EIP-1271 owner), so it
 * can be surfaced wherever the human already signs.
 *
 *   POST /v1/agent/external-address/challenge  { address }
 *     -> { challenge_id, message, nonce, issued_at, expires_at, chain }
 *   POST /v1/agent/external-address/verify      { address, challenge_id, signature }
 *     -> { ok, proven_address, proven_at, proven_at_block, proof_method, pe_id, ... }
 *
 * Both require AGENT auth (Bearer api_key:api_secret). The agent_id is taken
 * from the authenticated wallet, never the body, so an agent can only bind an
 * address to ITSELF.
 */

import { Router, type Request, type Response } from 'express';
import { ethers } from 'ethers';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import {
  issueChallenge,
  proveExternalAddress,
  PROOF_CHAIN,
  PROOF_CHAIN_ID,
} from '../core/external-address';

/** Reasons the prove flow can reject, mapped to HTTP status codes. */
export function proveReasonToStatus(reason: string | undefined): number {
  if (reason === 'address_bound_to_other_agent'
    // 2026-10-01: one address, one owner across agents, people and Provian wallets.
    || reason === 'address_bound_to_other_owner'
    || reason === 'address_is_provian_wallet') return 409;
  // Transient/retryable: the binding may be recorded but a downstream read or
  // the proof-PE emission failed. A re-prove is idempotent (fence preserved).
  if (
    reason === 'head_block_unavailable' ||
    reason === 'baseline_nonce_unavailable' ||
    reason === 'proof_evidence_changed' ||
    reason === 'cache_unavailable' ||
    reason === 'pe_emission_failed'
  ) {
    return 503;
  }
  return 400;
}

export function createExternalAddressRouter(deps: AgentBankDeps): Router {
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(deps.db);

  // POST /challenge - issue a one-time proof challenge for (this agent, address).
  router.post('/challenge', authenticateAgent, async (req: Request, res: Response) => {
    const wallet = req.agentWallet;
    if (!wallet) {
      res.status(401).json({ error: 'Agent authentication required' });
      return;
    }
    const address = typeof req.body?.address === 'string' ? req.body.address : '';
    if (!ethers.isAddress(address)) {
      res.status(400).json({ error: 'address must be a valid EVM address' });
      return;
    }
    try {
      const challenge = await issueChallenge(deps.cache, {
        agentId: wallet.agent_id,
        address,
      });
      res.json({ ...challenge, chain: PROOF_CHAIN, chain_id: PROOF_CHAIN_ID });
    } catch (err) {
      if ((err as Error).message === 'CACHE_UNAVAILABLE') {
        res.status(503).json({ error: 'Challenge store unavailable' });
        return;
      }
      if ((err as Error).message === 'invalid_address') {
        res.status(400).json({ error: 'address must be a valid EVM address' });
        return;
      }
      console.error('[external-address] challenge error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /verify - verify the signature, record the binding, emit the proof PE.
  router.post('/verify', authenticateAgent, async (req: Request, res: Response) => {
    const wallet = req.agentWallet;
    if (!wallet) {
      res.status(401).json({ error: 'Agent authentication required' });
      return;
    }
    const address = typeof req.body?.address === 'string' ? req.body.address : '';
    const challengeId = typeof req.body?.challenge_id === 'string' ? req.body.challenge_id : '';
    const signature = typeof req.body?.signature === 'string' ? req.body.signature : '';
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
    try {
      const result = await proveExternalAddress(deps, {
        agentId: wallet.agent_id,
        agentWalletId: wallet.id,
        address,
        challengeId,
        signature,
      });
      if (!result.ok) {
        res.status(proveReasonToStatus(result.reason)).json({ ok: false, error: result.reason });
        return;
      }
      res.json(result);
    } catch (err) {
      console.error('[external-address] verify error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
