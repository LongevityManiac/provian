/**
 * Ask the store about a purchase, and turn its answer into a `VerifiedStorePurchase`.
 *
 * App Store: the app sends the signed transaction StoreKit gave it. The relay first verifies that
 * JWS against Apple Root CA - G3 (so a forged JWS, or a StoreKit configuration file's local
 * transaction, is refused with no credentials needed), then asks the App Store Server API for that
 * transaction id and reads the purchase from Apple's own signed answer.
 *
 * Google Play: the app sends the purchase token. The relay asks the Google Play Developer API about
 * that token, for this app's package and the product the app names, with the relay's service
 * account.
 *
 * Both stores' credentials come from relay config. With no credentials there is no answer, and
 * no answer is a denial. Hosts are fixed; nothing a client sends chooses where the relay connects.
 */
import { createHash, createPrivateKey, sign as signBytes } from 'crypto';
import { AppleJwsError, verifyAppleSignedJws } from './apple-jws';
import { STORE_APP_ID, type VerifiedStorePurchase } from './store-products';

export class StoreVerifyError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

/** A minimal fetch: the relay passes the global one, tests pass a scripted one. */
export type StoreFetch = (url: string, init: {
  readonly method: 'GET' | 'POST';
  readonly headers: Record<string, string>;
  readonly body?: string;
}) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

// ─── App Store ───────────────────────────────────────────────────────────────

export interface AppStoreCredentials {
  readonly issuerId: string;
  readonly keyId: string;
  /** The App Store Connect API key (.p8, PKCS#8 PEM). */
  readonly privateKeyPem: string;
}

const APP_STORE_HOSTS = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
} as const;

