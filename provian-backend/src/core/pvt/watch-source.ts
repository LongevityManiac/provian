/**
 * what a USDC watcher run asks the chain about, and how it validates what it finds.
 *
 * A run used to rebuild its whole validated watched set from every source row before scanning.
 * A `WatchSource` splits that into the two things the scan actually needs:
 *
 * - `load()` the addresses to consider this run — the registry (every address ever made
 * watchable, `watch-registry.ts`), the addresses already marked live, the ones parked today
 * (validation excluded them and they have no live admission), the admissions still
 * backfilling, and the late records the daily reconcile wrote. All of it is a fixed number of
 * documents, whatever the wallet count.
 * - `resolve(address)` the full enumeration's verdict for ONE address, computed by the same
 * enumerator over the rows that can affect that address (its index rows, its wallet's rows,
 * its admissions, its proven rows). A run resolves only addresses with work: the pending
 * ones, and the recipients and senders of logs the chain returned.
 *
 * Verdicts: `valid` (watch it, with the fresh record), `excluded` (the enumerator's per-wallet
 * exclusion — the same set an old run left out of its band), `hold` (anything the enumerator
 * threw, including a failed read: the old run aborted on these, so the per-address equivalent is
 * to keep the checkpoint behind the event).
 *
 * `legacyWatchSource` wraps a full `list()` so a caller without the registry (tests, operator
 * tools) gets exactly the old behavior through the same code path: every listed address is
 * pending every run, nothing is marked, and a list that throws aborts the run as before.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  parseWatcherAddressAdmission,
  type WatcherAddressAdmissionDocument,
  type WatcherDirection,
} from './watcher-address-admission';
import {
  WatcherEnumerationExclusionLog,
  type WatcherEnumerationExclusion,
} from './watcher-enumeration-health';
import {
  parkAddresses,
  readParkedToday,
  readPendingLateRecords,
  readWatchMarks,
  readWatchMarksGenerationHighWater,
  raiseWatchMarksGenerationHighWater,
  WATCH_REGISTRY_MARKS_COLLECTION,
  seedWatchMarks,
  watchRegistryAddresses,
  writeWatchMarks,
  clearLateRecord,
  advanceLateRecord,
  unmarkAddresses,
  unparkAddresses,
  type WatchRegistryWatcher,
} from './watch-registry';
import { ensureWatchRegistrySeeded } from './watch-registry-reconcile';

export type WatchResolution<W> =
  | { readonly kind: 'valid'; readonly wallet: W; readonly admission: WatcherAddressAdmissionDocument | null }
  | { readonly kind: 'excluded'; readonly admission: WatcherAddressAdmissionDocument | null }
  | { readonly kind: 'hold'; readonly error: string };

export interface WatchSourceView {
  /** Every address to consider (the band superset), in a stable order. */
  readonly candidates: readonly string[];
  /** Addresses whose admission for this direction is already live (no per-address work). */
  readonly marked: ReadonlySet<string>;
  /** Addresses validation excluded today that have no live admission. */
  readonly parked: ReadonlySet<string>;
  /** Addresses whose admission for this direction is backfilling. */
  readonly backfilling: ReadonlySet<string>;
  /** Late records (reconcile repairs): address -> next block to rescan (null = from the fence). */
  readonly late: ReadonlyMap<string, number | null>;
  /**
   * The highest membership generation among admissions marked live (0 for the legacy list,
   * which re-checks every admission each run). The run refuses a checkpoint below it.
   */
  readonly generationHighWater: number;
}

