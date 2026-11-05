/**
 * linked-job settlement — jobs payment truth: the SINGLE receipt-gated settlement path for the
 * agent job board (`jobs/`) and Commons human jobs (`commons_human_jobs/`).
 *
 * This module is the first live consumer of the beneficiary routing institution state machine:
 * every terminal job transition ('completed' the linked escrow released to
 * the worker; 'refunded' the disputed escrow resolved by refunding the
 * poster) is evaluated through `evaluateInstitutionTransition` INSIDE the
 * Firestore transaction that flips the job document, so:
 *
 * - suspension check is evaluated FIRST inside the guard (settlement recording is
 * a SYSTEM path — there is no acting agent, so `killSwitchActive` is
 * `false` here by doctrine: refusing to RECORD an already-settled on-chain
 * fact would make Firestore lie, not make anyone safer; the agent-initiated
 * draft paths in jobs.ts pass the real wallet-suspension state);
 * - an unmodeled edge fails closed (Unknown = Block): the job document is
 * left un-advanced with a logged reason, never silently flipped;
 * - an ECONOMIC transition cannot fire without a receipt bearing a
 * well-formed 64-hex settlement tx hash (`settlementReceipt` may only be
 * built from a TERMINAL escrowChain settle()/settleDispute() outcome — the
 * same trust root the escrow record itself is flipped on);
 * - retries are idempotent by tx hash: the job doc carries a
 * `settlement_tx_hashes` ledger consumed as `priorEconomicTxHashes`, and
 * settlement PEs are emitted under a transactional single-winner claim
 * (`settlement_pe_claimed`, mirroring escrow's `completion_pe_claimed`) so
 * a retry or a concurrent settler can never append duplicate economic PEs.
 *
 * The money itself NEVER moves here: payment rides the linked escrow
 * (pitfalls #25/#35 — jobs must not fork a parallel escrow path), whose own
 * verified escrow_completed / escrow_resolved PEs remain the canonical money
 * record. This module records the JOB lifecycle outcome those receipts prove.
 */

import admin from 'firebase-admin';
import type { AgentBankDeps, EscrowDocument, JobDocument } from './types';
import type { HumanJob } from '../commons/types';
import { COMMONS_COLLECTIONS } from '../commons/types';
import { tryResolveEscrowParty, type EscrowParty } from './escrow-party';
import {
  evaluateInstitutionTransition,
  type InstitutionKind,
  type ReceiptEvidence,
} from './institution-state-machine';
import { generatePE } from './pe-utils';

export type JobSettlementOutcome = 'completed' | 'refunded';

export interface JobSettlementResult {
  /** True iff THIS call performed the terminal doc flip. */
  transitioned: boolean;
  /** True iff the receipt's tx hash had already driven this job's settlement. */
  idempotent: boolean;
  /** The guard's (or caller-level) block reason when the flip did not happen. */
  blockedReason?: string;
  /** Settlement PE ids emitted by THIS call (empty when not the emission winner). */
  peIds: string[];
}

/**
 * Build the `ReceiptEvidence` for a settled escrow. ONLY call this after the
 * escrowChain gateway returned a TERMINAL outcome ('released' /
 * 'already_released' / 'resolved' / 'already_resolved') — the `ok: true` here
 * asserts exactly that confirmed on-chain settlement. A missing/malformed tx
 * hash is passed through untouched so the guard fails closed on it
 * (`receipt_missing_tx_hash`) rather than this helper inventing evidence.
 */
export function settlementReceipt(txHash: string | undefined): ReceiptEvidence {
  return { ok: true, txHash };
}

interface SettleDocOptions {
  kind: InstitutionKind;
  /** Firestore schema quirk: commons_human_jobs has no updated_at field. */
  hasUpdatedAt: boolean;
  /** Extra fields folded into the terminal flip (payment truth mirrors). */
  extraFlip: (outcome: JobSettlementOutcome, now: number) => Record<string, unknown>;
}

/**
 * The shared guarded flip: evaluate the transition on the FRESH doc inside a
 * Firestore transaction and flip it only on an allowed, non-idempotent
 * economic decision. Returns what happened; never throws on a block.
 */
