/**
 * Provian x402 facilitator — Base (eip155:8453).
 *
 * VERIFY runs x402's own open-source `ExactEvmScheme` verification (@x402/evm 2.28.0, Apache-2.0:
 * signature, recipient, amount, validity window, asset, on-chain simulation) on top of Provian's
 * checks (registered seller, pinned assets, no sponsored approvals, presentation gate), and then
 * checks the fee can be collected.
 *
 * SETTLE never uses the scheme's own settle (that would broadcast a bare transferWithAuthorization
 * with no fee). It broadcasts ONE call to ProvianX402FeeSettler, which runs the buyer's authorization
 * buyer → seller and pulls the fee from the seller's own approval, in the same transaction.
 *
 * "Coverage up front": the fee is computed for the exact call (gas limit × max fee per gas + the
 * OP-stack L1 data fee, at Chainlink ETH/USD, rounded up, + $0.0003). Before anything is
 * broadcast the facilitator checks the seller's allowance and balance cover the fee and eth_call-
 * simulates the exact settle call at that fee; any failure → `fee_uncollectable`, nothing is sent
 * and Provian spends nothing.
 */
import { getAddress, isAddress, decodeEventLog, type Hex } from 'viem';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import {
  BASE_GAS_WALLET,
  BASE_NETWORK,
  BASE_PVT,
  BASE_USDC,
  BASE_USDC_EIP712,
  MAX_FEE_USDC_ATOMIC,
  SPONSORED_APPROVAL_EXTENSION_KEYS,
  X402_EXACT_PERMIT2_PROXY,
} from '../constants.js';
import { usdcAtomicFromWei, withMargin, ceilDiv } from '../fee-math.js';
import { checkPresentation, type FetchLike } from '../presentation.js';
import { sellerIdOf } from '../sellers.js';
import type { FacilitatorStore, SellerRecord, SettlementRecord } from '../store.js';
import { deliverWitness, type WitnessReporter } from '../witness.js';
import {
  eip3009PayloadSchema,
  permit2PayloadSchema,
  type Payload,
  type Refusal,
  type Requirements,
  type SettleResult,
  type VerifyResult,
} from '../x402-types.js';
import type { Receipt } from './chain.js';
import { BroadcastError, type BaseChain, type SettleCall } from './chain.js';
import { settlerAbi } from './abi.js';
import { InFlight } from '../inflight.js';

export interface BaseFacilitatorDeps {
  readonly chain: BaseChain;
  readonly store: FacilitatorStore;
  readonly relayUrl: string;
  readonly fetch: FetchLike;
  readonly witness: WitnessReporter;
  readonly priceMaxAgeSeconds: number;
  readonly now: () => number;
  /** The fee recipient the settler pays (pinned: the Base gas wallet). Overridable only for fork tests. */
  readonly feeRecipient?: `0x${string}`;
  /**
   * x402's standard verification. Defaults to @x402/evm's ExactEvmScheme over `chain.verifySigner`;
   * unit tests inject a stub to reach every Provian refusal path without a node.
   */
  readonly standardVerify?: (payload: Payload, req: Requirements) => Promise<{ isValid: boolean; invalidReason?: string; invalidMessage?: string }>;
}

/**
 * Tip cap: the priority fee the facilitator bids is clamped to this (Base tips are ~0.001 gwei; a
 * 1-gwei tip on a 100k-gas settle alone would cost ~$0.27, above the settler's $0.05 cap).
 */
export const MAX_PRIORITY_FEE_WEI = 50_000_000n;
/** Seller auto-suspension after this many settlements that reverted after broadcast. */
const STRIKES_BEFORE_SUSPENSION = 3;
/**
 * 2026-10-17: an authorization must still be valid for at least this long when it is verified.
 * Inclusion lands 2–4 s after broadcast while simulation reads `latest`, so a buyer could pass
 * verify + simulation with `validBefore ≈ now + 2 s` and revert on chain for free — burning the
 * facilitator's gas and, before the strike rule below, a strike against the seller. The floor covers
 * only that gap: standard clients sign `validBefore = now + maxTimeoutSeconds`, and 60 is a common
 * maxTimeoutSeconds, so a 60 s floor refused every such payment .
 */
