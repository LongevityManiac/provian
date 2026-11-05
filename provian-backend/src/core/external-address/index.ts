/**
 * External-address proof-of-control - orchestrator (Unit 2).
 *
 * Public surface for the challenge/verify flow that lets an agent prove it
 * controls an arbitrary external EVM address, after which the existing
 * inbound/go-forward watcher maps that address's REAL go-forward financial
 * activity to the standard mint path. Separately, the completed proof is the
 * potential qualifying act for a separately armed fixed Genesis grant.
 *
 * Boundaries enforced here:
 *   - Proof is an off-chain signature only (no gas, no tx).
 *   - NO retroactive mint: configured operators agree on head H, proof state is
 *     read canonically at H-11, and `proven_at_block` is the H+1 eligibility
 *     fence. We FAIL CLOSED if those facts cannot be established. Prior and
 *     same-head history sets a read-only reputation tier only (zero PVT).
 *   - The proof PE itself is policy-sealed record-only. Proving is attribution,
 *     not activity; the legacy fixedEstimatedPVT input is not authority.
 *   - agent_id is taken from the authenticated agent by the caller, never a
 *     free parameter, so agent A can't bind an address to agent B.
 */

import { ethers } from 'ethers';
import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import type { PopCacheDeps } from '../agent-wallet/proof-of-possession';
import {
  issueExternalAddressChallenge,
  loadExternalAddressChallenge,
  consumeExternalAddressChallenge,
  personProofSubject,
  type ExternalAddressChallenge,
} from './challenge';
import {
  HUMAN_PROVEN_ADDRESS_SCHEMA,
  writeHumanProvenAddress,
  type HumanProvenAddressRecord,
} from './human-link';
import {
  verifyExternalAddressSignature,
  type ExternalSignatureVerifyResult,
} from './verify';
import {
  PROVEN_ADDRESS_CHAIN,
  PROVEN_ADDRESS_CHAIN_ID,
  PROVEN_ADDRESS_SCHEMA,
  createProvenAddressProofEvidence,
  writeProvenAddress,
  type ProvenAddressRecord,
} from './link';
import type { GenesisActivationApprovalVerifier } from '../pvt/policy/genesis-policy-engine';
import {
  assertExternalProofFenceEvidence,
  readExternalProofNonce,
  revalidateExternalProofFence,
  selectExternalProofFence,
  type ExternalProofFenceEvidence,
} from './proof-head';

/** Genesis (and proof) is Base-only. */
export const PROOF_CHAIN = 'base' as const;
export const PROOF_CHAIN_ID = 8453;

/** PE action type emitted when an external address is proven. */
export const EXTERNAL_ADDRESS_PROVEN_ACTION = 'external_address_proven';

export {
  issueExternalAddressChallenge,
  loadExternalAddressChallenge,
  consumeExternalAddressChallenge,
} from './challenge';
export {
  verifyExternalAddressSignature,
  type ProofMethod,
  type ExternalVerifyDeps,
} from './verify';
export {
  writeProvenAddress,
  getProvenAddress,
  listProvenAddresses,
  type ProvenAddressRecord,
  PROVEN_ADDRESSES_COLLECTION,
  HUMAN_PROVEN_ADDRESSES_COLLECTION,
} from './link';
export {
  listHumanProvenAddresses,
  listHumanProvenAddressesForUser,
  isEconomicallyActiveHumanProvenAddress,
  type HumanProvenAddressRecord,
} from './human-link';

/**
 * Issue a proof challenge. `agentId` MUST be the authenticated agent's id.
 */
export async function issueChallenge(
  cache: PopCacheDeps,
  params: { agentId: string; address: string; now?: number },
): Promise<ExternalAddressChallenge> {
  if (!ethers.isAddress(params.address)) {
    throw new Error('invalid_address');
  }
  return issueExternalAddressChallenge(cache, params);
}

/**
 * Chain reads the prove flow needs. Injectable so the orchestrator is unit
 * testable without a live RPC. Defaults bind to the Base RPC + the real
 * signature verifier.
 */
