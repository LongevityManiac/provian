/**
 * — the public x402 seller list.
 *
 * GET /v1/x402/sellers?chain=base|solana&limit=&cursor=
 * Active sellers registered with Provian's x402 facilitator, public fields only
 * (`core/x402/sellers.ts`). A public VIEW: closed pre-flip by `preLaunchSurfaceGate`.
 *
 * Its own module (not beside the facilitator's report route) so each router is mounted, and
 * statically mapped, on exactly one prefix.
 */

import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import {
  X402_SELLERS_MAX_PAGE,
  isX402SellerChain,
  isX402SellerId,
  listActiveX402Sellers,
} from '../core/x402/sellers';

export function createX402SellersRouter(deps: { readonly db: Firestore; readonly cache: Pick<RedisCache, 'checkRateLimit'> }): Router {
  const router = Router();
  router.get('/sellers', async (req: Request, res: Response) => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimit = await deps.cache.checkRateLimit(`rl:x402sellers:${clientIp}`, 60, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }
      const chain = req.query.chain;
      if (chain !== undefined && !isX402SellerChain(chain)) {
        res.status(400).json({ error: 'chain must be base or solana' });
        return;
      }
      const rawLimit = req.query.limit;
      let limit: number | undefined;
      if (rawLimit !== undefined) {
        const n = typeof rawLimit === 'string' && /^[0-9]{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
        if (!Number.isInteger(n) || n < 1 || n > X402_SELLERS_MAX_PAGE) {
          res.status(400).json({ error: `limit must be an integer from 1 to ${X402_SELLERS_MAX_PAGE}` });
          return;
        }
        limit = n;
      }
      const cursor = req.query.cursor;
      if (cursor !== undefined && !isX402SellerId(cursor)) {
        res.status(400).json({ error: 'cursor is invalid' });
        return;
      }
      const page = await listActiveX402Sellers(deps.db, {
        ...(chain !== undefined ? { chain } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(typeof cursor === 'string' ? { cursor } : {}),
      });
      res.json({ sellers: page.sellers, count: page.sellers.length, next_cursor: page.next_cursor });
    } catch (error) {
      console.error('[x402-sellers] list failed:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  return router;
}
