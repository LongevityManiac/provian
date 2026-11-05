/**
 * App-store purchases: a purchase credits a wallet only when its store confirmed it, and only once.
 *
 * RED negative controls (each fails if its guard is weakened):
 * - a forged receipt: a JWS chained to any root other than Apple Root CA - G3, a tampered payload,
 *   a leaf without Apple's receipt-signing marker, a one-certificate (StoreKit configuration) JWS,
 *   a transaction Apple does not know, a Play token Google does not know;
 * - a replayed transaction id: the second redemption credits nothing, by the same account or any other;
 * - the wrong product, and the wrong bundle / package;
 * - a sandbox purchase presented to production.
 * Each control is paired with the accepting case it differs from, so none can pass vacuously.
 */
import { describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import * as crypto from 'crypto';
import type { webcrypto } from 'crypto';
import * as x509 from '@peculiar/x509';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  APPLE_RECEIPT_SIGNER_OID,
  APPLE_ROOT_CA_G3_DER,
  APPLE_WWDR_INTERMEDIATE_OID,
  AppleJwsError,
  verifyAppleSignedJws,
} from './apple-jws';
import {
  admitVerifiedPurchase,
  STORE_APP_ID,
  storeAccountToken,
  storeTransactionKey,
  type VerifiedStorePurchase,
} from './store-products';
import {
  resetPlayTokenCacheForTests,
  StoreVerifyError,
  verifyAppStorePurchase,
  verifyPlayPurchase,
  type StoreFetch,
} from './store-verify';
import { appStoreCredentialsFrom, playCredentialsFrom } from './store-runtime';
import {
  redeemStorePurchase,
  redeemHeldSettleNow,
  heldSettleNowKeys,
  STORE_TRANSACTIONS_COLLECTION,
  type StorePurchaseDeps,
} from './store-purchase-service';
import { ARCHIVE_GB_BYTES, ARCHIVE_ACCOUNTS_COLLECTION } from '../archive/archive-terms';
import { PAYOUT_REQUESTS_COLLECTION, type PayoutDeps } from '../payout/on-demand-payout';
import { METER_PENDING_CLAIMS_COLLECTION } from '../meter/meter-store';

x509.cryptoProvider.set(crypto.webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const NOW = Date.UTC(2026, 9, 27, 12);
const ARCHIVE = 'com.provian.wallet.archive_1gb';
const SETTLE = 'com.provian.wallet.settle_now';

interface TestKey { readonly pair: webcrypto.CryptoKeyPair; readonly node: crypto.KeyObject }
async function genKey(curve: 'P-256' | 'P-384'): Promise<TestKey> {
  const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { pair, node: crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }) };
}
const marker = (oid: string): x509.Extension => new x509.Extension(oid, false, Buffer.from([0x05, 0x00]));

interface Chain { readonly root: Buffer; readonly x5c: string[]; readonly leafKey: TestKey }
async function makeChain(opts: { leafMarker?: boolean; intermediateMarker?: boolean; intermediateIsCa?: boolean } = {}): Promise<Chain> {
  const rootKey = await genKey('P-384');
  const intKey = await genKey('P-384');
  const leafKey = await genKey('P-256');
  const span = { notBefore: new Date(NOW - 86_400_000), notAfter: new Date(NOW + 365 * 86_400_000) };
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01', name: 'CN=Test Root', ...span, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
    keys: rootKey.pair, extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: '02', subject: 'CN=Test WWDR', issuer: root.subject, ...span,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' }, publicKey: intKey.pair.publicKey, signingKey: rootKey.pair.privateKey,
    extensions: [new x509.BasicConstraintsExtension(opts.intermediateIsCa !== false, undefined, true), ...(opts.intermediateMarker === false ? [] : [marker(APPLE_WWDR_INTERMEDIATE_OID)])],
  });
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '03', subject: 'CN=Test Receipt Signer', issuer: intermediate.subject, ...span,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' }, publicKey: leafKey.pair.publicKey, signingKey: intKey.pair.privateKey,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true), ...(opts.leafMarker === false ? [] : [marker(APPLE_RECEIPT_SIGNER_OID)])],
  });
  const der = (c: x509.X509Certificate): Buffer => Buffer.from(c.rawData);
  return { root: der(root), x5c: [der(leaf), der(intermediate), der(root)].map((b) => b.toString('base64')), leafKey };
}

