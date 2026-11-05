import { Firestore } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'crypto';
import { privateFirestore } from '../provenance/private-store';
import { BatchPricingCounters, NOVELTY_COUNTERS_COLLECTION, NoveltyCounterConflictError } from './batch-pricing-counters';
import { PACKED_COUNTER_CONFIG, PACKED_DAY_COUNTERS } from './packed-day-counters';
jest.setTimeout(60_000);
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('packed daily counters preserve exact ordinals through the format cutover', () => {
  let raw: Firestore, db: Firestore;
  const now = Date.parse('2026-10-30T12:00:00Z'), day = '2026-10-30', secret = process.env.RELAY_SIGNING_KEY;
  const cache = { getUserDailyPECountStrict: async () => 0, getUserActionTypeCountStrict: async () => 0 };
  const id = (value: string) => createHash('sha256').update(value).digest('hex');
  beforeAll(async () => {
    process.env.RELAY_SIGNING_KEY = 'public-packed-counter-emulator-key';
    raw = new Firestore({ projectId: 'demo-packed-counters', databaseId: 'counter-' + randomUUID().slice(0, 8) });
    await raw.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: true, opaque_records_complete: true }); db = privateFirestore(raw);
  });
  afterAll(async () => { await raw.terminate(); if (secret === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = secret; });
  async function commit(counters: BatchPricingCounters): Promise<void> { await db.runTransaction(async txn => { await counters.inspect(txn); counters.commit(txn); }); }
  it('rejects a scalar quote spanning activation, then carries durable 11/7 rather than Redis zero', async () => {
    const actor = 'legacy';
    await db.collection(NOVELTY_COUNTERS_COLLECTION).doc(id(`pe_rate:daily:${actor}:${day}`)).set({ count: 11 });
    await db.collection(NOVELTY_COUNTERS_COLLECTION).doc(id(`pvt:occ:${actor}:coding_session:${day}`)).set({ count: 7 });
    const stale = new BatchPricingCounters(true, ['coding_session']);
    expect(await stale.counts(db, cache, actor, 'coding_session', now)).toEqual([11, 7]); stale.stageCounts(actor, 'coding_session', now);
    await db.collection(PACKED_COUNTER_CONFIG).doc('live').set({ packed_from_day: day, legacy_seed_through_day: day });
    await expect(commit(stale)).rejects.toBeInstanceOf(NoveltyCounterConflictError);
    const fresh = new BatchPricingCounters(true, ['coding_session']);
    expect(await fresh.counts(db, cache, actor, 'coding_session', now)).toEqual([11, 7]); fresh.stageCounts(actor, 'coding_session', now); await commit(fresh);
    expect(await new BatchPricingCounters(true).counts(db, cache, actor, 'coding_session', now)).toEqual([12, 8]);
  });
  it('allocates simultaneous devices once, forcing the loser to price at the next ordinal', async () => {
    const a = new BatchPricingCounters(true), b = new BatchPricingCounters(true);
    expect(await a.counts(db, cache, 'race', 'coding_session', now)).toEqual([0, 0]);
    expect(await b.counts(db, cache, 'race', 'coding_session', now)).toEqual([0, 0]);
    a.stageCounts('race', 'coding_session', now); b.stageCounts('race', 'coding_session', now);
    const results = await Promise.allSettled([commit(a), commit(b)]); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const retry = new BatchPricingCounters(true); expect(await retry.counts(db, cache, 'race', 'coding_session', now)).toEqual([1, 1]);
  });
  it('keeps daily and action counts distinct even for an action literally named daily', async () => {
    const counters = new BatchPricingCounters(true);
    expect(await counters.counts(db, cache, 'types', 'coding_session', now)).toEqual([0, 0]); counters.stageCounts('types', 'coding_session', now);
    expect(await counters.counts(db, cache, 'types', 'daily', now)).toEqual([1, 0]); counters.stageCounts('types', 'daily', now); await commit(counters);
    expect(await new BatchPricingCounters(true).counts(db, cache, 'types', 'daily', now)).toEqual([2, 1]);
  });
  it('persists a non-batch seed before Redis increments so an interrupted seal cannot seed from itself', async () => {
    let mirrored = 4; const mirror = { getUserDailyPECountStrict: async () => mirrored, getUserActionTypeCountStrict: async () => mirrored };
    expect(await new BatchPricingCounters(false).counts(db, mirror, 'recovery', 'coding_session', now)).toEqual([4, 4]); mirrored++;
    const retry = new BatchPricingCounters(false); expect(await retry.counts(db, mirror, 'recovery', 'coding_session', now)).toEqual([4, 4]); retry.stageCounts('recovery', 'coding_session', now); await commit(retry);
    expect(await new BatchPricingCounters(false).counts(db, mirror, 'recovery', 'coding_session', now)).toEqual([5, 5]);
  });
  it('old pending days retain their scalar counts; new clean days share one packed document', async () => {
    const yesterday = now - 86400000, date = '2026-10-29', actor = 'old-pending';
    await db.collection(NOVELTY_COUNTERS_COLLECTION).doc(id(`pe_rate:daily:${actor}:${date}`)).set({ count: 9 });
    expect(await new BatchPricingCounters(true).counts(db, cache, actor, 'coding_session', yesterday)).toEqual([9, 0]);
    const tomorrow = now + 86400000, fresh = new BatchPricingCounters(true, ['coding_session', 'agent_tool_orchestration']);
    expect(await fresh.counts(db, cache, 'future', 'coding_session', tomorrow)).toEqual([0, 0]); fresh.stageCounts('future', 'coding_session', tomorrow);
    expect(await fresh.counts(db, cache, 'future', 'agent_tool_orchestration', tomorrow)).toEqual([1, 0]); fresh.stageCounts('future', 'agent_tool_orchestration', tomorrow); await commit(fresh);
    expect((await db.collection(PACKED_DAY_COUNTERS).where('actor_id', '==', 'future').get()).size).toBe(1);
  });
  it('refuses an uncertified opaque cutover rather than losing a legacy scalar seed', async () => {
    const collection = NOVELTY_COUNTERS_COLLECTION, actor = 'uncertified';
    await raw.collection(collection).doc(id(`pe_rate:daily:${actor}:${day}`)).set({ count: 5 });
    await raw.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: false, opaque_records_complete: false });
    try { await expect(new BatchPricingCounters(true).counts(db, cache, actor, 'coding_session', now)).rejects.toThrow('packed_counter_legacy_storage_uncertified'); }
    finally { await raw.collection(collection).doc(id(`pe_rate:daily:${actor}:${day}`)).delete(); await raw.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: true, opaque_records_complete: true }); }
  });
  it('retains the strict Redis outage fence', async () => {
    const unavailable = { ...cache, getUserDailyPECountStrict: async () => { throw new Error('strict_redis_down'); } };
    await expect(new BatchPricingCounters(true).counts(db, unavailable, 'outage', 'coding_session', now)).rejects.toThrow('strict_redis_down');
  });
});