export const MIN_REMAINING_VALIDITY_SECONDS = 10n;
/** A `submitted` record whose authorization expired this long ago without a receipt is closed as failed. */
const UNMINED_GRACE_SEC = 900;
/** For a record stored before `expires_at_sec` existed: closed this long after its last update. */
const UNMINED_FALLBACK_AGE_SEC = 7_200;
/** A settlement record that provably never reached the chain may be claimed again. */
function isPreBroadcastFailure(error: string | null): boolean {
  return typeof error === 'string' && (error.startsWith('send_failed') || error === 'store_failed_before_broadcast');
}
/**
 * A hashless `submitting` record is one whose attempt died between the claim and the (pre-broadcast)
 * hash write: signing takes seconds, so one older than this never reached the chain either.
 */
const STALE_SUBMITTING_MS = 90_000;

interface Verified {
  readonly ok: true;
  readonly payer: `0x${string}`;
  readonly seller: SellerRecord;
  readonly sellerAddress: `0x${string}`;
  readonly call: SettleCall; // fee field is a placeholder until priced
  readonly scheme: 'eip3009' | 'permit2';
  readonly settlementKey: string;
  readonly presentationId: string | null;
  readonly presentationExpiresAtMs: number;
}

export interface BaseFeeQuote {
  readonly fee: bigint;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly l2CostWei: bigint;
  readonly l1CostWei: bigint;
  readonly ethUsd: bigint;
  readonly ethUsdDecimals: number;
}

type Priced = { readonly ok: true; readonly call: SettleCall; readonly quote: BaseFeeQuote };

function refuse(reason: string, payer?: string, message?: string): Refusal {
  return { ok: false, reason, ...(payer ? { payer } : {}), ...(message ? { message } : {}) };
}

function withFee(call: SettleCall, fee: bigint): SettleCall {
  return { ...call, fee };
}

function sameAddr(a: string, b: string): boolean {
  return isAddress(a, { strict: false }) && isAddress(b, { strict: false }) && a.toLowerCase() === b.toLowerCase();
}

export class BaseFacilitator {
  private readonly standardVerify: NonNullable<BaseFacilitatorDeps['standardVerify']>;
  private readonly feeRecipient: `0x${string}`;
  private readonly inflight = new InFlight();

  constructor(private readonly deps: BaseFacilitatorDeps) {
    if (deps.standardVerify) {
      this.standardVerify = deps.standardVerify;
    } else {
      // eip6492AllowedFactories: [] → counterfactual smart-wallet deployment is refused (no sponsored deploys).
      const scheme = new ExactEvmScheme(deps.chain.verifySigner, { eip6492AllowedFactories: [], simulateInSettle: true });
      this.standardVerify = (payload, req) => scheme.verify(payload as unknown as PaymentPayload, req as unknown as PaymentRequirements);
    }
    this.feeRecipient = deps.feeRecipient ?? BASE_GAS_WALLET;
  }

  get network(): string {
    return BASE_NETWORK;
  }

