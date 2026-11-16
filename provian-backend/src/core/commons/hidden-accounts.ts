/**
 * Which ACCOUNTS are off every public projection.
 *
 * An account is one person or agent seen through up to three documents: its Commons profile
 * (`commons_profiles/{id}` — the user id for a person, the wallet id for an agent), its wallet
 * (`wallets/{walletId}`, which carries the person's `user_id`) and, for an agent,
 * `agent_wallets/{walletId}`. The account is hidden when ANY of those documents is excluded from
 * public display (`isExcludedFromPublicDisplay`: a hidden marker or `platform: 'test'`). Before this
 * module each surface read only the one document it happened to load, so an account marked on its
 * wallet still listed in the Commons directory, and one marked on its profile still ranked.
 *
 * DISPLAY ONLY. Nothing is deleted, and no mint, Genesis, accrual or settlement path reads this.
 *
 * The set is built from equality / `in` queries on the markers (the population is the marked
 * documents, never the whole collection) and memoized per database client for a minute, so a
 * public read pays for it at most once a minute per instance. A read failure throws: a surface
 * that cannot tell whether an account is hidden does not show it (unknown = block).
 */

import type { DocumentData, DocumentReference, DocumentSnapshot, Firestore, QuerySnapshot } from 'firebase-admin/firestore';
import { COMMONS_COLLECTIONS } from './types';
import { HIDDEN_VISIBILITY_VALUES, isExcludedFromPublicDisplay } from './public-visibility';
import { TEST_PLATFORM_VALUE } from '../pvt/genesis-award-state-machine';

export const HIDDEN_ACCOUNTS_TTL_MS = 60_000;
const IN_QUERY_CHUNK = 30;
const GET_ALL_CHUNK = 100;

type Reader = Pick<Firestore, 'collection' | 'getAll'>;

export interface HiddenAccounts {
  /** Every hidden profile id, wallet id and person's user id. */
  readonly ids: ReadonlySet<string>;
}

