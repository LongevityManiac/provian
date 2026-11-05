import { computeWalletAttestationTier } from './wallet-reads';
/**
 * Provian Commons - Human Jobs
 *
 * Agents hiring humans. Auto-escrow on acceptance via existing createEscrow().
 * Bidirectional PE-attested ratings. Court-backed dispute resolution.
 */

import { v4 as uuidv4 } from 'uuid';
import { generatePE } from '../agent-bank/pe-utils';
import { isAgentPartyId, speechWindowParam, type SpeechWindow } from './speech-window';
import { deliverableOutputDigests, deliverablePeMetadata, normalizeDeliverable, openThread, postDeliverableMessage, type DeliverableInput } from './threads';
import { createHash } from 'crypto';
import { createEscrow, completeEscrow, verifyFunding, resolveEscrowContractForDocument } from '../agent-bank/escrow';
import { chainIdForName, escrowUsdcAddressForChain, escrowV4AddressForChain, type AgentBankChain } from '../agent-bank/chain-registry';
import { usdcTokenAddressForChainId } from '../onchain/tx-verifier';
import { settleLinkedHumanJob, settlementReceipt } from '../agent-bank/job-settlement';
import { getPvtPrincipalChainString, getPvtAddressForChain } from '../agent-bank/pvt-principal-config';
import { parsePvtWei, type EscrowDocument } from '../agent-bank/types';
import { ValidationError, NotFoundError, ForbiddenError } from '../agent-bank/errors';
import { acceptAttachedOutputSignature } from './attached-output-signature';
import { deliverableOutputText, jobPostOutputText } from '../meter/output-signature';
import { isHiddenPrelaunchTest } from './public-visibility';
import { notifyJobCounterparty } from './job-notify';
import {
  COMMONS_SAFETY_LIMITS,
  COMMONS_COLLECTIONS,
  type CommonsDeps,
  type HumanJob,
  type HumanJobApplication,
  type HumanJobCurrency,
  type HumanJobDirection,
  type HumanJobSeeking,
  type HumanJobRating,
  type PostHumanJobRequest,
  HUMAN_JOB_DIRECTIONS,
  type ApplyHumanJobRequest,
  type RateJobRequest,
} from './types';

const L = COMMONS_SAFETY_LIMITS;
// Note: MAX_HUMAN_JOB_BUDGET_USD in COMMONS_SAFETY_LIMITS still applies to the
// legacy USDC back-compat path (tied to V3 escrow safety limits). New PVT-path
// posts have no numeric ceiling - BigInt is arbitrary precision, mirroring the
// USDC dollar number would be invented policy, not a technical constraint.

/**
 * Chain the human-jobs auto-escrow funds PVT on. DERIVED from the env-driven
 * PVT-principal config (`getPvtPrincipalChainString`) — the same source that
 * supplies the PVT token address — NOT a hardcoded literal. The post-time gate
 * (C5) and acceptApplicant's `createEscrow` both call this, so the chain they
 * use can never drift apart, and it always traces to whichever chain env
 * actually configures a PVT principal address for (Base by default; PVT is
 * Base-only). `null` ⇒ no PVT-principal chain configured ⇒ posting is closed
 * (Unknown = Block).
 */
function resolveHumanJobEscrowChain(): string | null {
  return getPvtPrincipalChainString();
}

/**
 * the chain a USDC hire escrows on, or null when no escrow contract on this relay
 * carries the ruled dispute fallback for USDC.
 *
 * Every Commons hire must reach the ruled fallback (admin path + the 30-day permissionless
 * refund, `claimDisputeTimeout`). That refund exists ONLY on ProvianEscrowV4; the legacy V3
 * USDC contract has no timeout. So a USDC hire is admitted only when the relay's USDC escrow
 * address for Base IS the V4 contract (on the live stack both env keys name the same V4
 * address, which holds Base USDC and PVT). Anything else — unset, or a V3 address — refuses
 * the post (Unknown = Block): a USDC escrow without the refund would strand a disputed payment.
 */
export function resolveUsdcHireEscrowChain(): AgentBankChain | null {
  const chain: AgentBankChain = 'base';
  const usdcEscrow = escrowUsdcAddressForChain(chain);
  const v4Escrow = escrowV4AddressForChain(chain);
  if (!usdcEscrow || !v4Escrow) return null;
  if (usdcEscrow.toLowerCase() !== v4Escrow.toLowerCase()) return null;
  if (!usdcTokenAddressForChainId(chainIdForName(chain))) return null;
  return chain;
}

/** The currency a job pays in (legacy rows: PVT when budget_pvt is set, else the pre-W3 USDC path). */
export function jobCurrencyOf(job: Pick<HumanJob, 'currency' | 'budget_pvt' | 'compensation_amount'>): HumanJobCurrency {
  if (job.currency === 'pvt' || job.currency === 'usdc') return job.currency;
  if (job.budget_pvt && job.budget_pvt !== '0') return 'pvt';
  if (job.compensation_amount && job.compensation_amount > 0) return 'usdc';
  return 'pvt';
}

/** Who a job hires. Legacy rows derive it from `direction` (missing → the original agent_seeking_human). */
export function jobSeekingOf(job: Pick<HumanJob, 'seeking' | 'direction'>): HumanJobSeeking {
  if (job.seeking === 'agent' || job.seeking === 'human') return job.seeking;
  const direction = job.direction ?? 'agent_seeking_human';
  return direction.endsWith('_seeking_agent') ? 'agent' : 'human';
}

/** The listing direction of a job (legacy rows without one are 'agent_seeking_human'). */
export function jobDirectionOf(job: Pick<HumanJob, 'direction'>): HumanJobDirection {
  return job.direction ?? 'agent_seeking_human';
}

const USDC_MAX_DECIMALS_SCALE = 1_000_000;

/** A USDC budget: a finite number > 0, ≤ the Commons cap, with at most 6 decimals (USDC atomic units). */
function parseUsdcBudget(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ValidationError('budget_usdc must be a finite number (USD)');
  }
  if (raw <= 0 || raw > L.MAX_HUMAN_JOB_BUDGET_USD) {
    throw new ValidationError(`budget_usdc must be greater than 0 and at most ${L.MAX_HUMAN_JOB_BUDGET_USD}`);
  }
  const scaled = raw * USDC_MAX_DECIMALS_SCALE;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new ValidationError('budget_usdc supports at most 6 decimal places');
  }
  return raw;
}

// ─── Post Job ───────────────────────────────────────────────────────────────

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
function evmAddressOrNull(value: unknown): string | null {
  return typeof value === 'string' && EVM_ADDRESS.test(value.trim()) ? value.trim() : null;
}

/**
 * F-A1-5 — resolve the poster's on-chain EVM address at PERSIST time so the
 * completion verifier can pay a genuine off-chain delivery.
 *
 * The Commons session-token branch passes a resolved address OR null (d06cc643
 * stopped the wallet-id-as-address bug). A null `poster_address` refuses the
 * deliverer's off-chain completion earning (`refused_completion_counterparty_
 * unresolvable`). The deliverer's PRIMARY pay — the on-chain escrow release —
 * is unaffected, so this is best-effort and NEVER blocks the post; it only
 * guarantees the address is resolvable when the poster has one on record, by
 * consulting the poster's authoritative wallet record under BOTH key shapes
 * (`wallets.user_id ==` and the `wallets`/`agent_wallets` doc id) rather than the
 * single query the auth branch ran. Persist null only when nothing resolves.
 */
