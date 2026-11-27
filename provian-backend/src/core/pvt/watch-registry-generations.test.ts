/**
 * Watch-registry generations: past the alarm line the reconcile opens the next generation, new
 * entries go there, and every reader still finds every address in every generation. Marks follow
 * the same generations, and a removal clears an address in all of them.
 */
import { describe, expect, it, beforeEach } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  WATCH_REGISTRY_COLLECTION,
  WATCH_REGISTRY_SHARD_WARN_ENTRIES,
  addWatchRegistryEntries,
  hasWatchRegistryEntry,
  markWatchRegistrySeeded,
  openNextWatchRegistryGeneration,
  readWatchMarks,
  readWatchRegistry,
  resetWatchRegistryGenerationCacheForTests,
  seedWatchMarks,
  unmarkAddresses,
  watchRegistryAddresses,
  watchRegistryShardOf,
  writeWatchMarks,
} from './watch-registry';
import { runWatchRegistryReconcile } from './watch-registry-reconcile';

const A = '0x' + 'ab'.repeat(20);
const B = '0x' + 'cd'.repeat(20);
const shard = (address: string, generation: number): string => {
  const base = `s${String(watchRegistryShardOf(address)).padStart(2, '0')}`;
  return generation === 0 ? base : `g${generation}_${base}`;
};

beforeEach(() => resetWatchRegistryGenerationCacheForTests());

describe('watch registry generations', () => {
  it('an entry written after a generation opens lands in it, and the read finds both generations', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await addWatchRegistryEntries(db, [{ kind: 'native', address: A }], 1);
    await markWatchRegistrySeeded(db, 1);
    expect(await openNextWatchRegistryGeneration(db, 0, 2)).toBe(1);
    await addWatchRegistryEntries(db, [{ kind: 'agent_proven', address: B }], 3);
    expect(fake.store.get(`${WATCH_REGISTRY_COLLECTION}/${shard(B, 1)}`)).toBeDefined();
    const zero = fake.store.get(`${WATCH_REGISTRY_COLLECTION}/${shard(B, 0)}`) as { e?: Record<string, number> } | undefined;
    expect(zero?.e?.[`agent_proven|${B}`]).toBeUndefined();
    const snapshot = await readWatchRegistry(db);
    expect(snapshot && watchRegistryAddresses(snapshot)).toEqual([A, B].sort());
    expect(snapshot?.writeGeneration).toBe(1);
    expect(await hasWatchRegistryEntry(db, 'agent_proven', B)).toBe(true);
    expect(await hasWatchRegistryEntry(db, 'native', A)).toBe(true);
    // RED: an address in neither generation is not found.
    expect(await hasWatchRegistryEntry(db, 'native', B)).toBe(false);
  });

  it('opening is compare-and-set: a stale expected generation opens nothing', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await markWatchRegistrySeeded(db, 1);
    expect(await openNextWatchRegistryGeneration(db, 0, 2)).toBe(1);
    expect(await openNextWatchRegistryGeneration(db, 0, 3)).toBe(1);
  });

  it('the reconcile opens the next generation once a write-generation shard passes the alarm line; RED: below it, it does not', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await markWatchRegistrySeeded(db, 1);
    const id = `s${String(watchRegistryShardOf(A)).padStart(2, '0')}`;
    const fill = (n: number) => {
      const e: Record<string, number> = {};
      for (let i = 0; i < n; i += 1) {
        // Addresses that hash to A's shard.
        let k = i * 7919;
        let candidate = '';
        do { candidate = '0x' + (k++).toString(16).padStart(40, '0'); } while (watchRegistryShardOf(candidate) !== watchRegistryShardOf(A) || e[`native|${candidate}`]);
        e[`native|${candidate}`] = 1;
      }
      fake.store.set(`${WATCH_REGISTRY_COLLECTION}/${id}`, { schema_version: 'watch-registry/v1', e });
    };
    fill(100);
    await runWatchRegistryReconcile(db, 10, { revision: 'r1' });
    expect((await readWatchRegistry(db))?.writeGeneration).toBe(0);
    fill(WATCH_REGISTRY_SHARD_WARN_ENTRIES + 1);
    await runWatchRegistryReconcile(db, 10 + 86_400_000 * 2, { revision: 'r1' });
    expect((await readWatchRegistry(db))?.writeGeneration).toBe(1);
  }, 60_000);

  it('marks: a mark in a later generation is read, and a removal clears every generation', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    await markWatchRegistrySeeded(db, 1);
    await seedWatchMarks(db, 'chain_record', [A], 1);
    await openNextWatchRegistryGeneration(db, 0, 2);
    await writeWatchMarks(db, 'chain_record', [B], 3);
    expect(await readWatchMarks(db, 'chain_record')).toEqual(new Set([A, B]));
    await unmarkAddresses(db, 'chain_record', [A, B]);
    expect(await readWatchMarks(db, 'chain_record')).toEqual(new Set());
  });
});
