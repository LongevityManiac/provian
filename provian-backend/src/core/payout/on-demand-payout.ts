/**
 * — on-demand payout.
 *
 * Standard earnings settle on a schedule Provian sets, currently 30 UTC calendar days after each payee’s last standard settlement, for free. A payee that wants its earnings
 * NOW pays a flat $1 USDC service fee and the relay runs one settlement for that payee alone.
 *
 * Order of operations — nothing is charged unless the settlement is coverable right now:
 * 1. QUOTE: the payee must have settleable earnings (ready meter claims or registered unsettled
 * standard-lane rows), and the estimated gas for the charge plus the settlement must be at or
 * below the fee. Any miss answers without a charge (`nothing_to_pay` / `waits_for_gas`).
 * Recovery escrow is not a condition: it never holds earnings.
 * 2. CHARGE: the x402 payment's terms are checked (exact $1, Base USDC, to the revenue
 * wallet), its EIP-712 signer must be `from`, its nonce unused and its balance sufficient;
 * then USDC's own `transferWithAuthorization` moves the fee payer → revenue wallet. The
 * request id is derived from (from, nonce), which USDC itself settles at most once.
 * 3. ANSWER: the paid request answers as soon as its charge is decided (`charged`, or
 * `charge_unconfirmed` past a short wait) — never after the settlement, which can take minutes
 * on Base and outlived the payer's x402 deadline (a charged, settled payout reported a
 * timeout). The relay's CPU is throttled once a response is sent, so nothing settles "in the
 * background" of that request.
 * 4. SETTLE: `runSettlement({ payee })` this payee's standard-lane claims only, under its own
 * cycle id — run by the sweep (`/v1/internal/scheduler/payout-sweep`, every 10 minutes) or an
 * app's "check again" (`/v1/payout/:id/advance`). If the signer is busy, gas rose above the
 * fee, or the run stopped, the request stays `charged` with a waiting reason and the next
 * sweep retries. Earnings are never lost either way: anything a payout does not settle
 * settles when due in the daily run.
 *
 * No request limit. The fee is never a price for PVT: it is the same $1 whatever the payee is
 * owed, and the payout mints nothing that the payee had not already earned.
 */
import { createHash, randomBytes } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { METER_PENDING_CLAIMS_COLLECTION, type MeterPendingClaim } from '../meter/meter-store';
import { isDemotionHeld } from '../meter/meter-demotion-hold';
import { isCarriedOverLegacyClaim } from '../meter/meter-settlement';
import { MAX_PAYOUT_MEMBERS, readyWindowActs } from '../meter/meter-claims';
import { CLAIM_LEDGER_COLLECTION } from '../pvt/wp4/durable-settlement-store';
import { SETTLEMENT_GAS_MODEL } from '../pvt/wp4/operator-runtime';
import {
  checkPayoutPayment,
  PAYOUT_FEE_USDC_ATOMIC,
  payoutRequestId,
  type PayoutPayment,
} from './payout-terms';
import { recoverPayoutSigner, type PayoutChain } from './payout-chain';
import { awaitUsdcCharge, chargeStatusNow, submitUsdcCharge, USDC_CHARGE_GAS } from '../payments/usdc-charge';

export const PAYOUT_REQUESTS_COLLECTION = 'pvt_payout_requests_v1';
/** $1 — the ceiling the estimated gas (charge + settlement) must fit under. */
export const PAYOUT_FEE_USD = 1;
/** Gas for USDC `transferWithAuthorization` (observed ~60–70k on Base; padded). */
export const PAYOUT_CHARGE_GAS = USDC_CHARGE_GAS;
/** Headroom over the planning gas model, in basis points. */
export const PAYOUT_GAS_HEADROOM_BPS = 15_000n;
/**
 * How long the request handler waits for the charge receipt before handing it to the sweep. Kept
 * well inside the 30 s x402 deadline of installed CLIs : the whole paid request — quote
 * reads, submit, this wait — must answer before the payer gives up on it.
 */
export const PAYOUT_CHARGE_CONFIRM_WAIT_MS = 15_000;

export type PayoutState =
  | 'charging'
  | 'charge_unconfirmed'
  | 'charge_failed'
  | 'charged'
  | 'settling'
  | 'settled';

