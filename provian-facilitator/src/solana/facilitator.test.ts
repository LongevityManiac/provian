import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { KeyPairSigner } from '@solana/kit';
import { SolanaFacilitator, readFeeTerms } from './facilitator.js';
import { signQuote } from './quote.js';
import { MemoryStore } from '../store.js';
import { FakeSolanaChain, recordingWitness, seller, noFetch } from '../test-support/fakes.js';
import { buildSvmPayment, keypairs } from '../test-support/svm-tx.js';
import { SOLANA_NETWORK, SOLANA_USDC_MINT } from '../constants.js';
import type { Payload, Requirements } from '../x402-types.js';

const SECRET = 'test-relay-secret-0123456789';
let buyer: KeyPairSigner;
let feePayerKp: KeyPairSigner;
let sellerKp: KeyPairSigner;
let chain: FakeSolanaChain;
let store: MemoryStore;
let witness: ReturnType<typeof recordingWitness>;
let fac: SolanaFacilitator;

beforeAll(async () => {
  [buyer, feePayerKp, sellerKp] = (await keypairs(3)) as [KeyPairSigner, KeyPairSigner, KeyPairSigner];
});

const AMOUNT = 1_000_000n;
// 10,001 lamports at $120 = 1,200.12 µUSDC → 1,201 (rounded up) + 300 = 1,501.
const FEE_AT_120 = 1_501n;

function req(fee: bigint, quote?: string, overrides: Partial<Requirements> = {}): Requirements {
  return {
    scheme: 'exact',
    network: SOLANA_NETWORK,
    asset: SOLANA_USDC_MINT,
    amount: AMOUNT.toString(),
    payTo: sellerKp.address,
    maxTimeoutSeconds: 60,
    extra: {
      feePayer: feePayerKp.address,
      provianFee: { amount: fee.toString(), payTo: feePayerKp.address, asset: SOLANA_USDC_MINT, ...(quote ? { quote } : {}) },
    },
    ...overrides,
  };
}

async function payload(r: Requirements, fee: bigint | null, extensions?: Record<string, unknown>): Promise<Payload> {
  const tx = await buildSvmPayment({ buyer, feePayer: feePayerKp.address, payTo: sellerKp.address, amount: AMOUNT, feeWallet: feePayerKp.address, fee });
  return { x402Version: 2, accepted: r, payload: { transaction: tx }, ...(extensions ? { extensions } : {}) };
}

beforeEach(async () => {
  chain = new FakeSolanaChain(feePayerKp.address, feePayerKp);
  store = new MemoryStore();
  witness = recordingWitness();
  await store.upsertSeller(seller('solana', sellerKp.address));
  fac = new SolanaFacilitator({
    chain,
    store,
    relayUrl: 'https://relay.test',
    fetch: noFetch,
    witness: witness.reporter,
    quoteSecret: SECRET,
    priceMaxAgeSeconds: 120,
    now: () => Date.now(),
    feeWallet: feePayerKp.address,
  });
});

