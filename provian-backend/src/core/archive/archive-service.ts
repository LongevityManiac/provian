/**
 * — the paid PE Archive, relay side.
 *
 * Opt-in per wallet. The owner's device seals each day of its PEs (with each PE's proof against
 * that day's anchor) to the owner — and, for an agent with a linked human, to that human — and
 * uploads the ciphertext here. The relay keeps ONE Archive-class object per uploaded part, written
 * once and never replaced (2026-10-07; days stored earlier keep their one object per wallet per
 * day), and a small index (`archive_days_v1`); it never holds anything it can read. Space is
 * bought in GB for $5 USDC over the shared USDC charge path (x402 for agents, the app wallet for
 * people), paid at turn-on and each time another GB is reached, kept while Provian operates the Archive.
 *
 * A day is CONFIRMED only when (1) every batch each part covers is anchored in that day's on-chain
 * root — read from the meter's batch record, or, for a batch older than the record's 30 days,
 * verified on Base with the proof the part carries — and then (2) the stored objects are exactly
 * the parts the index records: each part object's size and the MD5 Cloud Storage checked when it
 * was written (metadata only, so no Archive retrieval), and a pre-2026-10-07 day object streamed
 * back line by line. Anchoring is checked first so a day waiting for its anchor never reads the
 * bucket. Only a confirmed day may be dropped from an owner's devices (the devices also re-read it
 * themselves before dropping).
 *
 * NOTHING HERE DELETES AN ARCHIVED DAY OR ANY PE. When the paid space is used up and the next GB is
 * not paid, an upload is refused (402 `archive_space_exhausted`) and the day simply stays on the
 * owner's devices; turning the Archive off stops uploads and keeps everything stored.
 */
import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { PassThrough, type Readable } from 'stream';
import { METER_BATCHES_COLLECTION } from '../meter/meter-store';
import { meterAnchorBatchId } from '../meter/meter-anchor';
import { hashEnvelopeHashLeaf, verifyMerkleProof } from '../pvt/merkle';
import type { PeAnchorVerifyContract } from '../presentation/anchor-contract';
import {
  ARCHIVE_MAX_PART_BYTES,
  archiveDayId,
  archiveObjectPath,
  parseArchivePart,
  type ArchiveAnchorRef,
} from '../meter/pe-archive-wire';
import {
  awaitUsdcCharge,
  chargeStatusNow,
  submitUsdcCharge,
  usdcChargeRequirement,
  USDC_CHARGE_GAS,
  type UsdcChargePayment,
} from '../payments/usdc-charge';
import { recoverUsdcChargeSigner } from '../payments/usdc-charge-chain';
import type { UsdcChargeRuntimeDeps } from '../payments/usdc-charge-runtime';
import type { CdpFacilitator, CdpSettlementListing } from '../payments/cdp-facilitator';
import {
  ARCHIVE_ACCOUNTS_COLLECTION,
  ARCHIVE_DAYS_COLLECTION,
  ARCHIVE_FEE_USD,
  ARCHIVE_GB_BYTES,
  ARCHIVE_GB_FEE_USDC_ATOMIC,
  ARCHIVE_PAYMENTS_COLLECTION,
  ARCHIVE_SERVICE_TERMS,
  archiveGbPurchasable,
  archivePaymentRequestId,
  archiveChargedBytes,
  archiveSpaceFits,
  checkArchivePayment,
} from './archive-terms';
import { md5Base64, type ArchiveObjectStore } from './archive-objects';

/** An 'uploading' part older than this, never finished by its device, is settled by the sweep. */
export const ARCHIVE_STALE_UPLOAD_MS = 15 * 60_000;

// ─── records ────────────────────────────────────────────────────────────────────

/** Who an archive belongs to (resolved from the caller's auth, never from a request body). */
export interface ArchiveOwner {
  /** The account id: an agent's wallet id, or a person's `wallets/{doc}` id. */
  readonly wallet: string;
  readonly kind: 'agent' | 'human';
  /** The meter actor id every one of the owner's batch leaves commits to (agent_id / user_id). */
  readonly actorId: string;
  /** For an agent: its linked human's `wallets/{doc}` id (also a recipient), else null. */
  readonly linkedHumanWallet: string | null;
}

export interface ArchiveAccountDoc {
  readonly schema: 'provian.pe-archive-account.v1';
  readonly wallet: string;
  readonly owner_kind: 'agent' | 'human';
  readonly actor_id: string;
  readonly on: boolean;
  /** GB purchased × 10^9. */
  readonly paid_bytes: number;
  /** Ciphertext bytes stored (and reserved by an upload in progress). */
  readonly used_bytes: number;
  readonly gb_purchased: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly turned_on_at_ms: number | null;
  readonly turned_off_at_ms: number | null;
}

export type ArchivePaymentState = 'charging' | 'charge_unconfirmed' | 'charge_failed' | 'charged';

export interface ArchivePaymentDoc {
  readonly schema: 'provian.pe-archive-payment.v1';
  readonly request_id: string;
  readonly wallet: string;
  readonly owner_kind: 'agent' | 'human';
  readonly actor_id: string;
  readonly requested_by: string;
  readonly payer: string;
  readonly authorization_nonce: string;
  readonly fee_usdc_atomic: string;
  readonly state: ArchivePaymentState;
  /** The GB this payment bought has been added to the account (exactly once). */
  readonly credited: boolean;
  readonly credited_bytes: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly charge_tx_hash: string | null;
  /** The Base block when the request was made: where a search for its charge starts (absent on older requests). */
  readonly charge_from_block?: number | null;
  readonly charged_at_ms: number | null;
  readonly last_error: string | null;
  /** The x402 payment, kept so the sweep can re-check a charge whose receipt was not yet in. */
  readonly payment: UsdcChargePayment;
  /** Who submitted the charge (absent on payments made before 2026-10-07: the relay's gas key). */
  readonly settled_via?: 'relay_gas_key' | 'cdp_facilitator';
}

export interface ArchivePartBatch {
  readonly seq: number;
  readonly batch_hash: string;
  readonly batch_leaf: string;
  readonly acts_root: string;
  readonly actor_id: string;
  readonly first_index: number;
  readonly count: number;
  readonly anchor: ArchiveAnchorRef;
}

export interface ArchivePartRecord {
  readonly device_id: string;
  readonly part: number;
  readonly sha256: string;
  readonly bytes: number;
  /**
   * What this part counts against the paid space: `archiveChargedBytes(bytes)`, never less than
   * 1 MB. Absent on a part stored before the floor, which counted its own bytes.
   */
  readonly charged_bytes?: number;
  readonly pe_count: number;
  readonly state: 'uploading' | 'stored';
  readonly confirmed: boolean;
  readonly uploaded_at_ms: number;
  readonly stored_at_ms: number | null;
  readonly batches: readonly ArchivePartBatch[];
  /**
   * The part's own object (written once). Absent on a part stored before 2026-10-07, whose bytes
   * are inside the day's single object (`ArchiveDayDoc.object_path`).
   */
  readonly object_path?: string;
  /** Base64 MD5 of the part's bytes (what Cloud Storage checked at write). With `object_path`. */
  readonly md5_b64?: string;
}

