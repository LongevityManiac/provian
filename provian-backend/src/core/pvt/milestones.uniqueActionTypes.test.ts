/**
 * `unique_pe_action_types` the distinct-action-type milestone (M7).
 *
 * THE DEFECT THIS PINS. The metric used to sample the newest 5,000 `pe_history`
 * rows and count distinct `actionType` values in them. That is a metric about
 * recent traffic, not about the network: one busy emitter producing 5,000 PEs of
 * a single type pushes every other type out of the sample and collapses the
 * number to ~1. It also degrades as the network grows, which is backwards for a
 * milestone. It now counts `pe_type_catalog` one document per action type ever
 * observed — which is exact and cannot be skewed by emitter mix.
 *
 * the "loud emitter" case is the whole point, so it is constructed
 * explicitly rather than asserted in prose, and it is paired with a control
 * showing the SEED-ONLY types are excluded — without which a passing count could
 * simply be the size of the seed list, a large constant that never moves.
 */

import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import type { AgentBankDeps } from '../agent-bank/types';
import { checkAllMilestones } from './milestones';

interface CatalogRow {
  readonly action_type: string;
  readonly observation_count: number;
}

function makeDeps(catalog: CatalogRow[], peHistory: { actionType: string }[] = []): AgentBankDeps {
  const db: FakeFirestore = createFakeFirestore();
  for (const row of catalog) {
    db.store.set(`pe_type_catalog/${row.action_type}`, { ...row, status: 'active' });
  }
  // Seeded ONLY to prove the metric no longer reads it: a lopsided pe_history
  // must not move the number in either direction.
  peHistory.forEach((pe, i) => {
    db.store.set(`pe_history/pe_${String(i).padStart(5, '0')}`, {
      peId: `pe_${i}`, userId: 'u', timestamp: 1_000 + i, actionType: pe.actionType,
    });
  });

  const cacheStore = new Map<string, unknown>();
  const cache = {
    get: async <T>(k: string): Promise<T | null> => (cacheStore.get(k) as T) ?? null,
    set: async (k: string, v: unknown): Promise<void> => { cacheStore.set(k, v); },
  };
  return { db, cache } as unknown as AgentBankDeps;
}

async function uniqueTypes(deps: AgentBankDeps): Promise<number> {
  return (await checkAllMilestones(deps)).unique_pe_action_types.current;
}

describe('unique_pe_action_types', () => {
  it('counts every OBSERVED catalogued type', async () => {
    const deps = makeDeps([
      { action_type: 'coding_session', observation_count: 4 },
      { action_type: 'wallet_created', observation_count: 1 },
      { action_type: 'x402_payment', observation_count: 12 },
    ]);
    expect(await uniqueTypes(deps)).toBe(3);
  });

  it('a LOUD emitter no longer owns the metric', async () => {
    // The regression. 5,000 PEs of ONE type, while three types are catalogued.
    // Under the old sampling implementation this fixture reported 1.
    const flood = Array.from({ length: 5_000 }, () => ({ actionType: 'coding_session' }));
    const deps = makeDeps(
      [
        { action_type: 'coding_session', observation_count: 5_000 },
        { action_type: 'wallet_created', observation_count: 1 },
        { action_type: 'promise_created', observation_count: 2 },
      ],
      flood,
    );

    expect(await uniqueTypes(deps)).toBe(3);
  });

  it('EXCLUDES seeded-but-never-observed types', async () => {
    // The load-bearing filter. `seedCatalog()` writes every known type with
    // `observation_count: 0`, so an unfiltered count would report the size of the
    // seed list — a big constant that never moves and would look like a healthy
    // metric while measuring nothing.
    const deps = makeDeps([
      { action_type: 'coding_session', observation_count: 3 },
      { action_type: 'seeded_never_used_a', observation_count: 0 },
      { action_type: 'seeded_never_used_b', observation_count: 0 },
      { action_type: 'seeded_never_used_c', observation_count: 0 },
    ]);

    expect(await uniqueTypes(deps)).toBe(1);
  });

  it('CONTROL — those same seeded types DO count once observed', async () => {
    // Without this, the exclusion case above would pass against an
    // implementation that counted nothing at all.
    const deps = makeDeps([
      { action_type: 'coding_session', observation_count: 3 },
      { action_type: 'seeded_never_used_a', observation_count: 1 },
      { action_type: 'seeded_never_used_b', observation_count: 0 },
      { action_type: 'seeded_never_used_c', observation_count: 0 },
    ]);

    expect(await uniqueTypes(deps)).toBe(2);
  });

  it('reports zero on an empty catalog rather than throwing', async () => {
    expect(await uniqueTypes(makeDeps([]))).toBe(0);
  });
});
