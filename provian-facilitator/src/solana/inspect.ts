/**
 * Static inspection of a buyer's x402 `exact` Solana transaction, with Provian's fee leg.
 *
 * Adapted from the open-source x402 `ExactSvmScheme` static verification path (@x402/svm 2.28.0,
 * Apache-2.0, Coinbase): same signature, fee-payer, compute-budget, transfer, recipient-ATA, amount
 * and optional-instruction rules — with ONE addition the standard verifier cannot express (it refuses
 * any 4th instruction that is not Memo/Lighthouse): exactly one extra SPL `transferChecked` of the
 * Provian fee, in USDC, from the buyer to the Provian Solana fee wallet's USDC account. Missing,
 * duplicated, mis-sized or mis-addressed fee → invalid → never submitted.
 *
 * Layout accepted:
 *   [0] ComputeBudget SetComputeUnitLimit (≤ SOLANA_MAX_COMPUTE_UNITS)
 *   [1] ComputeBudget SetComputeUnitPrice (≤ SOLANA_MAX_PRIORITY_MICROLAMPORTS)
 *   [2] Token transferChecked — the payment, buyer → seller's USDC ATA, exactly the required amount
 *   [3..] exactly one Token transferChecked — the fee, buyer → fee wallet's USDC ATA — plus only Memo/Lighthouse
 * No address lookup tables. The fee payer (the facilitator) is account 0, signs nothing at verify,
 * and appears in NO instruction (stricter than the standard static path: full fee-payer isolation).
 */
