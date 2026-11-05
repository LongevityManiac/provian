/**
 * — THE FACILITATOR LANE: every settlement Provian's x402 facilitator lands is a
 * relay-witnessed PE for the buyer (`x402_payment`) and the seller (`receive`).
 *
 * WHERE THE PE COMES FROM. Only the relay's own reading of the chain. The facilitator POSTs a
 * pointer (`routes/x402-facilitator.ts`); this lane re-reads the transaction itself — Base through
 * the two operator legs at the watcher confirmation floor and the agreed safe head
 * (`verifyBaseTransactionEvidence`), Solana at `finalized` and checks it against the rules in
 * `x402-facilitator-settlement.ts`. A transaction that is not yet final is kept as a pending
 * pointer (`x402_facilitator_settlements_v1`) and retried by the five-minute chain-record cron; one
 * that does not match the pointer is refused and records nothing.
 *
 * WHO IS RECORDED. A party gets an act only when it is a Provian identity — a native wallet (agent
 * or person) through the canonical native address index, or a proven external address (an agent's
 * `proven_addresses`, a person's `human_proven_addresses`) — resolved by the SAME resolvers the
 * chain-record lane uses (`resolveChainRecordWallet` / `resolveChainRecordProvenAddress`), from that
 * identity's own fence (native registration fence / the proof's H+1) forward. A SOLANA party is a
 * Provian identity exactly when it holds an ed25519 proof of control in `solana_proven_addresses`
 * (`external-address/solana-link.ts` the one Solana authority; an agent's reported
 * `chain_addresses.solana` stays display-only), from the proof's slot forward: a settlement in a
 * slot at or before `proven_at_slot` seals nothing for that party (`before_identity_fence`), and an
 * unproven Solana address seals nothing (`not_a_provian_identity`). Its act lands on the owner's
 * own chain (the agent's `agent_id`, or the person's `user_id`).
 *
 * MINT-ONCE — one transaction mints once per actor however many lanes see it. This lane emits
 * through `generatePE` (the relay-authored meter path) with `awaitAccrual`, so the UNCHANGED seal
 * applies, and it keys each act on exactly the anchor the chain watchers key the same leg on:
 * - the buyer's `x402_payment` the x402 claim (payer, settlement tx) — `x402MintClaimKey` /
 * `prepareX402TxMintClaim`, via `payer` + `settlementTxHash` + `chain_verified` in metadata. The
 * outbound USDC watcher labels the same USDC leg `x402_payment` (it reads the settler's
 * `FeeSettled`, `facilitatorSettlementNamesLeg`) and stamps the same three fields;
 * - the seller's `receive` the financial-settlement claim (seller address, `8453:tx:logIndex` of
 * the payment Transfer) — `financialSettlementMintClaimKey`, via `walletAddress` +
 * `observedCanonicalEventId`. The inbound USDC watcher (a USDC payment) and the chain-record
 * lane (a PVT payment) key the same log identically.
 * Whichever lane seals first owns the claim; the other records and earns 0.
 *
 * On SOLANA the same two claims, keyed on the Solana facts (no other lane witnesses Solana today,
 * so they bind replays; the keys are what a future second lane must share):
 * - the buyer's `x402_payment` the x402 claim (payer = the buyer's base58 address, settlement =
 * the transaction signature);
 * - the seller's `receive` the financial-settlement claim (the seller's base58 address,
 * `solana:<signature>:<index of the payment transferChecked>`).
 * Both enter the claim store as exact bytes (`solana-keys.ts`), since the store lowercases and
 * base58 is case-sensitive. The PE ids are `facilitatorActPeId('solana', signature, role)` and the
 * timestamp is the block time, so a replay doubles nothing.
 *
 * FENCES — none is re-implemented here: `counterpartyAddress` carries the other party, so the
 * same-owner / shared-beneficial-owner fence, receive authorship, novelty, the daily
 * ceilings and the 30-day mint window apply exactly as on the watcher lanes. The same-owner fence
 * reads EVM registries, so on Solana a counterparty that is a proven Provian identity is handed to
 * it as that owner's canonical EVM address (a person paying their own linked agent on Solana seals
 * record_only exactly as on Base); a stranger is handed over as its raw base58 address.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import { resolvableOrigin, chainWatcherWitness } from '../provenance/origin-capture';
import { relayObservationWitness, RELAY_WITNESS_CHAIN_WATCHER } from './relay-observation-witness';
import {
  BASE_USDC_ADDRESS,
  verifyBaseTransactionEvidence,
  type BaseTransactionEvidence,
} from '../onchain/economic-discovery';
import { canonicalLogIdentity } from './institution-funding-watcher';
import {
  resolveChainRecordProvenAddress,
  resolveChainRecordWallet,
  type ChainRecordWallet,
} from './chain-record-watcher';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  parseCanonicalNativeAddressIndex,
} from './native-wallet-registration';
import {
  HUMAN_PROVEN_ADDRESSES_COLLECTION,
  PROVEN_ADDRESSES_COLLECTION,
  isEconomicallyActiveProvenAddress,
} from '../external-address/link';
import { isEconomicallyActiveHumanProvenAddress } from '../external-address/human-link';
import { isSolanaAddress, solanaInstructionEventId } from '../external-address/solana-keys';
import { readSolanaProvenAddress, type SolanaAddressOrigin } from '../external-address/solana-link';
import { isActiveHumanWallet } from '../wallet/active-human-wallet';
import {
  FACILITATOR_BASE_CHAIN_ID,
  facilitatorActPeId,
  facilitatorBaseAssets,
  facilitatorBaseGasAddress,
  facilitatorClaimDigest,
  facilitatorSettlementId,
  facilitatorSettlerAddress,
  facilitatorSolanaFeeWallet,
  facilitatorSolanaRpcUrl,
  FACILITATOR_SOLANA_NETWORK,
  SOLANA_USDC_MINT,
  solanaPaymentInstructionIndex,
  verifyBaseFacilitatorEvidence,
  verifySolanaFacilitatorTransaction,
  type FacilitatorSettlementClaim,
  type SolanaParsedTransaction,
} from './x402-facilitator-settlement';

export const FACILITATOR_SETTLEMENTS_COLLECTION = 'x402_facilitator_settlements_v1';
export const FACILITATOR_SETTLEMENT_SCHEMA = 'x402-facilitator-settlement/v1';
/** A pointer whose transaction never becomes final is refused after this long. */
export const FACILITATOR_POINTER_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 2 * 60_000;
const MAX_RETRY_MS = 30 * 60_000;
/** Finished pointers sort past every ready one (the sweep's single-field range). */
const TERMINAL_NEXT_ATTEMPT_MS = Number.MAX_SAFE_INTEGER;

