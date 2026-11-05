/**
 * Agent Bank - Court Business Logic (Phase 2)
 *
 * Arbitration by opted-in agents. Until enough qualified arbitrators exist the Court seats no panel, and Provian's admin key resolves disputed escrows on-chain.
 * Eligible agents opt in as arbitrators; 3-member panels are randomly
 * selected to vote on disputed escrows. 2-vote majority resolves.
 *
 * Firestore collections: `arbitrators/`, `court_disputes/`
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  SAFETY_LIMITS,
  type AgentBankDeps,
  type ArbitratorDocument,
  type BondClaimDocument,
  type BondClaimVerdict,
  type BondSlashBasis,
  type CourtDisputeDocument,
  type CourtVoteRecord,
  type EscrowDisputeSettleResult,
  type EscrowDocument,
  type GeneralDisputeDocument,
  type GeneralDisputeResolution,
} from './types';
import { ValidationError, NotFoundError, ForbiddenError } from './errors';
import { generatePE } from './pe-utils';
import {
  resolveBondClaim,
  recordBondClaimCourtFinding,
  getClaimDetails,
  bondPoolAddressForChain,
  chainIdForChain,
} from './bonds';
import {
  evaluateInstitutionTransition,
  INITIAL,
  type InstitutionKind,
  type ReceiptEvidence,
} from './institution-state-machine';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { verifyEvmContractCall, recoverEvmBondClaimResolution } from '../onchain/tx-verifier';
import {
  assertSupportedAgentBankChain,
  chainIdForName,
  courtAddressForChain,
  type AgentBankChain,
} from './chain-registry';
import { computeActorVocabulary, VocabularyUnavailableError } from '../presentation/vocabulary';
import {
  resolveCitedAct,
  type CitedActDeps,
  type CitedActFacts,
  type PresentedPeProof,
} from '../meter/cited-act';
import { canonicalPeAnchorReadContract } from '../presentation/anchor-contract';

/**
 * A cited PE's identifier facts (`cited-act.ts`): the act key, an identity act, or the presented
 * PE + inclusion proof. Not found → 404 naming how to cite an older act; a presented proof that
 * fails → the proof's own refusal, never "not found".
 */
async function citedActOrThrow(
  deps: AgentBankDeps,
  peId: string,
  proofs: ReadonlyMap<string, PresentedPeProof> | undefined,
  anchorContract: CitedActDeps['anchorContract'] | undefined,
): Promise<CitedActFacts> {
  const presented = proofs?.get(peId) ?? null;
  const resolved = await resolveCitedAct(deps.db, peId, presented, {
    anchorContract: anchorContract === undefined
      ? (presented !== null ? canonicalPeAnchorReadContract() : null)
      : anchorContract,
  });
  if (resolved.status === 'found') return resolved.facts;
  if (resolved.status === 'not_found') {
    throw new NotFoundError(
      `PE ${peId} not found in retained relay facts: supply its owner-held PE and inclusion proof (pe_proofs)`,
    );
  }
  if (resolved.http === 403) throw new ForbiddenError(`PE ${peId}: ${resolved.reason}`);
  if (resolved.http >= 500) throw new Error(`PE ${peId}: ${resolved.reason}`);
  throw new ValidationError(`PE ${peId}: ${resolved.reason}`);
}

// =========================================================================
// agent directory — the ONE institution-machine gate for Court process transitions
// =========================================================================

/**
 * Evaluate an agent-initiated Court transition INTENT through the ONE machine
 * BEFORE any I/O — suspension check FIRST (the relay's agent-suspension state for
 * the ACTING wallet; a missing/non-'active' status blocks, Unknown = Block).
 * For the ECONOMIC court_dispute pending→resolved edge the settlement receipt
 * does not exist yet at intent time, so the guard's `receipt_required` outcome
 * is the expected pass-through: it proves the suspension check is clear AND the
 * (kind, from, to) edge is declared. The authoritative receipt-gated
 * evaluation then runs INSIDE the Firestore transaction on the FRESH doc
 * state (bond lifecycle shape, bonds.ts).
 */
function assertCourtTransitionIntent(
  actingWallet: AgentWalletDocument,
  kind: InstitutionKind,
  from: string,
  to: string,
  illegalEdgeMessage: string,
): void {
  const decision = evaluateInstitutionTransition({
    kind,
    from,
    to,
    killSwitchActive: actingWallet.status !== 'active',
  });
  if (decision.allowed) return; // declared record_only edge
  if (decision.reason === 'kill_switch_active') {
    throw new ForbiddenError('Agent wallet is not active');
  }
  if (decision.reason === 'receipt_required') return; // declared economic edge; receipt is gated later
  throw new ValidationError(illegalEdgeMessage);
}

/**
 * agent directory: the receipt-gated evaluation for the ECONOMIC court_dispute
 * pending→resolved edge (and the escrow disputed→resolved flip it carries),
 * run at the settlement point inside the Firestore transaction on FRESH doc
 * state. Any block throws, aborting the transaction. Returns the guard's
 * `idempotent` flag so a replayed settlement records no second economic PE.
 */
function assertCourtEconomicTransition(input: {
  kind: InstitutionKind;
  from: string;
  to: string;
  receipt: ReceiptEvidence;
  priorEconomicTxHashes?: readonly string[];
  killSwitchActive: boolean;
}): { idempotent: boolean } {
  const decision = evaluateInstitutionTransition(input);
  if (!decision.allowed) {
    if (decision.reason === 'kill_switch_active') {
      throw new ForbiddenError('Agent wallet is not active');
    }
    throw new ValidationError(`Institution transition blocked: ${decision.reason}`);
  }
  if (!decision.economic) {
    throw new ValidationError('Expected an economic institution transition');
  }
  return { idempotent: decision.idempotent };
}

/**
 * agent directory: evaluate a SYSTEM (scheduler / admin-panel-assignment) record-only
 * Court transition through the machine. killSwitchActive is false — these are
 * relay-driven process advances, not agent-initiated actions. A
 * blocked decision throws (Unknown = Block; an undeclared edge never advances
 * a dispute record).
 */
function assertSystemRecordTransition(kind: InstitutionKind, from: string, to: string): void {
  const decision = evaluateInstitutionTransition({ kind, from, to, killSwitchActive: false });
  if (!decision.allowed) {
    throw new ValidationError(`Institution transition blocked: ${decision.reason}`);
  }
}

async function updateWalletStats(
  deps: AgentBankDeps,
  walletId: string,
  transactionAmountUsd: number,
): Promise<void> {
  // The stored `pe_count` tally is gone : PE counts are read live from
  // pe_history / actor_stats, never from a per-wallet counter. Only the economic
  // activity total (which the bond trust discount reads) is maintained here.
  const { FieldValue } = await import('firebase-admin/firestore');
  await deps.db.collection('agent_wallets').doc(walletId).update({
    economic_activity_usd: FieldValue.increment(transactionAmountUsd),
    updated_at: Date.now(),
  });
}

// =========================================================================
// Arbitrator operations
// =========================================================================

/**
 * An agent opts in as an arbitrator only when all three criteria hold:
 *
 * 1. >= COURT_MIN_COMPLETED_ESCROWS completed escrows AS A PARTY, each with a
 * real counterparty (depositor != recipient — no self-escrow farming). Both
 * sides (depositor and recipient) count.
 * 2. Clean standing: zero adverse events on record (defaults are one of the
 * adverse types, so this subsumes "no defaults"). Read from the SAME live
 * standing facts the presentation vocabulary exposes — Standing is
 * always present and non-redactable.
 * 3. An active bond in the agent-bank bond system. Arbitrators impose slashes;
 * they must themselves be slashable.
 *
 * The gate reads NO governance signal and NO stored PE tally — both were deleted
 * as dead post-/ (invariant). Standing + bond come from
 * `computeActorVocabulary` (the reputation vocabulary), the escrow count from a
 * direct query with the real-counterparty filter. There is deliberately no
 * capital or effort floor beyond the bond and the earned escrow history.
 *
 * Nothing here activates Court. It stays deferred; this only defines who
 * qualifies when it lights (Escalate-to-Court remains gated on Court reporting
 * `live`, and panel selection is unchanged).
 */
