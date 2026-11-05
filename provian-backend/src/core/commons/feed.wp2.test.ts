import {publicProjectionId} from './projection-privacy';
import { describe, expect, it } from '@jest/globals';
import { getActivityFeed, getInstitutions, getNetworkStats } from './feed';
import { BLOCKED_COMMONS_INSTITUTIONS } from '../pvt/wp2-runtime-boundary';
import { COMMONS_COLLECTIONS, type CommonsDeps } from './types';

type Row = Record<string, unknown>;

function makeDeps(fixtures: Record<string, Row[]> = {}): {
  deps: CommonsDeps;
  collectionsRead: string[];
} {
  const collectionsRead: string[] = [];

  const db = {
    collection(name: string) {
      collectionsRead.push(name);
      const rows = fixtures[name] ?? [];
      // Equality (`==`) filters are honoured so a filtered count/get is a REAL
      // control (e.g. commons_agents vs commons_participants). Other operators
      // (`!=`, `<`, `array-contains`) stay pass-through, matching the prior
      // no-op behaviour the existing assertions rely on.
      const eqFilters: Array<[string, unknown]> = [];
      // `in` (hidden forum posts are counted across every hidden marker) is honoured too.
      const inFilters: Array<[string, readonly unknown[]]> = [];
      const apply = (): Row[] =>
        rows.filter((r) => eqFilters.every(([f, v]) => (r as Record<string, unknown>)[f] === v)
          && inFilters.every(([f, vs]) => vs.includes((r as Record<string, unknown>)[f])));
      const query: Record<string, unknown> = {};
      query.where = (field: string, op: string, value: unknown) => {
        if (op === '==') eqFilters.push([field, value]);
        if (op === 'in' && Array.isArray(value)) inFilters.push([field, value]);
        return query;
      };
      query.orderBy = () => query;
      query.limit = () => query;
      query.count = () => ({
        get: async () => ({ data: () => ({ count: apply().length }) }),
      });
      query.get = async () => ({
        docs: apply().map((row, index) => ({ id: String(index), data: () => row })),
      });
      query.doc = (id: string) => ({
        get: async () => {
          const row = rows.find((candidate) => candidate.wallet_id === id);
          return { exists: Boolean(row), data: () => row };
        },
      });
      return query;
    },
  };

  const deps = {
    db,
    cache: {
      get: async () => null,
      set: async () => undefined,
    },
  } as unknown as CommonsDeps;

  return { deps, collectionsRead };
}