export type FacilitatorRole = 'buyer' | 'seller';
/** The two acts this lane seals — both existing matrix rows; no row is added or changed. */
export type FacilitatorActType = 'x402_payment' | 'receive';

/** The act each role seals. Read through this map by the one emit below. */
export const FACILITATOR_ROLE_ACTS: Readonly<Record<FacilitatorRole, FacilitatorActType>> = Object.freeze({
  buyer: 'x402_payment',
  seller: 'receive',
});

export interface FacilitatorActResult {
  readonly role: FacilitatorRole;
  readonly address: string;
  readonly action_type: FacilitatorActType;
  readonly recorded: boolean;
  readonly pe_id: string | null;
  /** Why no act was sealed (`not_a_provian_identity`, `before_identity_fence`, …). */
  readonly reason: string | null;
}

export type FacilitatorOutcome =
  | { readonly status: 'recorded'; readonly acts: readonly FacilitatorActResult[] }
  | { readonly status: 'pending'; readonly reason: string }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string };

/** What the emit needs to seal one party's act. */
export interface FacilitatorEmitInput {
  readonly role: FacilitatorRole;
  readonly identity: ChainRecordWallet;
  readonly claim: FacilitatorSettlementClaim;
  readonly counterparty: string;
  readonly paymentLogIndex: number;
  readonly evidence: BaseTransactionEvidence;
}

/**
 * The Provian identity behind a proven Solana address. `agentId` is the accrual identity (the
 * agent's `agent_id`, or the person's `user_id`); `ownerEvmAddress` is the owner's LIVE canonical
 * EVM address (the agent wallet's current address, or the person's wallet address), which is what
 * the EVM-registry fences read.
 */
export interface FacilitatorSolanaIdentity {
  readonly walletId: string;
  readonly agentId: string;
  readonly ownerType: 'agent' | 'human';
  readonly address: string;
  readonly provenAtSlot: number;
  readonly ownerEvmAddress: string;
  readonly origin: SolanaAddressOrigin;
}

/** What the Solana emit needs to seal one party's act. */
export interface FacilitatorSolanaEmitInput {
  readonly role: FacilitatorRole;
  readonly identity: FacilitatorSolanaIdentity;
  readonly claim: FacilitatorSettlementClaim;
  /** The other party's base58 address, as settled. */
  readonly counterparty: string;
  /** What the same-owner fence reads: the counterparty owner's EVM address, or the raw base58. */
  readonly counterpartyFenceAddress: string;
  readonly paymentInstructionIndex: number;
  readonly slot: number;
  readonly blockTimeMs: number;
}

