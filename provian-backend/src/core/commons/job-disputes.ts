/**
 * the dispute fallback for every Commons hire, reachable by people (wallet auth, the
 * app) and agents (API key, SDK / MCP / CLI) through the same routes.
 *
 * The ruled fallback is: the escrow ADMIN resolves a dispute on-chain, and if
 * nobody resolves it within the contract's dispute timeout (30 days on ProvianEscrowV4), ANYONE
 * may refund the depositor with the permissionless `claimDisputeTimeout`. Escalation to Court
 * stays hidden until the Court institution reports live — nothing here reaches Court.
 *
 * Three acts, each bound to the chain (the relay never records a dispute state the chain does
 * not hold):
 * 1. FILE — the depositor (the job's poster) raises `disputeEscrow` on-chain with its own key
 * (the contract is `onlyDepositor`), then tells the relay. The relay reads the on-chain
 * Status and records the dispute ONLY when the chain says Disputed; the job mirrors it.
 * 2. READ — either party reads the dispute: the relay record plus the on-chain Status and the
 * refund deadline (`disputeDeadline`), so the app/SDK can show when the refund opens.
 * 3. SETTLE — either party asks the relay to settle what the chain allows: an admin (or Court)
 * resolution that already happened on-chain is OBSERVED and recorded in the direction the
 * chain paid; a dispute past its deadline is refunded to the depositor through
 * `claimDisputeTimeout` (the relay's gas-only key, or the party's own tx — observed either
 * way). A dispute still inside its window is refused (409) with the deadline — the relay
 * never forces an early outcome, and never asks the gas key to resolve in either direction
 * before the timeout.
 *
 * RECONCILIATION : the chain is authoritative, and the relay record can lag it —
 * a dispute mined just before auto-release whose relay POST lands after the relay's own
 * `auto_release_at` (which `disputeEscrow` refuses), or a dispute that the admin / the timeout
 * refund RESOLVED on-chain before anyone told the relay. Left alone, the record would say `funded`
 * forever and the auto-release keeper would fail on the Disputed/Resolved chain status forever.
 * So when the chain holds a dispute the relay does not, FILE and SETTLE record it as observed
 * (`recordObservedOnchainDispute` the same fields `disputeEscrow` writes, the same job mirror,
 * conditional on the record still being `funded`), and a chain that already RESOLVED is then
 * settled through the existing `resolveDispute`, which reads the paid direction off the chain.
 * Nothing is recorded that the chain does not hold; no outcome is driven.
 *
 * Escrow logic is NOT duplicated: filing and settling call the existing `disputeEscrow` /
 * `resolveDispute` in `agent-bank/escrow.ts` (which mirror onto the linked job and settle it
 * `completed` / `refunded` off the on-chain receipt). This module only adds the job-level
 * authorization and the on-chain preconditions.
 */

import { forEachDocument } from '../agent-bank/page-all';
import { disputeEscrow, resolveDispute } from '../agent-bank/escrow';
import { mirrorEscrowDisputeToLinkedJobs } from '../agent-bank/job-settlement';
import { ForbiddenError, NotFoundError, ValidationError } from '../agent-bank/errors';
import {
  ONCHAIN_ESCROW_STATUS,
  type AgentBankDeps,
  type EscrowDocument,
  type EscrowDisputeStateRead,
} from '../agent-bank/types';
import { COMMONS_COLLECTIONS, type HumanJob } from './types';

export const DISPUTE_REASON_MAX_LENGTH = 1000;
export const DISPUTE_EVIDENCE_MAX_LENGTH = 2000;

/** A 409 carrying a machine-readable code (the route maps it). */
export class JobDisputeConflictError extends Error {
  readonly status = 409;
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'JobDisputeConflictError';
  }
}

