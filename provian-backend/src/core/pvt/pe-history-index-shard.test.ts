/**
 * The pe_history index shard (H5 close-out): the shard function, the
 * data-driven reader cutover, the fan-out, the backfill, and the three readers
 * in sharded mode.
 *
 * THE RED CONTROLS THE BRIEF NAMES, permanent and in-suite:
 * 1. a reader that FORGETS one shard misses rows on a fixture — the fan-out
 * takes its shard list as a parameter precisely so the violating case is
 * constructible; the full list finds every row, N−1 of them does not;
 * 2. the backfill is IDEMPOTENT — a second run writes zero, and rows that
 * already carry the right shard are untouched.
 * Plus: readers stay LEGACY until the migration marker says every row carries
 * the field (fail-closed), and each reader in sharded mode reaches rows on
 * every shard. Constants are imported from the module, never re-typed.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  PE_HISTORY_INDEX_SHARD_COUNT,
  PE_HISTORY_INDEX_SHARD_FIELD,
  PE_HISTORY_INDEX_SHARD_IDS,
  PE_HISTORY_INDEX_SHARD_MIGRATION_COLLECTION,
  PE_HISTORY_INDEX_SHARD_MIGRATION_DOC,
  PE_HISTORY_INDEX_SHARD_MIGRATION_SCHEMA,
  collectAcrossShards,
  enableShardedReaders,
  hasCorrectIndexShard,
  peHistoryIndexShard,
  readPeHistoryReaderMode,
  shardPlan,
  withIndexShard,
} from './pe-history-index-shard';
import {
  backfillPeHistoryIndexShard,
  verifyIndexShardCoverage,
} from './pe-history-index-shard-backfill';

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

function db(fake: FakeFirestore): Firestore {
  return fake as unknown as Firestore;
}

/** Enough ids to land on EVERY shard — asserted, never assumed. */
function idsCoveringEveryShard(prefix: string): string[] {
  const ids: string[] = [];
  const seen = new Set<number>();
  for (let i = 0; seen.size < PE_HISTORY_INDEX_SHARD_COUNT || ids.length < 40; i += 1) {
    const id = `${prefix}-${i}`;
    ids.push(id);
    seen.add(peHistoryIndexShard(id));
    if (i > 5000) throw new Error('shard function never covered every shard');
  }
  return ids;
}

function seedPending(fake: FakeFirestore, ids: readonly string[], status: string, withShard: boolean): void {
  ids.forEach((peId, i) => {
    fake.store.set(`pe_history/${peId}`, {
      peId,
      userId: 'user-1',
      actionType: 'send',
      mint_status: status,
      jurisdiction_context: 'US',
      timestamp: NOW - 1_000_000 + i,
      ...(withShard ? { [PE_HISTORY_INDEX_SHARD_FIELD]: peHistoryIndexShard(peId) } : {}),
    });
  });
}

describe('peHistoryIndexShard', () => {
  it('is deterministic, in range, and spreads a population over every shard', () => {
    const ids = idsCoveringEveryShard('pe');
    const shards = new Set(ids.map(peHistoryIndexShard));
    expect(shards.size).toBe(PE_HISTORY_INDEX_SHARD_COUNT);
    for (const id of ids) {
      const s = peHistoryIndexShard(id);
      expect(s).toBe(peHistoryIndexShard(id));
      expect(PE_HISTORY_INDEX_SHARD_IDS).toContain(s);
    }
    expect(hasCorrectIndexShard('x', { [PE_HISTORY_INDEX_SHARD_FIELD]: peHistoryIndexShard('x') })).toBe(true);
    expect(hasCorrectIndexShard('x', { [PE_HISTORY_INDEX_SHARD_FIELD]: (peHistoryIndexShard('x') + 1) % PE_HISTORY_INDEX_SHARD_COUNT })).toBe(false);
    expect(hasCorrectIndexShard('x', {})).toBe(false);
  });
});

describe('reader mode — data-driven, fail-closed to legacy', () => {
  it('no marker → legacy; wrong schema or shard count → legacy; enabled marker → sharded', async () => {
    const fake = createFakeFirestore();
    expect(await readPeHistoryReaderMode(db(fake))).toBe('legacy');
    expect(shardPlan('legacy')).toEqual([null]);

    fake.store.set(`${PE_HISTORY_INDEX_SHARD_MIGRATION_COLLECTION}/${PE_HISTORY_INDEX_SHARD_MIGRATION_DOC}`, {
      schema_version: PE_HISTORY_INDEX_SHARD_MIGRATION_SCHEMA,
      sharded_readers_enabled: true,
      shard_count: PE_HISTORY_INDEX_SHARD_COUNT + 1, // a foreign shard count must not enable
    });
    expect(await readPeHistoryReaderMode(db(fake))).toBe('legacy');

    await enableShardedReaders(db(fake), { nowMs: NOW, evidence: 'test' });
    expect(await readPeHistoryReaderMode(db(fake))).toBe('sharded');
    expect(shardPlan('sharded')).toEqual([...PE_HISTORY_INDEX_SHARD_IDS]);
    expect(withIndexShard(db(fake).collection('pe_history'), null)).toBeDefined();
  });
});

