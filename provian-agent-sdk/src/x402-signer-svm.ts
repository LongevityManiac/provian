import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * x402 "exact" scheme on Solana (SVM).
 *
 * The EVM path (x402-signer.ts) signs an off-chain EIP-3009 authorization. The
 * Solana exact scheme is different: the client builds and PARTIALLY signs a
 * versioned transaction (ComputeBudget + SPL TransferChecked to the payTo's
 * associated token account), leaving the facilitator's fee-payer signature
 * missing; the facilitator co-signs and submits it. See Coinbase x402
 * specs/schemes/exact/scheme_exact_svm.md.
 *
 * Provian facilitator fee: when the requirement carries `extra.provianFee`, the
 * buyer's transaction also carries ONE extra SPL TransferChecked of exactly that
 * USDC amount to the PINNED Provian Solana fee wallet's ATA, immediately after
 * the payment transfer (layout: CU limit, CU price, payment, fee, memo). Any
 * provianFee whose payTo/asset/amount is not the pinned wallet, the pinned USDC
 * mint, and a positive integer within {@link PROVIAN_SOLANA_FACILITATOR_FEE_MAX_ATOMIC}
 * is refused (X402_PROVIAN_FEE_REFUSED) — never signed, never silently dropped.
 * The fee counts toward the per-payment ceiling.
 *
 * Governance-free, agent's-own-money — same posture as the EVM x402 path.
 *
 * SECURITY: the USDC mint and cluster are PINNED here per network id and are
 * NEVER taken from the untrusted 402 response; a requirement whose `asset` does
 * not equal the pinned mint is rejected (fail closed). The agent's Solana
 * keypair is derived deterministically from its existing secp256k1 secret via a
 * domain-separated SHA-512 KDF (no new key to back up).
 */

import { randomBytes } from 'crypto';
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { deriveSolanaEd25519Seed, deriveSolanaAddress } from './chains';
import type { PaymentRequirement, PaymentRequired } from './x402-signer';
import { ProvianError } from './errors';

// SPL program ids. @solana/spl-token 0.4 is ESM-only and cannot be required
// from the SDK's CommonJS build, so the two helpers we need (ATA derivation +
// TransferChecked) are hand-rolled below on @solana/web3.js primitives — the
// SDK stays dep-minimal (only @solana/web3.js, which is CJS-friendly).
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/** SPL Memo program. */
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** USDC on Solana uses 6 decimals (same as EVM USDC). */
export const SVM_USDC_DECIMALS = 6;

/**
 * Provian's x402 facilitator fee wallet on Solana (base58 owner; the fee lands in
 * its USDC associated token account). PINNED: an `extra.provianFee.payTo` that is
 * not exactly this address is refused, so a hostile 402 cannot redirect funds
 * through the fee instruction.
 */
export const PROVIAN_SOLANA_FACILITATOR_FEE_WALLET = 'DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2';

/**
 * Upper bound on a single Provian facilitator fee, in USDC atomic units
 * (6 decimals): 50_000 = $0.05. A provianFee above this is refused before signing.
 */
export const PROVIAN_SOLANA_FACILITATOR_FEE_MAX_ATOMIC = 50_000n;

/**
 * Associated Token Account PDA for (owner, mint) under the mint's token program
 * (classic SPL Token by default — USDC is a classic-Token mint).
 */
export function associatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/**
 * SPL Token `TransferChecked` (instruction 12): data = [12, amount(u64 LE),
 * decimals(u8)]. Accounts: source, mint, destination, owner(signer).
 */
export function transferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: tokenProgramId,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export interface SvmNetworkParams {
  /** Canonical Circle USDC SPL mint on this cluster (base58, case-sensitive). */
  usdcMint: string;
  /** Default RPC used to fetch a recent blockhash if none is supplied. */
  rpcUrl: string;
  /** Token program that owns `usdcMint` (USDC is a classic SPL Token mint). */
  usdcTokenProgramId: string;
}

/**
 * Pinned Solana clusters for x402. Keyed by CAIP-2 network id (the genesis-hash
 * form the x402 spec uses). Mainnet-beta and devnet only.
 */