async function settleJobDoc(
  deps: AgentBankDeps,
  jobRef: FirebaseFirestore.DocumentReference,
  outcome: JobSettlementOutcome,
  receipt: ReceiptEvidence,
  now: number,
  opts: SettleDocOptions,
): Promise<{ transitioned: boolean; idempotent: boolean; blockedReason?: string }> {
  let transitioned = false;
  let idempotent = false;
  let blockedReason: string | undefined;

  await deps.db.runTransaction(async (tx) => {
    // Reset per attempt — Firestore may retry the transaction closure.
    transitioned = false;
    idempotent = false;
    blockedReason = undefined;

    const fresh = await tx.get(jobRef);
    if (!fresh.exists) {
      blockedReason = 'job_not_found';
      return;
    }
    const job = fresh.data() as { status: string; settlement_tx_hashes?: string[] };
    const ledger = job.settlement_tx_hashes ?? [];

    // Caller-level idempotency: the job already terminated at this outcome off
    // this very tx. (After the first flip the (outcome → outcome) edge is no
    // longer declared, so the guard alone cannot distinguish a retry from an
    // illegal flip — the ledger does.)
    if (
      job.status === outcome
      && typeof receipt.txHash === 'string'
      && ledger.some((h) => h.toLowerCase() === receipt.txHash!.toLowerCase())
    ) {
      idempotent = true;
      return;
    }

    // The ONE fail-closed guard (suspension check first → Unknown=Block → economic
    // needs a Base-final receipt → idempotent by tx hash).
    const decision = evaluateInstitutionTransition({
      kind: opts.kind,
      from: job.status,
      to: outcome,
      receipt,
      priorEconomicTxHashes: ledger,
      // System settlement recording: no acting agent (see module header).
      killSwitchActive: false,
    });
    if (!decision.allowed) {
      blockedReason = decision.reason;
      return;
    }
    if (decision.idempotent) {
      idempotent = true;
      return;
    }

    tx.update(jobRef, {
      status: outcome,
      settlement_tx_hash: decision.txHash,
      settlement_tx_hashes: admin.firestore.FieldValue.arrayUnion(decision.txHash),
      ...(outcome === 'completed' ? { completed_at: now } : { refunded_at: now }),
      ...(opts.hasUpdatedAt ? { updated_at: now } : {}),
      ...opts.extraFlip(outcome, now),
    });
    transitioned = true;
  });

  return { transitioned, idempotent, blockedReason };
}

/**
 * Transactional single-winner claim for settlement-PE emission (mirrors
 * escrow's claimCompletionEmission): exactly one caller — the flip winner or a
 * later repair after a crash between flip and emission — wins and emits; every
 * other caller reads the claim/ids and skips. Claimed only on a doc that
 * actually terminated at `outcome`, so a blocked flip can never emit.
 */
async function claimSettlementEmission(
  deps: AgentBankDeps,
  jobRef: FirebaseFirestore.DocumentReference,
  outcome: JobSettlementOutcome,
  now: number,
  hasUpdatedAt: boolean,
): Promise<boolean> {
  let claimed = false;
  await deps.db.runTransaction(async (tx) => {
    claimed = false;
    const fresh = await tx.get(jobRef);
    if (!fresh.exists) return;
    const job = fresh.data() as {
      status: string;
      settlement_pe_ids?: string[];
      settlement_pe_claimed?: boolean;
    };
    if (job.status !== outcome) return;
    if ((job.settlement_pe_ids?.length ?? 0) > 0 || job.settlement_pe_claimed) return;
    tx.update(jobRef, {
      settlement_pe_claimed: true,
      ...(hasUpdatedAt ? { updated_at: now } : {}),
    });
    claimed = true;
  });
  return claimed;
}

/**
 * Currency-aware amount fields for a settlement PE, from the escrow record.
 * (The USDC branch is deliberately FIRST: the runtime boundary lexical external-value audit
 * reads a pvt-fee token textually followed by a usdc-amount token as coupling,
 * and this record-metadata copy is not one — no amount feeds any PVT economic
 * authority here.)
 */
