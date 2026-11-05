/**
 * 5c — registry deep-filter must be INDEX-FREE. browseRegistry may send only
 * `status == active` + one orderBy to Firestore (covered by the existing
 * [status, <sort>] composite indexes); every optional filter is applied in memory.
 * The mock below THROWS if any optional `.where` reaches Firestore, so a regression
 * that re-adds a Firestore-side optional filter (which would 500 with
 * FAILED_PRECONDITION on an unbuilt composite index) reddens this suite.
 */
import { describe, it, expect } from '@jest/globals';
import { browseRegistry } from './profiles';
import type { CommonsDeps } from './types';

type Profile = Record<string, unknown>;

function makeDeps(candidates: Profile[]): { deps: CommonsDeps; whereCalls: string[] } {
  const whereCalls: string[] = [];
  const query = {
    where(field: string, op: string, value: unknown) {
      whereCalls.push(`${field} ${op} ${String(value)}`);
      // Only the status equality is allowed to hit Firestore. Anything else means a
      // composite-index-requiring query slipped back in (the 5c regression).
      if (!(field === 'status' && op === '==' && value === 'active')) {
        throw new Error(`INDEX_REGRESSION: optional filter reached Firestore: ${field} ${op}`);
      }
      return query;
    },
    orderBy() { return query; },
    limit() { return query; },
    async get() {
      return { docs: candidates.map((c) => ({ data: () => c })) };
    },
  };
  const deps = { db: { collection: () => query } } as unknown as CommonsDeps;
  return { deps, whereCalls };
}

// governance_score is deleted, so it is no longer a registry fixture
// field, a filter, or a sort key.
const CANDIDATES: Profile[] = [
  { wallet_id: 'a', participant_type: 'agent', capabilities: ['code', 'research'], attestation_tier: 'hardware_full', availability: 'open' },
  { wallet_id: 'b', participant_type: 'human', capabilities: ['design'], attestation_tier: 'software', availability: 'busy' },
  { wallet_id: 'c', participant_type: 'agent', capabilities: ['research'], attestation_tier: 'software', availability: 'open' },
];

describe('5c browseRegistry — index-free optional filtering', () => {
  it('only status==active reaches Firestore (no optional filter is a Firestore where)', async () => {
    const { deps, whereCalls } = makeDeps(CANDIDATES);
    await browseRegistry(deps, { participant_type: 'agent', capability: 'research', attestation_tier: 'software', availability: 'open' });
    expect(whereCalls).toEqual(['status == active']);
  });

  it('participant_type filters in memory', async () => {
    const { deps } = makeDeps(CANDIDATES);
    const r = await browseRegistry(deps, { participant_type: 'agent' });
    expect(r.profiles.map((p) => p.wallet_id)).toEqual(['a', 'c']);
    expect(r.total).toBe(2);
  });

  it('capability array-contains filters in memory', async () => {
    const { deps } = makeDeps(CANDIDATES);
    const r = await browseRegistry(deps, { capability: 'research' });
    expect(r.profiles.map((p) => p.wallet_id)).toEqual(['a', 'c']);
  });

  it('q searches the name, bio and capabilities in memory (RED: the app sent its search box as an exact capability tag)', async () => {
    const { deps } = makeDeps(CANDIDATES);
    const byCapability = await browseRegistry(deps, { q: 'RESE' }); // case-insensitive substring of "research"
    expect(byCapability.profiles.map((p) => p.wallet_id).sort()).toEqual(['a', 'c']);
    expect(byCapability.total).toBe(2);
    const none = await browseRegistry(deps, { q: 'zz-no-such-profile-zz' });
    expect(none.profiles).toEqual([]);
    expect(none.total).toBe(0);
  });

  it('combined optional filters intersect', async () => {
    const { deps } = makeDeps(CANDIDATES);
    // reconstruct an intersection from the surviving filters — both 'a'
    // and 'c' are open agents, but only 'a' is hardware_full.
    const r = await browseRegistry(deps, { participant_type: 'agent', availability: 'open', attestation_tier: 'hardware_full' });
    expect(r.profiles.map((p) => p.wallet_id)).toEqual(['a']); // c is software
    expect(r.total).toBe(1);
  });

  it('paginates in memory after filtering (offset + page_size honoured)', async () => {
    const { deps } = makeDeps(CANDIDATES);
    const r = await browseRegistry(deps, { participant_type: 'agent', page_size: 1, offset: 1 });
    expect(r.total).toBe(2);           // both agents matched
    expect(r.profiles.map((p) => p.wallet_id)).toEqual(['c']); // second page of 1
  });

  it('no optional filters returns the whole active candidate set', async () => {
    const { deps } = makeDeps(CANDIDATES);
    const r = await browseRegistry(deps, {});
    expect(r.total).toBe(3);
  });

  it('excludes marked prelaunch profiles before pagination and count', async () => {
    const { deps } = makeDeps([
      CANDIDATES[0],
      { ...CANDIDATES[1], public_visibility: 'hidden_prelaunch_test' },
      CANDIDATES[2],
    ]);
    const r = await browseRegistry(deps, { page_size: 1, offset: 1 });
    expect(r.total).toBe(2);
    expect(r.profiles.map((p) => p.wallet_id)).toEqual(['c']);
  });
});