export interface JobDisputeView {
  job_id: string;
  escrow_id: string;
  /** Relay record: funded | disputed | resolved | completed | … */
  escrow_status: string;
  currency: 'usdc' | 'pvt';
  disputed_at: number | null;
  dispute_reason: string | null;
  resolution: 'release_to_recipient' | 'refund_to_depositor' | null;
  resolution_tx_hash: string | null;
  /** On-chain Status enum name, or null when the chain could not be read. */
  onchain_status: 'created' | 'funded' | 'completed' | 'disputed' | 'resolved' | 'cancelled' | 'unknown' | null;
  /** When the permissionless refund opens (ms), or null when not disputed on-chain / unreadable. */
  refund_opens_at: number | null;
  /** True when the on-chain dispute is past its deadline and still unresolved. */
  refund_claimable: boolean;
  /** Court stays hidden until it reports live : never offered here. */
  court_escalation_available: false;
  onchain_escrow_id: string | null;
}

const STATUS_NAMES: Record<number, JobDisputeView['onchain_status']> = {
  [ONCHAIN_ESCROW_STATUS.CREATED]: 'created',
  [ONCHAIN_ESCROW_STATUS.FUNDED]: 'funded',
  [ONCHAIN_ESCROW_STATUS.COMPLETED]: 'completed',
  [ONCHAIN_ESCROW_STATUS.DISPUTED]: 'disputed',
  [ONCHAIN_ESCROW_STATUS.RESOLVED]: 'resolved',
  [ONCHAIN_ESCROW_STATUS.CANCELLED]: 'cancelled',
};

async function loadJobAndEscrow(
  deps: AgentBankDeps,
  jobId: string,
): Promise<{ job: HumanJob; escrow: EscrowDocument }> {
  const jobSnap = await deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).doc(jobId).get();
  if (!jobSnap.exists) throw new NotFoundError('Job not found');
  const job = jobSnap.data() as HumanJob;
  if (!job.escrow_id) throw new ValidationError('This job has no escrow (no one has been hired yet)');
  const escrowSnap = await deps.db.collection('escrows').doc(job.escrow_id).get();
  if (!escrowSnap.exists) throw new NotFoundError('Escrow not found');
  return { job, escrow: escrowSnap.data() as EscrowDocument };
}

function assertParty(job: HumanJob, walletId: string): 'poster' | 'hired' {
  if (job.poster_wallet_id === walletId) return 'poster';
  if (job.accepted_applicant_wallet_id && job.accepted_applicant_wallet_id === walletId) return 'hired';
  throw new ForbiddenError('Only the job poster or the hired participant can act on this dispute');
}

async function readChainDispute(deps: AgentBankDeps, escrow: EscrowDocument): Promise<EscrowDisputeStateRead> {
  const reader = deps.escrowChain?.readDisputeState;
  if (!deps.escrowChain || !reader) return { ok: false, reason: 'escrow_chain_reader_unconfigured' };
  return reader.call(deps.escrowChain, escrow);
}

function toView(job: HumanJob, escrow: EscrowDocument, chain: EscrowDisputeStateRead, nowMs: number): JobDisputeView {
  const onchainStatus = chain.ok ? (STATUS_NAMES[chain.status] ?? 'unknown') : null;
  const deadlineMs = chain.ok && chain.disputeDeadlineSec > 0n ? Number(chain.disputeDeadlineSec) * 1000 : null;
  return {
    job_id: job.job_id,
    escrow_id: escrow.escrow_id,
    escrow_status: escrow.status,
    currency: escrow.currency ?? 'usdc',
    disputed_at: escrow.disputed_at ?? null,
    dispute_reason: escrow.dispute_reason ?? null,
    resolution: escrow.resolution ?? null,
    resolution_tx_hash: escrow.resolution_tx_hash ?? null,
    onchain_status: onchainStatus,
    refund_opens_at: onchainStatus === 'disputed' ? deadlineMs : null,
    refund_claimable: onchainStatus === 'disputed' && deadlineMs !== null && nowMs >= deadlineMs,
    court_escalation_available: false,
    onchain_escrow_id: chain.ok ? chain.onchainId : (escrow.onchain_escrow_id ?? null),
  };
}