export interface ArchiveDayDoc {
  readonly schema: 'provian.pe-archive-day.v1';
  readonly id: string;
  readonly wallet: string;
  readonly day: string;
  readonly bucket: string;
  /** The pre-2026-10-07 single day object (holds only parts without their own `object_path`). */
  readonly object_path: string;
  /** Parts in serving order (stored ones first, in the order they were stored). */
  readonly parts: readonly ArchivePartRecord[];
  readonly stored_bytes: number;
  readonly generation: string | null;
  readonly pe_count: number;
  /** Every part stored AND confirmed. */
  readonly confirmed: boolean;
  readonly confirmed_at_ms: number | null;
  /** A part whose batches do not match the meter's record can never be confirmed. */
  readonly rejected_reason: string | null;
  readonly last_check: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface ArchiveDeps {
  readonly db: Firestore;
  readonly objects: ArchiveObjectStore;
  /** The deployed PEAnchor (read-only) for batches older than the meter's 30-day batch record. */
  readonly anchor: PeAnchorVerifyContract | null;
  /**
   * The chain reads every charge uses (terms, balance, receipts, the sweep's search) and, before the
   * launch flip, the charge gas key that submits. Null while the gas key / RPC is not configured
   * (payments answer 503).
   */
  readonly charge: UsdcChargeRuntimeDeps | null;
  /** Who submits a new charge: the relay's gas key, or Coinbase's CDP facilitator. */
  readonly settlement: ArchiveSettlement;
  readonly now: () => number;
}

/**
 * Who settles a NEW Archive charge. Read per request, never at mount:
 * - `relay_gas_key` the shared charge gas key submits `transferWithAuthorization` (before the
 * launch flip; how every Archive charge settled until now);
 * - `cdp_facilitator` Coinbase's CDP facilitator settles it and pays the gas (from the flip), and
 * a settlement of the agent route carries the x402 Bazaar listing, which makes Coinbase's Bazaar
 * index the Archive. Nothing goes public before go, so this is tied to the flip itself.
 * Either way the chain decides whether the fee was paid (`chargeStatusNow`), and a payment already
 * in flight is finished by the same chain reads whoever submitted it.
 */
export interface ArchiveSettlement {
  readonly mode: () => 'relay_gas_key' | 'cdp_facilitator';
  /** Null when the CDP key is not configured: in `cdp_facilitator` mode payments then answer 503. */
  readonly cdp: CdpFacilitator | null;
}

// ─── reads ──────────────────────────────────────────────────────────────────────

function accountRef(db: Firestore, wallet: string) {
  return db.collection(ARCHIVE_ACCOUNTS_COLLECTION).doc(wallet);
}

function paymentRef(db: Firestore, requestId: string) {
  return db.collection(ARCHIVE_PAYMENTS_COLLECTION).doc(requestId);
}

function dayRef(db: Firestore, id: string) {
  return db.collection(ARCHIVE_DAYS_COLLECTION).doc(id);
}

export async function readArchiveAccount(db: Firestore, wallet: string): Promise<ArchiveAccountDoc | null> {
  const snap = await accountRef(db, wallet).get();
  return snap.exists ? (snap.data() as ArchiveAccountDoc) : null;
}

export async function readArchivePayment(db: Firestore, requestId: string): Promise<ArchivePaymentDoc | null> {
  const snap = await paymentRef(db, requestId).get();
  return snap.exists ? (snap.data() as ArchivePaymentDoc) : null;
}

/** An owner's payments, newest first (a wallet makes few; single-field equality, no composite index). */
export async function listArchivePayments(db: Firestore, wallet: string, limit = 100): Promise<ArchivePaymentDoc[]> {
  const snap = await db.collection(ARCHIVE_PAYMENTS_COLLECTION).where('wallet', '==', wallet).limit(500).get();
  return snap.docs
    .map((d) => d.data() as ArchivePaymentDoc)
    .sort((a, b) => b.created_at_ms - a.created_at_ms)
    .slice(0, Math.max(1, Math.min(500, limit)));
}

/**
 * Where a part's object lives: one object per part, named by its content hash so a re-sealed retry
 * of the same part number can never land on (and never needs to replace) an existing object.
 */
export function archivePartObjectPath(wallet: string, day: string, deviceId: string, part: number, sha256: string): string {
  archiveObjectPath(wallet, day); // the wire's wallet + day check (throws archive_object_path_invalid)
  if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isInteger(part) || part < 0 || deviceId.length === 0) {
    throw new Error('archive_part_path_invalid');
  }
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `v2/${safe(wallet)}/${day}/${safe(deviceId)}.${part}.${sha256}.pea`;
}

/** The stored parts kept inside the pre-2026-10-07 single day object. */
function legacyStoredBytes(day: ArchiveDayDoc): number {
  return day.parts.filter((p) => p.object_path === undefined && p.state === 'stored').reduce((s, p) => s + p.bytes, 0);
}

/**
 * The day as one NDJSON stream: its stored parts in index order. Consecutive pre-2026-10-07 parts
 * come from the single day object (which holds exactly those parts); every other part from its own
 * object. Each object is read once per call; the bytes are what a reader always received.
 */
