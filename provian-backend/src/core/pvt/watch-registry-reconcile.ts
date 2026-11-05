/**
 * seeding the watch registry once, and the daily reconcile that proves it complete.
 *
 * SEED. The first run of a registry-reading watcher over a database the registry has never
 * seen copies every pre-existing source row's address in (raw: no validation, so nothing a later
 * repair could make watchable is left out), then writes `meta.seeded`. A registration that
 * commits while the seed runs writes its own entry in its own transaction, so the order does not
 * matter, and two concurrent seeds merge the same keys.
 *
 * RECONCILE. Once a day (resumable, a bounded page per call, run from the chain-record job) the
 * three source collections are paged and every address is checked against the registry. An
 * address missing from it means some code path created a watchable row without going through
 * the writers — a defect, alarmed loudly — and it is repaired, not just reported: the entry is
 * added and a late record makes each watcher rescan that address alone from its own fence, so a
 * payment it received in the meantime is still found. Rows that do not parse are handed to the
 * caller (chain-record sets them aside for the data-health view, as its full listing used to).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { FieldPath } from 'firebase-admin/firestore';
import {
  HUMAN_PROVEN_ADDRESSES_COLLECTION,
  PROVEN_ADDRESSES_COLLECTION,
} from '../external-address/link';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION } from './native-wallet-registration';
import {
  WATCH_REGISTRY_COLLECTION,
  addWatchRegistryEntries,
  createLateRecord,
  markWatchRegistrySeeded,
  readWatchRegistry,
  watchRegistryShardOf,
  WATCH_REGISTRY_SHARD_WARN_ENTRIES,
  type WatchRegistryKind,
  type WatchRegistrySnapshot,
} from './watch-registry';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const RECONCILE_DOC = 'reconcile';
const RECONCILE_SCHEMA = 'watch-registry-reconcile/v1';
export const WATCH_REGISTRY_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECONCILE_PAGE = 2_000;

interface SourcePhase {
  readonly collection: string;
  readonly kind: WatchRegistryKind;
  /** The address a source document names, or null when it names none that can be watched. */
  readonly addressOf: (id: string, data: Record<string, unknown> | undefined) => string | null;
}

/** Native index docs are keyed by a hash, so their address is a field; proven docs are keyed by it. */
const PHASES: readonly SourcePhase[] = Object.freeze([
  {
    collection: NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
    kind: 'native',
    addressOf: (_id, data) => {
      const raw = typeof data?.address === 'string' ? data.address.toLowerCase() : '';
      return ADDRESS.test(raw) ? raw : null;
    },
  },
  {
    collection: PROVEN_ADDRESSES_COLLECTION,
    kind: 'agent_proven',
    addressOf: (id) => (ADDRESS.test(id) ? id : null),
  },
  {
    collection: HUMAN_PROVEN_ADDRESSES_COLLECTION,
    kind: 'human_proven',
    addressOf: (id) => (ADDRESS.test(id) ? id : null),
  },
]);

/** The registry, seeding it first if this database has never had one. */
export async function ensureWatchRegistrySeeded(
  db: Firestore,
  nowMs: number,
): Promise<WatchRegistrySnapshot> {
  const existing = await readWatchRegistry(db);
  if (existing) return existing;
  const entries: Array<{ kind: WatchRegistryKind; address: string }> = [];
  for (const phase of PHASES) {
    const snap = await db.collection(phase.collection).get();
    for (const doc of snap.docs) {
      const address = phase.addressOf(doc.id, doc.data() as Record<string, unknown> | undefined);
      if (address) entries.push({ kind: phase.kind, address });
    }
  }
  await addWatchRegistryEntries(db, entries, nowMs);
  await markWatchRegistrySeeded(db, nowMs);
  console.log(`[watch-registry] seeded with ${entries.length} source rows`);
  const seeded = await readWatchRegistry(db);
  if (!seeded) throw new Error('watch_registry_seed_not_visible');
  return seeded;
}

export interface WatchRegistryReconcileReport {
  /** The daily full pass took a slice this call. */
  readonly ran: boolean;
  readonly completed: boolean;
  /** The post-deploy check of recently created rows ran this call. */
  readonly eager: boolean;
  readonly docs_read: number;
  readonly missing_found: number;
  readonly malformed: number;
}

