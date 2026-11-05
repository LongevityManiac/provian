/**
 * Watched-set enumeration health for the USDC watchers.
 *
 * Both watchers isolate a wallet whose authority records fail validation: the
 * wallet is EXCLUDED from that cycle and the scan proceeds for everyone else
 * (Unknown = Block, per wallet). Until the only trace of an exclusion was
 * a console.error line, so a real wallet (Atlas, after its key rotation) sat
 * excluded from inbound witnessing for weeks while every scan answered 200.
 *
 * This module makes every exclusion a durable, counted fact:
 * - each scan report carries `excluded_wallets`, `orphaned_index_rows` and
 * the per-wallet `exclusions` (wallet id + exact reason);
 * - each scan writes `pvt_watcher_enumeration_health_v1/{watcher}`, carrying
 * each exclusion's first-seen time forward so persistence is measurable;
 * - the ops chain collector reads that document and the attention engine
 * raises `chain.watcher_exclusions.<watcher>`.
 *
 * Two classes, deliberately separated: an ORPHANED index row names a wallet
 * whose wallet document no longer exists (a deleted wallet; nothing can earn
 * there, so it is counted and shown, never paged). An INVALID-AUTHORITY
 * exclusion names a wallet that EXISTS but whose records do not bind — the
 * silent-exclusion class that hid Atlas — and pages once it persists.
 */

import type { Firestore } from 'firebase-admin/firestore';

export const WATCHER_ENUMERATION_HEALTH_COLLECTION = 'pvt_watcher_enumeration_health_v1';
export const WATCHER_ENUMERATION_HEALTH_SCHEMA = 'pvt-watcher-enumeration-health/v1';
/** Items persisted per document; counts are always exact. */
export const WATCHER_ENUMERATION_HEALTH_MAX_ITEMS = 50;

export type WatcherEnumerationName = 'inbound_usdc' | 'outbound_usdc';
export type WatcherEnumerationExclusionKind = 'orphaned_index_row' | 'invalid_authority';

export interface WatcherEnumerationExclusion {
  /** The wallet (or index document) the reason names; null when unattributable. */
  readonly wallet_id: string | null;
  /** The exact exclusion reason (the thrown message), truncated to 300 chars. */
  readonly reason: string;
  readonly kind: WatcherEnumerationExclusionKind;
}

export interface WatcherEnumerationHealthItem extends WatcherEnumerationExclusion {
  readonly first_seen_at_ms: number;
}

export interface WatcherEnumerationHealthDocument {
  readonly schema_version: typeof WATCHER_ENUMERATION_HEALTH_SCHEMA;
  readonly watcher: WatcherEnumerationName;
  readonly checked_at_ms: number;
  readonly watched_count: number;
  readonly excluded_wallets: number;
  readonly orphaned_index_rows: number;
  readonly exclusions: readonly WatcherEnumerationHealthItem[];
}

/** The owner-class wallet-missing reasons: the wallet document is gone. */
const ORPHANED_REASON = /^watched_address_enumeration_invalid:(?:agent_wallet_missing|human_wallet_missing|native_wallet_missing):/;
/** Back-check reasons that name a wallet id whose existence decides the class. */
const BACK_CHECK_REASON = /^watched_address_enumeration_invalid:(?:agent_address_index_missing|human_address_index_missing|native_address_index_missing):(.+)$/;

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

/** The trailing `:<id>` of a `watched_address_enumeration_*` reason. */
function subjectOf(reason: string): string | null {
  if (!reason.startsWith('watched_address_enumeration_')) return null;
  const index = reason.lastIndexOf(':');
  if (index < 0 || index === reason.length - 1) return null;
  return reason.slice(index + 1);
}

/**
 * Per-enumeration recorder. `record` is synchronous (the watchers call it from
 * their existing `excludeWallet` sinks); `classify` resolves the back-check
 * reasons with one existence read per named wallet.
 */
export class WatcherEnumerationExclusionLog {
  private readonly pending: { reason: string; walletId: string | null }[] = [];

