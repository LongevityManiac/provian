/**
 * THE WATCH REGISTRY: every address a chain watcher must ask the chain about.
 *
 * Before each scheduled watcher run re-read every source row (native address index,
 * registration indexes, admissions, proven addresses, every wallet document) to rebuild its
 * watched set, so a run cost Firestore reads in proportion to the number of wallets, several
 * times an hour, whether or not anything happened.
 *
 * The registry is the RAW address set, written IN THE SAME TRANSACTION as the source row that
 * makes an address watchable:
 * - `writeNativeWalletWatcherRegistration` (agent creation, human registration and
 * displacement, key rotation) records `native`;
 * - `writeProvenAddress` records `agent_proven`;
 * - `writeHumanProvenAddress` records `human_proven`.
 * So an address can never be watchable while absent from the registry: completeness is a
 * property of the commit, not of a clock, a journal or a later rebuild.
 *
 * It is a FILTER, never an authority. A watcher only uses it to decide which addresses to ask
 * the chain about; whatever the chain shows for an address is validated afresh, by the same code
 * the full enumeration ran, before anything is claimed or queued. So an entry never needs to be
 * removed: a rotated-away, test or deleted address only widens the log filter, and the registry
 * is ADD-ONLY (no rebuild ever rewrites a shard, and concurrent writers merge distinct map keys).
 *
 * Layout: `watch_registry_v1/s00..s15`, each `{ e: { "<kind>|<address>" created_at_ms } }`,
 * plus `watch_registry_v1/meta { seeded: true }` once the one-time seed has copied every
 * pre-existing source row in. The map fields are exempt from indexing (firestore.indexes.json),
 * so a shard is bounded only by the 1 MiB document limit, about 15,000 entries: 32 shards hold
 * about 480,000. The reconcile records the largest shard; `WATCH_REGISTRY_SHARD_WARN_ENTRIES`
 * is the alarm line.
 *
 * Marks (`watch_registry_marks_v1`) record, per watcher, the addresses that need no per-address
 * work this run (for the USDC watchers: the direction's admission is live; for chain-record: the
 * scan has asked about the address since its fence). Parked marks record, per UTC day, addresses
 * a USDC watcher's validation excluded, so they are re-validated once a day rather than on every
 * run. Late records (`watch_registry_late_v1`) are written only by the daily reconcile when it
 * finds a source row that is missing from the registry (a code path that bypassed the writers):
 * each watcher then rescans that address alone from its own fence.
 *
 * This module imports no source-collection module, so the writers can import it.
 */

import crypto from 'crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';

export const WATCH_REGISTRY_COLLECTION = 'watch_registry_v1';
export const WATCH_REGISTRY_MARKS_COLLECTION = 'watch_registry_marks_v1';
export const WATCH_REGISTRY_LATE_COLLECTION = 'watch_registry_late_v1';
export const WATCH_REGISTRY_META_DOC = 'meta';
export const WATCH_REGISTRY_SHARDS = 32;
const REGISTRY_SCHEMA = 'watch-registry/v1';
const MARKS_SCHEMA = 'watch-registry-marks/v1';
const LATE_SCHEMA = 'watch-registry-late/v1';

export type WatchRegistryKind = 'native' | 'agent_proven' | 'human_proven';
export const WATCH_REGISTRY_KINDS: readonly WatchRegistryKind[] = Object.freeze(['native', 'agent_proven', 'human_proven']);
export type WatchRegistryWatcher = 'inbound_usdc' | 'outbound_usdc' | 'chain_record';
export const WATCH_REGISTRY_WATCHERS: readonly WatchRegistryWatcher[] = Object.freeze(['inbound_usdc', 'outbound_usdc', 'chain_record']);

const ADDRESS = /^0x[0-9a-f]{40}$/;
/** A shard past this many entries is alarmed (the 1 MiB limit is about 15,000). */
export const WATCH_REGISTRY_SHARD_WARN_ENTRIES = 9_000;

