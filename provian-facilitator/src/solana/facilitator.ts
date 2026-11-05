/**
 * Provian x402 facilitator — Solana mainnet.
 *
 * In x402's `exact` SVM scheme the buyer builds and signs the whole transaction and the facilitator
 * only co-signs as fee payer, so the fee rides in the buyer's transaction: the seller's 402 carries
 *   extra.provianFee = { amount, payTo: <Provian Solana gas wallet>, asset: <Solana USDC>, quote? }
 * and VERIFY requires exactly one extra transferChecked of that amount to that wallet's USDC account
 * (see inspect.ts). The fee must cover the transaction's actual gas (5,000 lamports × signatures +
 * its priority fee) in USD + $0.0003. A missing or short fee is invalid and never submitted, so a
 * settlement whose fee cannot be collected costs Provian nothing: the fee and the payment are one
 * atomic transaction — both land or neither does.
 *
 * Third-party Solana buyers must include the fee transfer themselves (Provian's SDK does it).
 */
import {
  FEE_MARGIN_USDC_ATOMIC,
  MAX_FEE_USDC_ATOMIC,
  SOLANA_GAS_WALLET,
  SOLANA_NETWORK,
  SOLANA_USDC_MINT,
} from '../constants.js';
import { usdcAtomicFromLamports } from '../fee-math.js';
import { checkPresentation, type FetchLike } from '../presentation.js';
import { sellerIdOf } from '../sellers.js';
import type { FacilitatorStore, SellerRecord, SettlementRecord } from '../store.js';
import { deliverWitness, type WitnessReporter } from '../witness.js';
import { svmPayloadSchema, type Payload, type Refusal, type Requirements, type SettleResult, type VerifyResult } from '../x402-types.js';
import type { SolanaChain } from './chain.js';
import { inspectSvmPayment } from './inspect.js';
import { readQuote } from './quote.js';
import { InFlight } from '../inflight.js';
import { decodeTransactionFromPayload, getTokenPayerFromTransaction } from '@x402/svm';
import { createHash } from 'node:crypto';

/** A settlement record that provably never reached the network may be claimed again. */
function isPreBroadcastFailure(error: string | null): boolean {
  // A legacy `send_failed` (signed and sent in one call) may have landed: re-signing the same message
  // yields the same signature, so taking it again re-broadcasts the same transaction and the chain's
  // answer (confirmed, failed or never seen) resolves it.
  return typeof error === 'string' && (error.startsWith('send_failed') || error === 'store_failed_before_broadcast');
}
/** A hashless `submitting` record this old died before its pre-broadcast write: it never reached the network. */
const STALE_SUBMITTING_MS = 90_000;
/**
 * A `submitted` signature the cluster still does not know this long after it was recorded can never
 * land: a blockhash is valid for at most ~150 slots (about a minute), and the lookup searches history.
 */
const UNLANDED_CLOSE_MS = 10 * 60_000;

export interface SolanaFacilitatorDeps {
  readonly chain: SolanaChain;
  readonly store: FacilitatorStore;
  readonly relayUrl: string;
  readonly fetch: FetchLike;
  readonly witness: WitnessReporter;
  readonly quoteSecret: string | null;
  readonly priceMaxAgeSeconds: number;
  readonly now: () => number;
  /** Pinned fee wallet; overridable only in tests. */
  readonly feeWallet?: string;
}

interface Verified {
  readonly ok: true;
  readonly payer: string;
  readonly seller: SellerRecord;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly lamports: bigint;
  readonly settlementKey: string;
  readonly transaction: string;
  readonly presentationId: string | null;
  readonly presentationExpiresAtMs: number;
}

function refuse(reason: string, payer?: string, message?: string): Refusal {
  return { ok: false, reason, ...(payer ? { payer } : {}), ...(message ? { message } : {}) };
}

export interface ProvianFeeTerms {
  readonly amount: bigint;
  readonly payTo: string;
  readonly asset: string;
  readonly quote: string | null;
}

