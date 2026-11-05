/**
 * the watch registry's own invariants: it reads as "not seeded" until the seed
 * completes (never as an empty watched set), an entry is accepted only in its own shard, and a
 * removal mark or un-park never deletes a registry entry.
 */
import { describe, expect, it } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { registryWatchSource } from './watch-source';
import {
  WATCH_REGISTRY_COLLECTION,
  WATCH_REGISTRY_SHARDS,
  addWatchRegistryEntries,
  WATCH_REGISTRY_MARKS_COLLECTION,
  markWatchRegistrySeeded,
  parkAddresses,
  recordWatchRegistryEntry,
  readWatchMarks,
  readWatchRegistry,
  seedWatchMarks,
  unmarkAddresses,
  watchRegistryAddresses,
  watchRegistryShardOf,
} from './watch-registry';

const A = '0x' + 'ab'.repeat(20);

describe('watch registry', () => {
  it('reads null until seeded, then the entries', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await addWatchRegistryEntries(db, [{ kind: 'native', address: A }], 1);
    expect(await readWatchRegistry(db)).toBeNull();
    await markWatchRegistrySeeded(db, 1);
    const snapshot = await readWatchRegistry(db);
    expect(snapshot && watchRegistryAddresses(snapshot)).toEqual([A]);
  });

  it('RED CONTROL — an entry stored in a shard that is not its own refuses the read', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await addWatchRegistryEntries(db, [{ kind: 'native', address: A }], 1);
    await markWatchRegistrySeeded(db, 1);
    const own = watchRegistryShardOf(A);
    const other = (own + 1) % WATCH_REGISTRY_SHARDS;
    const id = (n: number) => `s${String(n).padStart(2, '0')}`;
    const doc = fake.store.get(`${WATCH_REGISTRY_COLLECTION}/${id(own)}`) as Record<string, unknown>;
    fake.store.set(`${WATCH_REGISTRY_COLLECTION}/${id(other)}`, doc);
    await expect(readWatchRegistry(db)).rejects.toThrow(`watch_registry_shard_invalid:${id(other)}`);
  });

  it('un-marking removes the mark only; the registry entry stays', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await addWatchRegistryEntries(db, [{ kind: 'native', address: A }], 1);
    await markWatchRegistrySeeded(db, 1);
    await seedWatchMarks(db, 'inbound_usdc', [A], 1);
    expect(await readWatchMarks(db, 'inbound_usdc')).toEqual(new Set([A]));
    await unmarkAddresses(db, 'inbound_usdc', [A]);
    expect(await readWatchMarks(db, 'inbound_usdc')).toEqual(new Set());
    const snapshot = await readWatchRegistry(db);
    expect(snapshot && watchRegistryAddresses(snapshot)).toEqual([A]);
  });

  it('a registration writes only its registry entry: nothing per day, however many register', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    for (let i = 0; i < 50; i += 1) {
      const address = `0x${(0x1000 + i).toString(16).repeat(10)}`;
      await db.runTransaction(async (txn) => { recordWatchRegistryEntry(txn, db, 'native', address, 1_000 + i); });
    }
    const marksDocs = [...fake.store.keys()].filter((k) => k.startsWith(`${WATCH_REGISTRY_MARKS_COLLECTION}/`));
    expect(marksDocs).toEqual([]);
  });

  it('a park holds until the address is registered or proved again, then lapses', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await addWatchRegistryEntries(db, [{ kind: 'native', address: A }], 1_000);
    await markWatchRegistrySeeded(db, 1_000);
    await seedWatchMarks(db, 'inbound_usdc', [], 1_000);
    await parkAddresses(db, 'inbound_usdc', [A], 0, 2_000);
    const source = registryWatchSource<{ address: string }>({
      db, watcher: 'inbound_usdc', direction: 'inbound', chainId: 8453, logPrefix: '[test]',
      addressOf: (w) => w.address,
      resolveAddress: async () => { throw new Error('not_resolved_here'); },
    });
    expect((await source.load(3_000)).parked).toEqual(new Set([A]));
    // RED twin: the same park, with a registration of the address recorded after it.
    await db.runTransaction(async (txn) => { recordWatchRegistryEntry(txn, db, 'native', A, 2_500); });
    expect((await source.load(3_000)).parked).toEqual(new Set());
  });
});