export interface FacilitatorLaneDeps {
  readonly db: Firestore;
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  readonly verifyBaseTransaction: (txHash: string) => Promise<BaseTransactionEvidence>;
  /** `getTransaction` at `finalized`, jsonParsed; null when not (yet) finalized or unknown. */
  readonly getSolanaTransaction: (signature: string) => Promise<SolanaParsedTransaction | null>;
  readonly emit: (input: FacilitatorEmitInput) => Promise<{ readonly peId: string }>;
  /** Defaults to `resolveFacilitatorBaseIdentity`. */
  readonly resolveBaseIdentity?: (db: Firestore, address: string) => Promise<ChainRecordWallet | null>;
  /** Seals a Solana party's act. Production always sets it; absent → a Solana act is `unavailable`. */
  readonly emitSolana?: (input: FacilitatorSolanaEmitInput) => Promise<{ readonly peId: string }>;
  /** Defaults to `resolveFacilitatorSolanaIdentity`. */
  readonly resolveSolanaIdentity?: (db: Firestore, address: string) => Promise<FacilitatorSolanaIdentity | null>;
  /** The activity-mapping kill switch; absent = enabled. */
  readonly activityMappingEnabled?: () => Promise<boolean>;
  readonly now?: () => number;
}

// =============================================================================
// IDENTITY
// =============================================================================

/**
 * The Provian identity behind a Base address, or null when there is none. The authorities are the
 * ones every watcher reads: the canonical native address index (then the wallet + its registration
 * fence), the agent proven-address registry, and the person proven-address registry. A proven
 * record that is not economically active is not an identity. A test wallet is not an identity.
 * An index or wallet that does not bind throws (the pointer is retried, never guessed past).
 */
export async function resolveFacilitatorBaseIdentity(
  db: Firestore,
  address: string,
): Promise<ChainRecordWallet | null> {
  const lower = address.toLowerCase();
  const indexId = nativeWalletAddressIndexId(lower);
  const indexSnap = await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(indexId).get();
  if (indexSnap.exists) {
    const authority = parseCanonicalNativeAddressIndex(indexSnap.data() as Record<string, unknown>, indexId);
    if (authority.address !== lower) throw new Error('facilitator_identity_index_mismatch');
    return resolveChainRecordWallet(db, authority.wallet_id, authority.owner_type);
  }
  const agentProven = await db.collection(PROVEN_ADDRESSES_COLLECTION).doc(lower).get();
  if (agentProven.exists && isEconomicallyActiveProvenAddress(agentProven.data(), lower)) {
    return resolveChainRecordProvenAddress(db, lower, 'agent');
  }
  const personProven = await db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(lower).get();
  if (personProven.exists && isEconomicallyActiveHumanProvenAddress(personProven.data(), lower)) {
    return resolveChainRecordProvenAddress(db, lower, 'human');
  }
  return null;
}

/**
 * The Provian identity behind a Solana address, or null when there is none: the address must hold
 * a valid proof in `solana_proven_addresses`, and the owner's wallet must still bind it (the agent
 * wallet named by the record, or the person's active human wallet). A test wallet is not an
 * identity. A record or wallet that does not bind throws (the pointer is retried, never guessed past).
 */
export async function resolveFacilitatorSolanaIdentity(
  db: Firestore,
  address: string,
): Promise<FacilitatorSolanaIdentity | null> {
  if (!isSolanaAddress(address)) return null;
  const record = await readSolanaProvenAddress(db, address);
  if (record === null) return null;
  if (record.owner_type === 'agent') {
    const snap = await db.collection('agent_wallets').doc(record.wallet_id).get();
    if (!snap.exists) throw new Error('facilitator_solana_wallet_missing');
    const wallet = snap.data() as { id?: unknown; agent_id?: unknown; address?: unknown; platform?: unknown };
    if (wallet.platform === 'test') return null;
    if (wallet.id !== record.wallet_id || wallet.agent_id !== record.agent_id
      || typeof wallet.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) {
      throw new Error('facilitator_solana_agent_wallet_mismatch');
    }
    return {
      walletId: record.wallet_id,
      agentId: record.agent_id as string,
      ownerType: 'agent',
      address: record.address,
      provenAtSlot: record.proven_at_slot,
      ownerEvmAddress: wallet.address.toLowerCase(),
      origin: record.origin,
    };
  }
  const snap = await db.collection('wallets').doc(record.wallet_id).get();
  const wallet = snap.exists ? snap.data() as Record<string, unknown> : undefined;
  if (wallet?.platform === 'test') return null;
  if (!wallet || !isActiveHumanWallet(wallet) || wallet.id !== record.wallet_id || wallet.user_id !== record.user_id) {
    throw new Error('facilitator_solana_person_wallet_invalid');
  }
  return {
    walletId: record.wallet_id,
    agentId: record.user_id as string,
    ownerType: 'human',
    address: record.address,
    provenAtSlot: record.proven_at_slot,
    ownerEvmAddress: (wallet.address as string).toLowerCase(),
    origin: record.origin,
  };
}