/**
 * Record a dispute the chain already holds (status Disputed, or Resolved — the contract resolves
 * only a disputed escrow) but the relay record does not. Same fields as `disputeEscrow`, same job
 * mirror; written only while the record is still `funded`, in a transaction, so a concurrent
 * file/settle cannot double-write. Returns the escrow as recorded.
 */
async function recordObservedOnchainDispute(
  deps: AgentBankDeps,
  escrow: EscrowDocument,
  reason: string,
  evidence: string | undefined,
  nowMs: number,
): Promise<EscrowDocument> {
  const ref = deps.db.collection('escrows').doc(escrow.escrow_id);
  const recorded = await deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new NotFoundError('Escrow not found');
    const current = snap.data() as EscrowDocument;
    if (current.status !== 'funded') return { doc: current, wrote: false };
    const fields = {
      status: 'disputed' as const,
      disputed_at: nowMs,
      dispute_reason: reason,
      dispute_evidence: evidence ?? null,
      dispute_recorded_from_chain: true,
      updated_at: nowMs,
    };
    tx.update(ref, fields);
    return { doc: { ...current, ...fields } as EscrowDocument, wrote: true };
  });
  if (recorded.wrote) await mirrorEscrowDisputeToLinkedJobs(deps, escrow.escrow_id, nowMs);
  return recorded.doc;
}

const OBSERVED_DISPUTE_REASON = 'Dispute raised on-chain by the payer (recorded from the chain).';

/** READ: the dispute view for either party. */
export async function getJobDispute(
  deps: AgentBankDeps,
  walletId: string,
  jobId: string,
  nowMs: number = Date.now(),
): Promise<JobDisputeView> {
  const { job, escrow } = await loadJobAndEscrow(deps, jobId);
  assertParty(job, walletId);
  const chain = await readChainDispute(deps, escrow);
  return toView(job, escrow, chain, nowMs);
}

/**
 * FILE: the depositor (poster) records the dispute it already raised on-chain. Refused unless
 * the chain says Disputed — the relay never records a dispute the escrow contract does not hold
 * (a relay-only flip would stall the auto-release keeper while the chain still auto-releases).
 */
export async function fileJobDispute(
  deps: AgentBankDeps,
  walletId: string,
  jobId: string,
  input: { reason?: unknown; evidence?: unknown },
  nowMs: number = Date.now(),
): Promise<JobDisputeView> {
  const { job, escrow } = await loadJobAndEscrow(deps, jobId);
  const role = assertParty(job, walletId);
  if (role !== 'poster') {
    throw new ForbiddenError(
      'Only the payer (the job poster) can dispute: the escrow contract lets only the depositor file. ' +
      'The hired participant is protected by auto-release.',
    );
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length === 0 || reason.length > DISPUTE_REASON_MAX_LENGTH) {
    throw new ValidationError(`reason is required (1-${DISPUTE_REASON_MAX_LENGTH} chars)`);
  }
  let evidence: string | undefined;
  if (input.evidence !== undefined && input.evidence !== null) {
    if (typeof input.evidence !== 'string' || input.evidence.length > DISPUTE_EVIDENCE_MAX_LENGTH) {
      throw new ValidationError(`evidence must be a string of at most ${DISPUTE_EVIDENCE_MAX_LENGTH} chars`);
    }
    evidence = input.evidence.trim() || undefined;
  }

  if (escrow.status === 'disputed') {
    // Idempotent re-file: the record already holds it.
    const chain = await readChainDispute(deps, escrow);
    return toView(job, escrow, chain, nowMs);
  }
  if (escrow.status !== 'funded') {
    throw new ValidationError(`Only a funded escrow can be disputed (escrow is ${escrow.status})`);
  }

  const chain = await readChainDispute(deps, escrow);
  if (!chain.ok) {
    throw new JobDisputeConflictError(
      'onchain_state_unreadable',
      `Could not read the escrow on-chain (${chain.reason}); the dispute was not recorded. Retry shortly.`,
    );
  }
  if (chain.status === ONCHAIN_ESCROW_STATUS.RESOLVED) {
    // Resolved on-chain (admin, or the timeout refund) before the relay heard of the dispute:
    // record it, then settle it in the direction the chain paid.
    await recordObservedOnchainDispute(deps, escrow, reason, evidence, nowMs);
    const settled = await resolveDispute(deps, escrow.escrow_id, false, 'onchain_resolution_observed', { hireJobId: jobId });
    const settledJob = (await deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).doc(jobId).get()).data() as HumanJob;
    return toView(settledJob ?? job, settled, chain, nowMs);
  }
  if (chain.status !== ONCHAIN_ESCROW_STATUS.DISPUTED) {
    throw new JobDisputeConflictError(
      'onchain_dispute_required',
      'Raise the dispute on-chain first: call disputeEscrow(onchain_escrow_id) on the escrow contract ' +
        'from the depositor wallet, then file it here.',
      { onchain_escrow_id: chain.onchainId, onchain_status: STATUS_NAMES[chain.status] ?? 'unknown' },
    );
  }

  // The chain holds the dispute. `disputeEscrow` refuses once the relay's own auto_release_at has
  // passed — a dispute mined just before auto-release whose POST lands after it is still a real
  // on-chain dispute, so it is recorded as observed rather than left `funded` forever.
  const updated = nowMs >= escrow.auto_release_at
    ? await recordObservedOnchainDispute(deps, escrow, reason, evidence, nowMs)
    : await disputeEscrow(deps, escrow.escrow_id, walletId, reason, evidence);
  const freshJob = (await deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).doc(jobId).get()).data() as HumanJob;
  return toView(freshJob ?? job, updated, chain, nowMs);
}