export interface PayoutRequestDoc {
  readonly schema: 'provian.pvt-payout-request.v1';
  readonly request_id: string;
  readonly payee: string;
  readonly payee_kind: 'agent' | 'human';
  readonly requested_by: string;
  readonly payer: string;
  readonly authorization_nonce: string;
  readonly fee_usdc_atomic: string;
  readonly state: PayoutState;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly charge_tx_hash: string | null;
  /** The Base block when the request was made: where a search for its charge starts (absent on older requests). */
  readonly charge_from_block?: number | null;
  readonly charged_at_ms: number | null;
  readonly quoted_ready_points_atomic: string;
  readonly waiting_reason: string | null;
  readonly settle_attempts: number;
  /** The advance currently running this request's settlement (absent/null when none). */
  readonly settle_lease?: string | null;
  readonly settle_lease_until_ms?: number | null;
  readonly settled_at_ms: number | null;
  readonly settlement: {
    readonly cycle_id: string | null;
    readonly claims_settled: number;
    readonly batches_confirmed: number;
    readonly fee_wei_spent: string;
  } | null;
  readonly last_error: string | null;
  /**
   * The x402 payment, kept so the sweep can re-check a charge whose receipt was not yet in. Null for
   * a request paid through an app store, which the store already confirmed before it was created.
   */
  readonly payment: PayoutPayment | null;
  /** How the fee was paid (absent on requests paid before store purchases existed: USDC). */
  readonly paid_via?: 'usdc' | 'app_store' | 'google_play';
  /** The store purchase that paid this request (`store_transactions_v1`), when one did. */
  readonly store_transaction_key?: string | null;
}

export interface ReadyWork {
  readonly claims: number;
  readonly recipients: number;
  readonly pointsAtomic: bigint;
  /** Ready claims a demotion in flight holds : a charged payout waits for them. */
  readonly held: number;
}

/**
 * What a payout for this payee would settle now: its pending meter claims that the inlet would
 * register (ready, or a carried-over legacy claim, or an already-built payout claim) plus its
 * registered, unsettled, unheld standard-lane ledger rows. Two equality reads, indexed
 * (contributor, state) and (contributor, settled).
 */
export async function readReadyWork(db: Firestore, payee: string, nowMs: number): Promise<ReadyWork> {
  const address = payee.toLowerCase();
  const [pendingSnap, ledgerSnap] = await Promise.all([
    db.collection(METER_PENDING_CLAIMS_COLLECTION)
      .where('contributor', '==', address).where('state', '==', 'pending').orderBy('claim_key', 'asc').get(),
    db.collection(CLAIM_LEDGER_COLLECTION)
      .where('contributor', '==', address).where('settled', '==', false).orderBy('claim_key', 'asc').get(),
  ]);
  const classes = new Set<string>();
  let points = 0n;
  let meterMembers = 0;
  let payoutClaims = 0;
  let held = 0;
  for (const doc of pendingSnap.docs) {
    const claim = doc.data() as MeterPendingClaim;
    // : a window claim's acts each wait their own takeover window; the inlet takes
    // exactly the ready ones (as one member: the claim itself, or the slice it cuts).
    const readyPoints = claim.unit === 'window'
      ? readyWindowActs(claim, nowMs).reduce((t, a) => t + BigInt(a.points_atomic), 0n)
      : null;
    const ready = readyPoints !== null
      ? readyWindowActs(claim, nowMs).length > 0
      : claim.unit === 'payout' || claim.ready_at_ms <= nowMs || isCarriedOverLegacyClaim(claim);
    if (!ready) continue;
    // Held by a demotion in flight: the inlet leaves it, so it is not work a payout settles now.
    if (claim.unit !== 'payout' && isDemotionHeld(claim as unknown as Record<string, unknown>, nowMs)) { held += 1; continue; }
    if (claim.unit === 'payout') payoutClaims += 1;
    else meterMembers += 1;
    classes.add(`${claim.beneficiary_class}`);
    points += readyPoints ?? BigInt(claim.record_points_atomic);
  }
  let ledgerRows = 0;
  for (const doc of ledgerSnap.docs) {
    const row = doc.data() as { lane?: unknown; hold?: unknown; record_points_atomic?: unknown; beneficiary_class?: unknown };
    if (row.lane !== 'standard') continue;
    if (row.hold !== undefined && row.hold !== null) continue;
    if (typeof row.record_points_atomic !== 'string' || !/^[0-9]+$/.test(row.record_points_atomic)) continue;
    ledgerRows += 1;
    classes.add(`${String(row.beneficiary_class)}`);
    points += BigInt(row.record_points_atomic);
  }
  // Meter claims reach the kernel as payout claims of up to MAX_PAYOUT_MEMBERS members each.
  const claims = payoutClaims + Math.ceil(meterMembers / MAX_PAYOUT_MEMBERS) + ledgerRows;
  return { claims, recipients: Math.max(classes.size, claims > 0 ? 1 : 0), pointsAtomic: points, held };
}