// =============================================================================
// PROCESS ONE POINTER
// =============================================================================

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Verify one pointer against the chain and, when it holds, seal each Provian party's act.
 * Idempotent: the act PE ids are deterministic and the timestamp is the block's, so a replay of
 * the same settlement returns the sealed PEs and doubles nothing.
 */
export async function processFacilitatorSettlement(
  deps: FacilitatorLaneDeps,
  claim: FacilitatorSettlementClaim,
): Promise<FacilitatorOutcome> {
  const env = deps.env ?? process.env;
  if (deps.activityMappingEnabled && !(await deps.activityMappingEnabled())) {
    return { status: 'pending', reason: 'activity_mapping_disabled' };
  }

  if (claim.chain === 'solana') {
    const feeWallet = facilitatorSolanaFeeWallet(env);
    if (feeWallet === null) return { status: 'unavailable', reason: 'facilitator_solana_fee_wallet_invalid' };
    let tx: SolanaParsedTransaction | null;
    try {
      tx = await deps.getSolanaTransaction(claim.txHash);
    } catch (error) {
      return { status: 'pending', reason: `solana_rpc:${errorText(error)}` };
    }
    if (tx === null) return { status: 'pending', reason: 'solana_transaction_not_finalized' };
    const verdict = verifySolanaFacilitatorTransaction(tx, claim, { feeWallet });
    if (!verdict.ok) return { status: 'refused', reason: verdict.reason };
    return processSolanaParties(deps, claim, tx, verdict);
  }

  const settler = facilitatorSettlerAddress(env);
  if (settler === null) return { status: 'unavailable', reason: 'facilitator_settler_not_configured' };
  const feeRecipient = facilitatorBaseGasAddress(env);
  if (feeRecipient === null) return { status: 'unavailable', reason: 'facilitator_base_gas_address_invalid' };
  if (!(claim.asset in facilitatorBaseAssets())) return { status: 'refused', reason: 'asset_not_allowed' };

  let evidence: BaseTransactionEvidence;
  try {
    evidence = await deps.verifyBaseTransaction(claim.txHash);
  } catch (error) {
    const message = errorText(error);
    // A reverted transaction (receipt status 0) is terminal; everything else is "not yet".
    if (message === 'economic_evidence_transaction_failed') return { status: 'refused', reason: 'transaction_failed' };
    return { status: 'pending', reason: message };
  }
  const verdict = verifyBaseFacilitatorEvidence(evidence, claim, { settler, feeRecipient });
  if (!verdict.ok) return { status: 'refused', reason: verdict.reason };

  const resolve = deps.resolveBaseIdentity ?? resolveFacilitatorBaseIdentity;
  const acts: FacilitatorActResult[] = [];
  for (const role of ['buyer', 'seller'] as const) {
    const address = role === 'buyer' ? claim.buyer : claim.seller;
    const counterparty = role === 'buyer' ? claim.seller : claim.buyer;
    const actionType = FACILITATOR_ROLE_ACTS[role];
    let identity: ChainRecordWallet | null;
    try {
      identity = await resolve(deps.db, address);
    } catch (error) {
      return { status: 'pending', reason: `identity_unresolvable:${role}:${errorText(error)}` };
    }
    if (identity === null) {
      acts.push({ role, address, action_type: actionType, recorded: false, pe_id: null, reason: 'not_a_provian_identity' });
      continue;
    }
    if (identity.address !== address) {
      return { status: 'pending', reason: `identity_address_mismatch:${role}` };
    }
    if (verdict.blockNumber < identity.eligibilityStartBlock) {
      acts.push({ role, address, action_type: actionType, recorded: false, pe_id: null, reason: 'before_identity_fence' });
      continue;
    }
    let emitted: { readonly peId: string };
    try {
      emitted = await deps.emit({
        role, identity, claim, counterparty, paymentLogIndex: verdict.paymentLogIndex, evidence,
      });
    } catch (error) {
      // The act's PE id is deterministic: a retry returns what was sealed and prices what was not.
      return { status: 'pending', reason: `emit_failed:${role}:${errorText(error)}` };
    }
    acts.push({ role, address, action_type: actionType, recorded: true, pe_id: emitted.peId, reason: null });
  }
  return { status: 'recorded', acts };
}

