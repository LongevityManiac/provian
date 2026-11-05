/**
 * — Provian's x402 facilitator: the PURE half of the relay's facilitator lane.
 *
 * the operator’s spec: "Every settlement is a relay-witnessed PE for buyer and seller under the existing
 * pricing and mint-once rules; add the facilitator lane to A2's witness table."
 *
 * The facilitator (`provian-x402-facilitator`, its own Cloud Run service) settles a buyer's x402
 * payment and then POSTs the relay a POINTER — `{ chain, tx_hash, buyer, seller, asset, amount,
 * fee, scheme }`. The pointer is never evidence. This module holds the one set of rules the relay
 * reads the chain against:
 *
 * - BASE. The transaction must be final (two operator legs, 12 confirmations, the agreed safe
 * head — `verifyBaseTransactionEvidence`), sent TO the configured `ProvianX402FeeSettler`, and
 * its receipt must carry, from the asset contract, `Transfer(buyer → seller, amount)`; from
 * USDC, `Transfer(seller → feeRecipient, fee)`; and, from the settler, `FeeSettled(buyer,
 * seller, token, value, fee)` naming exactly those values. The asset is Base USDC or the live
 * PVT9 token; nothing else.
 * - SOLANA. The transaction must be FINALIZED with `meta.err === null`, paid for by the
 * facilitator's fee wallet, and its token-balance deltas (by owner + mint) must show the
 * seller +amount of the asset (Solana USDC), the fee wallet +fee USDC, and the buyer debited
 * at least amount + fee.
 *
 * The same `FeeSettled` reading is what the outbound USDC watcher uses to label a settler-routed
 * payment leg `x402_payment` (`facilitatorSettlementNamesLeg`), so the watcher and this lane seal
 * the buyer's act under ONE mint-once anchor — the x402 claim keyed (payer, settlement tx).
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import {
  BASE_USDC_ADDRESS,
  ERC20_TRANSFER_TOPIC,
  type BaseTransactionEvidence,
  type CanonicalEconomicLog,
} from '../onchain/economic-discovery';
import { LIVE_PVT9_TOKEN, addressTopic } from './wallet-exchange';

// =============================================================================
// CONSTANTS + CONFIG
// =============================================================================

export const FACILITATOR_BASE_CHAIN_ID = 8453;
export const FACILITATOR_BASE_NETWORK = 'eip155:8453';
export const FACILITATOR_SOLANA_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** keccak256("FeeSettled(address,address,address,uint256,uint256)") — `ProvianX402FeeSettler`. */
export const FEE_SETTLED_TOPIC = ethers.id('FeeSettled(address,address,address,uint256,uint256)').toLowerCase();

/** Solana USDC (SPL) mint. */
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * The facilitator's gas wallets, as published in the run record. The relay never holds either key;
 * it only ever names the ADDRESS (fee recipient / fee payer / gas-runway leg). An env value
 * overrides the pinned default.
 */
export const FACILITATOR_BASE_GAS_ADDRESS_DEFAULT = '0xa37fc594e98e951571c771c9e77cdc73f67d3efb';
export const FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT = 'DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
/** base58 (no 0 O I l). A Solana pubkey is 32 bytes (32–44 chars); a signature 64 bytes (64–88). */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
/** A positive atomic integer, no leading zeros, at most 78 digits (uint256). */
const POSITIVE_ATOMIC = /^[1-9][0-9]{0,77}$/;

type Env = NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;

/** The settler contract the relay accepts a Base settlement from; null when unset (refuse, 503). */
export function facilitatorSettlerAddress(env: Env = process.env): string | null {
  const raw = env.FACILITATOR_SETTLER_ADDRESS?.trim();
  return raw && EVM_ADDRESS.test(raw) ? raw.toLowerCase() : null;
}