export const X402_SVM_NETWORKS: Readonly<Record<string, SvmNetworkParams>> = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': {
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    usdcTokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
  },
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': {
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    rpcUrl: 'https://api.devnet.solana.com',
    usdcTokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
  },
};

export function isSvmNetwork(caip2: string): boolean {
  return typeof caip2 === 'string' && caip2.startsWith('solana:');
}

export function getX402SvmNetwork(caip2: string): SvmNetworkParams | null {
  return X402_SVM_NETWORKS[caip2] ?? null;
}

/**
 * Pick the first accepted requirement payable on Solana: scheme 'exact', a
 * pinned Solana network, and an asset equal to that cluster's pinned USDC mint
 * (base58, case-sensitive — NOT lowercased). Returns null if none match, so the
 * caller can fall through to the EVM path or fail closed.
 */
export function selectCompatibleSvmRequirement(pr: PaymentRequired): PaymentRequirement | null {
  const source = pr.accepts ?? pr.accepted;
  const accepted = Array.isArray(source) ? source : source ? [source] : [];
  for (const req of accepted) {
    if (!req || typeof req.network !== 'string' || typeof req.asset !== 'string') continue;
    if (req.scheme !== 'exact') continue;
    const net = getX402SvmNetwork(req.network);
    if (!net) continue;
    if (req.asset !== net.usdcMint) continue;
    return req;
  }
  return null;
}

/** A validated Provian facilitator fee (see {@link resolveProvianFee}). */
export interface ProvianSvmFee {
  /** Fee in USDC atomic units (6 decimals); > 0 and ≤ the pinned bound. */
  amountAtomic: bigint;
  /** The pinned fee wallet (owner), never the 402's choice. */
  payTo: string;
  /** The pinned USDC mint of the requirement's network. */
  asset: string;
  /** Opaque facilitator quote token, if any (rides back under `accepted.extra`). */
  quote?: string;
}

function refuseFee(reason: string): never {
  throw new ProvianError(`x402 Solana signer: refusing extra.provianFee — ${reason}`, 'X402_PROVIAN_FEE_REFUSED');
}

/**
 * Validate a requirement's `extra.provianFee` against the PINNED Provian fee
 * wallet, the network's pinned USDC mint, and the fee bound. Returns null when
 * the requirement carries no provianFee (the payment is built exactly as
 * before). Any present-but-invalid provianFee THROWS (X402_PROVIAN_FEE_REFUSED):
 * a hostile 402 must not redirect funds through it, and silently dropping it
 * would only get the payment refused by the facilitator.
 */
export function resolveProvianFee(requirement: PaymentRequirement): ProvianSvmFee | null {
  const extra = requirement.extra;
  if (!extra || !Object.prototype.hasOwnProperty.call(extra, 'provianFee')) return null;
  const raw = extra.provianFee;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    refuseFee('it is not an object');
  }
  const fee = raw as Record<string, unknown>;
  const net = getX402SvmNetwork(requirement.network);
  if (!net) refuseFee(`unsupported network ${String(requirement.network)}`);
  if (fee.payTo !== PROVIAN_SOLANA_FACILITATOR_FEE_WALLET) {
    refuseFee('payTo is not the pinned Provian Solana fee wallet');
  }
  if (fee.asset !== net.usdcMint) {
    refuseFee('asset is not the pinned USDC mint');
  }
  // Canonical positive decimal integer only: no sign, no fraction, no hex
  // (BigInt('0x…') would otherwise parse), no whitespace, no leading zeros.
  if (typeof fee.amount !== 'string' || !/^[1-9][0-9]*$/.test(fee.amount)) {
    refuseFee('amount is not a positive integer string');
  }
  const amountAtomic = BigInt(fee.amount);
  if (amountAtomic > PROVIAN_SOLANA_FACILITATOR_FEE_MAX_ATOMIC) {
    refuseFee(`amount ${amountAtomic} exceeds the bound ${PROVIAN_SOLANA_FACILITATOR_FEE_MAX_ATOMIC} (USDC atomic units)`);
  }
  if (fee.quote !== undefined && typeof fee.quote !== 'string') {
    refuseFee('quote is not a string');
  }
  return {
    amountAtomic,
    payTo: PROVIAN_SOLANA_FACILITATOR_FEE_WALLET,
    asset: net.usdcMint,
    ...(typeof fee.quote === 'string' ? { quote: fee.quote } : {}),
  };
}