export function readFeeTerms(extra: Record<string, unknown>, feeWallet: string): ProvianFeeTerms | null {
  const raw = extra.provianFee;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.amount !== 'string' || !/^[1-9]\d{0,17}$/.test(o.amount)) return null;
  if (o.payTo !== feeWallet || o.asset !== SOLANA_USDC_MINT) return null;
  if (o.quote !== undefined && typeof o.quote !== 'string') return null;
  const amount = BigInt(o.amount);
  if (amount > MAX_FEE_USDC_ATOMIC) return null;
  return { amount, payTo: feeWallet, asset: SOLANA_USDC_MINT, quote: typeof o.quote === 'string' ? o.quote : null };
}

export class SolanaFacilitator {
  private readonly feeWallet: string;
  private readonly inflight = new InFlight();

  constructor(private readonly deps: SolanaFacilitatorDeps) {
    this.feeWallet = deps.feeWallet ?? SOLANA_GAS_WALLET;
  }

  get network(): string {
    return SOLANA_NETWORK;
  }

  /** The minimum fee for `lamports` of gas: live coverage AND (quoted or live) gas + $0.0003. */
  async requiredFee(lamports: bigint, quoteToken: string | null): Promise<{ required: bigint; live: bigint } | Refusal> {
    let live;
    try {
      live = await this.deps.chain.solUsd(this.deps.priceMaxAgeSeconds);
    } catch {
      return refuse('fee_price_unavailable');
    }
    const liveGas = usdcAtomicFromLamports(lamports, live.price, live.expo);
    const quoted = readQuote(this.deps.quoteSecret, SOLANA_NETWORK, quoteToken, this.deps.now());
    const marginBase = quoted ? usdcAtomicFromLamports(lamports, quoted.price, quoted.expo) : liveGas;
    const required = marginBase + FEE_MARGIN_USDC_ATOMIC > liveGas ? marginBase + FEE_MARGIN_USDC_ATOMIC : liveGas;
    return { required, live: liveGas };
  }

  private async verifyPayment(payload: Payload, req: Requirements): Promise<Verified | Refusal> {
    if (req.network !== SOLANA_NETWORK || payload.accepted.network !== SOLANA_NETWORK) return refuse('network_mismatch');
    if (req.scheme !== 'exact' || payload.accepted.scheme !== 'exact') return refuse('unsupported_scheme');
    const acc = payload.accepted;
    if (acc.amount !== req.amount || acc.asset !== req.asset || acc.payTo !== req.payTo) return refuse('requirements_mismatch');
    if (req.asset !== SOLANA_USDC_MINT) return refuse('asset_not_supported');
    if (req.extra.feePayer !== this.deps.chain.feePayer) return refuse('fee_payer_not_managed');
    const terms = readFeeTerms(req.extra, this.feeWallet);
    if (!terms) return refuse('provian_fee_terms_invalid');
    const accTerms = readFeeTerms(acc.extra ?? {}, this.feeWallet);
    if (!accTerms || accTerms.amount !== terms.amount) return refuse('requirements_mismatch');
    const amount = BigInt(req.amount);
    if (amount <= 0n) return refuse('invalid_amount');
    if (req.payTo === this.deps.chain.feePayer || req.payTo === this.feeWallet) return refuse('facilitator_wallet_party_refused');

    const seller = await this.deps.store.getSeller(sellerIdOf('solana', req.payTo));
    if (!seller) return refuse('seller_not_registered');
    if (seller.status !== 'active') return refuse('seller_suspended');

    const p = svmPayloadSchema.safeParse(payload.payload);
    if (!p.success) return refuse('unsupported_payload');
    const memo = typeof req.extra.memo === 'string' && req.extra.memo.length > 0 ? req.extra.memo : null;
    const inspected = await inspectSvmPayment({
      transactionBase64: p.data.transaction,
      feePayer: this.deps.chain.feePayer,
      payTo: req.payTo,
      amount,
      feeWallet: this.feeWallet,
      feeAmount: terms.amount,
      expectedMemo: memo,
    });
    if (!inspected.ok) return inspected;
    if (inspected.payer === req.payTo) return refuse('self_payment_refused', inspected.payer);

    const need = await this.requiredFee(inspected.lamports, terms.quote);
    if ('ok' in need) return { ...need, payer: inspected.payer };
    if (terms.amount < need.required) {
      return refuse('fee_below_cost', inspected.payer, `the fee must be at least ${need.required} USDC atomic for this transaction`);
    }

    const pres = await checkPresentation({
      seller,
      payer: inspected.payer,
      extensions: payload.extensions,
      relayUrl: this.deps.relayUrl,
      fetch: this.deps.fetch,
      store: this.deps.store,
    });
    if (!pres.ok) return refuse(pres.reason, inspected.payer);

    try {
      await this.deps.chain.simulate(p.data.transaction);
    } catch (err) {
      return refuse('transaction_simulation_failed', inspected.payer, err instanceof Error ? err.message.slice(0, 200) : undefined);
    }
    return {
      ok: true,
      payer: inspected.payer,
      seller,
      amount,
      fee: terms.amount,
      lamports: inspected.lamports,
      settlementKey: `solana_${inspected.messageHashHex}`,
      transaction: p.data.transaction,
      presentationId: pres.presentationId,
      presentationExpiresAtMs: pres.expiresAtMs,
    };
  }

