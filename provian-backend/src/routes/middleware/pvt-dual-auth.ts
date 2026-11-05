/**
 * PVT dual authentication — wallet HMAC auth OR agent API key auth.
 *
 * Wallet auth: Bearer base64(payload).hmacSignature (v2, request-bound)
 * → resolves user_id via the shared verifyWalletAuthToken helper
 * Agent auth: Bearer pvn_live_...:pvns_... → resolves agent wallet
 *
 * WHY THIS IS A MODULE. It was a closure inside `createPVTRouter` (the unmounted
 * legacy `routes/pvt.ts`, since deleted with the PE meter migration), which meant
 * the PVT9-era public read surface could only reuse it by copying it. A second
 * copy of an auth path is the "self-referential control" shape names: the
 * two drift, and whichever one the test binds to is the one that stays correct.
 * `GET /v1/pvt/allocation/:wallet_id` is served by ONE of these, from here.
 *
 * This module adds a refusal and resolves an identity. It grants no PVT
 * authority: the caller still has to prove the requested `wallet_id` is its own.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import { createAgentAuthMiddleware } from './agent-auth';
import { verifyWalletAuthToken } from './wallet-auth';

export interface PVTDualAuthDeps {
  db: Firestore;
  cache: RedisCache;
}

// req.pvtAuth is typed globally in src/types/express.d.ts.

export function createPVTDualAuthMiddleware(deps: PVTDualAuthDeps): RequestHandler {
  const { db, cache } = deps;
  const authenticateAgent = createAgentAuthMiddleware(db);

  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
   try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const token = authHeader.substring(7);

    // --- Try wallet HMAC auth first (v2 only; v1 is refused) ---
    const dotIndex = token.lastIndexOf('.');
    if (dotIndex !== -1 && !token.startsWith('pvn_live_')) {
      const result = await verifyWalletAuthToken(token, req, { db, cache });
      if (result.ok) {
        // Resolve wallet address from users collection.
        // NOTE: the users doc stores the on-chain address under `wallet_address`
        // (set at registration / recovery). The legacy `address` field is read
        // as a fallback for any older docs. Reading only `address` left
        // walletAddress empty for every human wallet, which silently forced
        // on_chain_balance to '0' in the allocation endpoint.
        let walletAddress = '';
        const userDoc = await db.collection('users').doc(result.userId).get();
        if (userDoc.exists) {
          const data = userDoc.data()!;
          walletAddress =
            (data.wallet_address as string) || (data.address as string) || '';
        }
        req.pvtAuth = {
          type: 'wallet',
          userId: result.userId,
          walletAddress,
        };
        next();
        return;
      }
      // 400 (malformed) and explicit token_v1_no_longer_supported should
      // surface to the caller rather than silently fall through to the
      // agent-auth path.
      if (result.status === 400) {
        res.status(400).json({ error: result.error });
        return;
      }
      if (result.error === 'token_v1_no_longer_supported') {
        res.status(401).json({ error: result.error });
        return;
      }
      // Otherwise (signature mismatch, expiry, replay, etc.) fall through and
      // try agent auth - the token might have been a malformed-but-not-v2
      // attempt by an SDK using agent credentials.
    }

    // --- Fall back to agent API key auth ---
    // authenticateAgent now wraps its own body in try/catch (F62), so its
    // returned promise no longer rejects; a bad api-key prefix answers 4xx/503
    // rather than crashing.
    authenticateAgent(req, res, () => {
      const agentWallet = req.agentWallet;
      if (agentWallet) {
        req.pvtAuth = {
          type: 'agent',
          userId: agentWallet.id,
          walletAddress: agentWallet.address as string | undefined,
        };
        next();
      } else {
        res.status(401).json({ error: 'Invalid authentication' });
      }
    });
   } catch (err) {
    // F62: fail closed with a 503, never reject uncaught.
    console.error('[PVTDualAuth] middleware error:', err);
    res.status(503).json({ error: 'Authentication service temporarily unavailable' });
   }
  };
}