/**
 * Derive the agent's ed25519 Solana keypair from its secp256k1 private key,
 * using the single KDF in chains.ts (deriveSolanaEd25519Seed). Deterministic +
 * domain-separated, so the same keystore always yields the same Solana address.
 */
export function deriveSolanaKeypair(privateKeyHex: string): Keypair {
  return Keypair.fromSeed(deriveSolanaEd25519Seed(privateKeyHex));
}

/** The agent's Solana address (base58) for funding, from its secp256k1 key. */
export function deriveSolanaAddressFromEvmKey(privateKeyHex: string): string {
  return deriveSolanaAddress(privateKeyHex);
}

export interface SvmSignedPayment {
  /** Base64-encoded, partially-signed versioned transaction. */
  transaction: string;
  /** The paying agent's Solana address (base58). */
  payer: string;
}

export interface SignX402SvmArgs {
  privateKeyHex: string;
  requirement: PaymentRequirement;
  /**
   * Hard per-payment ceiling in USDC atomic units (6 decimals). REQUIRED — same
   * SDK-local safety boundary as the EVM path ({@link SignX402PaymentArgs}); the
   * agent's Solana x402 spend is ungoverned, so a hostile 402 must not be able to
   * drain the wallet. No unlimited default: a missing ceiling is refused before
   * signing. It bounds EVERYTHING this transaction moves out of the agent's
   * wallet: the payment amount PLUS any Provian facilitator fee
   * (`extra.provianFee`). Both legs are USDC (the payment asset is pinned to the
   * network's USDC mint, as is the fee asset), so the sum is compared directly.
   */
  maxAmountAtomic: bigint;
  /** Optional RPC override (else the pinned cluster default). */
  rpcUrl?: string;
  /** Optional blockhash override (else fetched from RPC) — used by tests. */
  recentBlockhash?: string;
}

async function fetchRecentBlockhash(rpcUrl: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'confirmed' }],
    }),
  });
  if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: { value?: { blockhash?: string } }; error?: unknown };
  const blockhash = json?.result?.value?.blockhash;
  if (!blockhash) throw new Error('Solana RPC returned no blockhash');
  return blockhash;
}

/**
 * Build and partially sign the x402 SVM payment transaction.
 * Instruction order per spec: ComputeUnitLimit, ComputeUnitPrice,
 * TransferChecked (to payTo's ATA), [Provian fee TransferChecked to the pinned
 * fee wallet's ATA — only when `extra.provianFee` is present and valid], then a
 * Memo.
 */