describe('runtime boundary Commons discovery and feed truth', () => {
  it('institution tiles exclude marked prelaunch members and posts', async () => {
    const { deps } = makeDeps({
      [COMMONS_COLLECTIONS.PROFILES]: [
        { wallet_id: 'frank', status: 'active' },
        { wallet_id: 'atlas', status: 'active' },
        { wallet_id: 'test', status: 'active', public_visibility: 'hidden_prelaunch_test' },
      ],
      [COMMONS_COLLECTIONS.FORUM_POSTS]: [
        { post_id: 'test-post', public_visibility: 'hidden_prelaunch_test' },
      ],
    });
    const institutions = await getInstitutions(deps);
    expect(institutions.find((row) => row.id === 'registry')?.key_metric?.value).toBe(2);
    expect(institutions.find((row) => row.id === 'forum')?.key_metric?.value).toBe(0);
  });

  it('does not query or publish legacy economic rows as current network stats', async () => {
    const { deps, collectionsRead } = makeDeps({
      // the second row is an operator-reviewed prelaunch fixture — off the
      // public agent total (display only). Without the subtraction this reads 2.
      agent_wallets: [{ platform: 'sdk' }, { platform: 'sdk', public_visibility: 'hidden_prelaunch_test' }],
      // A real humans-vs-agents split: one human profile + one agent profile.
      // commons_participants counts both; commons_agents counts only the agent;
      // commons_humans is the difference. If getNetworkStats ever double-counted
      // agents into the humans figure (the pre-fix "Members" behaviour), humans
      // would read 2 here, not 1 — this is the negative control for that bug.
      [COMMONS_COLLECTIONS.PROFILES]: [
        { wallet_id: 'user-1', participant_type: 'human' },
        { wallet_id: 'wallet_aw-1', participant_type: 'agent' },
        { wallet_id: 'user-test', participant_type: 'human', public_visibility: 'hidden_prelaunch_test' },
        { wallet_id: 'wallet_aw-test', participant_type: 'agent', public_visibility: 'hidden_prelaunch_test' },
      ],
      [COMMONS_COLLECTIONS.FORUM_POSTS]: [
        { post_id: 'post-1' },
        { post_id: 'post-test', public_visibility: 'hidden_prelaunch_test' },
        // speech made under a talking pass whose burn was revoked is hidden too.
        { post_id: 'post-revoked', public_visibility: 'hidden_revoked_burn' },
      ],
      jobs: [{ job_id: 'legacy-job' }],
      escrows: [{ escrow_id: 'legacy-escrow' }],
      court_disputes: [{ dispute_id: 'legacy-case' }],
      governance_proposals: [{ proposal_id: 'legacy-proposal' }],
    });

    const stats = await getNetworkStats(deps);

    expect(stats).toMatchObject({
      total_agents: 1,
      commons_participants: 2,
      commons_humans: 1,
      commons_agents: 1,
      forum_posts: 1,
      active_surfaces: ['registry', 'forum', 'jobs', 'market'],
      unavailable_institutions: ['escrow', 'court', 'bonds', 'governance'],
    });
    expect(stats).not.toHaveProperty('total_agent_jobs');
    expect(stats).not.toHaveProperty('total_escrows');
    expect(stats).not.toHaveProperty('court_cases');
    expect(stats).not.toHaveProperty('governance_proposals');
    // Profiles and posts count raw and hidden rows; the three legacy economic
    // collections remain untouched.
    expect(collectionsRead).toEqual([
      'agent_wallets',
      'agent_wallets',
      COMMONS_COLLECTIONS.PROFILES,
      COMMONS_COLLECTIONS.PROFILES,
      COMMONS_COLLECTIONS.PROFILES,
      COMMONS_COLLECTIONS.PROFILES,
      COMMONS_COLLECTIONS.FORUM_POSTS,
      COMMONS_COLLECTIONS.FORUM_POSTS,
    ]);
  });

  it('serves a cache HIT (Upstash auto-deserialized object) without a JSON.parse crash', async () => {
    // Upstash Redis auto-deserializes JSON on read, so `cache.get` returns the
    // stored value already as an OBJECT — not a string. The pre-fix code ran
    // `JSON.parse(cached)` on it, which coerces the object to "[object Object]"
    // and throws `SyntaxError: "[object Object]" is not valid JSON` on EVERY
    // cache hit (the balances route 500'd 8/8 in production for exactly this).
    const cachedObject = { total_agents: 42, from_cache_marker: true };

    // Negative control: prove the pre-fix expression would have thrown on this
    // exact value. If someone reverts the guard to `JSON.parse(cached)`, this
    // documents the failure mode the guard prevents.
    expect(() => JSON.parse(cachedObject as unknown as string)).toThrow(/is not valid JSON/);

    const { deps } = makeDeps();
    (deps as unknown as { cache: { get: (k: string) => Promise<unknown> } }).cache.get = async () =>
      cachedObject;

    const stats = await getNetworkStats(deps);
    // The cached object is returned verbatim — no crash, no re-parse.
    expect(stats).toEqual(cachedObject);

    // And a raw-string cache value (auto-deser off / legacy 30s entry) still parses.
    (deps as unknown as { cache: { get: (k: string) => Promise<unknown> } }).cache.get = async () =>
      JSON.stringify(cachedObject);
    const statsFromString = await getNetworkStats(deps);
    expect(statsFromString).toEqual(cachedObject);
  });

  it('reports exactly the institutions the runtime boundary blocks, and no more', async () => {
    const { deps } = makeDeps();
    const institutions = await getInstitutions(deps);

    // Guard the population: a catalog that failed to build would make every
    // per-id assertion below vacuously pass.
    expect(institutions.length).toBeGreaterThan(0);

    const unavailableIds = institutions
      .filter((institution) => institution.status === 'unavailable')
      .map((institution) => institution.id)
      .sort();

    // THE invariant that would have caught the drift: the catalog's
    // unavailable set must equal the boundary's blocked set exactly. Reporting
    // a surface the boundary ADMITS (jobs) as unavailable fails here, and so
    // does quietly advertising a still-blocked one as open.
    expect(unavailableIds).toEqual([...BLOCKED_COMMONS_INSTITUTIONS].sort());

    // Jobs is the specific surface opened; pin it positively so a
    // regression cannot re-close it by dropping it from the catalog entirely.
    expect(institutions.find((institution) => institution.id === 'jobs')?.status).toBe('live');
    // lit the Market; pin it the same way.
    expect(institutions.find((institution) => institution.id === 'market')?.status).toBe('live');
    expect(institutions.find((institution) => institution.id === 'registry')?.status).toBe('live');
    expect(institutions.find((institution) => institution.id === 'forum')?.status).toBe('live');
  });

  it('labels every institution with the audience that transacts there', async () => {
    const { deps } = makeDeps();
    const institutions = await getInstitutions(deps);

    expect(institutions.length).toBeGreaterThan(0);
    // Every entry must declare an audience — the mobile Commons groups by it,
    // and an undefined audience would silently fall into the human section and
    // present an agent-only rail to a person as something they can use.
    for (const institution of institutions) {
      expect(['human', 'agent', 'both']).toContain(institution.audience);
    }

    // The agent-only rails a human never calls directly.
    for (const id of ['bonds', 'court']) {
      expect(institutions.find((institution) => institution.id === id)?.audience).toBe('agent');
    }
    // The surfaces a person acts on (the Market is one of them).
    // Escrow is where every jobs-board hire is paid, for people and agents alike.
    for (const id of ['registry', 'forum', 'jobs', 'market', 'escrow']) {
      expect(institutions.find((institution) => institution.id === id)?.audience).toBe('both');
    }
  });

  it(' exposes exactly Voting, Compute market, and Insurance with the ruled Insurance copy and no dead routes', async () => {
    const { deps } = makeDeps();
    let cacheReadKey = '';
    deps.cache.get = async <T>(key: string): Promise<T | null> => {
      cacheReadKey = key;
      return null;
    };
    const institutions = await getInstitutions(deps);
    const future = institutions.filter((institution) =>
      institution.audience !== 'agent' && institution.status !== 'live',
    );

    // Non-vacuous exact-set assertion: adding a fourth card or silently dropping
    // one fails. Research and Standards were retired as Commons institutions.
    expect(future.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'governance', name: 'Voting' },
      { id: 'compute', name: 'Compute market' },
      { id: 'insurance', name: 'Insurance' },
    ]);
    expect(future.every((institution) => institution.route === null)).toBe(true);
    expect(institutions.some((institution) => institution.id === 'research')).toBe(false);
    expect(institutions.some((institution) => institution.id === 'standards')).toBe(false);
    expect(institutions.find((institution) => institution.id === 'insurance')?.description).toBe(
      "Agent insurance — pooled coverage that pays Court-triggered payouts above an at-fault agent's performance bond. PVT premiums, contract-held, no admin override; coverage scales with the pool. Not open: premium pricing needs real PE and claim history. Provian provides the rails, not the insurance.",
    );
    expect(cacheReadKey).toBe('commons:institutions:public-cleanup-v7');
  });

  it('keeps Forum activity live while classifying legacy institution PEs as historical provenance', async () => {
    const { deps, collectionsRead } = makeDeps({
      [COMMONS_COLLECTIONS.PUBLISHED_PES]: [{
        pe_id: 'pe-legacy-job',
        actor_wallet_id: 'wallet-1',
        attestation_tier: 'software',
        institution: 'jobs',
        action_type: 'job_posted',
        published_at: '2026-07-15T00:00:00.000Z',
      }],
      [COMMONS_COLLECTIONS.FORUM_POSTS]: [{
        post_id: 'forum-1',
        author_wallet_id: 'wallet-1',
        title: 'A current record',
        content: 'A current record',
        created_at: Date.parse('2026-07-16T00:00:00.000Z'),
      }],
      [COMMONS_COLLECTIONS.PROFILES]: [{
        wallet_id: 'wallet-1',
        display_name: 'Atlas',
        attestation_tier: 'software',
      }],
      [COMMONS_COLLECTIONS.HUMAN_JOBS]: [{ job_id: 'must-not-be-read' }],
    });

    const feed = await getActivityFeed(deps, { page_size: 10, before: Date.parse('2026-07-17T00:00:00.000Z') });

    expect(feed.find((item) => item.id === 'forum-1')).toMatchObject({ institution: 'forum', type: 'forum_post' });
    expect(feed.find((item) => item.id === publicProjectionId('pe-legacy-job'))).toMatchObject({
      institution: 'provenance',
      summary: 'Published historical job_posted provenance record',
    });
    expect(collectionsRead).not.toContain(COMMONS_COLLECTIONS.HUMAN_JOBS);
  });
});
