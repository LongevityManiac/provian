/**
 * Agent Bank - Job Board
 *
 * Agent-to-agent job marketplace. Agents post jobs, other agents apply,
 * poster accepts an applicant which auto-creates an escrow, and the
 * assigned worker delivers.
 *
 * Auto-escrow: acceptApplicant() calls createEscrow() from./escrow.ts
 * to reuse all existing escrow validation, PE generation, and on-chain logic.
 *
 * linked-job settlement — payment truth: every job STATUS transition routes through the beneficiary routing
 * institution state machine (`evaluateInstitutionTransition`), the first live
 * consumer of it. The guard runs FIRST on each transition path — suspension check
 * (the relay's agent-suspension state, `wallet.status !== 'active'`) before any
 * other validation or side effect (Security Invariant #3) — and fails closed on
 * any undeclared edge (Unknown = Block). Draft transitions (post/accept/
 * deliver) are record-only; the terminal 'completed'/'refunded' outcomes are
 * ECONOMIC and are written ONLY by the receipt-gated settlement path in
 *./job-settlement.ts (escrow release / dispute-resolution receipts, idempotent
 * by settlement tx hash). Applications are sub-records, not status transitions;
 * they stay governed by the auth middleware's wallet-status enforcement plus
 * the self-apply/duplicate/capacity checks below.
 *
 * Firestore collection: jobs/
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import stableStringify from 'json-stable-stringify';
import {
  SAFETY_LIMITS,
  parsePvtWei,
  type AgentBankDeps,
  type Currency,
  type JobDocument,
  type JobApplication,
  type JobStatus,
  type PostJobRequest,
  type ApplyToJobRequest,
} from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { createEscrow } from './escrow';
import {
  evaluateInstitutionTransition,
  INITIAL,
  type EvaluateTransitionDecision,
} from './institution-state-machine';
import { ValidationError, NotFoundError, ForbiddenError } from './errors';
import { emitBackendCorroboration, resolveTargetPeHash } from '../corroboration/CorroborationManager';
import { isPvtPrincipalEnabledForChain } from './pvt-principal-config';
import { assertSupportedAgentBankChain } from './chain-registry';

import { generatePE } from './pe-utils';
import { createHash } from 'crypto';
import { speechWindowParam, type SpeechWindow } from '../commons/speech-window';
import { deliverableOutputDigests, deliverablePeMetadata, normalizeDeliverable, openThread, postDeliverableMessage, type DeliverableInput } from '../commons/threads';

/**
 * linked-job settlement: evaluate a record-only (draft) job transition through the ONE machine,
 * suspension check FIRST. `killSwitchActive` is the relay's agent-suspension state
 * for the ACTING wallet — a missing/non-'active' status blocks (Unknown =
 * Block; the auth middleware enforces the same state upstream, and passing it
 * through the guard keeps the ordering probe-able at the module boundary).
 * Throws ForbiddenError on a suspended-wallet block; on an illegal edge it throws
 * ValidationError with the caller's established message so route consumers
 * keep their contract. Never returns a blocked decision.
 */
function assertDraftTransition(
  actingWallet: AgentWalletDocument,
  from: string,
  to: string,
  illegalEdgeMessage: string,
): EvaluateTransitionDecision {
  const decision = evaluateInstitutionTransition({
    kind: 'job',
    from,
    to,
    killSwitchActive: actingWallet.status !== 'active',
  });
  if (!decision.allowed) {
    if (decision.reason === 'kill_switch_active') {
      throw new ForbiddenError('Agent wallet is not active');
    }
    // The only other block on a draft path is an undeclared (kind, from, to)
    // edge — i.e. the job is not in the required source state.
    throw new ValidationError(illegalEdgeMessage);
  }
  return decision;
}

/**
 * Post a new job on the job board.
 */