  // ── VERIFY ────────────────────────────────────────────────────────────────────────────────
  private async verifyPayment(payload: Payload, req: Requirements): Promise<Verified | Refusal> {
    if (req.network !== BASE_NETWORK || payload.accepted.network !== BASE_NETWORK) return refuse('network_mismatch');
    if (req.scheme !== 'exact' || payload.accepted.scheme !== 'exact') return refuse('unsupported_scheme');
    const acc = payload.accepted;
    if (acc.amount !== req.amount || !sameAddr(acc.asset, req.asset) || !sameAddr(acc.payTo, req.payTo)) {
      return refuse('requirements_mismatch');
    }
    if (!isAddress(req.payTo, { strict: false })) return refuse('invalid_pay_to');
    const sellerAddress = getAddress(req.payTo.toLowerCase());
    for (const key of SPONSORED_APPROVAL_EXTENSION_KEYS) {
      if (payload.extensions && key in payload.extensions) return refuse('sponsored_approval_refused');
    }
    if (BigInt(req.amount) <= 0n) return refuse('invalid_amount');

    const seller = await this.deps.store.getSeller(sellerIdOf('base', sellerAddress));
    if (!seller) return refuse('seller_not_registered');
    if (seller.status !== 'active') return refuse('seller_suspended');

    let call: SettleCall;
    let payer: `0x${string}`;
    let scheme: 'eip3009' | 'permit2';
    let settlementKey: string;
    const e3009 = eip3009PayloadSchema.safeParse(payload.payload);
    const p2 = permit2PayloadSchema.safeParse(payload.payload);
    if (e3009.success) {
      if (!sameAddr(req.asset, BASE_USDC)) return refuse('asset_not_supported');
      if (req.extra.name !== BASE_USDC_EIP712.name || req.extra.version !== BASE_USDC_EIP712.version) {
        return refuse('invalid_eip712_domain');
      }
      const a = e3009.data.authorization;
      payer = getAddress(a.from.toLowerCase());
      scheme = 'eip3009';
      call = {
        kind: 'eip3009',
        buyer: payer,
        seller: getAddress(a.to.toLowerCase()),
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce as Hex,
        signature: e3009.data.signature as Hex,
        fee: 0n,
      };
      settlementKey = `base_eip3009_${payer.toLowerCase()}_${a.nonce.toLowerCase()}`;
    } else if (p2.success) {
      if (!sameAddr(req.asset, BASE_PVT)) return refuse('asset_not_supported');
      const a = p2.data.permit2Authorization;
      if (!sameAddr(a.spender, X402_EXACT_PERMIT2_PROXY)) return refuse('invalid_permit2_spender');
      // PVT is priced by the seller in PVT, and only at a price it registered (Provian never quotes PVT in dollars).
      if (!seller.pvt_prices.some((p) => p.amount_atomic === req.amount)) return refuse('pvt_price_not_registered');
      payer = getAddress(a.from.toLowerCase());
      scheme = 'permit2';
      call = {
        kind: 'permit2',
        token: getAddress(a.permitted.token.toLowerCase()),
        amount: BigInt(a.permitted.amount),
        permitNonce: BigInt(a.nonce),
        deadline: BigInt(a.deadline),
        buyer: payer,
        seller: getAddress(a.witness.to.toLowerCase()),
        validAfter: BigInt(a.witness.validAfter),
        signature: p2.data.signature as Hex,
        fee: 0n,
      };
      settlementKey = `base_permit2_${payer.toLowerCase()}_${a.nonce}`;
    } else {
      return refuse('unsupported_payload');
    }

    {
      const nowSec = BigInt(Math.floor(this.deps.now() / 1000));
      const expiresAt = call.kind === 'eip3009' ? call.validBefore : call.deadline;
      if (expiresAt < nowSec + MIN_REMAINING_VALIDITY_SECONDS) return refuse('authorization_expires_too_soon', payer);
    }
    if (!sameAddr(call.seller, sellerAddress)) return refuse('recipient_mismatch', payer);
    if (sameAddr(payer, sellerAddress)) return refuse('self_payment_refused', payer);
    for (const party of [payer, sellerAddress]) {
      if (sameAddr(party, this.deps.chain.operator) || sameAddr(party, this.deps.chain.settler) || sameAddr(party, this.feeRecipient)) {
        return refuse('facilitator_wallet_party_refused', payer);
      }
    }

    const pres = await checkPresentation({
      seller,
      payer,
      extensions: payload.extensions,
      relayUrl: this.deps.relayUrl,
      fetch: this.deps.fetch,
      store: this.deps.store,
    });
    if (!pres.ok) return refuse(pres.reason, payer);

    // x402's own verification (signature, recipient, amount, timing, asset contract, simulation).
    const std = await this.standardVerify(payload, req);
    if (!std.isValid) return refuse(std.invalidReason ?? 'invalid_payment', payer, std.invalidMessage);

    return {
      ok: true,
      payer,
      seller,
      sellerAddress,
      call,
      scheme,
      settlementKey,
      presentationId: pres.presentationId,
      presentationExpiresAtMs: pres.expiresAtMs,
    };
  }