/**
 * Seal each Solana party's act: resolve both parties first (a counterparty's owner feeds the fence
 * even when only one party is recorded), then emit for every proven party past its slot fence.
 */
async function processSolanaParties(
  deps: FacilitatorLaneDeps,
  claim: FacilitatorSettlementClaim,
  tx: SolanaParsedTransaction,
  verdict: { readonly slot: number; readonly blockTimeMs: number },
): Promise<FacilitatorOutcome> {
  const resolve = deps.resolveSolanaIdentity ?? resolveFacilitatorSolanaIdentity;
  const identities = new Map<FacilitatorRole, FacilitatorSolanaIdentity | null>();
  for (const role of ['buyer', 'seller'] as const) {
    const address = role === 'buyer' ? claim.buyer : claim.seller;
    try {
      const identity = await resolve(deps.db, address);
      if (identity !== null && identity.address !== address) {
        return { status: 'pending', reason: `identity_address_mismatch:${role}` };
      }
      identities.set(role, identity);
    } catch (error) {
      return { status: 'pending', reason: `identity_unresolvable:${role}:${errorText(error)}` };
    }
  }
  const toEmit = (['buyer', 'seller'] as const).filter((role) => {
    const identity = identities.get(role) ?? null;
    return identity !== null && verdict.slot > identity.provenAtSlot;
  });
  // Anchor before sealing anything: the seller's claim keys on the payment instruction, and an act
  // that cannot be anchored is never sealed (Unknown = Block).
  let paymentIx: number | null = null;
  if (toEmit.length > 0) {
    if (claim.asset !== SOLANA_USDC_MINT) return { status: 'refused', reason: 'asset_not_allowed' };
    paymentIx = solanaPaymentInstructionIndex(tx, claim);
    if (paymentIx === null) return { status: 'refused', reason: 'payment_instruction_unresolvable' };
    if (!deps.emitSolana) return { status: 'unavailable', reason: 'facilitator_solana_emit_not_configured' };
  }
  const acts: FacilitatorActResult[] = [];
  for (const role of ['buyer', 'seller'] as const) {
    const address = role === 'buyer' ? claim.buyer : claim.seller;
    const counterpartyRole: FacilitatorRole = role === 'buyer' ? 'seller' : 'buyer';
    const counterparty = role === 'buyer' ? claim.seller : claim.buyer;
    const actionType = FACILITATOR_ROLE_ACTS[role];
    const identity = identities.get(role) ?? null;
    if (identity === null) {
      acts.push({ role, address, action_type: actionType, recorded: false, pe_id: null, reason: 'not_a_provian_identity' });
      continue;
    }
    if (verdict.slot <= identity.provenAtSlot) {
      acts.push({ role, address, action_type: actionType, recorded: false, pe_id: null, reason: 'before_identity_fence' });
      continue;
    }
    const counterpartyIdentity = identities.get(counterpartyRole) ?? null;
    const emitSolana = deps.emitSolana;
    if (!emitSolana || paymentIx === null) {
      return { status: 'unavailable', reason: 'facilitator_solana_emit_not_configured' };
    }
    let emitted: { readonly peId: string };
    try {
      emitted = await emitSolana({
        role,
        identity,
        claim,
        counterparty,
        counterpartyFenceAddress: counterpartyIdentity?.ownerEvmAddress ?? counterparty,
        paymentInstructionIndex: paymentIx,
        slot: verdict.slot,
        blockTimeMs: verdict.blockTimeMs,
      });
    } catch (error) {
      return { status: 'pending', reason: `emit_failed:${role}:${errorText(error)}` };
    }
    acts.push({ role, address, action_type: actionType, recorded: true, pe_id: emitted.peId, reason: null });
  }
  return { status: 'recorded', acts };
}

// =============================================================================
// THE POINTER RECORD (idempotent route + retry sweep)
// =============================================================================

interface PointerDoc {
  readonly schema_version: typeof FACILITATOR_SETTLEMENT_SCHEMA;
  readonly settlement_id: string;
  readonly claim_digest: string;
  readonly claim: Record<string, string>;
  readonly status: 'pending' | 'recorded' | 'refused';
  readonly reason: string | null;
  readonly acts: readonly FacilitatorActResult[];
  readonly first_reported_at_ms: number;
  readonly updated_at_ms: number;
  readonly attempts: number;
  readonly next_attempt_at_ms: number;
}

function claimRecord(claim: FacilitatorSettlementClaim): Record<string, string> {
  return {
    chain: claim.chain, tx_hash: claim.txHash, buyer: claim.buyer, seller: claim.seller,
    asset: claim.asset, amount: claim.amount, fee: claim.fee, scheme: claim.scheme,
  };
}