export interface GasQuote {
  readonly costWei: bigint;
  readonly costUsd: number;
  readonly covered: boolean;
}

/**
 * The charge plus a one-payee settlement, priced at the gas key's current max fee with headroom,
 * plus the L1 data-fee upper bound of both transactions. `covered` is false when the price feed
 * has no ETH price (unknown = wait, never charge).
 */
export async function quotePayoutGas(
  chain: Pick<PayoutChain, 'gasPriceWei' | 'l1FeeUpperBoundWei'>,
  ethUsd: number | null,
  work: Pick<ReadyWork, 'claims' | 'recipients'>,
): Promise<GasQuote> {
  const settlementGas = BigInt(SETTLEMENT_GAS_MODEL.baseGas)
    + BigInt(SETTLEMENT_GAS_MODEL.gasPerRecipient) * BigInt(Math.max(work.recipients, 1))
    + BigInt(SETTLEMENT_GAS_MODEL.gasPerClaim) * BigInt(Math.max(work.claims, 1));
  const gasPrice = await chain.gasPriceWei();
  const l2 = ((PAYOUT_CHARGE_GAS + settlementGas) * gasPrice * PAYOUT_GAS_HEADROOM_BPS) / 10_000n;
  const l1 = (await chain.l1FeeUpperBoundWei(400)) + (await chain.l1FeeUpperBoundWei(1_000 + 200 * Math.max(work.claims, 1)));
  const costWei = l2 + l1;
  if (ethUsd === null || !Number.isFinite(ethUsd) || ethUsd <= 0) {
    return { costWei, costUsd: Number.POSITIVE_INFINITY, covered: false };
  }
  const costUsd = (Number(costWei) / 1e18) * ethUsd;
  return { costWei, costUsd, covered: costUsd <= PAYOUT_FEE_USD };
}

export type PayoutSettleOutcome =
  | { readonly kind: 'settled'; readonly cycleId: string | null; readonly claimsSettled: number; readonly batchesConfirmed: number; readonly feeWeiSpent: string }
  | { readonly kind: 'nothing'; readonly cycleId: string | null }
  | { readonly kind: 'wait'; readonly reason: string };

export interface PayoutDeps {
  readonly db: Firestore;
  readonly chain: PayoutChain;
  readonly ethUsd: () => Promise<number | null>;
  readonly settle: (payee: string, requestId: string) => Promise<PayoutSettleOutcome>;
  /** Serialises the payout gas key's transactions across instances (a nonce lease). */
  readonly withGasKeyLease: <T>(fn: () => Promise<T>) => Promise<T | 'lease_busy'>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
}

export type PayoutPrecheck =
  | { readonly kind: 'ok'; readonly work: ReadyWork; readonly gas: GasQuote }
  | { readonly kind: 'nothing_to_pay' }
  | { readonly kind: 'waits_for_gas'; readonly gas: GasQuote };

export async function precheckPayout(deps: PayoutDeps, payee: string): Promise<PayoutPrecheck> {
  const work = await readReadyWork(deps.db, payee, deps.now());
  if (work.claims === 0 || work.pointsAtomic === 0n) return { kind: 'nothing_to_pay' };
  const gas = await quotePayoutGas(deps.chain, await deps.ethUsd(), work);
  if (!gas.covered) return { kind: 'waits_for_gas', gas };
  return { kind: 'ok', work, gas };
}

