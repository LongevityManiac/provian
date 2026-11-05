import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { GitHubPrApiError, PR_GATE_REPOSITORIES, type PrGateApi } from './github-pr-api';
import { approvePrMerge, mergeApprovedPr, prGateId, PR_GATES_COLLECTION, sweepPrGates, type PrGateDeps } from './github-pr-gate';

const NOW = 1793660000000;
const SHA = 'a'.repeat(40);
const BASE = 'f'.repeat(40);
const CTX = { head_sha: SHA, base_ref: 'master', base_sha: BASE };
const MERGE = 'c'.repeat(40);
const OWNER = 229043875;
function setup() {
  const fake = createFakeFirestore();
  fake.store.set('github_wallet_links_v1/77_wallet-agent', { github_id: '77', wallet_id: 'wallet-agent', verified_by: 'github_user_oauth', verified_at: NOW - 100000, revoked_at: null });
  fake.store.set('agent_wallets/wallet-agent', { status: 'active', address: '0x' + '1'.repeat(40) });
  const pr: Record<string, unknown> = { number: 1, user: { id: 77, login: 'agent-author' }, head: { sha: SHA },
    base: { ref: 'master', sha: BASE, repo: { id: PR_GATE_REPOSITORIES.provian.id } }, state: 'open', merge_commit_sha: MERGE };
  const review: Record<string, unknown> = { id: 100, user: { id: OWNER }, state: 'APPROVED', commit_id: SHA, submitted_at: new Date(NOW - 5000).toISOString() };
  const reviews: Record<string, unknown>[] = [review];
  const merges: unknown[] = []; const runs: Record<string, unknown>[] = []; const comments: Record<string, unknown>[] = [];
  let rejectMerge = false;
  const api: PrGateApi = { call: jest.fn(async (_repo, method, suffix, body) => {
    if (method === 'GET' && suffix === '/pulls/1') return pr;
    if (method === 'GET' && suffix.startsWith('/pulls?')) return _repo === 'provian' ? [pr] : [];
    if (method === 'GET' && /^\/pulls\/1\/reviews\/\d+$/.test(suffix)) {
      const found = reviews.find((r) => r.id === Number(suffix.split('/').at(-1)));
      if (!found) throw new GitHubPrApiError(404); return found;
    }
    if (method === 'GET' && suffix.startsWith('/pulls/1/reviews?')) return reviews;
    if (method === 'GET' && suffix.includes('/check-runs?')) return { check_runs: runs };
    if (method === 'POST' && suffix === '/check-runs') { const run = { id: 10, app: { id: 4570525 }, ...(body as object) }; runs.push(run); return run; }
    if (method === 'PATCH' && suffix === '/check-runs/10') { Object.assign(runs[0], body); return runs[0]; }
    if (method === 'GET' && suffix.startsWith('/issues/1/comments?')) return comments;
    if (method === 'POST' && suffix === '/issues/1/comments') { const c = { id: 20, user: { type: 'Bot', login: 'provian-git-witness[bot]' }, ...(body as object) }; comments.push(c); return c; }
    if (method === 'PATCH' && suffix === '/issues/comments/20') { Object.assign(comments[0], body); return comments[0]; }
    if (suffix.includes('/labels')) return null;
    if (method === 'PUT' && suffix === '/pulls/1/merge') { if (!runs.some((r) => r.head_sha === SHA && r.conclusion === 'success')) throw new GitHubPrApiError(405); if (rejectMerge) throw new GitHubPrApiError(405); merges.push(body); return { merged: true }; }
    throw new Error(`unexpected API ${method} ${suffix}`);
  }) };
  const row = { repository: 'provian', number: 1, author_id: '77', author_login: 'agent-author', head_sha: SHA, state: 'open',
    cleared: { burn_id: 'b'.repeat(64), presenter_id: 'wallet-agent', amount_atomic: '50000000000000000000', token_sha256: 'd'.repeat(64), at: NOW - 10000 } };
  const key = `${PR_GATES_COLLECTION}/${prGateId('provian', 1)}`;
  fake.store.set(key, row);
  const deps: PrGateDeps = { db: fake as unknown as Firestore, api, now: () => NOW };
  return { fake, deps, pr, review, reviews, merges, row, key, runs, setRejected: (value: boolean) => { rejectMerge = value; } };
}