/** Where the Base fee lands (the facilitator's Base gas EOA, address only). */
export function facilitatorBaseGasAddress(env: Env = process.env): string | null {
  const raw = env.FACILITATOR_BASE_GAS_ADDRESS?.trim();
  if (raw === undefined || raw === '') return FACILITATOR_BASE_GAS_ADDRESS_DEFAULT;
  return EVM_ADDRESS.test(raw) ? raw.toLowerCase() : null;
}

/** The Solana wallet that receives the fee and pays the network fee (address only). */
export function facilitatorSolanaFeeWallet(env: Env = process.env): string | null {
  const raw = env.FACILITATOR_SOLANA_FEE_WALLET?.trim();
  if (raw === undefined || raw === '') return FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT;
  return SOLANA_ADDRESS.test(raw) ? raw : null;
}

/** The Solana gas wallet the runway dashboard reads (address only). */
export function facilitatorSolanaGasAddress(env: Env = process.env): string | null {
  const raw = env.FACILITATOR_SOLANA_GAS_ADDRESS?.trim();
  if (raw === undefined || raw === '') return FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT;
  return SOLANA_ADDRESS.test(raw) ? raw : null;
}

/** The relay's Solana JSON-RPC: an explicit URL, else Alchemy (keyed, as the swap proxy reads
 * Solana), else the public endpoint. */
export function facilitatorSolanaRpcUrl(env: Env = process.env): string {
  const explicit = env.FACILITATOR_SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  return env.ALCHEMY_API_KEY
    ? `https://solana-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`
    : 'https://api.mainnet-beta.solana.com';
}

/** The Base assets a facilitator settlement may move: USDC and the live PVT9 token. Nothing else. */
export function facilitatorBaseAssets(): Readonly<Record<string, 'USDC' | 'PVT'>> {
  return Object.freeze({
    [BASE_USDC_ADDRESS]: 'USDC',
    ...(LIVE_PVT9_TOKEN ? { [LIVE_PVT9_TOKEN]: 'PVT' as const } : {}),
  });
}

// =============================================================================
// THE POINTER (request body)
// =============================================================================

export type FacilitatorChain = 'base' | 'solana';
export type FacilitatorScheme = 'eip3009' | 'permit2' | 'svm_exact';

export interface FacilitatorSettlementClaim {
  readonly chain: FacilitatorChain;
  /** Base: lowercased 0x tx hash. Solana: the base58 signature, as sent. */
  readonly txHash: string;
  /** Base: lowercased. Solana: base58 as sent. */
  readonly buyer: string;
  readonly seller: string;
  readonly asset: string;
  readonly amount: string;
  readonly fee: string;
  readonly scheme: FacilitatorScheme;
}

export type ParsedClaim =
  | { readonly ok: true; readonly claim: FacilitatorSettlementClaim }
  | { readonly ok: false; readonly reason: string };

const BODY_KEYS = ['amount', 'asset', 'buyer', 'chain', 'fee', 'scheme', 'seller', 'tx_hash'] as const;

/**
 * Parse the facilitator's pointer strictly (Unknown = Block): the exact key set, the chain/scheme
 * pairing, well-formed addresses and hashes, an allowed asset, and positive atomic amounts.
 */
