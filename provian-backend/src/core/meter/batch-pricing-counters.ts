import { PackedDayCounters } from './packed-day-counters';
import { FieldPath, Firestore as NativeFirestore } from 'firebase-admin/firestore';
import { rawPrivateFirestore, isPrivateFirestore, privateStorageId, decodePrivateRecord } from '../provenance/private-store';
import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import type { DurableAccrualPayload } from '../pvt/durable-accrual-effects';
import type { MeterActOutcome } from './meter-seal';

/** One durable scalar per existing logical counter key; no PE or private input is retained. */
export const NOVELTY_COUNTERS_COLLECTION = 'pvt_novelty_counters_v1';
/** Operational cutover only: reject without sealing or initializing a carried counter. */
export class NoveltySealsPausedError extends Error {
  constructor() { super('novelty_seals_paused'); }
}
export function assertNoveltySealsOpen(): void {
  if (process.env.PVT_NOVELTY_SEALS_PAUSED === 'true') throw new NoveltySealsPausedError();
}
export class NoveltyCounterConflictError extends Error {
  constructor() { super('novelty_counter_changed'); }
}

/** Re-price after an optimistic conflict. No allocation survives a failed seal. */
export async function retryNoveltyConflict<T>(work: () => Promise<T>): Promise<T> {
  for (;;) {
    try { return await work(); }
    catch (error) { if (!(error instanceof NoveltyCounterConflictError)) throw error; }
  }
}

interface CounterRead {
  readonly ref: FirebaseFirestore.DocumentReference;
  readonly exists: boolean;
  readonly count: number;
  staged: number;
}
function validCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('novelty_counter_invalid');
  return Number(value);
}

/** Pricing reads a version; the transaction that seals the acts checks and advances it. */
export class BatchPricingCounters {
  private readonly packed: PackedDayCounters;
  constructor(private readonly commitWithBatch = false, private readonly batchActionTypes: readonly string[] = []) { this.packed = new PackedDayCounters(commitWithBatch, batchActionTypes, () => new NoveltyCounterConflictError()); }
  private readonly hooks: { inspect(txn: FirebaseFirestore.Transaction): Promise<void>; commit(txn: FirebaseFirestore.Transaction): void }[] = [];
  private readonly stagedValues = new Map<string, unknown>();
  stagedValue<T>(key: string): T | undefined { return this.stagedValues.get(key) as T | undefined; }
  stageValue(key: string, value: unknown): void { this.stagedValues.set(key, value); }
  addHook(hook: { inspect(txn: FirebaseFirestore.Transaction): Promise<void>; commit(txn: FirebaseFirestore.Transaction): void }): void {
    this.hooks.push(hook);
  }
  private certificate: FirebaseFirestore.DocumentSnapshot | null | undefined;
  private readonly sparseValues = new Map<string, { exists: boolean; count: number }>();
  private readonly sparseGroups: { query: FirebaseFirestore.Query; expected: Map<string, number>; privateStore: boolean; raw: FirebaseFirestore.Firestore }[] = [];
  private readonly sparseKeys = new Set<string>();
  private readonly primes = new Map<string, Promise<void>>();
  private async prime(db: Firestore, user: string, type: string, timestamp: number): Promise<void> {
    if (!this.commitWithBatch) return;
    const raw = rawPrivateFirestore(db);
    if (!(raw instanceof NativeFirestore)) return;
    const key = `${user}\0${new Date(timestamp).toISOString().slice(0, 10)}\0${this.batchActionTypes.includes(type) ? '' : type}`;
    let pending = this.primes.get(key);
    if (!pending) {
      pending = (async () => {
        const privateStore = isPrivateFirestore(db);
        if (this.certificate === undefined) this.certificate = privateStore ? await raw.collection('private_retention_state_v1').doc('d554').get() : null;
        if (privateStore && (this.certificate?.get('opaque_ids_ready') !== true || this.certificate?.get('opaque_records_complete') !== true)) return;
        const keys = [...new Set([type, ...this.batchActionTypes].flatMap(action => this.keys(user, action, timestamp)))];
        for (let i = 0; i < keys.length; i += 30) {
          const selected = keys.slice(i, i + 30), ids = selected.map(value => createHash('sha256').update(value).digest('hex'));
          const physical = ids.map(id => privateStore ? privateStorageId(NOVELTY_COUNTERS_COLLECTION, id) : id);
          const query = raw.collection(NOVELTY_COUNTERS_COLLECTION).where(FieldPath.documentId(), 'in', physical);
          const expected = new Map<string, number>();
          for (const doc of (await query.get()).docs) {
            const data = privateStore ? decodePrivateRecord(NOVELTY_COUNTERS_COLLECTION, doc.id, doc.data(), db).data : doc.data();
            expected.set(doc.id, validCount(data.count));
          }
          selected.forEach((value, index) => this.sparseValues.set(value, { exists: expected.has(physical[index]), count: expected.get(physical[index]) ?? 0 }));
          this.sparseGroups.push({ query, expected, privateStore, raw });
        }
      })();
      this.primes.set(key, pending);
    }
    await pending;
  }
  private readonly reads = new Map<string, CounterRead>();
  private readonly daily = new Map<string, number>();
  private readonly occurrences = new Map<string, number>();

  private keys(userId: string, actionType: string, timestampMs: number): readonly [string, string] {
    const day = new Date(timestampMs).toISOString().slice(0, 10);
    return [`pe_rate:daily:${userId}:${day}`, `pvt:occ:${userId}:${actionType}:${day}`];
  }

