import { createFakeFirestore, compareFirestoreDocumentIds, type FakeCollection, type FakeDocRef, type FakeQuerySnap } from './fake-firestore';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION } from '../native-wallet-registration';

/** Same fixture store, with the native address equality index Firestore actually provides. */
export function createIndexedFirestore(readMs = 0, writeMs = 0) {
  const db = createFakeFirestore();
  const index = new Map<string, Set<string>>();
  const stats = { reads: 0, writes: 0, activeReads: 0, maxReads: 0, peakHeap: 0, baselineHeap: 0 };
  const sampleHeap = () => { stats.peakHeap = Math.max(stats.peakHeap, process.memoryUsage().heapUsed); };
  let timing = false;
  const wait = (ms: number) => ms ? new Promise<void>(resolve => setTimeout(resolve, ms)) : Promise.resolve();
  async function read<T>(work: () => Promise<T>): Promise<T> {
    stats.reads++; stats.activeReads++; stats.maxReads = Math.max(stats.maxReads, stats.activeReads);
    if (stats.reads % 1000 === 0) sampleHeap();
    try { if (timing) await wait(readMs); return await work(); }
    finally { stats.activeReads--; }
  }
  async function write<T>(work: () => Promise<T>): Promise<T> {
    stats.writes++; const result = await work(); if (stats.writes % 1000 === 0) sampleHeap();
    if (timing) await wait(writeMs); return result;
  }
  const prefix = `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/`;
  const track = (key: string, value: Record<string, unknown> | undefined, add: boolean) => {
    if (!key.startsWith(prefix) || typeof value?.address !== 'string') return;
    const id = key.slice(prefix.length), ids = index.get(value.address) ?? new Set<string>();
    if (add) ids.add(id); else ids.delete(id);
    if (ids.size) index.set(value.address, ids); else index.delete(value.address);
  };
  const set = db.store.set.bind(db.store), remove = db.store.delete.bind(db.store), clear = db.store.clear.bind(db.store);
  db.store.set = (key, value) => { track(key, db.store.get(key), false); set(key, value); track(key, value, true); return db.store; };
  db.store.delete = key => { track(key, db.store.get(key), false); return remove(key); };
  db.store.clear = () => { index.clear(); clear(); };
  const collection = db.collection.bind(db);
  const point = (ref: FakeDocRef): FakeDocRef => ({ ...ref,
    get: () => read(() => ref.get()),
    set: (data, options) => write(() => ref.set(data, options)),
    update: data => write(() => ref.update(data)), create: data => write(() => ref.create(data)), delete: () => write(() => ref.delete()),
  });
  db.collection = (name): FakeCollection => {
    const ref = collection(name);
    return { ...ref, doc: id => point(ref.doc(id)), where: (field, op, value) => {
      const query = ref.where(field, op, value);
      if (name !== NATIVE_WALLET_ADDRESS_INDEX_COLLECTION || field !== 'address' || op !== '==' || typeof value !== 'string') return query;
      return { ...query, get: () => read(async (): Promise<FakeQuerySnap> => {
        // Derived from every current stored source row; conflicting/noncanonical rows are retained.
        const ids = [...(index.get(value) ?? [])].sort(compareFirestoreDocumentIds);
        const docs = await Promise.all(ids.map(async id => ({ ...await ref.doc(id).get(), ref: ref.doc(id) })));
        return { docs, empty: docs.length === 0, size: docs.length, forEach: callback => docs.forEach(callback) };
      }) };
    } };
  };
  const transaction = db.runTransaction.bind(db);
  db.runTransaction = async fn => write(() => transaction(fn));
  return { db, stats, sampleHeap, startTiming: () => { timing = true; stats.reads = 0; stats.writes = 0; stats.maxReads = 0; stats.baselineHeap = process.memoryUsage().heapUsed; stats.peakHeap = stats.baselineHeap; } };
}
