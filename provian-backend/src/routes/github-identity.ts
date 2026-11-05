import { Router, type Request } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { GitHubIdentityError, pollGitHubIdentity, startGitHubIdentity } from '../core/witnesses/github-identity-link';
import type { PresentRateLimiter } from './present';

/** Mount behind the existing dual wallet-owner/agent-API authentication. */
export function createGitHubIdentityRouter(db: Firestore, cache: PresentRateLimiter): Router {
  const router = Router();
  const wallet = async (req: Request): Promise<string | null> => {
    if (req.agentWallet?.id) return req.agentWallet.id;
    if (!req.user?.id) return null;
    const found = await db.collection('wallets').where('user_id', '==', req.user.id).limit(1).get();
    return found.docs[0]?.id ?? null;
  };
  router.post('/:action', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const walletId = await wallet(req);
      if (!walletId) { res.status(403).json({ error: 'wallet_owner_required' }); return; }
      const limit = await cache.checkRateLimit(`github-identity:${walletId}:${req.params.action}`, req.params.action === 'start' ? 5 : 30, 60);
      if (!limit.allowed) { res.status(429).json({ error: 'rate_limited' }); return; }
      if (req.params.action === 'start') res.json(await startGitHubIdentity({ db }, walletId));
      else if (req.params.action === 'poll') res.json(await pollGitHubIdentity({ db }, walletId, typeof req.body?.state === 'string' ? req.body.state : ''));
      else res.status(404).json({ error: 'not_found' });
    } catch (error) {
      res.status(error instanceof GitHubIdentityError ? error.status : 503).json({ error: error instanceof GitHubIdentityError ? error.message : 'identity_link_unavailable' });
    }
  });
  return router;
}