  // ── FEE ───────────────────────────────────────────────────────────────────────────────────
  /** Price the exact settle call and prove the fee is collectable. Nothing here broadcasts. */
  async priceAndProve(call: SettleCall): Promise<Priced | Refusal> {
    const chain = this.deps.chain;
    const isUsdcPayment = call.kind === 'eip3009' || sameAddr(call.token, BASE_USDC);
    const value = call.kind === 'eip3009' ? call.value : call.amount;
    // Provisional fee for the gas estimate (inside the settler's accepted range).
    const provisionalCap = isUsdcPayment ? value - 1n : MAX_FEE_USDC_ATOMIC;
    const provisional = provisionalCap < MAX_FEE_USDC_ATOMIC ? provisionalCap : MAX_FEE_USDC_ATOMIC;
    if (provisional < 1n) return refuse('fee_uncollectable', undefined, 'payment too small to carry a fee');

    let gasEstimate: bigint;
    try {
      gasEstimate = await chain.estimateSettleGas(withFee(call, provisional));
    } catch (err) {
      return refuse('fee_uncollectable', undefined, `settle call does not execute: ${shortError(err)}`);
    }
    const gasLimit = ceilDiv(gasEstimate * 110n, 100n);
    let baseFee: bigint;
    let tip: bigint;
    try {
      [baseFee, tip] = await Promise.all([chain.latestBaseFee(), chain.priorityFee()]);
    } catch {
      return refuse('fee_price_unavailable');
    }
    if (tip > MAX_PRIORITY_FEE_WEI) tip = MAX_PRIORITY_FEE_WEI;
    if (tip < 1n) tip = 1n;
    // The fee covers the most this transaction can be charged on L2: gas limit × max fee per gas.
    const maxFeePerGas = ceilDiv(baseFee * 125n, 100n) + tip;
    const l2CostWei = gasLimit * maxFeePerGas;
    let l1CostWei: bigint;
    let price: { answer: bigint; decimals: number; updatedAt: number };
    try {
      [l1CostWei, price] = await Promise.all([
        chain.l1Fee(chain.encodeSettle(withFee(call, provisional)), gasLimit, maxFeePerGas, tip),
        chain.ethUsd(),
      ]);
    } catch {
      return refuse('fee_price_unavailable');
    }
    const nowSec = Math.floor(this.deps.now() / 1000);
    if (price.answer <= 0n || nowSec - price.updatedAt > this.deps.priceMaxAgeSeconds || price.updatedAt > nowSec + 60) {
      return refuse('fee_price_unavailable', undefined, 'ETH/USD price is stale');
    }
    const fee = withMargin(usdcAtomicFromWei(l2CostWei + l1CostWei, price.answer, price.decimals));
    if (fee > MAX_FEE_USDC_ATOMIC) return refuse('fee_uncollectable', undefined, 'fee exceeds the settler cap');
    if (isUsdcPayment && fee >= value) return refuse('fee_uncollectable', undefined, 'fee is not below the payment');

    const finalCall = withFee(call, fee);
    // Collectability: the seller's own allowance to the settler and its balance (after the payment lands).
    try {
      const [allowance, balance] = await Promise.all([
        chain.allowance(BASE_USDC, finalCall.seller, chain.settler),
        chain.balanceOf(BASE_USDC, finalCall.seller),
      ]);
      if (allowance < fee) return refuse('fee_uncollectable', undefined, 'seller has not approved the settler for the fee');
      const after = balance + (isUsdcPayment ? value : 0n);
      if (after < fee) return refuse('fee_uncollectable', undefined, 'seller USDC balance cannot cover the fee');
      // The exact call, at the exact fee, from the operator.
      await chain.simulateSettle(finalCall);
    } catch (err) {
      return refuse('fee_uncollectable', undefined, `simulation failed: ${shortError(err)}`);
    }
    return {
      ok: true,
      call: finalCall,
      quote: { fee, gasLimit, maxFeePerGas, maxPriorityFeePerGas: tip, l2CostWei, l1CostWei, ethUsd: price.answer, ethUsdDecimals: price.decimals },
    };
  }

