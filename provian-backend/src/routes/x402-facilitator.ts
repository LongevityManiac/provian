/**
 * — the facilitator's report route (the public seller list is `x402-sellers.ts`).
 *
 * POST /v1/internal/x402/facilitator-settlement (facilitator → relay, shared secret)
 * The facilitator reports a settlement it landed: `{ chain, tx_hash, buyer, seller, asset,
 * amount, fee, scheme }`. That is a POINTER: the relay re-reads the transaction on chain and
 * seals the buyer's `x402_payment` and the seller's `receive` (Provian identities only) through
 * the facilitator lane (`core/pvt/x402-facilitator-lane.ts`). Answers:
 * 200 { status: 'recorded', acts } verified; acts sealed (or why a party got none)
 * 202 { status: 'pending', reason } not final yet — kept and retried by the relay itself
 * 400 { error: 'invalid_settlement', reason } malformed / disallowed pointer
 * 401 / 503 wrong secret / secret or settler not configured
 * 409 { error: 'settlement_conflict' } the same transaction was recorded with other terms
 * 422 { error: 'settlement_not_verified', reason } the chain does not show this settlement
 */

import { Router, type Request, type Response } from 'express';
import { verifyFacilitatorRelaySecret } from './middleware/facilitator-relay-auth';
import { parseFacilitatorSettlementBody } from '../core/pvt/x402-facilitator-settlement';
import { submitFacilitatorSettlement, type FacilitatorLaneDeps } from '../core/pvt/x402-facilitator-lane';

export function createFacilitatorSettlementRouter(deps: {
  /** Built per request so the lane reads the current env (secret, settler). */
  readonly laneDeps: () => FacilitatorLaneDeps;
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
}): Router {
  const router = Router();
  router.post('/facilitator-settlement', async (req: Request, res: Response) => {
    const auth = verifyFacilitatorRelaySecret(req.headers.authorization, deps.env ?? process.env);
    if (auth === 'unconfigured') {
      res.status(503).json({ error: 'facilitator_relay_secret_not_configured' });
      return;
    }
    if (auth !== 'ok') {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const parsed = parseFacilitatorSettlementBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: 'invalid_settlement', reason: parsed.reason });
      return;
    }
    try {
      const outcome = await submitFacilitatorSettlement(deps.laneDeps(), parsed.claim);
      switch (outcome.status) {
        case 'recorded':
          res.status(200).json({ status: 'recorded', chain: parsed.claim.chain, tx_hash: parsed.claim.txHash, acts: outcome.acts });
          return;
        case 'pending':
          res.status(202).json({ status: 'pending', reason: outcome.reason });
          return;
        case 'refused':
          res.status(422).json({ error: 'settlement_not_verified', reason: outcome.reason });
          return;
        case 'conflict':
          res.status(409).json({ error: 'settlement_conflict', reason: outcome.reason });
          return;
        case 'unavailable':
          res.status(503).json({ error: 'facilitator_lane_unavailable', reason: outcome.reason });
          return;
      }
    } catch (error) {
      console.error('[x402-facilitator] settlement report failed:', error);
      res.status(500).json({ error: 'internal_error' });
    }
  });
  return router;
}