export interface WatchSource<W> {
  /** True when backed by the registry (scoped resolution); false for the legacy full list. */
  readonly registry: boolean;
  load(nowMs: number): Promise<WatchSourceView>;
  resolve(address: string): Promise<WatchResolution<W>>;
  /** Mark addresses live; `generation` is the highest membership generation among their admissions. */
  markLive(addresses: readonly string[], nowMs: number, generation: number): Promise<void>;
  park(addresses: readonly string[], nowMs: number): Promise<void>;
  /** Un-mark and un-park: a log found the address valid without a live admission, so the next
   *  run gives it its per-address work (ensure + catch-up from its fence). */
  requeue(addresses: readonly string[], nowMs: number): Promise<void>;
  advanceLate(address: string, nextBlock: number): Promise<void>;
  clearLate(address: string): Promise<void>;
  /** The exclusions recorded since the last `load`. */
  exclusions(): WatcherEnumerationExclusionLog;
  /**
   * The next slice of the health sweep: registry addresses to resolve this run with nothing to
   * act on, so a wallet that has become invalid is reported even while it is idle. A fixed
   * number per run (a full cycle takes registry size / slice runs); empty for the legacy list,
   * which resolves everything every run.
   */
  sweep(view: WatchSourceView): Promise<readonly string[]>;
  /**
   * The exclusions to publish: this run's, plus — until the current sweep cycle completes — the
   * last completed cycle's, so an idle excluded wallet stays visible between its checks.
   */
  healthExclusions(thisRun: readonly WatcherEnumerationExclusion[]): Promise<WatcherEnumerationExclusion[]>;
}

/** Registry addresses resolved per run by the health sweep. */
export const WATCH_HEALTH_SWEEP_PER_RUN = 25;
const HEALTH_CYCLE_SCHEMA = 'watch-registry-health-cycle/v1';
const HEALTH_CYCLE_MAX_ITEMS = 200;

function exclusionKey(item: WatcherEnumerationExclusion): string {
  return `${item.wallet_id ?? ''}\u0000${item.reason}`;
}

function mergeExclusions(...groups: ReadonlyArray<readonly WatcherEnumerationExclusion[]>): WatcherEnumerationExclusion[] {
  const out = new Map<string, WatcherEnumerationExclusion>();
  for (const group of groups) {
    for (const item of group) if (!out.has(exclusionKey(item))) out.set(exclusionKey(item), item);
  }
  return [...out.values()].slice(0, HEALTH_CYCLE_MAX_ITEMS);
}

function parseExclusionList(raw: unknown): WatcherEnumerationExclusion[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is WatcherEnumerationExclusion => item !== null && typeof item === 'object'
    && typeof (item as Record<string, unknown>).reason === 'string'
    && ((item as Record<string, unknown>).wallet_id === null || typeof (item as Record<string, unknown>).wallet_id === 'string')
    && ((item as Record<string, unknown>).kind === 'orphaned_index_row' || (item as Record<string, unknown>).kind === 'invalid_authority'))
    .map((item) => ({ wallet_id: item.wallet_id, reason: item.reason, kind: item.kind }));
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** The old behavior through the new path: one full list per run, every address pending. */
export function legacyWatchSource<W>(
  list: () => Promise<readonly W[]>,
  addressOf: (wallet: W) => string,
  /** A copy of a listed wallet with its address lowercased (the old run copied every row). */
  copy: (wallet: W, address: string) => W,
  exclusions: () => WatcherEnumerationExclusionLog = () => new WatcherEnumerationExclusionLog(),
): WatchSource<W> {
  let byAddress = new Map<string, W>();
  return {
    registry: false,
    async load() {
      const listed = await list();
      byAddress = new Map();
      for (const wallet of listed) {
        const address = addressOf(wallet).toLowerCase();
        // Two rows for one address: neither is authority (the old run's abort, unchanged).
        if (byAddress.has(address)) throw new Error(`watched_address_enumeration_duplicate:${address}`);
        byAddress.set(address, copy(wallet, address));
      }
      return {
        candidates: [...byAddress.keys()],
        marked: new Set(),
        parked: new Set(),
        backfilling: new Set(),
        late: new Map(),
        generationHighWater: 0,
      };
    },
    async resolve(address) {
      const wallet = byAddress.get(address.toLowerCase());
      return wallet ? { kind: 'valid', wallet, admission: null } : { kind: 'excluded', admission: null };
    },
    async markLive() { /* nothing persists */ },
    async park() { /* nothing persists */ },
    async requeue() { /* nothing persists */ },
    async advanceLate() { /* nothing persists */ },
    async clearLate() { /* nothing persists */ },
    exclusions,
    async sweep() { return []; },
    async healthExclusions(thisRun) { return [...thisRun]; },
  };
}

