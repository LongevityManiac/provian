import { Firestore } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'crypto';
import { privateFirestore } from '../provenance/private-store';
import { BatchPricingCounters, NOVELTY_COUNTERS_COLLECTION, NoveltyCounterConflictError } from './batch-pricing-counters';
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('sparse daily counters preserve legacy ordinals and reject competing first creates', () => {
  let raw: Firestore, db: Firestore;
  const now = 1_800_000_000_000, day = new Date(now).toISOString().slice(0, 10), secret = process.env.RELAY_SIGNING_KEY;
  const cache = { getUserDailyPECountStrict: async () => 0, getUserActionTypeCountStrict: async () => 0 };
  beforeAll(async () => {
    process.env.RELAY_SIGNING_KEY = 'public-sparse-counter-emulator-key';
    raw = new Firestore({ projectId: 'demo-sparse-counters', databaseId: 'counter-' + randomUUID().slice(0, 8) });
    await raw.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: true, opaque_records_complete: true }); db = privateFirestore(raw);
  });
  afterAll(async () => { await raw.terminate(); if (secret === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = secret; });
  const id = (value: string) => createHash('sha256').update(value).digest('hex');
  async function commit(counters: BatchPricingCounters): Promise<void> { await db.runTransaction(async txn => { await counters.inspect(txn); counters.commit(txn); }); }
  it('RED stale quote detects a counter another writer changed; a fresh quote uses that exact durable ordinal', async () => {
    const actor = 'legacy', daily = `pe_rate:daily:${actor}:${day}`, action = `pvt:occ:${actor}:coding_session:${day}`;
    await db.collection(NOVELTY_COUNTERS_COLLECTION).doc(id(daily)).set({ count: 11 });
    await db.collection(NOVELTY_COUNTERS_COLLECTION).doc(id(action)).set({ count: 7 });
    const old = new BatchPricingCounters(true, ['coding_session', 'agent_tool_orchestration']);
    expect(await old.counts(db, cache, actor, 'coding_session', now)).toEqual([11, 7]); old.stageCounts(actor, 'coding_session', now);
    await db.collection(NOVELTY_COUNTERS_COLLECTION).doc(id(action)).update({ count: 9 });
    await expect(commit(old)).rejects.toBeInstanceOf(NoveltyCounterConflictError);
    const fresh = new BatchPricingCounters(true, ['coding_session']); expect(await fresh.counts(db, cache, actor, 'coding_session', now)).toEqual([11, 9]); fresh.stageCounts(actor, 'coding_session', now); await commit(fresh);
    expect((await db.collection(NOVELTY_COUNTERS_COLLECTION).doc(id(action)).get()).get('count')).toBe(10);
  });
  it('only one simultaneous absent-counter allocation commits; its loser must reprice rather than overwrite', async () => {
    const actor = 'race', a = new BatchPricingCounters(true, ['coding_session']), b = new BatchPricingCounters(true, ['coding_session']);
    expect(await a.counts(db, cache, actor, 'coding_session', now)).toEqual([0, 0]);
    expect(await b.counts(db, cache, actor, 'coding_session', now)).toEqual([0, 0]);
    a.stageCounts(actor, 'coding_session', now); b.stageCounts(actor, 'coding_session', now);
    const results = await Promise.allSettled([commit(a), commit(b)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const retry = new BatchPricingCounters(true, ['coding_session']); expect(await retry.counts(db, cache, actor, 'coding_session', now)).toEqual([1, 1]); retry.stageCounts(actor, 'coding_session', now); await commit(retry);
    expect((await db.collection(NOVELTY_COUNTERS_COLLECTION).doc(id(`pvt:occ:${actor}:coding_session:${day}`)).get()).get('count')).toBe(2);
  });
  it('strict Redis unavailability still prevents allocation even when Firestore is readable', async () => {
    const counters = new BatchPricingCounters(true, ['coding_session']);
    const unavailable = { ...cache, getUserDailyPECountStrict: async () => { throw new Error('strict_redis_down'); } };
    await expect(counters.counts(db, unavailable, 'outage', 'coding_session', now)).rejects.toThrow('strict_redis_down');
    expect((await db.collection(NOVELTY_COUNTERS_COLLECTION).doc(id(`pe_rate:daily:outage:${day}`)).get()).exists).toBe(false);
  });
});