function normalizeAddress(address: string): string {
  const lower = typeof address === 'string' ? address.toLowerCase() : '';
  if (!ADDRESS.test(lower)) throw new Error('watch_registry_address_invalid');
  return lower;
}

export function watchRegistryShardOf(address: string): number {
  const digest = crypto.createHash('sha256').update(normalizeAddress(address)).digest();
  return digest[0] % WATCH_REGISTRY_SHARDS;
}

function shardId(index: number): string {
  return `s${String(index).padStart(2, '0')}`;
}

function entryKey(kind: WatchRegistryKind, address: string): string {
  return `${kind}|${address}`;
}

function assertKind(kind: string): asserts kind is WatchRegistryKind {
  if (!(WATCH_REGISTRY_KINDS as readonly string[]).includes(kind)) throw new Error('watch_registry_kind_invalid');
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * Record one watchable address inside the caller's transaction. Write-only (never read in the
 * transaction), so it adds no read contention to the registration it rides on.
 */
export function recordWatchRegistryEntry(
  txn: Transaction,
  db: Firestore,
  kind: WatchRegistryKind,
  address: string,
  nowMs: number,
): void {
  assertKind(kind);
  const lower = normalizeAddress(address);
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('watch_registry_time_invalid');
  txn.set(
    db.collection(WATCH_REGISTRY_COLLECTION).doc(shardId(watchRegistryShardOf(lower))),
    { schema_version: REGISTRY_SCHEMA, e: { [entryKey(kind, lower)]: nowMs } },
    { merge: true },
  );
  // The entry's value is the latest registration or proof time: a park written before it no
  // longer holds (`readParkedToday`'s caller compares the two), so a writer adds nothing per day.
}

export interface WatchRegistrySnapshot {
  /** address -> kinds recorded for it. */
  readonly entries: ReadonlyMap<string, ReadonlySet<WatchRegistryKind>>;
  /** address -> the latest time any of its entries was recorded (a registration or proof). */
  readonly latestMs: ReadonlyMap<string, number>;
  readonly largestShardEntries: number;
}

/** Every registry address carrying one of `kinds` (all kinds when omitted), sorted. */
export function watchRegistryAddresses(
  snapshot: WatchRegistrySnapshot,
  kinds?: readonly WatchRegistryKind[],
): string[] {
  const out: string[] = [];
  for (const [address, recorded] of snapshot.entries) {
    if (!kinds || kinds.some((kind) => recorded.has(kind))) out.push(address);
  }
  return out.sort();
}

/**
 * Read the whole registry (33 documents: meta + 32 shards). Returns null until the one-time seed has completed,
 * so a caller can never mistake an unseeded registry for an empty watched set. A malformed
 * shard throws: the run stops before any cursor moves.
 */
export async function readWatchRegistry(db: Firestore): Promise<WatchRegistrySnapshot | null> {
  const collection = db.collection(WATCH_REGISTRY_COLLECTION);
  const refs = [collection.doc(WATCH_REGISTRY_META_DOC)];
  for (let i = 0; i < WATCH_REGISTRY_SHARDS; i += 1) refs.push(collection.doc(shardId(i)));
  const [meta, ...shards] = await db.getAll(...refs);
  if (!meta.exists) return null;
  const metaData = meta.data() as Record<string, unknown> | undefined;
  if (metaData?.schema_version !== REGISTRY_SCHEMA || metaData.seeded !== true) {
    throw new Error('watch_registry_meta_invalid');
  }
  const entries = new Map<string, Set<WatchRegistryKind>>();
  const latestMs = new Map<string, number>();
  let largestShardEntries = 0;
  shards.forEach((snap, index) => {
    if (!snap.exists) return;
    const data = snap.data() as Record<string, unknown> | undefined;
    if (data?.schema_version !== REGISTRY_SCHEMA || !isPlainMap(data.e)) {
      throw new Error(`watch_registry_shard_invalid:${shardId(index)}`);
    }
    const keys = Object.keys(data.e);
    largestShardEntries = Math.max(largestShardEntries, keys.length);
    for (const key of keys) {
      const value = data.e[key];
      const separator = key.indexOf('|');
      const kind = key.slice(0, separator);
      const address = key.slice(separator + 1);
      if (separator < 0 || !(WATCH_REGISTRY_KINDS as readonly string[]).includes(kind)
        || !ADDRESS.test(address) || watchRegistryShardOf(address) !== index
        || !Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new Error(`watch_registry_shard_invalid:${shardId(index)}`);
      }
      const recorded = entries.get(address) ?? new Set<WatchRegistryKind>();
      recorded.add(kind as WatchRegistryKind);
      entries.set(address, recorded);
      latestMs.set(address, Math.max(latestMs.get(address) ?? 0, value as number));
    }
  });
  return { entries, latestMs, largestShardEntries };
}