function claimFromRecord(raw: unknown): FacilitatorSettlementClaim | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const fields = ['chain', 'tx_hash', 'buyer', 'seller', 'asset', 'amount', 'fee', 'scheme'];
  if (fields.some((f) => typeof r[f] !== 'string')) return null;
  return {
    chain: r.chain as FacilitatorSettlementClaim['chain'],
    txHash: r.tx_hash as string,
    buyer: r.buyer as string,
    seller: r.seller as string,
    asset: r.asset as string,
    amount: r.amount as string,
    fee: r.fee as string,
    scheme: r.scheme as FacilitatorSettlementClaim['scheme'],
  };
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 10);
  return Math.min(RETRY_MS * 2 ** exponent, MAX_RETRY_MS);
}

export type FacilitatorSubmission =
  | FacilitatorOutcome
  | { readonly status: 'conflict'; readonly reason: string };

/**
 * The route's half: record (or re-read) the pointer, process it, and persist the outcome.
 *   - an already-RECORDED settlement returns its stored acts (idempotent), unless the report names
 *     different terms (409 conflict);
 *   - otherwise the pointer is (re)processed; pending outcomes stay queued for the sweep.
 */
export async function submitFacilitatorSettlement(
  deps: FacilitatorLaneDeps,
  claim: FacilitatorSettlementClaim,
): Promise<FacilitatorSubmission> {
  const now = (deps.now ?? Date.now)();
  const id = facilitatorSettlementId(claim);
  const digest = facilitatorClaimDigest(claim);
  const ref = deps.db.collection(FACILITATOR_SETTLEMENTS_COLLECTION).doc(id);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() as Partial<PointerDoc> : null;
  if (existing?.status === 'recorded') {
    if (existing.claim_digest !== digest) return { status: 'conflict', reason: 'settlement_recorded_with_different_terms' };
    return { status: 'recorded', acts: existing.acts ?? [] };
  }
  const outcome = await processFacilitatorSettlement(deps, claim);
  if (outcome.status === 'unavailable') return outcome; // configuration fault: nothing is persisted
  // A refused report never displaces a queued pointer that named DIFFERENT terms: the queued one
  // may still be the true settlement, and only its own sweep may retire it.
  if (outcome.status === 'refused' && existing?.status === 'pending' && existing.claim_digest !== digest) {
    return outcome;
  }
  const attempts = (typeof existing?.attempts === 'number' ? existing.attempts : 0) + 1;
  const firstReported = typeof existing?.first_reported_at_ms === 'number' ? existing.first_reported_at_ms : now;
  const doc: PointerDoc = {
    schema_version: FACILITATOR_SETTLEMENT_SCHEMA,
    settlement_id: id,
    claim_digest: digest,
    claim: claimRecord(claim),
    status: outcome.status,
    reason: outcome.status === 'recorded' ? null : outcome.reason,
    acts: outcome.status === 'recorded' ? outcome.acts : [],
    first_reported_at_ms: firstReported,
    updated_at_ms: now,
    attempts,
    next_attempt_at_ms: outcome.status === 'pending' ? now + retryDelayMs(attempts) : TERMINAL_NEXT_ATTEMPT_MS,
  };
  await ref.set(doc as unknown as Record<string, unknown>);
  return outcome;
}

export interface FacilitatorSweepReport {
  scanned: number;
  recorded: number;
  pending: number;
  refused: number;
  errors: number;
}

/** Retry pending pointers whose transaction was not yet final (run from the chain-record cron). */
export async function runFacilitatorSettlementSweep(
  deps: FacilitatorLaneDeps,
  options: { readonly limit?: number } = {},
): Promise<FacilitatorSweepReport> {
  const now = (deps.now ?? Date.now)();
  const report: FacilitatorSweepReport = { scanned: 0, recorded: 0, pending: 0, refused: 0, errors: 0 };
  const snap = await deps.db.collection(FACILITATOR_SETTLEMENTS_COLLECTION)
    .where('next_attempt_at_ms', '<=', now)
    .orderBy('next_attempt_at_ms')
    .limit(Math.max(1, options.limit ?? 50))
    .get();
  for (const doc of snap.docs) {
    const data = doc.data() as Partial<PointerDoc>;
    if (data.status !== 'pending') continue;
    const claim = claimFromRecord(data.claim);
    report.scanned += 1;
    if (claim === null || facilitatorSettlementId(claim) !== doc.id) {
      await doc.ref.set({ status: 'refused', reason: 'pointer_record_invalid', updated_at_ms: now, next_attempt_at_ms: TERMINAL_NEXT_ATTEMPT_MS }, { merge: true });
      report.refused += 1;
      continue;
    }
    if (typeof data.first_reported_at_ms === 'number' && now - data.first_reported_at_ms > FACILITATOR_POINTER_HORIZON_MS) {
      await doc.ref.set({
        status: 'refused', reason: `horizon_expired:${data.reason ?? 'pending'}`, updated_at_ms: now,
        next_attempt_at_ms: TERMINAL_NEXT_ATTEMPT_MS,
      }, { merge: true });
      report.refused += 1;
      continue;
    }
    try {
      const outcome = await submitFacilitatorSettlement({ ...deps, now: () => now }, claim);
      if (outcome.status === 'recorded') report.recorded += 1;
      else if (outcome.status === 'refused' || outcome.status === 'conflict') report.refused += 1;
      else report.pending += 1;
    } catch (error) {
      report.errors += 1;
      console.error(`[x402-facilitator] sweep of ${doc.id} failed:`, error);
    }
  }
  return report;
}

