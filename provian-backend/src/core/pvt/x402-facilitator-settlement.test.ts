/**
 * — the facilitator lane's pure rules: the pointer parser, the Base receipt reading,
 * the Solana balance-delta reading, and the leg test the outbound USDC watcher shares. Every GREEN
 * sits beside the RED that differs from it in one variable.
 */
import { describe, it, expect } from '@jest/globals';
import { BASE_USDC_ADDRESS, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { transactionEvidence, transferLog, TEST_BLOCK, topicOf } from './__test-helpers__/base-transaction-evidence';
import {
  FEE_SETTLED_TOPIC,
  SOLANA_USDC_MINT,
  facilitatorActPeId,
  facilitatorBaseAssets,
  facilitatorBaseGasAddress,
  facilitatorSettlementNamesLeg,
  facilitatorSettlerAddress,
  parseFacilitatorSettlementBody,
  verifyBaseFacilitatorEvidence,
  verifySolanaFacilitatorTransaction,
  type FacilitatorSettlementClaim,
  type SolanaParsedTransaction,
} from './x402-facilitator-settlement';
import { LIVE_PVT9_TOKEN } from './wallet-exchange';

const SETTLER = '0x5e77100000000000000000000000000000000b01';
const FEE_RECIPIENT = '0xa37fc594e98e951571c771c9e77cdc73f67d3efb';
const FACILITATOR_EOA = FEE_RECIPIENT;
const BUYER = '0xb0b0000000000000000000000000000000000b0b';
const SELLER = '0x5e11e00000000000000000000000000000005e11';
const TX = `0x${'ab'.repeat(32)}`;
const PVT = '0x8811441914381143b9408c5c32247367f86f173a';

function feeSettledLog(
  tx: string,
  fields: { buyer: string; seller: string; token: string; value: bigint; fee: bigint },
  logIndex: number,
  emitter = SETTLER,
): CanonicalEconomicLog {
  return {
    ...transferLog(tx, emitter, fields.buyer, fields.seller, 0n, logIndex),
    topics: [FEE_SETTLED_TOPIC, topicOf(fields.buyer), topicOf(fields.seller), topicOf(fields.token)],
    data: `0x${fields.value.toString(16).padStart(64, '0')}${fields.fee.toString(16).padStart(64, '0')}`,
  };
}

function settlement(over: {
  to?: string;
  asset?: string;
  payment?: CanonicalEconomicLog | null;
  fee?: CanonicalEconomicLog | null;
  settled?: CanonicalEconomicLog | null;
} = {}) {
  const asset = over.asset ?? BASE_USDC_ADDRESS;
  const logs = [
    over.payment === undefined ? transferLog(TX, asset, BUYER, SELLER, 1_000_000n, 1) : over.payment,
    over.fee === undefined ? transferLog(TX, BASE_USDC_ADDRESS, SELLER, FEE_RECIPIENT, 300n, 2) : over.fee,
    over.settled === undefined
      ? feeSettledLog(TX, { buyer: BUYER, seller: SELLER, token: asset, value: 1_000_000n, fee: 300n }, 3)
      : over.settled,
  ].filter((l): l is CanonicalEconomicLog => l !== null);
  return transactionEvidence({
    transactionHash: TX, fromAddress: FACILITATOR_EOA, toAddress: over.to ?? SETTLER, blockTimestampMs: 1_000, logs,
  });
}

const claim = (over: Partial<FacilitatorSettlementClaim> = {}): FacilitatorSettlementClaim => ({
  chain: 'base', txHash: TX, buyer: BUYER, seller: SELLER, asset: BASE_USDC_ADDRESS,
  amount: '1000000', fee: '300', scheme: 'eip3009', ...over,
});
const config = { settler: SETTLER, feeRecipient: FEE_RECIPIENT };

describe('the pointer parser (Unknown = Block)', () => {
  const body = {
    chain: 'base', tx_hash: TX, buyer: BUYER, seller: SELLER, asset: BASE_USDC_ADDRESS,
    amount: '1000000', fee: '300', scheme: 'eip3009',
  };
  it('GREEN: a well-formed Base pointer parses, lowercased', () => {
    const parsed = parseFacilitatorSettlementBody({ ...body, buyer: BUYER.toUpperCase().replace('0X', '0x') });
    expect(parsed).toEqual({ ok: true, claim: claim() });
  });
  it.each([
    ['not an object', 'x', 'body_not_object'],
    ['an extra key', { ...body, extra: '1' }, 'body_keys_invalid'],
    ['a missing key', Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'fee')), 'body_keys_invalid'],
    ['a numeric amount', { ...body, amount: 1000000 }, 'amount_not_string'],
    ['a zero amount', { ...body, amount: '0' }, 'amount_invalid'],
    ['a leading-zero amount', { ...body, amount: '01' }, 'amount_invalid'],
    ['a zero fee (no free tier)', { ...body, fee: '0' }, 'fee_invalid'],
    ['an unknown chain', { ...body, chain: 'arbitrum' }, 'chain_not_supported'],
    ['a Solana scheme on Base', { ...body, scheme: 'svm_exact' }, 'scheme_not_base'],
    ['a short tx hash', { ...body, tx_hash: '0xdead' }, 'tx_hash_invalid'],
    ['a bad buyer', { ...body, buyer: 'nope' }, 'buyer_invalid'],
    ['an asset that is neither USDC nor PVT', { ...body, asset: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb' }, 'asset_not_allowed'],
    ['PVT under EIP-3009', { ...body, asset: PVT }, 'scheme_asset_mismatch'],
    ['a buyer who is the seller', { ...body, seller: BUYER }, 'buyer_is_seller'],
    ['a Base address on Solana', { ...body, chain: 'solana', scheme: 'svm_exact', tx_hash: '5'.repeat(88) }, 'buyer_invalid'],
  ])('RED: refuses %s', (_name, input, reason) => {
    expect(parseFacilitatorSettlementBody(input)).toEqual({ ok: false, reason });
  });
  it('GREEN: PVT under Permit2 parses (PVT has no EIP-3009)', () => {
    expect(parseFacilitatorSettlementBody({ ...body, asset: PVT, scheme: 'permit2' }).ok).toBe(true);
  });
  it('the allowed PVT asset is the LIVE PVT9 token (one source: the generated config)', () => {
    expect(LIVE_PVT9_TOKEN).toBe(PVT);
    expect(Object.keys(facilitatorBaseAssets()).sort()).toEqual([BASE_USDC_ADDRESS, PVT].sort());
  });
  it('a Solana pointer parses only with Solana USDC', () => {
    const sol = {
      chain: 'solana', tx_hash: '5'.repeat(88), buyer: 'B'.repeat(44), seller: 'C'.repeat(44),
      asset: SOLANA_USDC_MINT, amount: '1000000', fee: '50', scheme: 'svm_exact',
    };
    expect(parseFacilitatorSettlementBody(sol).ok).toBe(true);
    expect(parseFacilitatorSettlementBody({ ...sol, asset: 'So11111111111111111111111111111111111111112' }))
      .toEqual({ ok: false, reason: 'asset_not_allowed' });
  });
});

describe('Base: the relay reads the final receipt, never the pointer', () => {
  it('GREEN: the settler tx carrying the payment, the fee and FeeSettled verifies', () => {
    expect(verifyBaseFacilitatorEvidence(settlement(), claim(), config)).toMatchObject({
      ok: true, paymentLogIndex: 1, feeLogIndex: 2, feeSettledLogIndex: 3, blockNumber: TEST_BLOCK,
    });
  });
  it('GREEN: a PVT payment through Permit2 (USDC fee) verifies', () => {
    expect(verifyBaseFacilitatorEvidence(settlement({ asset: PVT }), claim({ asset: PVT, scheme: 'permit2' }), config).ok)
      .toBe(true);
  });
  it('RED: a transaction not sent to the settler', () => {
    expect(verifyBaseFacilitatorEvidence(settlement({ to: BASE_USDC_ADDRESS }), claim(), config))
      .toEqual({ ok: false, reason: 'settler_target_mismatch' });
  });
  it('RED: no Transfer(buyer → seller, amount) from the asset', () => {
    expect(verifyBaseFacilitatorEvidence(settlement({ payment: null }), claim(), config))
      .toEqual({ ok: false, reason: 'payment_transfer_missing' });
  });
  it('RED: the payment amount differs from the pointer', () => {
    expect(verifyBaseFacilitatorEvidence(settlement(), claim({ amount: '1000001' }), config))
      .toEqual({ ok: false, reason: 'payment_transfer_missing' });
  });
  it('RED: the payment came from a different token than the pointer names', () => {
    expect(verifyBaseFacilitatorEvidence(settlement({ asset: PVT }), claim(), config))
      .toEqual({ ok: false, reason: 'payment_transfer_missing' });
  });
  it('RED: no USDC Transfer(seller → fee recipient, fee)', () => {
    expect(verifyBaseFacilitatorEvidence(settlement({ fee: null }), claim(), config))
      .toEqual({ ok: false, reason: 'fee_transfer_missing' });
  });
  it('RED: the fee went somewhere other than the facilitator gas wallet', () => {
    const elsewhere = transferLog(TX, BASE_USDC_ADDRESS, SELLER, BUYER, 300n, 2);
    expect(verifyBaseFacilitatorEvidence(settlement({ fee: elsewhere }), claim(), config))
      .toEqual({ ok: false, reason: 'fee_transfer_missing' });
  });
  it('RED: no FeeSettled from the settler', () => {
    expect(verifyBaseFacilitatorEvidence(settlement({ settled: null }), claim(), config))
      .toEqual({ ok: false, reason: 'fee_settled_event_missing' });
  });
  it('RED: a FeeSettled emitted by another contract', () => {
    const forged = feeSettledLog(TX, { buyer: BUYER, seller: SELLER, token: BASE_USDC_ADDRESS, value: 1_000_000n, fee: 300n }, 3, BUYER);
    expect(verifyBaseFacilitatorEvidence(settlement({ settled: forged }), claim(), config))
      .toEqual({ ok: false, reason: 'fee_settled_event_missing' });
  });
  it('RED: a FeeSettled naming a different fee', () => {
    const other = feeSettledLog(TX, { buyer: BUYER, seller: SELLER, token: BASE_USDC_ADDRESS, value: 1_000_000n, fee: 301n }, 3);
    expect(verifyBaseFacilitatorEvidence(settlement({ settled: other }), claim(), config))
      .toEqual({ ok: false, reason: 'fee_settled_event_missing' });
  });
  it('RED: evidence for another transaction', () => {
    expect(verifyBaseFacilitatorEvidence(settlement(), claim({ txHash: `0x${'cd'.repeat(32)}` }), config))
      .toEqual({ ok: false, reason: 'evidence_transaction_mismatch' });
  });
});

describe('the outbound watcher\'s leg test (one x402 anchor for both lanes)', () => {
  const leg = { from: BUYER, to: SELLER, amountAtomic: '1000000' };
  it('GREEN: the payment leg named by FeeSettled is the x402 payment', () => {
    expect(facilitatorSettlementNamesLeg(settlement(), SETTLER, leg)).toBe(true);
  });
  it('RED: the seller\'s fee leg is never named a payment', () => {
    expect(facilitatorSettlementNamesLeg(settlement(), SETTLER, { from: SELLER, to: FEE_RECIPIENT, amountAtomic: '300' })).toBe(false);
  });
  it('RED: no settler configured, or a different target, or no FeeSettled → not a facilitator payment', () => {
    expect(facilitatorSettlementNamesLeg(settlement(), null, leg)).toBe(false);
    expect(facilitatorSettlementNamesLeg(settlement({ to: BASE_USDC_ADDRESS }), SETTLER, leg)).toBe(false);
    expect(facilitatorSettlementNamesLeg(settlement({ settled: null }), SETTLER, leg)).toBe(false);
  });
  it('RED: a PVT settlement names no USDC leg', () => {
    expect(facilitatorSettlementNamesLeg(settlement({ asset: PVT }), SETTLER, leg)).toBe(false);
  });
});

describe('Solana: the relay reads the finalized transaction', () => {
  const FEE_WALLET = 'DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2';
  const SBUYER = 'B'.repeat(44);
  const SSELLER = 'C'.repeat(44);
  const SIG = '5'.repeat(88);
  const sClaim = claim({ chain: 'solana', txHash: SIG, buyer: SBUYER, seller: SSELLER, asset: SOLANA_USDC_MINT, scheme: 'svm_exact', fee: '50' });
  const bal = (accountIndex: number, owner: string, amount: string) => ({
    accountIndex, owner, mint: SOLANA_USDC_MINT, uiTokenAmount: { amount },
  });
  const tx = (over: { err?: unknown; payer?: string; post?: ReturnType<typeof bal>[]; blockTime?: number | null } = {}): SolanaParsedTransaction => ({
    slot: 300_000_000,
    blockTime: over.blockTime === undefined ? 1_790_000_000 : over.blockTime,
    meta: {
      err: over.err ?? null,
      preTokenBalances: [bal(1, SBUYER, '5000000'), bal(2, SSELLER, '0'), bal(3, FEE_WALLET, '10')],
      postTokenBalances: over.post ?? [bal(1, SBUYER, '3999950'), bal(2, SSELLER, '1000000'), bal(3, FEE_WALLET, '60')],
    },
    transaction: { signatures: [SIG], message: { accountKeys: [{ pubkey: over.payer ?? FEE_WALLET, signer: true }, { pubkey: SBUYER, signer: true }] } },
  });
  const cfg = { feeWallet: FEE_WALLET };

  it('GREEN: seller +amount, fee wallet +fee, buyer debited amount + fee', () => {
    expect(verifySolanaFacilitatorTransaction(tx(), sClaim, cfg)).toEqual({ ok: true, slot: 300_000_000, blockTimeMs: 1_790_000_000_000 });
  });
  it('RED: meta.err is set (the transaction failed)', () => {
    expect(verifySolanaFacilitatorTransaction(tx({ err: { InstructionError: [0, 'Custom'] } }), sClaim, cfg))
      .toEqual({ ok: false, reason: 'transaction_failed' });
  });
  it('RED: no fee credit to the facilitator fee wallet', () => {
    const post = [bal(1, SBUYER, '4000000'), bal(2, SSELLER, '1000000'), bal(3, FEE_WALLET, '10')];
    expect(verifySolanaFacilitatorTransaction(tx({ post }), sClaim, cfg)).toEqual({ ok: false, reason: 'fee_credit_missing' });
  });
  it('RED: the seller was not credited the amount', () => {
    const post = [bal(1, SBUYER, '3999950'), bal(2, SSELLER, '999999'), bal(3, FEE_WALLET, '60')];
    expect(verifySolanaFacilitatorTransaction(tx({ post }), sClaim, cfg)).toEqual({ ok: false, reason: 'seller_credit_mismatch' });
  });
  it('RED: the buyer was not debited amount + fee', () => {
    const post = [bal(1, SBUYER, '5000000'), bal(2, SSELLER, '1000000'), bal(3, FEE_WALLET, '60')];
    expect(verifySolanaFacilitatorTransaction(tx({ post }), sClaim, cfg)).toEqual({ ok: false, reason: 'buyer_debit_missing' });
  });
  it('RED: a transaction the facilitator did not pay for', () => {
    expect(verifySolanaFacilitatorTransaction(tx({ payer: SBUYER }), sClaim, cfg)).toEqual({ ok: false, reason: 'fee_payer_not_facilitator' });
  });
  it('RED: no block time', () => {
    expect(verifySolanaFacilitatorTransaction(tx({ blockTime: null }), sClaim, cfg)).toEqual({ ok: false, reason: 'block_time_missing' });
  });
});

describe('configuration', () => {
  it('the settler is required and must be an address; unset → null (the lane answers 503)', () => {
    expect(facilitatorSettlerAddress({})).toBeNull();
    expect(facilitatorSettlerAddress({ FACILITATOR_SETTLER_ADDRESS: 'nope' })).toBeNull();
    expect(facilitatorSettlerAddress({ FACILITATOR_SETTLER_ADDRESS: SETTLER.toUpperCase().replace('0X', '0x') })).toBe(SETTLER);
  });
  it('the Base gas wallet defaults to the published address; a malformed override is refused', () => {
    expect(facilitatorBaseGasAddress({})).toBe(FEE_RECIPIENT);
    expect(facilitatorBaseGasAddress({ FACILITATOR_BASE_GAS_ADDRESS: 'bad' })).toBeNull();
  });
  it('the act PE id is deterministic per (chain, tx, role) and distinct per role', () => {
    expect(facilitatorActPeId('base', TX, 'buyer')).toBe(facilitatorActPeId('base', TX.toUpperCase().replace('0X', '0x'), 'buyer'));
    expect(facilitatorActPeId('base', TX, 'buyer')).not.toBe(facilitatorActPeId('base', TX, 'seller'));
  });
});
