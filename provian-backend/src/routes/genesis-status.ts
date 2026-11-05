/**
 * Genesis economic-progress feedback (next-milestone hook) — read-only, dual-auth.
 *
 * Genesis is identity-agnostic, so this read serves BOTH a human (wallet auth -
 * reading their own wallet or a linked agent's) AND an agent (api-key auth -
 * reading its own wallet). It is a READ-ONLY either-auth wrapper: the wallet-auth
 * and agent-auth WRITE paths are never merged (CLAUDE.md security boundary #2);
 * each credential is checked by its own untouched verifier and fans in to a
 * normalized caller identity, then an ownership gate enforces that a caller can
 * only read a wallet they own (closing the IDOR the original endpoint had).
 *
 * Extracted from server.ts as a router factory so the security logic is unit-
 * testable with supertest (see genesis-status.test.ts).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Firestore } from 'firebase-admin/firestore';

/** Result shape returned by the shared wallet-auth verifier. */
export type WalletAuthVerifyResult =
  | { ok: true; userId: string; deviceId: string }
  | { ok: false; status: number; error: string };

export interface GenesisStatusRouterDeps {
  db: Firestore;
  /** Verify a human wallet-auth token (HMAC, replay-protected). */
  verifyWalletAuthToken: (token: string, req: Request) => Promise<WalletAuthVerifyResult>;
  /** Agent api-key middleware: sets req.agentWallet on success, sends 401/403 on failure. */
  authenticateAgent: (req: Request, res: Response, next: (err?: unknown) => void) => void;
  /** The status reader (injected so the route is testable without Firestore). */
  getGenesisWalletStatus: (db: Firestore, walletId: string) => Promise<unknown>;
}

type GenesisCaller = { kind: 'agent'; walletId: string } | { kind: 'human'; userId: string };
type GenesisCallerRequest = Request & { genesisCaller?: GenesisCaller };

export function createGenesisStatusRouter(deps: GenesisStatusRouterDeps): Router {
  const router = Router();

  async function authenticateGenesisRead(req: GenesisCallerRequest, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const token = authHeader.substring(7);
    // Agent api-key: always prefixed `pvn_live_` (matches the codebase's
    // prefix-based discrimination convention; more robust than '.'-vs-':' shape).
    if (token.startsWith('pvn_live_')) {
      deps.authenticateAgent(req, res, (err?: unknown) => {
        if (err || !req.agentWallet) {
          res.status(401).json({ error: 'Invalid authentication' });
          return;
        }
        req.genesisCaller = { kind: 'agent', walletId: req.agentWallet.id };
        next();
      });
      return;
    }
    // Human wallet auth (base64.hexSignature): contains '.'.
    if (token.includes('.')) {
      const result = await deps.verifyWalletAuthToken(token, req);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      req.genesisCaller = { kind: 'human', userId: result.userId };
      next();
      return;
    }
    res.status(401).json({ error: 'Invalid authentication' });
  }

  /**
   * Ownership gate for a HUMAN caller. A human may read only a wallet they own:
   * their OWN wallet (wallets/{id}, type 'human', matching user_id) OR a linked
   * agent (agent_wallets.linked_human_user_id === user_id). Unknown / unlinked /
   * missing => block (false), and a missing wallet is treated identically so
   * wallet ids cannot be probed for existence.
   */
  async function humanOwnsGenesisWallet(userId: string, walletId: string): Promise<boolean> {
    const w = await deps.db.collection('wallets').doc(walletId).get();
    if (w.exists) {
      const d = w.data() as { type?: string; user_id?: string };
      if (d?.type === 'human' && d?.user_id === userId) return true;
    }
    const a = await deps.db.collection('agent_wallets').doc(walletId).get();
    if (a.exists) {
      const d = a.data() as { linked_human_user_id?: string | null };
      if (d?.linked_human_user_id && d.linked_human_user_id === userId) return true;
    }
    return false;
  }

  router.get('/:walletId', authenticateGenesisRead, async (req: GenesisCallerRequest, res: Response) => {
    try {
      const { walletId } = req.params;
      const caller = req.genesisCaller!;
      if (caller.kind === 'agent') {
        if (caller.walletId !== walletId) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      } else if (!(await humanOwnsGenesisWallet(caller.userId, walletId))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      const status = await deps.getGenesisWalletStatus(deps.db, walletId);
      res.json(status);
    } catch (error) {
      console.error('[Genesis] Status read error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