/**
 * SETTLE: either party asks the relay to record what the chain allows — an on-chain admin /
 * Court resolution (observed, recorded in the direction the chain paid), or the permissionless
 * refund once the dispute deadline has passed. Inside the window with no on-chain resolution →
 * 409 `dispute_pending` with `refund_opens_at`.
 */
export async function settleJobDispute(
  deps: AgentBankDeps,
  walletId: string,
  jobId: string,
  nowMs: number = Date.now(),
): Promise<JobDisputeView> {
  const loaded = await loadJobAndEscrow(deps, jobId);
  const job = loaded.job;
  let escrow = loaded.escrow;
  assertParty(job, walletId);

  if (escrow.status === 'resolved') {
    const chain = await readChainDispute(deps, escrow);
    return toView(job, escrow, chain, nowMs);
  }
  if (escrow.status !== 'disputed' && escrow.status !== 'funded') {
    throw new ValidationError(`There is no open dispute on this job (escrow is ${escrow.status})`);
  }

  const chain = await readChainDispute(deps, escrow);
  if (escrow.status === 'funded') {
    // The relay has no dispute. Only a chain that holds one (Disputed or Resolved) can change
    // that; anything else — including an unreadable chain — is "no open dispute".
    const chainHoldsDispute = chain.ok
      && (chain.status === ONCHAIN_ESCROW_STATUS.DISPUTED || chain.status === ONCHAIN_ESCROW_STATUS.RESOLVED);
    if (!chainHoldsDispute) {
      throw new ValidationError('There is no open dispute on this job (escrow is funded)');
    }
    escrow = await recordObservedOnchainDispute(deps, escrow, OBSERVED_DISPUTE_REASON, undefined, nowMs);
  }
  if (!chain.ok) {
    throw new JobDisputeConflictError(
      'onchain_state_unreadable',
      `Could not read the escrow on-chain (${chain.reason}). Retry shortly.`,
    );
  }
  const deadlineMs = chain.disputeDeadlineSec > 0n ? Number(chain.disputeDeadlineSec) * 1000 : null;
  const resolvedOnchain = chain.status === ONCHAIN_ESCROW_STATUS.RESOLVED;
  const refundOpen = chain.status === ONCHAIN_ESCROW_STATUS.DISPUTED && deadlineMs !== null && nowMs >= deadlineMs;
  if (!resolvedOnchain && !refundOpen) {
    throw new JobDisputeConflictError(
      'dispute_pending',
      deadlineMs !== null
        ? 'Until the Court opens, Provian’s admin key resolves disputed escrows only to the recipient or depositor. Anyone can trigger the depositor refund after the 30-day timeout.'
        : 'The dispute is not settled on-chain yet.',
      { refund_opens_at: deadlineMs, onchain_status: STATUS_NAMES[chain.status] ?? 'unknown' },
    );
  }

  // Direction `false` (refund): on an already-Resolved escrow `resolveDispute` observes and
  // records the ACTUAL on-chain direction (an admin release pays the worker and is recorded as
  // such); past the deadline it refunds the depositor via claimDisputeTimeout. It never drives
  // a release, and it is only reached once the chain already permits the outcome.
  const resolved = await resolveDispute(
    deps,
    escrow.escrow_id,
    false,
    resolvedOnchain ? 'onchain_resolution_observed' : 'dispute_timeout_refund',
    { hireJobId: jobId },
  );
  const freshJob = (await deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).doc(jobId).get()).data() as HumanJob;
  const reread = await readChainDispute(deps, resolved);
  return toView(freshJob ?? job, resolved, reread, nowMs);
}