describe('Solana verify + settle', () => {
  it('a payment carrying the fee verifies and settles: co-signed once, witness reported', async () => {
    const r = req(FEE_AT_120);
    const p = await payload(r, FEE_AT_120);
    expect(await fac.verify(p, r)).toMatchObject({ isValid: true, payer: buyer.address });
    const s = await fac.settle(p, r);
    expect(s).toMatchObject({ success: true, transaction: 'sig1', payer: buyer.address });
    expect(chain.sent).toHaveLength(1);
    expect(witness.reports).toEqual([
      { chain: 'solana', tx_hash: 'sig1', buyer: buyer.address, seller: sellerKp.address, asset: SOLANA_USDC_MINT, amount: AMOUNT.toString(), fee: FEE_AT_120.toString(), scheme: 'svm_exact' },
    ]);
    // Idempotent: the same transaction settles once.
    expect(await fac.settle(p, r)).toMatchObject({ success: true, transaction: 'sig1' });
    expect(chain.sent).toHaveLength(1);
  });

  it('RED: a fee one unit below actual gas + $0.0003 is never submitted', async () => {
    const r = req(FEE_AT_120 - 1n);
    const p = await payload(r, FEE_AT_120 - 1n);
    const v = await fac.verify(p, r);
    expect(v).toMatchObject({ isValid: false, invalidReason: 'fee_below_cost' });
    expect(await fac.settle(p, r)).toMatchObject({ success: false, errorReason: 'fee_below_cost' });
    expect(chain.sent).toHaveLength(0);
  });

  it('RED: a transaction without the fee leg is never submitted', async () => {
    const r = req(FEE_AT_120);
    const p = await payload(r, null);
    expect(await fac.settle(p, r)).toMatchObject({ success: false });
    expect(chain.sent).toHaveLength(0);
  });

  it('a fresh signed quote fixes the margin price; live coverage still binds', async () => {
    // Quote at $100: gas 1,000.1 → 1,001 + 300 = 1,301.
    const quote = signQuote(SECRET, SOLANA_NETWORK, { price: 100_00000000n, expo: -8, issuedAtMs: Date.now() });
    const r = req(1_301n, quote);
    expect(await fac.verify(await payload(r, 1_301n), r)).toMatchObject({ isValid: true });
    // Live price jumps to $140: gas alone is 1,400.14 → 1,401 > 1,301 — coverage refuses even with the quote.
    chain.price = { ...chain.price, price: 140_00000000n };
    expect(await fac.verify(await payload(r, 1_301n), r)).toMatchObject({ isValid: false, invalidReason: 'fee_below_cost' });
  });

  it('RED: an expired or forged quote falls back to the live price', async () => {
    const stale = signQuote(SECRET, SOLANA_NETWORK, { price: 100_00000000n, expo: -8, issuedAtMs: Date.now() - 6 * 60_000 });
    const r1 = req(1_301n, stale);
    expect(await fac.verify(await payload(r1, 1_301n), r1)).toMatchObject({ isValid: false, invalidReason: 'fee_below_cost' });
    const forged = signQuote('another-secret-entirely-xxxx', SOLANA_NETWORK, { price: 100_00000000n, expo: -8, issuedAtMs: Date.now() });
    const r2 = req(1_301n, forged);
    expect(await fac.verify(await payload(r2, 1_301n), r2)).toMatchObject({ isValid: false, invalidReason: 'fee_below_cost' });
  });

  it('RED: provianFee terms naming another wallet are refused before anything else', async () => {
    const r = req(FEE_AT_120);
    r.extra.provianFee = { amount: FEE_AT_120.toString(), payTo: sellerKp.address, asset: SOLANA_USDC_MINT };
    expect(await fac.verify(await payload(r, FEE_AT_120), r)).toMatchObject({ isValid: false, invalidReason: 'provian_fee_terms_invalid' });
  });

  it('RED: a fee above the $0.05 cap is refused', () => {
    expect(readFeeTerms({ provianFee: { amount: '50001', payTo: 'W', asset: SOLANA_USDC_MINT } }, 'W')).toBeNull();
    expect(readFeeTerms({ provianFee: { amount: '50000', payTo: 'W', asset: SOLANA_USDC_MINT } }, 'W')).not.toBeNull();
  });

  it('RED: unregistered seller', async () => {
    store.sellers.clear();
    const r = req(FEE_AT_120);
    expect(await fac.verify(await payload(r, FEE_AT_120), r)).toMatchObject({ isValid: false, invalidReason: 'seller_not_registered' });
  });

  it('RED: a fee payer the facilitator does not manage', async () => {
    const r = req(FEE_AT_120, undefined, {});
    r.extra.feePayer = buyer.address;
    expect(await fac.verify(await payload(r, FEE_AT_120), r)).toMatchObject({ isValid: false, invalidReason: 'fee_payer_not_managed' });
  });

  it('RED: a failing simulation is never submitted', async () => {
    chain.simulateError = new Error('insufficient funds');
    const r = req(FEE_AT_120);
    expect(await fac.settle(await payload(r, FEE_AT_120), r)).toMatchObject({ success: false, errorReason: 'transaction_simulation_failed' });
    expect(chain.sent).toHaveLength(0);
  });

  it('RED: a stale SOL price refuses (never prices on stale data)', async () => {
    chain.solUsd = async () => {
      throw new Error('stale');
    };
    const r = req(FEE_AT_120);
    expect(await fac.verify(await payload(r, FEE_AT_120), r)).toMatchObject({ isValid: false, invalidReason: 'fee_price_unavailable' });
  });

  it('RED: an empty gas wallet submits nothing', async () => {
    chain.balanceLamports = 100n;
    const r = req(FEE_AT_120);
    expect(await fac.settle(await payload(r, FEE_AT_120), r)).toMatchObject({ success: false, errorReason: 'facilitator_gas_low' });
    expect(chain.sent).toHaveLength(0);
  });

  it('a transaction that fails on chain reports no witness', async () => {
    chain.confirmOutcome = 'failed';
    const r = req(FEE_AT_120);
    expect(await fac.settle(await payload(r, FEE_AT_120), r)).toMatchObject({ success: false, errorReason: 'transaction_failed' });
    expect(witness.reports).toHaveLength(0);
  });

  it('presentation: required → refused without one (reading stays free: verify is the gate)', async () => {
    store.sellers.set(`solana:${sellerKp.address}`, seller('solana', sellerKp.address, { require_presentation: { tier: 'pe_fact' } }));
    const r = req(FEE_AT_120);
    expect(await fac.verify(await payload(r, FEE_AT_120), r)).toMatchObject({ isValid: false, invalidReason: 'presentation_required' });
    expect(
      await fac.verify(await payload(r, FEE_AT_120, { 'provian-presentation': { token: 'x'.repeat(40), challenge: 'x402-pay:someone-else' } }), r),
    ).toMatchObject({ isValid: false, invalidReason: 'presentation_challenge_mismatch' });
  });
});

