/**
 * FoundationMembership client.
 *
 * Historical FoundationMembership queue implementation. runtime boundary has no active
 * PVT9-dependent membership runtime: the production config seam below is
 * always disabled and ignores stale environment flags and deployed legacy
 * addresses. The queue implementation is retained as historical later-WP code.
 *
 * Queueing keeps the happy path entirely on Firestore writes - no RPC, no
 * signing key, no chance of a grant call blocking a PE submission.
 *
 * Queue document shape:
 * {
 * wallet_address: "0x...",
 * chain_id: 8453 | 42161 | 10,
 * contract_address: "0x...",
 * user_id: "<pvt_accrual doc key>",
 * status: "pending" | "granted" | "failed",
 * queued_at: number,
 * granted_tx?: string,
 * error?: string,
 * }
 *
 * One queue entry per (wallet, chain) tuple. The grant function on-chain is
 * idempotent at the contract level (reverts AlreadyMember on second call),
 * so queue-side duplication is safe - the Safe can ignore reverts.
 */

import type { Firestore } from 'firebase-admin/firestore';

// -----------------------------------------------------------------------------
// Config + env validation
// -----------------------------------------------------------------------------

export interface FoundationMembershipChain {
  chainId: number;
  networkName: 'base' | 'arbitrum' | 'optimism';
  contractAddress: string;
}

export interface FoundationMembershipConfig {
  enabled: boolean;
  chains: FoundationMembershipChain[];
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Return the canonical runtime boundary-disabled state. Environment variables and legacy
 * deployment addresses are deliberately not read: neither is PVT9 authority.
 */
export function loadFoundationMembershipConfig(): FoundationMembershipConfig {
  return { enabled: false, chains: [] };
}

// -----------------------------------------------------------------------------
// Queue writer (runs on first human PE)
// -----------------------------------------------------------------------------

const GRANTS_COLLECTION = 'foundation_membership_grants';

/**
 * Statuses for which a re-queue would cause the Safe drainer to send a
 * second on-chain `grantInitialMembership` for the same user - i.e. the
 * states that are downstream of "queue write picked up by drainer".
 *
 * H-5 (audit 2026-05-11): the previous batch.set(..., { merge: true })
 * pattern overwrote `status: 'granted'` back to `pending` if any code
 * path re-entered queueInitialMembershipGrants for the same
 * {userId}_{chainId}. The (since-deleted) lazyMigrateAccrual rebuild path
 * could re-fire the 0→1 PE-accrual hook, which is the only producer of this queue.
 * The transactional skip below is the per-doc guard.
 */
const TERMINAL_OR_IN_FLIGHT_STATUSES = new Set(['granted', 'granting']);

/**
 * Queue initial-membership grants for one human wallet across all configured
 * chains. Fire-and-forget: returns a promise but callers don't need to await.
 *
 * No-op when:
 *   - config.enabled is false
 *   - walletAddress doesn't parse as a 0x address (defensive; relay typically
 *     passes validated addresses)
 *   - userId or walletAddress is empty
 *
 * Per-chain doc id is `{userId}_{chainId}`. The write is a transactional
 * read-then-set so a re-entry for a user whose grant is already 'granted'
 * or in-flight 'granting' becomes a no-op rather than overwriting back to
 * 'pending' (which would re-trip the Safe drainer and double-mint the
 * grant).
 */
export async function queueInitialMembershipGrants(
  db: Firestore,
  config: FoundationMembershipConfig,
  userId: string,
  walletAddress: string,
): Promise<void> {
  if (!config.enabled) return;
  if (!userId || !walletAddress) return;
  if (!HEX_ADDRESS.test(walletAddress)) return;

  const now = Date.now();
  for (const chain of config.chains) {
    const docId = `${userId}_${chain.chainId}`;
    const ref = db.collection(GRANTS_COLLECTION).doc(docId);

    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) {
        const data = existing.data() as { status?: string } | undefined;
        const status = data?.status;
        if (status && TERMINAL_OR_IN_FLIGHT_STATUSES.has(status)) {
          // H-5: already granted or being granted - skip silently.
          // Re-queueing would overwrite back to 'pending' and re-trip the
          // Safe drainer, double-minting the on-chain grant.
          console.info(
            '[FoundationMembership] grant already in terminal/in-flight state, skipping queue re-entry',
            { docId, status },
          );
          return;
        }
      }
      tx.set(ref, {
        user_id: userId,
        wallet_address: walletAddress,
        chain_id: chain.chainId,
        network: chain.networkName,
        contract_address: chain.contractAddress,
        status: 'pending',
        queued_at: now,
      }, { merge: true });
    });
  }
}