export interface RegistryWatchSourceConfig<W> {
  readonly db: Firestore;
  readonly watcher: Extract<WatchRegistryWatcher, 'inbound_usdc' | 'outbound_usdc'>;
  readonly direction: WatcherDirection;
  readonly chainId: number;
  /**
   * The full enumerator's verdict for one address: the wallets it would watch for that address
   * (normally zero or one) plus this direction's admission for it. Exclusions go to `exclude`;
   * anything thrown is a hold.
   */
  readonly resolveAddress: (
    address: string,
    exclude: (error: unknown) => void,
  ) => Promise<{ readonly wallets: readonly W[]; readonly admission: WatcherAddressAdmissionDocument | null }>;
  readonly addressOf: (wallet: W) => string;
  readonly logPrefix: string;
}

/** This direction's admission for `address` among `docs`, or null (absent or malformed). */
export function admissionFromDocs(
  docs: ReadonlyArray<{ data(): unknown }>,
  direction: WatcherDirection,
  chainId: number,
  address: string,
): WatcherAddressAdmissionDocument | null {
  for (const doc of docs) {
    try {
      const admission = parseWatcherAddressAdmission(doc.data() as Record<string, unknown>);
      if (admission.direction === direction && admission.chain_id === chainId && admission.address === address) {
        return admission;
      }
    } catch {
      // A malformed admission is the enumerator's to report; it is no admission here.
    }
  }
  return null;
}

/** This direction's admissions in `state`, by address. Malformed docs name their address when they can. */
async function admissionAddressesInState(
  db: Firestore,
  direction: WatcherDirection,
  chainId: number,
  state: 'live' | 'backfilling',
): Promise<{ addresses: Set<string>; maxGeneration: number }> {
  const snap = await db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION).where('state', '==', state).get();
  const out = new Set<string>();
  let maxGeneration = 0;
  for (const doc of snap.docs) {
    const raw = doc.data() as Record<string, unknown>;
    if (raw.direction !== direction || raw.chain_id !== chainId || typeof raw.address !== 'string') continue;
    const address = raw.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
    if (state === 'live') {
      // Only a well-formed live admission may be MARKED: a mark skips per-address work.
      try {
        maxGeneration = Math.max(maxGeneration, parseWatcherAddressAdmission(raw).membership_generation);
      } catch {
        continue;
      }
    }
    // A backfilling (or malformed) admission only makes the address pending: resolution decides.
    out.add(address);
  }
  return { addresses: out, maxGeneration };
}