import { createHash } from 'node:crypto';
import {
  address as toAddress,
  decompileTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  verifySignature,
  type Transaction,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  parseTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  parseSetComputeUnitLimitInstruction,
  parseSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { LIGHTHOUSE_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS } from '@x402/svm';
import {
  SOLANA_LAMPORTS_PER_SIGNATURE,
  SOLANA_MAX_COMPUTE_UNITS,
  SOLANA_MAX_PRIORITY_MICROLAMPORTS,
  SOLANA_MAX_REQUIRED_SIGNATURES,
  SOLANA_USDC_DECIMALS,
  SOLANA_USDC_MINT,
} from '../constants.js';
import { ceilDiv } from '../fee-math.js';
import type { Refusal } from '../x402-types.js';

export interface InspectedPayment {
  readonly ok: true;
  readonly payer: string;
  readonly amount: bigint;
  readonly fee: bigint;
  /** Exactly what this transaction costs its fee payer: 5,000 × signatures + ceil(CU limit × CU price / 1e6). */
  readonly lamports: bigint;
  readonly messageHashHex: string;
  readonly memo: string | null;
}

const TRANSFER_CHECKED = 12;

function refuse(reason: string, payer?: string): Refusal {
  return { ok: false, reason, ...(payer ? { payer } : {}) };
}

export function decodeWireTransaction(base64: string): Transaction | null {
  try {
    return getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  } catch {
    return null;
  }
}

export async function inspectSvmPayment(args: {
  transactionBase64: string;
  feePayer: string;
  payTo: string;
  amount: bigint;
  feeWallet: string;
  feeAmount: bigint;
  expectedMemo: string | null;
}): Promise<InspectedPayment | Refusal> {
  const tx = decodeWireTransaction(args.transactionBase64);
  if (!tx) return refuse('invalid_transaction');
  let compiled;
  try {
    compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch {
    return refuse('invalid_transaction');
  }
  if ('addressTableLookups' in compiled && Array.isArray(compiled.addressTableLookups) && compiled.addressTableLookups.length > 0) {
    return refuse('address_lookup_tables_refused');
  }
  const numSigners = compiled.header.numSignerAccounts;
  if (numSigners < 2 || numSigners > SOLANA_MAX_REQUIRED_SIGNATURES) return refuse('invalid_signer_count');
  const statics = compiled.staticAccounts.map((a) => a.toString());
  if (statics[0] !== args.feePayer) return refuse('fee_payer_mismatch');
  // Every signer except the fee payer must already have signed, validly.
  for (let i = 1; i < numSigners; i++) {
    const signer = statics[i];
    if (!signer) return refuse('invalid_signature');
    const sig = tx.signatures[toAddress(signer)];
    if (!sig || sig.length !== 64) return refuse('invalid_signature');
    let valid = false;
    try {
      const key = await getPublicKeyFromAddress(toAddress(signer));
      valid = await verifySignature(key, sig, tx.messageBytes);
    } catch {
      valid = false;
    }
    if (!valid) return refuse('invalid_signature');
  }

  let message;
  try {
    message = decompileTransactionMessage(compiled);
  } catch {
    return refuse('invalid_transaction');
  }
  const ixs = message.instructions;
  if (ixs.length < 4 || ixs.length > 8) return refuse('invalid_instruction_layout');

  // Full fee-payer isolation: the facilitator's key is never a program or an account in any instruction.
  for (const ix of ixs) {
    if (ix.programAddress.toString() === args.feePayer) return refuse('fee_payer_not_isolated');
    for (const acc of ix.accounts ?? []) {
      if (acc.address.toString() === args.feePayer) return refuse('fee_payer_not_isolated');
    }
  }

  const [limitIx, priceIx, payIx] = [ixs[0]!, ixs[1]!, ixs[2]!];
  let cuLimit: bigint;
  let cuPrice: bigint;
  try {
    if (limitIx.programAddress.toString() !== COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() || limitIx.data?.[0] !== 2) {
      return refuse('invalid_compute_limit_instruction');
    }
    cuLimit = BigInt(parseSetComputeUnitLimitInstruction(limitIx as Parameters<typeof parseSetComputeUnitLimitInstruction>[0]).data.units);
    if (priceIx.programAddress.toString() !== COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() || priceIx.data?.[0] !== 3) {
      return refuse('invalid_compute_price_instruction');
    }
    cuPrice = BigInt(parseSetComputeUnitPriceInstruction(priceIx as Parameters<typeof parseSetComputeUnitPriceInstruction>[0]).data.microLamports);
  } catch {
    return refuse('invalid_compute_budget');
  }
  if (cuLimit <= 0n || cuLimit > SOLANA_MAX_COMPUTE_UNITS) return refuse('compute_limit_too_high');
  if (cuPrice > SOLANA_MAX_PRIORITY_MICROLAMPORTS) return refuse('compute_price_too_high');

  const parseTransfer = (ix: (typeof ixs)[number]) => {
    if (ix.programAddress.toString() !== TOKEN_PROGRAM_ADDRESS.toString()) return null;
    if (!ix.data || ix.data.length < 10 || ix.data[0] !== TRANSFER_CHECKED) return null;
    try {
      return parseTransferCheckedInstruction(ix as Parameters<typeof parseTransferCheckedInstruction>[0]);
    } catch {
      return null;
    }
  };

  // [2] the payment.
  const pay = parseTransfer(payIx);
  if (!pay) return refuse('no_transfer_instruction');
  const payer = pay.accounts.authority.address.toString();
  if (payer === args.feePayer) return refuse('fee_payer_transferring_funds', payer);
  if (pay.accounts.mint.address.toString() !== SOLANA_USDC_MINT) return refuse('mint_mismatch', payer);
  if (pay.data.decimals !== SOLANA_USDC_DECIMALS) return refuse('decimals_mismatch', payer);
  const [sellerAta] = await findAssociatedTokenPda({ mint: toAddress(SOLANA_USDC_MINT), owner: toAddress(args.payTo), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  if (pay.accounts.destination.address.toString() !== sellerAta.toString()) return refuse('recipient_mismatch', payer);
  if (BigInt(pay.data.amount) !== args.amount) return refuse('amount_mismatch', payer);

  // [3..] exactly one fee transfer; everything else Memo/Lighthouse.
  const [feeAta] = await findAssociatedTokenPda({ mint: toAddress(SOLANA_USDC_MINT), owner: toAddress(args.feeWallet), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  let feeSeen = 0;
  const memos: string[] = [];
  for (const ix of ixs.slice(3)) {
    const program = ix.programAddress.toString();
    if (program === MEMO_PROGRAM_ADDRESS) {
      memos.push(ix.data ? new TextDecoder().decode(new Uint8Array(ix.data)) : '');
      continue;
    }
    if (program === LIGHTHOUSE_PROGRAM_ADDRESS) continue;
    const t = parseTransfer(ix);
    if (!t) return refuse('unknown_instruction', payer);
    feeSeen += 1;
    if (t.accounts.destination.address.toString() !== feeAta.toString()) return refuse('provian_fee_recipient_mismatch', payer);
    if (t.accounts.mint.address.toString() !== SOLANA_USDC_MINT || t.data.decimals !== SOLANA_USDC_DECIMALS) {
      return refuse('provian_fee_asset_mismatch', payer);
    }
    if (t.accounts.authority.address.toString() !== payer) return refuse('provian_fee_payer_mismatch', payer);
    if (BigInt(t.data.amount) !== args.feeAmount) return refuse('provian_fee_amount_mismatch', payer);
  }
  if (feeSeen === 0) return refuse('provian_fee_missing', payer);
  if (feeSeen > 1) return refuse('provian_fee_duplicated', payer);
  if (args.expectedMemo !== null) {
    if (memos.length !== 1) return refuse('memo_count', payer);
    if (memos[0] !== args.expectedMemo) return refuse('memo_mismatch', payer);
  }

  const lamports = SOLANA_LAMPORTS_PER_SIGNATURE * BigInt(numSigners) + ceilDiv(cuLimit * cuPrice, 1_000_000n);
  return {
    ok: true,
    payer,
    amount: args.amount,
    fee: args.feeAmount,
    lamports,
    messageHashHex: createHash('sha256').update(Uint8Array.from(tx.messageBytes)).digest('hex'),
    memo: memos[0] ?? null,
  };
}
