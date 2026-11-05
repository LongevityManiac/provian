/**
 * Wallet-owner auth middleware for witness-connector routes.
 *
 * Extracted from routes/witnesses-github.ts (the phone-initiated GitHub
 * connect variants) so the GitLab / Bitbucket install-registration wallet
 * variants and the cross-provider installs router share ONE resolution of
 * "wallet auth token → wallets-collection doc id" instead of three copies.
 *
 * The connect/install user id space is owner_wallet_id (the wallets
 * collection doc id) - that is what the DeviceKey path uses
 * (device.owner_wallet_id) and what service_installs / webhook PE
 * attribution key on. Wallet auth tokens carry the users-collection id,
 * so after HMAC verification we resolve the wallet doc id the same way
 * device registration does (routes/devices.ts). This keeps phone- and
 * CLI-initiated installs in one id space - and keeps wallet auth and
 * agent session auth strictly separate (no dual-auth here).
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyWalletAuthToken, type WalletAuthDeps } from './wallet-auth';

/**
 * Factory: returns middleware that verifies the request-bound wallet auth
 * token, resolves the caller's wallets-collection doc id, and attaches it
 * as `req.walletOwnerId`. 401 on missing/invalid token, 409 wallet_required
 * when the authenticated user has no wallet row (installs must attribute
 * to a wallet id).
 */
export function createWalletOwnerAuthMiddleware(deps: WalletAuthDeps): RequestHandler {
  return async function authenticateWalletOwner(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
   try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }
    const token = authHeader.substring(7);
    const result = await verifyWalletAuthToken(token, req, deps);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const walletsQuery = await deps.db
      .collection('wallets')
      .where('user_id', '==', result.userId)
      .limit(1)
      .get();
    if (walletsQuery.empty) {
      // No wallet yet - installs/connect sessions must attribute to a wallet id.
      res.status(409).json({ error: 'wallet_required' });
      return;
    }
    req.walletOwnerId = walletsQuery.docs[0].id;
    next();
   } catch (err) {
    // F62: an extracted auth middleware answers 4xx/503 rather than rejecting.
    // The `sub` charset guard in verifyWalletAuthToken already prevents the
    // `.doc()` crash; this is defense-in-depth for any transient error.
    console.error('[WalletOwnerAuth] middleware error:', err);
    res.status(503).json({ error: 'Authentication service temporarily unavailable' });
   }
  };
}