function settlementAmounts(escrow: EscrowDocument): Record<string, unknown> {
  const currency = escrow.currency ?? 'usdc';
  return currency === 'usdc'
    ? {
        currency,
        amount_usdc: escrow.amount_usdc,
        net_to_recipient_usdc: escrow.net_to_recipient_usdc,
        fee_usdc: escrow.fee_usdc,
      }
    : {
        currency,
        amount_pvt: escrow.amount_pvt,
        net_to_recipient_pvt: escrow.net_to_recipient_pvt,
        fee_pvt: escrow.fee_pvt,
      };
}

/**
 * Read both party identities off the escrow record. Missing/unresolvable
 * wallets skip their PE. parties may be agents OR humans, so this
 * resolves through `tryResolveEscrowParty` (agent_wallets → human wallets/users)
 * rather than assuming an `agent_wallets` doc — otherwise a human depositor or
 * recipient of a human-jobs escrow silently got no settlement PE.
 */
async function readParties(
  deps: AgentBankDeps,
  escrow: EscrowDocument,
): Promise<{ depositor: EscrowParty | null; recipient: EscrowParty | null }> {
  const [depositor, recipient] = await Promise.all([
    tryResolveEscrowParty(deps, escrow.depositor_wallet_id, 'Depositor'),
    tryResolveEscrowParty(deps, escrow.recipient_wallet_id, 'Recipient'),
  ]);
  return { depositor, recipient };
}

/**
 * Emit the dual-party settlement PEs (single-winner claim already held by the
 * caller) and persist their ids on the job doc.
 */
async function emitSettlementPEs(
  deps: AgentBankDeps,
  jobRef: FirebaseFirestore.DocumentReference,
  escrow: EscrowDocument,
  actionType: string,
  metadata: Record<string, unknown>,
  now: number,
  hasUpdatedAt: boolean,
  appendToPeIds: boolean,
): Promise<string[]> {
  const { depositor, recipient } = await readParties(deps, escrow);
  const peIds: string[] = [];
  if (depositor) {
    const { peId } = await generatePE(deps, {
      walletId: escrow.depositor_wallet_id,
      agentId: depositor.agentId,
      actorAddress: depositor.address,
      actionType,
      metadata: { ...metadata, role: 'depositor' },
      counterpartyAddress: escrow.recipient_address,
    });
    peIds.push(peId);
  }
  if (recipient) {
    const { peId } = await generatePE(deps, {
      walletId: escrow.recipient_wallet_id,
      agentId: recipient.agentId,
      actorAddress: recipient.address,
      actionType,
      metadata: { ...metadata, role: 'recipient' },
      counterpartyAddress: escrow.depositor_address,
    });
    peIds.push(peId);
  }
  if (peIds.length > 0) {
    await jobRef.update({
      settlement_pe_ids: peIds,
      ...(appendToPeIds ? { pe_ids: admin.firestore.FieldValue.arrayUnion(...peIds) } : {}),
      ...(hasUpdatedAt ? { updated_at: now } : {}),
    });
  }
  return peIds;
}

/**
 * Settle a linked AGENT-BOARD job document off its escrow's confirmed on-chain
 * settlement. Guarded, idempotent, fail-closed (a block leaves the job
 * un-advanced for retry and logs the reason — never records a lie).
 */