export async function optInAsArbitrator(
  deps: AgentBankDeps,
  walletId: string,
): Promise<ArbitratorDocument> {
  const walletDoc = await deps.db.collection('agent_wallets').doc(walletId).get();
  if (!walletDoc.exists) throw new NotFoundError('Wallet not found');
  const wallet = walletDoc.data() as AgentWalletDocument;

  // Criterion 1 — completed escrows AS A PARTY with a real counterparty. Count
  // both depositor- and recipient-side completed/resolved escrows, excluding any
  // self-escrow (depositor === recipient) so the count cannot be farmed.
  const [asDepositor, asRecipient] = await Promise.all([
    deps.db.collection('escrows')
      .where('depositor_wallet_id', '==', walletId)
      .where('status', 'in', ['completed', 'resolved'])
      .get(),
    deps.db.collection('escrows')
      .where('recipient_wallet_id', '==', walletId)
      .where('status', 'in', ['completed', 'resolved'])
      .get(),
  ]);
  const hasRealCounterparty = (d: EscrowDocument): boolean =>
    d.depositor_wallet_id !== d.recipient_wallet_id;
  const completedEscrows =
    asDepositor.docs.filter(x => hasRealCounterparty(x.data() as EscrowDocument)).length +
    asRecipient.docs.filter(x => hasRealCounterparty(x.data() as EscrowDocument)).length;
  if (completedEscrows < SAFETY_LIMITS.COURT_MIN_COMPLETED_ESCROWS) {
    throw new ValidationError(
      `Must have at least ${SAFETY_LIMITS.COURT_MIN_COMPLETED_ESCROWS} completed escrows with a real counterparty (current: ${completedEscrows})`,
    );
  }

  // Criteria 2 & 3 — read the SAME live standing facts the presentation
  // vocabulary uses : adverse events (always present) and active-bond
  // status. No governance signal, no stored PE tally.
  // item 2 (Unknown = Block): a standing source that cannot be read DENIES the seat — the
  // vocabulary throws rather than reading a failure as a clean zero.
  let facts: Awaited<ReturnType<typeof computeActorVocabulary>>;
  try {
    facts = await computeActorVocabulary(
      { db: deps.db },
      { kind: 'agent', walletId, peOwnerUserId: wallet.agent_id, address: wallet.address },
    );
  } catch (err) {
    if (err instanceof VocabularyUnavailableError) {
      throw new ValidationError(
        `Standing could not be read (source: ${err.source}); the arbitrator seat is denied until it can be`,
      );
    }
    throw err;
  }

  // Criterion 2 — clean standing (zero adverse events, defaults included).
  const adverseEvents = facts['standing.adverse_events'] ?? 0;
  if (adverseEvents !== 0) {
    throw new ValidationError(
      `Clean standing required: ${adverseEvents} adverse event(s) on record`,
    );
  }

  // Criterion 3 — an active bond (arbitrators are slashable).
  if ((facts['standing.bond_active'] ?? 0) !== 1) {
    throw new ValidationError('An active bond is required to serve as an arbitrator');
  }

  const now = Date.now();
  const existing = await deps.db.collection('arbitrators').doc(walletId).get();

  const doc: ArbitratorDocument = {
    wallet_id: walletId,
    address: wallet.address,
    agent_id: wallet.agent_id,
    is_active: true,
    completed_escrows: completedEscrows,
    opted_in_at: existing.exists ? (existing.data() as ArbitratorDocument).opted_in_at : now,
    total_cases: existing.exists ? (existing.data() as ArbitratorDocument).total_cases : 0,
    majority_votes: existing.exists ? (existing.data() as ArbitratorDocument).majority_votes : 0,
    minority_votes: existing.exists ? (existing.data() as ArbitratorDocument).minority_votes : 0,
    updated_at: now,
  };

  await deps.db.collection('arbitrators').doc(walletId).set(doc);
  return doc;
}

/**
 * Agent opts out of arbitration.
 */
export async function optOutAsArbitrator(
  deps: AgentBankDeps,
  walletId: string,
): Promise<void> {
  const existing = await deps.db.collection('arbitrators').doc(walletId).get();
  if (!existing.exists) throw new NotFoundError('Arbitrator record not found');

  await deps.db.collection('arbitrators').doc(walletId).update({
    is_active: false,
    updated_at: Date.now(),
  });
}

/**
 * List all active arbitrators.
 */
export async function listArbitrators(
  deps: AgentBankDeps,
): Promise<ArbitratorDocument[]> {
  const snapshot = await deps.db.collection('arbitrators')
    .where('is_active', '==', true)
    .get();
  return snapshot.docs.map(d => d.data() as ArbitratorDocument);
}

// =========================================================================
// Panel assignment & voting
// =========================================================================

/**
 * Select 3 random arbitrators and assign them to a disputed escrow.
 * Excludes the escrow parties. Requires >= 15 active arbitrators.
 */
export async function selectAndAssignPanel(
  deps: AgentBankDeps,
  escrowId: string,
): Promise<CourtDisputeDocument> {
  // Verify escrow exists and is disputed
  const escrowDoc = await deps.db.collection('escrows').doc(escrowId).get();
  if (!escrowDoc.exists) throw new NotFoundError('Escrow not found');
  const escrow = escrowDoc.data() as EscrowDocument;
  if (escrow.status !== 'disputed') {
    throw new ValidationError(`Escrow status is ${escrow.status}, expected disputed`);
  }

  // Get eligible arbitrators (active, excluding escrow parties)
  const allArbitrators = await listArbitrators(deps);
  const eligible = allArbitrators.filter(
    a => a.wallet_id !== escrow.depositor_wallet_id &&
         a.wallet_id !== escrow.recipient_wallet_id,
  );

  if (eligible.length < SAFETY_LIMITS.COURT_MIN_ARBITRATORS) {
    throw new ValidationError(
      `Need at least ${SAFETY_LIMITS.COURT_MIN_ARBITRATORS} eligible arbitrators (have ${eligible.length})`,
    );
  }

  // Fisher-Yates shuffle for unbiased random selection
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  const panel = eligible.slice(0, SAFETY_LIMITS.COURT_PANEL_SIZE);

  const now = Date.now();
  const votingDeadline = now + SAFETY_LIMITS.COURT_VOTING_WINDOW_HOURS * 60 * 60 * 1000;

  const disputeDoc: CourtDisputeDocument = {
    escrow_id: escrowId,
    // Wave J-bis: capture chain from the linked escrow at dispute
    // creation so castVote can resolve the right Court contract
    // address without an extra Firestore read on every vote. Falls
    // back to 'base' for legacy escrow docs that predate the multi-
    // chain rollout.
    chain: escrow.chain || 'base',
    panel: panel.map(a => a.wallet_id),
    panel_addresses: panel.map(a => a.address),
    votes: {},
    voting_deadline: votingDeadline,
    status: 'pending',
    created_at: now,
    updated_at: now,
    pe_ids: [],
  };

  // agent directory: the panel-assignment record enters the machine (court_dispute
  // INITIAL→pending, record-only; system path,). Unknown = Block: an
  // undeclared edge never writes a panel record.
  assertSystemRecordTransition('court_dispute', INITIAL, 'pending');

  // Phase 2.13 - Theme 8: claim the dispute slot in a transaction so two
  // concurrent assignment calls cannot both believe the slot is empty
  // and write competing panels. The existence check + write must run
  // atomically.
  const disputeRef = deps.db.collection('court_disputes').doc(escrowId);
  await deps.db.runTransaction(async (tx) => {
    const fresh = await tx.get(disputeRef);
    if (fresh.exists) {
      throw new ValidationError('Court dispute already assigned for this escrow');
    }
    tx.set(disputeRef, disputeDoc);
  });

  // Update arbitrator case counts
  const { FieldValue } = await import('firebase-admin/firestore');
  for (const arb of panel) {
    await deps.db.collection('arbitrators').doc(arb.wallet_id).update({
      total_cases: FieldValue.increment(1),
      updated_at: now,
    });
  }

  // Generate PEs for panel assignment (one per arbitrator)
  const peIds: string[] = [];
  for (const arb of panel) {
    const { peId } = await generatePE(deps, {
      walletId: arb.wallet_id,
      agentId: arb.agent_id,
      actorAddress: arb.address,
      actionType: 'court_panel_assigned',
      metadata: {
        escrow_id: escrowId,
        amount_usdc: escrow.amount_usdc,
        panel_size: SAFETY_LIMITS.COURT_PANEL_SIZE,
        voting_deadline: votingDeadline,
      },
    });
    peIds.push(peId);
  }

  disputeDoc.pe_ids = peIds;
  await deps.db.collection('court_disputes').doc(escrowId).update({ pe_ids: peIds });

  return disputeDoc;
}

/**
 * Panel member casts their vote on a disputed escrow.
 * On 2-vote majority, resolves the escrow and generates verdict PEs.
 *
 * Phase 2.15 (D3-C-4): the relay accepts the vote in Firestore as the
 * tier-1 source of truth. If the arbitrator's SDK has already submitted
 * the on-chain CourtV2.castVote() and provides the resulting tx_hash,
 * the relay verifies the tx via the on-chain tx-verifier and marks the
 * vote `confirmed`. Otherwise the vote enters `pending_chain` state and
 * the SDK is expected to follow up with the on-chain submission. The
 * vote counts toward the majority either way - the on-chain attestation
 * is for tamper-evidence after the fact, not gating.
 *
 * The relay never holds arbitrator private keys (post-Phase 2.8) so it
 * cannot self-submit the on-chain vote. A future contract deployment
 * with EIP-712 meta-transactions would let the relay relay signed votes;
 * until then the SDK posts the tx_hash back here for verification.
 */
