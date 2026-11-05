/**
 * Redeem an app-store purchase: verify it with its store, record it once, and grant what it bought.
 *
 * Every purchase is recorded under its store transaction (`store_transactions_v1/{key}`), created in
 * the same Firestore transaction that grants it, so a transaction id credits at most once whoever
 * presents it and however often. A replay by the account that made it answers with the record; a
 * replay by any other account is refused.
 *
 * - PE Archive (1 GB): the account's paid space goes up by one GB and the Archive turns on, the
 *   exact grant the USDC payment makes.
 * - Settle now: a payout request is created already paid and the payout sweep settles it, exactly
 *   as for a USDC-paid request. When there is nothing ready to settle, or Base gas is above what
 *   the fee covers, the purchase is kept as an unused Settle now (`held`) and redeemed by the next
 *   Settle now this account asks for: a purchase is never spent on an empty settlement.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { archiveAccountRef, archiveAccountWithOneMoreGb, humanArchiveOwner, type ArchiveAccountDoc } from '../archive/archive-service';
import { ARCHIVE_GB_BYTES } from '../archive/archive-terms';
import {
  PAYOUT_REQUESTS_COLLECTION,
  precheckPayout,
  publicPayoutView,
  storePaidPayoutRequest,
  type PayoutDeps,
  type PayoutRequestDoc,
  type PayoutState,
} from '../payout/on-demand-payout';
import {
  admitVerifiedPurchase,
  STORE_TRANSACTIONS_COLLECTION,
  storeProductKind,
  storeTransactionKey,
  type StorePlatform,
  type StoreProductKind,
  type VerifiedStorePurchase,
} from './store-products';
import { StoreVerifyError } from './store-verify';

export { STORE_TRANSACTIONS_COLLECTION };

/** A payout request in one of these states has not finished its settlement yet. */
const PAYOUT_IN_FLIGHT: ReadonlySet<PayoutState> = new Set<PayoutState>(['charging', 'charge_unconfirmed', 'charged', 'settling']);