function signJws(chain: Pick<Chain, 'x5c' | 'leafKey'>, payload: Record<string, unknown>, x5c: string[] = chain.x5c): string {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', x5c })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: chain.leafKey.node, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

function appleTx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: '2000000123456789',
    originalTransactionId: '2000000123456789',
    bundleId: STORE_APP_ID,
    productId: SETTLE,
    type: 'Consumable',
    quantity: 1,
    environment: 'Production',
    appAccountToken: storeAccountToken('user_a'),
    purchaseDate: NOW - 1000,
    ...over,
  };
}

const appStoreCreds = {
  issuerId: 'issuer-1',
  keyId: 'KEY123',
  privateKeyPem: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const playCreds = {
  clientEmail: 'svc@provian.iam.gserviceaccount.com',
  privateKeyPem: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

/** A scripted store: answers by URL and records every call. */
function scriptedFetch(answer: (url: string) => { status: number; body: unknown }): { fetch: StoreFetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      const a = answer(url);
      return { status: a.status, json: async () => a.body };
    },
  };
}

let chain: Chain;
beforeAll(async () => {
  chain = await makeChain();
});

// ─── Apple's signature chain ──────────────────────────────────────────────────

describe("an Apple-signed JWS is accepted only on Apple's chain", () => {
  it('the checks accept a well-formed chain to the trusted root (so the refusals below are not vacuous)', async () => {
    const payload = await verifyAppleSignedJws(signJws(chain, appleTx()), { nowMs: NOW, trustedRootDer: chain.root });
    expect(payload.transactionId).toBe('2000000123456789');
  });

  it('the embedded root is Apple Root CA - G3', () => {
    expect(crypto.createHash('sha256').update(APPLE_ROOT_CA_G3_DER).digest('hex'))
      .toBe('63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179');
  });

  it('RED forged receipt: a chain to any other root is refused in production', async () => {
    await expect(verifyAppleSignedJws(signJws(chain, appleTx()), { nowMs: NOW })).rejects.toEqual(new AppleJwsError('jws_root_untrusted'));
  });

  it('RED forged receipt: a tampered payload fails the signature', async () => {
    const [h, , s] = signJws(chain, appleTx()).split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify(appleTx({ productId: ARCHIVE }))).toString('base64url')}.${s}`;
    await expect(verifyAppleSignedJws(forged, { nowMs: NOW, trustedRootDer: chain.root })).rejects.toEqual(new AppleJwsError('jws_signature_invalid'));
  });

  it('RED forged receipt: a leaf without the receipt-signing marker, or an intermediate without its marker, is refused', async () => {
    const noLeaf = await makeChain({ leafMarker: false });
    await expect(verifyAppleSignedJws(signJws(noLeaf, appleTx()), { nowMs: NOW, trustedRootDer: noLeaf.root })).rejects.toEqual(new AppleJwsError('jws_leaf_not_app_store'));
    const noInt = await makeChain({ intermediateMarker: false });
    await expect(verifyAppleSignedJws(signJws(noInt, appleTx()), { nowMs: NOW, trustedRootDer: noInt.root })).rejects.toEqual(new AppleJwsError('jws_intermediate_not_apple'));
  });

  it('RED forged receipt: a leaf the intermediate did not sign breaks the chain', async () => {
    const other = await makeChain();
    const spliced = [other.x5c[0], chain.x5c[1], chain.x5c[2]];
    await expect(verifyAppleSignedJws(signJws({ x5c: spliced, leafKey: other.leafKey }, appleTx()), { nowMs: NOW, trustedRootDer: chain.root }))
      .rejects.toEqual(new AppleJwsError('jws_chain_broken'));
  });

  it('RED forged receipt: a chain outside its validity window is refused', async () => {
    const jws = signJws(chain, appleTx());
    await expect(verifyAppleSignedJws(jws, { nowMs: NOW + 400 * 86_400_000, trustedRootDer: chain.root })).rejects.toEqual(new AppleJwsError('jws_chain_expired'));
    await expect(verifyAppleSignedJws(jws, { nowMs: NOW - 2 * 86_400_000, trustedRootDer: chain.root })).rejects.toEqual(new AppleJwsError('jws_chain_expired'));
  });

  it('RED forged receipt: an intermediate that is not a CA cannot vouch for the leaf', async () => {
    const notCa = await makeChain({ intermediateIsCa: false });
    await expect(verifyAppleSignedJws(signJws(notCa, appleTx()), { nowMs: NOW, trustedRootDer: notCa.root })).rejects.toEqual(new AppleJwsError('jws_chain_broken'));
  });

  it("RED StoreKit configuration receipt: Xcode's single local certificate is refused", async () => {
    const local = signJws(chain, appleTx({ environment: 'Xcode' }), [chain.x5c[0]]);
    await expect(verifyAppleSignedJws(local, { nowMs: NOW })).rejects.toEqual(new AppleJwsError('jws_chain_missing'));
    await expect(verifyAppStorePurchase({ creds: appStoreCreds, fetch: scriptedFetch(() => ({ status: 500, body: null })).fetch, nowMs: NOW, acceptSandbox: true }, local))
      .rejects.toEqual(new StoreVerifyError('store_receipt_unverified', 402));
  });
});

// ─── the App Store Server API ─────────────────────────────────────────────────

describe("the App Store's own answer decides", () => {
  const verify = (fetchFn: StoreFetch, jws: string, over: { creds?: typeof appStoreCreds | null; acceptSandbox?: boolean } = {}) =>
    verifyAppStorePurchase({
      creds: over.creds === undefined ? appStoreCreds : over.creds,
      fetch: fetchFn, nowMs: NOW, acceptSandbox: over.acceptSandbox ?? false, trustedRootDer: chain.root,
    }, jws);

  it("a production purchase is read from Apple's signed answer for that transaction", async () => {
    const store = scriptedFetch(() => ({ status: 200, body: { signedTransactionInfo: signJws(chain, appleTx()) } }));
    const p = await verify(store.fetch, signJws(chain, appleTx()));
    expect(store.calls).toEqual(['https://api.storekit.itunes.apple.com/inApps/v1/transactions/2000000123456789']);
    expect(p).toMatchObject({ platform: 'app_store', productId: SETTLE, appId: STORE_APP_ID, environment: 'production', state: 'purchased' });
  });

  it('RED forged receipt: a transaction Apple does not know is refused', async () => {
    const store = scriptedFetch(() => ({ status: 404, body: { errorCode: 4040010 } }));
    await expect(verify(store.fetch, signJws(chain, appleTx()))).rejects.toEqual(new StoreVerifyError('store_transaction_not_found', 402));
  });

  it("RED forged receipt: Apple's answer for a different transaction is refused", async () => {
    const store = scriptedFetch(() => ({ status: 200, body: { signedTransactionInfo: signJws(chain, appleTx({ transactionId: '2000000999999999' })) } }));
    await expect(verify(store.fetch, signJws(chain, appleTx()))).rejects.toEqual(new StoreVerifyError('store_receipt_unverified', 402));
  });

  it('unknown = deny: no credentials, no answer', async () => {
    const store = scriptedFetch(() => ({ status: 200, body: { signedTransactionInfo: signJws(chain, appleTx()) } }));
    await expect(verify(store.fetch, signJws(chain, appleTx()), { creds: null })).rejects.toEqual(new StoreVerifyError('store_verification_not_configured', 503));
    expect(store.calls).toEqual([]);
  });

  it('a refund Apple reports is not a purchase', async () => {
    const store = scriptedFetch(() => ({ status: 200, body: { signedTransactionInfo: signJws(chain, appleTx({ revocationDate: NOW })) } }));
    expect((await verify(store.fetch, signJws(chain, appleTx()))).state).toBe('refunded');
  });

  it('a sandbox purchase goes to the sandbox host only when sandbox purchases are accepted', async () => {
    const sandboxJws = signJws(chain, appleTx({ environment: 'Sandbox' }));
    const off = scriptedFetch(() => ({ status: 200, body: { signedTransactionInfo: sandboxJws } }));
    expect((await verify(off.fetch, sandboxJws)).environment).toBe('sandbox');
    expect(off.calls).toEqual([]);
    const on = scriptedFetch(() => ({ status: 200, body: { signedTransactionInfo: sandboxJws } }));
    expect((await verify(on.fetch, sandboxJws, { acceptSandbox: true })).environment).toBe('sandbox');
    expect(on.calls).toEqual(['https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions/2000000123456789']);
  });
});

// ─── Google Play ──────────────────────────────────────────────────────────────

describe("Google Play's own answer decides", () => {
  const TOKEN = 'opaque-token.AO-J1Oz_abcdefghijklmnop';
  beforeEach(() => resetPlayTokenCacheForTests());
  const play = (purchase: { status: number; body: unknown }) => scriptedFetch((url) => (
    url === 'https://oauth2.googleapis.com/token' ? { status: 200, body: { access_token: 'ya29.test', expires_in: 3600 } } : purchase
  ));
  const productPurchase = (over: Record<string, unknown> = {}) => ({
    kind: 'androidpublisher#productPurchase', purchaseState: 0, consumptionState: 0, orderId: 'GPA.1234-5678-9012-34567',
    productId: SETTLE, quantity: 1, obfuscatedExternalAccountId: storeAccountToken('user_a'), ...over,
  });

  it("a real purchase is read from Google's answer for this app's package and product", async () => {
    const store = play({ status: 200, body: productPurchase() });
    const p = await verifyPlayPurchase({ creds: playCreds, fetch: store.fetch, nowMs: NOW }, { productId: SETTLE, purchaseToken: TOKEN, packageName: STORE_APP_ID });
    expect(store.calls[1]).toBe(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${STORE_APP_ID}/purchases/products/${SETTLE}/tokens/${encodeURIComponent(TOKEN)}`);
    expect(p).toMatchObject({ platform: 'google_play', environment: 'production', state: 'purchased', appId: STORE_APP_ID });
  });

  it('RED forged receipt: a token Google does not know is refused', async () => {
    await expect(verifyPlayPurchase({ creds: playCreds, fetch: play({ status: 400, body: {} }).fetch, nowMs: NOW }, { productId: SETTLE, purchaseToken: TOKEN, packageName: undefined }))
      .rejects.toEqual(new StoreVerifyError('store_transaction_not_found', 402));
  });

  it('RED wrong package: a purchase claimed for another package is refused before Google is asked', async () => {
    const store = play({ status: 200, body: productPurchase() });
    await expect(verifyPlayPurchase({ creds: playCreds, fetch: store.fetch, nowMs: NOW }, { productId: SETTLE, purchaseToken: TOKEN, packageName: 'com.example.other' }))
      .rejects.toEqual(new StoreVerifyError('store_wrong_app', 403));
    expect(store.calls).toEqual([]);
  });

  it("a license tester's purchase is a sandbox purchase; pending and cancelled are not purchases", async () => {
    const base = { creds: playCreds, nowMs: NOW };
    const input = { productId: SETTLE, purchaseToken: TOKEN, packageName: undefined };
    expect((await verifyPlayPurchase({ ...base, fetch: play({ status: 200, body: productPurchase({ purchaseType: 0 }) }).fetch }, input)).environment).toBe('sandbox');
    expect((await verifyPlayPurchase({ ...base, fetch: play({ status: 200, body: productPurchase({ purchaseState: 2 }) }).fetch }, input)).state).toBe('pending');
    expect((await verifyPlayPurchase({ ...base, fetch: play({ status: 200, body: productPurchase({ purchaseState: 1 }) }).fetch }, input)).state).toBe('cancelled');
  });

  it('RED unknown = deny: a purchase type Google may add later is refused, not guessed', async () => {
    await expect(verifyPlayPurchase({ creds: playCreds, nowMs: NOW, fetch: play({ status: 200, body: productPurchase({ purchaseType: 2 }) }).fetch }, { productId: SETTLE, purchaseToken: TOKEN, packageName: undefined }))
      .rejects.toEqual(new StoreVerifyError('store_receipt_unverified', 402));
  });

  it('unknown = deny: no service account, no answer', async () => {
    await expect(verifyPlayPurchase({ creds: null, fetch: play({ status: 200, body: productPurchase() }).fetch, nowMs: NOW }, { productId: SETTLE, purchaseToken: TOKEN, packageName: undefined }))
      .rejects.toEqual(new StoreVerifyError('store_verification_not_configured', 503));
  });
});