export async function castVote(
  deps: AgentBankDeps,
  escrowId: string,
  walletId: string,
  actingWallet: AgentWalletDocument,
  releaseToRecipient: boolean,
  txHash?: string,
): Promise<CourtDisputeDocument> {
  // agent directory: the machine gate runs FIRST — suspension check before any I/O. The vote's
  // nominal target is the dispute's economic pending→resolved edge (a vote is
  // what can complete the majority); receipt_required passes through and the
  // authoritative receipt-gated evaluation runs at the resolution claim below.
  assertCourtTransitionIntent(actingWallet, 'court_dispute', 'pending', 'resolved', 'Court vote is not a legal transition');

  const disputeRef = deps.db.collection('court_disputes').doc(escrowId);
  const disputeDoc = await disputeRef.get();
  if (!disputeDoc.exists) throw new NotFoundError('Court dispute not found');

  // If the SDK supplied a tx_hash, verify it on-chain BEFORE the
  // Firestore transaction. We don't want to hold a Firestore txn open
  // during an RPC round-trip.
  let voteRecord: CourtVoteRecord = {
    release_to_recipient: releaseToRecipient,
    cast_at: Date.now(),
    status: txHash ? 'pending_chain' : 'pending_chain',
  };

  // Wave J-bis: prefer the dispute's own chain field (captured at panel
  // assignment from the linked escrow). Fall back to a one-shot escrow
  // read for legacy dispute docs that predate the field. Final fallback
  // to 'base' covers single-chain deployments and the (very narrow)
  // case of a dispute whose escrow doc has been deleted - e.g. the
  // jobs.ts rollback path on assignment failure, which can't reach
  // court flows but is defended against here for resilience.
  const existingDispute = disputeDoc.data() as CourtDisputeDocument;
  let voteChain: AgentBankChain = 'base';
  if (existingDispute.chain) {
    const candidate = existingDispute.chain as AgentBankChain;
    assertSupportedAgentBankChain(candidate);
    voteChain = candidate;
  } else {
    try {
      const escrowSnap = await deps.db.collection('escrows').doc(escrowId).get();
      if (escrowSnap.exists) {
        const escrowData = escrowSnap.data() as EscrowDocument;
        const candidate = (escrowData.chain || 'base') as AgentBankChain;
        assertSupportedAgentBankChain(candidate);
        voteChain = candidate;
      }
    } catch {
      // Defensive: keep Base default rather than blocking the vote on
      // a chain-resolution failure. The verification result will
      // surface a clear reason if the chain is genuinely wrong.
    }
  }
  const courtContractAddress = courtAddressForChain(voteChain);
  if (txHash && courtContractAddress) {
    const verification = await verifyEvmContractCall({
      chainId: chainIdForName(voteChain),
      txHash,
      expectedContract: courtContractAddress,
    });
    if (verification.ok) {
      voteRecord = {
        ...voteRecord,
        status: 'confirmed',
        tx_hash: txHash,
        block_number: verification.blockNumber ?? null,
      };
    } else {
      voteRecord = {
        ...voteRecord,
        status: 'failed',
        tx_hash: txHash,
        failure_reason: verification.reason,
      };
    }
  }

  // Use Firestore transaction to atomically check deadline + double-vote + write
  const now = Date.now();
  const dispute = await deps.db.runTransaction(async (txn) => {
    const freshDoc = await txn.get(disputeRef);
    if (!freshDoc.exists) throw new NotFoundError('Court dispute not found');
    const d = freshDoc.data() as CourtDisputeDocument;

    if (d.status !== 'pending') {
      throw new ValidationError(`Dispute status is ${d.status}, expected pending`);
    }
    if (now > d.voting_deadline) {
      throw new ValidationError('Voting deadline has passed');
    }
    if (!d.panel.includes(walletId)) {
      throw new ForbiddenError('Not a panel member for this dispute');
    }
    if (d.votes[walletId] !== undefined) {
      throw new ValidationError('Already voted on this dispute');
    }

    txn.update(disputeRef, {
      [`votes.${walletId}`]: voteRecord,
      updated_at: now,
    });

    d.votes[walletId] = voteRecord;
    return d;
  });

  // Get voter wallet for PE
  const voterWalletDoc = await deps.db.collection('agent_wallets').doc(walletId).get();
  const voter = voterWalletDoc.data() as AgentWalletDocument;

  await generatePE(deps, {
    walletId,
    agentId: voter.agent_id,
    actorAddress: voter.address,
    actionType: 'court_vote_cast',
    metadata: {
      escrow_id: escrowId,
      release_to_recipient: releaseToRecipient,
      // §2.12: a vote whose castVote tx the relay re-checked on-chain is verified; a
      // pending/failed one records as the arbitrator's own claim.
      ...(voteRecord.status === 'confirmed' && typeof voteRecord.tx_hash === 'string'
        ? {
          verified: true,
          tx_hash: voteRecord.tx_hash,
          block_number: voteRecord.block_number ?? null,
          chain_id: chainIdForName(voteChain),
        }
        : {}),
    },
  });

  // Check for majority. Vote records carry both the boolean and the chain-sync
  // status. Pass-3 #15: EXCLUDE votes whose on-chain castVote reverted
  // (status:'failed' — NotPanelMember/AlreadyVoted/VotingClosed, or a
  // wrong-contract / wrong-sender tx the verifier rejected via tx_failed). The
  // prior filter read ONLY the boolean, so a chain-REJECTED vote was still
  // tallied toward the 2-of-3 majority and could finalize an irreversible
  // verdict + court_verdict PEs partly on a vote the chain refused — the comment
  // claimed "any non-failed vote counts" but the code never enforced it. A vote
  // with no tx_hash stays 'pending_chain' and still counts (on-chain attestation
  // is after-the-fact tamper-evidence, not gating); only an explicitly
  // on-chain-FAILED vote is dropped.
  const countedVotes = Object.values(dispute.votes).filter(v => v.status !== 'failed');
  const votesForRelease = countedVotes.filter(v => v.release_to_recipient === true).length;
  const votesForRefund = countedVotes.filter(v => v.release_to_recipient === false).length;

  if (votesForRelease >= 2 || votesForRefund >= 2) {
    const verdict = votesForRelease >= 2; // true = release_to_recipient

    // Pass-3 #1 (CRITICAL): the escrow must be SETTLED ON-CHAIN before the relay
    // records the verdict. The on-chain resolution is driven by the arbitrators'
    // on-chain CourtV2.castVote (the majority vote calls escrowContract.resolveDispute
    // in the same tx); the relay OBSERVES it here (settleDispute → already_resolved)
    // and only then flips Firestore + emits court_verdict PEs. Fail-closed: if the
    // on-chain escrow is not yet Resolved, DON'T record a verdict — the dispute
    // stays 'pending' and escalates at its voting deadline (processCourtDeadlines)
    // rather than declaring on both parties' hash chains a payout that never moved.
    const escrowDoc = await deps.db.collection('escrows').doc(escrowId).get();
    if (!escrowDoc.exists) {
      console.warn(`[Court] Escrow ${escrowId} not found; cannot settle verdict on-chain — leaving dispute pending.`);
      return dispute;
    }
    const escrow = escrowDoc.data() as EscrowDocument;

    const settle: EscrowDisputeSettleResult = deps.escrowChain
      ? await deps.escrowChain.settleDispute(escrow, verdict)
      : { status: 'unconfigured' };
    if (settle.status !== 'resolved' && settle.status !== 'already_resolved') {
      console.warn(
        `[Court] Dispute ${escrowId} reached a ${votesForRelease}-${votesForRefund} Firestore majority but the ` +
          `on-chain escrow is not settled (${settle.status}${settle.reason ? `: ${settle.reason}` : ''}); ` +
          `leaving the dispute 'pending' (no verdict PEs, no escrow flip) until the on-chain resolution is confirmed or it escalates.`,
      );
      return dispute;
    }
    // agent directory: the settlement tx hash IS the receipt/idempotency anchor for the
    // economic pending→resolved transition. settleDispute returns it on both
    // the driven ('resolved') and observe ('already_resolved') paths; if it is
    // ever absent, fail closed — leave the dispute pending for a later retry
    // rather than record an evidence-free verdict.
    const resolutionTxHash = settle.txHash;
    if (!resolutionTxHash) {
      console.warn(
        `[Court] Dispute ${escrowId} settled on-chain but no settlement tx hash was recovered; ` +
          `leaving the dispute 'pending' (no verdict PEs) until a receipt-bearing observation.`,
      );
      return dispute;
    }
    // Record the ACTUAL on-chain resolution direction (recovered from the
    // EscrowResolved event), which can diverge from the Firestore tally — the
    // on-chain CourtV2 vote / claimDisputeTimeout is authoritative for the payout.
    const onchainVerdict = settle.resolvedReleaseToRecipient ?? verdict;
    const resolutionReceipt: ReceiptEvidence = { ok: true, txHash: resolutionTxHash };

    // Pass-3 review (LOW): claim the dispute pending→resolved transition
    // transactionally so two arbitrator votes landing concurrently can't BOTH
    // record the verdict (duplicate court_verdict PEs + double arbitrator credit).
    // agent directory: the claim txn now (1) runs the authoritative receipt-gated machine
    // evaluation on the FRESH dispute status (court_dispute pending→resolved,
    // economic — Base-final settlement receipt required, idempotent by the
    // resolution tx hash), and (2) folds the escrow's own disputed→resolved
    // flip into the SAME atomic txn behind the SAME receipt, so the verdict
    // record and the escrow settlement record can never diverge.
    const escrowRef = deps.db.collection('escrows').doc(escrowId);
    let claimedResolution = false;
    await deps.db.runTransaction(async (txn) => {
      const fresh = await txn.get(disputeRef);
      const freshEscrow = await txn.get(escrowRef);
      if (!fresh.exists) return;
      const freshDispute = fresh.data() as CourtDisputeDocument;
      if (freshDispute.status !== 'pending') return; // already recorded

      assertCourtEconomicTransition({
        kind: 'court_dispute',
        from: freshDispute.status,
        to: 'resolved',
        receipt: resolutionReceipt,
        priorEconomicTxHashes: freshDispute.resolution_tx_hash ? [freshDispute.resolution_tx_hash] : [],
        killSwitchActive: actingWallet.status !== 'active',
      });

      txn.update(disputeRef, {
        status: 'resolved',
        verdict: onchainVerdict,
        resolution_tx_hash: resolutionTxHash.toLowerCase(),
        updated_at: now,
      });

      // Escrow disputed→resolved rides the same verified settlement receipt.
      // If another path (admin resolveDispute) already flipped it, skip — the
      // on-chain escrow is terminal either way and the flip is idempotent.
      if (freshEscrow.exists) {
        const fe = freshEscrow.data() as EscrowDocument;
        if (fe.status === 'disputed') {
          assertCourtEconomicTransition({
            kind: 'escrow',
            from: 'disputed',
            to: 'resolved',
            receipt: resolutionReceipt,
            priorEconomicTxHashes: fe.resolution_tx_hash ? [fe.resolution_tx_hash] : [],
            killSwitchActive: actingWallet.status !== 'active',
          });
          txn.update(escrowRef, {
            status: 'resolved',
            resolution: onchainVerdict ? 'release_to_recipient' : 'refund_to_depositor',
            resolution_reason: `Court verdict: ${votesForRelease}-${votesForRefund}`,
            resolved_at: now,
            resolution_tx_hash: resolutionTxHash.toLowerCase(),
            updated_at: now,
          });
        }
      }
      claimedResolution = true;
    });
    if (!claimedResolution) return dispute; // a concurrent castVote already recorded the verdict
    dispute.status = 'resolved';
    dispute.verdict = onchainVerdict;

    const [depositorDoc, recipientDoc] = await Promise.all([
      deps.db.collection('agent_wallets').doc(escrow.depositor_wallet_id).get(),
      deps.db.collection('agent_wallets').doc(escrow.recipient_wallet_id).get(),
    ]);
    const depositor = depositorDoc.data() as AgentWalletDocument;
    const recipient = recipientDoc.data() as AgentWalletDocument;

    // Verdict PEs for both escrow parties
    await generatePE(deps, {
      walletId: escrow.depositor_wallet_id,
      agentId: depositor.agent_id,
      actorAddress: depositor.address,
      actionType: 'court_verdict',
      metadata: {
        escrow_id: escrowId,
        verdict: onchainVerdict ? 'release_to_recipient' : 'refund_to_depositor',
        votes_for_release: votesForRelease,
        votes_for_refund: votesForRefund,
        role: 'depositor',
        // §2.12: sealed behind the on-chain settlement receipt → verified.
        verified: true,
        tx_hash: resolutionTxHash.toLowerCase(),
        chain_id: chainIdForName(voteChain),
      },
      counterpartyAddress: recipient.address,
    });

    await generatePE(deps, {
      walletId: escrow.recipient_wallet_id,
      agentId: recipient.agent_id,
      actorAddress: recipient.address,
      actionType: 'court_verdict',
      metadata: {
        escrow_id: escrowId,
        verdict: onchainVerdict ? 'release_to_recipient' : 'refund_to_depositor',
        votes_for_release: votesForRelease,
        votes_for_refund: votesForRefund,
        role: 'recipient',
        verified: true,
        tx_hash: resolutionTxHash.toLowerCase(),
        chain_id: chainIdForName(voteChain),
      },
      counterpartyAddress: depositor.address,
    });

    // PEs for arbitrators (majority bonus or minority vote)
    const { FieldValue } = await import('firebase-admin/firestore');
    for (const panelWalletId of dispute.panel) {
      const panelVote = dispute.votes[panelWalletId];
      if (panelVote === undefined) continue; // Didn't vote
      // Pass-3 #15: a chain-REJECTED vote is not a real vote — it earns neither a
      // majority bonus nor a minority-vote credit (consistent with excluding it
      // from the tally above).
      if (panelVote.status === 'failed') continue;

      const panelVoteBool = panelVote.release_to_recipient;
      const isInMajority = panelVoteBool === onchainVerdict;
      const arbWalletDoc = await deps.db.collection('agent_wallets').doc(panelWalletId).get();
      if (!arbWalletDoc.exists) continue;
      const arbWallet = arbWalletDoc.data() as AgentWalletDocument;

      await generatePE(deps, {
        walletId: panelWalletId,
        agentId: arbWallet.agent_id,
        actorAddress: arbWallet.address,
        actionType: isInMajority ? 'court_majority_bonus' : 'court_minority_vote',
        metadata: {
          escrow_id: escrowId,
          verdict: onchainVerdict ? 'release_to_recipient' : 'refund_to_depositor',
          own_vote: panelVoteBool ? 'release' : 'refund',
        },
      });

      // Update arbitrator stats
      await deps.db.collection('arbitrators').doc(panelWalletId).update({
        [isInMajority ? 'majority_votes' : 'minority_votes']: FieldValue.increment(1),
        updated_at: now,
      });

      await updateWalletStats(deps, panelWalletId, 0);
    }

    // agent directory: the escrow's disputed→resolved flip now lands INSIDE the claim
    // transaction above, behind the same verified settlement receipt — no
    // trailing non-transactional escrow update remains on this path.
  }

  return dispute;
}

