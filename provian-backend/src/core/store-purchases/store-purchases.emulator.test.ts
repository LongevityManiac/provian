/**
 * App-store purchase crediting against the Firestore EMULATOR (real transaction semantics), with a
 * scripted store verdict. Skipped unless FIRESTORE_EMULATOR_HOST is set:
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 npx firebase emulators:start --only firestore --project demo-meter
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx jest src/core/store-purchases/store-purchases.emulator.test.ts
 *
 * Proves: one Archive purchase adds exactly one GB however many times it is presented, including
 * concurrently; another account presenting it gets nothing; a held Settle now becomes exactly one
 * paid payout request even when redeemed concurrently; two different Settle now purchases for one
 * payee, redeemed at once, start one settlement and the other waits.
 */
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import { createHash } from 'crypto';
import { redeemHeldSettleNow, redeemStorePurchase, STORE_TRANSACTIONS_COLLECTION, type StorePurchaseDeps } from './store-purchase-service';
import { STORE_APP_ID, storeAccountToken, storeTransactionKey, type VerifiedStorePurchase } from './store-products';
import { ARCHIVE_ACCOUNTS_COLLECTION, ARCHIVE_GB_BYTES } from '../archive/archive-terms';
import { PAYOUT_REQUESTS_COLLECTION, type PayoutDeps } from '../payout/on-demand-payout';
import { METER_PENDING_CLAIMS_COLLECTION } from '../meter/meter-store';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const suite = EMULATOR ? describe : describe.skip;
// Concurrent transactions retry under contention on the emulator; a few seconds each is normal.
jest.setTimeout(30_000);
const RUN = `s${Date.now().toString(36)}`;
const ARCHIVE = 'com.provian.wallet.archive_1gb';
const SETTLE = 'com.provian.wallet.settle_now';
/** A payee address no earlier run has used (emulator data persists between runs). */
const payeeFor = (label: string): string => '0x' + createHash('sha256').update(`${RUN}|${label}`).digest('hex').slice(0, 40);

let db: FirebaseFirestore.Firestore;