  async verify(payload: Payload, req: Requirements): Promise<VerifyResult> {
    const v = await this.verifyPayment(payload, req);
    if (!v.ok) return { isValid: false, invalidReason: v.reason, ...(v.message ? { invalidMessage: v.message } : {}), ...(v.payer ? { payer: v.payer } : {}) };
    const priced = await this.priceAndProve(v.call);
    if (!priced.ok) {
      return { isValid: false, invalidReason: priced.reason, ...(priced.message ? { invalidMessage: priced.message } : {}), payer: v.payer };
    }
    return { isValid: true, payer: v.payer, extra: { provianFee: { amount: priced.quote.fee.toString(), asset: BASE_USDC, payer: 'seller' } } };
  }

  // ── SETTLE ────────────────────────────────────────────────────────────────────────────────
  async settle(payload: Payload, req: Requirements): Promise<SettleResult> {
    const e = eip3009PayloadSchema.safeParse(payload.payload);
    const p = permit2PayloadSchema.safeParse(payload.payload);
    const payerKey = e.success ? e.data.authorization.from.toLowerCase() : p.success ? p.data.permit2Authorization.from.toLowerCase() : null;
    if (payerKey && !this.inflight.tryAcquire(payerKey)) {
      return { success: false, errorReason: 'payer_settlement_in_progress', transaction: '', network: BASE_NETWORK, payer: payerKey };
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
      network: BASE_NETWORK,
    });

    const v = await this.verifyPayment(payload, req);
    if (!v.ok) {
      // Idempotency: a retried /settle for an authorization already settled by us returns that
      // settlement — for the SAME terms only (2026-10-17). A spent (payer, nonce) presented with
      // another seller's requirements used to answer `success` with the first seller's
      // transaction, so a buyer could be served by seller B for one payment to seller A.
      const prior = await this.priorSettlementFor(payload, req);
      if (prior) return prior;
      return fail(v.reason, v.payer, v.message);
    }
    const priced = await this.priceAndProve(v.call);
    if (!priced.ok) return fail(priced.reason, v.payer, priced.message);

    // Gas the operator can actually spend for this transaction (never broadcast what could strand).
    const maxGasCost = priced.quote.gasLimit * priced.quote.maxFeePerGas + priced.quote.l1CostWei;
    try {
      const gasBalance = await this.deps.chain.nativeBalance(this.deps.chain.operator);
      if (gasBalance < maxGasCost) return fail('facilitator_gas_low', v.payer, 'the facilitator gas wallet is refilling');
    } catch {
      return fail('facilitator_unavailable', v.payer);
    }

