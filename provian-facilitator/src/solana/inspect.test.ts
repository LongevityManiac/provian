import { describe, expect, it, beforeAll } from 'vitest';
import { address, getBase64Encoder, getTransactionDecoder, getBase64EncodedWireTransaction, type KeyPairSigner, type Address } from '@solana/kit';
import { inspectSvmPayment } from './inspect.js';
import { buildSvmPayment, keypairs } from '../test-support/svm-tx.js';

let buyer: KeyPairSigner;
let other: KeyPairSigner;
let feePayerKp: KeyPairSigner;
let sellerKp: KeyPairSigner;
let feePayer: Address;
let seller: Address;

beforeAll(async () => {
  [buyer, other, feePayerKp, sellerKp] = (await keypairs(4)) as [KeyPairSigner, KeyPairSigner, KeyPairSigner, KeyPairSigner];
  feePayer = feePayerKp.address;
  seller = sellerKp.address;
});

const AMOUNT = 1_000_000n;
const FEE = 1_600n;

async function inspect(tx: string, overrides: Partial<{ amount: bigint; feeAmount: bigint; memo: string | null }> = {}) {
  return inspectSvmPayment({
    transactionBase64: tx,
    feePayer,
    payTo: seller,
    amount: overrides.amount ?? AMOUNT,
    // Production: the fee wallet IS the fee payer (its USDC account receives the fee).
    feeWallet: feePayer,
    feeAmount: overrides.feeAmount ?? FEE,
    expectedMemo: overrides.memo ?? null,
  });
}

function base(): Parameters<typeof buildSvmPayment>[0] {
  return { buyer, feePayer, payTo: seller, amount: AMOUNT, feeWallet: feePayer, fee: FEE };
}

describe('inspectSvmPayment — the Provian fee leg', () => {
  it('accepts a payment carrying exactly one fee transfer to the fee wallet', async () => {
    const r = await inspect(await buildSvmPayment(base()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payer).toBe(buyer.address);
      expect(r.fee).toBe(FEE);
      // 2 signatures × 5,000 + ceil(200,000 × 1 / 1e6) = 10,001 lamports.
      expect(r.lamports).toBe(10_001n);
      expect(r.messageHashHex).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('RED: a payment with NO fee transfer is invalid (never submitted)', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), fee: null }));
    expect(r).toMatchObject({ ok: false, reason: 'invalid_instruction_layout' });
  });

  it('RED: a payment with no fee but a memo in slot 3 is refused as fee missing', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), fee: null, memo: 'hello' }));
    expect(r).toMatchObject({ ok: false, reason: 'provian_fee_missing' });
  });

  it('RED: the fee transfer twice is refused', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), duplicateFee: true }));
    expect(r).toMatchObject({ ok: false, reason: 'provian_fee_duplicated' });
  });

  it('RED: a short fee is refused', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), fee: FEE - 1n }));
    expect(r).toMatchObject({ ok: false, reason: 'provian_fee_amount_mismatch' });
  });

  it('RED: a fee to any other wallet is refused', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), feeDestinationOwner: other.address }));
    expect(r).toMatchObject({ ok: false, reason: 'provian_fee_recipient_mismatch' });
  });

  it('RED: a fee in another mint is refused', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), feeMint: address('So11111111111111111111111111111111111111112') }));
    expect(r.ok).toBe(false);
  });

  it('RED: a fee paid by someone other than the buyer is refused', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), feeAuthority: other }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['provian_fee_payer_mismatch', 'invalid_signer_count']).toContain(r.reason);
  });

  it('RED: the fee payer referenced in any instruction is refused (isolation)', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), feePayerAsSource: true }));
    expect(r).toMatchObject({ ok: false, reason: 'fee_payer_not_isolated' });
  });

  it('RED: a transaction whose fee payer is not ours is refused', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), feePayer: other.address }));
    expect(r).toMatchObject({ ok: false, reason: 'fee_payer_mismatch' });
  });

  it('RED: a tampered buyer signature is refused', async () => {
    const tx = await buildSvmPayment(base());
    const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(tx));
    const sigs = { ...decoded.signatures } as Record<string, Uint8Array | null>;
    const s = new Uint8Array(sigs[buyer.address] as Uint8Array);
    s[0] = (s[0]! ^ 0xff) & 0xff;
    sigs[buyer.address] = s;
    const tampered = getBase64EncodedWireTransaction({ ...decoded, signatures: sigs } as unknown as Parameters<typeof getBase64EncodedWireTransaction>[0]);
    const r = await inspect(tampered);
    expect(r).toMatchObject({ ok: false, reason: 'invalid_signature' });
  });

  it('RED: a payment amount other than required is refused', async () => {
    const r = await inspect(await buildSvmPayment(base()), { amount: AMOUNT + 1n });
    expect(r).toMatchObject({ ok: false, reason: 'amount_mismatch' });
  });

  it('RED: a payment to a different recipient is refused', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), payTo: other.address }));
    expect(r).toMatchObject({ ok: false, reason: 'recipient_mismatch' });
  });

  it('RED: a compute price above the bound is refused', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), cuPrice: 5_000_001n }));
    expect(r).toMatchObject({ ok: false, reason: 'compute_price_too_high' });
  });

  it('RED: a compute limit above the bound is refused', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), cuLimit: 400_001 }));
    expect(r).toMatchObject({ ok: false, reason: 'compute_limit_too_high' });
  });

  it('RED: an unknown extra instruction is refused', async () => {
    const extra = { programAddress: address('11111111111111111111111111111111'), data: new Uint8Array([2, 0, 0, 0]), accounts: [] };
    const r = await inspect(await buildSvmPayment({ ...base(), extra }));
    expect(r).toMatchObject({ ok: false, reason: 'unknown_instruction' });
  });

  it('memo: the seller-required memo must match exactly', async () => {
    expect((await inspect(await buildSvmPayment({ ...base(), memo: 'order-42' }), { memo: 'order-42' })).ok).toBe(true);
    expect(await inspect(await buildSvmPayment({ ...base(), memo: 'order-43' }), { memo: 'order-42' })).toMatchObject({ ok: false, reason: 'memo_mismatch' });
  });

  it('lamports include the priority fee the transaction sets (rounded up)', async () => {
    const r = await inspect(await buildSvmPayment({ ...base(), cuLimit: 300_000, cuPrice: 1_000_000n }));
    expect(r.ok && r.lamports).toBe(10_000n + 300_000n);
  });

  it('RED: garbage is refused', async () => {
    expect(await inspect('not-a-transaction')).toMatchObject({ ok: false, reason: 'invalid_transaction' });
  });
});