export interface ProofChainDeps {
  getProofFence: () => Promise<ProofFenceObservation>;
  /** Account nonce read at the canonical finalized proof-state block H-11.
   *  This is a retired coarse activity baseline, not the H+1 reward fence. */
  getTransactionCount: (
    address: string,
    proof: ProofFenceObservation,
  ) => Promise<number>;
  revalidateProofFence: (proof: ProofFenceObservation) => Promise<void>;
  verifySignature: (p: {
    address: string;
    message: string;
    signature: string;
    chain: typeof PROOF_CHAIN;
    proof: ProofFenceObservation;
  }) => Promise<ExternalSignatureVerifyResult>;
}

export type ProofFenceObservation = ExternalProofFenceEvidence;

function defaultProofChainDeps(): ProofChainDeps {
  return {
    getProofFence: () => selectExternalProofFence(),
    getTransactionCount: (address, proof) => readExternalProofNonce(address, proof),
    revalidateProofFence: (proof) => revalidateExternalProofFence(proof),
    verifySignature: (p) => verifyExternalAddressSignature(p),
  };
}

/**
 * Coarse read-only reputation tier from prior outbound activity (nonce). This
 * tiers a returning agent up; it NEVER mints PVT. Kept deliberately simple.
 */
export function reputationTierFromNonce(nonce: number): number {
  if (nonce >= 100) return 3;
  if (nonce >= 10) return 2;
  if (nonce >= 1) return 1;
  return 0;
}

export interface ProveExternalAddressParams {
  /** Authenticated agent id (attribution target). */
  agentId: string;
  /** Genesis per-wallet-ledger key: the agent's native wallet id, else agentId. */
  agentWalletId: string;
  address: string;
  challengeId: string;
  signature: string;
  now?: number;
}

export interface ProveExternalAddressResult {
  ok: boolean;
  reason?: string;
  proven_address?: string;
  proven_at?: number;
  proven_at_block?: number;
  proof_method?: string;
  already_proven?: boolean;
  upgraded_legacy?: boolean;
  pe_id?: string;
  pe_hash?: string;
  initial_reputation_tier?: number;
}

export type ExternalAddressControlResult =
  | {
    readonly ok: true;
    readonly fence: ProofFenceObservation;
    readonly method: NonNullable<ExternalSignatureVerifyResult['method']>;
    readonly baselineNonce: number;
    readonly message: string;
    readonly provenAtMs: number;
  }
  | { readonly ok: false; readonly reason: string };

/**
 * Steps 1–6 of every proof, shared by the agent and person paths (2026-10-01):
 * load the challenge bound to `subjectKey` (an agent id, or `person:<user_id>`),
 * select the operator-agreed H / H-11 fence, verify the signature at the proof
 * block, read the baseline nonce at the same block, re-validate the fence, and
 * only then consume the challenge. Nothing is written here.
 */
export async function verifyExternalAddressControl(
  deps: Pick<AgentBankDeps, 'cache'>,
  params: { subjectKey: string; address: string; challengeId: string; signature: string; now?: number },
  chainDeps: ProofChainDeps = defaultProofChainDeps(),
): Promise<ExternalAddressControlResult> {
  const address = params.address.toLowerCase();
  if (!ethers.isAddress(address)) {
    return { ok: false, reason: 'invalid_address' };
  }

  // 1. Load + validate the challenge (no consume yet).
  const loaded = await loadExternalAddressChallenge(deps.cache, {
    challengeId: params.challengeId,
    agentId: params.subjectKey,
    address,
    now: params.now,
  });
  if (!loaded.ok) {
    return { ok: false, reason: loaded.reason };
  }

  // 2. Select one operator-agreed proof-state block that is already at least
  //    12 confirmations deep. The separate agreed latest head sets the
  //    go-forward fence to head + 1, so prior and same-head activity earn zero.
  const provenAtMs = params.now ?? Date.now();
  let fence: ProofFenceObservation;
  try {
    fence = assertExternalProofFenceEvidence(await chainDeps.getProofFence());
  } catch {
    return { ok: false, reason: 'head_block_unavailable' };
  }

  // 3. Verify the signature against account code at that exact proof block.
  //    A contract at the proof block must pass EIP-1271 at the same block tag;
  //    an EOA at that block must pass EIP-191 recovery.
  const verified = await chainDeps.verifySignature({
    address,
    message: loaded.message,
    signature: params.signature,
    chain: PROOF_CHAIN,
    proof: fence,
  });
  if (!verified.ok || !verified.method) {
    return { ok: false, reason: verified.reason ?? 'signature_invalid' };
  }

  // 4. Bind the baseline nonce and read-only reputation to the same exact
  //    finalized block tag. Unlike the prior best-effort path, an unavailable
  //    baseline cannot silently produce a partially evidenced link.
  let baselineNonce: number;
  try {
    baselineNonce = await chainDeps.getTransactionCount(address, fence);
  } catch {
    return { ok: false, reason: 'baseline_nonce_unavailable' };
  }
  if (!Number.isSafeInteger(baselineNonce) || baselineNonce < 0) {
    return { ok: false, reason: 'baseline_nonce_unavailable' };
  }

  // 5. Re-read the exact block hash after code/signature/nonce reads and require
  //    current operator agreement. A reorg or latest-state disagreement leaves
  //    the challenge unconsumed and the address unlinked.
  try {
    await chainDeps.revalidateProofFence(fence);
  } catch {
    return { ok: false, reason: 'proof_evidence_changed' };
  }

  // 6. Consume the challenge only after every exact-block proof input is final.
  const consumed = await consumeExternalAddressChallenge(deps.cache, params.challengeId);
  if (!consumed) {
    return { ok: false, reason: 'challenge_consume_failed' };
  }
  return { ok: true, fence, method: verified.method, baselineNonce, message: loaded.message, provenAtMs };
}