export type PayoutResponse =
  | { readonly kind: 'payment_required'; readonly error?: string; readonly work?: ReadyWork; readonly gas?: GasQuote }
  | { readonly kind: 'nothing_to_pay' }
  | { readonly kind: 'waits_for_gas'; readonly costUsd: number }
  | { readonly kind: 'not_your_request' }
  | { readonly kind: 'request'; readonly request: PayoutRequestDoc };

function requestRef(db: Firestore, requestId: string) {
  return db.collection(PAYOUT_REQUESTS_COLLECTION).doc(requestId);
}

/**
 * Patch a request only while it is still in one of `from` (a transaction). The request handler, the
 * sweep and a polling GET all advance the same request; a blind write from one could pull a request
 * another already charged or settled back to `charge_unconfirmed` — and a re-confirmed request would
 * settle a second time for one fee.
 */
async function patchRequestIf(db: Firestore, requestId: string, from: readonly PayoutState[], patch: Partial<PayoutRequestDoc>): Promise<boolean> {
  return db.runTransaction(async (txn) => {
    const ref = requestRef(db, requestId);
    const snap = await txn.get(ref);
    if (!snap.exists || !from.includes((snap.data() as PayoutRequestDoc).state)) return false;
    txn.update(ref, patch as Record<string, unknown>);
    return true;
  });
}

/**
 * How long one advance holds a request's settlement. A settlement run is bounded well inside this
 * (inlet + cycle); an advance that died mid-run frees the request when it lapses. Even past it the
 * kernel refuses any claim already settled, so a lapse can cost gas, never a second mint.
 */
export const PAYOUT_SETTLE_LEASE_MS = 60 * 60_000;

/**
 * Take the request's settlement for one advance: from `charged`, or from `settling` whose lease has
 * lapsed. Returns the lease token, or null when another advance holds it (or the request moved on).
 * Exactly one advance runs `deps.settle` for a request at a time, and only it records the outcome.
 */
async function takeSettleLease(db: Firestore, requestId: string, nowMs: number): Promise<string | null> {
  const token = randomBytes(12).toString('hex');
  return db.runTransaction(async (txn) => {
    const ref = requestRef(db, requestId);
    const snap = await txn.get(ref);
    if (!snap.exists) return null;
    const r = snap.data() as PayoutRequestDoc;
    const lapsed = r.state === 'settling' && (r.settle_lease_until_ms ?? 0) <= nowMs;
    if (r.state !== 'charged' && !lapsed) return null;
    txn.update(ref, {
      state: 'settling', settle_attempts: r.settle_attempts + 1, waiting_reason: null,
      settle_lease: token, settle_lease_until_ms: nowMs + PAYOUT_SETTLE_LEASE_MS, updated_at_ms: nowMs,
    });
    return token;
  });
}

/** Record a settlement outcome only while this advance still holds the request's lease. */
async function patchUnderLease(db: Firestore, requestId: string, token: string, patch: Partial<PayoutRequestDoc>): Promise<boolean> {
  return db.runTransaction(async (txn) => {
    const ref = requestRef(db, requestId);
    const snap = await txn.get(ref);
    if (!snap.exists) return false;
    const r = snap.data() as PayoutRequestDoc;
    if (r.state !== 'settling' || r.settle_lease !== token) return false;
    txn.update(ref, { ...patch, settle_lease: null, settle_lease_until_ms: null } as Record<string, unknown>);
    return true;
  });
}

async function readRequest(db: Firestore, requestId: string): Promise<PayoutRequestDoc | null> {
  const snap = await requestRef(db, requestId).get();
  return snap.exists ? (snap.data() as PayoutRequestDoc) : null;
}

/**
 * The paid request. `paymentHeader` is the raw `PAYMENT-SIGNATURE` value (undefined → quote).
 */