export function parseFacilitatorSettlementBody(body: unknown): ParsedClaim {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'body_not_object' };
  const raw = body as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  if (keys.length !== BODY_KEYS.length || keys.some((k, i) => k !== BODY_KEYS[i])) {
    return { ok: false, reason: 'body_keys_invalid' };
  }
  for (const k of BODY_KEYS) {
    if (typeof raw[k] !== 'string') return { ok: false, reason: `${k}_not_string` };
  }
  const s = raw as Record<(typeof BODY_KEYS)[number], string>;
  if (!POSITIVE_ATOMIC.test(s.amount)) return { ok: false, reason: 'amount_invalid' };
  // "No free tier": every settlement carries a fee, and the settler refuses fee == 0 on chain.
  if (!POSITIVE_ATOMIC.test(s.fee)) return { ok: false, reason: 'fee_invalid' };

  if (s.chain === 'base') {
    if (s.scheme !== 'eip3009' && s.scheme !== 'permit2') return { ok: false, reason: 'scheme_not_base' };
    if (!EVM_TX.test(s.tx_hash)) return { ok: false, reason: 'tx_hash_invalid' };
    if (!EVM_ADDRESS.test(s.buyer)) return { ok: false, reason: 'buyer_invalid' };
    if (!EVM_ADDRESS.test(s.seller)) return { ok: false, reason: 'seller_invalid' };
    if (!EVM_ADDRESS.test(s.asset)) return { ok: false, reason: 'asset_invalid' };
    const asset = s.asset.toLowerCase();
    const assets = facilitatorBaseAssets();
    if (!(asset in assets)) return { ok: false, reason: 'asset_not_allowed' };
    // EIP-3009 is USDC's own authorization; the Permit2 path may move either allowed asset.
    if (s.scheme === 'eip3009' && asset !== BASE_USDC_ADDRESS) return { ok: false, reason: 'scheme_asset_mismatch' };
    if (s.buyer.toLowerCase() === s.seller.toLowerCase()) return { ok: false, reason: 'buyer_is_seller' };
    return {
      ok: true,
      claim: {
        chain: 'base',
        txHash: s.tx_hash.toLowerCase(),
        buyer: s.buyer.toLowerCase(),
        seller: s.seller.toLowerCase(),
        asset,
        amount: s.amount,
        fee: s.fee,
        scheme: s.scheme,
      },
    };
  }
  if (s.chain === 'solana') {
    if (s.scheme !== 'svm_exact') return { ok: false, reason: 'scheme_not_solana' };
    if (!SOLANA_SIGNATURE.test(s.tx_hash)) return { ok: false, reason: 'tx_hash_invalid' };
    if (!SOLANA_ADDRESS.test(s.buyer)) return { ok: false, reason: 'buyer_invalid' };
    if (!SOLANA_ADDRESS.test(s.seller)) return { ok: false, reason: 'seller_invalid' };
    if (s.asset !== SOLANA_USDC_MINT) return { ok: false, reason: 'asset_not_allowed' };
    if (s.buyer === s.seller) return { ok: false, reason: 'buyer_is_seller' };
    return {
      ok: true,
      claim: {
        chain: 'solana',
        txHash: s.tx_hash,
        buyer: s.buyer,
        seller: s.seller,
        asset: s.asset,
        amount: s.amount,
        fee: s.fee,
        scheme: 'svm_exact',
      },
    };
  }
  return { ok: false, reason: 'chain_not_supported' };
}

/** The pointer's identity: one document per settlement transaction. */
export function facilitatorSettlementId(claim: Pick<FacilitatorSettlementClaim, 'chain' | 'txHash'>): string {
  return `${claim.chain}:${claim.txHash}`;
}

/** A digest of the whole claim, so a second report naming different terms is a conflict. */
export function facilitatorClaimDigest(claim: FacilitatorSettlementClaim): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    claim.chain, claim.txHash, claim.buyer, claim.seller, claim.asset, claim.amount, claim.fee, claim.scheme,
  ])).digest('hex');
}

/** The deterministic PE id this lane seals for one party of one settlement (a replay returns it). */
export function facilitatorActPeId(chain: FacilitatorChain, txHash: string, role: 'buyer' | 'seller'): string {
  return `pe_x402fac_${crypto.createHash('sha256').update(`${chain}:${txHash.toLowerCase()}:${role}`).digest('hex')}`;
}

// =============================================================================
// BASE — read the final receipt
// =============================================================================

export type BaseFacilitatorVerdict =
  | {
    readonly ok: true;
    readonly paymentLogIndex: number;
    readonly feeLogIndex: number;
    readonly feeSettledLogIndex: number;
    readonly blockNumber: number;
    readonly blockTimestampMs: number;
  }
  | { readonly ok: false; readonly reason: string };