describe('App-only merger requires explicit current-head owner approval after clearance', () => {
  it('clearance alone never merges, including during the reconciliation sweep', async () => {
    const { deps, merges } = setup();
    expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(false);
    await sweepPrGates(deps);
    expect(merges).toHaveLength(0);
  });
  it('owner approval arms a single-head intent and merges with an optimistic SHA guard', async () => {
    const { deps, merges, runs } = setup();
    expect(await approvePrMerge(deps, 'provian', 1, 100, CTX)).toBe(true);
    expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(true);
    expect(merges).toEqual([{ sha: SHA, merge_method: 'merge' }]);
    expect(runs[0].head_sha).toBe(SHA);
  });
  it('RED: an unpaid PR cannot merge despite a real owner approval and shared successful commit', async () => {
    const { deps, fake, key, merges } = setup();
    delete fake.store.get(key)!.cleared;
    expect(await approvePrMerge(deps, 'provian', 1, 100, CTX)).toBe(false);
    expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(false);
    expect(merges).toHaveLength(0);
  });
  it('RED: approval submitted before clearance never arms when replayed after clearance', async () => {
    const { deps, review, merges } = setup();
    review.submitted_at = new Date(NOW - 20000).toISOString();
    expect(await approvePrMerge(deps, 'provian', 1, 100, CTX)).toBe(false);
    expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(false);
    expect(merges).toHaveLength(0);
  });
  it.each(['other-owner', 'CHANGES_REQUESTED', 'DISMISSED', 'old-head', 'same-second'])('RED: %s cannot authorize merge', async (reason) => {
    const { deps, review, row, merges } = setup();
    if (reason === 'other-owner') review.user = { id: 10 };
    else if (reason === 'old-head') review.commit_id = 'e'.repeat(40);
    else if (reason === 'same-second') review.submitted_at = new Date(row.cleared.at).toISOString();
    else review.state = reason;
    expect(await approvePrMerge(deps, 'provian', 1, 100, CTX)).toBe(false);
    expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(false);
    expect(merges).toHaveLength(0);
  });
  it('RED: a push after approval needs a new review and keeps the one-burn clearance', async () => {
    const { deps, pr, fake, key, merges } = setup();
    await approvePrMerge(deps, 'provian', 1, 100, CTX);
    pr.head = { sha: 'e'.repeat(40) };
    expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(false);
    expect(fake.store.get(key)!.cleared).toBeDefined(); expect(merges).toHaveLength(0);
  });
  it('RED: a dismissed or superseded owner review cannot be retried into a merge', async () => {
    const { deps, reviews, merges } = setup(); await approvePrMerge(deps, 'provian', 1, 100, CTX);
    reviews.push({ id: 101, user: { id: OWNER }, state: 'CHANGES_REQUESTED', commit_id: SHA, submitted_at: new Date(NOW - 1000).toISOString() });
    expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(false); expect(merges).toHaveLength(0);
  });
  it('RED: changed author or an unprotected destination is refused', async () => {
    for (const kind of ['author', 'base']) {
      const { deps, pr, merges } = setup(); await approvePrMerge(deps, 'provian', 1, 100, CTX);
      if (kind === 'author') pr.user = { id: 99, login: 'changed' }; else pr.base = { ref: 'other', sha: BASE, repo: { id: PR_GATE_REPOSITORIES.provian.id } };
      expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(false); expect(merges).toHaveLength(0);
    }
  });
  it('a transient protected-branch refusal retains only the explicit review intent for retry', async () => {
    const { deps, setRejected, merges } = setup(); await approvePrMerge(deps, 'provian', 1, 100, CTX);
    setRejected(true); expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(false);
    setRejected(false); expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(true);
    expect(merges).toHaveLength(1);
  });
});


describe('approval destination binding', () => {
  it('RED: retargeting during reconciliation never reaches the merge endpoint', async () => {
    const { deps, pr, merges } = setup(); await approvePrMerge(deps, 'provian', 1, 100, CTX);
    const api = deps.api;
    const racing: PrGateDeps = { ...deps, api: { call: async (...args) => {
      if (args[2].startsWith('/pulls/1/reviews?')) pr.base = { ref: 'other', sha: BASE, repo: { id: PR_GATE_REPOSITORIES.provian.id } };
      return api.call(...args);
    } } };
    expect(await mergeApprovedPr(racing, 'provian', 1)).toBe(false); expect(merges).toHaveLength(0);
  });
  it('RED: retargeted signed review context cannot arm against the new destination', async () => {
    const { deps, pr, merges } = setup();
    pr.base = { ref: 'prod', sha: BASE, repo: { id: PR_GATE_REPOSITORIES.provian.id } };
    expect(await approvePrMerge(deps, 'provian', 1, 100, CTX)).toBe(false); expect(merges).toHaveLength(0);
  });
});

it('merges with the required head check even when GitHub regenerates test-merge commits on every read', async () => {
  const { deps, pr, runs, merges } = setup(); let read = 0; const original = deps.api;
  const moving: PrGateDeps = { ...deps, api: { call: async (...args) => {
    if (args[1] === 'GET' && args[2] === '/pulls/1') pr.merge_commit_sha = (++read).toString(16).padStart(40, '0');
    return original.call(...args);
  } } };
  expect(await approvePrMerge(moving, 'provian', 1, 100, CTX)).toBe(true);
  expect(await mergeApprovedPr(moving, 'provian', 1)).toBe(true);
  expect(read).toBeGreaterThan(2); expect(runs[0].head_sha).toBe(SHA); expect(merges).toHaveLength(1);
});

it('refuses another wallet’s old clearance even after a current-head owner approval', async () => {
  const { deps, fake, key, merges } = setup();
  (fake.store.get(key)!.cleared as Record<string, unknown>).presenter_id = 'wallet-sponsor';
  await approvePrMerge(deps, 'provian', 1, 100, CTX);
  expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(false);
  expect(merges).toHaveLength(0);
});
it('leaves owner PRs to the owner’s direct merge path even if old gate state exists', async () => {
  const { deps, pr, merges } = setup();
  pr.user = { id: OWNER, login: 'LongevityManiac' };
  expect(await approvePrMerge(deps, 'provian', 1, 100, CTX)).toBe(false);
  expect(await mergeApprovedPr(deps, 'provian', 1)).toBe(false);
  expect(merges).toHaveLength(0);
});
