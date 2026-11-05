import { createHash } from 'crypto';
import { FieldPath } from 'firebase-admin/firestore';
import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import { decodePrivateRecord, isPrivateFirestore, privateStorageId, rawPrivateFirestore } from '../provenance/private-store';
export const PACKED_DAY_COUNTERS = 'meter_day_counters_v1';
export const PACKED_COUNTER_CONFIG = 'meter_day_counter_cutover_v1';
interface Config { packed_from_day: string; legacy_seed_through_day: string }
interface DayData { schema: string; actor_id: string; day: string; daily?: number; actions: Record<string, number> }
interface DayRead { snap: DocumentSnapshot; data: DayData; daily: number; actions: Map<string, number>; checked: Set<string>; legacy?: Map<string, number> }
interface StrictCache extends Pick<RedisCache, 'getUserDailyPECountStrict' | 'getUserActionTypeCountStrict'> {}
function valid(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('novelty_counter_invalid'); return Number(value); }
function hash(key: string): string { return createHash('sha256').update(key).digest('hex'); }
/** A format cutover, never a price change. Old days retain their exact durable scalar counters. */
export class PackedDayCounters {
  private configRead: Promise<DocumentSnapshot> | undefined;
  private configRef: FirebaseFirestore.DocumentReference | undefined;
  private readonly days = new Map<string, Promise<DayRead>>();
  constructor(private readonly withBatch: boolean, private readonly types: readonly string[], private readonly conflict: () => Error) {}
  private async config(db: Firestore): Promise<Config | null> {
    this.configRef ??= db.collection(PACKED_COUNTER_CONFIG).doc('live');
    const snap = await (this.configRead ??= this.configRef.get());
    if (!snap.exists) return null;
    const config = snap.data() as Config;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(config.packed_from_day) || !/^\d{4}-\d{2}-\d{2}$/.test(config.legacy_seed_through_day)
      || config.packed_from_day > config.legacy_seed_through_day) throw new Error('packed_counter_cutover_invalid');
    return config;
  }
  private async day(db: Firestore, actor: string, day: string): Promise<DayRead> {
    const key = JSON.stringify([actor, day]); let pending = this.days.get(key);
    if (!pending) {
      pending = (async () => {
        const snap = await db.collection(PACKED_DAY_COUNTERS).doc(hash(key)).get();
        const data: DayData = snap.exists ? snap.data() as DayData : { schema: 'provian.meter-day-counts.v1', actor_id: actor, day, actions: {} };
        if (data.schema !== 'provian.meter-day-counts.v1' || data.actor_id !== actor || data.day !== day || !data.actions || Array.isArray(data.actions)) throw new Error('packed_counter_binding_invalid');
        if (data.daily !== undefined) valid(data.daily);
        for (const count of Object.values(data.actions)) valid(count);
        return { snap, data, daily: 0, actions: new Map<string, number>(), checked: new Set<string>() };
      })(); this.days.set(key, pending);
    }
    return pending;
  }
  private async legacy(db: Firestore, read: DayRead, type: string): Promise<Map<string, number>> {
    if (read.legacy?.has('checked:' + type)) return read.legacy;
    const collection = 'pvt_novelty_counters_v1', raw = rawPrivateFirestore(db), privateStore = isPrivateFirestore(db);
    if (privateStore) {
      const certificate = await raw.collection('private_retention_state_v1').doc('d554').get();
      if (certificate.get('opaque_ids_ready') !== true || certificate.get('opaque_records_complete') !== true) throw new Error('packed_counter_legacy_storage_uncertified');
    }
    const types = [...new Set([type, ...this.types])];
    const keys = [`pe_rate:daily:${read.data.actor_id}:${read.data.day}`, ...types.map(action => `pvt:occ:${read.data.actor_id}:${action}:${read.data.day}`)];
    const counts = read.legacy ?? new Map<string, number>();
    for (let start = 0; start < keys.length; start += 30) {
      const ids = keys.slice(start, start + 30).map(hash), physical = ids.map(id => privateStore ? privateStorageId(collection, id) : id);
      for (const doc of (await raw.collection(collection).where(FieldPath.documentId(), 'in', physical).get()).docs) {
        const decoded = privateStore ? decodePrivateRecord(collection, doc.id, doc.data(), db) : { id: doc.id, data: doc.data() };
        counts.set(decoded.id, valid(decoded.data.count));
      }
    }
    for (const action of types) counts.set('checked:' + action, 1);
    read.legacy = counts; return counts;
  }
  async counts(db: Firestore, cache: StrictCache, actor: string, type: string, timestamp: number): Promise<readonly [number, number] | null> {
    const config = await this.config(db), day = new Date(timestamp).toISOString().slice(0, 10);
    if (!config || day < config.packed_from_day) return null;
    if (['__proto__', 'constructor', 'prototype'].includes(type)) throw new Error('packed_counter_type_invalid');
    const read = await this.day(db, actor, day);
    for (const isDaily of [true, false]) {
      const mark = isDaily ? '$daily' : 'type:' + type;
      if (read.checked.has(mark)) continue;
      const seed = isDaily ? await cache.getUserDailyPECountStrict(actor, timestamp) : await cache.getUserActionTypeCountStrict(actor, type, timestamp);
      const current = isDaily ? read.data.daily : read.data.actions[type];
      if (current === undefined) {
        const old = day <= config.legacy_seed_through_day ? await this.legacy(db, read, type) : new Map<string, number>();
        const key = isDaily ? `pe_rate:daily:${actor}:${day}` : `pvt:occ:${actor}:${type}:${day}`;
        const initial = old.get(hash(key)) ?? valid(seed);
        if (this.withBatch) { if (isDaily) read.data.daily = initial; else read.data.actions[type] = initial; }
        else {
          // Before a recoverable non-batch seal increments Redis, persist its original seed once.
          await db.runTransaction(async txn => {
            const snap = await txn.get(read.snap.ref), data: DayData = snap.exists ? snap.data() as DayData : { schema: 'provian.meter-day-counts.v1', actor_id: actor, day, actions: {} };
            const value = isDaily ? data.daily : data.actions[type];
            if (value === undefined) { if (isDaily) data.daily = initial; else data.actions[type] = initial; txn.set(read.snap.ref, data); }
          });
          read.snap = await read.snap.ref.get(); read.data = read.snap.data() as DayData;
        }
      }
      read.checked.add(mark);
    }
    return [valid(read.data.daily) + read.daily, valid(read.data.actions[type]) + (read.actions.get(type) ?? 0)];
  }
  stage(actor: string, type: string, timestamp: number): boolean {
    const pending = this.days.get(JSON.stringify([actor, new Date(timestamp).toISOString().slice(0, 10)]));
    if (!pending) return false;
    // counts() resolved this promise before stageCounts; retain synchronous staging via the map below.
    const read = this.resolved.get(pending); if (!read) throw new Error('packed_counter_not_loaded');
    read.daily++; read.actions.set(type, (read.actions.get(type) ?? 0) + 1); return true;
  }
  private readonly resolved = new Map<Promise<DayRead>, DayRead>();
  async rememberResolved(): Promise<void> { for (const pending of this.days.values()) this.resolved.set(pending, await pending); }
  async inspect(txn: Transaction): Promise<void> {
    if (this.configRead) {
      const prior = await this.configRead, current = await txn.get(this.configRef!);
      if (prior.exists !== current.exists || prior.exists && !prior.updateTime!.isEqual(current.updateTime!)) throw this.conflict();
    }
    for (const pending of this.days.values()) {
      const read = await pending; if (!read.daily && !read.actions.size) continue;
      const current = await txn.get(read.snap.ref);
      if (current.exists !== read.snap.exists || current.exists && !current.updateTime!.isEqual(read.snap.updateTime!)) throw this.conflict();
    }
  }
  commit(txn: Transaction): void {
    for (const read of this.resolved.values()) {
      if (!read.daily && !read.actions.size) continue;
      const actions = { ...read.data.actions }; for (const [type, count] of read.actions) actions[type] = valid(actions[type]) + count;
      txn.set(read.snap.ref, { ...read.data, daily: valid(read.data.daily) + read.daily, actions });
    }
  }
}
