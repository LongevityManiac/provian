import { Firestore } from 'firebase-admin/firestore';
import { randomUUID } from 'crypto';
import { privateFirestore, privateStorageId, encodePrivateRecord } from '../provenance/private-store';
import { PRIVATE_RETENTION_STATE_COLLECTION as STATE, PRIVATE_RETENTION_STATE_DOC as DOC } from '../provenance/private-retention';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { AUTOMATIC_MEMBERSHIP_FOLLOWUPS, runAutomaticMembershipSweep } from './automatic-membership';

/**
 * The membership sweep against the real private store, where every account is
 * encrypted under an opaque id: one full pass reads each account once however
 * many runs it takes, and the follow-up list reads only the members that are due.
 */
const suite = /^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') ? describe : describe.skip;
jest.setTimeout(120_000);
suite('the membership sweep reads each account once per pass', () => {
  let raw: Firestore, db: Firestore; const prior = process.env.RELAY_SIGNING_KEY;
  beforeEach(async () => {
    process.env.RELAY_SIGNING_KEY = 'public-membership-sweep-cost-proof';
    raw = new Firestore({ projectId: 'demo-membership-sweep', databaseId: `sweep-${randomUUID().slice(0, 8)}` });
    db = privateFirestore(raw);
    await raw.collection(STATE).doc(DOC).set({ opaque_ids_ready: true, opaque_records_complete: true, range_lookup_version: 1 });
  });
  afterEach(async () => { jest.restoreAllMocks(); await raw.terminate(); if (prior === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = prior; });
  const owner = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  function physicalReads(collection: string): Map<string, number> {
    const hits = new Map<string, number>();
    const count = (docs: readonly FirebaseFirestore.QueryDocumentSnapshot[]) => { for (const doc of docs) if (doc.ref.parent.id === collection) hits.set(doc.id, (hits.get(doc.id) ?? 0) + 1); };
    const run = raw.runTransaction.bind(raw);
    jest.spyOn(raw, 'runTransaction').mockImplementation(((fn: (tx: FirebaseFirestore.Transaction) => unknown, options: unknown) =>
      run(async tx => fn(new Proxy(tx, { get(target, prop) {
        if (prop === 'get') return async (query: FirebaseFirestore.Query) => { const snap = await tx.get(query) as FirebaseFirestore.QuerySnapshot; count(snap.docs ?? []); return snap; };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } })), options as FirebaseFirestore.ReadOnlyTransactionOptions)) as typeof raw.runTransaction);
    const query = Object.getPrototypeOf(raw.collection(collection));
    const get = query.get as () => Promise<FirebaseFirestore.QuerySnapshot>;
    jest.spyOn(query, 'get').mockImplementation(async function (this: FirebaseFirestore.Query) { const snap = await get.call(this); count(snap.docs); return snap; });
    return hits;
  }
  it('300 members over several runs: each account is read once, every member visited once', async () => {
    for (let at = 0; at < 300; at += 100) {
      const batch = raw.batch();
      for (let i = at; i < at + 100; i++) batch.create(raw.collection(C.owners).doc(privateStorageId(C.owners, owner(i))), encodePrivateRecord(C.owners, owner(i), { ownerIdentity: owner(i), needsScan: false }));
      await batch.commit();
    }
    const hits = physicalReads(C.owners), visited: string[] = [];
    let clock = Date.UTC(2026, 11, 1, 6), runs = 0;
    while (runs < 50) {
      let steps = 0; runs++;
      const result = await runAutomaticMembershipSweep(db, { deadlineMs: clock + 3_600_000, now: () => clock, concurrency: 8,
        backlog: async () => steps++ < 5 ? 0 : 99, collect: async (_db, o) => { visited.push(o); return 'settled'; } });
      if (result.passes === 1) break;
    }
    expect(runs).toBeGreaterThan(2);
    expect(visited).toHaveLength(300);
    expect(new Set(visited).size).toBe(300);
    expect(hits.size).toBe(300);
    expect([...hits.values()].every(n => n === 1)).toBe(true);
  });
  it('the follow-up list reads only the members that are due', async () => {
    const now = Date.UTC(2026, 11, 1, 6);
    for (let i = 0; i < 200; i++) await db.collection(AUTOMATIC_MEMBERSHIP_FOLLOWUPS).doc(owner(i)).set({ ownerIdentity: owner(i), attempts: 1, dueAtMs: i < 5 ? now - 1 : now + 3_600_000 });
    // No members, so the pass itself reads nothing; only the follow-ups are visited.
    await db.collection('recourse_private_membership_sweep_v1').doc('cursor').set({ pass: null, restUntilMs: now + 86_400_000 });
    const hits = physicalReads(AUTOMATIC_MEMBERSHIP_FOLLOWUPS), visited: string[] = [];
    const result = await runAutomaticMembershipSweep(db, { deadlineMs: now + 60_000, now: () => now, concurrency: 8, collect: async (_db, o) => { visited.push(o); return 'settled'; } });
    expect(result.followups).toBe(5);
    expect(visited.sort()).toEqual([0, 1, 2, 3, 4].map(owner));
    expect(hits.size).toBe(5);
  });
});
