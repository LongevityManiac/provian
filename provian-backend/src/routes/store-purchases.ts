/**
 * App-store purchases (the App Store and Google Play builds of the app).
 *
 * GET  /v1/store                     human wallet auth. The account token the app attaches to every
 *                                    purchase, the product ids, and this account's held Settle now
 *                                    purchases.
 * POST /v1/store/purchases           human wallet auth. Body `{ platform: 'app_store' | 'google_play',
 *                                    product_id, signed_transaction? (App Store), purchase_token?
 *                                    (Play), package_name?, payee? }`. The relay verifies the purchase
 *                                    with its store, then grants it once: 200 `credited`, 202 `held`
 *                                    (a Settle now kept for the next settlement), or a refusal with
 *                                    nothing credited. Replaying a purchase credits nothing again.
 * POST /v1/store/settle-now/redeem   human wallet auth. Spend this account's oldest held Settle now
 *                                    on a settlement, if one can run now.
 *
 * There is no test mode and no bypass: a purchase the store did not confirm is refused, and so is
 * any purchase while the store credentials are not configured.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { publicArchiveAccount } from '../core/archive/archive-service';
import {
  heldSettleNowKeys,
  publicStoreTransactionView,
  redeemHeldSettleNow,
  redeemStorePurchase,
  type StorePurchaseDeps,
  type StoreRedeemResult,
} from '../core/store-purchases/store-purchase-service';
import { STORE_PRODUCTS, storeAccountToken } from '../core/store-purchases/store-products';

export interface StorePurchaseRouterDeps {
  readonly db: Firestore;
  /** Wallet auth that sets `req.user = { id, device_id }`. */
  readonly authenticateWallet: RequestHandler;
  readonly storeDeps: () => StorePurchaseDeps;
}

const DENIAL_MESSAGES: Readonly<Record<string, string>> = {
  store_verification_not_configured: 'Store purchases cannot be confirmed right now. Nothing was credited.',
  store_verification_unavailable: 'The store could not be reached to confirm this purchase. Nothing was credited yet; it will be checked again.',
};

function respond(res: Response, result: StoreRedeemResult): void {
  if (result.kind === 'denied') {
    res.status(result.status).json({
      error: result.error,
      credited: false,
      message: DENIAL_MESSAGES[result.error] ?? 'This purchase could not be confirmed with the store. Nothing was credited.',
    });
    return;
  }
  res.status(result.kind === 'credited' ? 200 : 202).json({
    status: result.kind,
    credited: result.kind === 'credited',
    replayed: result.replayed,
    transaction: publicStoreTransactionView(result.transaction),
    ...(result.account !== undefined ? { archive: result.account === null ? null : publicArchiveAccount(result.account) } : {}),
    ...(result.payout !== undefined ? { payout: result.payout } : {}),
  });
}

export function createStorePurchaseRouter(deps: StorePurchaseRouterDeps): Router {
  const router = Router();

  const handle = (fn: (req: Request, res: Response, userId: string) => Promise<void>) =>
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const userId = req.user?.id;
      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      try {
        await fn(req, res, userId);
      } catch (error) {
        console.error('[store-purchase] failed', error instanceof Error ? error.message : error);
        if (!res.headersSent) res.status(500).json({ error: 'store_purchase_failed', credited: false });
      }
    };

  router.get('/v1/store', deps.authenticateWallet, handle(async (_req, res, userId) => {
    const held = await heldSettleNowKeys(deps.db, userId);
    res.json({
      account_token: storeAccountToken(userId),
      products: Object.keys(STORE_PRODUCTS),
      settle_now_held: held.length,
    });
  }));

  router.post('/v1/store/purchases', deps.authenticateWallet, handle(async (req, res, userId) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await redeemStorePurchase(deps.storeDeps(), {
      userId,
      platform: body.platform,
      productId: body.product_id,
      signedTransaction: body.signed_transaction,
      purchaseToken: body.purchase_token,
      packageName: body.package_name,
      payee: body.payee,
    });
    respond(res, result);
  }));

  router.post('/v1/store/settle-now/redeem', deps.authenticateWallet, handle(async (_req, res, userId) => {
    const held = await heldSettleNowKeys(deps.db, userId);
    if (held.length === 0) {
      res.status(404).json({ error: 'no_held_settle_now', credited: false });
      return;
    }
    respond(res, await redeemHeldSettleNow(deps.storeDeps(), held[0]));
  }));

  return router;
}