// The stored pe_count is a join-time snapshot; the registry must show the same
// LIVE count getProfile shows (agent → agent_id, human → wallet id), or a
// long-lived agent lists as "1 record" while its profile and the leaderboard
// show thousands.
function makeLiveDeps(
  candidates: Profile[],
  agentIds: Record<string, string>,
  liveCounts: Record<string, number>,
  failFor: string[] = [],
): CommonsDeps {
  const profilesQuery = {
    where() { return profilesQuery; },
    orderBy() { return profilesQuery; },
    limit() { return profilesQuery; },
    async get() { return { docs: candidates.map((c) => ({ data: () => c })) }; },
  };
  // PE METER: the live count is the actor's running total (`actor_stats_v1.pe_count`).
  const actorStats = {
    doc: (id: string) => ({
      async get() {
        if (failFor.includes(id)) throw new Error('count unavailable');
        return { exists: id in liveCounts, data: () => ({ actor_id: id, pe_count: liveCounts[id] }) };
      },
    }),
  };
  const db = {
    collection(name: string) {
      if (name === 'agent_wallets') {
        return {
          doc: (id: string) => ({
            async get() {
              const agentId = agentIds[id];
              return { exists: agentId !== undefined, data: () => ({ agent_id: agentId }) };
            },
          }),
        };
      }
      if (name === 'actor_stats_v1') return actorStats;
      if (name === 'pe_history') throw new Error('pe_history must not be read');
      return profilesQuery;
    },
  };
  return { db } as unknown as CommonsDeps;
}

describe('browseRegistry — live record counts', () => {
  const LIVE_CANDIDATES: Profile[] = [
    { wallet_id: 'atlas-wallet', participant_type: 'agent', pe_count: 1 },
    { wallet_id: 'human-wallet', participant_type: 'human', pe_count: 0 },
  ];

  it('replaces the stored join-time snapshot with the live visible count', async () => {
    const deps = makeLiveDeps(LIVE_CANDIDATES, { 'atlas-wallet': 'agent-atlas' }, { 'agent-atlas': 3314, 'human-wallet': 12 });
    const r = await browseRegistry(deps, {});
    const byId = Object.fromEntries(r.profiles.map((p) => [p.wallet_id, p.pe_count]));
    expect(byId['atlas-wallet']).toBe(3314); // counted under agent_id, not the wallet id
    expect(byId['human-wallet']).toBe(12);   // humans count under their wallet id
  });

  it('a pe_count sort ranks by the live count, not the stored snapshot', async () => {
    const candidates: Profile[] = [
      { wallet_id: 'x', participant_type: 'human', pe_count: 50 }, // stale-high snapshot
      { wallet_id: 'y', participant_type: 'human', pe_count: 1 },  // stale-low snapshot
    ];
    const deps = makeLiveDeps(candidates, {}, { x: 2, y: 40 });
    const r = await browseRegistry(deps, { sort_by: 'pe_count' });
    expect(r.profiles.map((p) => p.wallet_id)).toEqual(['y', 'x']);
  });

  it('keeps the stored snapshot when the live count cannot be read', async () => {
    const deps = makeLiveDeps(LIVE_CANDIDATES, { 'atlas-wallet': 'agent-atlas' }, { 'human-wallet': 12 }, ['agent-atlas']);
    const r = await browseRegistry(deps, {});
    expect(r.profiles.find((p) => p.wallet_id === 'atlas-wallet')?.pe_count).toBe(1);
  });
});