  async counts(db: Firestore, cache: Pick<RedisCache, 'getUserDailyPECountStrict' | 'getUserActionTypeCountStrict'>,
    userId: string, actionType: string, timestampMs: number): Promise<readonly [number, number]> {
    assertNoveltySealsOpen();
    // Preserve the existing outage fence. Redis seeds an unseen window once; after that it is
    // only a display mirror. Expiry, eviction or a failed post-commit write cannot reset prices.
    const packed = await this.packed.counts(db, cache, userId, actionType, timestampMs);
    if (packed) { await this.packed.rememberResolved(); return packed; }
    await this.prime(db, userId, actionType, timestampMs);
    const keys = this.keys(userId, actionType, timestampMs);
    const counts = await Promise.all(keys.map(async (key, i) => {
      let read = this.reads.get(key);
      if (!read) {
        const seed = i === 0 ? await cache.getUserDailyPECountStrict(userId, timestampMs)
          : await cache.getUserActionTypeCountStrict(userId, actionType, timestampMs);
        const ref = db.collection(NOVELTY_COUNTERS_COLLECTION).doc(createHash('sha256').update(key).digest('hex'));
        if (this.commitWithBatch) {
          const sparse = this.sparseValues.get(key);
          const snap = sparse ? null : await ref.get();
          const exists = sparse ? sparse.exists : snap!.exists;
          read = { ref, exists, count: exists ? sparse?.count ?? validCount(snap!.data()?.count) : validCount(seed), staged: 0 };
          if (sparse) this.sparseKeys.add(key);
          this.reads.set(key, read);
          return read.count;
        }
        // Initialize the carried legacy count once, without consuming a new occurrence. A
        // recovery's Redis-success/seal-failure retry must not seed from its own mirror increment.
        const count = await db.runTransaction(async txn => {
          const snap = await txn.get(ref);
          if (snap.exists) return validCount(snap.data()?.count);
          const initial = validCount(seed);
          txn.set(ref, { count: initial });
          return initial;
        });
        read = { ref, exists: true, count, staged: 0 };
        this.reads.set(key, read);
      }
      return read.count + read.staged;
    }));
    return [counts[0], counts[1]];
  }

  async inspect(txn: FirebaseFirestore.Transaction): Promise<void> {
    for (const hook of this.hooks) await hook.inspect(txn);
    await this.packed.inspect(txn);
    if (this.certificate) {
      const raw = this.sparseGroups[0]?.raw;
      if (raw) {
        const current = await txn.get(raw.collection('private_retention_state_v1').doc('d554'));
        if (!current.exists || !current.updateTime!.isEqual(this.certificate.updateTime!)) throw new NoveltyCounterConflictError();
      }
    }
    for (const group of this.sparseGroups) {
      const current = new Map<string, number>();
      for (const doc of (await txn.get(group.query)).docs) {
        const data = group.privateStore ? decodePrivateRecord(NOVELTY_COUNTERS_COLLECTION, doc.id, doc.data(), group.raw).data : doc.data();
        current.set(doc.id, validCount(data.count));
      }
      if (current.size !== group.expected.size || [...current].some(([id, count]) => group.expected.get(id) !== count)) throw new NoveltyCounterConflictError();
    }
    for (const [key, read] of this.reads) {
      if (read.staged === 0 || this.sparseKeys.has(key)) continue;
      const current = await txn.get(read.ref);
      if (current.exists !== read.exists || current.exists && validCount(current.data()?.count) !== read.count) {
        throw new NoveltyCounterConflictError();
      }
    }
  }

  commit(txn: FirebaseFirestore.Transaction): void {
    for (const hook of this.hooks) hook.commit(txn);
    this.packed.commit(txn);
    for (const [key, read] of this.reads) {
      if (read.staged === 0) continue;
      const value = { count: validCount(read.count + read.staged) };
      if (this.sparseKeys.has(key) && !read.exists) txn.create(read.ref, value); else txn.set(read.ref, value);
    }
  }

  stageCounts(userId: string, actionType: string, timestampMs: number): void {
    if (this.packed.stage(userId, actionType, timestampMs)) return;
    for (const key of this.keys(userId, actionType, timestampMs)) {
      const read = this.reads.get(key);
      if (read) read.staged++;
    }
  }

  stageEffect(effect: DurableAccrualPayload): void {
    if (effect.redisCountersRequired === true) this.stageCounts(effect.userId, effect.actionType, effect.timestampMs);
  }

  offsets(userId: string, actionType: string, timestampMs: number): readonly [number, number] {
    const day = new Date(timestampMs).toISOString().slice(0, 10);
    return [this.daily.get(JSON.stringify([userId, day])) ?? 0,
      this.occurrences.get(JSON.stringify([userId, actionType, day])) ?? 0];
  }

  stage(outcome: MeterActOutcome): void {
    // Exactly the population commitMeterBatchCounters advances. Refused, replayed and
    // policy-record-only/cache-unavailable acts must not shift a later act's ordinal.
    const effect: DurableAccrualPayload | null | undefined = outcome.key?.side.effect;
    if (outcome.replay || effect?.redisCountersRequired !== true) return;
    this.stageEffect(effect);
    const day = new Date(effect.timestampMs).toISOString().slice(0, 10);
    for (const [map, key] of [
      [this.daily, JSON.stringify([effect.userId, day])],
      [this.occurrences, JSON.stringify([effect.userId, effect.actionType, day])],
    ] as const) map.set(key, (map.get(key) ?? 0) + 1);
  }
}

export function isNoveltyCounterCreateCollision(error: unknown): boolean {
  const e = error as { code?: unknown; details?: unknown; message?: unknown };
  return e?.code === 6 && (String(e.details ?? '') + String(e.message ?? '')).includes(NOVELTY_COUNTERS_COLLECTION + '/');
}