  record(error: unknown): void {
    const reason = reasonOf(error);
    this.pending.push({ reason, walletId: subjectOf(reason) });
  }

  get size(): number {
    return this.pending.length;
  }

  async classify(db: Firestore): Promise<WatcherEnumerationExclusion[]> {
    const out: WatcherEnumerationExclusion[] = [];
    const seen = new Set<string>();
    for (const item of this.pending) {
      const key = `${item.walletId ?? ''}\u0000${item.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let kind: WatcherEnumerationExclusionKind = 'invalid_authority';
      if (ORPHANED_REASON.test(item.reason)) {
        kind = 'orphaned_index_row';
      } else {
        const backCheck = BACK_CHECK_REASON.exec(item.reason);
        if (backCheck) {
          // An index/admission row with no address index: orphaned only when no
          // wallet document of either owner class exists. A read failure keeps
          // it `invalid_authority` (Unknown = Block: page rather than hide).
          try {
            const walletId = backCheck[1];
            const [agent, human] = await Promise.all([
              db.collection('agent_wallets').doc(walletId).get(),
              db.collection('wallets').doc(walletId).get(),
            ]);
            if (!agent.exists && !human.exists) kind = 'orphaned_index_row';
          } catch {
            kind = 'invalid_authority';
          }
        }
      }
      out.push({ wallet_id: item.walletId, reason: item.reason, kind });
    }
    return out;
  }
}

export function countExclusions(exclusions: readonly WatcherEnumerationExclusion[]): {
  excluded_wallets: number;
  orphaned_index_rows: number;
} {
  let excluded = 0;
  let orphaned = 0;
  for (const item of exclusions) {
    if (item.kind === 'orphaned_index_row') orphaned += 1;
    else excluded += 1;
  }
  return { excluded_wallets: excluded, orphaned_index_rows: orphaned };
}

/**
 * Write the watcher's enumeration health. First-seen times carry forward for an
 * exclusion (same wallet + same reason) present in the prior document, so the
 * attention rule can tell a persisting exclusion from a transient one.
 * Best-effort by contract: the scan's own result never depends on it, so a
 * failure is logged and swallowed by the caller.
 */
export async function persistWatcherEnumerationHealth(
  db: Firestore,
  watcher: WatcherEnumerationName,
  input: {
    readonly watchedCount: number;
    readonly exclusions: readonly WatcherEnumerationExclusion[];
    readonly now: number;
  },
): Promise<WatcherEnumerationHealthDocument> {
  const ref = db.collection(WATCHER_ENUMERATION_HEALTH_COLLECTION).doc(watcher);
  const priorSnap = await ref.get();
  const prior = priorSnap.exists
    ? (priorSnap.data() as Partial<WatcherEnumerationHealthDocument>)
    : undefined;
  const priorFirstSeen = new Map<string, number>();
  for (const item of Array.isArray(prior?.exclusions) ? prior!.exclusions : []) {
    if (item && typeof item.reason === 'string' && Number.isSafeInteger(item.first_seen_at_ms)) {
      priorFirstSeen.set(`${item.wallet_id ?? ''}\u0000${item.reason}`, item.first_seen_at_ms);
    }
  }
  const counts = countExclusions(input.exclusions);
  // Invalid-authority items first, so the persisted slice never drops a paging
  // item behind orphaned rows.
  const ordered = [...input.exclusions].sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'invalid_authority' ? -1 : 1));
  const doc: WatcherEnumerationHealthDocument = {
    schema_version: WATCHER_ENUMERATION_HEALTH_SCHEMA,
    watcher,
    checked_at_ms: input.now,
    watched_count: input.watchedCount,
    excluded_wallets: counts.excluded_wallets,
    orphaned_index_rows: counts.orphaned_index_rows,
    exclusions: ordered.slice(0, WATCHER_ENUMERATION_HEALTH_MAX_ITEMS).map((item) => ({
      ...item,
      first_seen_at_ms: priorFirstSeen.get(`${item.wallet_id ?? ''}\u0000${item.reason}`) ?? input.now,
    })),
  };
  await ref.set(doc as unknown as Record<string, unknown>);
  return doc;
}