suite('store purchases on the Firestore emulator', () => {
  beforeAll(async () => {
    const admin = await import('firebase-admin');
    if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-meter' });
    db = admin.firestore();
  });

  const purchase = (userId: string, productId: string, transactionId: string): VerifiedStorePurchase => ({
    platform: 'app_store', transactionId, productId, appId: STORE_APP_ID, environment: 'production',
    accountToken: storeAccountToken(userId), state: 'purchased', quantity: 1,
  });
  const deps = (presented: VerifiedStorePurchase, payout: (() => PayoutDeps | null) = () => null): StorePurchaseDeps => ({
    db, now: () => Date.now(), acceptSandbox: false, payout,
    verifyAppStore: async () => presented, verifyPlay: async () => presented, acknowledgePlay: async () => true,
  });

  it('one Archive purchase, presented five times at once, adds exactly one GB', async () => {
    const user = `${RUN}_a`;
    await db.collection('wallets').doc(`w_${user}`).set({ user_id: user, type: 'human', address: '0x' + 'a1'.repeat(20) });
    const d = deps(purchase(user, ARCHIVE, `${Date.now()}1`));
    const results = await Promise.all(Array.from({ length: 5 }, () => redeemStorePurchase(d, { userId: user, platform: 'app_store', productId: ARCHIVE, signedTransaction: 'x' })));
    expect(results.every((r) => r.kind === 'credited')).toBe(true);
    expect(results.filter((r) => r.kind === 'credited' && !r.replayed)).toHaveLength(1);
    const account = (await db.collection(ARCHIVE_ACCOUNTS_COLLECTION).doc(`w_${user}`).get()).data();
    expect(account).toMatchObject({ paid_bytes: ARCHIVE_GB_BYTES, gb_purchased: 1 });
  });

  it("another account presenting the same transaction is refused and credited nothing", async () => {
    const owner = `${RUN}_o`;
    const other = `${RUN}_x`;
    for (const u of [owner, other]) await db.collection('wallets').doc(`w_${u}`).set({ user_id: u, type: 'human', address: '0x' + (u === owner ? 'b1' : 'c1').repeat(20) });
    const tx = `${Date.now()}2`;
    await redeemStorePurchase(deps(purchase(owner, ARCHIVE, tx)), { userId: owner, platform: 'app_store', productId: ARCHIVE, signedTransaction: 'x' });
    const r = await redeemStorePurchase(deps({ ...purchase(other, ARCHIVE, tx) }), { userId: other, platform: 'app_store', productId: ARCHIVE, signedTransaction: 'x' });
    expect(r).toEqual({ kind: 'denied', status: 409, error: 'store_transaction_redeemed_elsewhere' });
    expect((await db.collection(ARCHIVE_ACCOUNTS_COLLECTION).doc(`w_${other}`).get()).exists).toBe(false);
  });

  it('a held Settle now, redeemed four times at once, becomes exactly one paid payout request', async () => {
    const user = `${RUN}_s`;
    const payee = payeeFor('s');
    await db.collection('wallets').doc(`w_${user}`).set({ user_id: user, type: 'human', address: payee });
    const tx = `${Date.now()}3`;
    const held = await redeemStorePurchase(deps(purchase(user, SETTLE, tx)), { userId: user, platform: 'app_store', productId: SETTLE, signedTransaction: 'x' });
    expect(held).toMatchObject({ kind: 'held', transaction: { held_reason: 'payout_not_configured' } });
    await db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(`${RUN}_c`).set({
      contributor: payee, state: 'pending', claim_key: `${RUN}_k`, unit: 'payout',
      record_points_atomic: '1000000000000000000', beneficiary_class: 'human', ready_at_ms: Date.now() - 1,
    });
    const payout = (): PayoutDeps => ({
      db, chain: { gasPriceWei: async () => 0n, l1FeeUpperBoundWei: async () => 0n } as unknown as PayoutDeps['chain'],
      ethUsd: async () => 3000, settle: async () => ({ kind: 'nothing', cycleId: null }), withGasKeyLease: async (fn) => fn(),
      now: () => Date.now(), sleep: async () => undefined, log: () => undefined,
    });
    const key = storeTransactionKey('app_store', tx);
    await Promise.all(Array.from({ length: 4 }, () => redeemHeldSettleNow(deps(purchase(user, SETTLE, tx), payout), key)));
    const requests = await db.collection(PAYOUT_REQUESTS_COLLECTION).where('store_transaction_key', '==', key).get();
    expect(requests.size).toBe(1);
    expect(requests.docs[0].data()).toMatchObject({ state: 'charged', paid_via: 'app_store', payment: null });
    expect((await db.collection(STORE_TRANSACTIONS_COLLECTION).doc(key).get()).data()).toMatchObject({ state: 'credited' });
  });

  it('two Settle now purchases for one payee, redeemed at once, start one settlement; the other waits', async () => {
    const user = `${RUN}_p`;
    const payee = payeeFor('p');
    await db.collection('wallets').doc(`w_${user}`).set({ user_id: user, type: 'human', address: payee });
    await db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(`${RUN}_cp`).set({
      contributor: payee, state: 'pending', claim_key: `${RUN}_kp`, unit: 'payout',
      record_points_atomic: '1000000000000000000', beneficiary_class: 'human', ready_at_ms: Date.now() - 1,
    });
    const keys: string[] = [];
    for (const n of [4, 5]) {
      const tx = `${Date.now()}${n}`;
      await redeemStorePurchase(deps(purchase(user, SETTLE, tx)), { userId: user, platform: 'app_store', productId: SETTLE, signedTransaction: 'x' });
      keys.push(storeTransactionKey('app_store', tx));
    }
    const payout = (): PayoutDeps => ({
      db, chain: { gasPriceWei: async () => 0n, l1FeeUpperBoundWei: async () => 0n } as unknown as PayoutDeps['chain'],
      ethUsd: async () => 3000, settle: async () => ({ kind: 'nothing', cycleId: null }), withGasKeyLease: async (fn) => fn(),
      now: () => Date.now(), sleep: async () => undefined, log: () => undefined,
    });
    const results = await Promise.all(keys.map((k) => redeemHeldSettleNow(deps(purchase(user, SETTLE, 'unused'), payout), k)));
    expect(results.map((r) => r.kind).sort()).toEqual(['credited', 'held']);
    expect((await db.collection(PAYOUT_REQUESTS_COLLECTION).where('payee', '==', payee).get()).size).toBe(1);
  });
});
