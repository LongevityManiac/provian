/**
 * jobBoard — pure rules for the ONE Commons hiring board (all four directions: people and
 * agents hiring people and agents), kept out of the screens so they are unit-tested.
 *
 * Legacy rows carry no `seeking` / `currency`; they are derived exactly as the relay derives them
 * (`jobSeekingOf` / `jobCurrencyOf` in provian-backend human-jobs.ts), so the phone never disagrees
 * with the relay about who a job hires or what it pays in.
 */
import type { HumanJob, FeaturedSlot, JobDisputeView } from './CommonsService';

export type JobSeeking = 'agent' | 'human';
export type JobCurrency = 'pvt' | 'usdc';
export type JobPartyKind = 'agent' | 'human';

/** Who a job hires. Legacy rows derive it from `direction` (missing → agent_seeking_human). */
export function jobSeekingOf(job: Pick<HumanJob, 'seeking' | 'direction'>): JobSeeking {
  if (job.seeking === 'agent' || job.seeking === 'human') return job.seeking;
  const direction = job.direction ?? 'agent_seeking_human';
  return direction.endsWith('_seeking_agent') ? 'agent' : 'human';
}

/** Who posted a job. Legacy rows derive it from `direction`. */
export function jobPostedByOf(job: Pick<HumanJob, 'posted_by_type' | 'direction'>): JobPartyKind {
  if (job.posted_by_type === 'agent' || job.posted_by_type === 'human') return job.posted_by_type;
  const direction = job.direction ?? 'agent_seeking_human';
  return direction.startsWith('human_') ? 'human' : 'agent';
}

/** What a job pays in. Legacy rows: PVT when budget_pvt is set, else the pre-W3 USDC path. */
export function jobCurrencyOf(job: Pick<HumanJob, 'currency' | 'budget_pvt' | 'compensation_amount'>): JobCurrency {
  if (job.currency === 'pvt' || job.currency === 'usdc') return job.currency;
  if (job.budget_pvt) return 'pvt';
  return job.compensation_amount != null ? 'usdc' : 'pvt';
}

/** Why a viewer cannot apply. The screens show each as plain words (never a silent hide). */
export type ApplyBlockReason =
  | 'not_member'
  | 'own_job'
  | 'already_applied'
  | 'already_hired'
  | 'not_open'
  | 'hires_agents'
  | 'hires_people';

export type ApplyEligibility = { canApply: true } | { canApply: false; reason: ApplyBlockReason };

/**
 * Can this viewer apply? The relay refuses an applicant whose kind differs from `seeking` (400);
 * the phone says so up front instead. A person using the app is always a 'human' applicant.
 */
export function applyEligibility(
  job: Pick<HumanJob, 'job_id' | 'seeking' | 'direction' | 'poster_wallet_id' | 'accepted_applicant_wallet_id' | 'status'>,
  viewer: { walletId: string | null | undefined; kind: JobPartyKind | null | undefined; appliedJobIds?: ReadonlySet<string> },
): ApplyEligibility {
  if (!viewer.walletId || !viewer.kind) return { canApply: false, reason: 'not_member' };
  if (job.poster_wallet_id === viewer.walletId) return { canApply: false, reason: 'own_job' };
  if (job.accepted_applicant_wallet_id) return { canApply: false, reason: 'already_hired' };
  if (job.status !== 'open') return { canApply: false, reason: 'not_open' };
  // the relay refuses a second application to the same job ("Already applied").
  if (viewer.appliedJobIds?.has(job.job_id)) return { canApply: false, reason: 'already_applied' };
  const seeking = jobSeekingOf(job);
  if (seeking !== viewer.kind) return { canApply: false, reason: seeking === 'agent' ? 'hires_agents' : 'hires_people' };
  return { canApply: true };
}

/** The featured rank of a job (1 = top), or null when it holds no live placement. */
export function featuredRankOf(jobId: string, featured: ReadonlyArray<Pick<FeaturedSlot, 'item_id' | 'rank'>>): number | null {
  const slot = featured.find((f) => f.item_id === jobId);
  return slot ? slot.rank : null;
}

/** Featured jobs first (by rank), then everything else newest first. Never mutates the input. */
export function featuredFirst<T extends Pick<HumanJob, 'job_id' | 'posted_at'>>(
  jobs: readonly T[],
  featured: ReadonlyArray<Pick<FeaturedSlot, 'item_id' | 'rank'>>,
): T[] {
  const rank = (j: T) => featuredRankOf(j.job_id, featured) ?? Number.POSITIVE_INFINITY;
  return [...jobs].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return (b.posted_at ?? 0) - (a.posted_at ?? 0);
  });
}

/** The poster should release payment: the hired party delivered and the payment is not out yet. */
export function needsReleaseByPoster(
  job: Pick<HumanJob, 'poster_wallet_id' | 'status' | 'completion_pe_id' | 'payment_released' | 'payment_release_pending'>,
  myWalletId: string | null | undefined,
): boolean {
  return !!myWalletId
    && job.poster_wallet_id === myWalletId
    && job.status === 'in_progress'
    && !!job.completion_pe_id
    && !job.payment_released
    && !job.payment_release_pending;
}

/** The payer (poster) can take the refund now: the dispute timed out with no resolution. */
export function payerCanClaimRefund(
  job: Pick<HumanJob, 'poster_wallet_id'>,
  view: Pick<JobDisputeView, 'refund_claimable' | 'resolution'> | null | undefined,
  myWalletId: string | null | undefined,
): boolean {
  return !!view && !!myWalletId && job.poster_wallet_id === myWalletId && view.refund_claimable && view.resolution === null;
}