export function openArchiveDayStream(objects: ArchiveObjectStore, day: ArchiveDayDoc): Readable {
  const segments: string[] = [];
  let legacyQueued = false;
  for (const p of day.parts) {
    if (p.state !== 'stored') continue;
    if (p.object_path === undefined) {
      if (!legacyQueued) segments.push(day.object_path);
      legacyQueued = true;
    } else {
      segments.push(p.object_path);
    }
  }
  const out = new PassThrough();
  // When the reader goes away (the client disconnected and the caller destroyed `out`), stop: the
  // object being read is destroyed and no later part is opened, so a dropped download never keeps
  // reading (and paying retrieval for) the rest of the day.
  let closed = false;
  let current: Readable | null = null;
  let stopWaiting: (() => void) | null = null;
  out.once('close', () => {
    closed = true;
    current?.destroy();
    stopWaiting?.();
  });
  void (async () => {
    try {
      for (const path of segments) {
        if (closed) return;
        await new Promise<void>((resolve, reject) => {
          const src = objects.openRead(path);
          current = src;
          stopWaiting = resolve;
          src.on('error', (error) => (closed ? resolve() : reject(error)));
          src.on('end', resolve);
          src.on('close', () => { if (closed) resolve(); });
          src.pipe(out, { end: false });
        });
        current = null;
        stopWaiting = null;
      }
      if (!closed) out.end();
    } catch (error) {
      if (!closed) out.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  })();
  return out;
}

export async function readArchiveDay(db: Firestore, wallet: string, day: string): Promise<ArchiveDayDoc | null> {
  const snap = await dayRef(db, archiveDayId(wallet, day)).get();
  return snap.exists ? (snap.data() as ArchiveDayDoc) : null;
}

/** A wallet's archived days, oldest first, after `afterDay` (exclusive). Indexed (wallet, day). */
export async function listArchiveDays(db: Firestore, wallet: string, afterDay: string | null, limit = 100): Promise<ArchiveDayDoc[]> {
  let query = db.collection(ARCHIVE_DAYS_COLLECTION).where('wallet', '==', wallet).orderBy('day', 'asc');
  if (afterDay !== null) query = query.startAfter(afterDay);
  const snap = await query.limit(Math.max(1, Math.min(500, limit))).get();
  return snap.docs.map((d) => d.data() as ArchiveDayDoc);
}

/** What an owner (or their app) sees about the account. */
export function publicArchiveAccount(account: ArchiveAccountDoc | null): Record<string, unknown> {
  const paid = account?.paid_bytes ?? 0;
  const used = account?.used_bytes ?? 0;
  return {
    on: account?.on === true,
    paid_bytes: paid,
    used_bytes: used,
    free_bytes: Math.max(0, paid - used),
    gb_purchased: account?.gb_purchased ?? 0,
    turned_on_at_ms: account?.turned_on_at_ms ?? null,
    gb_bytes: ARCHIVE_GB_BYTES,
    price_usdc_per_gb: '5.00',
    space_exhausted: account !== null && account.on && used >= paid,
    next_gb_purchasable: archiveGbPurchasable(account),
    note: 'Your PEs stay yours: the Archive keeps encrypted days you choose to pay for ($5 USDC per GB, kept for as long as Provian operates the Archive; each part a device uploads, normally one a day, counts as at least 1 MB). With it on, your devices keep the most recent 30 days and pull older days from the Archive when needed. When the paid space is used up and the next GB is not paid, new days stay on your devices; nothing is deleted.',
  };
}

export function publicArchiveDay(day: ArchiveDayDoc): Record<string, unknown> {
  return {
    wallet: day.wallet,
    day: day.day,
    bytes: day.stored_bytes,
    pe_count: day.pe_count,
    confirmed: day.confirmed,
    confirmed_at_ms: day.confirmed_at_ms,
    rejected_reason: day.rejected_reason,
    parts: day.parts.map((p) => ({
      device_id: p.device_id,
      part: p.part,
      sha256: p.sha256,
      bytes: p.bytes,
      pe_count: p.pe_count,
      state: p.state,
      confirmed: p.confirmed,
      batches: p.batches.map((b) => ({ seq: b.seq, batch_hash: b.batch_hash, first_index: b.first_index, count: b.count })),
    })),
    // Owner-authenticated proof metadata, never PE content. Ciphertext objects are immutable.
    proof_repairs: day.parts.filter(p => p.state === 'stored').flatMap(p => p.batches.map(b => ({ ...b, device_id: p.device_id }))),
  };
}

export function publicArchivePayment(p: ArchivePaymentDoc): Record<string, unknown> {
  return {
    request_id: p.request_id,
    wallet: p.wallet,
    state: p.state,
    credited: p.credited,
    fee_usdc: '5.00',
    credited_bytes: p.credited_bytes,
    charge_tx_hash: p.charge_tx_hash,
    created_at_ms: p.created_at_ms,
    charged_at_ms: p.charged_at_ms,
    payer: p.payer,
    settled_via: p.settled_via ?? 'relay_gas_key',
    last_error: p.state === 'charge_failed' ? p.last_error : null,
    note: p.state === 'charge_failed'
      ? 'The fee was not taken. Nothing was charged.'
      : p.credited
        ? 'Paid: one more GB of Archive space, kept for as long as Provian operates the Archive.'
        : 'Charged; adding the GB to your Archive. This finishes automatically.',
  };
}

// ─── payments ───────────────────────────────────────────────────────────────────

export type ArchivePayResponse =
  | { readonly kind: 'payment_required'; readonly error?: string; readonly account: ArchiveAccountDoc | null }
  | { readonly kind: 'space_available'; readonly account: ArchiveAccountDoc }
  | { readonly kind: 'waits_for_gas'; readonly costUsd: number }
  | { readonly kind: 'not_your_request' }
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'payment'; readonly payment: ArchivePaymentDoc; readonly account: ArchiveAccountDoc | null };

/**
 * The charge's own gas (one `transferWithAuthorization`), with headroom and its L1 fee bound. When
 * Coinbase's CDP facilitator settles, it pays the gas: nothing for the relay to cover (and when CDP is
 * the settler but its key is absent, nothing can be charged, so the quote says not covered).
 */
export async function archiveChargeCovered(
  charge: UsdcChargeRuntimeDeps,
  settlement: ArchiveSettlement,
): Promise<{ covered: boolean; costUsd: number }> {
  if (settlement.mode() === 'cdp_facilitator') {
    // CDP pays the gas — but only a configured CDP can: without its key nothing can be charged now.
    return settlement.cdp === null ? { covered: false, costUsd: Number.POSITIVE_INFINITY } : { covered: true, costUsd: 0 };
  }
  const gasPrice = await charge.chain.gasPriceWei();
  const costWei = (USDC_CHARGE_GAS * gasPrice * 15_000n) / 10_000n + await charge.chain.l1FeeUpperBoundWei(400);
  const ethUsd = await charge.ethUsd();
  if (ethUsd === null || !Number.isFinite(ethUsd) || ethUsd <= 0) return { covered: false, costUsd: Number.POSITIVE_INFINITY };
  const costUsd = (Number(costWei) / 1e18) * ethUsd;
  return { covered: costUsd <= ARCHIVE_FEE_USD, costUsd };
}

/**
 * The charge runtime that submits THIS charge: the gas-key runtime as it is, or the same chain reads
 * with the submit handed to Coinbase's CDP facilitator (no gas-key lease: CDP holds the nonce). CDP
 * is sent the relay's own requirement and the route's `listing`, never anything from the client.
 */
function submittingRuntime(
  charge: UsdcChargeRuntimeDeps,
  viaCdp: CdpFacilitator | null,
  listing: CdpSettlementListing,
): UsdcChargeRuntimeDeps {
  if (viaCdp === null) return charge;
  const requirement = usdcChargeRequirement(ARCHIVE_SERVICE_TERMS);
  return {
    ...charge,
    chain: { ...charge.chain, submitCharge: (payment) => viaCdp.settle(payment, requirement, listing) },
    withGasKeyLease: (fn) => fn(),
  };
}