// =========================================================================
// Scheduler: deadline processing
// =========================================================================

/**
 * Process expired court disputes - set to 'escalated'.
 * Called by Cloud Scheduler.
 */
export async function processCourtDeadlines(
  deps: AgentBankDeps,
): Promise<number> {
  const now = Date.now();
  const snapshot = await deps.db.collection('court_disputes')
    .where('status', '==', 'pending')
    .where('voting_deadline', '<=', now)
    .limit(100)
    .get();

  let processed = 0;

  // Pre-load all unique panel member wallets to avoid N+1 queries
  const allPanelWalletIds = new Set<string>();
  for (const doc of snapshot.docs) {
    const dispute = doc.data() as CourtDisputeDocument;
    for (const wid of dispute.panel) {
      allPanelWalletIds.add(wid);
    }
  }

  const walletCache = new Map<string, AgentWalletDocument>();
  const walletIds = [...allPanelWalletIds];
  // Firestore 'in' queries limited to 30 items per batch
  for (let i = 0; i < walletIds.length; i += 30) {
    const batch = walletIds.slice(i, i + 30);
    const walletSnap = await deps.db.collection('agent_wallets')
      .where('__name__', 'in', batch)
      .get();
    for (const wDoc of walletSnap.docs) {
      walletCache.set(wDoc.id, wDoc.data() as AgentWalletDocument);
    }
  }

  for (const doc of snapshot.docs) {
    try {
      const dispute = doc.data() as CourtDisputeDocument;

      // Idempotency: skip if already escalated by a concurrent scheduler run
      if (dispute.status !== 'pending') continue;

      // agent directory: pending→escalated through the machine (record-only appeal lane;
      // system path,). Unknown = Block.
      assertSystemRecordTransition('court_dispute', dispute.status, 'escalated');

      await doc.ref.update({
        status: 'escalated',
        updated_at: now,
      });

      // Generate escalation PEs for panel members (using pre-loaded cache)
      for (const panelWalletId of dispute.panel) {
        const wallet = walletCache.get(panelWalletId);
        if (!wallet) continue;

        await generatePE(deps, {
          walletId: panelWalletId,
          agentId: wallet.agent_id,
          actorAddress: wallet.address,
          actionType: 'court_escalated',
          metadata: {
            escrow_id: dispute.escrow_id,
            reason: 'voting_deadline_expired',
          },
        });
      }

      processed++;
      console.log(`[Scheduler] Escalated court dispute for escrow ${dispute.escrow_id}`);
    } catch (err) {
      console.error(`[Scheduler] Court deadline error for ${doc.id}:`, err);
    }
  }

  return processed;
}

// =========================================================================
// Read operations
// =========================================================================

