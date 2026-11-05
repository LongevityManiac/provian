/**
 * Provisional Wallets - Zero-setup PE submission for agents
 *
 * Allows agents to submit PEs with no pre-existing account. A provisional wallet
 * is created on-the-fly when an agent submits its first PE with AgentKey auth.
 * The former claim-to-wallet conversion is retired; status remains readable.
 *
 * Auth: AgentKey {identifier} - any string identifier chosen by the agent.
 *
 * Endpoints (this router, mounted at /v1/provisional):
 * POST /claim - Terminal retirement response
 * GET /:identifier/status - Public status of a provisional chain
 *
 * PE SUBMISSION IS REMOVED. An unauthenticated
 * agent's own claim about its work, under an identifier it chose, is never a PE.
 * `/v1/pe/submit` itself is now retired (PE meter, 2026-10-03: 410 for every
 * caller, routes/meter-retired-recorders.ts). Provisional chains sealed before
 * are untouched and stay readable via /status.
 */

import { Router, Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RecordPEAccrualParams } from '../pvt-accrual';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvisionalWalletDocument {
  identifier: string;
  created_at: number;
  pe_count: number;
  estimated_pvt: number;
  claimed: boolean;
  claim_token: string;
  owner_user_id: string | null;
  chain_tip_hash: string;
  // #13: durable PE-migration state so a crash/failure between the (one-shot)
  // claim flip and migration completion is re-runnable, not silently stranded.
  // 'pending' = claimed but PEs not yet fully re-keyed (resumable via re-claim);
  // 'complete' = migration finished. Absent on legacy/unclaimed docs.
  migration_status?: 'pending' | 'complete';
  /** Number of PEs actually re-keyed to the owner (set when migration completes). */
  migrated_pe_count?: number;
  /** The agent wallet id minted by the claim (so a resume can reference it). */
  claimed_wallet_id?: string | null;
}

/** Base deps of the provisional router (the device-submit caller that shared them is retired). */
export interface ProvisionalPEDeps {
  db: Firestore;
  cache: {
    checkRateLimit: (key: string, limit: number, windowSeconds: number) => Promise<{ allowed: boolean; retryAfter?: number }>;
  };
  peBuffer: { enqueue: (docId: string, data: object) => void };
  recordPEAccrual: (params: RecordPEAccrualParams) => Promise<void>;
}

/** Full deps for the provisional router (claim + status endpoints) */
export interface ProvisionalRouterDeps extends ProvisionalPEDeps {
  cache: ProvisionalPEDeps['cache'] & {
    get: <T>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown, ttl: number) => Promise<void>;
    del: (key: string) => Promise<void>;
  };
  deriveAddressFromPublicKey: (publicKeyHex: string) => string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max identifier length */
const MAX_IDENTIFIER_LENGTH = 200;

/** Identifier format: alphanumeric, hyphens, underscores, dots, colons */
const IDENTIFIER_REGEX = /^[a-zA-Z0-9._:@-]+$/;

// Firestore collection name
const COLLECTION = 'provisional_wallets';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Provisional Wallet Router (/v1/provisional)
// ---------------------------------------------------------------------------

export function createProvisionalRouter(deps: ProvisionalRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  // =========================================================================
  // POST /claim - Claim a provisional wallet (wallet auth required)
  // =========================================================================
  router.post('/claim', (_req: Request, res: Response) => {
    // The superseded conversion path is deliberately absent: it previously
    // created a partial agent_wallets row. Existing provisional records stay
    // readable, but wallet creation must use the canonical PoP route.
    res.status(410).json({
      error: 'provisional_wallet_claim_retired',
      migration: {
        challenge: 'GET /v1/agent/wallet/challenge?public_key=<public_key>&registration_id=<stable_registration_id>&agent_id=<stable_agent_id>',
        register: 'POST /v1/agent/wallet/create',
        provenance: 'Contact Provian support for a reviewed provenance migration.',
      },
    });
  });
  // =========================================================================
  // GET /:identifier/status - Public chain status (no auth)
  // =========================================================================
  router.get('/:identifier/status', async (req: Request, res: Response) => {
    try {
      const { identifier } = req.params;

      if (!identifier || !IDENTIFIER_REGEX.test(identifier) || identifier.length > MAX_IDENTIFIER_LENGTH) {
        res.status(400).json({ error: 'Invalid identifier' });
        return;
      }

      const doc = await db.collection(COLLECTION).doc(identifier).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'Provisional wallet not found' });
        return;
      }

      const wallet = doc.data() as ProvisionalWalletDocument;
      const chainAgeDays = Math.floor((Date.now() - wallet.created_at) / (1000 * 60 * 60 * 24));

      res.json({
        pe_count: wallet.pe_count,
        estimated_pvt: wallet.estimated_pvt,
        claimed: wallet.claimed,
        chain_age_days: chainAgeDays,
      });
    } catch (error) {
      console.error('[Provisional] Status error:', error);
      res.status(500).json({ error: 'Status lookup failed' });
    }
  });

  return router;
}