/**
 * Run the full prove flow: validate + consume the challenge, verify the
 * signature, fence the no-retro block, write the link record, emit a 0-PVT
 * proof PE. Returns a structured result; the route maps reasons to HTTP codes.
 */
export async function proveExternalAddress(
  deps: AgentBankDeps,
  params: ProveExternalAddressParams,
  chainDeps: ProofChainDeps = defaultProofChainDeps(),
): Promise<ProveExternalAddressResult> {
  const address = params.address.toLowerCase();
  const control = await verifyExternalAddressControl(deps, {
    subjectKey: params.agentId,
    address,
    challengeId: params.challengeId,
    signature: params.signature,
    now: params.now,
  }, chainDeps);
  if (!control.ok) return { ok: false, reason: control.reason };
  const { fence, method: verifiedMethod, baselineNonce, message: challengeMessage, provenAtMs } = control;
  const provenAtBlock = fence.provenAtBlock;
  const reputationTier = reputationTierFromNonce(baselineNonce);
  const verified = { method: verifiedMethod };
  const loaded = { message: challengeMessage };

  // 7. Write the link record (rejects a re-bind to a different agent).
  const proofEvidence = createProvenAddressProofEvidence({
    challengeId: params.challengeId,
    challengeMessage: loaded.message,
    signature: params.signature,
    proofMethod: verified.method,
    verifiedAtMs: provenAtMs,
  });
  const record: ProvenAddressRecord = {
    schema_version: PROVEN_ADDRESS_SCHEMA,
    economic_eligibility: 'active_go_forward_only',
    address,
    agent_id: params.agentId,
    wallet_id: params.agentWalletId,
    proven_at_ms: provenAtMs,
    proven_at_block: provenAtBlock,
    proof_observed_head_block: fence.observedHeadBlock,
    proof_block_number: fence.proofBlockNumber,
    proof_block_hash: fence.proofBlockHash,
    proof_min_confirmations: fence.minActivityConfirmations,
    proof_rpc_operator_ids: [...fence.rpcOperatorIds] as [string, string],
    chain: PROVEN_ADDRESS_CHAIN,
    chain_id: PROVEN_ADDRESS_CHAIN_ID,
    proof_method: verified.method,
    signature_hash: proofEvidence.signature_sha256,
    proof_evidence: proofEvidence,
    initial_reputation_tier: reputationTier,
    baseline_nonce: baselineNonce,
    created_at: provenAtMs,
  };
  // PHASE 1: proving an external address emits NO Genesis qualification of any kind.
  // `genesis_signup` was re-scoped to qualify on AGENT WALLET CREATION (see
  // `routes/agent-wallet.ts`) — same canonical key, same grant type, same 75 PVT, same
  // `agent_id` anchor. The proof flow keeps everything it ever did as a PROOF: the binding,
  // one-address-one-agent, the `H+1` no-retro fence, and the read-only reputation tier. It
  // simply no longer pays. Do not re-add a co-write here; two emission sites for one
  // one-time anchor is a double-grant waiting on a race.
  const write = await writeProvenAddress(deps.db, record);
  if (!write.ok) {
    return { ok: false, reason: write.reason };
  }
  const rec = write.record;

  // 8. Emit the proof PE - a RECORD, not money. The action policy seals it
  //    record-only; the compatibility zero is not independent authority.
  //    Attribution is bound to the proving agent; the actor address is the
  //    proven external address.
  //
  //    The link record (step 6) is already written and the no-retro fence is
  //    set, so the address is genuinely proven and safe for the watcher even if
  //    PE emission throws transiently (e.g. a chain-tip transaction conflict).
  //    Surface that as a retryable failure rather than a generic 500: a
  //    re-prove finds the existing binding (fence preserved, idempotent) and
  //    re-emits the PE. We never leave the caller thinking it failed while
  //    silently over-issuing - the proof PE remains record-only either way.
  let peId: string;
  let peHash: string;
  try {
    const emitted = await generatePE(deps, {
      walletId: params.agentWalletId,
      agentId: params.agentId,
      actorAddress: rec.address,
      actionType: EXTERNAL_ADDRESS_PROVEN_ACTION,
      metadata: {
        external_proven: true,
        proven_address: rec.address,
        attributed_agent_id: rec.agent_id,
        proof_method: rec.proof_method,
        proven_at_block: rec.proven_at_block,
        proof_observed_head_block: rec.proof_observed_head_block,
        proof_block_number: rec.proof_block_number,
        proof_block_hash: rec.proof_block_hash,
        proof_min_confirmations: rec.proof_min_confirmations,
        proof_rpc_operator_ids: rec.proof_rpc_operator_ids,
        chain: rec.chain,
        chain_id: rec.chain_id,
        signature_hash: rec.signature_hash,
        proof_evidence: rec.proof_evidence,
        initial_reputation_tier: rec.initial_reputation_tier,
        already_proven: write.already_proven,
        upgraded_legacy: write.upgraded_legacy,
        // This PE attributes provenance; it mints no PVT.
        no_pvt: true,
      },
      fixedEstimatedPVT: 0,
    });
    peId = emitted.peId;
    peHash = emitted.peHash;
  } catch (err) {
    console.warn('[external-address] proof PE emission failed after binding', {
      agentId: params.agentId,
      address,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: 'pe_emission_failed',
      proven_address: rec.address,
      proven_at: rec.proven_at_ms,
      proven_at_block: rec.proven_at_block,
      already_proven: write.already_proven,
      upgraded_legacy: write.upgraded_legacy,
    };
  }

  return {
    ok: true,
    proven_address: rec.address,
    proven_at: rec.proven_at_ms,
    proven_at_block: rec.proven_at_block,
    proof_method: rec.proof_method,
    already_proven: write.already_proven,
    upgraded_legacy: write.upgraded_legacy,
    pe_id: peId,
    pe_hash: peHash,
    initial_reputation_tier: rec.initial_reputation_tier,
  };
}

// =============================================================================
// A PERSON PROVES A WALLET THEY ALREADY HOLD (2026-10-01)
// =============================================================================

export interface ProvePersonExternalAddressParams {
  /** The authenticated person's `user_id` (never client-supplied). */
  userId: string;
  /** The person's own active Provian wallet doc id (`wallets/{id}`). */
  humanWalletId: string;
  address: string;
  challengeId: string;
  signature: string;
  now?: number;
}

/** Issue a person's proof challenge, bound to `person:<user_id>` and the address. */
export async function issuePersonChallenge(
  cache: PopCacheDeps,
  params: { userId: string; address: string; now?: number },
): Promise<ExternalAddressChallenge> {
  if (!ethers.isAddress(params.address)) {
    throw new Error('invalid_address');
  }
  return issueExternalAddressChallenge(cache, {
    agentId: personProofSubject(params.userId),
    address: params.address,
    now: params.now,
  });
}

/**
 * The person's proof: the SAME control proof as an agent's, then a record in
 * `human_proven_addresses` and a 0-PVT `external_address_proven` receipt on the
 * person's own chain. Proving pays nothing; the H+1 fence means only activity
 * after the proof can ever count.
 */
export async function provePersonExternalAddress(
  deps: AgentBankDeps,
  params: ProvePersonExternalAddressParams,
  chainDeps: ProofChainDeps = defaultProofChainDeps(),
): Promise<ProveExternalAddressResult> {
  const control = await verifyExternalAddressControl(deps, {
    subjectKey: personProofSubject(params.userId),
    address: params.address,
    challengeId: params.challengeId,
    signature: params.signature,
    now: params.now,
  }, chainDeps);
  if (!control.ok) return { ok: false, reason: control.reason };
  const { fence, method, baselineNonce, message, provenAtMs } = control;
  const address = params.address.toLowerCase();
  const proofEvidence = createProvenAddressProofEvidence({
    challengeId: params.challengeId,
    challengeMessage: message,
    signature: params.signature,
    proofMethod: method,
    verifiedAtMs: provenAtMs,
  });
  const record: HumanProvenAddressRecord = {
    schema_version: HUMAN_PROVEN_ADDRESS_SCHEMA,
    economic_eligibility: 'active_go_forward_only',
    address,
    user_id: params.userId,
    wallet_id: params.humanWalletId,
    proven_at_ms: provenAtMs,
    proven_at_block: fence.provenAtBlock,
    proof_observed_head_block: fence.observedHeadBlock,
    proof_block_number: fence.proofBlockNumber,
    proof_block_hash: fence.proofBlockHash,
    proof_min_confirmations: fence.minActivityConfirmations,
    proof_rpc_operator_ids: [...fence.rpcOperatorIds] as [string, string],
    chain: PROVEN_ADDRESS_CHAIN,
    chain_id: PROVEN_ADDRESS_CHAIN_ID,
    proof_method: method,
    signature_hash: proofEvidence.signature_sha256,
    proof_evidence: proofEvidence,
    initial_reputation_tier: reputationTierFromNonce(baselineNonce),
    baseline_nonce: baselineNonce,
    created_at: provenAtMs,
  };
  const write = await writeHumanProvenAddress(deps.db, record);
  if (!write.ok) return { ok: false, reason: write.reason };
  const rec = write.record;

  // The proof receipt: a RECORD on the person's own chain, never money (the
  // matrix row is record_only for every owner). Same retry contract as an agent's.
  try {
    const emitted = await generatePE(deps, {
      walletId: rec.wallet_id,
      agentId: rec.user_id,
      ownerType: 'human',
      actorAddress: rec.address,
      actionType: EXTERNAL_ADDRESS_PROVEN_ACTION,
      metadata: {
        external_proven: true,
        proven_address: rec.address,
        proven_by: 'person',
        proof_method: rec.proof_method,
        proven_at_block: rec.proven_at_block,
        proof_observed_head_block: rec.proof_observed_head_block,
        proof_block_number: rec.proof_block_number,
        proof_block_hash: rec.proof_block_hash,
        proof_min_confirmations: rec.proof_min_confirmations,
        proof_rpc_operator_ids: rec.proof_rpc_operator_ids,
        chain: rec.chain,
        chain_id: rec.chain_id,
        signature_hash: rec.signature_hash,
        proof_evidence: rec.proof_evidence,
        initial_reputation_tier: rec.initial_reputation_tier,
        already_proven: write.already_proven,
        no_pvt: true,
      },
      fixedEstimatedPVT: 0,
    });
    return {
      ok: true,
      proven_address: rec.address,
      proven_at: rec.proven_at_ms,
      proven_at_block: rec.proven_at_block,
      proof_method: rec.proof_method,
      already_proven: write.already_proven,
      upgraded_legacy: false,
      pe_id: emitted.peId,
      pe_hash: emitted.peHash,
      initial_reputation_tier: rec.initial_reputation_tier,
    };
  } catch (err) {
    console.warn('[external-address] person proof PE emission failed after binding', {
      address,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: 'pe_emission_failed',
      proven_address: rec.address,
      proven_at: rec.proven_at_ms,
      proven_at_block: rec.proven_at_block,
      already_proven: write.already_proven,
    };
  }
}