function wellFormedTransfer(log: CanonicalEconomicLog): boolean {
  return !log.removed
    && log.topics.length === 3
    && log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC
    && /^0x[0-9a-fA-F]{64}$/.test(log.data);
}

function isTransfer(log: CanonicalEconomicLog, token: string, from: string, to: string, amount: string): boolean {
  return wellFormedTransfer(log)
    && log.address.toLowerCase() === token
    && log.topics[1].toLowerCase() === addressTopic(from)
    && log.topics[2].toLowerCase() === addressTopic(to)
    && BigInt(log.data) === BigInt(amount);
}

function wordOf(value: string): string {
  return BigInt(value).toString(16).padStart(64, '0');
}

/** The settler's `FeeSettled(buyer, seller, token, value, fee)`, exactly. */
function isFeeSettled(
  log: CanonicalEconomicLog,
  settler: string,
  fields: { buyer: string; seller: string; token: string; value: string; fee: string | null },
): boolean {
  if (log.removed || log.address.toLowerCase() !== settler || log.topics.length !== 4) return false;
  if (log.topics[0].toLowerCase() !== FEE_SETTLED_TOPIC) return false;
  if (log.topics[1].toLowerCase() !== addressTopic(fields.buyer)
    || log.topics[2].toLowerCase() !== addressTopic(fields.seller)
    || log.topics[3].toLowerCase() !== addressTopic(fields.token)) return false;
  const data = log.data.toLowerCase();
  if (!/^0x[0-9a-f]{128}$/.test(data)) return false;
  if (data.slice(2, 66) !== wordOf(fields.value)) return false;
  return fields.fee === null || data.slice(66) === wordOf(fields.fee);
}

/**
 * Verify a Base facilitator settlement against FINAL transaction evidence. Pure: the evidence is
 * already final (`verifyBaseTransactionEvidence` throws on a pending or reverted transaction).
 */
export function verifyBaseFacilitatorEvidence(
  evidence: BaseTransactionEvidence,
  claim: FacilitatorSettlementClaim,
  config: { readonly settler: string; readonly feeRecipient: string },
): BaseFacilitatorVerdict {
  if (claim.chain !== 'base') return { ok: false, reason: 'chain_mismatch' };
  if (evidence.chainId !== FACILITATOR_BASE_CHAIN_ID) return { ok: false, reason: 'evidence_chain_mismatch' };
  if (evidence.transactionHash.toLowerCase() !== claim.txHash) return { ok: false, reason: 'evidence_transaction_mismatch' };
  if (evidence.toAddress === null || evidence.toAddress.toLowerCase() !== config.settler) {
    return { ok: false, reason: 'settler_target_mismatch' };
  }
  const payment = evidence.logs.find((log) => isTransfer(log, claim.asset, claim.buyer, claim.seller, claim.amount));
  if (!payment) return { ok: false, reason: 'payment_transfer_missing' };
  const fee = evidence.logs.find((log) => log.logIndex !== payment.logIndex
    && isTransfer(log, BASE_USDC_ADDRESS, claim.seller, config.feeRecipient, claim.fee));
  if (!fee) return { ok: false, reason: 'fee_transfer_missing' };
  const settled = evidence.logs.find((log) => isFeeSettled(log, config.settler, {
    buyer: claim.buyer, seller: claim.seller, token: claim.asset, value: claim.amount, fee: claim.fee,
  }));
  if (!settled) return { ok: false, reason: 'fee_settled_event_missing' };
  return {
    ok: true,
    paymentLogIndex: payment.logIndex,
    feeLogIndex: fee.logIndex,
    feeSettledLogIndex: settled.logIndex,
    blockNumber: evidence.blockNumber,
    blockTimestampMs: evidence.blockTimestampMs,
  };
}