interface ReconcileState {
  next_due_ms: number;
  phase: number;
  after: string | null;
  missing_found: number;
  revision: string | null;
  revision_seen_at_ms: number;
}

const EMPTY_STATE: ReconcileState = {
  next_due_ms: 0, phase: 0, after: null, missing_found: 0, revision: null, revision_seen_at_ms: 0,
};

/**
 * After a new code revision first runs, older instances may still be draining requests for up to
 * the request timeout (an hour), and a rollback runs code with no registry writer at all. For this
 * long after a revision change every call also checks the rows CREATED recently, so such a row
 * is in the registry within one run instead of at the next daily pass.
 */
export const WATCH_REGISTRY_EAGER_WINDOW_MS = 2 * 60 * 60 * 1000;
/** How far before the revision change the eager check looks (the drain plus the registration's own clock skew). */
const EAGER_LOOKBACK_MS = 2 * 60 * 60 * 1000;
/** Per source collection, the row's creation-time field (server clock). */
const CREATED_AT_FIELD: Readonly<Record<string, string>> = Object.freeze({
  [NATIVE_WALLET_ADDRESS_INDEX_COLLECTION]: 'created_at_ms',
  [PROVEN_ADDRESSES_COLLECTION]: 'proven_at_ms',
  [HUMAN_PROVEN_ADDRESSES_COLLECTION]: 'proven_at_ms',
});

function parseState(raw: Record<string, unknown> | undefined): ReconcileState {
  if (!raw) return { ...EMPTY_STATE };
  if (raw.schema_version !== RECONCILE_SCHEMA || !Number.isSafeInteger(raw.next_due_ms)
    || !Number.isSafeInteger(raw.phase) || (raw.phase as number) < 0 || (raw.phase as number) > PHASES.length
    || !(raw.after === null || typeof raw.after === 'string') || !Number.isSafeInteger(raw.missing_found)
    || !(raw.revision === undefined || raw.revision === null || typeof raw.revision === 'string')
    || !(raw.revision_seen_at_ms === undefined || Number.isSafeInteger(raw.revision_seen_at_ms))) {
    // The reconcile's own position: a malformed one restarts the pass (it only ever adds).
    console.error('[watch-registry] reconcile state invalid; restarting the pass');
    return { ...EMPTY_STATE };
  }
  return {
    next_due_ms: raw.next_due_ms as number,
    phase: raw.phase as number,
    after: raw.after as string | null,
    missing_found: raw.missing_found as number,
    revision: (raw.revision as string | null | undefined) ?? null,
    revision_seen_at_ms: (raw.revision_seen_at_ms as number | undefined) ?? 0,
  };
}

/**
 * Check one page of source rows against the registry; add (and late-record) any missing.
 * Returns the number found missing. A suspect is re-read fresh before it counts: a registration
 * that committed after the registry snapshot was taken wrote its own entry.
 */
async function reconcileRows(
  db: Firestore,
  registry: WatchRegistrySnapshot,
  source: SourcePhase,
  docs: ReadonlyArray<{ readonly id: string; data(): unknown }>,
  nowMs: number,
  onMalformed: ((row: { collection: string; id: string }) => Promise<void>) | undefined,
): Promise<{ missing: number; malformed: number }> {
  let missing = 0;
  let malformed = 0;
  const suspects: Array<{ kind: WatchRegistryKind; address: string }> = [];
  for (const doc of docs) {
    const address = source.addressOf(doc.id, doc.data() as Record<string, unknown> | undefined);
    if (address === null) {
      malformed += 1;
      if (onMalformed) await onMalformed({ collection: source.collection, id: doc.id });
      continue;
    }
    if (!registry.entries.get(address)?.has(source.kind)) suspects.push({ kind: source.kind, address });
  }
  for (const suspect of suspects) {
    const shard = await db.collection(WATCH_REGISTRY_COLLECTION)
      .doc(`s${String(watchRegistryShardOf(suspect.address)).padStart(2, '0')}`).get();
    const e = (shard.data() as { e?: Record<string, unknown> } | undefined)?.e;
    if (e && Number.isSafeInteger(e[`${suspect.kind}|${suspect.address}`])) continue;
    missing += 1;
    console.error('[watch-registry] watch_registry_entry_missing: a source row bypassed the registry writers; '
      + 'added, and every watcher rescans it from its fence', { collection: source.collection, ...suspect });
    await addWatchRegistryEntries(db, [suspect], nowMs);
    await createLateRecord(db, suspect.address, [suspect.kind], nowMs);
  }
  return { missing, malformed };
}