// ─── admission ────────────────────────────────────────────────────────────────

describe('a verified purchase credits only the product, app, account and environment it is for', () => {
  const good: VerifiedStorePurchase = {
    platform: 'app_store', transactionId: '1', productId: SETTLE, appId: STORE_APP_ID, environment: 'production',
    accountToken: storeAccountToken('user_a'), state: 'purchased', quantity: 1,
  };
  const admit = (p: Partial<VerifiedStorePurchase>, over: { productId?: string; userId?: string; acceptSandbox?: boolean } = {}) =>
    admitVerifiedPurchase({ ...good, ...p }, { requestedProductId: over.productId ?? SETTLE, userId: over.userId ?? 'user_a', acceptSandbox: over.acceptSandbox ?? false });

  it('the matching purchase is admitted', () => {
    expect(admit({})).toEqual({ ok: true, kind: 'settle_now' });
    expect(admit({ productId: ARCHIVE }, { productId: ARCHIVE })).toEqual({ ok: true, kind: 'archive_gb' });
  });
  it('RED wrong product: the store confirmed a different product than the app claims', () => {
    expect(admit({ productId: ARCHIVE })).toEqual({ ok: false, error: 'store_wrong_product' });
    expect(admit({ productId: 'com.provian.wallet.unknown' })).toEqual({ ok: false, error: 'store_product_unknown' });
  });
  it('RED wrong bundle: a purchase in another app is refused', () => {
    expect(admit({ appId: 'com.provian.wallet.dev' })).toEqual({ ok: false, error: 'store_wrong_app' });
  });
  it('RED sandbox presented to production: refused unless the relay accepts sandbox purchases', () => {
    expect(admit({ environment: 'sandbox' })).toEqual({ ok: false, error: 'store_sandbox_purchase_refused' });
    expect(admit({ environment: 'sandbox' }, { acceptSandbox: true })).toEqual({ ok: true, kind: 'settle_now' });
  });
  it("RED another account's purchase, a pending or refunded purchase, a quantity above one", () => {
    expect(admit({}, { userId: 'user_b' })).toEqual({ ok: false, error: 'store_purchase_other_account' });
    expect(admit({ accountToken: null })).toEqual({ ok: false, error: 'store_purchase_other_account' });
    expect(admit({ state: 'pending' })).toEqual({ ok: false, error: 'store_purchase_pending' });
    expect(admit({ state: 'refunded' })).toEqual({ ok: false, error: 'store_purchase_refunded' });
    expect(admit({ quantity: 2 })).toEqual({ ok: false, error: 'store_quantity_refused' });
  });
});