export async function getDispute(
  deps: AgentBankDeps,
  escrowId: string,
): Promise<CourtDisputeDocument> {
  const snapshot = await deps.db.collection('court_disputes').doc(escrowId).get();
  if (!snapshot.exists) throw new NotFoundError('Court dispute not found');
  return snapshot.data() as CourtDisputeDocument;
}

export async function getArbitratorHistory(
  deps: AgentBankDeps,
  walletId: string,
): Promise<{ arbitrator: ArbitratorDocument; disputes: CourtDisputeDocument[] }> {
  const arbDoc = await deps.db.collection('arbitrators').doc(walletId).get();
  if (!arbDoc.exists) throw new NotFoundError('Arbitrator not found');

  const arbitrator = arbDoc.data() as ArbitratorDocument;

  // Find disputes where this wallet is on the panel
  const snapshot = await deps.db.collection('court_disputes')
    .where('panel', 'array-contains', walletId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .get();

  const disputes = snapshot.docs.map(d => d.data() as CourtDisputeDocument);
  return { arbitrator, disputes };
}

// =========================================================================
// General Disputes (Court Mandate Expansion)
// =========================================================================

/**
 * File a general dispute (not escrow-specific). Any PE-attested action
 * where a counterparty has a grievance is Court-eligible.
 */
export async function fileGeneralDispute(
  deps: AgentBankDeps,
  params: {
    filedBy: string;
    respondent: string;
    subjectPeIds: string[];
    description: string;
    requestedRemedy: string;
    /**
     * agent directory: the acting wallet document, passed by the wired routes (the auth
     * middleware already holds it) so the suspension-check-first machine gate runs
     * BEFORE any I/O. Internal callers that only hold the wallet id may omit
     * it — the same gate then runs on the filer wallet doc immediately after
     * its first read, still before any further read or write.
     */
    actingWallet?: AgentWalletDocument;
    /**
     * When set, this dispute escalates a filed bond claim to the Court. agent directory:
     * on panel resolution the verdict is recorded as a RECORD-ONLY Court
     * FINDING on the claim; the claim's status flip rides only the
     * receipt-gated resolveBondClaim() bridge on a verified Base-final
     * settlement (the on-chain event decides the verdict). The claim must be
     * 'filed', owned by the filer, and against the named respondent.
     */
    bondClaimId?: string;
    /**
     * P4-09: when set, this dispute escalates a Commons forum challenge. On
     * panel resolution the mapped verdict drives resolveChallenge() so the
     * challenge transitions upheld/dismissed. Set by escalateChallengeToCourt;
     * the challenge back-references the returned disputeId as court_dispute_id.
     */
    challengeId?: string;
    /**
     * PE METER: proofs for subject PEs the relay no longer keeps (older than the 31-day act key,
     * not an identity act) — the PE body plus its inclusion proof, keyed by the cited id. See
     * `core/meter/cited-act.ts`.
     */
    subjectPeProofs?: ReadonlyMap<string, PresentedPeProof>;
    /** Test seam: the PEAnchor read contract presented proofs verify against (default: Base). */
    anchorContract?: CitedActDeps['anchorContract'];
  },
): Promise<{ disputeId: string }> {
  // agent directory: machine gate FIRST when the route supplied the acting wallet — the
  // suspension check before ANY I/O (general_dispute INITIAL→filed, record-only).
  if (params.actingWallet) {
    assertCourtTransitionIntent(params.actingWallet, 'general_dispute', INITIAL, 'filed', 'Dispute filing is not a legal transition');
  }

  // Validate wallet exists and has standing
  const walletDoc = await deps.db.collection('agent_wallets').doc(params.filedBy).get();
  if (!walletDoc.exists) throw new NotFoundError('Complainant wallet not found');
  const wallet = walletDoc.data() as AgentWalletDocument;

  // agent directory: for internal callers without the wallet doc in hand, the same gate
  // runs on the freshly-read filer wallet — still before any further I/O.
  if (!params.actingWallet) {
    assertCourtTransitionIntent(wallet, 'general_dispute', INITIAL, 'filed', 'Dispute filing is not a legal transition');
  }

  // The governance-score filing gate is removed: no eligibility path
  // reads a governance signal. Filing is bounded by the self-dispute check and
  // MAX_OPEN_DISPUTES_PER_WALLET below; Court itself stays deferred.

  // Check respondent exists
  const respondentDoc = await deps.db.collection('agent_wallets').doc(params.respondent).get();
  if (!respondentDoc.exists) throw new NotFoundError('Respondent wallet not found');

  // Cannot dispute yourself
  if (params.filedBy === params.respondent) {
    throw new ValidationError('Cannot file a dispute against yourself');
  }

  // Validate subject PE IDs
  if (!params.subjectPeIds.length || params.subjectPeIds.length > SAFETY_LIMITS.MAX_SUBJECT_PE_IDS) {
    throw new ValidationError(`Must provide 1-${SAFETY_LIMITS.MAX_SUBJECT_PE_IDS} subject PE IDs`);
  }

  // Verify each subject PE exists and the complainant was a party.
  //
  // PE METER: the relay keeps no PE. A subject resolves from its 31-day act key (identifier
  // facts: user_id, wallet_id, counterparty_address), an identity act, or — older than that — the
  // PE + inclusion proof the complainant presents (`cited-act.ts`). All three carry the three
  // identity fields the standing clauses read.
  for (const peId of params.subjectPeIds) {
    const pe = await citedActOrThrow(deps, peId, params.subjectPeProofs, params.anchorContract);
    // Complainant must be the author or counterparty. counterparty_address may
    // be stored in ANY case (it's client-supplied at PE-record time), while
    // wallet.address is lowercase — compare case-insensitively so a legitimate
    // counterparty recorded checksummed is not wrongly denied standing.
    const counterpartyAddr = pe.counterparty_address !== null ? pe.counterparty_address.toLowerCase() : null;
    const isParty = pe.user_id === wallet.agent_id ||
      pe.wallet_id === params.filedBy ||
      (counterpartyAddr !== null && counterpartyAddr === wallet.address.toLowerCase());
    if (!isParty) {
      throw new ForbiddenError(`Complainant has no standing on PE ${peId}`);
    }
  }

  // Check max open disputes per wallet
  const openDisputes = await deps.db.collection('general_disputes')
    .where('filed_by', '==', params.filedBy)
    .where('status', 'in', ['filed', 'panel_assigned', 'evidence_period', 'voting'])
    .get();

  if (openDisputes.size >= SAFETY_LIMITS.MAX_OPEN_DISPUTES_PER_WALLET) {
    throw new ValidationError(
      `Maximum ${SAFETY_LIMITS.MAX_OPEN_DISPUTES_PER_WALLET} open disputes per wallet`,
    );
  }

  // Validate description and remedy
  if (!params.description || params.description.length > 2000) {
    throw new ValidationError('Description is required and must be under 2000 characters');
  }
  if (!params.requestedRemedy || params.requestedRemedy.length > 1000) {
    throw new ValidationError('Requested remedy is required and must be under 1000 characters');
  }

  // Optional bond-claim escalation: this dispute will drive the claim's
  // resolution on verdict. Validate the link so a dispute can only resolve a
  // claim the filer actually owns, against the same respondent, that is still
  // open. (The claim's respondent is its bonded agent's wallet.)
  if (params.bondClaimId) {
    const claimSnap = await deps.db.collection('bond_claims').doc(params.bondClaimId).get();
    if (!claimSnap.exists) throw new NotFoundError(`Bond claim not found: ${params.bondClaimId}`);
    const claim = claimSnap.data() as BondClaimDocument;
    if (claim.status !== 'filed') {
      throw new ValidationError(`Bond claim is not in filed state (status: ${claim.status})`);
    }
    if (claim.claimant_wallet_id !== params.filedBy) {
      throw new ForbiddenError('Only the bond claimant can escalate their claim to the Court');
    }
    if (claim.respondent_wallet_id !== params.respondent) {
      throw new ValidationError('Dispute respondent must match the bond claim respondent');
    }
    if (claim.general_dispute_id) {
      throw new ValidationError('Bond claim already escalated to a Court dispute');
    }
  }

  const now = Date.now();
  const disputeId = `gd_${uuidv4()}`;

  const disputeDoc: GeneralDisputeDocument = {
    dispute_id: disputeId,
    filed_by: params.filedBy,
    respondent: params.respondent,
    subject_pe_ids: params.subjectPeIds,
    description: params.description,
    requested_remedy: params.requestedRemedy,
    evidence_pe_ids: [],
    status: 'filed',
    pe_ids: [],
    created_at: now,
    updated_at: now,
    filed_at: now,
    ...(params.bondClaimId ? { bond_claim_id: params.bondClaimId } : {}),
    ...(params.challengeId ? { challenge_id: params.challengeId } : {}),
  };

  await deps.db.collection('general_disputes').doc(disputeId).set(disputeDoc);

  // Back-reference the dispute on the claim so the link is discoverable from
  // either side and a second escalation is blocked by the check above.
  if (params.bondClaimId) {
    await deps.db.collection('bond_claims').doc(params.bondClaimId).update({
      general_dispute_id: disputeId,
      updated_at: now,
    });
  }

  // Generate filing PE (complainant's chain, respondent as counterparty)
  const respondentWallet = respondentDoc.data() as AgentWalletDocument;
  const { peId } = await generatePE(deps, {
    walletId: params.filedBy,
    agentId: wallet.agent_id,
    actorAddress: wallet.address,
    actionType: 'court_general_dispute_filed',
    metadata: {
      dispute_id: disputeId,
      respondent: params.respondent,
      subject_pe_count: params.subjectPeIds.length,
      description_preview: params.description.substring(0, 100),
      role: 'complainant',
    },
    counterpartyAddress: respondentWallet.address,
  });

  // agent directory — NOTICE: the respondent's OWN hash chain carries the dispute filing
  // (the linked-job settlement dual-party PE pattern). Notice of a Court process is provenance
  // truth for the party who must answer it, not just for the filer. Best-effort
  // after the filing PE: a notice failure never unwinds the filed dispute.
  const peIds = [peId];
  try {
    const { peId: noticePeId } = await generatePE(deps, {
      walletId: params.respondent,
      agentId: respondentWallet.agent_id,
      actorAddress: respondentWallet.address,
      actionType: 'court_general_dispute_filed',
      metadata: {
        dispute_id: disputeId,
        filed_by: params.filedBy,
        subject_pe_count: params.subjectPeIds.length,
        description_preview: params.description.substring(0, 100),
        role: 'respondent',
        notice: true,
      },
      counterpartyAddress: wallet.address,
    });
    peIds.push(noticePeId);
  } catch (err) {
    console.warn(`[Court] Respondent notice PE failed for dispute ${disputeId}:`, err);
  }

  await deps.db.collection('general_disputes').doc(disputeId).update({
    pe_ids: peIds,
  });

  return { disputeId };
}

/**
 * Submit additional PE evidence during evidence period.
 * Only parties to the dispute can submit evidence.
 */
export async function submitEvidence(
  deps: AgentBankDeps,
  params: {
    disputeId: string;
    submittedBy: string;
    evidencePeIds: string[];
    /** agent directory: acting wallet from the route for the suspension-check-first guard. */
    actingWallet?: AgentWalletDocument;
    /** PE METER: proofs for evidence PEs the relay no longer keeps, keyed by the cited id. */
    evidencePeProofs?: ReadonlyMap<string, PresentedPeProof>;
    /** Test seam: the PEAnchor read contract presented proofs verify against (default: Base). */
    anchorContract?: CitedActDeps['anchorContract'];
  },
): Promise<void> {
  // agent directory: suspension check FIRST, before any I/O. Evidence submission is a record
  // operation WITHIN the 'evidence_period' state (no machine transition to
  // classify — the machine gates edges, not intra-state records), so the
  // suspension check is applied directly with the same ordering discipline.
  if (params.actingWallet && params.actingWallet.status !== 'active') {
    throw new ForbiddenError('Agent wallet is not active');
  }

  const disputeRef = deps.db.collection('general_disputes').doc(params.disputeId);
  const disputeDoc = await disputeRef.get();
  if (!disputeDoc.exists) throw new NotFoundError('General dispute not found');

  const dispute = disputeDoc.data() as GeneralDisputeDocument;

  // Only parties can submit evidence
  if (params.submittedBy !== dispute.filed_by && params.submittedBy !== dispute.respondent) {
    throw new ForbiddenError('Only dispute parties can submit evidence');
  }

  // Must be in evidence_period
  if (dispute.status !== 'evidence_period') {
    throw new ValidationError(`Cannot submit evidence in ${dispute.status} status`);
  }

  // Validate evidence PE IDs
  if (!params.evidencePeIds.length || params.evidencePeIds.length > SAFETY_LIMITS.MAX_EVIDENCE_PE_IDS) {
    throw new ValidationError(`Must provide 1-${SAFETY_LIMITS.MAX_EVIDENCE_PE_IDS} evidence PE IDs`);
  }

  // Verify each evidence PE exists: its act key, an identity act, or the presented PE + proof.
  for (const peId of params.evidencePeIds) {
    await citedActOrThrow(deps, peId, params.evidencePeProofs, params.anchorContract);
  }

  const combined = [...dispute.evidence_pe_ids, ...params.evidencePeIds];
  if (combined.length > SAFETY_LIMITS.MAX_EVIDENCE_PE_IDS) {
    throw new ValidationError(`Total evidence PE IDs cannot exceed ${SAFETY_LIMITS.MAX_EVIDENCE_PE_IDS}`);
  }

  const now = Date.now();
  await disputeRef.update({
    evidence_pe_ids: combined,
    updated_at: now,
  });

  // Generate evidence submission PE
  const walletDoc = await deps.db.collection('agent_wallets').doc(params.submittedBy).get();
  if (walletDoc.exists) {
    const wallet = walletDoc.data() as AgentWalletDocument;
    await generatePE(deps, {
      walletId: params.submittedBy,
      agentId: wallet.agent_id,
      actorAddress: wallet.address,
      actionType: 'court_evidence_submitted',
      metadata: {
        dispute_id: params.disputeId,
        evidence_pe_count: params.evidencePeIds.length,
      },
    });
  }
}

/**
 * Assign panel to a general dispute. Uses same arbitrator pool as escrow disputes.
 * Excludes dispute parties from panel.
 */
export async function assignGeneralDisputePanel(
  deps: AgentBankDeps,
  disputeId: string,
): Promise<GeneralDisputeDocument> {
  const disputeRef = deps.db.collection('general_disputes').doc(disputeId);
  const disputeDoc = await disputeRef.get();
  if (!disputeDoc.exists) throw new NotFoundError('General dispute not found');

  const dispute = disputeDoc.data() as GeneralDisputeDocument;
  if (dispute.status !== 'filed') {
    throw new ValidationError(`Dispute status is ${dispute.status}, expected filed`);
  }

  if (dispute.panel_wallet_ids?.length) {
    throw new ValidationError('Panel already assigned for this dispute');
  }

  // Get eligible arbitrators (active, excluding dispute parties)
  const allArbitrators = await listArbitrators(deps);
  const eligible = allArbitrators.filter(
    a => a.wallet_id !== dispute.filed_by &&
         a.wallet_id !== dispute.respondent,
  );

  if (eligible.length < SAFETY_LIMITS.COURT_MIN_ARBITRATORS) {
    throw new ValidationError(
      `Need at least ${SAFETY_LIMITS.COURT_MIN_ARBITRATORS} eligible arbitrators (have ${eligible.length})`,
    );
  }

  // Fisher-Yates shuffle for unbiased random selection
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  const panel = eligible.slice(0, SAFETY_LIMITS.COURT_PANEL_SIZE);

  const now = Date.now();
  const evidenceDeadline = now + SAFETY_LIMITS.GENERAL_DISPUTE_EVIDENCE_WINDOW_HOURS * 60 * 60 * 1000;

  const panelWalletIds = panel.map(a => a.wallet_id);

  // agent directory: claim the filed→evidence_period transition transactionally (two
  // concurrent assignment calls can no longer both write competing panels —
  // the same Theme-8 race selectAndAssignPanel already closed) and evaluate it
  // through the machine (record-only; system path,). Unknown = Block.
  assertSystemRecordTransition('general_dispute', 'filed', 'evidence_period');
  await deps.db.runTransaction(async (txn) => {
    const fresh = await txn.get(disputeRef);
    if (!fresh.exists) throw new NotFoundError('General dispute not found');
    const fd = fresh.data() as GeneralDisputeDocument;
    if (fd.status !== 'filed') {
      throw new ValidationError(`Dispute status is ${fd.status}, expected filed`);
    }
    if (fd.panel_wallet_ids?.length) {
      throw new ValidationError('Panel already assigned for this dispute');
    }
    txn.update(disputeRef, {
      status: 'evidence_period',
      panel_wallet_ids: panelWalletIds,
      evidence_deadline: evidenceDeadline,
      updated_at: now,
    });
  });

  // Update arbitrator case counts
  const { FieldValue } = await import('firebase-admin/firestore');
  for (const arb of panel) {
    await deps.db.collection('arbitrators').doc(arb.wallet_id).update({
      total_cases: FieldValue.increment(1),
      updated_at: now,
    });
  }

  // Generate PEs for panel assignment
  const peIds: string[] = [...(dispute.pe_ids || [])];
  for (const arb of panel) {
    const { peId } = await generatePE(deps, {
      walletId: arb.wallet_id,
      agentId: arb.agent_id,
      actorAddress: arb.address,
      actionType: 'court_panel_assigned',
      metadata: {
        dispute_id: disputeId,
        dispute_type: 'general',
        panel_size: SAFETY_LIMITS.COURT_PANEL_SIZE,
        evidence_deadline: evidenceDeadline,
      },
    });
    peIds.push(peId);
  }

  await disputeRef.update({ pe_ids: peIds });

  const updatedDoc = await disputeRef.get();
  return updatedDoc.data() as GeneralDisputeDocument;
}

/**
 * Cast vote on a general dispute.
 * When 2-vote majority is reached, resolves the dispute.
 */
export async function castGeneralDisputeVote(
  deps: AgentBankDeps,
  disputeId: string,
  walletId: string,
  actingWallet: AgentWalletDocument,
  resolution: GeneralDisputeResolution,
): Promise<GeneralDisputeDocument> {
  // agent directory: machine gate FIRST — suspension check before any I/O. The vote's nominal
  // target is the record-only voting→resolved edge (a vote is what can
  // complete the majority); the fresh-status evaluation runs at the
  // resolution claim below.
  assertCourtTransitionIntent(actingWallet, 'general_dispute', 'voting', 'resolved', 'General dispute vote is not a legal transition');

  const disputeRef = deps.db.collection('general_disputes').doc(disputeId);
  const now = Date.now();

  // agent directory: atomically check status + deadline + panel membership + double-vote
  // and write the vote — the escrow-dispute castVote shape. The prior
  // non-transactional check-then-update let two same-arbitrator votes race,
  // and never enforced the voting deadline at all (a vote landing after the
  // deadline but before the escalation tick was silently accepted).
  const dispute = await deps.db.runTransaction(async (txn) => {
    const freshDoc = await txn.get(disputeRef);
    if (!freshDoc.exists) throw new NotFoundError('General dispute not found');
    const d = freshDoc.data() as GeneralDisputeDocument;
    if (d.status !== 'voting') {
      throw new ValidationError(`Dispute status is ${d.status}, expected voting`);
    }
    if (typeof d.voting_deadline === 'number' && now > d.voting_deadline) {
      throw new ValidationError('Voting deadline has passed');
    }
    if (!d.panel_wallet_ids?.includes(walletId)) {
      throw new ForbiddenError('Not a panel member for this dispute');
    }
    if (d.votes?.[walletId]) {
      throw new ValidationError('Already voted on this dispute');
    }
    txn.update(disputeRef, {
      [`votes.${walletId}`]: resolution,
      updated_at: now,
    });
    d.votes = { ...(d.votes || {}), [walletId]: resolution };
    return d;
  });

  const votes = dispute.votes || {};

  // Get voter wallet for PE
  const voterWalletDoc = await deps.db.collection('agent_wallets').doc(walletId).get();
  const voter = voterWalletDoc.data() as AgentWalletDocument;

  await generatePE(deps, {
    walletId,
    agentId: voter.agent_id,
    actorAddress: voter.address,
    actionType: 'court_vote_cast',
    metadata: {
      dispute_id: disputeId,
      dispute_type: 'general',
      resolution_vote: resolution,
    },
  });

  // Check for majority (2 of 3 with same resolution)
  const voteCounts: Record<string, number> = {};
  for (const v of Object.values(votes)) {
    voteCounts[v] = (voteCounts[v] || 0) + 1;
  }

  const majorityResolution = Object.entries(voteCounts).find(([, count]) => count >= 2);

  if (majorityResolution) {
    const [finalResolution] = majorityResolution as [GeneralDisputeResolution, number];

    // agent directory: claim the voting→resolved transition TRANSACTIONALLY through the
    // machine (record-only edge — a general-dispute resolution moves no funds
    // itself; its money legs are gated on their own kinds below) so two
    // concurrent majority-completing votes can't BOTH record the verdict and
    // double-run the side effects (duplicate resolution PEs — the exact race the
    // escrow-dispute path closed in Pass-3).
    let claimedResolution = false;
    await deps.db.runTransaction(async (txn) => {
      const fresh = await txn.get(disputeRef);
      if (!fresh.exists) return;
      const fd = fresh.data() as GeneralDisputeDocument;
      if (fd.status !== 'voting') return; // a concurrent vote already recorded the verdict
      assertSystemRecordTransition('general_dispute', fd.status, 'resolved');
      txn.update(disputeRef, {
        status: 'resolved',
        resolution: finalResolution,
        resolution_summary: `Court verdict: ${finalResolution}`,
        resolved_at: now,
        updated_at: now,
      });
      claimedResolution = true;
    });
    if (!claimedResolution) {
      dispute.votes = votes;
      return dispute;
    }

    // Generate resolution PE (winner only), then back-reference it. A PE
    // failure here leaves resolution_pe_id unset on a resolved dispute —
    // logged, never unwound (the verdict record is already committed).
    let resolutionPeId: string | undefined;
    try {
      const [filerWalletDoc, respondentWalletDoc] = await Promise.all([
        deps.db.collection('agent_wallets').doc(dispute.filed_by).get(),
        deps.db.collection('agent_wallets').doc(dispute.respondent).get(),
      ]);
      const filerWallet = filerWalletDoc.data() as AgentWalletDocument;
      const { peId } = await generatePE(deps, {
        walletId: dispute.filed_by,
        agentId: filerWallet.agent_id,
        actorAddress: filerWallet.address,
        actionType: 'court_general_dispute_resolved',
        metadata: {
          dispute_id: disputeId,
          resolution: finalResolution,
          resolution_summary: `Court verdict: ${finalResolution}`,
          pe_chain_summary: `Dispute over ${dispute.subject_pe_ids.length} PE(s): ${dispute.description.substring(0, 200)}`,
        },
        counterpartyAddress: (respondentWalletDoc.data() as AgentWalletDocument | undefined)?.address,
      });
      resolutionPeId = peId;
      await disputeRef.update({ resolution_pe_id: resolutionPeId });
    } catch (err) {
      console.error(`[Court] Resolution PE failed for general dispute ${disputeId}:`, err);
    }

    // No governance-score deltas: the stored governance signal is gone.
    // The resolution is recorded by the court_general_dispute_resolved PE above.

    // Arbitrator majority/minority PEs
    const { FieldValue } = await import('firebase-admin/firestore');
    for (const panelWalletId of dispute.panel_wallet_ids || []) {
      const panelVote = votes[panelWalletId];
      if (!panelVote) continue;

      const isInMajority = panelVote === finalResolution;
      const arbWalletDoc = await deps.db.collection('agent_wallets').doc(panelWalletId).get();
      if (!arbWalletDoc.exists) continue;
      const arbWallet = arbWalletDoc.data() as AgentWalletDocument;

      await generatePE(deps, {
        walletId: panelWalletId,
        agentId: arbWallet.agent_id,
        actorAddress: arbWallet.address,
        actionType: isInMajority ? 'court_majority_bonus' : 'court_minority_vote',
        metadata: {
          dispute_id: disputeId,
          dispute_type: 'general',
          resolution: finalResolution,
          own_vote: panelVote,
        },
      });

      await deps.db.collection('arbitrators').doc(panelWalletId).update({
        [isInMajority ? 'majority_votes' : 'minority_votes']: FieldValue.increment(1),
        updated_at: now,
      });

      await updateWalletStats(deps, panelWalletId, 0);
    }

    // agent directory (supersedes the Pass-2 #1 direct flip): if this dispute escalated a
    // bond claim, the panel outcome is recorded as a RECORD-ONLY Court FINDING
    // on the claim — never a status flip. The claim's filed→upheld|dismissed
    // transition is ECONOMIC in the ONE machine and fires only through the
    // receipt-gated resolveBondClaim bridge on a verified Base-final
    // BondSlashed/ClaimDismissed receipt: the on-chain settlement is driven by
    // arbitrators' on-chain CourtV2.castBondClaimVote votes (or the
    // permissionless finalizeBondClaim), NEVER by this backend. After the
    // finding lands we attempt settlement OBSERVATION (the escrow-release
    // recovery pattern, bounded from the filing block); absent a recovered
    // receipt the claim stays 'filed' (fail closed) until the SDK posts the
    // resolving tx or the scheduler's settlement mirror recovers it. The
    // dispute is already committed 'resolved' above, so failures here are
    // logged, never unwound.
    if (dispute.bond_claim_id) {
      const mapped = mapDisputeResolutionToBondVerdict(finalResolution);
      if (mapped) {
        try {
          await recordBondClaimCourtFinding(deps, {
            claimId: dispute.bond_claim_id,
            verdict: finalResolution,
            slashBasis: mapped.slashBasis ?? null,
            disputeId,
          });
          const claim = await getClaimDetails(deps, dispute.bond_claim_id);
          if (claim.status === 'filed' && claim.onchain_claim_id) {
            const bondPoolAddress = bondPoolAddressForChain(claim.chain);
            if (bondPoolAddress) {
              const recovered = await recoverEvmBondClaimResolution({
                chainId: chainIdForChain(claim.chain),
                bondPoolAddress,
                onchainClaimId: claim.onchain_claim_id,
                expectedAgent: claim.respondent_address,
                fromBlock: claim.filing_block_number ?? 0,
              });
              if (recovered.ok && recovered.txHash) {
                // The EVENT decides the verdict — the Firestore finding is
                // reconciliation context, never settlement authority.
                await resolveBondClaim(deps, {
                  claimId: dispute.bond_claim_id,
                  settlement: { txHash: recovered.txHash, chain: claim.chain },
                  slashBasis: mapped.slashBasis,
                  resolutionSummary: `Court verdict: ${finalResolution}`,
                  resolvedByDisputeId: disputeId,
                });
              } else {
                console.warn(
                  `[Court] Bond claim ${dispute.bond_claim_id} finding recorded (dispute ${disputeId}); ` +
                    `no Base-final on-chain settlement recovered yet (${recovered.reason ?? 'unknown'}) — ` +
                    `claim stays 'filed' until the on-chain Court resolution is observed.`,
                );
              }
            }
          }
        } catch (err) {
          console.error(
            `[Court] bond claim finding/settlement failed for ${dispute.bond_claim_id} ` +
              `(dispute ${disputeId}):`,
            err,
          );
        }
      }
    }

    // the forum challenge → Court flow-back is RETIRED. Forum challenges
    // resolve by burn-to-present (`core/commons/forum.ts::answerChallenge`), never by a panel.

    dispute.status = 'resolved';
    dispute.resolution = finalResolution;
    dispute.votes = votes;
    return dispute;
  }

  dispute.votes = votes;
  return dispute;
}

/**
 * Map a general-dispute resolution onto a bond-claim verdict + slash basis.
 *  - upheld   → { verdict: 'upheld',    slashBasis: 'full' }    (full slash, fee returned)
 *  - partial  → { verdict: 'upheld',    slashBasis: 'partial' } (partial slash, fee returned)
 *  - dismissed→ { verdict: 'dismissed' }                        (filing fee burned)
 *  - escalated_external → null (no terminal bond verdict; claim stays open for
 *    the external/admin escalation path, never force-resolved here)
 *
 * `partial` collapses to the `upheld` verdict for FEE routing but carries a
 * distinct `slashBasis` so the partial-vs-full slash MAGNITUDE survives to
 * settlement losslessly (the only carriers are the persisted claim + the
 * bond_claim_resolved PE; there is no on-chain settlement path yet). The numeric
 * fraction for 'partial' is undefined protocol-wide — a [DESIGN] item; this only
 * preserves the category.
 */
function mapDisputeResolutionToBondVerdict(
  resolution: GeneralDisputeResolution,
): { verdict: BondClaimVerdict; slashBasis?: BondSlashBasis } | null {
  switch (resolution) {
    case 'upheld':
      return { verdict: 'upheld', slashBasis: 'full' };
    case 'partial':
      return { verdict: 'upheld', slashBasis: 'partial' };
    case 'dismissed':
      return { verdict: 'dismissed' };
    case 'escalated_external':
    default:
      return null;
  }
}


/**
 * Get a general dispute by ID.
 */
export async function getGeneralDispute(
  deps: AgentBankDeps,
  disputeId: string,
): Promise<GeneralDisputeDocument> {
  const snapshot = await deps.db.collection('general_disputes').doc(disputeId).get();
  if (!snapshot.exists) throw new NotFoundError('General dispute not found');
  return snapshot.data() as GeneralDisputeDocument;
}

/**
 * List disputes for a wallet (as complainant or respondent).
 */
export async function listMyGeneralDisputes(
  deps: AgentBankDeps,
  walletId: string,
): Promise<GeneralDisputeDocument[]> {
  const [asComplainant, asRespondent] = await Promise.all([
    deps.db.collection('general_disputes')
      .where('filed_by', '==', walletId)
      .orderBy('filed_at', 'desc')
      .limit(50)
      .get(),
    deps.db.collection('general_disputes')
      .where('respondent', '==', walletId)
      .orderBy('filed_at', 'desc')
      .limit(50)
      .get(),
  ]);

  const disputes = [
    ...asComplainant.docs.map(d => d.data() as GeneralDisputeDocument),
    ...asRespondent.docs.map(d => d.data() as GeneralDisputeDocument),
  ];

  // Deduplicate and sort
  const seen = new Set<string>();
  return disputes
    .filter(d => {
      if (seen.has(d.dispute_id)) return false;
      seen.add(d.dispute_id);
      return true;
    })
    .sort((a, b) => b.filed_at - a.filed_at);
}

/**
 * Process general dispute deadlines (called by scheduler).
 * - filed > 48h without panel → escalate to admin
 * - evidence_period > 48h → advance to voting
 * - voting > 48h without majority → escalate
 */
export async function processGeneralDisputeDeadlines(
  deps: AgentBankDeps,
): Promise<number> {
  const now = Date.now();
  let processed = 0;

  // 1. Filed disputes waiting too long for panel assignment (48h)
  const filedCutoff = now - SAFETY_LIMITS.GENERAL_DISPUTE_VOTING_WINDOW_HOURS * 60 * 60 * 1000;
  const filedSnapshot = await deps.db.collection('general_disputes')
    .where('status', '==', 'filed')
    .where('filed_at', '<=', filedCutoff)
    .limit(100)
    .get();

  for (const doc of filedSnapshot.docs) {
    try {
      // agent directory: filed→escalated through the machine (record-only; system,).
      assertSystemRecordTransition('general_dispute', 'filed', 'escalated');
      await doc.ref.update({ status: 'escalated', updated_at: now });
      processed++;
      console.log(`[Scheduler] Escalated general dispute ${doc.id} (no panel assigned)`);
    } catch (err) {
      console.error(`[Scheduler] General dispute deadline error for ${doc.id}:`, err);
    }
  }

  // 2. Evidence period expired → advance to voting.
  // Filtered range query on evidence_deadline (written atomically with
  // status='evidence_period' in assignGeneralDisputePanel) so we only read
  // disputes actually past their deadline instead of scanning every open one.
  const evidenceSnapshot = await deps.db.collection('general_disputes')
    .where('status', '==', 'evidence_period')
    .where('evidence_deadline', '<=', now)
    .limit(100)
    .get();

  for (const doc of evidenceSnapshot.docs) {
    try {
      // agent directory: evidence_period→voting through the machine (record-only; system).
      assertSystemRecordTransition('general_dispute', 'evidence_period', 'voting');
      const votingDeadline = now + SAFETY_LIMITS.GENERAL_DISPUTE_VOTING_WINDOW_HOURS * 60 * 60 * 1000;
      await doc.ref.update({
        status: 'voting',
        voting_deadline: votingDeadline,
        updated_at: now,
      });
      processed++;
      console.log(`[Scheduler] Advanced general dispute ${doc.id} to voting`);
    } catch (err) {
      console.error(`[Scheduler] General dispute evidence deadline error for ${doc.id}:`, err);
    }
  }

  // 3. Voting expired without majority → escalate.
  // Filtered range query on voting_deadline (written atomically with
  // status='voting' in step 2 above) so we only read disputes past their
  // voting deadline.
  const votingSnapshot = await deps.db.collection('general_disputes')
    .where('status', '==', 'voting')
    .where('voting_deadline', '<=', now)
    .limit(100)
    .get();

  // Pre-load every panel member wallet in one batched pass (Firestore 'in' is
  // capped at 30 ids per query) to avoid a per-panelist N+1 read — mirrors
  // processCourtDeadlines above.
  const votingPanelWalletIds = new Set<string>();
  for (const doc of votingSnapshot.docs) {
    const dispute = doc.data() as GeneralDisputeDocument;
    for (const wid of dispute.panel_wallet_ids || []) votingPanelWalletIds.add(wid);
  }
  const votingWalletCache = new Map<string, AgentWalletDocument>();
  const votingWalletIds = [...votingPanelWalletIds];
  for (let i = 0; i < votingWalletIds.length; i += 30) {
    const idChunk = votingWalletIds.slice(i, i + 30);
    const walletSnap = await deps.db.collection('agent_wallets')
      .where('__name__', 'in', idChunk)
      .get();
    for (const wDoc of walletSnap.docs) {
      votingWalletCache.set(wDoc.id, wDoc.data() as AgentWalletDocument);
    }
  }

  for (const doc of votingSnapshot.docs) {
    try {
      const dispute = doc.data() as GeneralDisputeDocument;
      // agent directory: voting→escalated through the machine (record-only appeal lane).
      assertSystemRecordTransition('general_dispute', 'voting', 'escalated');
      await doc.ref.update({ status: 'escalated', updated_at: now });

      // Generate escalation PEs for panel members (using the pre-loaded cache).
      for (const panelWalletId of dispute.panel_wallet_ids || []) {
        const wallet = votingWalletCache.get(panelWalletId);
        if (!wallet) continue;

        await generatePE(deps, {
          walletId: panelWalletId,
          agentId: wallet.agent_id,
          actorAddress: wallet.address,
          actionType: 'court_escalated',
          metadata: {
            dispute_id: dispute.dispute_id,
            dispute_type: 'general',
            reason: 'voting_deadline_expired',
          },
        });
      }

      processed++;
      console.log(`[Scheduler] Escalated general dispute ${doc.id} (voting deadline expired)`);
    } catch (err) {
      console.error(`[Scheduler] General dispute voting deadline error for ${doc.id}:`, err);
    }
  }

  return processed;
}
