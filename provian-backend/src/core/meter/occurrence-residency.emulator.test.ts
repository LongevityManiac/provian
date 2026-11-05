import { Firestore } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import type { ArchiveObjectStore, ArchiveObjectStat } from '../archive/archive-objects';
import { privateFirestore } from '../provenance/private-store';
import { BatchOccurrences } from './batch-occurrences';
import { BATCH_OCCURRENCES_COLLECTION, occurrenceNodeId, packFingerprints } from './occurrence-tree';
import { OccurrenceResidency, OCCURRENCE_STATES, OCCURRENCE_DORMANCY_MS, occurrenceStateId, occurrenceDueDay, occurrenceDueRef, occurrenceDueRecord, sweepDormantOccurrences } from './occurrence-residency';
import { NoveltyCounterConflictError } from './batch-pricing-counters';
jest.setTimeout(60_000);
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
class MemoryArchive implements ArchiveObjectStore {
  bucket = 'public-emulator-archive';
  objects = new Map<string, Buffer>();
  failNextCreate = false;
  deathAfterManifest = false;
  stat(path: string): Promise<ArchiveObjectStat | null> { return Promise.resolve(this.objects.has(path) ? { size: this.objects.get(path)!.length, generation: '1', md5: null } : null); }
  async create(path: string, bytes: Uint8Array): Promise<ArchiveObjectStat> {
    if (this.failNextCreate) { this.failNextCreate = false; throw new Error('injected_archive_unavailable'); }
    if (this.objects.has(path)) throw new Error('archive_object_exists');
    this.objects.set(path, Buffer.from(bytes));
    if (this.deathAfterManifest && path.includes('/manifest-')) { this.deathAfterManifest = false; throw new Error('death_after_manifest_put'); }
    return (await this.stat(path))!;
  }
  async readRange(path: string, start: number, end: number): Promise<Uint8Array> { return this.objects.get(path)!.subarray(start, end); }
  openRead(path: string): Readable {
    const bytes = this.objects.get(path);
    return bytes ? Readable.from([bytes]) : Readable.from((async function* () { throw new Error('archive_missing'); })());
  }
}
suite('permanent bare occurrence fingerprints: dormant archive and fail-closed restore', () => {
  let raw: Firestore, db: Firestore, store: MemoryArchive, residency: OccurrenceResidency;
  const secret = process.env.RELAY_SIGNING_KEY;
  const first = 1_800_000_000_000, hash = (s: string) => createHash('sha256').update(s).digest('hex');
  beforeAll(async () => {
    process.env.RELAY_SIGNING_KEY = 'public-occurrence-residency-emulator-secret';
    raw = new Firestore({ projectId: 'demo-occurrence-archive', databaseId: 'proof-' + randomUUID().slice(0, 8) });
    await raw.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: true, opaque_records_complete: true });
    await raw.collection('meter_occurrence_carry_v1').doc('live').set({ complete: true });
    db = privateFirestore(raw); store = new MemoryArchive(); residency = new OccurrenceResidency(db, store);
  });
  afterAll(async () => { await raw.terminate(); if (secret === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = secret; });
  async function commit(batch: BatchOccurrences): Promise<void> { await db.runTransaction(async txn => { await batch.inspect(txn); batch.commit(txn); }); }
  async function seed(actor: string): Promise<void> {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(first);
    try { const batch = new BatchOccurrences(db, residency); expect(await batch.claim(actor, hash(actor))).toBe(true); await commit(batch); }
    finally { clock.mockRestore(); }
  }
  it('retains a bare 32-byte fingerprint forever and restores it before another device can price', async () => {
    const actor = 'dormant-actor'; await seed(actor);
    const node = (await db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(actor, '')).get()).data()!;
    expect(node.members).toBeUndefined(); expect(Buffer.isBuffer(node.fingerprints)).toBe(true); expect(node.fingerprints.length).toBe(32); expect(node.expire_at).toBeUndefined();
    expect(await residency.archive(actor, first + OCCURRENCE_DORMANCY_MS - 1)).toBe(false);
    expect(await residency.archive(actor, first + OCCURRENCE_DORMANCY_MS)).toBe(true);
    expect((await db.collection(BATCH_OCCURRENCES_COLLECTION).where('actor_id', '==', actor).get()).docs.every(d => !d.get('fingerprints') && !d.get('members'))).toBe(true);
    const state = (await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)).get()).data()!;
    expect(state.residency).toBe('cold'); expect([...store.objects.entries()].filter(([p]) => p.endsWith('.bin')).map(([, bytes]) => bytes.length)).toEqual([32]);
    expect([...store.objects.entries()].filter(([p]) => p.endsWith('.bin')).every(([, bytes]) => !bytes.includes(Buffer.from(actor)))).toBe(true);
    const returning = new BatchOccurrences(db, residency);
    expect(await returning.claim(actor, hash(actor))).toBe(false);
    expect(await returning.claim(actor, hash(actor + '-new'))).toBe(true); // RED deny-everything control
    await commit(returning);
    const hot = (await db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(actor, '')).get()).data()!;
    expect(hot.fingerprints.length).toBe(64); expect([...store.objects.keys()].filter(p => p.endsWith('.bin')).length).toBe(1); // immutable archive never deleted/replaced
  });
  it('RED recovered completion ownership gets permanent membership in the same transaction that schedules metadata expiry', async () => {
    const { prepareMintOnceClaim, inspectPreparedMintOnceClaimInTransaction, applyMintOnceClaimDecision, prepareRetireRecoveredMintOnceMetadata, ClosedCrossWitnessOccurrenceError } = await import('../pvt/mint-once-claim');
    const { Timestamp } = await import('firebase-admin/firestore');
    const input = { kind: 'completion' as const, subjectId: 'recovered-owner', eventId: 'human_job:hjob_recovered-cost', userId: 'recovered-owner', peId: 'pe_original_held', nowMs: first };
    const plan = await prepareMintOnceClaim(db, input), ref = db.collection(plan.claim_collection).doc(plan.evidence.claim.claim_id);
    await db.runTransaction(async txn => { applyMintOnceClaimDecision(db, txn, await inspectPreparedMintOnceClaimInTransaction(db, txn, plan)); });
    expect((await ref.get()).get('expire_at')).toBeUndefined();
    await db.runTransaction(async txn => { const finish = await prepareRetireRecoveredMintOnceMetadata(db, txn, input.peId, [plan.evidence], Timestamp.fromMillis(first + 31 * 86400000)); finish(); });
    expect((await ref.get()).get('expire_at').toMillis()).toBe(first + 31 * 86400000);
    await ref.delete();
    await expect(prepareMintOnceClaim(db, { ...input, peId: 'pe_second_device', nowMs: first + 100 * 86400000 })).rejects.toBeInstanceOf(ClosedCrossWitnessOccurrenceError);
    expect((await prepareMintOnceClaim(db, { ...input, eventId: 'human_job:hjob_distinct-cost', peId: 'pe_distinct' })).evidence.relation).toBe('owner');
  });
  it('rejects a missing or corrupted archive before exposing an empty membership set', async () => {
    const actor = 'corrupt-actor'; await seed(actor); await residency.archive(actor, first + OCCURRENCE_DORMANCY_MS);
    const state = (await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)).get()).data()!;
    const manifest = JSON.parse(store.objects.get(state.archive.path)!.toString('utf8')) as { nodes: { object: { path: string } }[] };
    const leaf = manifest.nodes.find(n => n.object)!.object.path;
    const original = store.objects.get(leaf)!;
    store.objects.set(leaf, Buffer.alloc(32, 99));
    await expect(new BatchOccurrences(db, residency).claim(actor, hash(actor))).rejects.toThrow('meter_occurrence_archive_integrity');
    store.objects.delete(leaf);
    await expect(new BatchOccurrences(db, residency).claim(actor, hash(actor))).rejects.toThrow('archive_missing');
    expect((await db.collection(BATCH_OCCURRENCES_COLLECTION).where('actor_id', '==', actor).get()).docs.every(d => !d.get('fingerprints') && !d.get('members'))).toBe(true);
    store.objects.set(leaf, original);
    expect(await new BatchOccurrences(db, residency).claim(actor, hash(actor))).toBe(false);
  });
  it('keeps live fingerprints if upload fails and resumes an interrupted archive on return', async () => {
    const actor = 'upload-failure'; await seed(actor); store.failNextCreate = true;
    await expect(residency.archive(actor, first + OCCURRENCE_DORMANCY_MS)).rejects.toThrow('injected_archive_unavailable');
    expect((await db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(actor, '')).get()).exists).toBe(true);
    expect(await new BatchOccurrences(db, residency).claim(actor, hash(actor))).toBe(false);
    expect((await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)).get()).get('residency')).toBe('hot');
  });
  it('checkpoints a tree across multiple manifests, resumes concurrent helpers, and retains every fingerprint', async () => {
    const actor = 'multi-manifest', writer = db.batch(), rawMembers: string[] = [];
    const node = (prefix: string, split: boolean, members: string[]) => writer.create(db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(actor, prefix)), { actor_id: actor, prefix, revision: 1, split, fingerprints: packFingerprints(members) });
    node('', true, []);
    for (const a of '0123456789abcdef') { node(a, true, []); for (const b of '0123456789abcdef') { const member = (a + b).padEnd(64, '0'); rawMembers.push(member); node(a + b, false, [member]); } }
    writer.create(db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)), { actor_id: actor, residency: 'hot', last_active_at_ms: first, archive_due_day: occurrenceDueDay(first) });
    writer.set(occurrenceDueRef(db, actor), occurrenceDueRecord(actor, first)); await writer.commit();
    await residency.archive(actor, first + OCCURRENCE_DORMANCY_MS, Date.now() - 1);
    const checkpoint = (await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)).get()).data()!;
    expect(checkpoint.residency).toBe('archiving'); expect(checkpoint.archive_build.manifests).toBe(1); expect(checkpoint.archive_build.nodes).toBe(1);
    await Promise.allSettled([residency.hot(actor), residency.hot(actor)]); await residency.hot(actor);
    const restored = (await db.collection(BATCH_OCCURRENCES_COLLECTION).where('actor_id', '==', actor).get()).docs;
    expect(restored).toHaveLength(273); expect(restored.flatMap(doc => { const data = doc.data(); return Array.from({ length: data.fingerprints.length / 32 }, (_, i) => data.fingerprints.subarray(i * 32, (i + 1) * 32).toString('hex')); }).sort()).toEqual(rawMembers.sort());
    expect([...store.objects.entries()].filter(([path]) => path.includes('/manifest-')).every(([, bytes]) => JSON.parse(bytes.toString()).nodes.length <= 128)).toBe(true);
    expect((await occurrenceDueRef(db, actor).get()).get('due_at_ms')).toBeGreaterThan(Date.now() + OCCURRENCE_DORMANCY_MS - 60_000);
  });
  it('RED a manifest uploaded before a crash resumes safely with a different flush boundary', async () => {
    const actor = 'manifest-before-checkpoint', writer = db.batch();
    writer.create(db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(actor, '')), { actor_id: actor, prefix: '', revision: 1, split: true, fingerprints: Buffer.alloc(0) });
    for (const prefix of '0123456789abcdef') writer.create(db.collection(BATCH_OCCURRENCES_COLLECTION).doc(occurrenceNodeId(actor, prefix)), { actor_id: actor, prefix, revision: 1, split: false, fingerprints: packFingerprints([prefix.padEnd(64, '0')]) });
    writer.create(db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)), { actor_id: actor, residency: 'hot', last_active_at_ms: first, archive_due_day: occurrenceDueDay(first) }); await writer.commit();
    store.deathAfterManifest = true; await expect(residency.archive(actor, first + OCCURRENCE_DORMANCY_MS, Date.now() - 1)).rejects.toThrow('death_after_manifest_put');
    expect((await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)).get()).get('archive_build')).toBeUndefined();
    await residency.hot(actor); expect((await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)).get()).get('residency')).toBe('hot');
    const nodes = await db.collection(BATCH_OCCURRENCES_COLLECTION).where('actor_id', '==', actor).get(); expect(nodes.size).toBe(17); expect(nodes.docs.reduce((n, doc) => n + doc.get('fingerprints').length / 32, 0)).toBe(16);
  });
  it('the indexed dormant sweep archives due actors while leaving active actors hot', async () => {
    await seed('sweep-dormant'); await seed('sweep-active');
    await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId('sweep-active')).update({ last_active_at_ms: first + 1, archive_due_day: occurrenceDueDay(first + 1) });
    await occurrenceDueRef(db, 'sweep-active').set(occurrenceDueRecord('sweep-active', first + 1));
    const result = await sweepDormantOccurrences(db, first + OCCURRENCE_DORMANCY_MS, 45000, store); expect(result.examined).toBeGreaterThan(0);
    expect((await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId('sweep-dormant')).get()).get('residency')).toBe('cold');
    expect((await db.collection(OCCURRENCE_STATES).doc(occurrenceStateId('sweep-active')).get()).get('residency')).toBe('hot');
    expect((await occurrenceDueRef(db, 'sweep-dormant').get()).exists).toBe(false);
  });
  it('resumes interrupted offline restoration from the due queue instead of starving later actors', async () => {
    const actor = 'offline-restore'; await seed(actor); await residency.archive(actor, first + OCCURRENCE_DORMANCY_MS);
    const ref = db.collection(OCCURRENCE_STATES).doc(occurrenceStateId(actor)), state = (await ref.get()).data()!;
    await ref.update({ residency: 'restoring', restore_cursor: { object: state.archive, offset: 0, nodes: 0, count: 0 } }); await occurrenceDueRef(db, actor).set(occurrenceDueRecord(actor, first));
    await sweepDormantOccurrences(db, first + OCCURRENCE_DORMANCY_MS, 45000, store);
    expect((await ref.get()).get('residency')).toBe('hot'); expect(await new BatchOccurrences(db, residency).claim(actor, hash(actor))).toBe(false);
  });
  it('forces a complete reprice when archival or another device changes the residency snapshot', async () => {
    const actor = 'race-actor'; await seed(actor);
    const priced = new BatchOccurrences(db, residency); expect(await priced.claim(actor, hash('fresh-racing-work'))).toBe(true);
    await residency.archive(actor, first + OCCURRENCE_DORMANCY_MS);
    expect(await new BatchOccurrences(db, residency).claim(actor, hash(actor))).toBe(false);
    await expect(commit(priced)).rejects.toBeInstanceOf(NoveltyCounterConflictError);
    const retry = new BatchOccurrences(db, residency); expect(await retry.claim(actor, hash('fresh-racing-work'))).toBe(true); await commit(retry);
    expect(await new BatchOccurrences(db, residency).claim(actor, hash('fresh-racing-work'))).toBe(false);
  });
});