  async verify(payload: Payload, req: Requirements): Promise<VerifyResult> {
    const v = await this.verifyPayment(payload, req);
    if (!v.ok) return { isValid: false, invalidReason: v.reason, ...(v.message ? { invalidMessage: v.message } : {}), ...(v.payer ? { payer: v.payer } : {}) };
    return { isValid: true, payer: v.payer, extra: { provianFee: { amount: v.fee.toString(), asset: SOLANA_USDC_MINT, payer: 'buyer' } } };
  }

  async settle(payload: Payload, req: Requirements): Promise<SettleResult> {
    let payerKey: string | null = null;
    const parsed = svmPayloadSchema.safeParse(payload.payload);
    if (parsed.success) {
      try {
        payerKey = getTokenPayerFromTransaction(decodeTransactionFromPayload({ transaction: parsed.data.transaction })) || null;
      } catch {
        payerKey = null;
      }
    }
    if (payerKey && !this.inflight.tryAcquire(payerKey)) {
      return { success: false, errorReason: 'payer_settlement_in_progress', transaction: '', network: SOLANA_NETWORK, payer: payerKey };
    }
    try {
      return await this.settleUnlocked(payload, req);
    } finally {
      if (payerKey) this.inflight.release(payerKey);
    }
  }

  private async settleUnlocked(payload: Payload, req: Requirements): Promise<SettleResult> {
    const fail = (reason: string, payer?: string, message?: string, tx = ''): SettleResult => ({
      success: false,
      errorReason: reason,
      ...(message ? { errorMessage: message } : {}),
      ...(payer ? { payer } : {}),
      transaction: tx,
      network: SOLANA_NETWORK,
    });
    const v = await this.verifyPayment(payload, req);
    if (!v.ok) {
      // A retried /settle for a transaction we already broadcast no longer simulates (it landed) and
      // its presentation is spent: answer from its settlement record — same terms only — so a
      // settled payment is never reported failed on a retry (M2, the Base rule).
      const prior = await this.priorSettlementFor(payload, req);
      if (prior) return prior;
      return fail(v.reason, v.payer, v.message);
    }

    try {
      const bal = await this.deps.chain.lamports(this.deps.chain.feePayer);
      if (bal < v.lamports + 5000n) return fail('facilitator_gas_low', v.payer, 'the facilitator gas wallet is refilling');
    } catch {
      return fail('facilitator_unavailable', v.payer);
    }

    const now = this.deps.now();
    const record: SettlementRecord = {
      key: v.settlementKey,
      chain: 'solana',
      network: SOLANA_NETWORK,
      seller_id: v.seller.seller_id,
      buyer: v.payer,
      seller: req.payTo,
      asset: SOLANA_USDC_MINT,
      amount: v.amount.toString(),
      fee: v.fee.toString(),
      scheme: 'svm_exact',
      status: 'submitting',
      tx_hash: null,
      error: null,
      witness_status: 'pending',
      witness_attempts: 0,
      created_at_ms: now,
      updated_at_ms: now,
    };
    const claim = await this.deps.store.claimSettlement(record);
    if (!claim.claimed) {
      const e = claim.existing;
      if (e.status === 'confirmed' && e.tx_hash) {
        return { success: true, transaction: e.tx_hash, network: SOLANA_NETWORK, payer: e.buyer, extra: { provianFee: { amount: e.fee, asset: SOLANA_USDC_MINT, payer: 'buyer' } } };
      }
      if (e.status === 'submitted' && e.tx_hash) return this.awaitAndFinish(e);
      if (!this.termsMatch(e, req)) return fail('settlement_mismatch', e.buyer);
      // An attempt that provably never reached the network may be taken again (the Base rule):
      // signing failed, the pre-broadcast write failed, or it died hashless between claim and write.
      const neverBroadcast = (e.status === 'failed' && isPreBroadcastFailure(e.error))
        || (e.status === 'submitting' && e.tx_hash === null && now - e.updated_at_ms > STALE_SUBMITTING_MS);
      if (!neverBroadcast) {
        return fail(e.status === 'submitting' ? 'settlement_in_progress' : 'transaction_failed', e.buyer, undefined, e.tx_hash ?? '');
      }
      const { key: _key, ...fresh } = record;
      await this.deps.store.updateSettlement(v.settlementKey, fresh);
    }

    if (v.presentationId) {
      const fresh = await this.deps.store.consumePresentation(v.presentationId, v.settlementKey, v.presentationExpiresAtMs);
      if (!fresh) {
        await this.deps.store.updateSettlement(v.settlementKey, { status: 'failed', error: 'presentation_already_used', witness_status: 'not_applicable' });
        return fail('presentation_already_used', v.payer);
      }
    }

    // M2 (fix run 2026-10-24), the Base rule: sign first (the fee payer's signature IS the
    // transaction id), record it `submitted`, THEN broadcast. A broadcast that throws is an unknown
    // outcome — the node may have accepted it — so it waits for the chain like any other, and a
    // retried /settle or the scheduled reconciliation resolves it. Only an attempt that provably
    // never reached the network is ever recorded failed before the chain answers.
    let signed: { readonly signature: string; readonly signed: string };
    try {
      signed = await this.deps.chain.sign(v.transaction);
    } catch (err) {
      await this.deps.store.updateSettlement(v.settlementKey, {
        status: 'failed',
        error: `send_failed: sign: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
        witness_status: 'not_applicable',
      });
      return fail('transaction_failed', v.payer, 'broadcast failed');
    }
    try {
      await this.deps.store.updateSettlement(v.settlementKey, { status: 'submitted', tx_hash: signed.signature });
    } catch {
      try {
        await this.deps.store.updateSettlement(v.settlementKey, { status: 'failed', error: 'store_failed_before_broadcast', witness_status: 'not_applicable' });
      } catch {
        // The store is what failed; the record stays hashless `submitting`, a slot a later attempt may take.
      }
      return fail('facilitator_unavailable', v.payer, 'broadcast failed');
    }
    const submitted: SettlementRecord = { ...record, status: 'submitted', tx_hash: signed.signature };
    try {
      await this.deps.chain.send(signed.signed);
    } catch {
      // Unknown outcome: never "failed" on a lost answer.
      return this.awaitAndFinish(submitted);
    }
    return this.awaitAndFinish(submitted);
  }

  /**
   * Scheduled: resolve Solana `submitted` records whose confirmation wait was lost (a lost RPC
   * answer, an instance that died) from the chain — confirmed and witnessed, failed on chain, or,
   * once the cluster still knows no such transaction well past any blockhash lifetime, closed as
   * never landed (M2, fix run 2026-10-24). One non-waiting lookup per record.
   */
  async reconcileStaleSubmitted(olderThanMs = 120_000, limit = 10): Promise<{ scanned: number; resolved: number }> {
    const stale = await this.deps.store.listStaleSubmitted(this.deps.now() - olderThanMs, limit, 'solana');
    let resolved = 0;
    for (const record of stale) {
      if (!record.tx_hash) continue;
      let status;
      try {
        status = await this.deps.chain.signatureStatus(record.tx_hash);
      } catch {
        continue; // outcome unknown this run
      }
      try {
        if (status === 'confirmed') {
          await this.finishConfirmed(record, record.tx_hash);
          resolved += 1;
        } else if (status === 'failed') {
          await this.deps.store.updateSettlement(record.key, { status: 'failed', error: 'failed_onchain', witness_status: 'not_applicable' });
          resolved += 1;
        } else if (status === 'not_found' && this.deps.now() - record.updated_at_ms > UNLANDED_CLOSE_MS) {
          await this.deps.store.updateSettlement(record.key, { status: 'failed', error: 'expired_unlanded', witness_status: 'not_applicable' });
          resolved += 1;
        }
      } catch {
        // a write failed: the record stays `submitted` for the next run
      }
    }
    return { scanned: stale.length, resolved };
  }

  private async awaitAndFinish(record: SettlementRecord): Promise<SettleResult> {
    const signature = record.tx_hash ?? '';
    let outcome;
    try {
      outcome = await this.deps.chain.confirm(signature);
    } catch {
      return { success: false, errorReason: 'settlement_pending', transaction: signature, network: SOLANA_NETWORK, payer: record.buyer };
    }
    if (outcome === 'failed') {
      await this.deps.store.updateSettlement(record.key, { status: 'failed', error: 'failed_onchain', witness_status: 'not_applicable' });
      return { success: false, errorReason: 'transaction_failed', transaction: signature, network: SOLANA_NETWORK, payer: record.buyer };
    }
    return this.finishConfirmed(record, signature);
  }

  /** The settlement record for this exact transaction (its message hash), answered for the SAME terms only. */
  private async priorSettlementFor(payload: Payload, req: Requirements): Promise<SettleResult | null> {
    const parsed = svmPayloadSchema.safeParse(payload.payload);
    if (!parsed.success) return null;
    let key: string;
    try {
      const tx = decodeTransactionFromPayload({ transaction: parsed.data.transaction });
      key = `solana_${createHash('sha256').update(Uint8Array.from(tx.messageBytes)).digest('hex')}`;
    } catch {
      return null;
    }
    const existing = await this.deps.store.getSettlement(key);
    if (!existing || existing.status === 'failed') return null;
    if (!this.termsMatch(existing, req)) {
      return { success: false, errorReason: 'settlement_mismatch', transaction: '', network: SOLANA_NETWORK, payer: existing.buyer };
    }
    if (existing.status === 'confirmed' && existing.tx_hash) {
      return { success: true, transaction: existing.tx_hash, network: SOLANA_NETWORK, payer: existing.buyer, extra: { provianFee: { amount: existing.fee, asset: SOLANA_USDC_MINT, payer: 'buyer' } } };
    }
    if (existing.status === 'submitted' && existing.tx_hash) return this.awaitAndFinish(existing);
    return { success: false, errorReason: 'settlement_in_progress', transaction: existing.tx_hash ?? '', network: SOLANA_NETWORK, payer: existing.buyer };
  }

  private termsMatch(existing: SettlementRecord, req: Requirements): boolean {
    return existing.chain === 'solana' && existing.seller === req.payTo && existing.amount === req.amount
      && existing.asset === req.asset && existing.network === req.network;
  }

  private async finishConfirmed(record: SettlementRecord, signature: string): Promise<SettleResult> {
    await this.deps.store.updateSettlement(record.key, { status: 'confirmed' });
    await this.deps.store.incrementSellerCounter(record.seller_id, 'settlement_count');
    await deliverWitness(this.deps.store, this.deps.witness, { ...record, status: 'confirmed' });
    return {
      success: true,
      transaction: signature,
      network: SOLANA_NETWORK,
      payer: record.buyer,
      extra: { provianFee: { amount: record.fee, asset: SOLANA_USDC_MINT, payer: 'buyer' } },
    };
  }
}