// =============================================================================
// PRODUCTION DEPS
// =============================================================================

/**
 * `getTransaction` at `finalized` commitment. Finalized, not `confirmed`: a finalized block is
 * rooted by a supermajority and cannot be rolled back, which is the Solana counterpart of the
 * Base watchers' 12-confirmation + safe-head floor (a `confirmed` block can still, rarely, be
 * dropped — Unknown = Block). Finality lands ~13 s after confirmation, well inside the sweep.
 */
export function buildSolanaTransactionReader(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): (signature: string) => Promise<SolanaParsedTransaction | null> {
  return async (signature) => {
    const res = await fetchImpl(facilitatorSolanaRpcUrl(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json() as { result?: SolanaParsedTransaction | null; error?: unknown };
    if (!res.ok || body.error !== undefined || body.result === undefined) {
      throw new Error('solana_rpc_unavailable');
    }
    return body.result;
  };
}

/**
 * The production emit: one relay-authored PE per party through `generatePE`, keyed on exactly
 * the anchors the chain watchers key the same leg on (see the module header).
 */
export function buildFacilitatorEmit(deps: AgentBankDeps): FacilitatorLaneDeps['emit'] {
  return async ({ role, identity, claim, counterparty, paymentLogIndex, evidence }) => {
    const actionType = FACILITATOR_ROLE_ACTS[role];
    const assetSymbol = facilitatorBaseAssets()[claim.asset];
    const canonicalEventId = canonicalLogIdentity(FACILITATOR_BASE_CHAIN_ID, claim.txHash, paymentLogIndex);
    const witness = chainWatcherWitness(`eip155:${FACILITATOR_BASE_CHAIN_ID}`);
    const derived = [
      resolvableOrigin(`evm:${counterparty}`, witness),
      resolvableOrigin(`chaintx:${canonicalEventId}`, witness),
    ];
    const isUsdc = claim.asset === BASE_USDC_ADDRESS;
    const emitted = await generatePE(deps, {
      walletId: identity.walletId,
      agentId: identity.agentId,
      actorAddress: identity.address,
      actionType,
      ownerType: identity.ownerType,
      walletAddress: identity.address,
      counterpartyAddress: counterparty,
      // A receive that reached the seller through the settler: the same-owner fence checks the
      // verified signer (the facilitator's gas EOA, a stranger to every owner) too — as the
      // chain-record lane does for a receive through a contract.
      transactionSignerAddress: role === 'seller' ? evidence.fromAddress : null,
      metadata: {
        tx_hash: claim.txHash,
        log_index: paymentLogIndex,
        block_number: evidence.blockNumber,
        block_hash: evidence.blockHash,
        chain: 'base',
        chain_id: FACILITATOR_BASE_CHAIN_ID,
        asset: assetSymbol,
        token_address: claim.asset,
        amount_atomic: claim.amount,
        // A dollar amount only for USDC; a PVT payment is never quoted in dollars.
        ...(isUsdc ? { amount_usd: Number(claim.amount) / 1e6 } : {}),
        fee_usdc_atomic: claim.fee,
        x402_scheme: claim.scheme,
        settler: evidence.toAddress,
        submitter: evidence.fromAddress,
        tx_to: evidence.toAddress,
        tx_selector: evidence.transactionSelector,
        verified: true,
        finality_confirmations: evidence.confirmationFloor,
        economic_evidence_hash: evidence.evidenceHash,
        economic_evidence_providers: [...evidence.providerOperatorIds],
        activity_mapped: true,
        source_type: 'x402_facilitator',
        attributed_agent_id: identity.agentId,
        ...(identity.addressKind === 'proven'
          ? { external_proven: true, proven_address: identity.address }
          : { native_address: identity.address }),
        counterparty_address: counterparty,
        // The x402 claim's inputs, exactly as the outbound USDC watcher stamps them: the payer,
        // the settlement tx, and the chain-verified mint authority.
        ...(role === 'buyer'
          ? { payer: identity.address, settlementTxHash: claim.txHash, chain_verified: true }
          : {}),
      },
      input_origins: derived,
      relayObservation: {
        witness: relayObservationWitness(RELAY_WITNESS_CHAIN_WATCHER, `eip155:${FACILITATOR_BASE_CHAIN_ID}`),
        derivedOrigins: derived,
      },
      observedCanonicalEventId: canonicalEventId,
      peIdOverride: facilitatorActPeId('base', claim.txHash, role),
      timestampOverride: evidence.blockTimestampMs,
      awaitAccrual: true,
    });
    return { peId: emitted.peId };
  };
}

/**
 * The production Solana emit: one relay-authored PE per party through `generatePE`, on the owner's
 * own chain, keyed on the Solana anchors (see the module header). The block time is the PE time.
 */
export function buildFacilitatorSolanaEmit(deps: AgentBankDeps): NonNullable<FacilitatorLaneDeps['emitSolana']> {
  return async ({ role, identity, claim, counterparty, counterpartyFenceAddress, paymentInstructionIndex, slot, blockTimeMs }) => {
    const actionType = FACILITATOR_ROLE_ACTS[role];
    const canonicalEventId = solanaInstructionEventId(claim.txHash, paymentInstructionIndex);
    const witness = chainWatcherWitness(FACILITATOR_SOLANA_NETWORK);
    const derived = [
      resolvableOrigin(`solana:${counterparty}`, witness),
      resolvableOrigin(`chaintx:${canonicalEventId}`, witness),
    ];
    const emitted = await generatePE(deps, {
      walletId: identity.walletId,
      agentId: identity.agentId,
      actorAddress: identity.address,
      actionType,
      ownerType: identity.ownerType,
      walletAddress: identity.address,
      counterpartyAddress: counterpartyFenceAddress,
      // A Solana settlement read by the relay at `finalized` is a chain witness, as a Base one is.
      witnessClass: 'chain_witnessed',
      metadata: {
        tx_hash: claim.txHash,
        signature: claim.txHash,
        instruction_index: paymentInstructionIndex,
        slot,
        chain: 'solana',
        network: FACILITATOR_SOLANA_NETWORK,
        asset: 'USDC',
        token_address: claim.asset,
        amount_atomic: claim.amount,
        amount_usd: Number(claim.amount) / 1e6,
        fee_usdc_atomic: claim.fee,
        x402_scheme: claim.scheme,
        verified: true,
        finality: 'finalized',
        activity_mapped: true,
        source_type: 'x402_facilitator',
        attributed_agent_id: identity.agentId,
        external_proven: true,
        proven_address: identity.address,
        solana_address: identity.address,
        solana_address_origin: identity.origin,
        counterparty_address: counterparty,
        ...(counterpartyFenceAddress !== counterparty ? { counterparty_owner_address: counterpartyFenceAddress } : {}),
        // The x402 claim's inputs: the payer, the settlement signature, the chain-verified authority.
        ...(role === 'buyer'
          ? { payer: identity.address, settlementTxHash: claim.txHash, chain_verified: true }
          : {}),
      },
      input_origins: derived,
      relayObservation: {
        witness: relayObservationWitness(RELAY_WITNESS_CHAIN_WATCHER, FACILITATOR_SOLANA_NETWORK),
        derivedOrigins: derived,
      },
      observedCanonicalEventId: canonicalEventId,
      peIdOverride: facilitatorActPeId('solana', claim.txHash, role),
      timestampOverride: blockTimeMs,
      awaitAccrual: true,
    });
    return { peId: emitted.peId };
  };
}

export function buildFacilitatorLaneDeps(
  deps: AgentBankDeps,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly activityMappingEnabled?: () => Promise<boolean>;
  } = {},
): FacilitatorLaneDeps {
  return {
    db: deps.db,
    env: options.env ?? process.env,
    verifyBaseTransaction: (txHash) => verifyBaseTransactionEvidence({ transactionHash: txHash }),
    getSolanaTransaction: buildSolanaTransactionReader(fetch, options.env ?? process.env),
    emit: buildFacilitatorEmit(deps),
    emitSolana: buildFacilitatorSolanaEmit(deps),
    ...(options.activityMappingEnabled ? { activityMappingEnabled: options.activityMappingEnabled } : {}),
  };
}