/**
 * Buy one GB (at turn-on, or the next one). `paymentHeader` undefined → the quote. Nothing is
 * charged unless the GB is purchasable now (turn-on, or within the top-up window of the paid
 * space) and the charge's gas is known and covered (or paid by CDP). `listing` is what a CDP
 * settlement declares for the route (`archiveAgentListing` / `archiveHumanListing`).
 */
export async function requestArchiveGb(
  deps: ArchiveDeps,
  params: {
    readonly owner: ArchiveOwner;
    readonly requestedBy: string;
    readonly paymentHeader: string | undefined;
    readonly listing: CdpSettlementListing;
  },
): Promise<ArchivePayResponse> {
  const { owner } = params;
  const account = await readArchiveAccount(deps.db, owner.wallet);
  if (params.paymentHeader === undefined) {
    if (!archiveGbPurchasable(account)) return { kind: 'space_available', account: account! };
    return { kind: 'payment_required', account };
  }
  const charge = deps.charge;
  if (charge === null) return { kind: 'not_configured' };
  const terms = checkArchivePayment(params.paymentHeader, Math.floor(deps.now() / 1000));
  if (!terms.ok) return { kind: 'payment_required', error: terms.reason, account };
  const payment = terms.payment;
  let signer: string;
  try {
    signer = recoverUsdcChargeSigner(payment);
  } catch {
    return { kind: 'payment_required', error: 'payment_signature_invalid', account };
  }
  if (signer !== payment.authorization.from) return { kind: 'payment_required', error: 'payment_signature_invalid', account };
  const requestId = archivePaymentRequestId(payment.authorization);

  // A retried paid request lands on its own document: report it (and finish it if it can be).
  const existing = await readArchivePayment(deps.db, requestId);
  if (existing !== null) {
    if (existing.wallet !== owner.wallet || existing.requested_by !== params.requestedBy) return { kind: 'not_your_request' };
    const advanced = await advanceArchivePayment(deps, requestId);
    return { kind: 'payment', payment: advanced, account: await readArchiveAccount(deps.db, owner.wallet) };
  }

  if (!archiveGbPurchasable(account)) return { kind: 'space_available', account: account! };
  // A NEW charge only: a retried request above is finished by chain reads, whoever submitted it.
  const viaCdp = deps.settlement.mode() === 'cdp_facilitator';
  if (viaCdp && deps.settlement.cdp === null) return { kind: 'not_configured' };
  const gas = await archiveChargeCovered(charge, deps.settlement);
  if (!gas.covered) return { kind: 'waits_for_gas', costUsd: gas.costUsd };
  if (await charge.chain.authorizationUsed(payment.authorization.from, payment.authorization.nonce)) {
    return { kind: 'payment_required', error: 'payment_nonce_used', account };
  }
  if ((await charge.chain.usdcBalance(payment.authorization.from)) < ARCHIVE_GB_FEE_USDC_ATOMIC) {
    return { kind: 'payment_required', error: 'payment_insufficient_funds', account };
  }

  // The block a later search for this charge starts from (chain truth, not the relay's clock).
  const fromBlock = await charge.chain.headBlock().catch(() => null);
  const nowMs = deps.now();
  const doc: ArchivePaymentDoc = {
    schema: 'provian.pe-archive-payment.v1',
    request_id: requestId,
    wallet: owner.wallet,
    owner_kind: owner.kind,
    actor_id: owner.actorId,
    requested_by: params.requestedBy,
    payer: payment.authorization.from,
    authorization_nonce: payment.authorization.nonce,
    fee_usdc_atomic: ARCHIVE_GB_FEE_USDC_ATOMIC.toString(10),
    state: 'charging',
    credited: false,
    credited_bytes: 0,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
    charge_tx_hash: null,
    charge_from_block: fromBlock,
    charged_at_ms: null,
    last_error: null,
    payment,
    settled_via: viaCdp ? 'cdp_facilitator' : 'relay_gas_key',
  };
  try {
    await paymentRef(deps.db, requestId).create(doc as unknown as Record<string, unknown>);
  } catch {
    const raced = await readArchivePayment(deps.db, requestId);
    if (raced === null) throw new Error('archive_payment_create_failed');
    return { kind: 'payment', payment: raced, account };
  }

  const submitter = submittingRuntime(charge, viaCdp ? deps.settlement.cdp : null, params.listing);
  const submitted = await submitUsdcCharge(submitter, payment);
  if (submitted.kind === 'not_submitted') {
    // "Failed" only when this request broadcast nothing and the authorization is unused; a submit
    // that threw may still land, so it stays unconfirmed until the chain decides (the sweep).
    // Written only while still `charging`: a sweep or poll may have found the charge meanwhile.
    const wrote = await updatePaymentIf(deps, requestId, ['charging'], {
      state: submitted.mayBeCharged ? 'charge_unconfirmed' : 'charge_failed',
      last_error: submitted.reason,
      updated_at_ms: deps.now(),
    });
    if (!submitted.mayBeCharged && wrote) return { kind: 'payment_required', error: 'payment_submit_failed', account };
    const now = await advanceArchivePayment(deps, requestId);
    return { kind: 'payment', payment: now, account: await readArchiveAccount(deps.db, owner.wallet) };
  }
  await updatePaymentIf(deps, requestId, ['charging'], {
    state: 'charge_unconfirmed', charge_tx_hash: submitted.txHash, updated_at_ms: deps.now(),
  });
  await awaitUsdcCharge(charge, submitted.txHash, payment);
  const after = await advanceArchivePayment(deps, requestId);
  return { kind: 'payment', payment: after, account: await readArchiveAccount(deps.db, owner.wallet) };
}

/**
 * Update a payment only while it is still in one of `from` (a transaction). The request handler,
 * the sweep and a polling GET all advance the same payment; a blind write from one could pull a
 * payment another already confirmed (or credited) back to an earlier state.
 */
async function updatePaymentIf(
  deps: ArchiveDeps,
  requestId: string,
  from: readonly ArchivePaymentState[],
  patch: Partial<ArchivePaymentDoc>,
): Promise<boolean> {
  return deps.db.runTransaction(async (txn) => {
    const ref = paymentRef(deps.db, requestId);
    const snap = await txn.get(ref);
    if (!snap.exists || !from.includes((snap.data() as ArchivePaymentDoc).state)) return false;
    txn.update(ref, patch as Record<string, unknown>);
    return true;
  });
}

/** A person's archive owner: their `wallets/{doc}` (the first, as the archive routes have always resolved it). */
async function humanWalletDocId(db: Firestore, userId: string): Promise<string | null> {
  const snap = await db.collection('wallets').where('user_id', '==', userId).limit(1).get();
  return snap.docs[0]?.id ?? null;
}

export async function humanArchiveOwner(db: Firestore, userId: string): Promise<ArchiveOwner | null> {
  const wallet = await humanWalletDocId(db, userId);
  return wallet === null ? null : { wallet, kind: 'human', actorId: userId, linkedHumanWallet: null };
}