export function registryWatchSource<W>(config: RegistryWatchSourceConfig<W>): WatchSource<W> {
  const { db, watcher, direction, chainId } = config;
  let log = new WatcherEnumerationExclusionLog();
  let cache = new Map<string, Promise<WatchResolution<W>>>();
  let parkedCount = 0;
  let cycleRead: { after: string | null; items: WatcherEnumerationExclusion[]; published: WatcherEnumerationExclusion[] } | null = null;
  let cycleWrapped = false;
  let cycleAfter: string | null = null;
  const readCycle = async () => {
    if (cycleRead) return cycleRead;
    const snap = await db.collection(WATCH_REGISTRY_MARKS_COLLECTION).doc(`${watcher}_health_cycle`).get();
    const raw = snap.exists ? snap.data() as Record<string, unknown> : undefined;
    // The sweep's own bookkeeping: a malformed one restarts the cycle (it only reports).
    const valid = raw?.schema_version === HEALTH_CYCLE_SCHEMA
      && (raw.after === null || (typeof raw.after === 'string' && /^0x[0-9a-f]{40}$/.test(raw.after)));
    cycleRead = {
      after: valid ? raw!.after as string | null : null,
      items: valid ? parseExclusionList(raw!.items) : [],
      published: valid ? parseExclusionList(raw!.published) : [],
    };
    cycleAfter = cycleRead.after;
    return cycleRead;
  };
  const exclude = (error: unknown): void => {
    log.record(error);
    console.error(`${config.logPrefix} watched-address resolution excluded a wallet:`, error);
  };
  return {
    registry: true,
    async load(nowMs) {
      log = new WatcherEnumerationExclusionLog();
      cache = new Map();
      const registry = await ensureWatchRegistrySeeded(db, nowMs);
      let marked = await readWatchMarks(db, watcher);
      if (marked === null) {
        // First run over this database: the old band was exactly this direction's live
        // admissions (each validated per run, as every band address still is at use).
        const live = await admissionAddressesInState(db, direction, chainId, 'live');
        await raiseWatchMarksGenerationHighWater(db, watcher, live.maxGeneration);
        await seedWatchMarks(db, watcher, live.addresses, nowMs);
        marked = live.addresses;
      }
      const [parkedAt, backfilling, late, generationHighWater] = await Promise.all([
        readParkedToday(db, watcher, nowMs),
        admissionAddressesInState(db, direction, chainId, 'backfilling').then((r) => r.addresses),
        readPendingLateRecords(db, watcher),
        readWatchMarksGenerationHighWater(db, watcher),
      ]);
      parkedCount = parkedAt.size;
      // A park holds only until the address is registered or proved again (its entry's time).
      const parked = new Set<string>();
      for (const [address, at] of parkedAt) {
        if (at > (registry.latestMs.get(address) ?? 0)) parked.add(address);
      }
      const lateProgress = new Map<string, number | null>();
      for (const [address, record] of late) lateProgress.set(address, record.progress[watcher] ?? null);
      return {
        candidates: watchRegistryAddresses(registry),
        marked,
        parked,
        backfilling,
        late: lateProgress,
        generationHighWater,
      };
    },
    resolve(addressInput) {
      const address = addressInput.toLowerCase();
      const cached = cache.get(address);
      if (cached) return cached;
      const pending = (async (): Promise<WatchResolution<W>> => {
        try {
          const { wallets, admission } = await config.resolveAddress(address, exclude);
          const matching = wallets.filter((wallet) => config.addressOf(wallet).toLowerCase() === address);
          if (matching.length > 1) {
            return { kind: 'hold', error: `watched_address_enumeration_duplicate:${address}` };
          }
          return matching.length === 1
            ? { kind: 'valid', wallet: matching[0], admission }
            : { kind: 'excluded', admission };
        } catch (error) {
          console.error(`${config.logPrefix} watched-address resolution held ${address}:`, error);
          return { kind: 'hold', error: errorText(error) };
        }
      })();
      cache.set(address, pending);
      return pending;
    },
    async markLive(addresses, nowMs, generation) {
      if (addresses.length === 0) return;
      // The high water first: a mark never exists without its generation covered.
      await raiseWatchMarksGenerationHighWater(db, watcher, generation);
      await writeWatchMarks(db, watcher, addresses, nowMs);
    },
    async park(addresses, nowMs) {
      if (addresses.length === 0) return;
      await parkAddresses(db, watcher, addresses, parkedCount, nowMs);
      parkedCount += addresses.length;
    },
    async requeue(addresses, nowMs) {
      if (addresses.length === 0) return;
      await unmarkAddresses(db, watcher, addresses);
      await unparkAddresses(db, watcher, addresses, nowMs);
    },
    advanceLate: (address, nextBlock) => advanceLateRecord(db, watcher, address, nextBlock),
    clearLate: (address) => clearLateRecord(db, watcher, address),
    exclusions: () => log,
    async sweep(view) {
      const cycle = await readCycle();
      const ordered = view.candidates;
      if (ordered.length === 0) {
        cycleWrapped = true;
        return [];
      }
      let start = cycle.after === null ? 0 : ordered.findIndex((address) => address > (cycle.after as string));
      if (start < 0) start = 0;
      const slice = ordered.slice(start, start + WATCH_HEALTH_SWEEP_PER_RUN);
      cycleWrapped = start + slice.length >= ordered.length;
      cycleAfter = slice.length > 0 ? slice[slice.length - 1] : cycle.after;
      return slice;
    },
    async healthExclusions(thisRun) {
      const cycle = await readCycle();
      const working = mergeExclusions(cycle.items, thisRun);
      const published = cycleWrapped ? working : mergeExclusions(cycle.published, working);
      await db.collection(WATCH_REGISTRY_MARKS_COLLECTION).doc(`${watcher}_health_cycle`).set({
        schema_version: HEALTH_CYCLE_SCHEMA,
        after: cycleWrapped ? null : cycleAfter,
        items: cycleWrapped ? [] : working,
        published: cycleWrapped ? working : cycle.published,
      });
      cycleRead = null;
      cycleWrapped = false;
      return published;
    },
  };
}
