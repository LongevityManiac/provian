/** Builds real, buyer-signed x402 `exact` Solana transactions (fee payer slot unsigned) for tests. */
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { MEMO_PROGRAM_ADDRESS } from '@x402/svm';
import { SOLANA_USDC_MINT } from '../constants.js';

export interface SvmTxOptions {
  buyer: KeyPairSigner;
  feePayer: Address;
  payTo: Address;
  amount: bigint;
  feeWallet: Address;
  fee: bigint | null;
  /** Add the fee instruction twice. */
  duplicateFee?: boolean;
  feeAuthority?: KeyPairSigner;
  feeDestinationOwner?: Address;
  feeMint?: Address;
  cuLimit?: number;
  cuPrice?: bigint;
  memo?: string;
  /** Put an extra instruction after the fee. */
  extra?: Instruction;
  /** Reference the fee payer inside the payment instruction (as the source account). */
  feePayerAsSource?: boolean;
  paymentMint?: Address;
}

export async function usdcAta(owner: Address, mint: Address = address(SOLANA_USDC_MINT)): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return ata;
}

export async function buildSvmPayment(o: SvmTxOptions): Promise<string> {
  const mint = o.paymentMint ?? address(SOLANA_USDC_MINT);
  const buyerAta = await usdcAta(o.buyer.address, mint);
  const sellerAta = await usdcAta(o.payTo, mint);
  const ixs: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: o.cuLimit ?? 200_000 }),
    getSetComputeUnitPriceInstruction({ microLamports: o.cuPrice ?? 1n }),
    getTransferCheckedInstruction({
      source: o.feePayerAsSource ? o.feePayer : buyerAta,
      mint,
      destination: sellerAta,
      authority: o.buyer,
      amount: o.amount,
      decimals: 6,
    }),
  ];
  if (o.fee !== null) {
    const feeMint = o.feeMint ?? address(SOLANA_USDC_MINT);
    const feeIx = getTransferCheckedInstruction({
      source: await usdcAta((o.feeAuthority ?? o.buyer).address, feeMint),
      mint: feeMint,
      destination: await usdcAta(o.feeDestinationOwner ?? o.feeWallet, feeMint),
      authority: o.feeAuthority ?? o.buyer,
      amount: o.fee,
      decimals: 6,
    });
    ixs.push(feeIx);
    if (o.duplicateFee) ixs.push(feeIx);
  }
  if (o.memo !== undefined) {
    ixs.push({ programAddress: address(MEMO_PROGRAM_ADDRESS), data: new TextEncoder().encode(o.memo), accounts: [] });
  }
  if (o.extra) ixs.push(o.extra);
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(o.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 1n }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await partiallySignTransactionMessageWithSigners(msg);
  return getBase64EncodedWireTransaction(signed);
}

export async function keypairs(n: number): Promise<KeyPairSigner[]> {
  return Promise.all(Array.from({ length: n }, () => generateKeyPairSigner()));
}