/**
 * The account after one more paid GB: the paid space up by 10^9 bytes and the Archive on. The one
 * definition of what a GB grants, whether USDC or an app-store purchase paid for it.
 */
export function archiveAccountWithOneMoreGb(
  prior: ArchiveAccountDoc | null,
  owner: Pick<ArchiveOwner, 'wallet' | 'kind' | 'actorId'>,
  nowMs: number,
): ArchiveAccountDoc {
  return {
    schema: 'provian.pe-archive-account.v1',
    wallet: owner.wallet,
    owner_kind: owner.kind,
    actor_id: prior?.actor_id ?? owner.actorId,
    on: true,
    paid_bytes: (prior?.paid_bytes ?? 0) + ARCHIVE_GB_BYTES,
    used_bytes: prior?.used_bytes ?? 0,
    gb_purchased: (prior?.gb_purchased ?? 0) + 1,
    created_at_ms: prior?.created_at_ms ?? nowMs,
    updated_at_ms: nowMs,
    turned_on_at_ms: prior?.on === true ? prior.turned_on_at_ms : nowMs,
    turned_off_at_ms: prior?.turned_off_at_ms ?? null,
  };
}

/** The account document's reference (`archive_accounts_v1/{wallet}`). */
export function archiveAccountRef(db: Firestore, wallet: string) {
  return accountRef(db, wallet);
}

/**
 * Add the paid GB to the account, exactly once per payment (one transaction moves the payment to
 * `charged + credited` and the account's paid space up by 10^9 bytes, turning the Archive on).
 */
async function creditArchivePayment(deps: ArchiveDeps, requestId: string): Promise<void> {
  await deps.db.runTransaction(async (txn) => {
    const pSnap = await txn.get(paymentRef(deps.db, requestId));
    if (!pSnap.exists) throw new Error(`archive_payment_missing:${requestId}`);
    const payment = pSnap.data() as ArchivePaymentDoc;
    if (payment.credited) {
      // Credited once already; a state some racing write left behind is put right, nothing more.
      if (payment.state !== 'charged') txn.update(pSnap.ref, { state: 'charged', updated_at_ms: deps.now() });
      return;
    }
    const aRef = accountRef(deps.db, payment.wallet);
    const aSnap = await txn.get(aRef);
    const nowMs = deps.now();
    const prior = aSnap.exists ? (aSnap.data() as ArchiveAccountDoc) : null;
    const account = archiveAccountWithOneMoreGb(prior, { wallet: payment.wallet, kind: payment.owner_kind, actorId: payment.actor_id }, nowMs);
    txn.set(aRef, account as unknown as Record<string, unknown>);
    txn.update(paymentRef(deps.db, requestId), {
      state: 'charged',
      credited: true,
      credited_bytes: ARCHIVE_GB_BYTES,
      charged_at_ms: payment.charged_at_ms ?? nowMs,
      updated_at_ms: nowMs,
    });
  });
}

/** Move one payment as far as it can go now: confirm the charge, then credit the GB. Idempotent. */
export async function advanceArchivePayment(deps: ArchiveDeps, requestId: string): Promise<ArchivePaymentDoc> {
  let payment = await readArchivePayment(deps.db, requestId);
  if (payment === null) throw new Error(`archive_payment_missing:${requestId}`);
  if ((payment.state === 'charging' || payment.state === 'charge_unconfirmed') && deps.charge !== null) {
    const { status, txHash } = await chargeStatusNow(deps.charge, {
      txHash: payment.charge_tx_hash, payment: payment.payment,
      since: { block: payment.charge_from_block ?? null, ms: payment.created_at_ms },
    });
    if (status === 'confirmed') {
      if (txHash !== null && txHash !== payment.charge_tx_hash) {
        await updatePaymentIf(deps, requestId, ['charging', 'charge_unconfirmed'], { charge_tx_hash: txHash, updated_at_ms: deps.now() });
      }
      await creditArchivePayment(deps, requestId);
    } else if (status === 'reverted') {
      await updatePaymentIf(deps, requestId, ['charging', 'charge_unconfirmed'], { state: 'charge_failed', last_error: 'charge_reverted', updated_at_ms: deps.now() });
    }
    payment = (await readArchivePayment(deps.db, requestId))!;
  }
  if (payment.state === 'charged' && !payment.credited) {
    await creditArchivePayment(deps, requestId);
    payment = (await readArchivePayment(deps.db, requestId))!;
  }
  return payment;
}

/** Turn the Archive on (only when paid space remains — otherwise it is bought) or off. */
export async function setArchiveOn(
  deps: ArchiveDeps,
  owner: ArchiveOwner,
  on: boolean,
): Promise<{ kind: 'ok'; account: ArchiveAccountDoc } | { kind: 'payment_required'; account: ArchiveAccountDoc | null }> {
  return deps.db.runTransaction(async (txn) => {
    const ref = accountRef(deps.db, owner.wallet);
    const snap = await txn.get(ref);
    const prior = snap.exists ? (snap.data() as ArchiveAccountDoc) : null;
    if (on && (prior === null || prior.used_bytes >= prior.paid_bytes)) return { kind: 'payment_required' as const, account: prior };
    if (prior === null) {
      // Off for a wallet that never turned it on: nothing to record.
      const empty: ArchiveAccountDoc = {
        schema: 'provian.pe-archive-account.v1', wallet: owner.wallet, owner_kind: owner.kind, actor_id: owner.actorId,
        on: false, paid_bytes: 0, used_bytes: 0, gb_purchased: 0, created_at_ms: deps.now(), updated_at_ms: deps.now(),
        turned_on_at_ms: null, turned_off_at_ms: null,
      };
      return { kind: 'ok' as const, account: empty };
    }
    const nowMs = deps.now();
    const next: ArchiveAccountDoc = {
      ...prior,
      on,
      updated_at_ms: nowMs,
      turned_on_at_ms: on && !prior.on ? nowMs : prior.turned_on_at_ms,
      turned_off_at_ms: !on && prior.on ? nowMs : prior.turned_off_at_ms,
    };
    txn.set(ref, next as unknown as Record<string, unknown>);
    return { kind: 'ok' as const, account: next };
  });
}

// ─── uploads ────────────────────────────────────────────────────────────────────

export type ArchiveUploadResult =
  | { readonly kind: 'stored'; readonly day: ArchiveDayDoc; readonly idempotent: boolean }
  | { readonly kind: 'refused'; readonly http: number; readonly error: string; readonly detail?: string }
  | { readonly kind: 'space_exhausted'; readonly account: ArchiveAccountDoc };