    const now = this.deps.now();
    const value = priced.call.kind === 'eip3009' ? priced.call.value : priced.call.amount;
    const asset = priced.call.kind === 'eip3009' ? BASE_USDC : priced.call.token;
    const record: SettlementRecord = {
      key: v.settlementKey,
      chain: 'base',
      network: BASE_NETWORK,
      seller_id: v.seller.seller_id,
      buyer: v.payer.toLowerCase(),
      seller: v.sellerAddress.toLowerCase(),
      asset: asset.toLowerCase(),
      amount: value.toString(),
      fee: priced.quote.fee.toString(),
      scheme: v.scheme,
      expires_at_sec: Number(priced.call.kind === 'eip3009' ? priced.call.validBefore : priced.call.deadline),
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
      if (!this.termsMatch(claim.existing, req, v.scheme)) return fail('settlement_mismatch', v.payer);
      const neverBroadcast = (claim.existing.status === 'failed' && isPreBroadcastFailure(claim.existing.error))
        || (claim.existing.status === 'submitting' && claim.existing.tx_hash === null
          && now - claim.existing.updated_at_ms > STALE_SUBMITTING_MS);
      if (!neverBroadcast) return this.resultOfExisting(claim.existing);
      // The earlier attempt provably never reached the chain: this attempt takes the slot.
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

    // The hash is recorded BEFORE the broadcast (the chain signs first and hands it out): a store
    // or instance failure after this point leaves a `submitted` record with a hash that a retry,
    // or the scheduled reconciliation, resolves from the chain — never a hashless strand with the
    // buyer charged and the seller told "in progress" forever (2026-10-17).
    let hash: Hex;
    let recorded = false;
    try {
      hash = await this.deps.chain.sendSettle(
        priced.call, priced.quote.gasLimit, priced.quote.maxFeePerGas, priced.quote.maxPriorityFeePerGas,
        async (h) => {
          await this.deps.store.updateSettlement(v.settlementKey, { status: 'submitted', tx_hash: h });
          recorded = true;
        },
      );
    } catch (err) {
      if (err instanceof BroadcastError) {
        // Signed and recorded; the network answer was lost. Outcome unknown: wait for the receipt.
        return this.awaitAndFinish({ ...record, status: 'submitted', tx_hash: err.hash }, req.maxTimeoutSeconds, priced.quote.fee);
      }
      if (recorded) {
        return this.awaitAndFinish({ ...record, status: 'submitted', tx_hash: hash! }, req.maxTimeoutSeconds, priced.quote.fee);
      }
      // Nothing reached the chain: the store write before broadcast failed, or signing did.
      const error = String(err instanceof Error ? err.message : err).includes('store_failed_before_broadcast')
        ? 'store_failed_before_broadcast'
        : `send_failed: ${shortError(err)}`;
      try {
        await this.deps.store.updateSettlement(v.settlementKey, { status: 'failed', error, witness_status: 'not_applicable' });
      } catch {
        // The store is what failed; the record stays `submitting` with no hash, which the next
        // attempt treats as a slot it may take (isPreBroadcastFailure covers the recorded case,
        // the hashless `submitting` case is below in resultOfExisting).
      }
      return fail(error === 'store_failed_before_broadcast' ? 'facilitator_unavailable' : 'transaction_failed', v.payer, 'broadcast failed');
    }
    return this.awaitAndFinish({ ...record, status: 'submitted', tx_hash: hash }, req.maxTimeoutSeconds, priced.quote.fee);
  }

  private async awaitAndFinish(record: SettlementRecord, maxTimeoutSeconds: number, fee: bigint): Promise<SettleResult> {
    const hash = record.tx_hash as Hex;
    const timeoutMs = Math.min(Math.max(maxTimeoutSeconds, 10), 120) * 1000;
    let receipt: Receipt;
    try {
      receipt = await this.deps.chain.waitReceipt(hash, timeoutMs);
    } catch {
      // Unknown outcome: keep the record `submitted`; a retried /settle reconciles it.
      return { success: false, errorReason: 'settlement_pending', transaction: hash, network: BASE_NETWORK, payer: record.buyer };
    }
    return this.finishWithReceipt(record, hash, receipt, fee);
  }