// ─── redemption: once per transaction ─────────────────────────────────────────

describe('a store purchase is granted once, to the account that made it', () => {
  let fake: FakeFirestore;
  let db: Firestore;
  let presented: VerifiedStorePurchase;
  let acks: number;

  const payoutDeps = (): PayoutDeps => ({
    db,
    chain: { gasPriceWei: async () => 0n, l1FeeUpperBoundWei: async () => 0n } as unknown as PayoutDeps['chain'],
    ethUsd: async () => 3000,
    settle: async () => ({ kind: 'nothing', cycleId: null }),
    withGasKeyLease: async (fn) => fn(),
    now: () => NOW,
    sleep: async () => undefined,
    log: () => undefined,
  });
  const deps = (over: Partial<StorePurchaseDeps> = {}): StorePurchaseDeps => ({
    db,
    now: () => NOW,
    verifyAppStore: async () => presented,
    verifyPlay: async () => presented,
    acknowledgePlay: async () => { acks += 1; return true; },
    acceptSandbox: false,
    payout: payoutDeps,
    ...over,
  });
  const redeem = (userId: string, productId: string, d: StorePurchaseDeps = deps()) =>
    redeemStorePurchase(d, { userId, platform: 'app_store', productId, signedTransaction: 'jws' });
  const docs = (collection: string) => [...fake.store.entries()].filter(([k]) => k.startsWith(`${collection}/`)).map(([, v]) => v);

  beforeEach(async () => {
    fake = createFakeFirestore();
    db = fake as unknown as Firestore;
    acks = 0;
    for (const u of ['user_a', 'user_b']) {
      await db.collection('wallets').doc(`w_${u}`).set({ user_id: u, type: 'human', address: `0x${(u === 'user_a' ? 'aa' : 'bb').repeat(20)}` });
    }
    presented = {
      platform: 'app_store', transactionId: '2000000123456789', productId: ARCHIVE, appId: STORE_APP_ID,
      environment: 'production', accountToken: storeAccountToken('user_a'), state: 'purchased', quantity: 1,
    };
  });

  it('one Archive purchase adds exactly one GB and turns the Archive on', async () => {
    const r = await redeem('user_a', ARCHIVE);
    expect(r).toMatchObject({ kind: 'credited', replayed: false });
    const [account] = docs(ARCHIVE_ACCOUNTS_COLLECTION);
    expect(account).toMatchObject({ wallet: 'w_user_a', paid_bytes: ARCHIVE_GB_BYTES, gb_purchased: 1, on: true });
    expect(docs(STORE_TRANSACTIONS_COLLECTION)).toHaveLength(1);
  });

  it('RED replayed transaction id: the same purchase again credits nothing more', async () => {
    await redeem('user_a', ARCHIVE);
    const again = await redeem('user_a', ARCHIVE);
    expect(again).toMatchObject({ kind: 'credited', replayed: true });
    expect(docs(ARCHIVE_ACCOUNTS_COLLECTION)[0]).toMatchObject({ paid_bytes: ARCHIVE_GB_BYTES, gb_purchased: 1 });
    expect(docs(STORE_TRANSACTIONS_COLLECTION)).toHaveLength(1);
  });

  it("RED replayed transaction id: another account presenting it is refused and credited nothing", async () => {
    await redeem('user_a', ARCHIVE);
    // Even a purchase whose account token were somehow user_b's lands on the same transaction record.
    presented = { ...presented, accountToken: storeAccountToken('user_b') };
    expect(await redeem('user_b', ARCHIVE)).toEqual({ kind: 'denied', status: 409, error: 'store_transaction_redeemed_elsewhere' });
    expect(docs(ARCHIVE_ACCOUNTS_COLLECTION)).toHaveLength(1);
    expect(docs(ARCHIVE_ACCOUNTS_COLLECTION)[0]).toMatchObject({ wallet: 'w_user_a', gb_purchased: 1 });
  });

  it('a different transaction is a different purchase (the replay guard keys on the transaction, not the account)', async () => {
    await redeem('user_a', ARCHIVE);
    presented = { ...presented, transactionId: '2000000123456790' };
    await redeem('user_a', ARCHIVE);
    expect(docs(ARCHIVE_ACCOUNTS_COLLECTION)[0]).toMatchObject({ paid_bytes: 2 * ARCHIVE_GB_BYTES, gb_purchased: 2 });
  });

  it('RED every refusal credits nothing: wrong product, wrong app, sandbox, unverifiable', async () => {
    expect(await redeem('user_a', SETTLE)).toMatchObject({ kind: 'denied', error: 'store_wrong_product' });
    presented = { ...presented, appId: 'com.other.app' };
    expect(await redeem('user_a', ARCHIVE)).toMatchObject({ kind: 'denied', error: 'store_wrong_app' });
    presented = { ...presented, appId: STORE_APP_ID, environment: 'sandbox' };
    expect(await redeem('user_a', ARCHIVE)).toMatchObject({ kind: 'denied', error: 'store_sandbox_purchase_refused' });
    const unverifiable = deps({ verifyAppStore: async () => { throw new StoreVerifyError('store_receipt_unverified', 402); } });
    expect(await redeem('user_a', ARCHIVE, unverifiable)).toEqual({ kind: 'denied', status: 402, error: 'store_receipt_unverified' });
    expect(docs(ARCHIVE_ACCOUNTS_COLLECTION)).toHaveLength(0);
    expect(docs(STORE_TRANSACTIONS_COLLECTION)).toHaveLength(0);
  });

  it('Settle now with nothing ready is held, never spent; it is redeemed once there is work', async () => {
    presented = { ...presented, productId: SETTLE };
    const held = await redeem('user_a', SETTLE);
    expect(held).toMatchObject({ kind: 'held', transaction: { held_reason: 'nothing_to_pay' } });
    expect(docs(PAYOUT_REQUESTS_COLLECTION)).toHaveLength(0);
    expect(await heldSettleNowKeys(db, 'user_a')).toHaveLength(1);

    await db.collection(METER_PENDING_CLAIMS_COLLECTION).doc('c1').set({
      contributor: '0x' + 'aa'.repeat(20), state: 'pending', claim_key: 'k1', unit: 'payout',
      record_points_atomic: '1000000000000000000', beneficiary_class: 'human', ready_at_ms: NOW - 1,
    });
    const key = storeTransactionKey('app_store', presented.transactionId);
    const credited = await redeemHeldSettleNow(deps(), key);
    expect(credited).toMatchObject({ kind: 'credited' });
    const requests = docs(PAYOUT_REQUESTS_COLLECTION);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ state: 'charged', paid_via: 'app_store', payee: '0x' + 'aa'.repeat(20), payment: null });

    // RED replay: redeeming again, or presenting the purchase again, creates no second request.
    await redeemHeldSettleNow(deps(), key);
    expect(await redeem('user_a', SETTLE)).toMatchObject({ kind: 'credited', replayed: true });
    expect(docs(PAYOUT_REQUESTS_COLLECTION)).toHaveLength(1);
    expect(await heldSettleNowKeys(db, 'user_a')).toHaveLength(0);
  });

  it('a credited Play purchase is acknowledged with Play; a refused one is not', async () => {
    const playDeps = deps();
    presented = { ...presented, platform: 'google_play' };
    await redeemStorePurchase(playDeps, { userId: 'user_a', platform: 'google_play', productId: ARCHIVE, purchaseToken: 'tok-0123456789abcdef' });
    expect(acks).toBe(1);
    presented = { ...presented, transactionId: 'other', environment: 'sandbox' };
    await redeemStorePurchase(playDeps, { userId: 'user_a', platform: 'google_play', productId: ARCHIVE, purchaseToken: 'tok-0123456789abcdef' });
    expect(acks).toBe(1);
  });

  it('RED a second Settle now waits while the first is still settling, so it is never spent on nothing', async () => {
    await db.collection(METER_PENDING_CLAIMS_COLLECTION).doc('c1').set({
      contributor: '0x' + 'aa'.repeat(20), state: 'pending', claim_key: 'k1', unit: 'payout',
      record_points_atomic: '1000000000000000000', beneficiary_class: 'human', ready_at_ms: NOW - 1,
    });
    presented = { ...presented, productId: SETTLE };
    expect(await redeem('user_a', SETTLE)).toMatchObject({ kind: 'credited' });
    // The first request is charged and not yet settled; its claims still read as ready.
    presented = { ...presented, transactionId: '2000000123456790' };
    expect(await redeem('user_a', SETTLE)).toMatchObject({ kind: 'held', transaction: { held_reason: 'previous_settlement_in_flight' } });
    expect(docs(PAYOUT_REQUESTS_COLLECTION)).toHaveLength(1);
    // Once the first has settled, the saved purchase can be spent on the next work that is ready.
    const [first] = docs(PAYOUT_REQUESTS_COLLECTION) as Array<{ request_id: string }>;
    await db.collection(PAYOUT_REQUESTS_COLLECTION).doc(first.request_id).update({ state: 'settled' });
    expect(await redeemHeldSettleNow(deps(), storeTransactionKey('app_store', '2000000123456790'))).toMatchObject({ kind: 'credited' });
    expect(docs(PAYOUT_REQUESTS_COLLECTION)).toHaveLength(2);
  });

  it.each(['charging', 'charge_unconfirmed', 'charged', 'settling'])('RED a saved Settle now waits while an earlier request is %s', async (state) => {
    await db.collection(METER_PENDING_CLAIMS_COLLECTION).doc('c1').set({
      contributor: '0x' + 'aa'.repeat(20), state: 'pending', claim_key: 'k1', unit: 'payout',
      record_points_atomic: '1000000000000000000', beneficiary_class: 'human', ready_at_ms: NOW - 1,
    });
    await db.collection(PAYOUT_REQUESTS_COLLECTION).doc('po_earlier').set({ request_id: 'po_earlier', payee: '0x' + 'aa'.repeat(20), state, created_at_ms: NOW - 1 });
    presented = { ...presented, productId: SETTLE };
    expect(await redeem('user_a', SETTLE)).toMatchObject({ kind: 'held', transaction: { held_reason: 'previous_settlement_in_flight' } });
    expect(docs(PAYOUT_REQUESTS_COLLECTION)).toHaveLength(1);
  });

  it.each(['settled', 'charge_failed'])('a finished earlier request (%s) does not hold a saved Settle now back', async (state) => {
    await db.collection(METER_PENDING_CLAIMS_COLLECTION).doc('c1').set({
      contributor: '0x' + 'aa'.repeat(20), state: 'pending', claim_key: 'k1', unit: 'payout',
      record_points_atomic: '1000000000000000000', beneficiary_class: 'human', ready_at_ms: NOW - 1,
    });
    await db.collection(PAYOUT_REQUESTS_COLLECTION).doc('po_earlier').set({ request_id: 'po_earlier', payee: '0x' + 'aa'.repeat(20), state, created_at_ms: NOW - 1 });
    presented = { ...presented, productId: SETTLE };
    expect(await redeem('user_a', SETTLE)).toMatchObject({ kind: 'credited' });
  });

  it('RED a Play purchase refused after verification, and so never recorded, is not acknowledged (Play refunds it)', async () => {
    presented = { ...presented, platform: 'google_play', productId: SETTLE };
    const r = await redeemStorePurchase(deps(), { userId: 'user_a', platform: 'google_play', productId: SETTLE, purchaseToken: 'tok-0123456789abcdef', payee: '0x' + 'cc'.repeat(20) });
    expect(r).toMatchObject({ kind: 'denied', error: 'payee_not_your_wallet' });
    expect(docs(STORE_TRANSACTIONS_COLLECTION)).toHaveLength(0);
    expect(acks).toBe(0);
  });

  it('RED a recorded Play purchase is acknowledged on every presentation, even when its redemption failed', async () => {
    presented = { ...presented, platform: 'google_play', productId: SETTLE };
    const failing = deps({ payout: () => ({ ...payoutDeps(), ethUsd: async () => { throw new Error('rpc down'); } }) });
    const present = (d: StorePurchaseDeps) => redeemStorePurchase(d, { userId: 'user_a', platform: 'google_play', productId: SETTLE, purchaseToken: 'tok-0123456789abcdef' });
    await present(failing).catch(() => undefined);
    expect(docs(STORE_TRANSACTIONS_COLLECTION)).toHaveLength(1);
    expect(acks).toBe(1);
    await present(deps());
    expect(acks).toBe(2);
  });

  it('RED a purchase verified on one store cannot be presented as the other', async () => {
    presented = { ...presented, platform: 'google_play' };
    expect(await redeem('user_a', ARCHIVE)).toEqual({ kind: 'denied', status: 402, error: 'store_receipt_unverified' });
  });
});