export async function postJob(
  deps: AgentBankDeps,
  walletId: string,
  wallet: AgentWalletDocument,
  body: PostJobRequest,
  // a job post is Commons speech — written under the poster's live presentation window
  // (asserted at the route) and minted at its evidence-class base, budget-bounded by that window.
  window: SpeechWindow,
): Promise<JobDocument> {
  // linked-job settlement: the machine gate runs FIRST — before any validation or write.
  assertDraftTransition(wallet, INITIAL, 'open', 'Job posting is not a legal transition');

  if (!body.title || body.title.length > 200) {
    throw new ValidationError('title is required (max 200 chars)');
  }
  if (!body.description || body.description.length > SAFETY_LIMITS.MAX_JOB_DESCRIPTION_LENGTH) {
    throw new ValidationError(`description is required (max ${SAFETY_LIMITS.MAX_JOB_DESCRIPTION_LENGTH} chars)`);
  }
  if (!Array.isArray(body.required_capabilities) || body.required_capabilities.length === 0) {
    throw new ValidationError('required_capabilities must be a non-empty array');
  }

  // --- Currency routing (Workstream 2). ---
  const currency: Currency = body.currency ?? 'usdc';
  if (currency !== 'usdc' && currency !== 'pvt') {
    throw new ValidationError(`currency must be 'usdc' or 'pvt' (got ${String(currency)})`);
  }
  if (currency === 'pvt') {
    if (!isPvtPrincipalEnabledForChain(body.chain ?? 'base')) {
      throw new ValidationError(`PVT-principal jobs are not enabled for chain '${body.chain ?? 'base'}' on this relay`);
    }
  }

  // --- Chain routing (Wave J-bis + Chunk K M-1). Defaults to 'base' for
  // back-compat with pre-multichain SDKs. The auto-escrow created on accept
  // inherits this chain so the job → escrow path stays single-chain.
  const chain: string = body.chain ?? 'base';
  assertSupportedAgentBankChain(chain);

  // --- Currency-specific budget validation ---
  let budgetUsdc = 0;
  let budgetPvtWei: bigint = 0n;
  if (currency === 'usdc') {
    if (body.budget_usdc === undefined) {
      throw new ValidationError('budget_usdc is required when currency is usdc');
    }
    // F39 (guard extension): reject a non-number / non-finite budget BEFORE
    // the range check (`undefined <= 0` / `"50" <= 0` both coerce to false), so a
    // string/NaN budget can never persist and sort among numeric budgets.
    if (typeof body.budget_usdc !== 'number' || !Number.isFinite(body.budget_usdc)) {
      throw new ValidationError('budget_usdc must be a finite number');
    }
    if (body.budget_usdc <= 0 || body.budget_usdc > SAFETY_LIMITS.MAX_JOB_BUDGET_USD) {
      throw new ValidationError(`budget_usdc must be between 0 and ${SAFETY_LIMITS.MAX_JOB_BUDGET_USD}`);
    }
    budgetUsdc = body.budget_usdc;
  } else {
    if (body.budget_pvt === undefined) {
      throw new ValidationError('budget_pvt is required when currency is pvt');
    }
    try {
      budgetPvtWei = parsePvtWei(body.budget_pvt);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
    const maxPvtWei = BigInt(SAFETY_LIMITS.MAX_JOB_BUDGET_USD) * (10n ** 18n);
    if (budgetPvtWei > maxPvtWei) {
      throw new ValidationError(
        `budget_pvt must be ≤ ${SAFETY_LIMITS.MAX_JOB_BUDGET_USD} PVT (atomic ≤ ${maxPvtWei.toString()})`,
      );
    }
  }

  // F39 (guard extension): reject non-finite deadline_hours before the
  // range check and before `now + body.deadline_hours * …`, else an omitted field
  // persists a NaN deadline the scheduler never expires (an open job forever).
  if (typeof body.deadline_hours !== 'number' || !Number.isFinite(body.deadline_hours)) {
    throw new ValidationError('deadline_hours must be a finite number');
  }
  if (body.deadline_hours <= 0 || body.deadline_hours > SAFETY_LIMITS.MAX_JOB_DEADLINE_HOURS) {
    throw new ValidationError(`deadline_hours must be between 1 and ${SAFETY_LIMITS.MAX_JOB_DEADLINE_HOURS}`);
  }

  const now = Date.now();
  const jobId = `job_${uuidv4()}`;
  const deadline = now + body.deadline_hours * 60 * 60 * 1000;

  const doc: JobDocument = {
    job_id: jobId,
    poster_wallet_id: walletId,
    poster_address: wallet.address,
    title: body.title,
    description: body.description,
    required_capabilities: body.required_capabilities,
    currency,
    budget_usdc: budgetUsdc,
    chain,
    deadline_hours: body.deadline_hours,
    deadline,
    status: 'open',
    applications: [],
    pe_ids: [],
    created_at: now,
    updated_at: now,
  };
  if (currency === 'pvt') {
    doc.budget_pvt = budgetPvtWei.toString();
  }

  await deps.db.collection('jobs').doc(jobId).set(doc);

  const peMetadata: Record<string, unknown> = {
    job_id: jobId,
    title: body.title,
    currency,
    required_capabilities: body.required_capabilities,
  };
  if (currency === 'pvt') {
    peMetadata.budget_pvt = budgetPvtWei.toString();
  } else {
    peMetadata.budget_usdc = budgetUsdc;
  }

  peMetadata.verified = true;
  const { peId } = await generatePE(deps, {
    walletId,
    agentId: wallet.agent_id,
    actorAddress: wallet.address,
    ownerType: 'agent',
    actionType: 'job_posted',
    metadata: peMetadata,
    witnessClass: 'relay_verified',
    durableViaOrdinaryIntake: true,
    speechWindow: speechWindowParam(window),
  });

  doc.pe_ids = [peId];
  await deps.db.collection('jobs').doc(jobId).update({ pe_ids: [peId] });

  return doc;
}

/**
 * List available (open) jobs with optional capability filter.
 */
export type ListAvailableJobsSort = 'budget_desc' | 'budget_asc' | 'posted_desc' | 'deadline_asc';

export interface ListAvailableJobsFilters {
  capability?: string;
  /** USDC budget floor. PVT jobs bypass this filter (different currency dimension). */
  min_budget?: number;
  /** USDC budget ceiling. PVT jobs bypass this filter. */
  max_budget?: number;
  /**
   * Sort key. Defaults to posted_desc.
   *   - budget_desc / budget_asc: order by budget_usdc (Firestore can
   *     only orderBy a single field; PVT jobs interleave by their
   *     budget_usdc which is 0). Phase-2 follow-up: a unified
   *     budget-rank field that compares PVT and USDC apples-to-apples.
   *   - deadline_asc: order by deadline (closest first).
   */
  sort?: ListAvailableJobsSort;
  limit?: number;
  offset?: number;
  /** 1-indexed page number. Computed as offset = (page - 1) * limit when offset is not also set. */
  page?: number;
}

export async function listAvailableJobs(
  deps: AgentBankDeps,
  filters: ListAvailableJobsFilters,
): Promise<JobDocument[]> {
  const limit = Math.min(filters.limit || 50, 100);
  // offset is canonical. page is convenience syntax for clients that
  // think in pages rather than item offsets. When both are supplied
  // offset wins (it is the lower-level primitive); when only page is
  // supplied we derive offset = (page - 1) * limit.
  let offset: number;
  if (filters.offset !== undefined) {
    offset = Math.max(filters.offset, 0);
  } else if (filters.page !== undefined && filters.page >= 1) {
    offset = (filters.page - 1) * limit;
  } else {
    offset = 0;
  }

  let query: FirebaseFirestore.Query = deps.db.collection('jobs')
    .where('status', '==', 'open');

  if (filters.capability) {
    query = query.where('required_capabilities', 'array-contains', filters.capability);
  }

  const sort: ListAvailableJobsSort = filters.sort ?? 'posted_desc';
  switch (sort) {
    case 'budget_desc':
      query = query.orderBy('budget_usdc', 'desc');
      break;
    case 'budget_asc':
      query = query.orderBy('budget_usdc', 'asc');
      break;
    case 'deadline_asc':
      query = query.orderBy('deadline', 'asc');
      break;
    case 'posted_desc':
    default:
      query = query.orderBy('created_at', 'desc');
      break;
  }
  query = query.limit(limit).offset(offset);

  const snap = await query.get();
  let results = snap.docs.map((doc) => doc.data() as JobDocument);

  if (filters.min_budget !== undefined) {
    // min_budget filters USDC jobs by budget_usdc. PVT jobs bypass this
    // filter - a PVT-budget filter belongs in a separate
    // `min_budget_pvt` param. Deferred follow-up.
    results = results.filter((j) => (j.currency ?? 'usdc') !== 'usdc' || j.budget_usdc >= filters.min_budget!);
  }
  if (filters.max_budget !== undefined) {
    // Symmetry with min_budget: USDC-only ceiling.
    results = results.filter((j) => (j.currency ?? 'usdc') !== 'usdc' || j.budget_usdc <= filters.max_budget!);
  }

  return results;
}

/**
 * Apply to a job.
 */
export async function applyToJob(
  deps: AgentBankDeps,
  jobId: string,
  walletId: string,
  wallet: AgentWalletDocument,
  body: ApplyToJobRequest,
): Promise<JobDocument> {
  // the application IS a thread (the E2E `message` opens it); a plaintext `proposal` is
  // the legacy one-shot form, still accepted and bounded.
  const hasMessage = body.message !== undefined && body.message !== null;
  if (!hasMessage && (!body.proposal || body.proposal.length > 1000)) {
    throw new ValidationError('an application needs a message (E2E) or a proposal (max 1000 chars)');
  }
  if (body.proposal && body.proposal.length > 1000) {
    throw new ValidationError('proposal must be at most 1000 chars');
  }

  const docRef = deps.db.collection('jobs').doc(jobId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new NotFoundError('Job not found');
  }

  const job = doc.data() as JobDocument;

  if (job.status !== 'open') {
    throw new ValidationError('Job is no longer open');
  }

  if (job.poster_wallet_id === walletId) {
    throw new ValidationError('Cannot apply to your own job');
  }

  if (job.applications.some((a) => a.wallet_id === walletId)) {
    throw new ValidationError('Already applied to this job');
  }

  if (job.applications.length >= SAFETY_LIMITS.MAX_JOB_APPLICATIONS) {
    throw new ValidationError('Maximum number of applications reached');
  }

  // the application IS a thread (poster ↔ applicant) — opened FIRST, so an applicant with
  // no relationship to the poster and no live speech window is refused (428) before anything is
  // written. A cold contact opens with one presentation; the refusal propagates to the route.
  await openThread(deps, { walletId, agentId: wallet.agent_id, actorAddress: wallet.address, isAgent: true }, {
    anchor: { kind: 'job', id: jobId },
    counterparty: job.poster_wallet_id,
    message: hasMessage
      ? { kind: 'text', ciphertexts: (body.message as { ciphertexts?: unknown }).ciphertexts, content_sha256: (body.message as { content_sha256?: unknown }).content_sha256, attachment: { application: true } }
      : { kind: 'text', ciphertexts: {}, attachment: { application: true, proposal_sha256: createHash('sha256').update(body.proposal ?? '').digest('hex') } },
  });

  const application: JobApplication = {
    wallet_id: walletId,
    agent_id: wallet.agent_id,
    address: wallet.address,
    proposal: body.proposal ?? '',
    applied_at: Date.now(),
  };

  const { FieldValue } = await import('firebase-admin/firestore');
  await docRef.update({
    applications: FieldValue.arrayUnion(application),
    updated_at: Date.now(),
  });

  await generatePE(deps, {
    walletId,
    agentId: wallet.agent_id,
    actorAddress: wallet.address,
    actionType: 'job_applied',
    metadata: {
      job_id: jobId,
      title: job.title,
      poster_wallet_id: job.poster_wallet_id,
    },
    counterpartyAddress: job.poster_address,
  });

  return {
    ...job,
    applications: [...job.applications, application],
  };
}

/**
 * Accept an applicant for a job. Creates an auto-escrow.
 * Only the poster can accept.
 */
export async function acceptApplicant(
  deps: AgentBankDeps,
  jobId: string,
  applicantWalletId: string,
  posterWalletId: string,
  posterWallet: AgentWalletDocument,
): Promise<{ job: JobDocument; escrow_id: string }> {
  const docRef = deps.db.collection('jobs').doc(jobId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new NotFoundError('Job not found');
  }

  const job = doc.data() as JobDocument;

  // linked-job settlement: machine gate FIRST (suspension check → Unknown=Block on the open→assigned
  // edge) — before ownership/applicant validation and before the auto-escrow.
  assertDraftTransition(posterWallet, job.status, 'assigned', 'Job is no longer open');

  if (job.poster_wallet_id !== posterWalletId) {
    throw new ForbiddenError('Only the job poster can accept applicants');
  }

  const applicant = job.applications.find((a) => a.wallet_id === applicantWalletId);
  if (!applicant) {
    throw new NotFoundError('Applicant not found');
  }

  // Create auto-escrow: poster is depositor, applicant is recipient.
  // The auto-escrow inherits the job's currency AND chain end-to-end so the
  // job → application → escrow → release chain is single-currency, single-chain.
  // Pre-Chunk-K legacy jobs without a chain field fall back to 'base'.
  const jobCurrency = job.currency ?? 'usdc';
  const jobChain = (job as JobDocument & { chain?: string }).chain ?? 'base';
  const escrow = await createEscrow(deps, {
    depositor_wallet_id: posterWalletId,
    recipient_wallet_id: applicantWalletId,
    currency: jobCurrency,
    ...(jobCurrency === 'pvt'
      ? { amount_pvt: job.budget_pvt }
      : { amount_usdc: job.budget_usdc }),
    description: `Job: ${job.title}`,
    deliverables: job.description,
    deadline_hours: job.deadline_hours,
    auto_release_hours: Math.min(job.deadline_hours, SAFETY_LIMITS.MAX_AUTO_RELEASE_HOURS),
    chain: jobChain,
  });

  const now = Date.now();
  try {
    await docRef.update({
      status: 'assigned',
      assigned_wallet_id: applicantWalletId,
      assigned_address: applicant.address,
      escrow_id: escrow.escrow_id,
      updated_at: now,
    });
  } catch (err) {
    // Rollback: delete orphaned escrow if job update fails
    await deps.db.collection('escrows').doc(escrow.escrow_id).delete();
    throw err;
  }

  // PE metadata for both poster and applicant - currency-aware.
  const acceptMeta = (counterpartyKey: 'applicant_wallet_id' | 'poster_wallet_id', counterpartyId: string) => {
    const m: Record<string, unknown> = {
      job_id: jobId,
      [counterpartyKey]: counterpartyId,
      escrow_id: escrow.escrow_id,
      currency: jobCurrency,
    };
    if (jobCurrency === 'pvt') {
      m.budget_pvt = job.budget_pvt;
    } else {
      m.budget_usdc = job.budget_usdc;
    }
    return m;
  };

  await generatePE(deps, {
    walletId: posterWalletId,
    agentId: posterWallet.agent_id,
    actorAddress: posterWallet.address,
    actionType: 'job_accepted',
    metadata: acceptMeta('applicant_wallet_id', applicantWalletId),
    counterpartyAddress: applicant.address,
  });

  await generatePE(deps, {
    walletId: applicantWalletId,
    agentId: applicant.agent_id,
    actorAddress: applicant.address,
    actionType: 'job_accepted',
    metadata: acceptMeta('poster_wallet_id', posterWalletId),
    counterpartyAddress: posterWallet.address,
  });

  const updatedJob: JobDocument = {
    ...job,
    status: 'assigned',
    assigned_wallet_id: applicantWalletId,
    assigned_address: applicant.address,
    escrow_id: escrow.escrow_id,
    updated_at: now,
  };

  return { job: updatedJob, escrow_id: escrow.escrow_id };
}

/**
 * Mark a job as delivered. Only the assigned worker can deliver.
 */
export async function deliverJob(
  deps: AgentBankDeps,
  jobId: string,
  walletId: string,
  wallet: AgentWalletDocument,
  // the delivery carries a deliverable (URI and/or body); its sha256 is sealed on the PE.
  deliverableInput?: DeliverableInput | null,
): Promise<JobDocument> {
  const deliverable = normalizeDeliverable(deliverableInput);
  const docRef = deps.db.collection('jobs').doc(jobId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new NotFoundError('Job not found');
  }

  const job = doc.data() as JobDocument;

  // linked-job settlement: machine gate FIRST (suspension check → Unknown=Block on the
  // assigned→delivered edge) — before the worker-ownership check.
  assertDraftTransition(wallet, job.status, 'delivered', 'Job must be in assigned status to deliver');

  if (job.assigned_wallet_id !== walletId) {
    throw new ForbiddenError('Only the assigned worker can deliver');
  }

  const now = Date.now();
  await docRef.update({
    status: 'delivered',
    delivered_at: now,
    updated_at: now,
    ...(deliverable ? { deliverable: { uri: deliverable.uri, body: deliverable.body, sha256: deliverable.sha256, delivered_at: now } } : {}),
  });

  const { peId: deliveryPeId } = await generatePE(deps, {
    walletId,
    agentId: wallet.agent_id,
    actorAddress: wallet.address,
    actionType: 'job_delivered',
    metadata: {
      job_id: jobId,
      title: job.title,
      poster_wallet_id: job.poster_wallet_id,
      escrow_id: job.escrow_id,
      ...(deliverable ? deliverablePeMetadata(deliverable) : {}),
    },
    ...(deliverable ? { output_digests: deliverableOutputDigests(deliverable) } : {}),
    counterpartyAddress: job.poster_address,
  });
  if (deliverable) {
    await postDeliverableMessage(
      deps, { walletId, agentId: wallet.agent_id, actorAddress: wallet.address, isAgent: true },
      'job', jobId, job.poster_wallet_id, deliverable, deliveryPeId,
    );
  }

  // Corroboration: job delivery confirms the job's creation (job_posted) PE,
  // mirroring escrow/promise which corroborate their creation PE.
  // Pass-2 #5: fetch the REAL target PE hash (was hardcoded '' which the
  // CorroborationManager falsy-guard rejected, so job_delivery_accepted never
  // fired). Mirror the github-webhook fetch-then-skip-if-absent pattern; a
  // genuinely-missing target is skipped, never a valid signal suppressed (#8).
  //
  // Target the CREATION PE explicitly via pe_ids[0]. The prior `pe_ids[last]`
  // intended the job_accepted PE, but acceptApplicant never appends the
  // job_accepted PE id to pe_ids (createJob sets pe_ids=[job_posted] and nothing
  // appends after), so in production pe_ids has exactly one element and [last]
  // already resolved to job_posted. Using [0] is explicit + robust if pe_ids
  // ever grows. (Whether to also append + corroborate the job_accepted PE is a
  // separate data-model decision — see OPEN_ITEMS.)
  const acceptedPeId = job.pe_ids?.[0];
  if (acceptedPeId) {
    void (async () => {
      const targetPeHash = await resolveTargetPeHash(deps, acceptedPeId);
      if (!targetPeHash) {
        console.warn(`[Job] Corroboration skipped: no resolvable hash for target PE ${acceptedPeId}`);
        return;
      }
      await emitBackendCorroboration(deps, {
        targetPeId: acceptedPeId,
        targetPeHash,
        signalType: 'job_delivery_accepted',
        corroboratingParty: walletId,
        evidence: JSON.stringify({ job_id: jobId, delivered_at: now, escrow_id: job.escrow_id }),
        evidenceRef: jobId,
        walletId,
        agentId: wallet.agent_id,
        actorAddress: wallet.address,
      });
    })().catch((err) => console.warn('[Job] Corroboration emit failed:', err));
  }

  return {
    ...job,
    status: 'delivered',
    delivered_at: now,
    updated_at: now,
  };
}

export type MyJobsRole = 'posted' | 'assigned';
export type MyJobsSort = 'posted_desc' | 'posted_asc' | 'updated_desc';

export interface MyJobsFilters {
  /** Filter by job status (open / assigned / delivered / completed / cancelled). */
  status?: JobStatus;
  /** Restrict to one side of the relationship; default is both. */
  role?: MyJobsRole;
  /** Page size. Default 50, max 200. */
  limit?: number;
  /** Pagination offset. Default 0. */
  offset?: number;
  /** Sort order. Default 'posted_desc'. */
  sort?: MyJobsSort;
}

export interface MyJobsResult {
  posted: JobDocument[];
  assigned: JobDocument[];
  /**
   * Total matches across both sides of the relationship after applying
   * status + role filters but before limit/offset. Computed via Firestore
   * count() aggregation, so it is the true total, not the page size.
   */
  total: number;
  /**
   * True when there are still unread results past this page on either
   * side. Computed as (offset + max(posted.length, assigned.length)) < total
   * after applying limits per side.
   */
  has_more: boolean;
}

const DEFAULT_MY_JOBS_LIMIT = 50;
const MAX_MY_JOBS_LIMIT = 200;

function applySort(query: FirebaseFirestore.Query, sort: MyJobsSort): FirebaseFirestore.Query {
  switch (sort) {
    case 'posted_asc':
      return query.orderBy('created_at', 'asc');
    case 'updated_desc':
      return query.orderBy('updated_at', 'desc');
    case 'posted_desc':
    default:
      return query.orderBy('created_at', 'desc');
  }
}

/**
 * Get jobs posted by or assigned to a wallet, with status/role filters,
 * pagination, and sort. Returns total + has_more so a paginated UI can
 * render correctly.
 *
 * `role` defaults to both, in which case `posted` and `assigned` are
 * fetched in parallel; each side is independently capped by `limit`
 * (so a default-call returns up to 50 of each, matching pre-filter
 * behavior). `total` is the sum of the two server-side counts; that
 * means a single doc that appeared in both queries (would only happen
 * if a wallet posted a job and was somehow also assigned to it, which
 * the backend forbids at apply time) would be counted twice. The
 * apply-self check at applyToJob(jobs.ts:218-220) makes this
 * impossible in practice.
 */
export async function getMyJobs(
  deps: AgentBankDeps,
  walletId: string,
  filters: MyJobsFilters = {},
): Promise<MyJobsResult> {
  const limit = Math.min(filters.limit ?? DEFAULT_MY_JOBS_LIMIT, MAX_MY_JOBS_LIMIT);
  const offset = Math.max(filters.offset ?? 0, 0);
  const sort: MyJobsSort = filters.sort ?? 'posted_desc';

  const wantPosted = filters.role === undefined || filters.role === 'posted';
  const wantAssigned = filters.role === undefined || filters.role === 'assigned';

  const buildQuery = (field: 'poster_wallet_id' | 'assigned_wallet_id') => {
    let q: FirebaseFirestore.Query = deps.db.collection('jobs').where(field, '==', walletId);
    if (filters.status) {
      q = q.where('status', '==', filters.status);
    }
    return q;
  };

  // Parallel fetches: count + page per side. Skip the side entirely when
  // role filter excludes it, returning empty arrays / zero counts so the
  // arithmetic at the bottom of this function still works.
  const postedQuery = wantPosted ? buildQuery('poster_wallet_id') : null;
  const assignedQuery = wantAssigned ? buildQuery('assigned_wallet_id') : null;

  const [postedTotalSnap, postedSnap, assignedTotalSnap, assignedSnap] = await Promise.all([
    postedQuery ? postedQuery.count().get() : null,
    postedQuery ? applySort(postedQuery, sort).limit(limit).offset(offset).get() : null,
    assignedQuery ? assignedQuery.count().get() : null,
    assignedQuery ? applySort(assignedQuery, sort).limit(limit).offset(offset).get() : null,
  ]);

  const posted = postedSnap ? postedSnap.docs.map((d) => d.data() as JobDocument) : [];
  const assigned = assignedSnap ? assignedSnap.docs.map((d) => d.data() as JobDocument) : [];
  const postedTotal = postedTotalSnap ? postedTotalSnap.data().count : 0;
  const assignedTotal = assignedTotalSnap ? assignedTotalSnap.data().count : 0;
  const total = postedTotal + assignedTotal;

  // has_more: either side has more results past this page. We check the
  // per-side count rather than the combined total because limit/offset
  // are applied per-side.
  const has_more =
    (postedQuery !== null && offset + posted.length < postedTotal) ||
    (assignedQuery !== null && offset + assigned.length < assignedTotal);

  return { posted, assigned, total, has_more };
}