export async function requestPayout(
  deps: PayoutDeps,
  params: {
    readonly payee: string;
    readonly payeeKind: 'agent' | 'human';
    readonly requestedBy: string;
    readonly paymentHeader: string | undefined;
  },
): Promise<PayoutResponse> {
  const payee = params.payee.toLowerCase();

  if (params.paymentHeader !== undefined) {
    const terms = checkPayoutPayment(params.paymentHeader, Math.floor(deps.now() / 1000));
    if (!terms.ok) return { kind: 'payment_required', error: terms.reason };
    const payment = terms.payment;
    let signer: string;
    try {
      signer = recoverPayoutSigner(payment);
    } catch {
      return { kind: 'payment_required', error: 'payment_signature_invalid' };
    }
    if (signer !== payment.authorization.from) return { kind: 'payment_required', error: 'payment_signature_invalid' };
    const requestId = payoutRequestId(payment.authorization);

    // A retried paid request lands on its own document: report it (confirming its charge if it can
    // be; the settlement is the sweep's).
    const existing = await readRequest(deps.db, requestId);
    if (existing !== null) {
      if (existing.payee !== payee || existing.requested_by !== params.requestedBy) return { kind: 'not_your_request' };
      return { kind: 'request', request: await advancePayout(deps, requestId, { settle: false }) };
    }

    // Coverable now, or nothing is charged.
    const pre = await precheckPayout(deps, payee);
    if (pre.kind === 'nothing_to_pay') return { kind: 'nothing_to_pay' };
    if (pre.kind === 'waits_for_gas') return { kind: 'waits_for_gas', costUsd: pre.gas.costUsd };

    if (await deps.chain.authorizationUsed(payment.authorization.from, payment.authorization.nonce)) {
      return { kind: 'payment_required', error: 'payment_nonce_used' };
    }
    if ((await deps.chain.usdcBalance(payment.authorization.from)) < PAYOUT_FEE_USDC_ATOMIC) {
      return { kind: 'payment_required', error: 'payment_insufficient_funds' };
    }

    // The block a later search for this charge starts from (chain truth, not the relay's clock).
    const fromBlock = await deps.chain.headBlock().catch(() => null);
    const nowMs = deps.now();
    const doc: PayoutRequestDoc = {
      schema: 'provian.pvt-payout-request.v1',
      request_id: requestId,
      payee,
      payee_kind: params.payeeKind,
      requested_by: params.requestedBy,
      payer: payment.authorization.from,
      authorization_nonce: payment.authorization.nonce,
      fee_usdc_atomic: PAYOUT_FEE_USDC_ATOMIC.toString(10),
      paid_via: 'usdc',
      state: 'charging',
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
      charge_tx_hash: null,
      charge_from_block: fromBlock,
      charged_at_ms: null,
      quoted_ready_points_atomic: pre.work.pointsAtomic.toString(10),
      waiting_reason: null,
      settle_attempts: 0,
      settled_at_ms: null,
      settlement: null,
      last_error: null,
      payment,
    };
    try {
      await requestRef(deps.db, requestId).create(doc as unknown as Record<string, unknown>);
    } catch {
      // A concurrent identical request created it first; report that one.
      const raced = await readRequest(deps.db, requestId);
      if (raced === null) throw new Error('payout_request_create_failed');
      return { kind: 'request', request: raced };
    }

    // The shared USDC charge path (also the PE Archive's): submit under the gas-key lease. A submit
    // that errored may still land (or the authorization was consumed anyway): the charge is
    // unknown, and the sweep decides it from the chain. Only a request that broadcast nothing,
    // with the authorization unused, is "not charged".
    const submitted = await submitUsdcCharge(deps, payment);
    if (submitted.kind === 'not_submitted') {
      // Written only while still `charging`: a sweep or poll may have found the charge meanwhile.
      const wrote = await patchRequestIf(deps.db, requestId, ['charging'], {
        state: submitted.mayBeCharged ? 'charge_unconfirmed' : 'charge_failed',
        last_error: submitted.reason,
        updated_at_ms: deps.now(),
      });
      if (!submitted.mayBeCharged && wrote) return { kind: 'payment_required', error: 'payment_submit_failed' };
      return { kind: 'request', request: (await readRequest(deps.db, requestId))! };
    }
    await patchRequestIf(deps.db, requestId, ['charging'], {
      state: 'charge_unconfirmed', charge_tx_hash: submitted.txHash, updated_at_ms: deps.now(),
    });
    await awaitUsdcCharge(deps, submitted.txHash, payment, PAYOUT_CHARGE_CONFIRM_WAIT_MS);
    // Answer with the charge decided; the settlement runs from the sweep.
    return { kind: 'request', request: await advancePayout(deps, requestId, { settle: false }) };
  }

  // No payment yet: quote, or say why there is nothing to buy right now.
  const pre = await precheckPayout(deps, payee);
  if (pre.kind === 'nothing_to_pay') return { kind: 'nothing_to_pay' };
  if (pre.kind === 'waits_for_gas') return { kind: 'waits_for_gas', costUsd: pre.gas.costUsd };
  return { kind: 'payment_required', work: pre.work, gas: pre.gas };
}