  /** The settlement's outcome from its mined receipt: confirmed and witnessed, or failed (and a strike when the seller caused it). */
  private async finishWithReceipt(record: SettlementRecord, hash: Hex, receipt: Receipt, fee: bigint): Promise<SettleResult> {
    if (receipt.status !== 'success' || !this.hasFeeSettled(receipt.logs, record, fee)) {
      await this.deps.store.updateSettlement(record.key, { status: 'failed', error: 'reverted', witness_status: 'not_applicable' });
      // 2026-10-17: a strike is for a revert the SELLER caused — its fee allowance or USDC balance
      // is gone. A buyer can make any settlement revert after broadcast for nothing (an authorization
      // expiring at inclusion, cancelAuthorization, a balance drained in the window); striking the
      // seller for that let any buyer suspend any seller with three cheap reverts.
      if (await this.sellerCannotPayFee(record, fee)) {
        const strikes = await this.deps.store.incrementSellerCounter(record.seller_id, 'strike_count');
        if (strikes >= STRIKES_BEFORE_SUSPENSION) await this.deps.store.suspendSeller(record.seller_id);
      }
      return { success: false, errorReason: 'transaction_failed', transaction: hash, network: BASE_NETWORK, payer: record.buyer };
    }
    await this.deps.store.updateSettlement(record.key, { status: 'confirmed' });
    await this.deps.store.incrementSellerCounter(record.seller_id, 'settlement_count');
    await deliverWitness(this.deps.store, this.deps.witness, { ...record, status: 'confirmed' });
    return {
      success: true,
      transaction: hash,
      network: BASE_NETWORK,
      payer: getAddress(record.buyer),
      extra: { provianFee: { amount: fee.toString(), asset: BASE_USDC, payer: 'seller' } },
    };
  }

  private hasFeeSettled(logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[], record: SettlementRecord, fee: bigint): boolean {
    for (const log of logs) {
      if (!sameAddr(log.address, this.deps.chain.settler)) continue;
      try {
        const ev = decodeEventLog({ abi: settlerAbi, eventName: 'FeeSettled', topics: [...log.topics] as [Hex, ...Hex[]], data: log.data });
        if (
          sameAddr(ev.args.buyer, record.buyer) &&
          sameAddr(ev.args.seller, record.seller) &&
          sameAddr(ev.args.token, record.asset) &&
          ev.args.value === BigInt(record.amount) &&
          ev.args.fee === fee
        ) {
          return true;
        }
      } catch {
        // not a FeeSettled log
      }
    }
    return false;
  }

  private async resultOfExisting(existing: SettlementRecord): Promise<SettleResult> {
    if (existing.status === 'confirmed' && existing.tx_hash) {
      return {
        success: true,
        transaction: existing.tx_hash,
        network: BASE_NETWORK,
        payer: getAddress(existing.buyer),
        extra: { provianFee: { amount: existing.fee, asset: BASE_USDC, payer: 'seller' } },
      };
    }
    if (existing.status === 'submitted' && existing.tx_hash) return this.awaitAndFinish(existing, 60, BigInt(existing.fee));
    return {
      success: false,
      errorReason: existing.status === 'submitting' ? 'settlement_in_progress' : 'transaction_failed',
      transaction: existing.tx_hash ?? '',
      network: BASE_NETWORK,
      payer: existing.buyer,
    };
  }

  /** A prior record answers only the SAME terms: seller, amount, asset, scheme and network. */
  private termsMatch(existing: SettlementRecord, req: Requirements, scheme: 'eip3009' | 'permit2'): boolean {
    return sameAddr(existing.seller, req.payTo)
      && existing.amount === req.amount
      && sameAddr(existing.asset, req.asset)
      && existing.scheme === scheme
      && existing.network === req.network;
  }

