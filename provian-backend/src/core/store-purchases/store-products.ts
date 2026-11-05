/**
 * The two things the store builds sell, and the rule every verified purchase must pass before it
 * credits a wallet.
 *
 * The App Store and Google Play builds sell the PE Archive (1 GB) and Settle now as consumable
 * in-app purchases. Each grants exactly what the USDC payment grants: one more GB of Archive
 * space, or one on-demand settlement of the buyer's ready earnings. The website APK has no store
 * billing and keeps the USDC payment; both paths deliver the same thing.
 *
 * A purchase is credited only when its store confirmed it to the relay. Unknown or unverifiable is
 * a denial, never a credit.
 */
import { createHash } from 'crypto';

export const STORE_APP_ID = 'com.provian.wallet';

/** One document per store transaction, ever: the purchase record and its replay guard. */
export const STORE_TRANSACTIONS_COLLECTION = 'store_transactions_v1';

export type StoreProductKind = 'archive_gb' | 'settle_now';

/** Product id → what it grants. The same ids on both stores. */
export const STORE_PRODUCTS: Readonly<Record<string, StoreProductKind>> = Object.freeze({
  'com.provian.wallet.archive_1gb': 'archive_gb',
  'com.provian.wallet.settle_now': 'settle_now',
});

export function storeProductKind(productId: unknown): StoreProductKind | null {
  return typeof productId === 'string' && Object.prototype.hasOwnProperty.call(STORE_PRODUCTS, productId)
    ? STORE_PRODUCTS[productId]
    : null;
}

export type StorePlatform = 'app_store' | 'google_play';

/** What a store said about one purchase, after the relay verified the store's answer. */
export interface VerifiedStorePurchase {
  readonly platform: StorePlatform;
  /** Apple's transactionId, or Google's orderId (or a token digest when Play gives none). */
  readonly transactionId: string;
  readonly productId: string;
  /** Bundle id (App Store) or package name (Play) the store says the purchase belongs to. */
  readonly appId: string;
  readonly environment: 'production' | 'sandbox';
  /** The account token the app attached at purchase (appAccountToken / obfuscatedAccountId). */
  readonly accountToken: string | null;
  readonly state: 'purchased' | 'pending' | 'cancelled' | 'refunded';
  readonly quantity: number;
}

/**
 * The account token the app attaches to a purchase: a UUID derived from the buyer's relay user id,
 * so a purchase can only ever be redeemed by the account that made it. App Store requires a UUID
 * (appAccountToken); Play accepts the same string (obfuscatedAccountId, at most 64 characters).
 */
export function storeAccountToken(userId: string): string {
  const h = createHash('sha256').update(`provian.store-account.v1|${userId}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The id a purchase is recorded under: one store transaction, one record, ever. */
export function storeTransactionKey(platform: StorePlatform, transactionId: string): string {
  return `st_${createHash('sha256').update(`provian.store-tx.v1|${platform}|${transactionId}`, 'utf8').digest('hex').slice(0, 40)}`;
}

export type StoreAdmission =
  | { readonly ok: true; readonly kind: StoreProductKind }
  | { readonly ok: false; readonly error: string };

/**
 * Whether a verified purchase may credit `userId` for `requestedProductId`. Every condition is
 * required; there is no override.
 */
export function admitVerifiedPurchase(
  purchase: VerifiedStorePurchase,
  expected: { readonly requestedProductId: string; readonly userId: string; readonly acceptSandbox: boolean },
): StoreAdmission {
  const kind = storeProductKind(purchase.productId);
  if (kind === null) return { ok: false, error: 'store_product_unknown' };
  if (purchase.productId !== expected.requestedProductId) return { ok: false, error: 'store_wrong_product' };
  if (purchase.appId !== STORE_APP_ID) return { ok: false, error: 'store_wrong_app' };
  if (purchase.environment !== 'production' && !(purchase.environment === 'sandbox' && expected.acceptSandbox)) {
    return { ok: false, error: 'store_sandbox_purchase_refused' };
  }
  if (purchase.accountToken !== storeAccountToken(expected.userId)) return { ok: false, error: 'store_purchase_other_account' };
  if (purchase.state !== 'purchased') return { ok: false, error: `store_purchase_${purchase.state}` };
  if (purchase.quantity !== 1) return { ok: false, error: 'store_quantity_refused' };
  return { ok: true, kind };
}