function emptyDay(deps: ArchiveDeps, wallet: string, day: string): ArchiveDayDoc {
  const nowMs = deps.now();
  return {
    schema: 'provian.pe-archive-day.v1',
    id: archiveDayId(wallet, day),
    wallet,
    day,
    bucket: deps.objects.bucket,
    object_path: archiveObjectPath(wallet, day),
    parts: [],
    stored_bytes: 0,
    generation: null,
    pe_count: 0,
    confirmed: false,
    confirmed_at_ms: null,
    rejected_reason: null,
    last_check: null,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Store one part of one of the owner's days. The relay checks the header (whose day, which device,
 * which batches — each batch leaf recomputed and committed to this owner's actor id), refuses a
 * part that would pass the paid space (402, nothing written), reserves the space and records the
 * part, writes it to the day's object, then tries to confirm the day.
 */
export async function storeArchivePart(
  deps: ArchiveDeps,
  params: { readonly owner: ArchiveOwner; readonly deviceId: string; readonly bytes: Uint8Array },
): Promise<ArchiveUploadResult> {
  const { owner, deviceId, bytes } = params;
  if (bytes.length === 0 || bytes.length > ARCHIVE_MAX_PART_BYTES) return { kind: 'refused', http: 413, error: 'archive_part_too_large' };
  const parsed = parseArchivePart(bytes);
  if (!parsed.ok) return { kind: 'refused', http: 400, error: 'archive_part_invalid', detail: parsed.error };
  const header = parsed.header;
  if (header.wallet !== owner.wallet) return { kind: 'refused', http: 403, error: 'archive_part_not_your_wallet' };
  if (header.device_id !== deviceId) return { kind: 'refused', http: 403, error: 'archive_part_not_this_device' };
  if (header.batches.some((b) => b.actor_id !== owner.actorId)) return { kind: 'refused', http: 403, error: 'archive_part_not_your_batches' };
  if (!header.recipients.some((r) => r.party_id === owner.wallet)) return { kind: 'refused', http: 400, error: 'archive_part_not_sealed_to_owner' };

  const id = archiveDayId(owner.wallet, header.day);
  const sha = parsed.sha256;
  type Reserve =
    | { kind: 'reserved'; day: ArchiveDayDoc; resume: boolean }
    | { kind: 'stored'; day: ArchiveDayDoc }
    | { kind: 'refused'; http: number; error: string }
    | { kind: 'space_exhausted'; account: ArchiveAccountDoc };
  const reserve = await deps.db.runTransaction(async (txn): Promise<Reserve> => {
    const aSnap = await txn.get(accountRef(deps.db, owner.wallet));
    const account = aSnap.exists ? (aSnap.data() as ArchiveAccountDoc) : null;
    if (account === null || account.paid_bytes <= 0) return { kind: 'refused', http: 402, error: 'archive_not_on' };
    const dSnap = await txn.get(dayRef(deps.db, id));
    const day = dSnap.exists ? (dSnap.data() as ArchiveDayDoc) : emptyDay(deps, owner.wallet, header.day);
    const same = day.parts.find((p) => p.device_id === header.device_id && p.part === header.part);
    if (same !== undefined) {
      if (same.sha256 !== sha) return { kind: 'refused', http: 409, error: 'archive_part_conflict' };
      if (same.state === 'stored') return { kind: 'stored', day };
      return { kind: 'reserved', day, resume: true };
    }
    if (!account.on) return { kind: 'refused', http: 409, error: 'archive_off' };
    if (day.parts.some((p) => p.state === 'uploading')) return { kind: 'refused', http: 409, error: 'archive_day_busy' };
    const archived = new Set(day.parts.filter((p) => p.device_id === header.device_id).flatMap((p) => p.batches.map((b) => b.seq)));
    if (header.batches.some((b) => archived.has(b.seq))) return { kind: 'refused', http: 409, error: 'archive_batch_already_archived' };
    const charged = archiveChargedBytes(bytes.length);
    if (!archiveSpaceFits(account, charged)) return { kind: 'space_exhausted', account };
    const nowMs = deps.now();
    const part: ArchivePartRecord = {
      device_id: header.device_id,
      part: header.part,
      sha256: sha,
      bytes: bytes.length,
      charged_bytes: charged,
      pe_count: header.pe_count,
      state: 'uploading',
      confirmed: false,
      uploaded_at_ms: nowMs,
      stored_at_ms: null,
      batches: header.batches.map((b) => ({
        seq: b.seq, batch_hash: b.batch_hash, batch_leaf: b.batch_leaf, acts_root: b.acts_root, actor_id: b.actor_id,
        first_index: b.first_index, count: b.count, anchor: b.anchor,
      })),
      object_path: archivePartObjectPath(owner.wallet, header.day, header.device_id, header.part, sha),
      md5_b64: md5Base64(bytes),
    };
    const next: ArchiveDayDoc = { ...day, parts: [...day.parts, part], confirmed: false, updated_at_ms: nowMs };
    txn.set(dayRef(deps.db, id), next as unknown as Record<string, unknown>);
    txn.update(accountRef(deps.db, owner.wallet), { used_bytes: account.used_bytes + charged, updated_at_ms: nowMs });
    return { kind: 'reserved', day: next, resume: false };
  });
  if (reserve.kind === 'refused') return { kind: 'refused', http: reserve.http, error: reserve.error };
  if (reserve.kind === 'space_exhausted') return { kind: 'space_exhausted', account: reserve.account };
  if (reserve.kind === 'stored') return { kind: 'stored', day: reserve.day, idempotent: true };

  const landed = await writePartToObject(deps, reserve.day, header.device_id, header.part, bytes);
  if (landed.kind === 'refused') return landed;
  await confirmArchiveDay(deps, owner.wallet, header.day).catch(() => undefined);
  const day = (await readArchiveDay(deps.db, owner.wallet, header.day))!;
  return { kind: 'stored', day, idempotent: reserve.resume };
}

/**
 * Put an 'uploading' part's bytes into storage and mark it stored. Idempotent across a crash.
 *
 * A part with its own object (every part reserved since 2026-10-07): the object is created once;
 * if it is already there with this part's size and MD5 it landed before a crash and only the index
 * is behind. A part reserved before 2026-10-07 (no `object_path`): if its bytes already landed at
 * the tail of the old day object it is marked stored as it is; otherwise it is given its own object
 * now. Nothing is ever appended to, composed into or replaced.
 */
async function writePartToObject(
  deps: ArchiveDeps,
  day: ArchiveDayDoc,
  deviceId: string,
  partNo: number,
  bytes: Uint8Array,
): Promise<{ kind: 'stored' } | { kind: 'refused'; http: number; error: string }> {
  const record = day.parts.find((p) => p.device_id === deviceId && p.part === partNo);
  if (record === undefined) return { kind: 'refused', http: 409, error: 'archive_part_not_reserved' };
  let assign: { object_path: string; md5_b64: string } | null = null;
  let target = record.object_path !== undefined && record.md5_b64 !== undefined
    ? { object_path: record.object_path, md5_b64: record.md5_b64 }
    : null;

  if (target === null) {
    const base = legacyStoredBytes(day);
    const stat = await deps.objects.stat(day.object_path);
    if (stat !== null && stat.size === base + bytes.length
      && sha256Hex(await deps.objects.readRange(day.object_path, base, base + bytes.length)) === sha256Hex(bytes)) {
      await markPartStored(deps, day.id, deviceId, partNo, null);
      return { kind: 'stored' };
    }
    assign = { object_path: archivePartObjectPath(day.wallet, day.day, deviceId, partNo, record.sha256), md5_b64: md5Base64(bytes) };
    target = assign;
  }

  // Create first (one write); only an object that is already there is looked at.
  let landed: Awaited<ReturnType<ArchiveObjectStore['stat']>>;
  try {
    landed = await deps.objects.create(target.object_path, bytes);
  } catch (error) {
    if (!(error instanceof Error && error.message === 'archive_object_exists')) throw error;
    landed = await deps.objects.stat(target.object_path);
  }
  if (landed === null || landed.size !== bytes.length || landed.md5 !== target.md5_b64) {
    await dayRef(deps.db, day.id).update({
      last_check: `part_object_inconsistent:${deviceId}:${partNo}:size=${landed?.size ?? 'none'}`,
      updated_at_ms: deps.now(),
    });
    return { kind: 'refused', http: 409, error: 'archive_object_inconsistent' };
  }
  await markPartStored(deps, day.id, deviceId, partNo, assign);
  return { kind: 'stored' };
}

/** One transaction: the part is stored (with its object, if just assigned) and the day's totals move. */
async function markPartStored(
  deps: ArchiveDeps,
  dayId: string,
  deviceId: string,
  partNo: number,
  assign: { object_path: string; md5_b64: string } | null,
): Promise<void> {
  await deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(dayRef(deps.db, dayId));
    const current = snap.data() as ArchiveDayDoc;
    const nowMs = deps.now();
    let added = 0;
    let pes = 0;
    const parts = current.parts.map((p) => {
      if (p.device_id === deviceId && p.part === partNo && p.state === 'uploading') {
        added = p.bytes;
        pes = p.pe_count;
        return { ...p, ...(assign ?? {}), state: 'stored' as const, stored_at_ms: nowMs };
      }
      return p;
    });
    if (added === 0) return;
    txn.update(dayRef(deps.db, dayId), {
      parts,
      stored_bytes: current.stored_bytes + added,
      pe_count: current.pe_count + pes,
      confirmed: false,
      updated_at_ms: nowMs,
    });
  });
}