/**
 * Is this outbound USDC leg (`from → to`, `amount`) the PAYMENT leg of a facilitator settlement?
 * True only when the transaction was sent to the configured settler and the settler emitted
 * `FeeSettled(from, to, USDC, amount, ·)` — the fee leg (seller → fee recipient) never matches,
 * because the settler names the BUYER, not the seller, as `buyer`. Read by the outbound USDC
 * watcher so its label and this lane's agree on the one x402 claim.
 */
export function facilitatorSettlementNamesLeg(
  evidence: BaseTransactionEvidence,
  settler: string | null,
  leg: { readonly from: string; readonly to: string; readonly amountAtomic: string },
): boolean {
  if (settler === null || evidence.toAddress === null || evidence.toAddress.toLowerCase() !== settler) return false;
  if (!POSITIVE_ATOMIC.test(leg.amountAtomic)) return false;
  return evidence.logs.some((log) => isFeeSettled(log, settler, {
    buyer: leg.from.toLowerCase(), seller: leg.to.toLowerCase(), token: BASE_USDC_ADDRESS, value: leg.amountAtomic, fee: null,
  }));
}

// =============================================================================
// SOLANA — read the finalized transaction (jsonParsed)
// =============================================================================

export interface SolanaTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string };
}

export interface SolanaParsedTransaction {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly meta: {
    readonly err: unknown;
    readonly preTokenBalances?: readonly SolanaTokenBalance[] | null;
    readonly postTokenBalances?: readonly SolanaTokenBalance[] | null;
  } | null;
  readonly transaction: {
    readonly signatures: readonly string[];
    readonly message: {
      readonly accountKeys: ReadonlyArray<{ readonly pubkey: string; readonly signer?: boolean } | string>;
      /** jsonParsed top-level instructions (read to locate the payment `transferChecked`). */
      readonly instructions?: ReadonlyArray<SolanaParsedInstruction> | null;
    };
  };
}

/** One jsonParsed instruction. Only a parsed SPL-token instruction is ever read. */
export interface SolanaParsedInstruction {
  readonly programId?: string;
  readonly program?: string;
  readonly parsed?: { readonly type?: string; readonly info?: Readonly<Record<string, unknown>> } | string | null;
}

/** The SPL Token and Token-2022 programs — the only programs a payment `transferChecked` runs in. */
export const SOLANA_TOKEN_PROGRAM_IDS: ReadonlySet<string> = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

export type SolanaFacilitatorVerdict =
  | { readonly ok: true; readonly slot: number; readonly blockTimeMs: number }
  | { readonly ok: false; readonly reason: string };

/** Net token change per `owner|mint` across the transaction (post − pre, atomic). */
export function solanaTokenDeltas(meta: NonNullable<SolanaParsedTransaction['meta']>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (rows: readonly SolanaTokenBalance[] | null | undefined, sign: 1n | -1n): void => {
    for (const row of rows ?? []) {
      if (typeof row.owner !== 'string' || typeof row.mint !== 'string') continue;
      const amount = row.uiTokenAmount?.amount;
      if (typeof amount !== 'string' || !/^[0-9]{1,40}$/.test(amount)) throw new Error('solana_token_balance_invalid');
      const key = `${row.owner}|${row.mint}`;
      out.set(key, (out.get(key) ?? 0n) + sign * BigInt(amount));
    }
  };
  add(meta.postTokenBalances, 1n);
  add(meta.preTokenBalances, -1n);
  return out;
}

/**
 * Verify a Solana facilitator settlement against a FINALIZED transaction (jsonParsed). Pure.
 */
