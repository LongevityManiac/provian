/**
 * the ONE hiring board's pure rules. RED controls: a job that hires agents must BLOCK a
 * person's Apply (the relay 400s it); an unfeatured board must keep newest-first order.
 */
import en from '../../i18n/locales/en.json';
import { describe, it, expect } from 'vitest';
import type { HumanJob } from './CommonsService';
import {
  applyEligibility,
  featuredFirst,
  featuredRankOf,
  jobCurrencyOf,
  jobPostedByOf,
  jobSeekingOf,
  needsReleaseByPoster,
  payerCanClaimRefund,
} from './jobBoard';

function job(overrides: Partial<HumanJob> = {}): HumanJob {
  return {
    job_id: 'hjob_1', poster_wallet_id: 'wallet_aw_poster', title: 'T', description: 'D', category: 'other',
    skills_required: [], location: { type: 'remote' }, compensation_type: 'fixed', status: 'open',
    applicant_count: 0, posted_at: 100, ...overrides,
  };
}

const PERSON = { walletId: 'user_me', kind: 'human' as const };

describe('legacy derivation (mirrors the relay)', () => {
  it('derives who a job hires and who posted it from direction when the fields are absent', () => {
    expect(jobSeekingOf(job({}))).toBe('human'); // legacy default agent_seeking_human
    expect(jobSeekingOf(job({ direction: 'human_seeking_agent' }))).toBe('agent');
    expect(jobSeekingOf(job({ direction: 'agent_seeking_agent', seeking: 'human' }))).toBe('human'); // explicit wins
    expect(jobPostedByOf(job({ direction: 'human_seeking_human' }))).toBe('human');
    expect(jobPostedByOf(job({}))).toBe('agent');
  });

  it('derives the currency (budget_pvt → pvt; pre-W3 compensation_amount → usdc)', () => {
    expect(jobCurrencyOf(job({ currency: 'usdc', budget_usdc: 5 }))).toBe('usdc');
    expect(jobCurrencyOf(job({ budget_pvt: '1' }))).toBe('pvt');
    expect(jobCurrencyOf(job({ compensation_amount: 20 }))).toBe('usdc');
  });
});

describe('applyEligibility — a person applies only to jobs that hire people', () => {
  it('allows a person on an open job that hires people', () => {
    expect(applyEligibility(job({ seeking: 'human' }), PERSON)).toEqual({ canApply: true });
  });

  it('RED: a job that hires agents blocks the person, with the reason', () => {
    expect(applyEligibility(job({ seeking: 'agent' }), PERSON)).toEqual({ canApply: false, reason: 'hires_agents' });
  });

  it('blocks your own job, a filled job, a closed job, and a non-member', () => {
    expect(applyEligibility(job({ seeking: 'human', poster_wallet_id: 'user_me' }), PERSON)).toMatchObject({ reason: 'own_job' });
    expect(applyEligibility(job({ seeking: 'human', accepted_applicant_wallet_id: 'user_x' }), PERSON)).toMatchObject({ reason: 'already_hired' });
    expect(applyEligibility(job({ seeking: 'human', status: 'completed' }), PERSON)).toMatchObject({ reason: 'not_open' });
    expect(applyEligibility(job({ seeking: 'human' }), { walletId: null, kind: null })).toMatchObject({ reason: 'not_member' });
  });

  it('a job you already applied to shows "You applied" instead of Apply (the relay refuses a second application)', () => {
    const applied = new Set(['hjob_1']);
    expect(applyEligibility(job({ seeking: 'human' }), { ...PERSON, appliedJobIds: applied })).toEqual({ canApply: false, reason: 'already_applied' });
    // RED control: a different job id, or no applied set at all, still offers Apply.
    expect(applyEligibility(job({ seeking: 'human', job_id: 'hjob_2' }), { ...PERSON, appliedJobIds: applied })).toEqual({ canApply: true });
    expect(applyEligibility(job({ seeking: 'human' }), PERSON)).toEqual({ canApply: true });
  });

  it('every block reason has English copy (JobCard applyBlockText)', () => {
    expect(typeof (en as { commonsJobs: Record<string, string> }).commonsJobs.applyBlockedApplied).toBe('string');
  });
});

describe('featured first', () => {
  const a = job({ job_id: 'a', posted_at: 300 });
  const b = job({ job_id: 'b', posted_at: 200 });
  const c = job({ job_id: 'c', posted_at: 100 });

  it('puts featured jobs first by rank, then the rest newest first', () => {
    const featured = [{ item_id: 'c', rank: 1 }, { item_id: 'b', rank: 2 }];
    expect(featuredFirst([a, b, c], featured).map((j) => j.job_id)).toEqual(['c', 'b', 'a']);
    expect(featuredRankOf('c', featured)).toBe(1);
    expect(featuredRankOf('a', featured)).toBeNull();
  });

  it('RED: with no placements the order is simply newest first (and the input is not mutated)', () => {
    const input = [c, a, b];
    expect(featuredFirst(input, []).map((j) => j.job_id)).toEqual(['a', 'b', 'c']);
    expect(input.map((j) => j.job_id)).toEqual(['c', 'a', 'b']);
  });
});

describe('attention predicates', () => {
  it('needsReleaseByPoster: delivered, in progress, not yet paid — for the poster only', () => {
    const delivered = job({ poster_wallet_id: 'user_me', status: 'in_progress', completion_pe_id: 'pe_1' });
    expect(needsReleaseByPoster(delivered, 'user_me')).toBe(true);
    expect(needsReleaseByPoster(delivered, 'user_other')).toBe(false);
    expect(needsReleaseByPoster({ ...delivered, payment_release_pending: true }, 'user_me')).toBe(false);
    expect(needsReleaseByPoster({ ...delivered, completion_pe_id: undefined }, 'user_me')).toBe(false);
  });

  it('payerCanClaimRefund: the poster, a claimable unresolved dispute', () => {
    const j = job({ poster_wallet_id: 'user_me' });
    expect(payerCanClaimRefund(j, { refund_claimable: true, resolution: null }, 'user_me')).toBe(true);
    expect(payerCanClaimRefund(j, { refund_claimable: false, resolution: null }, 'user_me')).toBe(false);
    expect(payerCanClaimRefund(j, { refund_claimable: true, resolution: 'refund_to_depositor' }, 'user_me')).toBe(false);
    expect(payerCanClaimRefund(j, { refund_claimable: true, resolution: null }, 'user_hired')).toBe(false);
  });
});