describe('relay config: a store whose key is not a readable key has no credentials', () => {
  const ecPem = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const rsaPem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const ids = { APP_STORE_CONNECT_ISSUER_ID: 'issuer', APP_STORE_CONNECT_KEY_ID: 'KEY123' };

  it('reads a real key, as PEM text or with escaped newlines', () => {
    expect(appStoreCredentialsFrom({ ...ids, APP_STORE_CONNECT_PRIVATE_KEY: ecPem })).toMatchObject({ issuerId: 'issuer', keyId: 'KEY123' });
    expect(appStoreCredentialsFrom({ ...ids, APP_STORE_CONNECT_PRIVATE_KEY: ecPem.replace(/\n/g, '\\n') })).not.toBeNull();
    expect(playCredentialsFrom({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: rsaPem }) }))
      .toMatchObject({ clientEmail: 'sa@x.iam.gserviceaccount.com' });
  });

  it('RED: the deployed placeholder, a missing id, or malformed JSON leaves the store unconfigured', () => {
    expect(appStoreCredentialsFrom({ ...ids, APP_STORE_CONNECT_PRIVATE_KEY: 'unset' })).toBeNull();
    expect(appStoreCredentialsFrom({ APP_STORE_CONNECT_KEY_ID: 'KEY123', APP_STORE_CONNECT_PRIVATE_KEY: ecPem })).toBeNull();
    expect(playCredentialsFrom({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: 'unset' })).toBeNull();
    expect(playCredentialsFrom({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'sa@x', private_key: 'unset' }) })).toBeNull();
  });
});