/**
 * One bounded slice of the daily reconcile (a no-op until due; resumes where the last slice
 * stopped), plus, within the eager window after a revision change, the recent-rows check.
 * `onMalformed` receives every source row that names no watchable address.
 */
export async function runWatchRegistryReconcile(
  db: Firestore,
  nowMs: number,
  options: {
    readonly maxDocs?: number;
    readonly revision?: string;
    readonly onMalformed?: (row: { collection: string; id: string }) => Promise<void>;
  } = {},
): Promise<WatchRegistryReconcileReport> {
  const stateRef = db.collection(WATCH_REGISTRY_COLLECTION).doc(RECONCILE_DOC);
  const stateSnap = await stateRef.get();
  const state = parseState(stateSnap.exists ? stateSnap.data() as Record<string, unknown> : undefined);
  const revision = options.revision ?? process.env.K_REVISION ?? 'unknown';
  const revisionSeenAt = state.revision === revision ? state.revision_seen_at_ms : nowMs;
  const eager = nowMs < revisionSeenAt + WATCH_REGISTRY_EAGER_WINDOW_MS;
  const due = !(state.phase === 0 && state.after === null && nowMs < state.next_due_ms);
  if (!eager && !due) {
    return { ran: false, completed: false, eager: false, docs_read: 0, missing_found: 0, malformed: 0 };
  }
  const registry = await ensureWatchRegistrySeeded(db, nowMs);
  let docsRead = 0;
  let missingFound = 0;
  let malformed = 0;

  if (eager) {
    for (const source of PHASES) {
      const snap = await db.collection(source.collection)
        .where(CREATED_AT_FIELD[source.collection], '>=', revisionSeenAt - EAGER_LOOKBACK_MS).get();
      docsRead += snap.docs.length;
      const found = await reconcileRows(db, registry, source, snap.docs, nowMs, undefined);
      missingFound += found.missing;
    }
  }

  let { phase, after } = state;
  if (due) {
    let budget = Math.max(1, options.maxDocs ?? DEFAULT_RECONCILE_PAGE);
    while (phase < PHASES.length && budget > 0) {
      const source = PHASES[phase];
      const limit = Math.min(budget, 500);
      let query = db.collection(source.collection).orderBy(FieldPath.documentId()).limit(limit);
      if (after !== null) query = query.startAfter(after);
      const page = await query.get();
      docsRead += page.docs.length;
      budget -= page.docs.length;
      const found = await reconcileRows(db, registry, source, page.docs, nowMs, options.onMalformed);
      missingFound += found.missing;
      malformed += found.malformed;
      if (page.docs.length < limit) {
        phase += 1;
        after = null;
      } else {
        after = page.docs[page.docs.length - 1].id;
      }
    }
  }
  const completed = due && phase >= PHASES.length;
  const totalMissing = state.missing_found + missingFound;
  if (registry.largestShardEntries > WATCH_REGISTRY_SHARD_WARN_ENTRIES) {
    console.error('[watch-registry] watch_registry_shard_near_limit', { largest_shard_entries: registry.largestShardEntries });
  }
  await stateRef.set({
    schema_version: RECONCILE_SCHEMA,
    next_due_ms: completed ? nowMs + WATCH_REGISTRY_RECONCILE_INTERVAL_MS : state.next_due_ms,
    phase: completed ? 0 : phase,
    after: completed ? null : after,
    missing_found: completed ? 0 : totalMissing,
    revision,
    revision_seen_at_ms: revisionSeenAt,
    ...(completed ? {
      last_completed_ms: nowMs,
      last_missing_found: totalMissing,
    } : {}),
    largest_shard_entries: registry.largestShardEntries,
    updated_at_ms: nowMs,
  }, { merge: true });
  return { ran: due, completed, eager, docs_read: docsRead, missing_found: missingFound, malformed };
}