/** Merge many entries outside a transaction (seed and reconcile only), one write per shard. */
export async function addWatchRegistryEntries(
  db: Firestore,
  entries: ReadonlyArray<{ readonly kind: WatchRegistryKind; readonly address: string }>,
  nowMs: number,
): Promise<void> {
  const byShard = new Map<number, Record<string, number>>();
  for (const { kind, address } of entries) {
    assertKind(kind);
    const lower = normalizeAddress(address);
    const shard = watchRegistryShardOf(lower);
    const map = byShard.get(shard) ?? {};
    map[entryKey(kind, lower)] = nowMs;
    byShard.set(shard, map);
  }
  for (const [shard, e] of byShard) {
    await db.collection(WATCH_REGISTRY_COLLECTION).doc(shardId(shard))
      .set({ schema_version: REGISTRY_SCHEMA, e }, { merge: true });
  }
}

/** Mark the registry seeded. Only after every pre-existing source row has been merged in. */
export async function markWatchRegistrySeeded(db: Firestore, nowMs: number): Promise<void> {
  await db.collection(WATCH_REGISTRY_COLLECTION).doc(WATCH_REGISTRY_META_DOC)
    .set({ schema_version: REGISTRY_SCHEMA, seeded: true, seeded_at_ms: nowMs });
}

// =============================================================================
// MARKS
// =============================================================================

function marksDocId(watcher: WatchRegistryWatcher, shard: number): string {
  return `${watcher}_${shardId(shard)}`;
}

function assertWatcher(watcher: string): asserts watcher is WatchRegistryWatcher {
  if (!(WATCH_REGISTRY_WATCHERS as readonly string[]).includes(watcher)) throw new Error('watch_registry_watcher_invalid');
}

/**
 * The addresses `watcher` has marked. Returns null until that watcher's marks were seeded. A
 * mark whose value is 0 is a removal (the rebind case) and is not returned.
 */
export async function readWatchMarks(
  db: Firestore,
  watcher: WatchRegistryWatcher,
): Promise<Set<string> | null> {
  assertWatcher(watcher);
  const collection = db.collection(WATCH_REGISTRY_MARKS_COLLECTION);
  const refs = [collection.doc(`${watcher}_meta`)];
  for (let i = 0; i < WATCH_REGISTRY_SHARDS; i += 1) refs.push(collection.doc(marksDocId(watcher, i)));
  const [meta, ...shards] = await db.getAll(...refs);
  if (!meta.exists) return null;
  const metaData = meta.data() as Record<string, unknown> | undefined;
  if (metaData?.schema_version !== MARKS_SCHEMA || metaData.seeded !== true) {
    throw new Error(`watch_registry_marks_meta_invalid:${watcher}`);
  }
  const out = new Set<string>();
  shards.forEach((snap, index) => {
    if (!snap.exists) return;
    const data = snap.data() as Record<string, unknown> | undefined;
    if (data?.schema_version !== MARKS_SCHEMA || !isPlainMap(data.m)) {
      throw new Error(`watch_registry_marks_invalid:${marksDocId(watcher, index)}`);
    }
    for (const [address, value] of Object.entries(data.m)) {
      if (!ADDRESS.test(address) || watchRegistryShardOf(address) !== index
        || !Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`watch_registry_marks_invalid:${marksDocId(watcher, index)}`);
      }
      if ((value as number) > 0) out.add(address);
    }
  });
  return out;
}