async function resolvePosterEvmAddress(
  deps: CommonsDeps,
  walletId: string,
  posterType: 'agent' | 'human',
  actorAddress: string | null,
): Promise<string | null> {
  const passed = evmAddressOrNull(actorAddress);
  if (passed !== null) return passed;
  try {
    if (posterType === 'agent') {
      const snap = await deps.db.collection('agent_wallets').doc(walletId).get();
      return snap.exists ? evmAddressOrNull((snap.data() as { address?: unknown } | undefined)?.address) : null;
    }
    const byUser = await deps.db.collection('wallets').where('user_id', '==', walletId).limit(1).get();
    if (!byUser.empty) {
      const a = evmAddressOrNull((byUser.docs[0].data() as { address?: unknown }).address);
      if (a !== null) return a;
    }
    const byDoc = await deps.db.collection('wallets').doc(walletId).get();
    return byDoc.exists ? evmAddressOrNull((byDoc.data() as { address?: unknown } | undefined)?.address) : null;
  } catch (err) {
    console.warn('[human-jobs] poster address resolution failed', err);
    return null;
  }
}

export async function postHumanJob(
  deps: CommonsDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  body: PostHumanJobRequest,
  // a job post is Commons speech — written under the poster's live presentation window
  // (asserted at the route) and minted at its evidence-class base, budget-bounded by that window.
  window: SpeechWindow,
): Promise<HumanJob> {
  // Rate limit
  const rl = await deps.cache.checkRateLimit(
    `rl:commons:hjob:post:${walletId}`,
    L.RATE_LIMIT_JOB_POST,
    60,
  );
  if (!rl.allowed) {
    throw new ValidationError(`Rate limit exceeded. Retry after ${rl.retryAfter}s`);
  }

  // Verify Commons profile
  const profileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!profileDoc.exists) {
    throw new ForbiddenError('Must be registered on the Commons to post jobs');
  }

  // Validate inputs
  if (!body.title || body.title.trim().length === 0) {
    throw new ValidationError('Title is required');
  }
  if (body.title.length > L.MAX_HUMAN_JOB_TITLE_LENGTH) {
    throw new ValidationError(`Title must be ${L.MAX_HUMAN_JOB_TITLE_LENGTH} characters or fewer`);
  }
  if (!body.description || body.description.trim().length === 0) {
    throw new ValidationError('Description is required');
  }
  if (body.description.length > L.MAX_HUMAN_JOB_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Description must be ${L.MAX_HUMAN_JOB_DESCRIPTION_LENGTH} characters or fewer`);
  }
  if (body.deadline_hours > L.MAX_HUMAN_JOB_DEADLINE_HOURS) {
    throw new ValidationError(`Deadline cannot exceed ${L.MAX_HUMAN_JOB_DEADLINE_HOURS} hours`);
  }
  if (!body.category) {
    throw new ValidationError('Category is required');
  }
  if (!body.location || !body.location.type) {
    throw new ValidationError('Location requirement is required');
  }

  // a Commons hire pays in PVT (budget_pvt, BigInt 18d string) or in USDC (budget_usdc,
  // USD float ≤ 6 decimals), escrowed on the V4 contract that carries the dispute fallback.
  // The legacy pre-W3 `compensation_amount` field stays refused (it never named an escrow
  // contract); USDC rides the explicit `currency: 'usdc'` + `budget_usdc` pair instead.
  if (body.compensation_amount !== undefined && body.compensation_amount > 0) {
    throw new ValidationError(
      'compensation_amount is retired. Set currency and budget_pvt (PVT, BigInt 18d string) ' +
      'or budget_usdc (USDC, USD with at most 6 decimals).',
    );
  }
  const requestedCurrency = body.currency
    ?? (body.budget_usdc !== undefined && body.budget_pvt === undefined ? 'usdc' : 'pvt');
  if (requestedCurrency !== 'pvt' && requestedCurrency !== 'usdc') {
    throw new ValidationError(`currency must be 'pvt' or 'usdc' (got '${String(requestedCurrency)}')`);
  }
  const currency: HumanJobCurrency = requestedCurrency;
  if (body.compensation_currency !== undefined && body.compensation_currency.toLowerCase() !== currency) {
    throw new ValidationError(
      `compensation_currency '${body.compensation_currency}' does not match currency '${currency}'`,
    );
  }

  let budgetPvtWei: bigint = 0n;
  let budgetUsdc = 0;
  if (currency === 'pvt') {
    if (body.budget_pvt === undefined || body.budget_pvt === null || body.budget_pvt === '') {
      throw new ValidationError('budget_pvt is required (BigInt 18-decimal string in PVT atomic units)');
    }
    try {
      budgetPvtWei = parsePvtWei(body.budget_pvt);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
    // C5 (Pass-2 Human-Jobs seams): a PVT-budget job's acceptance auto-escrows in
    // PVT on the configured PVT-principal chain (see acceptApplicant). If NO
    // PVT-principal chain is configured on THIS relay, the accept→createEscrow leg
    // is rejected and the job would be permanently unfillable. Block at POST time.
    // The chain is DERIVED from env (resolveHumanJobEscrowChain), the same source
    // acceptApplicant uses — they can't disagree. Unknown = Block.
    if (resolveHumanJobEscrowChain() === null) {
      throw new ValidationError(
        'PVT-principal human jobs are not enabled on this relay (no PVT-principal chain is configured). ' +
        'A PVT-budget job cannot be posted because its acceptance escrow could not be funded.',
      );
    }
  } else {
    budgetUsdc = parseUsdcBudget(body.budget_usdc);
    if (resolveUsdcHireEscrowChain() === null) {
      throw new ValidationError(
        'USDC hires are not enabled on this relay: no escrow contract with the 30-day dispute refund ' +
        'holds USDC here, so a USDC hire could not reach its dispute fallback.',
      );
    }
  }

  const now = Date.now();
  const jobId = `hjob_${uuidv4()}`;
  const jobRef = deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).doc(jobId);

  const profile = profileDoc.data()!;
  const posterType: 'agent' | 'human' = profile.participant_type === 'agent' ? 'agent' : 'human';
  // F-A1-5: resolve a poster EVM address from the strongest available source, so
  // the off-chain completion path can pay a genuine delivery even when the auth
  // branch's single lookup came back null. Never blocks (the escrow path pays
  // regardless); persists null only if genuinely nothing resolves.
  const resolvedPosterAddress = await resolvePosterEvmAddress(deps, walletId, posterType, actorAddress);
  // who the job hires. `seeking` wins; else an explicit `direction` (which must start with
  // the poster's own kind — a person cannot post an agent's listing); else the legacy default
  // (agents hire people, people hire agents). The direction is always derived from the two.
  let seeking: HumanJobSeeking;
  if (body.seeking !== undefined) {
    if (body.seeking !== 'agent' && body.seeking !== 'human') {
      throw new ValidationError(`seeking must be 'agent' or 'human' (got '${String(body.seeking)}')`);
    }
    seeking = body.seeking;
  } else if (body.direction !== undefined) {
    if (!HUMAN_JOB_DIRECTIONS.includes(body.direction)) {
      throw new ValidationError(`direction must be one of ${HUMAN_JOB_DIRECTIONS.join(', ')}`);
    }
    seeking = body.direction.endsWith('_seeking_agent') ? 'agent' : 'human';
  } else {
    seeking = posterType === 'agent' ? 'human' : 'agent';
  }
  if (seeking === 'agent' && body.requires_identity_verification) {
    throw new ValidationError('The hardware-backed device requirement is supported only for jobs hiring people');
  }
  const direction = `${posterType}_seeking_${seeking}` as HumanJobDirection;
  if (body.direction !== undefined && body.direction !== direction) {
    throw new ValidationError(
      `direction '${body.direction}' does not match this poster (${posterType}) hiring ${seeking}s`,
    );
  }

  // the job post's output is its title + description; the PE seals that hash and
  // the poster's signature over it (verified as theirs before any write) is kept with the job.
  const jobPostHash = createHash('sha256').update(jobPostOutputText(body.title, body.description)).digest('hex');
  const postSignature = await acceptAttachedOutputSignature(deps.db, body.provian_output_signature, jobPostHash, agentId);

  // Pure builder — safe to re-materialise on transaction retry.
  const buildJob = (peId: string): HumanJob => ({
    job_id: jobId,
    pe_id: peId,
    poster_wallet_id: walletId,
    // WS8: store the poster's on-chain address at post time so application /
    // delivery PEs can carry the poster as the real counterparty (previously
    // they mislabeled the actor's own address as "Job poster"). F-A1-5: resolved
    // from the strongest source above so a session-token post is payable.
    poster_address: resolvedPosterAddress,
    poster_attestation_tier: profile.attestation_tier || 'software',
    posted_by_type: posterType,
    direction,
    seeking,
    currency,
    title: body.title.trim(),
    description: body.description.trim(),
    category: body.category,
    skills_required: body.skills_required || [],
    location: body.location,
    compensation_type: body.compensation_type,
    // exactly one budget field, matching `currency`.
    ...(currency === 'pvt' ? { budget_pvt: budgetPvtWei.toString() } : { budget_usdc: budgetUsdc }),
    compensation_currency: currency === 'pvt' ? 'PVT' : 'USDC',
    requires_identity_verification: body.requires_identity_verification ?? false,
    requires_pe_history: body.requires_pe_history ?? false,
    min_promise_fulfillment_rate: body.min_promise_fulfillment_rate,
    status: 'open',
    applicant_count: 0,
    posted_at: now,
    deadline: body.deadline_hours ? now + body.deadline_hours * 60 * 60 * 1000 : undefined,
    ...(postSignature ? { provian_output_signature: postSignature } : {}),
  });

  // Generate PE. WS4: the job document commits in the SAME transaction as the PE
  // + chain-tip advance (atomicEntityWrite), so PE and job are durable-or-nothing
  // together — no job referencing a missing PE, no PE without its job.
  const { peId } = await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    ownerType: posterType,
    actionType: 'human_job_posted',
    metadata: {
      job_id: jobId,
      title: body.title,
      category: body.category,
      compensation_type: body.compensation_type,
      direction,
      currency,
      ...(currency === 'pvt' ? { budget_pvt: budgetPvtWei.toString() } : { budget_usdc: budgetUsdc }),
      verified: true,
    },
    output_digests: [{ hash: `sha256:${jobPostHash}`, kind: 'artifact' }],
    // Commons speech — relay-verified class, durable intake, budgeted under the window.
    witnessClass: 'relay_verified',
    durableViaOrdinaryIntake: true,
    speechWindow: speechWindowParam(window),
    atomicEntityWrite: (txn, generatedPeId) => {
      txn.set(jobRef, buildJob(generatedPeId));
    },
  });

  const job = buildJob(peId);

  // Update profile stats
  const { FieldValue } = await import('firebase-admin/firestore');
  await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .update({
      human_jobs_posted: FieldValue.increment(1),
      updated_at: now,
    });

  return job;
}

// ─── Browse Jobs ────────────────────────────────────────────────────────────

export async function browseHumanJobs(
  deps: CommonsDeps,
  options: {
    category?: string;
    location_type?: string;
    compensation_type?: string;
    status?: string;
    page_size?: number;
    offset?: number;
    /** Filter by listing direction (any of the four). Omit for all. */
    direction?: HumanJobDirection;
    /** filter by who the job hires. */
    seeking?: HumanJobSeeking;
    /** filter by who posted it. */
    posted_by?: 'agent' | 'human';
    /** filter by escrow currency. */
    currency?: HumanJobCurrency;
  },
): Promise<{ jobs: HumanJob[]; total: number }> {
  const pageSize = Math.min(options.page_size || 50, 100);
  const inMemoryFilter = Boolean(options.direction || options.seeking || options.posted_by || options.currency);

  let query = deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS) as FirebaseFirestore.Query;

  if (options.status) {
    query = query.where('status', '==', options.status);
  } else {
    query = query.where('status', '==', 'open');
  }
  if (options.category) {
    query = query.where('category', '==', options.category);
  }
  if (options.location_type) {
    query = query.where('location.type', '==', options.location_type);
  }
  if (options.compensation_type) {
    query = query.where('compensation_type', '==', options.compensation_type);
  }

  // Direction / seeking / poster / currency filters are applied in memory (no composite index
  // per combination; legacy rows derive direction + seeking + currency). When one is present the
  // scan widens to the query cap so a filtered page is not starved by the pre-filter limit.
  query = query.orderBy('posted_at', 'desc').limit(100);
  if (options.offset) {
    query = query.offset(options.offset);
  }

  const snap = await query.get();
  let jobs = snap.docs.map(d => d.data() as HumanJob).filter(j => !isHiddenPrelaunchTest(j));
  if (inMemoryFilter) {
    jobs = jobs.filter((j) => {
      const direction = jobDirectionOf(j);
      if (options.direction && direction !== options.direction) return false;
      if (options.seeking && jobSeekingOf(j) !== options.seeking) return false;
      if (options.posted_by && !direction.startsWith(`${options.posted_by}_`)) return false;
      if (options.currency && jobCurrencyOf(j) !== options.currency) return false;
      return true;
    }).slice(0, pageSize);
  } else {
    jobs = jobs.slice(0, pageSize);
  }
  return { jobs, total: jobs.length };
}

// ─── Market board stats ─────────────────────────────────────────────

export interface MarketBoardStats {
  total_jobs: number;
  open_jobs: number;
  in_progress_jobs: number;
  completed_jobs: number;
  disputed_jobs: number;
  refunded_jobs: number;
  /** Open jobs per direction (who posted → who it hires). */
  open_by_direction: Record<HumanJobDirection, number>;
  /** Open jobs per escrow currency. */
  open_by_currency: Record<HumanJobCurrency, number>;
  dispute_rate: number;
  timestamp: string;
}

/**
 * counts over THE hiring board (Commons jobs, all four directions). Replaces the old
 * `getMarketStats`, which scanned the retired agent-only `jobs` collection. Structural counts
 * only — no party ids, no amounts.
 */
export async function getMarketBoardStats(deps: CommonsDeps): Promise<MarketBoardStats> {
  const cacheKey = 'commons:market_board_stats:public-v2';
  const cached = await deps.cache.get<string>(cacheKey);
  if (cached) return (typeof cached === 'string' ? JSON.parse(cached) : cached) as MarketBoardStats;

  const snap = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .select('status', 'direction', 'seeking', 'currency', 'budget_pvt', 'compensation_amount', 'public_visibility')
    .limit(5000)
    .get();
  const open_by_direction: Record<HumanJobDirection, number> = {
    agent_seeking_human: 0, human_seeking_agent: 0, agent_seeking_agent: 0, human_seeking_human: 0,
  };
  const open_by_currency: Record<HumanJobCurrency, number> = { pvt: 0, usdc: 0 };
  let total = 0, open = 0, inProgress = 0, completed = 0, disputed = 0, refunded = 0;
  for (const doc of snap.docs) {
    const j = doc.data() as HumanJob;
    if (isHiddenPrelaunchTest(j)) continue;
    total++;
    switch (j.status) {
      case 'open':
        open++;
        open_by_direction[jobDirectionOf(j)]++;
        open_by_currency[jobCurrencyOf(j)]++;
        break;
      case 'in_progress': inProgress++; break;
      case 'completed': completed++; break;
      case 'disputed': disputed++; break;
      case 'refunded': refunded++; break;
      default: break;
    }
  }
  const stats: MarketBoardStats = {
    total_jobs: total,
    open_jobs: open,
    in_progress_jobs: inProgress,
    completed_jobs: completed,
    disputed_jobs: disputed,
    refunded_jobs: refunded,
    open_by_direction,
    open_by_currency,
    dispute_rate: total > 0 ? disputed / total : 0,
    timestamp: new Date().toISOString(),
  };
  await deps.cache.set(cacheKey, JSON.stringify(stats), 30);
  return stats;
}

// ─── Get My Human Jobs ──────────────────────────────────────────────────────
//
// Mirrors getMyJobs on the agent-to-agent surface (jobs.ts:getMyJobs). The
// HumanJob document does not carry an `updated_at` field, so the sort enum
// is narrower than the agent-to-agent equivalent: only posted_desc and
// posted_asc are exposed here. Callers who want activity-recency sorting
// should use the agent-to-agent endpoint instead, where `updated_at` exists.

export type MyHumanJobsRole = 'posted' | 'assigned';
export type MyHumanJobsSort = 'posted_desc' | 'posted_asc';

export interface MyHumanJobsFilters {
  status?: 'open' | 'in_progress' | 'completed' | 'disputed' | 'cancelled' | 'refunded';
  role?: MyHumanJobsRole;
  limit?: number;
  offset?: number;
  sort?: MyHumanJobsSort;
}

export interface MyHumanJobsResult {
  posted: HumanJob[];
  assigned: HumanJob[];
  total: number;
  has_more: boolean;
  /**
   * the jobs the caller has applied to (any application state). The relay refuses a second
   * application to the same job, so the app shows "You applied" instead of an Apply that can only
   * fail. Present on the unfiltered (no `role`) read only.
   */
  applied_job_ids?: string[];
}

const MAX_APPLIED_JOB_IDS = 200;

const DEFAULT_MY_HUMAN_JOBS_LIMIT = 50;
const MAX_MY_HUMAN_JOBS_LIMIT = 200;

function applyHumanJobsSort(
  query: FirebaseFirestore.Query,
  sort: MyHumanJobsSort,
): FirebaseFirestore.Query {
  return sort === 'posted_asc'
    ? query.orderBy('posted_at', 'asc')
    : query.orderBy('posted_at', 'desc');
}

export async function getMyHumanJobs(
  deps: CommonsDeps,
  walletId: string,
  filters: MyHumanJobsFilters = {},
): Promise<MyHumanJobsResult> {
  const limit = Math.min(filters.limit ?? DEFAULT_MY_HUMAN_JOBS_LIMIT, MAX_MY_HUMAN_JOBS_LIMIT);
  const offset = Math.max(filters.offset ?? 0, 0);
  const sort: MyHumanJobsSort = filters.sort ?? 'posted_desc';

  const wantPosted = filters.role === undefined || filters.role === 'posted';
  const wantAssigned = filters.role === undefined || filters.role === 'assigned';

  const buildQuery = (field: 'poster_wallet_id' | 'accepted_applicant_wallet_id') => {
    let q: FirebaseFirestore.Query = deps.db
      .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
      .where(field, '==', walletId);
    if (filters.status) {
      q = q.where('status', '==', filters.status);
    }
    return q;
  };

  const postedQuery = wantPosted ? buildQuery('poster_wallet_id') : null;
  const assignedQuery = wantAssigned ? buildQuery('accepted_applicant_wallet_id') : null;

  const [postedTotalSnap, postedSnap, assignedTotalSnap, assignedSnap] = await Promise.all([
    postedQuery ? postedQuery.count().get() : null,
    postedQuery ? applyHumanJobsSort(postedQuery, sort).limit(limit).offset(offset).get() : null,
    assignedQuery ? assignedQuery.count().get() : null,
    assignedQuery ? applyHumanJobsSort(assignedQuery, sort).limit(limit).offset(offset).get() : null,
  ]);

  const posted = postedSnap ? postedSnap.docs.map((d) => d.data() as HumanJob) : [];
  const assigned = assignedSnap ? assignedSnap.docs.map((d) => d.data() as HumanJob) : [];
  const postedTotal = postedTotalSnap ? postedTotalSnap.data().count : 0;
  const assignedTotal = assignedTotalSnap ? assignedTotalSnap.data().count : 0;
  const total = postedTotal + assignedTotal;

  const has_more =
    (postedQuery !== null && offset + posted.length < postedTotal) ||
    (assignedQuery !== null && offset + assigned.length < assignedTotal);

  if (filters.role !== undefined) return { posted, assigned, total, has_more };
  const appliedSnap = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS)
    .where('applicant_wallet_id', '==', walletId)
    .limit(MAX_APPLIED_JOB_IDS)
    .get();
  const applied_job_ids = [...new Set(appliedSnap.docs.map((d) => String((d.data() as { job_id?: unknown }).job_id ?? '')).filter(Boolean))];
  return { posted, assigned, total, has_more, applied_job_ids };
}

// ─── Get Job Detail ─────────────────────────────────────────────────────────

export async function getHumanJob(
  deps: CommonsDeps,
  jobId: string,
): Promise<HumanJob> {
  const doc = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .get();
  if (!doc.exists) {
    throw new NotFoundError('Job not found');
  }
  return doc.data() as HumanJob;
}

// ─── Get Job Categories ─────────────────────────────────────────────────────

export async function getJobCategories(
  deps: CommonsDeps,
): Promise<{ category: string; count: number }[]> {
  const snap = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .where('status', '==', 'open')
    .get();

  const counts: Record<string, number> = {};
  snap.docs.forEach(d => {
    if (isHiddenPrelaunchTest(d.data())) return;
    const cat = (d.data() as HumanJob).category;
    counts[cat] = (counts[cat] || 0) + 1;
  });

  return Object.entries(counts)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

// ─── Apply for Job ──────────────────────────────────────────────────────────

export async function applyForHumanJob(
  deps: CommonsDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  jobId: string,
  body: ApplyHumanJobRequest,
): Promise<HumanJobApplication> {
  // Rate limit
  const rl = await deps.cache.checkRateLimit(
    `rl:commons:hjob:apply:${walletId}`,
    L.RATE_LIMIT_JOB_APPLY,
    60,
  );
  if (!rl.allowed) {
    throw new ValidationError(`Rate limit exceeded. Retry after ${rl.retryAfter}s`);
  }

  // Verify Commons profile
  const profileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!profileDoc.exists) {
    throw new ForbiddenError('Must be registered on the Commons to apply');
  }

  // Get job
  const jobDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .get();
  if (!jobDoc.exists) {
    throw new NotFoundError('Job not found');
  }

  const job = jobDoc.data() as HumanJob;
  if (isHiddenPrelaunchTest(job)) throw new NotFoundError('Job not found');

  if (job.status !== 'open') {
    throw new ValidationError('Job is not accepting applications');
  }
  if (job.poster_wallet_id === walletId) {
    throw new ValidationError('Cannot apply to your own job');
  }
  // a listing hires one kind of participant. The applicant's kind is derived from its
  // authenticated id (an agent wallet id is `wallet_aw_…`; a person's is its user id), never
  // from anything the caller says about itself.
  const seeking = jobSeekingOf(job);
  const applicantKind: HumanJobSeeking = isAgentPartyId(walletId) ? 'agent' : 'human';
  if (applicantKind !== seeking) {
    throw new ValidationError(
      seeking === 'agent' ? 'This job is hiring agents, not people' : 'This job is hiring people, not agents',
    );
  }
  if (job.applicant_count >= L.MAX_HUMAN_JOB_APPLICATIONS) {
    throw new ValidationError('Job has reached maximum applications');
  }

  // Check requirements
  const profile = profileDoc.data()!;
  if (job.requires_identity_verification) {
    const device = await computeWalletAttestationTier(deps, walletId);
    if (!['hardware_partial', 'hardware_tpm', 'hardware_full', 'hardware'].includes(device.raw_tier)) {
      throw new ValidationError('This job requires a hardware-backed device');
    }
  }
  if (job.requires_pe_history && profile.pe_count === 0) {
    throw new ValidationError('This job requires PE history');
  }
  if (job.min_promise_fulfillment_rate !== undefined &&
      profile.promise_fulfillment_rate < job.min_promise_fulfillment_rate) {
    throw new ValidationError(
      `This job requires a promise fulfillment rate of ${job.min_promise_fulfillment_rate}`,
    );
  }

  // Check for duplicate application
  const existingApp = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS)
    .where('job_id', '==', jobId)
    .where('applicant_wallet_id', '==', walletId)
    .limit(1)
    .get();
  if (!existingApp.empty) {
    throw new ValidationError('Already applied to this job');
  }

  // New account daily application limit
  const accountAgeDays = (Date.now() - profile.commons_join_date) / (1000 * 60 * 60 * 24);
  if (accountAgeDays < L.FORUM_NEW_ACCOUNT_THRESHOLD_DAYS) {
    const dailyKey = `rl:commons:hjob:daily:${walletId}:${new Date().toISOString().slice(0, 10)}`;
    const dailyRl = await deps.cache.checkRateLimit(dailyKey, L.NEW_ACCOUNT_DAILY_APPLICATION_LIMIT, 86400);
    if (!dailyRl.allowed) {
      throw new ValidationError('New accounts are limited to 5 applications per day');
    }
  }

  const now = Date.now();
  const applicationId = `happ_${uuidv4()}`;

  // the application IS a thread (poster ↔ applicant, anchored to the job) — opened FIRST,
  // so an applicant with no relationship to the poster and no live speech window is refused (428)
  // before anything is written. The E2E `message` is its first message; a legacy plaintext cover
  // note opens the thread with an attachment carrying only the note's hash (the note itself stays
  // on the application row, poster-readable as before).
  {
    const hasMessage = body.message !== undefined && body.message !== null;
    await openThread(deps, { walletId, agentId, actorAddress, isAgent: isAgentPartyId(walletId) }, {
      anchor: { kind: 'human_job', id: jobId },
      counterparty: job.poster_wallet_id,
      message: hasMessage
        ? { kind: 'text', ciphertexts: body.message?.ciphertexts, content_sha256: body.message?.content_sha256, attachment: { application: true, application_id: applicationId } }
        : { kind: 'text', ciphertexts: {}, attachment: { application: true, application_id: applicationId, cover_note_sha256: createHash('sha256').update(body.cover_note?.trim() ?? '').digest('hex') } },
    });
  }

  // Generate PE
  const { peId } = await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    actionType: 'human_job_applied',
    metadata: {
      job_id: jobId,
      job_title: job.title,
    },
    // WS8: the counterparty is the JOB POSTER, not the applicant. Use the
    // poster address stored at post time (null for legacy jobs that predate
    // poster_address — null is honest; the applicant's own address was not).
    counterpartyAddress: job.poster_address,
  });

  const application: HumanJobApplication = {
    application_id: applicationId,
    job_id: jobId,
    applicant_wallet_id: walletId,
    pe_id: peId,
    cover_note: body.cover_note?.trim(),
    applied_at: now,
    status: 'pending',
  };

  await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS)
    .doc(applicationId)
    .set(application);

  // Increment applicant count
  const { FieldValue } = await import('firebase-admin/firestore');
  await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .update({ applicant_count: FieldValue.increment(1) });

  return application;
}

// ─── List Applicants (poster-only) ──────────────────────────────────────────
//
// C6 (Pass-2 Human-Jobs seams): the poster needs to SEE who applied before they
// can accept anyone (acceptApplicant takes an applicant_wallet_id). The accept/
// deliver/complete/rate endpoints existed but there was no way to enumerate a
// job's applicants, so the second-actor management UI had nothing to render.
// Poster-only: applications expose other participants' wallet ids + cover notes,
// which only the job owner may see. The Tier-3 sanitizer still strips any
// sensitive profile fields from the response.

/** Public-safe applicant profile snippet attached to an application row. */
export interface HumanJobApplicantSummary {
  display_name?: string;
  attestation_tier?: string;
  pe_count?: number;
  human_jobs_completed?: number;
  human_jobs_avg_rating?: number;
  promise_fulfillment_rate?: number;
}

export interface HumanJobApplicationWithApplicant extends HumanJobApplication {
  applicant: HumanJobApplicantSummary | null;
}

export async function getJobApplications(
  deps: CommonsDeps,
  walletId: string,
  jobId: string,
): Promise<HumanJobApplicationWithApplicant[]> {
  const jobDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .get();
  if (!jobDoc.exists) {
    throw new NotFoundError('Job not found');
  }
  const job = jobDoc.data() as HumanJob;
  if (job.poster_wallet_id !== walletId) {
    throw new ForbiddenError('Only the job poster can view applicants');
  }

  const snap = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS)
    .where('job_id', '==', jobId)
    .get();
  const apps = snap.docs.map((d) => d.data() as HumanJobApplication);

  // Enrich each with a public-safe profile snippet (bounded by
  // MAX_HUMAN_JOB_APPLICATIONS, so a small fixed number of point reads).
  const enriched = await Promise.all(
    apps.map(async (app): Promise<HumanJobApplicationWithApplicant> => {
      const pDoc = await deps.db
        .collection(COMMONS_COLLECTIONS.PROFILES)
        .doc(app.applicant_wallet_id)
        .get();
      const p = pDoc.exists ? pDoc.data()! : null;
      return {
        ...app,
        applicant: p
          ? {
              display_name: p.display_name,
              attestation_tier: p.attestation_tier,
              pe_count: p.pe_count,
              human_jobs_completed: p.human_jobs_completed,
              human_jobs_avg_rating: p.human_jobs_avg_rating,
              promise_fulfillment_rate: p.promise_fulfillment_rate,
            }
          : null,
      };
    }),
  );

  // Newest application first (sorted in-memory to avoid a composite index).
  enriched.sort((a, b) => b.applied_at - a.applied_at);
  return enriched;
}

// ─── Accept Applicant (triggers escrow) ─────────────────────────────────────

export async function acceptApplicant(
  deps: CommonsDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  jobId: string,
  applicantWalletId: string,
): Promise<{ job: HumanJob; escrow_id: string }> {
  // Get job
  const jobDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .get();
  if (!jobDoc.exists) {
    throw new NotFoundError('Job not found');
  }

  const job = jobDoc.data() as HumanJob;

  if (job.poster_wallet_id !== walletId) {
    throw new ForbiddenError('Only the job poster can accept applicants');
  }
  if (job.status !== 'open') {
    throw new ValidationError('Job is not accepting applications');
  }

  // Verify application exists
  const appSnap = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS)
    .where('job_id', '==', jobId)
    .where('applicant_wallet_id', '==', applicantWalletId)
    .limit(1)
    .get();
  if (appSnap.empty) {
    throw new NotFoundError('Application not found');
  }

  // Get applicant wallet info
  const applicantProfileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(applicantWalletId)
    .get();
  if (!applicantProfileDoc.exists) {
    throw new NotFoundError('Applicant profile not found');
  }

  // Create escrow via existing infrastructure - DO NOT duplicate escrow logic.
  //
  // Workstream 3: new human jobs are PVT-only. The auto-escrow inherits the
  // job's PVT budget end-to-end, routing through the V4 escrow contract
  // (no oracle dependency, no auto-conversion). Legacy human jobs that
  // pre-date W3 may still carry a USDC compensation_amount; those route to
  // the V3 USDC escrow for back-compat. acceptApplicant prefers budget_pvt
  // when present and only falls through to the legacy USDC path otherwise.
  let escrowId: string | undefined;
  const deadlineHours = job.deadline
    ? Math.ceil((job.deadline - Date.now()) / (1000 * 60 * 60))
    : 336; // 14 days default

  const jobCurrency = jobCurrencyOf(job);
  if (job.currency === 'usdc') {
    // a USDC hire escrows on the V4 contract (the only escrow with the 30-day dispute
    // refund). Re-derived here from the same guard the post used; refuse if it no longer holds.
    const usdcChain = resolveUsdcHireEscrowChain();
    if (usdcChain === null) {
      throw new ValidationError(
        'USDC hires are not enabled on this relay (no escrow contract with the dispute refund holds USDC); ' +
        'cannot accept this USDC job.',
      );
    }
    const escrow = await createEscrow(deps, {
      depositor_wallet_id: walletId,
      recipient_wallet_id: applicantWalletId,
      currency: 'usdc',
      amount_usdc: job.budget_usdc,
      description: `Commons job: ${job.title}`.substring(0, 1000),
      deliverables: job.description.substring(0, 500),
      deadline_hours: Math.max(deadlineHours, 24),
      auto_release_hours: Math.min(deadlineHours + 72, 336),
      chain: usdcChain,
    });
    escrowId = escrow.escrow_id;
  } else if (job.budget_pvt && job.budget_pvt !== '0') {
    // PVT path (canonical for W3-and-after posts). The escrow chain is DERIVED
    // from the SAME env config the post-gate checked (resolveHumanJobEscrowChain)
    // — they cannot drift. `null` here means PVT principal was disabled after the
    // job was posted; refuse rather than escrow on a guessed chain (Unknown =
    // Block). The auto-release scheduler / a re-post will reconcile.
    const escrowChain = resolveHumanJobEscrowChain();
    if (escrowChain === null) {
      throw new ValidationError(
        'PVT-principal escrow is not enabled on this relay; cannot accept this PVT-budget job.',
      );
    }
    const escrow = await createEscrow(deps, {
      depositor_wallet_id: walletId,
      recipient_wallet_id: applicantWalletId,
      currency: 'pvt',
      amount_pvt: job.budget_pvt,
      description: `Human Job: ${job.title}`,
      deliverables: job.description.substring(0, 500),
      deadline_hours: Math.max(deadlineHours, 24),
      auto_release_hours: Math.min(deadlineHours + 72, 336),
      chain: escrowChain,
    });
    escrowId = escrow.escrow_id;
  } else if (job.compensation_amount && job.compensation_amount > 0) {
    // Legacy USDC path - back-compat for pre-W3 human jobs only (new posts are
    // PVT-only). This is USDC, NOT PVT principal, so the chain is the historical
    // 'base' USDC escrow — unrelated to the PVT-principal config above.
    const escrow = await createEscrow(deps, {
      depositor_wallet_id: walletId,
      recipient_wallet_id: applicantWalletId,
      currency: 'usdc',
      amount_usdc: job.compensation_amount,
      description: `Human Job: ${job.title}`,
      deliverables: job.description.substring(0, 500),
      deadline_hours: Math.max(deadlineHours, 24),
      auto_release_hours: Math.min(deadlineHours + 72, 336),
      chain: 'base',
    });
    escrowId = escrow.escrow_id;
  }

  const now = Date.now();

  // Update job
  await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .update({
      status: 'in_progress',
      accepted_applicant_wallet_id: applicantWalletId,
      escrow_id: escrowId,
    });

  // Update application status
  const appDoc = appSnap.docs[0];
  await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS)
    .doc(appDoc.id)
    .update({ status: 'accepted' });

  // Generate PE - currency-aware metadata so the PE accurately records
  // which currency the auto-escrow was funded in.
  await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    actionType: 'human_job_accepted',
    metadata: {
      job_id: jobId,
      applicant_wallet_id: applicantWalletId,
      escrow_id: escrowId,
      ...(job.currency === 'usdc'
        ? { currency: 'usdc', budget_usdc: job.budget_usdc }
        : jobCurrency === 'pvt'
          ? { currency: 'pvt', budget_pvt: job.budget_pvt }
          : { currency: 'usdc', compensation_amount: job.compensation_amount }),
    },
  });

  const updatedDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .get();
  return {
    job: updatedDoc.data() as HumanJob,
    escrow_id: escrowId || '',
  };
}

// ─── Fund escrow (human depositor) ───────────────────────────────────────────

/**
 * Funding details a human poster needs to fund their job's escrow on-chain.
 *
 * the app builds the SAME three-tx on-chain sequence an agent depositor
 * builds — `createEscrow(escrowId, recipient, amount, autoReleaseAt, PVT)` →
 * `pvt.approve(escrowContract, amount)` → `fundEscrow(escrowId, false)` with
 * the poster's OWN key (non-custodial). To build `createEscrow` it needs the
 * recipient, the amount, and the auto-release deadline; to build `approve` it
 * needs the PVT token address. The `verifyFunding` the relay runs on the
 * submitted tx binds these exactly (`expectedFrom: depositor_address`,
 * `expectedTo: escrowContract`, struct `recipient == recipient_address`,
 * on-chain `autoReleaseAt <= auto_release_at`), so the app MUST use these values
 * verbatim. Poster-only.
 */
export async function getHumanJobEscrowFunding(
  deps: CommonsDeps,
  walletId: string,
  jobId: string,
): Promise<{
  escrow_id: string;
  currency: 'usdc' | 'pvt';
  contract_address: string;
  amount_pvt?: string;
  amount_usdc?: number;
  status: string;
  chain: string;
  depositor_address: string;
  recipient_address: string;
  auto_release_at: number;
  token_address?: string;
  onchain_escrow_id: string | null;
  disputed_at: number | null;
  resolution: string | null;
}> {
  const jobDoc = await deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).doc(jobId).get();
  if (!jobDoc.exists) throw new NotFoundError('Job not found');
  const job = jobDoc.data() as HumanJob;
  // both parties read the escrow (the worker sees whether it is funded / disputed); the
  // values are the on-chain struct's own, public on Base. Funding itself stays poster-only.
  if (job.poster_wallet_id !== walletId && job.accepted_applicant_wallet_id !== walletId) {
    throw new ForbiddenError('Only the job poster or the hired participant can view the escrow');
  }
  if (!job.escrow_id) {
    throw new ValidationError('Job has no escrow (accept an applicant first)');
  }
  const escrowDoc = await deps.db.collection('escrows').doc(job.escrow_id).get();
  if (!escrowDoc.exists) throw new NotFoundError('Escrow not found');
  const escrow = escrowDoc.data() as EscrowDocument;
  const currency = escrow.currency ?? 'usdc';
  const contractAddress = resolveEscrowContractForDocument({ ...escrow, currency });
  return {
    escrow_id: escrow.escrow_id,
    currency,
    contract_address: contractAddress,
    ...(currency === 'pvt' ? { amount_pvt: escrow.amount_pvt } : { amount_usdc: escrow.amount_usdc }),
    status: escrow.status,
    chain: escrow.chain,
    depositor_address: escrow.depositor_address,
    recipient_address: escrow.recipient_address,
    auto_release_at: escrow.auto_release_at,
    // The ERC-20 the poster approves to the escrow contract. PVT: the same canonical source
    // the on-chain PVT verifier reads. USDC : the verifier's own canonical USDC address
    // for the escrow's chain — never a drift-prone literal.
    token_address: currency === 'pvt'
      ? getPvtAddressForChain(escrow.chain) ?? undefined
      : usdcTokenAddressForChainId(chainIdForName(escrow.chain as AgentBankChain)),
    // the on-chain bytes32 id bound at funding — what release / dispute / refund call.
    onchain_escrow_id: escrow.onchain_escrow_id ?? null,
    // the dispute surface the parties act on (status mirrors the relay record).
    disputed_at: escrow.disputed_at ?? null,
    resolution: escrow.resolution ?? null,
  };
}

/**
 * A human poster funds their job's escrow. The poster has already signed the
 * on-chain approve + fund contract call with their OWN wallet (first-party
 * signing, the same path a human uses to send PVT); here they submit the fund
 * tx hash for verification.
 *
 * this reuses the SAME `verifyFunding` the agent escrow route uses — no
 * parallel unsafe path. verifyFunding re-checks on-chain that the transfer came
 * FROM the depositor address INTO the escrow contract for the exact amount, and
 * that the on-chain escrow struct pays OUR recipient on OUR timeline. The caller
 * being the poster (= escrow depositor) is enforced here for a clean 403; the
 * on-chain `expectedFrom: depositor_address` check is the load-bearing guard.
 */
export async function fundHumanJobEscrow(
  deps: CommonsDeps,
  walletId: string,
  jobId: string,
  txHash: string,
): Promise<{ job: HumanJob; escrow: EscrowDocument }> {
  if (!txHash || typeof txHash !== 'string') {
    throw new ValidationError('tx_hash is required');
  }
  const jobDoc = await deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).doc(jobId).get();
  if (!jobDoc.exists) throw new NotFoundError('Job not found');
  const job = jobDoc.data() as HumanJob;
  if (job.poster_wallet_id !== walletId) {
    throw new ForbiddenError('Only the job poster can fund the escrow');
  }
  if (!job.escrow_id) {
    throw new ValidationError('Job has no escrow to fund (accept an applicant first)');
  }
  const escrow = await verifyFunding(deps, job.escrow_id, txHash);
  return { job, escrow };
}

// ─── Close a hire that was never funded ──────────────────────────────────────

/**
 * How long after the escrow's `auto_release_at` an unfunded hire is closed. Past `auto_release_at`
 * no new escrow can be funded (the contract refuses an `autoReleaseAt` in the past, and the relay
 * refuses one later than its own), so the hire can never pay. The day's grace lets a poster who
 * funded in time but whose report never reached the relay still report it first.
 */
export const UNFUNDED_HIRE_CLOSE_GRACE_MS = 24 * 3_600_000;

export interface UnfundedHireSweepReport {
  scanned: number;
  closed: number;
  failures: number;
}

/**
 * Close every accepted hire whose escrow was never funded and can no longer be: the escrow is
 * cancelled, the job is open again (the poster may hire again or cancel it), the hired party's
 * application is pending again, and both parties are told. Each job is closed in one transaction
 * that re-reads the job and its escrow, so a hire funded meanwhile is never touched.
 *
 * Money-safe: an escrow funded on-chain whose report never reached the relay still pays the worker
 * on-chain (`releaseEscrow` is open to anyone after `autoReleaseAt`); closing the relay record moves
 * no funds.
 */
export async function closeUnfundedHires(
  deps: Pick<CommonsDeps, 'db'>,
  nowMs: number = Date.now(),
): Promise<UnfundedHireSweepReport> {
  const report: UnfundedHireSweepReport = { scanned: 0, closed: 0, failures: 0 };
  const jobs = await deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).where('status', '==', 'in_progress').get();
  for (const doc of jobs.docs) {
    const job = doc.data() as HumanJob;
    if (!job.escrow_id) continue;
    report.scanned++;
    try {
      const jobRef = doc.ref;
      const escrowRef = deps.db.collection('escrows').doc(job.escrow_id);
      const closed = await deps.db.runTransaction(async (txn) => {
        const [jobSnap, escrowSnap] = await Promise.all([txn.get(jobRef), txn.get(escrowRef)]);
        const j = jobSnap.data() as HumanJob | undefined;
        const e = escrowSnap.data() as EscrowDocument | undefined;
        if (!j || !e || j.status !== 'in_progress' || j.escrow_id !== job.escrow_id) return null;
        if (e.status !== 'created' || e.fund_tx_hash || typeof e.auto_release_at !== 'number') return null;
        if (nowMs < e.auto_release_at + UNFUNDED_HIRE_CLOSE_GRACE_MS) return null;
        const { FieldValue } = await import('firebase-admin/firestore');
        txn.update(escrowRef, { status: 'cancelled', cancelled_at: nowMs, cancel_reason: 'unfunded_past_deadline' });
        txn.update(jobRef, {
          status: 'open',
          accepted_applicant_wallet_id: FieldValue.delete(),
          escrow_id: FieldValue.delete(),
          unfunded_hire_closed_at: nowMs,
          lapsed_escrow_ids: FieldValue.arrayUnion(job.escrow_id),
        });
        return { poster: j.poster_wallet_id, worker: j.accepted_applicant_wallet_id ?? null, title: j.title };
      });
      if (!closed) continue;
      report.closed++;
      if (closed.worker) {
        const apps = await deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOB_APPLICATIONS)
          .where('job_id', '==', doc.id).where('applicant_wallet_id', '==', closed.worker).limit(1).get();
        for (const a of apps.docs) await a.ref.update({ status: 'pending' });
      }
      await notifyJobCounterparty(deps, { actorId: closed.poster, counterpartyId: closed.worker, jobId: doc.id, event: 'hire_lapsed', title: closed.title });
      await notifyJobCounterparty(deps, { actorId: closed.worker ?? '', counterpartyId: closed.poster, jobId: doc.id, event: 'hire_lapsed', title: closed.title });
    } catch (err) {
      report.failures++;
      console.error(`[CommonsJobs] closing unfunded hire ${doc.id} failed:`, err);
    }
  }
  return report;
}

// ─── Deliver Work ───────────────────────────────────────────────────────────

export async function deliverHumanJob(
  deps: CommonsDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  jobId: string,
  // the delivery carries a deliverable (URI and/or body); its sha256 is sealed on the PE
  // and the delivery is posted into the job's thread.
  deliverableInput?: DeliverableInput | null,
  // the deliverer's signature over `deliverableOutputText` (optional).
  outputSignatureInput?: unknown,
): Promise<HumanJob> {
  const deliverable = normalizeDeliverable(deliverableInput);
  if (!deliverable && outputSignatureInput !== undefined && outputSignatureInput !== null) {
    throw new ValidationError('output_signature_without_output');
  }
  const jobDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .get();
  if (!jobDoc.exists) {
    throw new NotFoundError('Job not found');
  }

  const job = jobDoc.data() as HumanJob;
  if (job.accepted_applicant_wallet_id !== walletId) {
    throw new ForbiddenError('Only the accepted applicant can deliver');
  }
  if (job.status !== 'in_progress') {
    throw new ValidationError('Job is not in progress');
  }
  const deliverableSignature = deliverable
    ? await acceptAttachedOutputSignature(
      deps.db, outputSignatureInput,
      createHash('sha256').update(deliverableOutputText(deliverable.uri, deliverable.body)).digest('hex'), agentId,
    )
    : null;

  const { peId } = await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    actionType: 'human_job_delivered',
    metadata: {
      job_id: jobId,
      ...(deliverable ? deliverablePeMetadata(deliverable) : {}),
    },
    ...(deliverable ? { output_digests: deliverableOutputDigests(deliverable) } : {}),
    // WS8: the counterparty is the JOB POSTER (who receives the delivery),
    // not the deliverer. Use the stored poster address (null for legacy jobs).
    counterpartyAddress: job.poster_address,
    // (completion earning): the delivery is the deliverer's EARNING act on
    // the off-chain path, so it takes the durable inlet. Without the marker the
    // row seals terminal `record_only` however good its evidence is
    // (`pvt-accrual.ts::resolveOperationalDisposition`); with it, the row seals
    // `pending_evidence` (the poster has not confirmed yet) and the
    // pending-evidence resolver promotes it to eligible ONLY once the poster's
    // `human_job_completed` confirmation verifies against this job and the
    // poster is a distinct owner (`core/pvt/completion-verifier.ts`). This is
    // NOT the relay-emitter fence ratified for escrow/promises/pools —
    // those emitters describe canonical on-chain events the watcher already
    // carries a payable row for; a delivery has no on-chain event, and its
    // one-mint-per-job guarantee against the watcher's escrow release is the
    // `completion` mint-once claim, not the absence of this marker. The
    // poster's confirmation (`completeHumanJob`) deliberately does NOT carry it:
    // a confirmation is corroboration, never a second earning act.
    durableViaOrdinaryIntake: true,
  });

  const deliveredAt = Date.now();
  await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .update({
      completion_pe_id: peId,
      ...(deliverable ? { deliverable: {
        uri: deliverable.uri, body: deliverable.body, sha256: deliverable.sha256, delivered_at: deliveredAt,
        ...(deliverableSignature ? { provian_output_signature: deliverableSignature } : {}),
      } } : {}),
    });
  if (deliverable) {
    await postDeliverableMessage(
      deps, { walletId, agentId, actorAddress, isAgent: isAgentPartyId(walletId) },
      'human_job', jobId, job.poster_wallet_id, deliverable, peId,
    );
  }

  const updated = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .get();
  return updated.data() as HumanJob;
}

// ─── Complete Job (confirmation record + settlement bridge) ─────────────────

/**
 * linked-job settlement : the poster's completion call is a CONFIRMATION RECORD — it
 * emits the human_job_completed PE and stamps poster_confirmed_at — plus a
 * bridge to the escrow's REAL on-chain release. The status flip to
 * 'completed' happens ONLY inside the receipt-gated settlement path
 * (agent-bank/job-settlement.ts, behind evaluateInstitutionTransition), so a
 * 'completed' human job ALWAYS means the worker was actually paid on-chain
 * (payment_released: true). In the normal flow — the poster released via SDK
 * bank.releaseEscrow before confirming — the bridge settles synchronously and
 * this call still returns a completed job. A confirm-without-release honestly
 * stays 'in_progress' with payment_release_pending until the depositor
 * releases or the auto-release scheduler settles it (≤ deadline + 72h).
 * Idempotent: a re-confirm skips the PE and just retries the bridge.
 * The applicant's human_jobs_completed stat is credited by the settlement
 * winner (job-settlement.ts), not here — the stat records a SETTLED job.
 */
export async function completeHumanJob(
  deps: CommonsDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  jobId: string,
): Promise<HumanJob> {
  const jobRef = deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).doc(jobId);
  const jobDoc = await jobRef.get();
  if (!jobDoc.exists) {
    throw new NotFoundError('Job not found');
  }

  const job = jobDoc.data() as HumanJob;
  if (job.poster_wallet_id !== walletId) {
    throw new ForbiddenError('Only the job poster can confirm completion');
  }
  if (job.status !== 'in_progress') {
    throw new ValidationError('Job is not in progress');
  }
  if (!job.completion_pe_id) {
    throw new ValidationError('Work has not been delivered yet');
  }

  const now = Date.now();

  // Confirmation record — once. A re-confirm (e.g. payment still pending from
  // a prior call) must not append a duplicate human_job_completed PE.
  if (!job.poster_confirmed_at) {
    const { peId: confirmationPeId } = await generatePE(deps, {
      walletId,
      agentId,
      actorAddress,
      actionType: 'human_job_completed',
      metadata: {
        job_id: jobId,
        applicant_wallet_id: job.accepted_applicant_wallet_id,
        escrow_id: job.escrow_id,
      },
    });
    // pin the confirmation PE on the job so the pending-evidence resolver
    // can bind the poster's corroboration to THIS job and THIS delivery by a
    // direct document read (never a metadata query). The confirmation itself is
    // a best-effort record — it carries no durable marker on purpose and mints
    // 0: it lifts the deliverer's `human_job_delivered`, it never pays twice.
    await jobRef.update({ poster_confirmed_at: now, confirmation_pe_id: confirmationPeId });
  }

  // WS1 bridge, linked-job settlement-gated: reach the escrow's REAL on-chain release. The
  // poster is the escrow depositor; completeEscrow either records an
  // already-on-chain release (poster released with their own key via SDK
  // bank.releaseEscrow) or, once auto-release has elapsed, the gas-only EOA
  // releases. Its linked-job advancement performs the guarded status flip. An
  // escrow already 'completed' (e.g. a crash between its flip and the job
  // advancement) is repaired here directly off its recorded release receipt.
  let paymentReleasePending = false;
  if (job.escrow_id) {
    const escSnap = await deps.db.collection('escrows').doc(job.escrow_id).get();
    const esc = escSnap.exists ? (escSnap.data() as EscrowDocument) : null;
    if (esc && esc.status === 'completed') {
      await settleLinkedHumanJob(
        deps,
        jobRef,
        esc,
        'completed',
        settlementReceipt(esc.release_tx_hash),
        now,
      );
    } else if (esc && esc.status === 'funded') {
      try {
        await completeEscrow(deps, job.escrow_id, walletId);
      } catch (err) {
        paymentReleasePending = true;
        console.warn(
          `[human-jobs] Escrow ${job.escrow_id} not yet released on-chain for job ${jobId}: ${(err as Error).message}`,
        );
      }
    } else {
      // disputed / cancelled / created, or missing escrow — payment not settled here.
      paymentReleasePending = !!esc;
    }
  }

  const updated = await jobRef.get();
  const fresh = updated.data() as HumanJob;

  // Surface pending truth when the confirmation did not settle the payment.
  if (fresh.status !== 'completed' && (paymentReleasePending || !fresh.payment_released)) {
    await jobRef.update({ payment_release_pending: true });
    return { ...fresh, payment_release_pending: true };
  }
  return fresh;
}

// ─── Rate Job ───────────────────────────────────────────────────────────────

export async function rateHumanJob(
  deps: CommonsDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  jobId: string,
  body: RateJobRequest,
): Promise<HumanJobRating> {
  const jobDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .get();
  if (!jobDoc.exists) {
    throw new NotFoundError('Job not found');
  }

  const job = jobDoc.data() as HumanJob;

  // Bidirectional ratings require completed work
  if (job.status !== 'completed') {
    throw new ValidationError('Can only rate completed jobs');
  }

  // Verify rater is a party to the job
  const isPoster = job.poster_wallet_id === walletId;
  const isApplicant = job.accepted_applicant_wallet_id === walletId;
  if (!isPoster && !isApplicant) {
    throw new ForbiddenError('Only job parties can rate');
  }

  // Validate rating
  if (body.rating < 1 || body.rating > 5 || !Number.isInteger(body.rating)) {
    throw new ValidationError('Rating must be an integer from 1 to 5');
  }

  // Check for duplicate rating
  const existingRating = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOB_RATINGS)
    .where('job_id', '==', jobId)
    .where('rater_wallet_id', '==', walletId)
    .limit(1)
    .get();
  if (!existingRating.empty) {
    throw new ValidationError('Already rated this job');
  }

  const rateeWalletId = isPoster
    ? job.accepted_applicant_wallet_id!
    : job.poster_wallet_id;

  const { peId } = await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    actionType: 'human_job_rated',
    metadata: {
      job_id: jobId,
      rating: body.rating,
      ratee_wallet_id: rateeWalletId,
    },
  });

  const now = Date.now();
  const ratingId = `hrat_${uuidv4()}`;
  const rating: HumanJobRating = {
    rating_id: ratingId,
    job_id: jobId,
    pe_id: peId,
    rater_wallet_id: walletId,
    ratee_wallet_id: rateeWalletId,
    rating: body.rating,
    comment: body.comment?.trim(),
    created_at: now,
  };

  await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOB_RATINGS)
    .doc(ratingId)
    .set(rating);

  // Update the job's rating PE reference
  const ratingField = isPoster ? 'rating_pe_id' : 'human_rating_pe_id';
  await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .doc(jobId)
    .update({ [ratingField]: peId });

  return rating;
}

// ─── Job Stats ──────────────────────────────────────────────────────────────

export async function getHumanJobStats(
  deps: CommonsDeps,
): Promise<{
  total_posted: number;
  total_completed: number;
  total_in_progress: number;
  categories: { category: string; count: number }[];
}> {
  const cacheKey = 'commons:human_job_stats:public-v2';
  const cached = await deps.cache.get<string>(cacheKey);
  if (cached) return typeof cached === 'string' ? JSON.parse(cached) : cached;

  const allSnap = await deps.db
    .collection(COMMONS_COLLECTIONS.HUMAN_JOBS)
    .get();

  let total_posted = 0;
  let total_completed = 0;
  let total_in_progress = 0;
  const catCounts: Record<string, number> = {};

  allSnap.docs.forEach(d => {
    const job = d.data() as HumanJob;
    if (isHiddenPrelaunchTest(job)) return;
    total_posted++;
    if (job.status === 'completed') total_completed++;
    if (job.status === 'in_progress') total_in_progress++;
    catCounts[job.category] = (catCounts[job.category] || 0) + 1;
  });

  const categories = Object.entries(catCounts)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  const result = { total_posted, total_completed, total_in_progress, categories };
  await deps.cache.set(cacheKey, JSON.stringify(result), 30);
  return result;
}