/** Whether a profile / wallet / user id belongs to a hidden account. */
export function isHiddenAccount(hidden: HiddenAccounts, id: unknown): boolean {
  return typeof id === 'string' && id.length > 0 && hidden.ids.has(id);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function stringField(data: DocumentData | undefined, field: string): string | null {
  const value = data?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function unionById(...snaps: QuerySnapshot[]): Array<{ id: string; data: DocumentData }> {
  const byId = new Map<string, DocumentData>();
  for (const snap of snaps) for (const doc of snap.docs) byId.set(doc.id, doc.data());
  return [...byId].map(([id, data]) => ({ id, data }));
}

/** Read documents by id in bounded `getAll` batches; missing documents are skipped. */
export async function readDocsById(db: Reader, collection: string, ids: readonly string[]): Promise<Map<string, DocumentData>> {
  const out = new Map<string, DocumentData>();
  for (const part of chunks(ids, GET_ALL_CHUNK)) {
    if (part.length === 0) continue;
    const refs: DocumentReference[] = part.map((id) => db.collection(collection).doc(id));
    const snaps: DocumentSnapshot[] = await db.getAll(...refs);
    for (const snap of snaps) {
      const data = snap.exists ? snap.data() : undefined;
      if (data) out.set(snap.id, data);
    }
  }
  return out;
}

/** Build the hidden-account set from the marked documents (uncached). */
export async function computeHiddenAccounts(db: Reader): Promise<HiddenAccounts> {
  const hiddenValues = [...HIDDEN_VISIBILITY_VALUES];
  const [profileSnap, walletMarkedSnap, walletTestSnap, agentMarkedSnap, agentTestSnap] = await Promise.all([
    db.collection(COMMONS_COLLECTIONS.PROFILES).where('public_visibility', 'in', hiddenValues).get(),
    db.collection('wallets').where('public_visibility', 'in', hiddenValues).get(),
    db.collection('wallets').where('platform', '==', TEST_PLATFORM_VALUE).get(),
    db.collection('agent_wallets').where('public_visibility', 'in', hiddenValues).get(),
    db.collection('agent_wallets').where('platform', '==', TEST_PLATFORM_VALUE).get(),
  ]);
  const profiles = unionById(profileSnap);
  const wallets = unionById(walletMarkedSnap, walletTestSnap);
  const agentWallets = unionById(agentMarkedSnap, agentTestSnap);
  const ids = new Set<string>();
  for (const row of [...profiles, ...wallets, ...agentWallets]) ids.add(row.id);

  // A person's profile is keyed by user id while the wallet is keyed by wallet id; `wallets`
  // carries the link. Resolve both directions with one `user_id in` pass over the candidates.
  const userIdsFromWallets = new Set(wallets.map((w) => stringField(w.data, 'user_id')).filter((u): u is string => u !== null));
  const candidates = [...new Set([...userIdsFromWallets, ...profiles.map((p) => p.id)])];
  const walletsByUser = new Map<string, Array<{ id: string; data: DocumentData }>>();
  for (const part of chunks(candidates, IN_QUERY_CHUNK)) {
    const snap = await db.collection('wallets').where('user_id', 'in', part).get();
    for (const doc of snap.docs) {
      const userId = stringField(doc.data(), 'user_id');
      if (!userId) continue;
      const list = walletsByUser.get(userId) ?? [];
      list.push({ id: doc.id, data: doc.data() });
      walletsByUser.set(userId, list);
    }
  }
  // A profile-marked person hides every wallet of theirs on wallet-level surfaces.
  for (const profile of profiles) {
    for (const wallet of walletsByUser.get(profile.id) ?? []) ids.add(wallet.id);
  }
  // A marked wallet hides its person's profile only when that person has no unmarked wallet: a
  // wallet retired as a test fixture must not take a live account of the same person with it.
  for (const userId of userIdsFromWallets) {
    const siblings = walletsByUser.get(userId) ?? [];
    if (siblings.every((w) => isExcludedFromPublicDisplay(w.data))) ids.add(userId);
  }
  return { ids };
}

const memo = new WeakMap<object, { readonly at: number; readonly value: Promise<HiddenAccounts> }>();

/** The hidden-account set, memoized per database client for `HIDDEN_ACCOUNTS_TTL_MS`. */
export function loadHiddenAccounts(db: Reader, now: number = Date.now()): Promise<HiddenAccounts> {
  const entry = memo.get(db);
  if (entry && now - entry.at < HIDDEN_ACCOUNTS_TTL_MS) return entry.value;
  const value = computeHiddenAccounts(db);
  memo.set(db, { at: now, value });
  // A failed read is not remembered: the next caller retries.
  value.catch(() => { if (memo.get(db)?.value === value) memo.delete(db); });
  return value;
}

/**
 * The profile and agent-wallet rows of the hidden accounts, for the public member and agent
 * counts. Bounded by the hidden set (one `getAll` pass per collection), never a collection scan.
 */
export async function readHiddenAccountRows(db: Reader, hidden: HiddenAccounts): Promise<{
  readonly profiles: ReadonlyArray<{ readonly id: string; readonly participant_type: string | null; readonly status: string | null }>;
  readonly agentWallets: ReadonlyArray<{ readonly id: string; readonly platform: string | null }>;
}> {
  const ids = [...hidden.ids];
  const [profiles, agentWallets] = await Promise.all([
    readDocsById(db, COMMONS_COLLECTIONS.PROFILES, ids),
    readDocsById(db, 'agent_wallets', ids),
  ]);
  return {
    profiles: [...profiles].map(([id, data]) => ({
      id,
      participant_type: stringField(data, 'participant_type'),
      status: stringField(data, 'status'),
    })),
    agentWallets: [...agentWallets].map(([id, data]) => ({ id, platform: stringField(data, 'platform') })),
  };
}
