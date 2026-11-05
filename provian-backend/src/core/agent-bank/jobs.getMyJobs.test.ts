/**
 * Tests for getMyJobs filtering, pagination, and sort.
 *
 * Validates that the function:
 *   - applies status filter to both posted and assigned queries
 *   - respects role filter by skipping the excluded side
 *   - applies the requested sort field/order
 *   - clamps limit to MAX (200) and floors offset at 0
 *   - returns total + has_more from the count() aggregation
 *
 * The Firestore mock keeps a per-side state so the test can confirm
 * each query independently.
 */

import { getMyJobs } from './jobs';
import type { AgentBankDeps, JobDocument } from './types';

interface QueryState {
  whereField?: string;
  whereValue?: unknown;
  statusFilter?: string;
  orderField?: string;
  orderDirection?: 'asc' | 'desc';
  limitValue?: number;
  offsetValue?: number;
}

interface CollectionFixture {
  /** Docs returned by the underlying snapshot when get() runs. */
  docs: JobDocument[];
  /** Total count returned by count().get(). */
  totalCount: number;
  /** Captured query state for assertions. */
  states: QueryState[];
}

interface QueryMock {
  where: (field: string, op: string, value: unknown) => QueryMock;
  orderBy: (field: string, direction: 'asc' | 'desc') => QueryMock;
  limit: (n: number) => QueryMock;
  offset: (n: number) => QueryMock;
  count: () => { get: () => Promise<{ data: () => { count: number } }> };
  get: () => Promise<{ docs: { data: () => JobDocument }[] }>;
}

function makeJobsCollection(): CollectionFixture & {
  where: (f: string, o: string, v: unknown) => QueryMock;
} {
  const fixture: CollectionFixture = { docs: [], totalCount: 0, states: [] };

  const buildQuery = (state: QueryState): QueryMock => {
    const q: QueryMock = {
      where: (field, _op, value) => {
        if (field === 'status') {
          state.statusFilter = String(value);
        } else {
          state.whereField = field;
          state.whereValue = value;
        }
        return q;
      },
      orderBy: (field, direction) => {
        state.orderField = field;
        state.orderDirection = direction;
        return q;
      },
      limit: (n) => {
        state.limitValue = n;
        return q;
      },
      offset: (n) => {
        state.offsetValue = n;
        return q;
      },
      count: () => ({
        get: () => Promise.resolve({ data: () => ({ count: fixture.totalCount }) }),
      }),
      get: () => Promise.resolve({
        docs: fixture.docs.map((d) => ({ data: () => d })),
      }),
    };
    return q;
  };

  return Object.assign(fixture, {
    where(field: string, op: string, value: unknown): QueryMock {
      const state: QueryState = {};
      fixture.states.push(state);
      return buildQuery(state).where(field, op, value);
    },
  });
}

function makeDeps(): { deps: AgentBankDeps; jobs: ReturnType<typeof makeJobsCollection> } {
  const jobs = makeJobsCollection();
  const db = {
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'jobs') return jobs;
      throw new Error(`Unexpected collection: ${name}`);
    }),
  };
  return {
    deps: { db, projectId: 'test', region: 'test', signerKey: '0xkey' } as unknown as AgentBankDeps,
    jobs,
  };
}

describe('getMyJobs', () => {
  it('default call queries both sides without status filter, sort=created_at desc', async () => {
    const { deps, jobs } = makeDeps();
    jobs.totalCount = 0;

    const result = await getMyJobs(deps, 'wallet_test');

    expect(result.posted).toEqual([]);
    expect(result.assigned).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.has_more).toBe(false);

    // One state per side (buildQuery creates the chain once; count() and
    // the page-fetch share the same query reference). Default role=both
    // => 2 states.
    expect(jobs.states.length).toBe(2);

    const sides = jobs.states.map((s) => s.whereField).sort();
    expect(sides).toEqual(['assigned_wallet_id', 'poster_wallet_id']);

    // The page-fetch chain mutates the same state with orderBy/limit/offset.
    jobs.states.forEach((s) => {
      expect(s.orderField).toBe('created_at');
      expect(s.orderDirection).toBe('desc');
      expect(s.limitValue).toBe(50);
      expect(s.offsetValue).toBe(0);
    });
  });

  it('role=posted skips the assigned side entirely', async () => {
    const { deps, jobs } = makeDeps();
    await getMyJobs(deps, 'wallet_test', { role: 'posted' });

    expect(jobs.states.length).toBe(1);
    expect(jobs.states[0].whereField).toBe('poster_wallet_id');
  });

  it('role=assigned skips the posted side entirely', async () => {
    const { deps, jobs } = makeDeps();
    await getMyJobs(deps, 'wallet_test', { role: 'assigned' });

    expect(jobs.states.length).toBe(1);
    expect(jobs.states[0].whereField).toBe('assigned_wallet_id');
  });

  it('threads status filter into both sides', async () => {
    const { deps, jobs } = makeDeps();
    await getMyJobs(deps, 'wallet_test', { status: 'completed' });

    expect(jobs.states.every((s) => s.statusFilter === 'completed')).toBe(true);
  });

  it('honors sort=updated_desc and sort=posted_asc', async () => {
    const { deps: depsA, jobs: jobsA } = makeDeps();
    await getMyJobs(depsA, 'wallet_test', { sort: 'updated_desc' });
    const sortedA = jobsA.states.filter((s) => s.orderField !== undefined);
    sortedA.forEach((s) => expect([s.orderField, s.orderDirection]).toEqual(['updated_at', 'desc']));

    const { deps: depsB, jobs: jobsB } = makeDeps();
    await getMyJobs(depsB, 'wallet_test', { sort: 'posted_asc' });
    const sortedB = jobsB.states.filter((s) => s.orderField !== undefined);
    sortedB.forEach((s) => expect([s.orderField, s.orderDirection]).toEqual(['created_at', 'asc']));
  });

  it('clamps limit to 200 and floors offset at 0', async () => {
    const { deps, jobs } = makeDeps();
    await getMyJobs(deps, 'wallet_test', { limit: 500, offset: -10 });

    const pageStates = jobs.states.filter((s) => s.limitValue !== undefined);
    pageStates.forEach((s) => {
      expect(s.limitValue).toBe(200);
      expect(s.offsetValue).toBe(0);
    });
  });

  it('reports total from the count() aggregation across both sides', async () => {
    const { deps, jobs } = makeDeps();
    jobs.totalCount = 7;

    const result = await getMyJobs(deps, 'wallet_test');
    // Both sides return the same totalCount in this fixture; total = 14.
    expect(result.total).toBe(14);
  });

  it('sets has_more=true when offset+page_size < total on either side', async () => {
    const { deps, jobs } = makeDeps();
    jobs.totalCount = 100;
    jobs.docs = []; // 0 docs returned by get(), but count says 100

    const result = await getMyJobs(deps, 'wallet_test', { limit: 50, offset: 0 });
    expect(result.has_more).toBe(true);
  });

  it('sets has_more=false when both sides have been fully paged', async () => {
    const { deps, jobs } = makeDeps();
    jobs.totalCount = 1;
    // Both sides return 1 doc each, totalCount per side is 1, so we are caught up.
    jobs.docs = [{ job_id: 'j1' } as unknown as JobDocument];

    const result = await getMyJobs(deps, 'wallet_test', { limit: 50, offset: 0 });
    expect(result.has_more).toBe(false);
  });
});