/**
 * M2 (fix run 2026-10-24, CC launch audit): a payment that landed is never reported failed, and a
 * retry after an ambiguous result recovers it — the outcome Base already produces. The lost-answer
 * broadcast is modelled on both chain shapes (the one-call sign-and-send the old code used, and the
 * split sign/send), so the same cases run as the failing control against the old code.
 */
describe('M2 — a settled Solana payment is never reported failed', () => {
  /** The node accepted the broadcast; its answer was lost (timeout, socket reset, 5xx). */
  function loseBroadcastAnswer(): void {
    const lost = new Error('socket hang up');
    Object.assign(chain as unknown as Record<string, unknown>, {
      signAndSend: async (tx: string) => { chain.sent.push(tx); throw lost; },
      send: async (signed: string) => { chain.sent.push(signed); throw lost; },
    });
  }

  it('a broadcast whose answer is lost after the node accepted it settles, and a retry after it landed recovers it', async () => {
    loseBroadcastAnswer();
    const r = req(FEE_AT_120);
    const p = await payload(r, FEE_AT_120);
    const first = await fac.settle(p, r);
    expect(chain.sent).toHaveLength(1); // the transaction reached the network
    expect(first).toMatchObject({ success: true, transaction: 'sig1', payer: buyer.address });
    expect(witness.reports).toHaveLength(1);
    // The retry: the transaction has landed, so it no longer simulates — the settlement still answers.
    chain.simulateError = new Error('AlreadyProcessed');
    expect(await fac.settle(p, r)).toMatchObject({ success: true, transaction: 'sig1' });
    expect(chain.sent).toHaveLength(1);
    expect(witness.reports).toHaveLength(1);
  });

  it('a lost broadcast whose confirmation also times out is pending (never failed); the retry recovers the settled payment', async () => {
    loseBroadcastAnswer();
    chain.confirmOutcome = 'throw';
    const r = req(FEE_AT_120);
    const p = await payload(r, FEE_AT_120);
    const first = await fac.settle(p, r);
    expect(first.success).toBe(false);
    expect(first.errorReason).toBe('settlement_pending');
    expect(witness.reports).toHaveLength(0);
    chain.confirmOutcome = 'confirmed';
    chain.simulateError = new Error('AlreadyProcessed');
    expect(await fac.settle(p, r)).toMatchObject({ success: true, transaction: 'sig1' });
    expect(witness.reports).toHaveLength(1);
  });

  it('the scheduled reconciliation confirms a stale signature from the chain; one the cluster never saw closes only past the blockhash lifetime', async () => {
    let now = Date.now();
    fac = new SolanaFacilitator({
      chain, store, relayUrl: 'https://relay.test', fetch: noFetch, witness: witness.reporter,
      quoteSecret: SECRET, priceMaxAgeSeconds: 120, now: () => now, feeWallet: feePayerKp.address,
    });
    loseBroadcastAnswer();
    chain.confirmOutcome = 'throw';
    const r = req(FEE_AT_120);
    const landed = await fac.settle(await payload(r, FEE_AT_120), r);
    // A second, distinct transaction (another compute price, the same gas cost).
    const other = await buildSvmPayment({ buyer, feePayer: feePayerKp.address, payTo: sellerKp.address, amount: AMOUNT, feeWallet: feePayerKp.address, fee: FEE_AT_120, cuPrice: 2n });
    const unseen = await fac.settle({ x402Version: 2, accepted: r, payload: { transaction: other } }, r);
    expect([landed.errorReason, unseen.errorReason]).toEqual(['settlement_pending', 'settlement_pending']);
    chain.statuses.set(landed.transaction, 'confirmed');

    now += 3 * 60_000;
    expect(await fac.reconcileStaleSubmitted(120_000)).toEqual({ scanned: 2, resolved: 1 });
    expect(witness.reports.map((w) => w.tx_hash)).toEqual([landed.transaction]);
    // The unseen one is still open: a young not-found is not a failure.
    const open = [...store.settlements.values()].find((x) => x.tx_hash === unseen.transaction);
    expect(open?.status).toBe('submitted');

    now += 10 * 60_000;
    expect(await fac.reconcileStaleSubmitted(120_000)).toEqual({ scanned: 1, resolved: 1 });
    const closed = [...store.settlements.values()].find((x) => x.tx_hash === unseen.transaction);
    expect(closed).toMatchObject({ status: 'failed', error: 'expired_unlanded' });
  });

  it('RED control: a signing failure (nothing reached the network) is still reported failed at once', async () => {
    Object.assign(chain as unknown as Record<string, unknown>, {
      signAndSend: async () => { throw new Error('signer unavailable'); },
      sign: async () => { throw new Error('signer unavailable'); },
    });
    const r = req(FEE_AT_120);
    expect(await fac.settle(await payload(r, FEE_AT_120), r)).toMatchObject({ success: false, errorReason: 'transaction_failed' });
    expect(chain.sent).toHaveLength(0);
  });
});