// =============================================================================
// a resolved hire dispute nobody reported (Standing reconcile sweep)
// =============================================================================

export interface HireDisputeSweepReport {
  readonly escrows_checked: number;
  readonly resolutions_recorded: number;
  readonly still_open: number;
  readonly unreadable: number;
  readonly failures: number;
}

/**
 * A lost hire dispute is counted from the `escrow_resolved` rows `resolveDispute` seals, and those
 * are sealed only when a party tells the relay (`settleJobDispute` / a late `fileJobDispute`). The
 * loser has no reason to. This sweep closes that: for every hire escrow the relay still holds as
 * `disputed`, or as `funded` past its auto-release time, it READS the chain and — only when the
 * chain already shows the escrow Resolved — records the resolution in the direction the chain paid.
 * It observes; it never files, drives or times out a dispute (an open dispute past its deadline is
 * left for the payer's own refund claim).
 */
export async function observeResolvedHireDisputes(
  deps: AgentBankDeps,
  nowMs: number = Date.now(),
  pageSize: number = 200,
): Promise<HireDisputeSweepReport> {
  let checked = 0;
  let recorded = 0;
  let open = 0;
  let unreadable = 0;
  let failures = 0;
  const visit = async (snap: { data(): unknown }): Promise<void> => {
    let escrow = snap.data() as EscrowDocument;
    try {
      const jobs = await deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).where('escrow_id', '==', escrow.escrow_id).limit(1).get();
      if (jobs.empty) return; // not a hire
      const jobId = (jobs.docs[0].data() as HumanJob).job_id;
      checked += 1;
      const chain = await readChainDispute(deps, escrow);
      if (!chain.ok) { unreadable += 1; return; }
      if (chain.status !== ONCHAIN_ESCROW_STATUS.RESOLVED) {
        if (chain.status === ONCHAIN_ESCROW_STATUS.DISPUTED) open += 1;
        return;
      }
      if (escrow.status === 'funded') {
        escrow = await recordObservedOnchainDispute(deps, escrow, OBSERVED_DISPUTE_REASON, undefined, nowMs);
      }
      if (escrow.status !== 'disputed') return; // a concurrent settle got there first
      await resolveDispute(deps, escrow.escrow_id, false, 'onchain_resolution_observed', { hireJobId: jobId });
      recorded += 1;
    } catch (err) {
      failures += 1;
      console.error('[HireDisputeSweep] could not record an on-chain resolution:', escrow.escrow_id, err);
    }
  };
  // Every candidate is read, a page at a time: a first page full of non-hire or still-open
  // disputes must never hide a hire the chain has already resolved.
  await forEachDocument(deps.db.collection('escrows').where('status', '==', 'disputed'), pageSize, visit);
  await forEachDocument(deps.db.collection('escrows').where('status', '==', 'funded').where('auto_release_at', '<=', nowMs), pageSize, visit);
  return { escrows_checked: checked, resolutions_recorded: recorded, still_open: open, unreadable, failures };
}
