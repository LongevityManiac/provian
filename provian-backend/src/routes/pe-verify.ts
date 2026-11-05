/**
 * PE Verification API Routes — the third-party trust-layer reads.
 *
 * MOUNTED AS OF C-1, and mounted HONESTLY.
 *
 * What is true today, measured rather than assumed:
 *
 * - THE ANCHOR RUNTIME IS RESTORED (B10, the design requires ARM; recipe per
 *). This router receives a READ-ONLY PEAnchor contract (provider-only, no key).
 * - `POST /verify` answers REAL on-chain inclusion proofs. When the env is unconfigured the
 * contract is null and the route fails closed with its self-citing 503 — never a fabricated
 * verdict.
 * - PE METER : the relay no longer stores PEs. `GET /export/:wallet_id`
 * and `GET /:pe_id/proof` answer 410 `pe_kept_by_owner` the chain lives in the owner's local PE
 * store, and a metered act is proven from its batch's anchored inclusion proof, which the
 * device fetches from `GET /v1/meter/proofs` and keeps with its PEs.
 *
 * READ-ONLY. No handler writes. `/export` is agent-authenticated and ownership-guarded to the
 * caller's own chain; the two public handlers carry `publicDiscoveryGate()` so they 404 until the
 * launch flip, exactly like every other unauthenticated surface.
 */

import { Router, type Request, type Response } from 'express';
import { ethers } from 'ethers';
import { type AgentBankDeps } from '../core/agent-bank/types';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import { publicDiscoveryGate } from './middleware/public-launch-gate';
import { hashEnvelopeHashLeaf } from '../core/pvt/merkle';
import { sendPeKeptByOwner } from '../core/meter/owner-reads';

// =============================================================================
// TYPES
// =============================================================================

export interface PEVerifyRouterDeps extends AgentBankDeps {
  /**
   * NULL only when the anchor env is unconfigured (fail-closed fallback); B10 configured the deployed PEAnchor, so production supplies a real read-only contract.
   * Typed nullable on purpose: the alternative is constructing a contract
   * against a legacy address, which would contradict the anchor quarantine and
   * make `POST /verify` return a verdict about a chain nothing writes to.
   */
  peAnchorContract: ethers.Contract | null;
}

/** Where a metered act's inclusion proof lives (device auth, by batch sequence). */
export const METER_PROOFS_PATH = 'GET /v1/meter/proofs';

/** Stable, self-citing refusal — the same shape the anchor schedulers serve. */
const ANCHOR_RUNTIME_UNCONFIGURED = Object.freeze({
  error: 'anchor_runtime_unconfigured',
  code: 'PVT9_UNCONFIGURED',
  message:
    'No PE anchor runtime is configured, so no PE is anchored on-chain and there is nothing to '
    + 'verify against. PEs and their hash chains remain with their owners; a device fetches its '
    + 'batches\' anchoring state from GET /v1/meter/proofs.',
});

// =============================================================================
// ERROR HANDLER
// =============================================================================

function handleError(res: Response, error: unknown): void {
  console.error('[PEVerify] Error:', error);
  res.status(500).json({ error: 'Internal server error' });
}

// =============================================================================
// ROUTER FACTORY
// =============================================================================

export function createPEVerifyRouter(deps: PEVerifyRouterDeps): Router {
  const { db } = deps;
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(db);

  // -------------------------------------------------------------------------
  // POST /verify - Verify PE against on-chain Merkle root (public)
  // -------------------------------------------------------------------------
  router.post('/verify', publicDiscoveryGate(), async (req: Request, res: Response) => {
    try {
      // FAIL CLOSED, FIRST. Without an anchor contract there is no root to
      // check a proof against; answering anything else would be inventing a
      // verdict. Checked before argument validation so the refusal is
      // attributed to the missing runtime, not to the caller's payload.
      if (deps.peAnchorContract === null) {
        res.status(503).json(ANCHOR_RUNTIME_UNCONFIGURED);
        return;
      }
      const { batch_id, envelope_hash, pe_hash, merkle_proof } = req.body;

      if (!batch_id || !envelope_hash || !merkle_proof) {
        res.status(400).json({ error: 'batch_id, envelope_hash, and merkle_proof are required' });
        return;
      }

      if (!Array.isArray(merkle_proof)) {
        res.status(400).json({ error: 'merkle_proof must be an array of bytes32 hashes' });
        return;
      }

      // The relay derives the leaf itself. On-chain verifyPE takes an
      // already-hashed leaf and never checks the 0x00 leaf-domain tag, so a
      // caller-supplied leaf would let an internal node (or the root with an
      // empty proof) verify as "valid". Same rule as the presentation path.
      let leaf: string;
      try {
        leaf = hashEnvelopeHashLeaf(String(envelope_hash));
      } catch {
        res.status(400).json({ error: 'envelope_hash must be a 32-byte hex hash' });
        return;
      }
      if (pe_hash !== undefined && String(pe_hash).toLowerCase() !== leaf.toLowerCase()) {
        res.status(400).json({ error: 'pe_hash does not match the leaf derived from envelope_hash' });
        return;
      }

      // Verify on-chain
      const isValid = await deps.peAnchorContract.verifyPE(batch_id, leaf, merkle_proof);

      // Get batch details
      const batch = await deps.peAnchorContract.getBatch(batch_id);

      res.json({
        valid: isValid,
        batch_id,
        pe_hash,
        batch_details: batch[4] // exists field
          ? {
              merkle_root: batch[0],
              pe_count: Number(batch[1]),
              timestamp: Number(batch[2]),
              epoch_number: Number(batch[3]),
            }
          : null,
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // -------------------------------------------------------------------------
  // GET /export/:wallet_id - the agent's PE chain (auth required)
  //
  // PE METER : the relay no longer stores PEs, so it has no chain to
  // export. The agent's SDK/daemon holds every PE it wrote (with each PE's `prev_hash` link), and
  // its batches' inclusion proofs come from `GET /v1/meter/proofs`. Ownership-guarded exactly as
  // before, so another wallet learns nothing.
  // -------------------------------------------------------------------------
  router.get('/export/:wallet_id', authenticateAgent, (req: Request, res: Response) => {
    const walletId = req.agentWallet?.id;
    const { wallet_id } = req.params;
    if (!walletId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (walletId !== wallet_id) {
      res.status(403).json({ error: 'Can only export own PE chain' });
      return;
    }
    sendPeKeptByOwner(res, { wallet_id, proofs: METER_PROOFS_PATH });
  });

  // -------------------------------------------------------------------------
  // GET /:pe_id/proof - (public)
  //
  // PE METER: a metered act is proven from its BATCH. The relay anchors each day's accepted
  // batches; the device fetches each batch's inclusion proof (`GET /v1/meter/proofs`, device
  // auth, by batch sequence) and keeps it with its PEs, so anyone holding the PE, its path to the
  // batch's `acts_root`, and that proof can verify it against Base with zero trust in Provian (a
  // PE-fact presentation embeds exactly that — `core/meter/meter-fact-proof.ts`). The relay keeps
  // no per-PE record to resolve a pe id against, and pre-meter rows are retired by the migration,
  // so this names where the proof lives instead of serving one. Registered LAST so the
  // parametric path never shadows /verify or /export.
  // -------------------------------------------------------------------------
  router.get('/:pe_id/proof', publicDiscoveryGate(), (req: Request, res: Response) => {
    sendPeKeptByOwner(res, {
      pe_id: req.params.pe_id,
      proofs: METER_PROOFS_PATH,
      proof_model: 'batch_inclusion',
      anchor_runtime_configured: deps.peAnchorContract !== null,
    });
  });

  return router;
}