  /**
   * True when the seller's own state cannot cover the fee any more: a revert it caused. The fee
   * allowance is the seller's for every scheme; the USDC balance only for a PVT (permit2)
   * payment — a USDC payment delivers the fee's cover in the same transaction (fee < value).
   */
  private async sellerCannotPayFee(record: SettlementRecord, fee: bigint): Promise<boolean> {
    try {
      const seller = getAddress(record.seller);
      const allowance = await this.deps.chain.allowance(BASE_USDC, seller, this.deps.chain.settler);
      if (allowance < fee) return true;
      if (record.scheme === 'permit2') {
        const balance = await this.deps.chain.balanceOf(BASE_USDC, seller);
        if (balance < fee) return true;
      }
      return false;
    } catch {
      return false; // unknown cause: never a strike on a guess
    }
  }

  /**
   * Scheduled: resolve `submitted` records whose receipt wait was lost (instance death, a lost RPC
   * answer) from the chain, confirming and witnessing or failing them (2026-10-17).
   */
  async reconcileStaleSubmitted(olderThanMs = 120_000, limit = 10): Promise<{ scanned: number; resolved: number }> {
    // Base records only: the store is shared with the Solana facilitator, whose signatures a Base
    // node can never find .
    const stale = await this.deps.store.listStaleSubmitted(this.deps.now() - olderThanMs, limit, 'base');
    let resolved = 0;
    const nowSec = Math.floor(this.deps.now() / 1000);
    for (const record of stale) {
      if (!record.tx_hash) continue;
      const hash = record.tx_hash as Hex;
      // One non-waiting lookup per record (a run is bounded by `limit` lookups, never the 60 s
      // Scheduler deadline). "Not mined" (the node knows no receipt) and "the lookup failed" (an RPC
      // outage or a slow node) are different answers: only the first can ever close a record.
      let receipt: Receipt | null;
      try {
        receipt = await this.deps.chain.getReceipt(hash);
      } catch {
        continue; // outcome unknown this run
      }
      if (receipt !== null) {
        try {
          await this.finishWithReceipt(record, hash, receipt, BigInt(record.fee));
          resolved += 1;
        } catch {
          // a write after the receipt failed: the record stays `submitted` for the next run
        }
        continue;
      }
      // Not mined. Once the authorization itself has expired (validBefore / deadline) plus a grace
      // period, a transaction that never mined can no longer settle it — a broadcast the node rejected
      // (nonce too low, replacement underpriced) left exactly this: a hash that never reaches the
      // chain. The record is closed as failed instead of being re-waited forever.
      const expiresAtSec = typeof record.expires_at_sec === 'number'
        ? record.expires_at_sec
        : Math.floor(record.updated_at_ms / 1000) + UNMINED_FALLBACK_AGE_SEC;
      if (nowSec > expiresAtSec + UNMINED_GRACE_SEC) {
        await this.deps.store.updateSettlement(record.key, { status: 'failed', error: 'expired_unmined', witness_status: 'not_applicable' });
        resolved += 1;
      }
    }
    return { scanned: stale.length, resolved };
  }

  /** A payload whose authorization we already settled (its nonce is now used, so verify refuses it). */
  private async priorSettlementFor(payload: Payload, req: Requirements): Promise<SettleResult | null> {
    const e = eip3009PayloadSchema.safeParse(payload.payload);
    const p = permit2PayloadSchema.safeParse(payload.payload);
    let key: string | null = null;
    let scheme: 'eip3009' | 'permit2' | null = null;
    if (e.success) { key = `base_eip3009_${e.data.authorization.from.toLowerCase()}_${e.data.authorization.nonce.toLowerCase()}`; scheme = 'eip3009'; }
    else if (p.success) { key = `base_permit2_${p.data.permit2Authorization.from.toLowerCase()}_${p.data.permit2Authorization.nonce}`; scheme = 'permit2'; }
    if (!key || !scheme) return null;
    const existing = await this.deps.store.getSettlement(key);
    if (!existing || existing.status === 'failed') return null;
    if (!this.termsMatch(existing, req, scheme)) {
      return { success: false, errorReason: 'settlement_mismatch', transaction: '', network: BASE_NETWORK, payer: existing.buyer };
    }
    return this.resultOfExisting(existing);
  }
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0]!.slice(0, 200);
}