export async function settleLinkedAgentJob(
  deps: AgentBankDeps,
  jobRef: FirebaseFirestore.DocumentReference,
  escrow: EscrowDocument,
  outcome: JobSettlementOutcome,
  receipt: ReceiptEvidence,
  now: number,
): Promise<JobSettlementResult> {
  const flip = await settleJobDoc(deps, jobRef, outcome, receipt, now, {
    kind: 'job',
    hasUpdatedAt: true,
    extraFlip: () => ({}),
  });
  if (flip.blockedReason) {
    console.warn(
      `[JobSettlement] jobs/${jobRef.id} NOT advanced to '${outcome}' `
        + `(${flip.blockedReason}); left as-is for retry (fail-closed).`,
    );
    return { ...flip, peIds: [] };
  }

  // PE emission: single-winner; the idempotent path also attempts the claim so
  // a crash between flip and emission is repaired by the next retry.
  let peIds: string[] = [];
  if (await claimSettlementEmission(deps, jobRef, outcome, now, true)) {
    const jobSnap = await jobRef.get();
    const job = jobSnap.data() as JobDocument;
    peIds = await emitSettlementPEs(
      deps,
      jobRef,
      escrow,
      outcome === 'completed' ? 'job_completed' : 'job_refunded',
      {
        job_id: job.job_id,
        escrow_id: escrow.escrow_id,
        tx_hash: job.settlement_tx_hash,
        outcome,
        ...(outcome === 'refunded' ? { resolution: 'refund_to_depositor' } : {}),
        ...settlementAmounts(escrow),
      },
      now,
      true,
      true,
    );
  }
  return { ...flip, peIds };
}

/**
 * Idempotent human_jobs_completed profile-stat credit for the accepted
 * applicant (moved here from completeHumanJob by the stat now records
 * a SETTLED job). The increment and its claim are one atomic transaction on
 * the job doc, mirroring escrow's creditWalletStatsAtomic pattern.
 */
async function creditHumanJobCompletionStat(
  deps: AgentBankDeps,
  jobRef: FirebaseFirestore.DocumentReference,
  now: number,
): Promise<void> {
  await deps.db.runTransaction(async (tx) => {
    const fresh = await tx.get(jobRef);
    if (!fresh.exists) return;
    const job = fresh.data() as HumanJob & { completion_stats_credited?: boolean };
    if (job.status !== 'completed') return;
    if (job.completion_stats_credited) return;
    if (!job.accepted_applicant_wallet_id) return;
    const profileRef = deps.db
      .collection(COMMONS_COLLECTIONS.PROFILES)
      .doc(job.accepted_applicant_wallet_id);
    const profile = await tx.get(profileRef);
    if (profile.exists) {
      tx.update(profileRef, {
        human_jobs_completed: admin.firestore.FieldValue.increment(1),
        updated_at: now,
      });
    }
    tx.update(jobRef, { completion_stats_credited: true });
  });
}

/**
 * Settle a linked COMMONS HUMAN-JOB document off its escrow's confirmed
 * on-chain settlement. Same guard/idempotency/fail-closed contract as the
 * agent board; the flip additionally records the WS1 payment-truth flags
 * (payment_released iff the worker was actually paid).
 */
export async function settleLinkedHumanJob(
  deps: AgentBankDeps,
  jobRef: FirebaseFirestore.DocumentReference,
  escrow: EscrowDocument,
  outcome: JobSettlementOutcome,
  receipt: ReceiptEvidence,
  now: number,
): Promise<JobSettlementResult> {
  const flip = await settleJobDoc(deps, jobRef, outcome, receipt, now, {
    kind: 'human_job',
    hasUpdatedAt: false, // commons_human_jobs has no updated_at field
    extraFlip: (o) => ({
      payment_released: o === 'completed',
      payment_release_pending: false,
    }),
  });
  if (flip.blockedReason) {
    console.warn(
      `[JobSettlement] commons_human_jobs/${jobRef.id} NOT advanced to '${outcome}' `
        + `(${flip.blockedReason}); left as-is for retry (fail-closed).`,
    );
    return { ...flip, peIds: [] };
  }

  let peIds: string[] = [];
  if (await claimSettlementEmission(deps, jobRef, outcome, now, false)) {
    const jobSnap = await jobRef.get();
    const job = jobSnap.data() as HumanJob;
    peIds = await emitSettlementPEs(
      deps,
      jobRef,
      escrow,
      outcome === 'completed' ? 'human_job_payment_released' : 'human_job_refunded',
      {
        job_id: job.job_id,
        escrow_id: escrow.escrow_id,
        tx_hash: job.settlement_tx_hash,
        outcome,
        ...(outcome === 'refunded' ? { resolution: 'refund_to_depositor' } : {}),
        ...settlementAmounts(escrow),
      },
      now,
      false,
      false, // HumanJob has no pe_ids array; ids live in settlement_pe_ids
    );
  }
  if (outcome === 'completed') {
    await creditHumanJobCompletionStat(deps, jobRef, now);
  }
  return { ...flip, peIds };
}