// ─── confirmation ───────────────────────────────────────────────────────────────

/** Stream an object and hash it line by line (bounded memory: never a whole part in memory). */
async function streamLineDigests(stream: Readable): Promise<{ lines: { sha256: string; bytes: number }[]; torn: boolean }> {
  const lines: { sha256: string; bytes: number }[] = [];
  let hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl === -1) {
        hash.update(buf.subarray(start));
        size += buf.length - start;
        break;
      }
      hash.update(buf.subarray(start, nl + 1));
      size += nl + 1 - start;
      lines.push({ sha256: hash.digest('hex'), bytes: size });
      hash = createHash('sha256');
      size = 0;
      start = nl + 1;
    }
  }
  return { lines, torn: size !== 0 };
}

type BatchCheck = 'anchored' | 'pending' | { mismatch: string };

export async function checkBatchAnchored(deps: ArchiveDeps, day: string, deviceId: string, b: ArchivePartBatch, record: Record<string, unknown> | undefined): Promise<BatchCheck> {
  try {
    if (b.anchor.day !== day || meterAnchorBatchId(day, b.anchor.segment) !== b.anchor.anchor_batch_id.toLowerCase()) return { mismatch: `batch_anchor_id_differs:${b.seq}` };
    if (!verifyMerkleProof(hashEnvelopeHashLeaf(b.batch_leaf), [...b.anchor.proof], b.anchor.merkle_root)) return { mismatch: `batch_anchor_proof_invalid:${b.seq}` };
  } catch { return { mismatch: `batch_anchor_malformed:${b.seq}` }; }
  if (record !== undefined) {
    if (record.device_id !== deviceId || record.actor_id !== b.actor_id || record.batch_leaf !== b.batch_leaf
      || record.acts_root !== b.acts_root || record.seq !== b.seq) {
      return { mismatch: `batch_record_differs:${b.seq}` };
    }
    if (record.anchored !== true) return 'pending';
    const anchor = record.anchor as { day?: unknown; anchor_batch_id?: unknown; merkle_root?: unknown } | undefined;
    if (anchor?.day !== day) return { mismatch: `batch_anchored_other_day:${b.seq}` };
    if (anchor.anchor_batch_id === b.anchor.anchor_batch_id && anchor.merkle_root === b.anchor.merkle_root) return 'anchored';
  }
  // The meter keeps a batch record for 30 days after anchoring; an older batch (history uploaded
  // later) is proven on Base with the anchor proof the part carries.
  if (deps.anchor === null) return 'pending';
  try {
    const ok = await deps.anchor.verifyPE(meterAnchorBatchId(day, b.anchor.segment), hashEnvelopeHashLeaf(b.batch_leaf), [...b.anchor.proof]);
    return ok ? 'anchored' : { mismatch: `batch_not_anchored_on_chain:${b.seq}` };
  } catch {
    return 'pending';
  }
}

export type ArchiveConfirmStatus = 'confirmed' | 'already_confirmed' | 'pending' | 'rejected' | 'missing';

/**
 * Confirm a day: the stored object is exactly its indexed parts (each part's sha256 and size, in
 * order), and every batch every part covers is anchored on that day. Idempotent; the sweep retries
 * a pending day.
 */