describe('collectAcrossShards — RED 1: forgetting one shard misses rows', () => {
  it('the full fan-out finds every row; N−1 shards lose the rows on the missing one', async () => {
    const fake = createFakeFirestore();
    const ids = idsCoveringEveryShard('fan');
    seedPending(fake, ids, 'deferred', true);
    const build = (shard: number) => withIndexShard(db(fake).collection('pe_history'), shard)
      .where('mint_status', '==', 'deferred')
      .orderBy('timestamp', 'asc');
    const orderBy = (doc: { data(): Record<string, unknown> }) => doc.data().timestamp as number;

    const all = await collectAcrossShards(build, { limit: 1000, orderBy, map: (d) => d.id });
    expect(new Set(all)).toEqual(new Set(ids));
    // Empty-population guard on the control: the forgotten shard really holds rows.
    const forgotten = PE_HISTORY_INDEX_SHARD_IDS[PE_HISTORY_INDEX_SHARD_COUNT - 1];
    const onForgotten = ids.filter((id) => peHistoryIndexShard(id) === forgotten);
    expect(onForgotten.length).toBeGreaterThan(0);

    const partial = await collectAcrossShards(build, {
      limit: 1000, orderBy, map: (d) => d.id, shards: PE_HISTORY_INDEX_SHARD_IDS.slice(0, -1),
    });
    expect(partial.length).toBe(ids.length - onForgotten.length);
    for (const id of onForgotten) expect(partial).not.toContain(id);
    // …and the merge is oldest-first across shards, cut to the limit.
    const firstThree = await collectAcrossShards(build, { limit: 3, orderBy, map: (d) => d.data().timestamp as number });
    expect(firstThree).toEqual([...firstThree].sort((a, b) => a - b));
    expect(firstThree[0]).toBe(NOW - 1_000_000);
  });
});

describe('backfill — RED 2: idempotent by the field', () => {
  it('stamps missing/wrong rows once; a second run writes zero; coverage verifies', async () => {
    const fake = createFakeFirestore();
    const ids = idsCoveringEveryShard('bf');
    seedPending(fake, ids, 'eligible', false);
    // One row already correct, one deliberately WRONG.
    fake.store.set(`pe_history/${ids[0]}`, { ...fake.store.get(`pe_history/${ids[0]}`)!, [PE_HISTORY_INDEX_SHARD_FIELD]: peHistoryIndexShard(ids[0]) });
    fake.store.set(`pe_history/${ids[1]}`, { ...fake.store.get(`pe_history/${ids[1]}`)!, [PE_HISTORY_INDEX_SHARD_FIELD]: (peHistoryIndexShard(ids[1]) + 1) % PE_HISTORY_INDEX_SHARD_COUNT });

    const before = await verifyIndexShardCoverage(db(fake), 7);
    expect(before).toEqual({ scanned: ids.length, missing: ids.length - 2, wrong: 1 });

    const dry = await backfillPeHistoryIndexShard(db(fake), { apply: false, pageSize: 7 });
    expect(dry.written).toBe(ids.length - 1);
    expect(dry.complete).toBe(true);
    expect(fake.store.get(`pe_history/${ids[2]}`)).not.toHaveProperty(PE_HISTORY_INDEX_SHARD_FIELD);

    const first = await backfillPeHistoryIndexShard(db(fake), { apply: true, pageSize: 7 });
    expect(first.written).toBe(ids.length - 1);
    expect(first.scanned).toBe(ids.length);
    for (const id of ids) expect(hasCorrectIndexShard(id, fake.store.get(`pe_history/${id}`))).toBe(true);

    const second = await backfillPeHistoryIndexShard(db(fake), { apply: true, pageSize: 7 });
    expect(second.written).toBe(0);
    expect(second.scanned).toBe(ids.length);
    expect(await verifyIndexShardCoverage(db(fake), 7)).toEqual({ scanned: ids.length, missing: 0, wrong: 0 });
  });

  it('a budgeted run stops with complete:false and resumes after its last id', async () => {
    const fake = createFakeFirestore();
    const ids = idsCoveringEveryShard('rs');
    seedPending(fake, ids, 'eligible', false);
    let tick = 0;
    const partial = await backfillPeHistoryIndexShard(db(fake), {
      apply: true, pageSize: 5, maxRunMs: 1, now: () => (tick += 1),
    });
    expect(partial.complete).toBe(false);
    expect(partial.written).toBe(5);
    const rest = await backfillPeHistoryIndexShard(db(fake), { apply: true, pageSize: 5, startAfterId: partial.lastId });
    expect(rest.complete).toBe(true);
    expect(partial.written + rest.written).toBe(ids.length);
  });
});