export function verifySolanaFacilitatorTransaction(
  tx: SolanaParsedTransaction,
  claim: FacilitatorSettlementClaim,
  config: { readonly feeWallet: string },
): SolanaFacilitatorVerdict {
  if (claim.chain !== 'solana') return { ok: false, reason: 'chain_mismatch' };
  if (!tx.meta) return { ok: false, reason: 'meta_missing' };
  if (tx.meta.err !== null && tx.meta.err !== undefined) return { ok: false, reason: 'transaction_failed' };
  if (tx.transaction?.signatures?.[0] !== claim.txHash) return { ok: false, reason: 'evidence_transaction_mismatch' };
  const payer = tx.transaction.message.accountKeys[0];
  const payerKey = typeof payer === 'string' ? payer : payer?.pubkey;
  if (payerKey !== config.feeWallet) return { ok: false, reason: 'fee_payer_not_facilitator' };
  if (typeof tx.blockTime !== 'number' || !Number.isSafeInteger(tx.blockTime) || tx.blockTime <= 0) {
    return { ok: false, reason: 'block_time_missing' };
  }
  let deltas: Map<string, bigint>;
  try {
    deltas = solanaTokenDeltas(tx.meta);
  } catch {
    return { ok: false, reason: 'token_balances_invalid' };
  }
  const delta = (owner: string, mint: string): bigint => deltas.get(`${owner}|${mint}`) ?? 0n;
  const amount = BigInt(claim.amount);
  const fee = BigInt(claim.fee);
  if (delta(claim.seller, claim.asset) !== amount) return { ok: false, reason: 'seller_credit_mismatch' };
  if (delta(config.feeWallet, SOLANA_USDC_MINT) !== fee) return { ok: false, reason: 'fee_credit_missing' };
  const buyerDebit = claim.asset === SOLANA_USDC_MINT ? amount + fee : amount;
  if (delta(claim.buyer, claim.asset) > -buyerDebit) return { ok: false, reason: 'buyer_debit_missing' };
  return { ok: true, slot: tx.slot, blockTimeMs: tx.blockTime * 1_000 };
}

/**
 * follow-up — the index of the ONE top-level `transferChecked` that pays the seller:
 * an SPL-token instruction moving exactly `claim.amount` of `claim.asset` from a token account the
 * BUYER owns (and authorizes) to one the SELLER owns, owners read from the transaction's own token
 * balances. That index keys the seller's mint-once claim (`solana:<signature>:<index>`), the
 * Solana counterpart of the Base payment log index. Null when there is not exactly one such
 * instruction (Unknown = Block: the caller seals nothing it cannot anchor). Pure.
 */
export function solanaPaymentInstructionIndex(
  tx: SolanaParsedTransaction,
  claim: FacilitatorSettlementClaim,
): number | null {
  if (claim.chain !== 'solana' || !tx.meta) return null;
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const keyAt = (i: number): string | null => {
    const k = keys[i];
    return typeof k === 'string' ? k : (typeof k?.pubkey === 'string' ? k.pubkey : null);
  };
  // token account → (owner, mint), from the post balances (and pre, for an account closed in-tx).
  const owners = new Map<string, { owner: string; mint: string }>();
  for (const row of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
    const account = Number.isSafeInteger(row.accountIndex) ? keyAt(row.accountIndex) : null;
    if (account !== null && typeof row.owner === 'string' && typeof row.mint === 'string') {
      owners.set(account, { owner: row.owner, mint: row.mint });
    }
  }
  const matches: number[] = [];
  (tx.transaction.message.instructions ?? []).forEach((ix, index) => {
    if (!ix || typeof ix.programId !== 'string' || !SOLANA_TOKEN_PROGRAM_IDS.has(ix.programId)) return;
    const parsed = ix.parsed;
    if (!parsed || typeof parsed !== 'object' || parsed.type !== 'transferChecked') return;
    const info = parsed.info ?? {};
    const tokenAmount = info.tokenAmount as { amount?: unknown } | undefined;
    const source = typeof info.source === 'string' ? owners.get(info.source) : undefined;
    const destination = typeof info.destination === 'string' ? owners.get(info.destination) : undefined;
    if (info.mint === claim.asset
      && tokenAmount?.amount === claim.amount
      && info.authority === claim.buyer
      && source?.owner === claim.buyer && source.mint === claim.asset
      && destination?.owner === claim.seller && destination.mint === claim.asset) {
      matches.push(index);
    }
  });
  return matches.length === 1 ? matches[0] : null;
}