export async function signX402SvmPayment(args: SignX402SvmArgs): Promise<SvmSignedPayment> {
  const { requirement } = args;

  if (requirement.scheme !== 'exact') {
    throw new Error(`Unsupported x402 scheme for Solana: ${requirement.scheme}`);
  }
  const net = getX402SvmNetwork(requirement.network);
  if (!net) {
    throw new Error(`Unsupported x402 Solana network: ${requirement.network}`);
  }
  // Pinned mint; never trust the 402's asset to set it.
  if (requirement.asset !== net.usdcMint) {
    throw new Error('x402 Solana asset is not the pinned USDC mint');
  }

  const amount = BigInt(requirement.amount);
  if (!(amount > 0n)) {
    throw new Error('x402 Solana amount must be positive');
  }

  // Provian facilitator fee (optional). Validated against the PINNED wallet,
  // mint and bound BEFORE the ceiling check, so the ceiling sees the full spend.
  const provianFee = resolveProvianFee(requirement);
  const feeAtomic = provianFee ? provianFee.amountAtomic : 0n;

  // Per-payment ceiling — enforced BEFORE signing, required (no unlimited
  // default), mirroring the EVM signer. The ungoverned key must never sign an
  // uncapped or over-ceiling amount.
  if (args.maxAmountAtomic === undefined || args.maxAmountAtomic === null) {
    throw new ProvianError(
      'x402 Solana signer: a per-payment ceiling (maxAmountAtomic) is required — the ungoverned x402 key must never sign an uncapped amount',
      'X402_CEILING_REQUIRED',
    );
  }
  if (args.maxAmountAtomic <= 0n) {
    throw new ProvianError('x402 Solana signer: maxAmountAtomic must be a positive integer', 'X402_CEILING_REQUIRED');
  }
  if (amount > args.maxAmountAtomic) {
    throw new ProvianError(
      `x402 Solana signer: payment amount ${amount} exceeds the per-payment ceiling ${args.maxAmountAtomic} (USDC atomic units)`,
      'X402_AMOUNT_EXCEEDS_CAP',
    );
  }
  if (amount + feeAtomic > args.maxAmountAtomic) {
    throw new ProvianError(
      `x402 Solana signer: payment amount ${amount} plus Provian facilitator fee ${feeAtomic} exceeds the per-payment ceiling ${args.maxAmountAtomic} (USDC atomic units)`,
      'X402_AMOUNT_EXCEEDS_CAP',
    );
  }

  const feePayerRaw = (requirement.extra?.feePayer ?? '') as string;
  let feePayer: PublicKey;
  let payTo: PublicKey;
  const mint = new PublicKey(net.usdcMint);
  const tokenProgram = new PublicKey(net.usdcTokenProgramId);
  try {
    feePayer = new PublicKey(feePayerRaw);
  } catch {
    throw new Error('x402 Solana requirement missing a valid feePayer');
  }
  try {
    payTo = new PublicKey(requirement.payTo);
  } catch {
    throw new Error('x402 Solana requirement has an invalid payTo');
  }

  const keypair = deriveSolanaKeypair(args.privateKeyHex);
  const sourceAta = associatedTokenAddress(mint, keypair.publicKey, tokenProgram);
  const destAta = associatedTokenAddress(mint, payTo, tokenProgram);

  const memoValue = (requirement.extra?.memo as string | undefined) ?? randomBytes(16).toString('hex');

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    transferCheckedInstruction(sourceAta, mint, destAta, keypair.publicKey, amount, SVM_USDC_DECIMALS, tokenProgram),
  ];
  if (provianFee) {
    // Index 3, immediately after the payment: buyer's USDC ATA -> the pinned
    // Provian fee wallet's USDC ATA (derived under the mint's token program),
    // authority = buyer. Both the owner and the mint are the PINNED constants,
    // never the 402's strings.
    const feeOwner = new PublicKey(PROVIAN_SOLANA_FACILITATOR_FEE_WALLET);
    const feeAta = associatedTokenAddress(mint, feeOwner, tokenProgram);
    instructions.push(
      transferCheckedInstruction(sourceAta, mint, feeAta, keypair.publicKey, provianFee.amountAtomic, SVM_USDC_DECIMALS, tokenProgram),
    );
  }
  instructions.push(
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoValue, 'utf8'),
    }),
  );

  const recentBlockhash = args.recentBlockhash ?? (await fetchRecentBlockhash(args.rpcUrl ?? net.rpcUrl));

  const message = new TransactionMessage({
    payerKey: feePayer, // facilitator pays the fee; not the agent
    recentBlockhash,
    instructions,
  }).compileToV0Message();

  const vtx = new VersionedTransaction(message);
  // Sign ONLY the agent's (transfer authority) slot; the facilitator co-signs
  // the fee-payer slot before submission. Partial signature by design.
  vtx.sign([keypair]);

  const transaction = Buffer.from(vtx.serialize()).toString('base64');
  return { transaction, payer: keypair.publicKey.toBase58() };
}

/** v2 wire shape for the paid retry: chosen requirement under `accepted`. */
export interface SvmPaymentPayload {
  x402Version: 2;
  accepted: PaymentRequirement;
  payload: { transaction: string };
}

/** Base64-encode the SVM PaymentPayload for the PAYMENT-SIGNATURE header. */
export function buildSvmPaymentHeader(signed: SvmSignedPayment, requirement: PaymentRequirement): string {
  const payload: SvmPaymentPayload = {
    x402Version: 2,
    accepted: requirement,
    payload: { transaction: signed.transaction },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