export async function writeWatchMarks(
  db: Firestore,
  watcher: WatchRegistryWatcher,
  addresses: Iterable<string>,
  nowMs: number,
): Promise<void> {
  assertWatcher(watcher);
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('watch_registry_time_invalid');
  const byShard = new Map<number, Record<string, number>>();
  for (const address of addresses) {
    const lower = normalizeAddress(address);
    const shard = watchRegistryShardOf(lower);
    const map = byShard.get(shard) ?? {};
    map[lower] = nowMs;
    byShard.set(shard, map);
  }
  for (const [shard, m] of byShard) {
    await db.collection(WATCH_REGISTRY_MARKS_COLLECTION).doc(marksDocId(watcher, shard))
      .set({ schema_version: MARKS_SCHEMA, m }, { merge: true });
  }
}

/**
 * The highest membership generation of any admission this watcher has marked live. A live
 * admission's generation never exceeds the global checkpoint's (the commit that makes an address
 * live raises the checkpoint's generation with it), so a checkpoint below this high water was
 * rolled back or replaced — the integrity fault the pre- run caught by re-checking every
 * live admission each run (`future_membership_generation`). The run asserts it instead.
 */
export async function readWatchMarksGenerationHighWater(
  db: Firestore,
  watcher: WatchRegistryWatcher,
): Promise<number> {
  assertWatcher(watcher);
  const snap = await db.collection(WATCH_REGISTRY_MARKS_COLLECTION).doc(`${watcher}_meta`).get();
  const raw = snap.exists ? snap.data() as Record<string, unknown> | undefined : undefined;
  if (!raw || raw.generation_high_water === undefined) return 0;
  if (!Number.isSafeInteger(raw.generation_high_water) || (raw.generation_high_water as number) < 0) {
    throw new Error(`watch_registry_marks_meta_invalid:${watcher}`);
  }
  return raw.generation_high_water as number;
}

/** Raise the high water to `generation` (never lowers it). */
export async function raiseWatchMarksGenerationHighWater(
  db: Firestore,
  watcher: WatchRegistryWatcher,
  generation: number,
): Promise<void> {
  assertWatcher(watcher);
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('watch_registry_generation_invalid');
  const ref = db.collection(WATCH_REGISTRY_MARKS_COLLECTION).doc(`${watcher}_meta`);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const raw = snap.exists ? snap.data() as Record<string, unknown> | undefined : undefined;
    const prior = raw && Number.isSafeInteger(raw.generation_high_water) ? raw.generation_high_water as number : 0;
    if (generation > prior) txn.set(ref, { generation_high_water: generation }, { merge: true });
  });
}

/** Remove one mark inside the caller's transaction (a native rebind that leaves the admission backfilling). */
export function removeWatchMarkInTransaction(
  txn: Transaction,
  db: Firestore,
  watcher: WatchRegistryWatcher,
  address: string,
): void {
  assertWatcher(watcher);
  const lower = normalizeAddress(address);
  txn.set(
    db.collection(WATCH_REGISTRY_MARKS_COLLECTION).doc(marksDocId(watcher, watchRegistryShardOf(lower))),
    { schema_version: MARKS_SCHEMA, m: { [lower]: 0 } },
    { merge: true },
  );
}

/** Seed a watcher's marks: write them, then the meta that makes them authoritative. */
export async function seedWatchMarks(
  db: Firestore,
  watcher: WatchRegistryWatcher,
  addresses: Iterable<string>,
  nowMs: number,
): Promise<void> {
  await writeWatchMarks(db, watcher, addresses, nowMs);
  await db.collection(WATCH_REGISTRY_MARKS_COLLECTION).doc(`${watcher}_meta`)
    // Merged: the generation high water (raised before the seed) lives in this doc too.
    .set({ schema_version: MARKS_SCHEMA, seeded: true, seeded_at_ms: nowMs }, { merge: true });
}