export async function confirmArchiveDay(deps: ArchiveDeps, wallet: string, dayKey: string): Promise<ArchiveConfirmStatus> {
  const day = await readArchiveDay(deps.db, wallet, dayKey);
  if (day === null) return 'missing';
  if (day.confirmed) return 'already_confirmed';
  if (day.rejected_reason !== null) return 'rejected';
  const stored = day.parts.filter((p) => p.state === 'stored');
  if (stored.length === 0 || stored.length !== day.parts.length) return 'pending';
  const note = async (last_check: string): Promise<void> => {
    await dayRef(deps.db, day.id).update({ last_check, updated_at_ms: deps.now() });
  };

  // (1) Anchoring first, from the meter's records (and Base for older batches): a day still waiting
  // for its anchor never reads the bucket.
  const records = new Map<string, Record<string, unknown>>();
  const hashes = [...new Set(stored.flatMap((p) => p.batches.map((b) => b.batch_hash)))];
  for (let i = 0; i < hashes.length; i += 100) {
    const refs = hashes.slice(i, i + 100).map((h) => deps.db.collection(METER_BATCHES_COLLECTION).doc(h));
    const snaps = await deps.db.getAll(...refs);
    for (const s of snaps) if (s.exists) records.set(s.id, s.data() as Record<string, unknown>);
  }
  let pending = false;
  for (const part of stored) {
    for (const b of part.batches) {
      const check = await checkBatchAnchored(deps, dayKey, part.device_id, b, records.get(b.batch_hash));
      if (check === 'pending') pending = true;
      else if (check !== 'anchored') {
        await dayRef(deps.db, day.id).update({ rejected_reason: check.mismatch, last_check: check.mismatch, updated_at_ms: deps.now() });
        return 'rejected';
      }
    }
  }
  if (pending) {
    await note('batches_not_yet_anchored');
    return 'pending';
  }

  // (2) The objects are exactly the indexed parts. A part's own object: its metadata (size and the
  // MD5 Cloud Storage checked when it was written) — no data read. A pre-2026-10-07 day object:
  // streamed back and compared line by line with the parts it holds.
  for (const part of stored) {
    if (part.object_path === undefined) continue;
    const stat = await deps.objects.stat(part.object_path).catch(() => null);
    if (stat === null || stat.size !== part.bytes || stat.md5 !== part.md5_b64) {
      await note(stat === null ? 'part_object_missing' : 'part_object_differs_from_index');
      return 'pending';
    }
  }
  const legacy = stored.filter((p) => p.object_path === undefined);
  if (legacy.length > 0) {
    const read = await streamLineDigests(deps.objects.openRead(day.object_path)).catch(() => null);
    if (read === null) {
      await note('object_unreadable');
      return 'pending';
    }
    if (read.torn || read.lines.length !== legacy.length
      || read.lines.some((l, i) => l.sha256 !== legacy[i].sha256 || l.bytes !== legacy[i].bytes)) {
      await note('object_differs_from_index');
      return 'pending';
    }
  }

  const confirmed = await deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(dayRef(deps.db, day.id));
    const current = snap.data() as ArchiveDayDoc;
    // Another part landed while this day was being read: confirm on the next pass instead.
    if (current.parts.length !== stored.length || current.stored_bytes !== day.stored_bytes) return false;
    const nowMs = deps.now();
    txn.update(dayRef(deps.db, day.id), {
      parts: current.parts.map((p) => ({ ...p, confirmed: true })),
      confirmed: true,
      confirmed_at_ms: nowMs,
      last_check: 'confirmed',
      updated_at_ms: nowMs,
    });
    return true;
  });
  return confirmed ? 'confirmed' : 'pending';
}

// ─── the sweep ──────────────────────────────────────────────────────────────────

/**
 * Settle an upload its device never finished (older than ARCHIVE_STALE_UPLOAD_MS): if its bytes
 * are in the object it is marked stored; if not, its reservation is released (nothing was stored,
 * so nothing is lost — the day is still on the device, which uploads it again).
 */
async function settleStaleUpload(deps: ArchiveDeps, day: ArchiveDayDoc): Promise<void> {
  const stale = day.parts.find((p) => p.state === 'uploading' && deps.now() - p.uploaded_at_ms > ARCHIVE_STALE_UPLOAD_MS);
  if (stale === undefined) return;
  let landed: boolean;
  let nothingStored: boolean;
  if (stale.object_path !== undefined) {
    // Its own object: metadata only.
    const stat = await deps.objects.stat(stale.object_path);
    landed = stat !== null && stat.size === stale.bytes && stat.md5 === stale.md5_b64;
    nothingStored = stat === null;
  } else {
    // Reserved before 2026-10-07: did its bytes reach the tail of the old day object?
    const base = legacyStoredBytes(day);
    const stat = await deps.objects.stat(day.object_path);
    landed = stat !== null && stat.size === base + stale.bytes
      && sha256Hex(await deps.objects.readRange(day.object_path, base, base + stale.bytes)) === stale.sha256;
    nothingStored = (stat === null && base === 0) || (stat !== null && stat.size === base);
  }
  if (landed) {
    await markPartStored(deps, day.id, stale.device_id, stale.part, null);
    return;
  }
  if (!nothingStored) return; // something unexpected is there: leave it for a person to look at
  await deps.db.runTransaction(async (txn) => {
    const dSnap = await txn.get(dayRef(deps.db, day.id));
    const aSnap = await txn.get(accountRef(deps.db, day.wallet));
    const current = dSnap.data() as ArchiveDayDoc;
    const held = current.parts.find((p) => p.device_id === stale.device_id && p.part === stale.part && p.state === 'uploading');
    if (held === undefined) return;
    const account = aSnap.data() as ArchiveAccountDoc;
    const nowMs = deps.now();
    txn.update(dayRef(deps.db, day.id), {
      parts: current.parts.filter((p) => !(p.device_id === stale.device_id && p.part === stale.part)),
      last_check: `stale_upload_released:${stale.device_id}:${stale.part}`,
      updated_at_ms: nowMs,
    });
    // Release exactly what the reservation counted (a part from before the 1 MB floor counted its bytes).
    txn.update(accountRef(deps.db, day.wallet), { used_bytes: Math.max(0, account.used_bytes - (held.charged_bytes ?? held.bytes)), updated_at_ms: nowMs });
  });
}

/** Advance unfinished payments and confirm unconfirmed days, a bounded number per run. */
export async function sweepArchive(deps: ArchiveDeps, limit = 25): Promise<{ payments: number; credited: number; days: number; confirmed: number }> {
  // Unresolved charges, and charged payments not yet credited — never the (ever-growing) set of
  // finished payments, which would crowd the unresolved ones out of a bounded read.
  const [unresolved, uncredited] = await Promise.all([
    deps.db.collection(ARCHIVE_PAYMENTS_COLLECTION).where('state', 'in', ['charging', 'charge_unconfirmed']).limit(limit * 2).get(),
    deps.db.collection(ARCHIVE_PAYMENTS_COLLECTION).where('state', '==', 'charged').where('credited', '==', false).limit(limit * 2).get(),
  ]);
  let payments = 0;
  let credited = 0;
  for (const doc of [...uncredited.docs, ...unresolved.docs]) {
    const p = doc.data() as ArchivePaymentDoc;
    if (p.state === 'charged' && p.credited) continue;
    if (payments >= limit) break;
    payments += 1;
    const after = await advanceArchivePayment(deps, p.request_id);
    if (after.credited) credited += 1;
  }
  const dSnap = await deps.db.collection(ARCHIVE_DAYS_COLLECTION).where('confirmed', '==', false).limit(limit * 4).get();
  let days = 0;
  let confirmed = 0;
  for (const doc of dSnap.docs) {
    const d = doc.data() as ArchiveDayDoc;
    if (d.rejected_reason !== null) continue;
    if (days >= limit) break;
    days += 1;
    await settleStaleUpload(deps, d).catch(() => undefined);
    const status = await confirmArchiveDay(deps, d.wallet, d.day).catch(() => 'pending' as const);
    if (status === 'confirmed') confirmed += 1;
  }
  return { payments, credited, days, confirmed };
}
