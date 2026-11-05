/**
 * x402 Solana (SVM) signer — money-path correctness.
 *
 * The hand-rolled ATA + TransferChecked helpers are cross-checked against the
 * canonical @solana/spl-token library (a DEV-only dep). The built transaction is
 * decoded back and asserted: instruction order/contents, correct fee payer,
 * exact amount, destination = payTo's ATA, and a valid client signature.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  Keypair,
  PublicKey,
  VersionedTransaction,
  ComputeBudgetProgram,
  TransactionInstruction,
} from '@solana/web3.js';
// @solana/spl-token is ESM-only; import it DYNAMICALLY (not statically) so the
// SDK's CommonJS typecheck of test files does not hit TS1479/TS1542. It is a
// DEV-only cross-check dependency; runtime is vitest/ESM. The functions are
// typed via @solana/web3.js types (CJS-safe) rather than the ESM module type.
interface SplSubset {
  getAssociatedTokenAddressSync: (mint: PublicKey, owner: PublicKey) => PublicKey;
  createTransferCheckedInstruction: (
    source: PublicKey, mint: PublicKey, destination: PublicKey, owner: PublicKey,
    amount: number | bigint, decimals: number,
  ) => TransactionInstruction;
}
let getAssociatedTokenAddressSync: SplSubset['getAssociatedTokenAddressSync'];
let createTransferCheckedInstruction: SplSubset['createTransferCheckedInstruction'];
beforeAll(async () => {
  const spl = (await import('@solana/spl-token')) as unknown as SplSubset;
  getAssociatedTokenAddressSync = spl.getAssociatedTokenAddressSync;
  createTransferCheckedInstruction = spl.createTransferCheckedInstruction;
});
import { deriveSolanaAddress, deriveSolanaEd25519Seed } from './chains';
import {
  associatedTokenAddress,
  transferCheckedInstruction,
  signX402SvmPayment,
  buildSvmPaymentHeader,
  selectCompatibleSvmRequirement,
  deriveSolanaKeypair,
  resolveProvianFee,
  PROVIAN_SOLANA_FACILITATOR_FEE_WALLET,
  PROVIAN_SOLANA_FACILITATOR_FEE_MAX_ATOMIC,
} from './x402-signer-svm';
import { createHash } from 'crypto';
import type { PaymentRequirement, PaymentRequired } from './x402-signer';

const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AGENT_KEY = '11'.repeat(32); // deterministic 32-byte hex
const FEE_PAYER = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey;
const PAY_TO = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(3)).toBase58();

function requirement(over: Partial<PaymentRequirement> = {}): PaymentRequirement {
  return {
    scheme: 'exact',
    network: MAINNET,
    amount: '1000000', // 1 USDC
    asset: USDC_MINT,
    payTo: PAY_TO.toBase58(),
    extra: { feePayer: FEE_PAYER.toBase58(), memo: 'pi_test_123' },
    ...over,
  };
}

// Generous per-payment ceiling for the behavior tests (F31). The cap-enforcement
// negative controls call signX402SvmPayment directly.
const MAX_ATOMIC = 100_000_000n; // 100 USDC
function signSvmWithCap(
  args: Omit<Parameters<typeof signX402SvmPayment>[0], 'maxAmountAtomic'> & { maxAmountAtomic?: bigint },
): ReturnType<typeof signX402SvmPayment> {
  return signX402SvmPayment({ maxAmountAtomic: MAX_ATOMIC, ...args });
}

describe('hand-rolled SPL helpers match @solana/spl-token', () => {
  it('associatedTokenAddress === getAssociatedTokenAddressSync', () => {
    const mint = new PublicKey(USDC_MINT);
    for (const owner of [FEE_PAYER, PAY_TO, deriveSolanaKeypair(AGENT_KEY).publicKey]) {
      expect(associatedTokenAddress(mint, owner).toBase58()).toBe(
        getAssociatedTokenAddressSync(mint, owner).toBase58(),
      );
    }
  });

  it('transferCheckedInstruction === createTransferCheckedInstruction (data + keys)', () => {
    const mint = new PublicKey(USDC_MINT);
    const src = associatedTokenAddress(mint, deriveSolanaKeypair(AGENT_KEY).publicKey);
    const dst = associatedTokenAddress(mint, PAY_TO);
    const owner = deriveSolanaKeypair(AGENT_KEY).publicKey;
    const mine = transferCheckedInstruction(src, mint, dst, owner, 1_000_000n, 6);
    const canon = createTransferCheckedInstruction(src, mint, dst, owner, 1_000_000n, 6);
    expect(Buffer.from(mine.data).toString('hex')).toBe(Buffer.from(canon.data).toString('hex'));
    expect(mine.keys.map(k => k.pubkey.toBase58())).toEqual(canon.keys.map(k => k.pubkey.toBase58()));
    expect(mine.keys.map(k => [k.isSigner, k.isWritable])).toEqual(canon.keys.map(k => [k.isSigner, k.isWritable]));
  });
});

describe('deriveSolanaAddress parity', () => {
  it('chains.deriveSolanaAddress === Keypair.fromSeed(seed).publicKey', () => {
    const seed = deriveSolanaEd25519Seed(AGENT_KEY);
    expect(deriveSolanaAddress(AGENT_KEY)).toBe(Keypair.fromSeed(seed).publicKey.toBase58());
  });
});

describe('signX402SvmPayment', () => {
  it('builds a valid partially-signed tx with correct instructions and fee payer', async () => {
    const signed = await signSvmWithCap({
      privateKeyHex: AGENT_KEY,
      requirement: requirement(),
      recentBlockhash: BLOCKHASH,
    });
    expect(signed.payer).toBe(deriveSolanaAddress(AGENT_KEY));

    const vtx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(signed.transaction, 'base64')));
    const msg = vtx.message;
    const keys = msg.staticAccountKeys.map(k => k.toBase58());
    // Fee payer is the FIRST account = the facilitator, not the agent.
    expect(keys[0]).toBe(FEE_PAYER.toBase58());

    // 4 instructions in spec order: CU limit, CU price, TransferChecked, Memo.
    expect(msg.compiledInstructions).toHaveLength(4);
    const programOf = (i: number) => keys[msg.compiledInstructions[i].programIdIndex];
    expect(programOf(0)).toBe(ComputeBudgetProgram.programId.toBase58());
    expect(programOf(1)).toBe(ComputeBudgetProgram.programId.toBase58());
    expect(programOf(2)).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'); // SPL token
    expect(programOf(3)).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'); // memo

    // TransferChecked: [12, amount u64 LE, decimals]
    const tcData = Buffer.from(msg.compiledInstructions[2].data);
    expect(tcData[0]).toBe(12);
    expect(tcData.readBigUInt64LE(1)).toBe(1_000_000n);
    expect(tcData[9]).toBe(6);

    // Destination must be payTo's ATA.
    const mint = new PublicKey(USDC_MINT);
    const destAta = associatedTokenAddress(mint, PAY_TO).toBase58();
    const tcAccounts = msg.compiledInstructions[2].accountKeyIndexes.map(i => keys[i]);
    expect(tcAccounts).toContain(destAta);

    // The agent's signature slot is filled (its authority signs); the fee-payer
    // slot is left empty for the facilitator to co-sign.
    const agentIdx = keys.indexOf(deriveSolanaAddress(AGENT_KEY));
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    const agentSig = vtx.signatures[agentIdx];
    expect(agentSig.some(b => b !== 0)).toBe(true); // agent signed
    const feePayerSig = vtx.signatures[0];
    expect(feePayerSig.every(b => b === 0)).toBe(true); // facilitator slot empty
  });

  it('FAIL CLOSED: rejects an asset that is not the pinned USDC mint', async () => {
    await expect(
      signSvmWithCap({
        privateKeyHex: AGENT_KEY,
        requirement: requirement({ asset: 'So11111111111111111111111111111111111111112' }),
        recentBlockhash: BLOCKHASH,
      }),
    ).rejects.toThrow(/pinned USDC/i);
  });

  it('FAIL CLOSED: rejects an unsupported network and a non-exact scheme', async () => {
    await expect(
      signSvmWithCap({ privateKeyHex: AGENT_KEY, requirement: requirement({ network: 'solana:unknown' }), recentBlockhash: BLOCKHASH }),
    ).rejects.toThrow(/network/i);
    await expect(
      signSvmWithCap({ privateKeyHex: AGENT_KEY, requirement: requirement({ scheme: 'upto' as unknown as 'exact' }), recentBlockhash: BLOCKHASH }),
    ).rejects.toThrow(/scheme/i);
  });

  it('FAIL CLOSED: rejects a missing/invalid feePayer', async () => {
    await expect(
      signSvmWithCap({ privateKeyHex: AGENT_KEY, requirement: requirement({ extra: {} }), recentBlockhash: BLOCKHASH }),
    ).rejects.toThrow(/feePayer/i);
  });

  it('FAIL CLOSED: refuses an amount above the per-payment ceiling before signing (F31)', async () => {
    // RED: pre-fix this signed any seller-supplied amount. The ceiling is
    // required and enforced before signing.
    let code = '';
    try {
      await signX402SvmPayment({
        privateKeyHex: AGENT_KEY,
        requirement: requirement({ amount: '5000000000' }), // $5,000 hostile 402
        maxAmountAtomic: 1_000_000n, // $1 ceiling
        recentBlockhash: BLOCKHASH,
      });
      throw new Error('SHOULD_HAVE_THROWN');
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
      expect((e as Error).message).not.toBe('SHOULD_HAVE_THROWN');
    }
    expect(code).toBe('X402_AMOUNT_EXCEEDS_CAP');
  });

  it('FAIL CLOSED: refuses when no ceiling is supplied (required, no unlimited default) (F31)', async () => {
    let code = '';
    try {
      await signX402SvmPayment({
        privateKeyHex: AGENT_KEY,
        requirement: requirement(),
        recentBlockhash: BLOCKHASH,
      } as unknown as Parameters<typeof signX402SvmPayment>[0]);
      throw new Error('SHOULD_HAVE_THROWN');
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
      expect((e as Error).message).not.toBe('SHOULD_HAVE_THROWN');
    }
    expect(code).toBe('X402_CEILING_REQUIRED');
  });

  it('produces a decodable v2 payment header', async () => {
    const signed = await signSvmWithCap({ privateKeyHex: AGENT_KEY, requirement: requirement(), recentBlockhash: BLOCKHASH });
    const header = buildSvmPaymentHeader(signed, requirement());
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.network).toBe(MAINNET);
    expect(decoded.payload.transaction).toBe(signed.transaction);
  });
});

describe('selectCompatibleSvmRequirement', () => {
  it('selects a Solana option and rejects EVM/mismatched-asset options', () => {
    const evm: PaymentRequirement = { scheme: 'exact', network: 'eip155:8453', amount: '1', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0xabc' };
    const pr: PaymentRequired = { x402Version: 2, resource: { url: 'x' }, accepts: [evm, requirement()] };
    const picked = selectCompatibleSvmRequirement(pr);
    expect(picked?.network).toBe(MAINNET);

    const evmOnly: PaymentRequired = { x402Version: 2, resource: { url: 'x' }, accepts: [evm] };
    expect(selectCompatibleSvmRequirement(evmOnly)).toBeNull();

    const wrongAsset: PaymentRequired = { x402Version: 2, resource: { url: 'x' }, accepts: [requirement({ asset: 'So11111111111111111111111111111111111111112' })] };
    expect(selectCompatibleSvmRequirement(wrongAsset)).toBeNull();
  });
});

describe('Provian facilitator fee (extra.provianFee)', () => {
  const FEE_WALLET = new PublicKey(PROVIAN_SOLANA_FACILITATOR_FEE_WALLET);
  const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  // sha256 of the base64 transaction the signer produced for `requirement()`
  // (fixed key, blockhash, memo) BEFORE the provianFee change was written —
  // captured by running the pre-change code. Ed25519 signatures are
  // deterministic, so a requirement with no provianFee must keep producing
  // exactly these bytes.
  const PRE_CHANGE_TX_SHA256 = '82ccf989f6223f6b1f4e9753195bfa8eec3e2ef0c32d250c8433d41788e60ac6';

  function feeRequirement(fee: unknown, over: Partial<PaymentRequirement> = {}): PaymentRequirement {
    return requirement({
      extra: { feePayer: FEE_PAYER.toBase58(), memo: 'pi_test_123', provianFee: fee },
      ...over,
    });
  }
  const goodFee = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    amount: '10000', // $0.01
    payTo: PROVIAN_SOLANA_FACILITATOR_FEE_WALLET,
    asset: USDC_MINT,
    ...over,
  });
  const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
  const decode = (b64: string): VersionedTransaction =>
    VersionedTransaction.deserialize(new Uint8Array(Buffer.from(b64, 'base64')));

  /** Resolves to the refusal code, or 'SIGNED' when the signer produced a tx. */
  async function codeOf(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      return (e as { code?: string }).code ?? `uncoded:${(e as Error).message}`;
    }
    return 'SIGNED';
  }

  it('exports the pinned fee wallet and the $0.05 bound', () => {
    expect(PROVIAN_SOLANA_FACILITATOR_FEE_WALLET).toBe('DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2');
    expect(PROVIAN_SOLANA_FACILITATOR_FEE_MAX_ATOMIC).toBe(50_000n);
  });

  it('no provianFee: the transaction is byte-identical to the pre-change signer output', async () => {
    const signed = await signSvmWithCap({ privateKeyHex: AGENT_KEY, requirement: requirement(), recentBlockhash: BLOCKHASH });
    expect(sha256(signed.transaction)).toBe(PRE_CHANGE_TX_SHA256);
    expect(decode(signed.transaction).message.compiledInstructions).toHaveLength(4);
    expect(resolveProvianFee(requirement())).toBeNull();
  });

  it('RED CONTROL for the byte-identity pin: a fee-bearing tx does NOT match the pre-change hash', async () => {
    const signed = await signSvmWithCap({ privateKeyHex: AGENT_KEY, requirement: feeRequirement(goodFee()), recentBlockhash: BLOCKHASH });
    expect(sha256(signed.transaction)).not.toBe(PRE_CHANGE_TX_SHA256);
  });

  it('adds the fee TransferChecked at index 3 with exact accounts, amount and decimals', async () => {
    const signed = await signSvmWithCap({ privateKeyHex: AGENT_KEY, requirement: feeRequirement(goodFee()), recentBlockhash: BLOCKHASH });
    const vtx = decode(signed.transaction);
    const msg = vtx.message;
    const keys = msg.staticAccountKeys.map(k => k.toBase58());
    expect(keys[0]).toBe(FEE_PAYER.toBase58());
    expect(msg.compiledInstructions).toHaveLength(5);
    const programOf = (i: number): string => keys[msg.compiledInstructions[i].programIdIndex];
    expect(programOf(0)).toBe(ComputeBudgetProgram.programId.toBase58());
    expect(programOf(1)).toBe(ComputeBudgetProgram.programId.toBase58());
    expect(programOf(2)).toBe(TOKEN_PROGRAM);
    expect(programOf(3)).toBe(TOKEN_PROGRAM);
    expect(programOf(4)).toBe(MEMO_PROGRAM);

    const mint = new PublicKey(USDC_MINT);
    const buyer = deriveSolanaKeypair(AGENT_KEY).publicKey;
    const buyerAta = getAssociatedTokenAddressSync(mint, buyer).toBase58();
    const feeAta = getAssociatedTokenAddressSync(mint, FEE_WALLET).toBase58(); // canonical lib derivation

    // Payment (index 2) is unchanged: 1 USDC to payTo's ATA.
    const pay = msg.compiledInstructions[2];
    expect(Buffer.from(pay.data).readBigUInt64LE(1)).toBe(1_000_000n);
    expect(pay.accountKeyIndexes.map(i => keys[i])).toEqual([
      buyerAta, USDC_MINT, getAssociatedTokenAddressSync(mint, PAY_TO).toBase58(), buyer.toBase58(),
    ]);

    // Fee (index 3): [12, 10000 u64 LE, 6]; source = buyer's USDC ATA,
    // mint = USDC, destination = the pinned fee wallet's USDC ATA, authority = buyer.
    const fee = msg.compiledInstructions[3];
    const feeData = Buffer.from(fee.data);
    expect(feeData.length).toBe(10);
    expect(feeData[0]).toBe(12);
    expect(feeData.readBigUInt64LE(1)).toBe(10_000n);
    expect(feeData[9]).toBe(6);
    expect(fee.accountKeyIndexes.map(i => keys[i])).toEqual([buyerAta, USDC_MINT, feeAta, buyer.toBase58()]);
    const canon = createTransferCheckedInstruction(new PublicKey(buyerAta), mint, new PublicKey(feeAta), buyer, 10_000n, 6);
    expect(feeData.toString('hex')).toBe(Buffer.from(canon.data).toString('hex'));
    expect(msg.isAccountWritable(keys.indexOf(feeAta))).toBe(true);
    expect(msg.isAccountWritable(keys.indexOf(buyerAta))).toBe(true);
    expect(msg.isAccountSigner(keys.indexOf(buyer.toBase58()))).toBe(true);
    // Agent signed; the facilitator's fee-payer slot is still empty.
    expect(vtx.signatures[keys.indexOf(buyer.toBase58())].some(b => b !== 0)).toBe(true);
    expect(vtx.signatures[0].every(b => b === 0)).toBe(true);
  });

  it('accepts the bound exactly (50_000) and passes an opaque quote through under accepted.extra', async () => {
    const req = feeRequirement(goodFee({ amount: '50000', quote: 'q_opaque_123' }));
    const signed = await signSvmWithCap({ privateKeyHex: AGENT_KEY, requirement: req, recentBlockhash: BLOCKHASH });
    const fee = decode(signed.transaction).message.compiledInstructions[3];
    expect(Buffer.from(fee.data).readBigUInt64LE(1)).toBe(50_000n);
    const decoded = JSON.parse(Buffer.from(buildSvmPaymentHeader(signed, req), 'base64').toString('utf8'));
    expect(decoded.accepted.extra.provianFee.quote).toBe('q_opaque_123');
    expect(resolveProvianFee(req)).toEqual({
      amountAtomic: 50_000n, payTo: PROVIAN_SOLANA_FACILITATOR_FEE_WALLET, asset: USDC_MINT, quote: 'q_opaque_123',
    });
  });

  it('RED: a payTo other than the pinned fee wallet is refused (never signed)', async () => {
    const hostile: unknown[] = [PAY_TO.toBase58(), FEE_PAYER.toBase58(), PROVIAN_SOLANA_FACILITATOR_FEE_WALLET.toLowerCase(), '', undefined];
    for (const payTo of hostile) {
      expect(await codeOf(signSvmWithCap({
        privateKeyHex: AGENT_KEY, requirement: feeRequirement(goodFee({ payTo })), recentBlockhash: BLOCKHASH,
      }))).toBe('X402_PROVIAN_FEE_REFUSED');
    }
  });

  it('RED: an asset other than the pinned USDC mint is refused', async () => {
    const hostile: unknown[] = ['So11111111111111111111111111111111111111112', DEVNET_USDC, USDC_MINT.toLowerCase(), undefined];
    for (const asset of hostile) {
      expect(await codeOf(signSvmWithCap({
        privateKeyHex: AGENT_KEY, requirement: feeRequirement(goodFee({ asset })), recentBlockhash: BLOCKHASH,
      }))).toBe('X402_PROVIAN_FEE_REFUSED');
    }
  });

  it('RED: amount 0 / negative / non-integer / hex / padded / non-string / over the bound is refused', async () => {
    const hostile: unknown[] = ['0', '-1', '-10000', '1.5', '10000.0', '0x10', ' 10000', '010000', '', '50001', '1000000', 10_000, undefined];
    for (const amount of hostile) {
      expect(await codeOf(signSvmWithCap({
        privateKeyHex: AGENT_KEY, requirement: feeRequirement(goodFee({ amount })), recentBlockhash: BLOCKHASH,
      }))).toBe('X402_PROVIAN_FEE_REFUSED');
    }
  });

  it('RED: a present-but-malformed provianFee (null / string / array / non-string quote) is refused, not dropped', async () => {
    const hostile: unknown[] = [null, PROVIAN_SOLANA_FACILITATOR_FEE_WALLET, [goodFee()], goodFee({ quote: 42 })];
    for (const fee of hostile) {
      expect(await codeOf(signSvmWithCap({
        privateKeyHex: AGENT_KEY, requirement: feeRequirement(fee), recentBlockhash: BLOCKHASH,
      }))).toBe('X402_PROVIAN_FEE_REFUSED');
    }
  });

  it('RED: amount + fee over the ceiling is refused while the amount alone fits (the fee tips it)', async () => {
    const ceiling = 1_005_000n; // payment 1_000_000 fits; payment + 10_000 fee does not
    // Same payment, no fee: signs under this ceiling.
    expect(await codeOf(signX402SvmPayment({
      privateKeyHex: AGENT_KEY, requirement: requirement(), maxAmountAtomic: ceiling, recentBlockhash: BLOCKHASH,
    }))).toBe('SIGNED');
    // With the fee: refused before signing, and the refusal names the fee.
    await expect(signX402SvmPayment({
      privateKeyHex: AGENT_KEY, requirement: feeRequirement(goodFee()), maxAmountAtomic: ceiling, recentBlockhash: BLOCKHASH,
    })).rejects.toMatchObject({ code: 'X402_AMOUNT_EXCEEDS_CAP', message: expect.stringMatching(/facilitator fee 10000/) });
    // Exactly amount + fee is allowed.
    expect(await codeOf(signX402SvmPayment({
      privateKeyHex: AGENT_KEY, requirement: feeRequirement(goodFee()), maxAmountAtomic: 1_010_000n, recentBlockhash: BLOCKHASH,
    }))).toBe('SIGNED');
  });
});
