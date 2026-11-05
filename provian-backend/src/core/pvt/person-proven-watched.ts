/**
 * ONE enumeration of PEOPLE's proven external addresses for every watcher
 * (2026-10-01, "Every watcher attributes a person's proven
 * address to that person").
 *
 * Read by the outbound USDC watcher, the inbound USDC watcher, the chain-record
 * lane and its inbound/outbound discovery scans, so all of them agree on who is
 * watched and from which block.
 *
 * A row is watched only when BOTH hold:
 * - the `human_proven_addresses` record passes the full proof validation
 * (`isEconomicallyActiveHumanProvenAddress`, the same check an agent's v2
 * record passes), and
 * - the person's Provian wallet it names (`wallets/{wallet_id}`) is that
 * person's active human wallet (not released, displaced, or a test wallet).
 * A row failing either is a per-row fault: excluded (via `onExclude`) and never
 * attributed to a guess, so one bad row never stops anyone else's scan.
 *
 * The fence is the record's exact H+1 `proven_at_block` nothing before the
 * proof is ever watched.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  HUMAN_PROVEN_ADDRESSES_COLLECTION,
  isEconomicallyActiveHumanProvenAddress,
} from '../external-address/human-link';
import { isActiveHumanWallet } from '../wallet/active-human-wallet';
import { WatchReadError } from './watch-read-error';

export interface PersonProvenWatchedAddress {
  /** Lowercased proven address. */
  readonly address: string;
  /** The person's own Provian wallet doc id (`wallets/{id}`). */
  readonly walletId: string;
  /** The person's `user_id` — the accrual identity of their PEs. */
  readonly userId: string;
  /** Exact H+1 go-forward fence. */
  readonly provenAtBlock: number;
  readonly provenAtMs: number;
}

export async function enumeratePersonProvenAddresses(
  db: Firestore,
  /** Per-row fault sink; without it the first fault throws (standalone contract). */
  onExclude?: (error: unknown) => void,
  /** only this address's row (the per-address resolution); every row when omitted. */
  onlyAddress?: string,
): Promise<PersonProvenWatchedAddress[]> {
  const docs = onlyAddress === undefined
    ? (await db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).get()).docs
    : await (async () => {
      const snap = await db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(onlyAddress.toLowerCase()).get();
      return snap.exists ? [snap] : [];
    })();
  const out: PersonProvenWatchedAddress[] = [];
  for (const doc of docs) {
    try {
      const record: unknown = doc.data();
      if (!isEconomicallyActiveHumanProvenAddress(record, doc.id)) {
        throw new Error(`watched_address_enumeration_invalid:person_proven:${doc.id}`);
      }
      const walletSnap = await db.collection('wallets').doc(record.wallet_id).get();
      const wallet = walletSnap.exists ? walletSnap.data() as Record<string, unknown> : undefined;
      if (wallet?.platform === 'test') continue;
      if (!wallet
        || !isActiveHumanWallet(wallet)
        || wallet.id !== record.wallet_id
        || wallet.user_id !== record.user_id) {
        throw new Error(`watched_address_enumeration_invalid:person_proven_wallet:${record.wallet_id}`);
      }
      out.push({
        address: record.address,
        walletId: record.wallet_id,
        userId: record.user_id,
        provenAtBlock: record.proven_at_block,
        provenAtMs: record.proven_at_ms,
      });
    } catch (error) {
      // a failed read under a watcher's per-address resolution holds, never excludes.
      if (!onExclude || error instanceof WatchReadError) throw error;
      onExclude(error);
    }
  }
  return out;
}