// =============================================================================
// PARKED (per UTC day)
// =============================================================================

export function utcDayOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
}

function parkedDocId(watcher: WatchRegistryWatcher, nowMs: number): string {
  return `${watcher}_parked_${utcDayOf(nowMs)}`;
}

/**
 * Addresses `watcher` parked today, with the time each was parked. A malformed doc throws. A park
 * holds only while no registration or proof of the address is newer (the caller compares it with
 * the registry entry's time), and 0 is an un-park (a log that resolved the address valid).
 */
export async function readParkedToday(
  db: Firestore,
  watcher: WatchRegistryWatcher,
  nowMs: number,
): Promise<Map<string, number>> {
  assertWatcher(watcher);
  const snap = await db.collection(WATCH_REGISTRY_MARKS_COLLECTION).doc(parkedDocId(watcher, nowMs)).get();
  if (!snap.exists) return new Map();
  const data = snap.data() as Record<string, unknown> | undefined;
  if (data?.schema_version !== MARKS_SCHEMA || !isPlainMap(data.p)) {
    throw new Error(`watch_registry_parked_invalid:${watcher}`);
  }
  const out = new Map<string, number>();
  for (const [address, value] of Object.entries(data.p)) {
    if (!ADDRESS.test(address) || !Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`watch_registry_parked_invalid:${watcher}`);
    }
    if ((value as number) > 0) out.set(address, value as number);
  }
  return out;
}

/** Un-park addresses for the rest of today (a parked address whose log resolved valid). */
export async function unparkAddresses(
  db: Firestore,
  watcher: WatchRegistryWatcher,
  addresses: Iterable<string>,
  nowMs: number,
): Promise<void> {
  assertWatcher(watcher);
  const p: Record<string, number> = {};
  for (const address of addresses) p[normalizeAddress(address)] = 0;
  if (Object.keys(p).length === 0) return;
  await db.collection(WATCH_REGISTRY_MARKS_COLLECTION).doc(parkedDocId(watcher, nowMs))
    .set({ schema_version: MARKS_SCHEMA, p }, { merge: true });
}

/** Remove marks outside a transaction (a marked address whose admission is no longer live). */
export async function unmarkAddresses(
  db: Firestore,
  watcher: WatchRegistryWatcher,
  addresses: Iterable<string>,
): Promise<void> {
  assertWatcher(watcher);
  const byShard = new Map<number, Record<string, number>>();
  for (const address of addresses) {
    const lower = normalizeAddress(address);
    const shard = watchRegistryShardOf(lower);
    const map = byShard.get(shard) ?? {};
    map[lower] = 0;
    byShard.set(shard, map);
  }
  for (const [shard, m] of byShard) {
    await db.collection(WATCH_REGISTRY_MARKS_COLLECTION).doc(marksDocId(watcher, shard))
      .set({ schema_version: MARKS_SCHEMA, m }, { merge: true });
  }
}

/** Most addresses one day's parked document holds; beyond it an address is re-validated each run. */
export const WATCH_REGISTRY_PARKED_CAP = 10_000;

export async function parkAddresses(
  db: Firestore,
  watcher: WatchRegistryWatcher,
  addresses: Iterable<string>,
  alreadyParked: number,
  nowMs: number,
): Promise<void> {
  assertWatcher(watcher);
  const p: Record<string, number> = {};
  let count = alreadyParked;
  for (const address of addresses) {
    if (count >= WATCH_REGISTRY_PARKED_CAP) break;
    p[normalizeAddress(address)] = nowMs;
    count += 1;
  }
  if (Object.keys(p).length === 0) return;
  await db.collection(WATCH_REGISTRY_MARKS_COLLECTION).doc(parkedDocId(watcher, nowMs))
    .set({ schema_version: MARKS_SCHEMA, p }, { merge: true });
}