export interface StoreTransactionDoc {
  readonly schema: 'provian.store-transaction.v1';
  readonly key: string;
  readonly platform: StorePlatform;
  readonly transaction_id: string;
  readonly product_id: string;
  readonly kind: StoreProductKind;
  readonly environment: 'production' | 'sandbox';
  readonly user_id: string;
  /** Archive: the `wallets/{doc}` id credited. Settle now: the payee address. */
  readonly wallet: string;
  /** `credited`: granted. `held`: a Settle now kept for the next settlement this account asks for. */
  readonly state: 'credited' | 'held';
  readonly held_reason: string | null;
  readonly payout_request_id: string | null;
  readonly credited_bytes: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface StorePurchaseDeps {
  readonly db: Firestore;
  readonly now: () => number;
  readonly verifyAppStore: (signedTransaction: unknown) => Promise<VerifiedStorePurchase>;
  readonly verifyPlay: (input: { readonly productId: unknown; readonly purchaseToken: unknown; readonly packageName: unknown }) => Promise<VerifiedStorePurchase>;
  /** Called once a Play purchase is credited, so Play never auto-refunds a delivered purchase. */
  readonly acknowledgePlay: (input: { readonly productId: string; readonly purchaseToken: string }) => Promise<boolean>;
  /** Whether a store-verified sandbox / test purchase may be credited (relay config; off by default). */
  readonly acceptSandbox: boolean;
  /** Null while payouts are not configured: a Settle now is then held, never lost. */
  readonly payout: () => PayoutDeps | null;
}

export type StoreRedeemResult =
  | {
    readonly kind: 'credited' | 'held';
    readonly replayed: boolean;
    readonly transaction: StoreTransactionDoc;
    readonly account?: ArchiveAccountDoc | null;
    readonly payout?: Record<string, unknown> | null;
  }
  | { readonly kind: 'denied'; readonly status: number; readonly error: string };

function txRef(db: Firestore, key: string) {
  return db.collection(STORE_TRANSACTIONS_COLLECTION).doc(key);
}

async function readTx(db: Firestore, key: string): Promise<StoreTransactionDoc | null> {
  const snap = await txRef(db, key).get();
  return snap.exists ? (snap.data() as StoreTransactionDoc) : null;
}

/** The person's own human Base wallet addresses (lowercase, unique). */
export async function humanPayeeAddresses(db: Firestore, userId: string): Promise<string[]> {
  const owned = await db.collection('wallets').where('user_id', '==', userId).get();
  const addresses = owned.docs
    .map((d) => d.data() as { type?: unknown; address?: unknown })
    .filter((w) => w.type === undefined || w.type === 'human')
    .map((w) => String(w.address ?? '').toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  return [...new Set(addresses)];
}

/**
 * Redeem one store purchase for `userId`. The product the app says it bought must be the product
 * the store confirmed; the store's answer decides everything else.
 */
export async function redeemStorePurchase(
  deps: StorePurchaseDeps,
  params: {
    readonly userId: string;
    readonly platform: unknown;
    readonly productId: unknown;
    readonly signedTransaction?: unknown;
    readonly purchaseToken?: unknown;
    readonly packageName?: unknown;
    readonly payee?: unknown;
  },
): Promise<StoreRedeemResult> {
  if (params.platform !== 'app_store' && params.platform !== 'google_play') {
    return { kind: 'denied', status: 400, error: 'store_platform_unknown' };
  }
  if (storeProductKind(params.productId) === null) return { kind: 'denied', status: 400, error: 'store_product_unknown' };
  const productId = params.productId as string;

  let purchase: VerifiedStorePurchase;
  try {
    purchase = params.platform === 'app_store'
      ? await deps.verifyAppStore(params.signedTransaction)
      : await deps.verifyPlay({ productId, purchaseToken: params.purchaseToken, packageName: params.packageName });
  } catch (error) {
    if (error instanceof StoreVerifyError) return { kind: 'denied', status: error.status, error: error.code };
    console.error('[store-purchase] verify failed', error instanceof Error ? error.message : error);
    return { kind: 'denied', status: 503, error: 'store_verification_unavailable' };
  }
  if (purchase.platform !== params.platform) return { kind: 'denied', status: 402, error: 'store_receipt_unverified' };
  const admitted = admitVerifiedPurchase(purchase, { requestedProductId: productId, userId: params.userId, acceptSandbox: deps.acceptSandbox });
  if (!admitted.ok) return { kind: 'denied', status: admitted.error === 'store_purchase_pending' ? 409 : 403, error: admitted.error };

  const key = storeTransactionKey(purchase.platform, purchase.transactionId);
  try {
    const existing = await readTx(deps.db, key);
    if (existing !== null) return await replay(deps, existing, params.userId);
    return admitted.kind === 'archive_gb'
      ? await creditArchive(deps, purchase, key, params.userId)
      : await recordSettleNow(deps, purchase, key, params.userId, params.payee);
  } finally {
    // Acknowledge on every presentation once the purchase is recorded, a replay and a failed
    // redemption included: Play refunds a purchase left unacknowledged for three days, and the
    // record (credited or held) is already the person's.
    if (purchase.platform === 'google_play' && typeof params.purchaseToken === 'string') {
      await acknowledgeIfRecorded(deps, key, productId, params.purchaseToken);
    }
  }
}

async function acknowledgeIfRecorded(deps: StorePurchaseDeps, key: string, productId: string, purchaseToken: string): Promise<void> {
  try {
    if ((await readTx(deps.db, key)) === null) return;
    await deps.acknowledgePlay({ productId, purchaseToken });
  } catch (error) {
    console.error('[store-purchase] play acknowledge failed', error instanceof Error ? error.message : error);
  }
}

async function replay(deps: StorePurchaseDeps, doc: StoreTransactionDoc, userId: string): Promise<StoreRedeemResult> {
  if (doc.user_id !== userId) return { kind: 'denied', status: 409, error: 'store_transaction_redeemed_elsewhere' };
  if (doc.kind === 'settle_now' && doc.state === 'held') {
    const after = await redeemHeldSettleNow(deps, doc.key);
    return after.kind === 'denied' ? after : { ...after, replayed: true };
  }
  return { kind: doc.state, replayed: true, transaction: doc, ...(await grantView(deps, doc)) };
}

async function grantView(deps: StorePurchaseDeps, doc: StoreTransactionDoc): Promise<{ account?: ArchiveAccountDoc | null; payout?: Record<string, unknown> | null }> {
  if (doc.kind === 'archive_gb') {
    const snap = await archiveAccountRef(deps.db, doc.wallet).get();
    return { account: snap.exists ? (snap.data() as ArchiveAccountDoc) : null };
  }
  if (doc.payout_request_id === null) return { payout: null };
  const snap = await deps.db.collection(PAYOUT_REQUESTS_COLLECTION).doc(doc.payout_request_id).get();
  return { payout: snap.exists ? publicPayoutView(snap.data() as PayoutRequestDoc) : null };
}

function baseDoc(purchase: VerifiedStorePurchase, key: string, kind: StoreProductKind, userId: string, wallet: string, nowMs: number): Omit<StoreTransactionDoc, 'state' | 'held_reason' | 'payout_request_id' | 'credited_bytes'> {
  return {
    schema: 'provian.store-transaction.v1',
    key,
    platform: purchase.platform,
    transaction_id: purchase.transactionId,
    product_id: purchase.productId,
    kind,
    environment: purchase.environment,
    user_id: userId,
    wallet,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
  };
}

async function creditArchive(deps: StorePurchaseDeps, purchase: VerifiedStorePurchase, key: string, userId: string): Promise<StoreRedeemResult> {
  const owner = await humanArchiveOwner(deps.db, userId);
  if (owner === null) return { kind: 'denied', status: 409, error: 'archive_owner_unresolved' };
  type Outcome = { readonly raced: StoreTransactionDoc } | { readonly doc: StoreTransactionDoc; readonly account: ArchiveAccountDoc };
  const outcome = await deps.db.runTransaction(async (txn): Promise<Outcome> => {
    const ref = txRef(deps.db, key);
    const snap = await txn.get(ref);
    if (snap.exists) return { raced: snap.data() as StoreTransactionDoc };
    const aRef = archiveAccountRef(deps.db, owner.wallet);
    const aSnap = await txn.get(aRef);
    const nowMs = deps.now();
    const account = archiveAccountWithOneMoreGb(aSnap.exists ? (aSnap.data() as ArchiveAccountDoc) : null, owner, nowMs);
    const doc: StoreTransactionDoc = {
      ...baseDoc(purchase, key, 'archive_gb', userId, owner.wallet, nowMs),
      state: 'credited',
      held_reason: null,
      payout_request_id: null,
      credited_bytes: ARCHIVE_GB_BYTES,
    };
    txn.set(aRef, account as unknown as Record<string, unknown>);
    txn.create(ref, doc as unknown as Record<string, unknown>);
    return { doc, account };
  });
  if ('raced' in outcome) return replay(deps, outcome.raced, userId);
  return { kind: 'credited', replayed: false, transaction: outcome.doc, account: outcome.account };
}

async function recordSettleNow(
  deps: StorePurchaseDeps,
  purchase: VerifiedStorePurchase,
  key: string,
  userId: string,
  requestedPayee: unknown,
): Promise<StoreRedeemResult> {
  const addresses = await humanPayeeAddresses(deps.db, userId);
  const requested = typeof requestedPayee === 'string' ? requestedPayee.toLowerCase() : null;
  const payee = requested ?? (addresses.length === 1 ? addresses[0] : null);
  if (payee === null || !addresses.includes(payee)) return { kind: 'denied', status: 400, error: 'payee_not_your_wallet' };
  const raced = await deps.db.runTransaction(async (txn) => {
    const ref = txRef(deps.db, key);
    const snap = await txn.get(ref);
    if (snap.exists) return snap.data() as StoreTransactionDoc;
    const nowMs = deps.now();
    const doc: StoreTransactionDoc = {
      ...baseDoc(purchase, key, 'settle_now', userId, payee, nowMs),
      state: 'held',
      held_reason: 'not_yet_redeemed',
      payout_request_id: null,
      credited_bytes: 0,
    };
    txn.create(ref, doc as unknown as Record<string, unknown>);
    return null;
  });
  if (raced !== null) return replay(deps, raced, userId);
  return redeemHeldSettleNow(deps, key);
}

/**
 * Spend a held Settle now on a settlement, if one can run now: the payout request is created
 * already paid and the purchase marked credited, in one transaction (once, ever). Otherwise the
 * purchase stays held with the reason.
 */
export async function redeemHeldSettleNow(deps: StorePurchaseDeps, key: string): Promise<StoreRedeemResult> {
  const doc = await readTx(deps.db, key);
  if (doc === null) return { kind: 'denied', status: 404, error: 'not_found' };
  if (doc.state !== 'held') return { kind: doc.state, replayed: false, transaction: doc, ...(await grantView(deps, doc)) };
  const payout = deps.payout();
  const pre = payout === null ? null : await precheckPayout(payout, doc.wallet);
  if (pre === null || pre.kind !== 'ok') {
    const reason = pre === null ? 'payout_not_configured' : pre.kind;
    await txRef(deps.db, key).update({ held_reason: reason, updated_at_ms: deps.now() });
    return { kind: 'held', replayed: false, transaction: { ...doc, held_reason: reason } };
  }
  const outcome = await deps.db.runTransaction(async (txn) => {
    const ref = txRef(deps.db, key);
    const snap = await txn.get(ref);
    const current = snap.data() as StoreTransactionDoc;
    if (current.state !== 'held') return current;
    const nowMs = deps.now();
    // One settlement per payee at a time: while an earlier payout request for this payee is still
    // being charged or settled, its claims still read as ready, and a second request would settle
    // nothing. The purchase stays held until that one finishes.
    const payeeRequests = await txn.get(deps.db.collection(PAYOUT_REQUESTS_COLLECTION).where('payee', '==', current.wallet));
    if (payeeRequests.docs.some((d) => PAYOUT_IN_FLIGHT.has((d.data() as PayoutRequestDoc).state))) {
      const waiting: StoreTransactionDoc = { ...current, held_reason: 'previous_settlement_in_flight', updated_at_ms: nowMs };
      txn.set(ref, waiting as unknown as Record<string, unknown>);
      return waiting;
    }
    const request = storePaidPayoutRequest({
      payee: current.wallet,
      requestedBy: current.user_id,
      platform: current.platform,
      storeTransactionKey: key,
      readyPointsAtomic: pre.work.pointsAtomic,
      nowMs,
    });
    txn.create(deps.db.collection(PAYOUT_REQUESTS_COLLECTION).doc(request.request_id), request as unknown as Record<string, unknown>);
    const credited: StoreTransactionDoc = { ...current, state: 'credited', held_reason: null, payout_request_id: request.request_id, updated_at_ms: nowMs };
    txn.set(ref, credited as unknown as Record<string, unknown>);
    return credited;
  });
  return { kind: outcome.state, replayed: false, transaction: outcome, ...(await grantView(deps, outcome)) };
}

/** This account's held Settle now purchases (unused, waiting for something to settle). */
export async function heldSettleNowKeys(db: Firestore, userId: string): Promise<string[]> {
  const snap = await db.collection(STORE_TRANSACTIONS_COLLECTION)
    .where('user_id', '==', userId).where('state', '==', 'held').limit(20).get();
  return snap.docs.map((d) => d.data() as StoreTransactionDoc).filter((d) => d.kind === 'settle_now')
    .sort((a, b) => a.created_at_ms - b.created_at_ms).map((d) => d.key);
}

/** What the app sees about a store purchase record. */
export function publicStoreTransactionView(doc: StoreTransactionDoc): Record<string, unknown> {
  return {
    key: doc.key,
    platform: doc.platform,
    product_id: doc.product_id,
    kind: doc.kind,
    state: doc.state,
    held_reason: doc.held_reason,
    payout_request_id: doc.payout_request_id,
    created_at_ms: doc.created_at_ms,
  };
}