/**
 * Move one request as far as it can go now: confirm an unconfirmed charge, then settle. Idempotent;
 * the sweep and the app's "check again" call it. The paid request itself passes `settle: false` * it only confirms the charge, so it answers inside the payer's deadline.
 */
export async function advancePayout(
  deps: PayoutDeps,
  requestId: string,
  opts: { readonly settle?: boolean } = {},
): Promise<PayoutRequestDoc> {
  let request = await readRequest(deps.db, requestId);
  if (request === null) throw new Error(`payout_request_missing:${requestId}`);

  if ((request.state === 'charge_unconfirmed' || request.state === 'charging') && request.payment !== null) {
    // By receipt, else by USDC's own authorization state; never failed while the authorization
    // could still land (`chargeStatusNow`).
    const { status, txHash } = await chargeStatusNow(deps, {
      txHash: request.charge_tx_hash, payment: request.payment,
      since: { block: request.charge_from_block ?? null, ms: request.created_at_ms },
    });
    if (status === 'confirmed') {
      await patchRequestIf(deps.db, requestId, ['charging', 'charge_unconfirmed'], {
        state: 'charged', charged_at_ms: deps.now(), updated_at_ms: deps.now(),
        ...(txHash !== null && txHash !== request.charge_tx_hash ? { charge_tx_hash: txHash } : {}),
      });
    } else if (status === 'reverted') {
      await patchRequestIf(deps.db, requestId, ['charging', 'charge_unconfirmed'], { state: 'charge_failed', last_error: 'charge_reverted', updated_at_ms: deps.now() });
    }
    request = (await readRequest(deps.db, requestId))!;
  }

  if (opts.settle !== false && (request.state === 'charged' || request.state === 'settling')) {
    // Gas may have risen since the quote: the payout waits rather than run at a loss.
    const work = await readReadyWork(deps.db, request.payee, deps.now());
    // A demotion in flight holds some of this payee's work: the paid payout waits for the hold to
    // end (at most hours) rather than settle around it and close with that work unpaid.
    if (work.held > 0 && request.state === 'charged') {
      await patchRequestIf(deps.db, requestId, ['charged'], { waiting_reason: 'demotion_hold', updated_at_ms: deps.now() });
      return (await readRequest(deps.db, requestId))!;
    }
    if (work.claims > 0) {
      const gas = await quotePayoutGas(deps.chain, await deps.ethUsd(), work);
      if (!gas.covered) {
        await patchRequestIf(deps.db, requestId, ['charged'], { waiting_reason: 'gas_above_fee', updated_at_ms: deps.now() });
        return (await readRequest(deps.db, requestId))!;
      }
    }
    // One advance at a time runs the settlement (the request handler, the sweep and a client's
    // "check again" all advance the same request): one fee, one settlement.
    const lease = await takeSettleLease(deps.db, requestId, deps.now());
    if (lease === null) return (await readRequest(deps.db, requestId))!;
    let outcome: PayoutSettleOutcome;
    try {
      outcome = await deps.settle(request.payee, requestId);
    } catch (error) {
      outcome = { kind: 'wait', reason: error instanceof Error ? error.message.slice(0, 200) : 'settle_failed' };
    }
    if (outcome.kind === 'wait') {
      await patchUnderLease(deps.db, requestId, lease, { state: 'charged', waiting_reason: outcome.reason, updated_at_ms: deps.now() });
    } else {
      await patchUnderLease(deps.db, requestId, lease, {
        state: 'settled',
        settled_at_ms: deps.now(),
        updated_at_ms: deps.now(),
        settlement: outcome.kind === 'settled'
          ? { cycle_id: outcome.cycleId, claims_settled: outcome.claimsSettled, batches_confirmed: outcome.batchesConfirmed, fee_wei_spent: outcome.feeWeiSpent }
          : { cycle_id: outcome.cycleId, claims_settled: 0, batches_confirmed: 0, fee_wei_spent: '0' },
      });
    }
    request = (await readRequest(deps.db, requestId))!;
  }
  return request;
}