function appStoreJwt(creds: AppStoreCredentials, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
  const head = enc({ alg: 'ES256', kid: creds.keyId, typ: 'JWT' });
  const body = enc({ iss: creds.issuerId, iat, exp: iat + 600, aud: 'appstoreconnect-v1', bid: STORE_APP_ID });
  const sig = signBytes('sha256', Buffer.from(`${head}.${body}`, 'utf8'), {
    key: createPrivateKey(creds.privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

function appleEnvironment(value: unknown): 'production' | 'sandbox' {
  if (value === 'Production') return 'production';
  if (value === 'Sandbox') return 'sandbox';
  // Xcode / LocalTesting transactions are never App Store purchases.
  throw new StoreVerifyError('store_receipt_unverified', 402);
}

function fromAppleTransaction(t: Record<string, unknown>): VerifiedStorePurchase {
  const transactionId = typeof t.transactionId === 'string' ? t.transactionId : '';
  if (!/^[0-9]{1,32}$/.test(transactionId)) throw new StoreVerifyError('store_receipt_unverified', 402);
  const token = typeof t.appAccountToken === 'string' ? t.appAccountToken.toLowerCase() : null;
  const quantity = typeof t.quantity === 'number' ? t.quantity : 1;
  return {
    platform: 'app_store',
    transactionId,
    productId: typeof t.productId === 'string' ? t.productId : '',
    appId: typeof t.bundleId === 'string' ? t.bundleId : '',
    environment: appleEnvironment(t.environment),
    accountToken: token,
    state: t.revocationDate !== undefined && t.revocationDate !== null ? 'refunded' : 'purchased',
    quantity,
  };
}

/**
 * The App Store's answer about the transaction a client's signed JWS names. `acceptSandbox` false
 * answers a verified sandbox transaction without calling Apple (it is refused by admission anyway).
 */
export async function verifyAppStorePurchase(
  deps: {
    readonly creds: AppStoreCredentials | null;
    readonly fetch: StoreFetch;
    readonly nowMs: number;
    readonly acceptSandbox: boolean;
    readonly trustedRootDer?: Buffer;
  },
  signedTransaction: unknown,
): Promise<VerifiedStorePurchase> {
  if (typeof signedTransaction !== 'string') throw new StoreVerifyError('store_receipt_missing', 400);
  let claimed: VerifiedStorePurchase;
  try {
    claimed = fromAppleTransaction(await verifyAppleSignedJws(signedTransaction, { nowMs: deps.nowMs, trustedRootDer: deps.trustedRootDer }));
  } catch (error) {
    if (error instanceof StoreVerifyError) throw error;
    if (error instanceof AppleJwsError) throw new StoreVerifyError('store_receipt_unverified', 402);
    throw error;
  }
  if (claimed.environment === 'sandbox' && !deps.acceptSandbox) return claimed;
  if (deps.creds === null) throw new StoreVerifyError('store_verification_not_configured', 503);

  const host = claimed.environment === 'production' ? APP_STORE_HOSTS.Production : APP_STORE_HOSTS.Sandbox;
  const res = await deps.fetch(`${host}/inApps/v1/transactions/${claimed.transactionId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${appStoreJwt(deps.creds, deps.nowMs)}` },
  }).catch(() => null);
  if (res === null) throw new StoreVerifyError('store_verification_unavailable', 503);
  if (res.status === 404) throw new StoreVerifyError('store_transaction_not_found', 402);
  if (res.status === 401 || res.status === 403) throw new StoreVerifyError('store_verification_auth_failed', 503);
  if (res.status !== 200) throw new StoreVerifyError('store_verification_unavailable', 503);
  const body = (await res.json().catch(() => null)) as { signedTransactionInfo?: unknown } | null;
  if (body === null || typeof body.signedTransactionInfo !== 'string') throw new StoreVerifyError('store_verification_unavailable', 503);
  let truth: VerifiedStorePurchase;
  try {
    truth = fromAppleTransaction(await verifyAppleSignedJws(body.signedTransactionInfo, { nowMs: deps.nowMs, trustedRootDer: deps.trustedRootDer }));
  } catch (error) {
    if (error instanceof StoreVerifyError) throw error;
    throw new StoreVerifyError('store_verification_unavailable', 503);
  }
  if (truth.transactionId !== claimed.transactionId) throw new StoreVerifyError('store_receipt_unverified', 402);
  return truth;
}

// ─── Google Play ─────────────────────────────────────────────────────────────

export interface PlayCredentials {
  readonly clientEmail: string;
  /** The service account's RSA key (PKCS#8 PEM). */
  readonly privateKeyPem: string;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PLAY_API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
/** Play purchase tokens are opaque; this bounds them to their observed alphabet and size. */
const PLAY_TOKEN = /^[A-Za-z0-9._-]{16,2048}$/;
const PLAY_PRODUCT = /^[a-z0-9][a-z0-9._]{0,148}$/;

let cachedPlayToken: { readonly key: string; readonly token: string; readonly untilMs: number } | null = null;

async function playAccessToken(creds: PlayCredentials, fetchFn: StoreFetch, nowMs: number): Promise<string> {
  if (cachedPlayToken !== null && cachedPlayToken.key === creds.clientEmail && cachedPlayToken.untilMs > nowMs) {
    return cachedPlayToken.token;
  }
  const iat = Math.floor(nowMs / 1000);
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const body = enc({ iss: creds.clientEmail, scope: PLAY_SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 });
  const sig = signBytes('sha256', Buffer.from(`${head}.${body}`, 'utf8'), createPrivateKey(creds.privateKeyPem));
  const assertion = `${head}.${body}.${sig.toString('base64url')}`;
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  }).catch(() => null);
  if (res === null || res.status !== 200) throw new StoreVerifyError('store_verification_auth_failed', 503);
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (json === null || typeof json.access_token !== 'string') throw new StoreVerifyError('store_verification_auth_failed', 503);
  const ttl = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  cachedPlayToken = { key: creds.clientEmail, token: json.access_token, untilMs: nowMs + Math.max(0, ttl - 120) * 1000 };
  return json.access_token;
}

/** Test seam: forget the cached OAuth token. */
export function resetPlayTokenCacheForTests(): void {
  cachedPlayToken = null;
}

/** The id a Play purchase is recorded under: its token's digest (orderId can be absent). */
export function playTransactionId(purchaseToken: string): string {
  return createHash('sha256').update(purchaseToken, 'utf8').digest('hex').slice(0, 40);
}

export async function verifyPlayPurchase(
  deps: { readonly creds: PlayCredentials | null; readonly fetch: StoreFetch; readonly nowMs: number },
  input: { readonly productId: unknown; readonly purchaseToken: unknown; readonly packageName: unknown },
): Promise<VerifiedStorePurchase> {
  if (input.packageName !== undefined && input.packageName !== STORE_APP_ID) throw new StoreVerifyError('store_wrong_app', 403);
  if (typeof input.purchaseToken !== 'string' || !PLAY_TOKEN.test(input.purchaseToken)) throw new StoreVerifyError('store_receipt_missing', 400);
  if (typeof input.productId !== 'string' || !PLAY_PRODUCT.test(input.productId)) throw new StoreVerifyError('store_product_unknown', 400);
  if (deps.creds === null) throw new StoreVerifyError('store_verification_not_configured', 503);
  const access = await playAccessToken(deps.creds, deps.fetch, deps.nowMs);
  const url = `${PLAY_API}/${STORE_APP_ID}/purchases/products/${encodeURIComponent(input.productId)}/tokens/${encodeURIComponent(input.purchaseToken)}`;
  const res = await deps.fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${access}` } }).catch(() => null);
  if (res === null) throw new StoreVerifyError('store_verification_unavailable', 503);
  if (res.status === 400 || res.status === 404 || res.status === 410) throw new StoreVerifyError('store_transaction_not_found', 402);
  if (res.status === 401 || res.status === 403) throw new StoreVerifyError('store_verification_auth_failed', 503);
  if (res.status !== 200) throw new StoreVerifyError('store_verification_unavailable', 503);
  const p = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (p === null || p.kind !== 'androidpublisher#productPurchase') throw new StoreVerifyError('store_verification_unavailable', 503);
  // purchaseType: absent = a real purchase, 0 = a license tester's test purchase, 1 = a promo code.
  const purchaseType = p.purchaseType;
  let environment: 'production' | 'sandbox';
  if (purchaseType === undefined || purchaseType === null || purchaseType === 1) environment = 'production';
  else if (purchaseType === 0) environment = 'sandbox';
  else throw new StoreVerifyError('store_receipt_unverified', 402);
  const state = p.purchaseState === 0 ? 'purchased' : p.purchaseState === 2 ? 'pending' : 'cancelled';
  const productId = typeof p.productId === 'string' ? p.productId : input.productId;
  return {
    platform: 'google_play',
    transactionId: playTransactionId(input.purchaseToken),
    productId,
    appId: STORE_APP_ID,
    environment,
    accountToken: typeof p.obfuscatedExternalAccountId === 'string' ? p.obfuscatedExternalAccountId.toLowerCase() : null,
    state,
    quantity: typeof p.quantity === 'number' ? p.quantity : 1,
  };
}

/** Acknowledge a credited Play purchase, so Play never auto-refunds a purchase that was delivered. */
export async function acknowledgePlayPurchase(
  deps: { readonly creds: PlayCredentials | null; readonly fetch: StoreFetch; readonly nowMs: number },
  input: { readonly productId: string; readonly purchaseToken: string },
): Promise<boolean> {
  if (deps.creds === null) return false;
  const access = await playAccessToken(deps.creds, deps.fetch, deps.nowMs);
  const url = `${PLAY_API}/${STORE_APP_ID}/purchases/products/${encodeURIComponent(input.productId)}/tokens/${encodeURIComponent(input.purchaseToken)}:acknowledge`;
  const res = await deps.fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
  return res !== null && (res.status === 200 || res.status === 204);
}