// =============================================================================
// LATE RECORDS (written by the daily reconcile only)
// =============================================================================

export interface WatchRegistryLateRecord {
  readonly address: string;
  readonly kinds: readonly WatchRegistryKind[];
  readonly found_at_ms: number;
  /** Per watcher, the next block its rescan resumes at (absent = from the address's fence). */
  readonly progress: Partial<Record<WatchRegistryWatcher, number>>;
}

function parseLate(id: string, raw: Record<string, unknown> | undefined): WatchRegistryLateRecord {
  if (!raw || raw.schema_version !== LATE_SCHEMA || raw.address !== id || !ADDRESS.test(id)
    || !Array.isArray(raw.kinds) || raw.kinds.length === 0
    || !raw.kinds.every((k) => (WATCH_REGISTRY_KINDS as readonly unknown[]).includes(k))
    || !Number.isSafeInteger(raw.found_at_ms) || !isPlainMap(raw.pending)
    || !(raw.progress === undefined || isPlainMap(raw.progress))) {
    throw new Error(`watch_registry_late_invalid:${id}`);
  }
  const progress: Partial<Record<WatchRegistryWatcher, number>> = {};
  for (const [watcher, value] of Object.entries((raw.progress as Record<string, unknown> | undefined) ?? {})) {
    if (!(WATCH_REGISTRY_WATCHERS as readonly string[]).includes(watcher)
      || !Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`watch_registry_late_invalid:${id}`);
    }
    progress[watcher as WatchRegistryWatcher] = value as number;
  }
  return { address: id, kinds: raw.kinds as WatchRegistryKind[], found_at_ms: raw.found_at_ms as number, progress };
}

/** Late records still pending for `watcher`. A malformed record throws (never a dropped repair). */
export async function readPendingLateRecords(
  db: Firestore,
  watcher: WatchRegistryWatcher,
): Promise<Map<string, WatchRegistryLateRecord>> {
  assertWatcher(watcher);
  const snap = await db.collection(WATCH_REGISTRY_LATE_COLLECTION).where(`pending.${watcher}`, '==', true).get();
  const out = new Map<string, WatchRegistryLateRecord>();
  for (const doc of snap.docs) out.set(doc.id, parseLate(doc.id, doc.data() as Record<string, unknown>));
  return out;
}

export async function createLateRecord(
  db: Firestore,
  address: string,
  kinds: readonly WatchRegistryKind[],
  nowMs: number,
): Promise<void> {
  const lower = normalizeAddress(address);
  kinds.forEach(assertKind);
  const pending: Record<string, boolean> = {};
  for (const watcher of WATCH_REGISTRY_WATCHERS) pending[watcher] = true;
  await db.collection(WATCH_REGISTRY_LATE_COLLECTION).doc(lower).set({
    schema_version: LATE_SCHEMA, address: lower, kinds: [...kinds], found_at_ms: nowMs, pending,
  }, { merge: true });
}

/** Persist a late rescan's resume point, so a long range survives the per-run call budget. */
export async function advanceLateRecord(
  db: Firestore,
  watcher: WatchRegistryWatcher,
  address: string,
  nextBlock: number,
): Promise<void> {
  assertWatcher(watcher);
  if (!Number.isSafeInteger(nextBlock) || nextBlock < 0) throw new Error('watch_registry_late_progress_invalid');
  await db.collection(WATCH_REGISTRY_LATE_COLLECTION).doc(normalizeAddress(address))
    .set({ progress: { [watcher]: nextBlock } }, { merge: true });
}

export async function clearLateRecord(
  db: Firestore,
  watcher: WatchRegistryWatcher,
  address: string,
): Promise<void> {
  assertWatcher(watcher);
  await db.collection(WATCH_REGISTRY_LATE_COLLECTION).doc(normalizeAddress(address))
    .set({ pending: { [watcher]: false } }, { merge: true });
}