/** The sweep: finish every charged-but-unsettled request, oldest first, a bounded number per run. */
export async function sweepPayouts(deps: PayoutDeps, limit = 10): Promise<{ examined: number; settled: number; waiting: number }> {
  const states: PayoutState[] = ['charging', 'charge_unconfirmed', 'charged', 'settling'];
  const snap = await deps.db.collection(PAYOUT_REQUESTS_COLLECTION).where('state', 'in', states).limit(limit * 5).get();
  const pending = snap.docs.map((d) => d.data() as PayoutRequestDoc)
    .sort((a, b) => a.created_at_ms - b.created_at_ms).slice(0, limit);
  let settled = 0;
  let waiting = 0;
  for (const request of pending) {
    const after = await advancePayout(deps, request.request_id);
    if (after.state === 'settled') settled += 1;
    else waiting += 1;
  }
  return { examined: pending.length, settled, waiting };
}

/** The request id of the payout a store purchase pays for (one purchase, one request, ever). */
export function storePaidPayoutRequestId(storeTransactionKey: string): string {
  return `po_${createHash('sha256').update(`provian.payout.store.v1|${storeTransactionKey}`, 'utf8').digest('hex').slice(0, 40)}`;
}

/**
 * A payout request already paid through an app store: it starts `charged` (the store confirmed the
 * payment before this is built) and the sweep settles it exactly like a USDC-paid request. The
 * caller creates it in the same transaction that marks the store purchase redeemed.
 */
export function storePaidPayoutRequest(params: {
  readonly payee: string;
  readonly requestedBy: string;
  readonly platform: 'app_store' | 'google_play';
  readonly storeTransactionKey: string;
  readonly readyPointsAtomic: bigint;
  readonly nowMs: number;
}): PayoutRequestDoc {
  return {
    schema: 'provian.pvt-payout-request.v1',
    request_id: storePaidPayoutRequestId(params.storeTransactionKey),
    payee: params.payee.toLowerCase(),
    payee_kind: 'human',
    requested_by: params.requestedBy,
    payer: params.payee.toLowerCase(),
    authorization_nonce: '',
    fee_usdc_atomic: '0',
    paid_via: params.platform,
    store_transaction_key: params.storeTransactionKey,
    state: 'charged',
    created_at_ms: params.nowMs,
    updated_at_ms: params.nowMs,
    charge_tx_hash: null,
    charge_from_block: null,
    charged_at_ms: params.nowMs,
    quoted_ready_points_atomic: params.readyPointsAtomic.toString(10),
    waiting_reason: null,
    settle_attempts: 0,
    settled_at_ms: null,
    settlement: null,
    last_error: null,
    payment: null,
  };
}

/** What a payer or app sees about a request (the stored payment signature is never echoed). */
export function publicPayoutView(request: PayoutRequestDoc): Record<string, unknown> {
  return {
    request_id: request.request_id,
    payee: request.payee,
    state: request.state,
    paid_via: request.paid_via ?? 'usdc',
    fee_usdc: request.paid_via === 'app_store' || request.paid_via === 'google_play' ? null : '1.00',
    charge_tx_hash: request.charge_tx_hash,
    waiting_reason: request.waiting_reason,
    created_at_ms: request.created_at_ms,
    settled_at_ms: request.settled_at_ms,
    settlement: request.settlement,
    note: request.state === 'settled'
      ? 'Settled. Anything not ready yet settles on a schedule Provian sets, currently every 30 days.'
      : request.state === 'charge_failed'
        ? 'The fee was not taken. Nothing was charged.'
        : request.state === 'charging' || request.state === 'charge_unconfirmed'
          ? 'The fee payment is not confirmed yet. Follow this request until its charge is decided; do not pay again.'
        : request.paid_via === 'app_store' || request.paid_via === 'google_play'
          ? 'Paid. The settlement runs next and finishes automatically, usually within about 10 minutes; check this request for the result. If gas or the signer is busy, the payout waits and the next run retries.'
          : 'Charged. The settlement runs next and finishes automatically, usually within about 10 minutes; check this request for the result. If gas or the signer is busy, the payout waits and the next run retries.',
  };
}