/**
 * Find and settle every job document (agent board + Commons human jobs) linked
 * to a settled escrow. Best-effort relative to the escrow's own flip (the
 * funds already moved on-chain — an error here must not unwind that record),
 * but each individual advancement is guarded + idempotent, so a failed or
 * blocked advancement is simply retried by the next settlement caller.
 */
export async function settleLinkedJobsForEscrow(
  deps: AgentBankDeps,
  escrow: EscrowDocument,
  outcome: JobSettlementOutcome,
  receipt: ReceiptEvidence,
  now: number,
): Promise<void> {
  try {
    const [agentJobsSnap, humanJobsSnap] = await Promise.all([
      deps.db.collection('jobs').where('escrow_id', '==', escrow.escrow_id).limit(1).get(),
      deps.db
        .collection('commons_human_jobs')
        .where('escrow_id', '==', escrow.escrow_id)
        .limit(1)
        .get(),
    ]);
    if (!agentJobsSnap.empty) {
      await settleLinkedAgentJob(deps, agentJobsSnap.docs[0].ref, escrow, outcome, receipt, now);
    }
    if (!humanJobsSnap.empty) {
      await settleLinkedHumanJob(deps, humanJobsSnap.docs[0].ref, escrow, outcome, receipt, now);
    }
  } catch (err) {
    console.error(
      `[JobSettlement] linked-job settlement failed for escrow ${escrow.escrow_id} `
        + '(escrow record unaffected; advancement will be retried):',
      err,
    );
  }
}

/**
 * Mirror a raised escrow dispute onto its linked job documents. Record-only:
 * no receipt, no money — the dispute lives on the ESCROW record
 * (funded→disputed, already modeled); the agent-board job mirrors it as a
 * FIELD (a dispute is not a payment outcome there), while the Commons human
 * job takes the guarded record_only in_progress→disputed transition (its
 * status enum models the dispute). Fail-closed: a blocked mirror is logged and
 * skipped — the escrow's own dispute record is unaffected.
 */
export async function mirrorEscrowDisputeToLinkedJobs(
  deps: AgentBankDeps,
  escrowId: string,
  now: number,
): Promise<void> {
  try {
    const [agentJobsSnap, humanJobsSnap] = await Promise.all([
      deps.db.collection('jobs').where('escrow_id', '==', escrowId).limit(1).get(),
      deps.db
        .collection('commons_human_jobs')
        .where('escrow_id', '==', escrowId)
        .limit(1)
        .get(),
    ]);

    if (!agentJobsSnap.empty) {
      // Field mirror, not a status transition — nothing for the machine to gate.
      await agentJobsSnap.docs[0].ref.update({
        escrow_disputed_at: now,
        updated_at: now,
      });
    }

    if (!humanJobsSnap.empty) {
      const jobRef = humanJobsSnap.docs[0].ref;
      await deps.db.runTransaction(async (tx) => {
        const fresh = await tx.get(jobRef);
        if (!fresh.exists) return;
        const job = fresh.data() as HumanJob;
        const decision = evaluateInstitutionTransition({
          kind: 'human_job',
          from: job.status,
          to: 'disputed',
          killSwitchActive: false, // consequence record of the depositor's authenticated dispute
        });
        if (!decision.allowed) {
          console.warn(
            `[JobSettlement] commons_human_jobs/${jobRef.id} dispute mirror blocked `
              + `(${decision.reason}); escrow dispute record unaffected.`,
          );
          return;
        }
        tx.update(jobRef, { status: 'disputed', disputed_at: now });
      });
    }
  } catch (err) {
    console.error(
      `[JobSettlement] dispute mirror failed for escrow ${escrowId} `
        + '(escrow dispute record unaffected):',
      err,
    );
  }
}
