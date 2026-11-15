import { Firestore } from 'firebase-admin/firestore';
import { randomUUID } from 'crypto';
import { privateFirestore, privateStorageId, encodePrivateRecord } from '../provenance/private-store';
import { PRIVATE_RETENTION_STATE_COLLECTION as STATE, PRIVATE_RETENTION_STATE_DOC as DOC } from '../provenance/private-retention';
import { BINDING_OPERATIONS } from './binding-operation';
import { anyQueued, laneQueue, laneQueuedFields, type LaneKind } from './transaction-lane';

/**
 * The lane's queue read against the real private store: every lane collection keeps
 * every request it ever held, and the private store can only narrow a physical read
 * by an equality on an indexed field. The queue read must cost the backlog, not the history.
 */
const suite = /^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') ? describe : describe.skip;
jest.setTimeout(120_000);
suite('the lane queue reads only live requests', () => {
  const collection = BINDING_OPERATIONS;
  let raw: Firestore, db: Firestore; const prior = process.env.RELAY_SIGNING_KEY;
  beforeEach(async () => {
    process.env.RELAY_SIGNING_KEY = 'public-lane-queue-cost-proof';
    raw = new Firestore({ projectId: 'demo-lane-queue', databaseId: `lane-${randomUUID().slice(0, 8)}` });
    db = privateFirestore(raw);
    await raw.collection(STATE).doc(DOC).set({ opaque_ids_ready: true, opaque_records_complete: true });
  });
  afterEach(async () => { jest.restoreAllMocks(); await raw.terminate(); if (prior === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = prior; });
  const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  async function seed(history: number, live: readonly number[]) {
    for (let at = 0; at < history; at += 400) {
      const batch = raw.batch();
      for (let i = at; i < Math.min(at + 400, history); i++) {
        batch.create(raw.collection(collection).doc(privateStorageId(collection, id(i))),
          encodePrivateRecord(collection, id(i), { status: i % 3 ? 'confirmed' : 'failed', createdAtMs: i, transactionHash: id(i) }));
      }
      await batch.commit();
    }
    for (const at of live) {
      const n = 10_000 + at;
      await raw.collection(collection).doc(privateStorageId(collection, id(n))).create(
        encodePrivateRecord(collection, id(n), { status: 'queued', createdAtMs: at, transactionHash: null, ...laneQueuedFields(at, id(n)) }));
    }
  }
  /** Physical documents of `collection` the store reads in one call (the store reads inside a pinned transaction). */
  async function physicalReads(read: () => Promise<unknown>): Promise<number> {
    const hits = new Map<string, number>(), run = raw.runTransaction.bind(raw);
    const spy = jest.spyOn(raw, 'runTransaction').mockImplementation(((fn: (tx: FirebaseFirestore.Transaction) => unknown, options: unknown) =>
      run(async tx => fn(new Proxy(tx, { get(target, prop) {
        if (prop === 'get') return async (query: FirebaseFirestore.Query) => {
          const snap = await tx.get(query) as FirebaseFirestore.QuerySnapshot;
          for (const doc of snap.docs ?? []) if (doc.ref.parent.id === collection) hits.set(doc.id, (hits.get(doc.id) ?? 0) + 1);
          return snap;
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } })), options as FirebaseFirestore.ReadOnlyTransactionOptions)) as typeof raw.runTransaction);
    await read();
    spy.mockRestore();
    return [...hits.values()].reduce((a, b) => a + b, 0);
  }
  it('1,200 settled requests and three live ones: the queue returns the live ones oldest first and reads only them', async () => {
    await seed(1_200, [30, 10, 20]);
    let page: FirebaseFirestore.QuerySnapshot | undefined;
    const reads = await physicalReads(async () => { page = await laneQueue(db, collection).limit(25).get(); });
    expect(page!.docs.map(doc => doc.get('createdAtMs'))).toEqual([10, 20, 30]);
    expect(reads).toBe(3);
    const kind = { collection } as LaneKind;
    expect(await physicalReads(() => anyQueued(db, [kind]))).toBe(3);
    // RED control: the same order without the status equality reads every request ever held.
    const unfiltered = await physicalReads(() => db.collection(collection).orderBy('laneQueueKey').limit(25).get());
    expect(unfiltered).toBe(1_203);
  });
});
