/**
 * Agent Bank - shared wallet stats updater.
 *
 * Centralises the post-transaction increment to `agent_wallets/{id}` so the
 * USDC vs PVT routing lives in one place. Existing economic_activity_usd
 * keeps its USD-float semantics (back-compat with bond trust discount,
 * arbitrator eligibility, leaderboard). PVT activity accumulates in a
 * separate BigInt-as-string field so trust scoring isn't forced to take an
 * oracle dependency in Phase 1 (Workstream 2 - Q6).
 *
 * Phase 2 will decide which thresholds, if any, should additionally read
 * economic_activity_pvt - that's a monetary-policy decision, not a code
 * change waiting on infra.
 */

import type { AgentBankDeps } from './types';
import type { Currency } from './types';

/**
 * Atomic increment of pe_count + the currency-appropriate economic_activity
 * field. PVT activity is stored as a BigInt-as-string and incremented
 * transactionally to avoid lost updates from concurrent writes (Firestore's
 * FieldValue.increment doesn't apply to strings).
 *
 * @param deps    AgentBankDeps (Firestore + cache)
 * @param walletId  agent_wallets doc id
 * @param currency  'usdc' or 'pvt' - drives which field updates
 * @param amount    USDC: number (USD float). PVT: bigint (18-decimal wei).
 */
export async function updateWalletStats(
  deps: AgentBankDeps,
  walletId: string,
  currency: Currency,
  amount: number | bigint,
): Promise<void> {
  const { FieldValue } = await import('firebase-admin/firestore');
  const now = Date.now();

  if (currency === 'usdc') {
    if (typeof amount !== 'number') {
      throw new Error('updateWalletStats: USDC amount must be a number');
    }
    await deps.db.collection('agent_wallets').doc(walletId).update({
      pe_count: FieldValue.increment(1),
      economic_activity_usd: FieldValue.increment(amount),
      updated_at: now,
    });
    return;
  }

  // PVT path - BigInt accumulation requires a transaction since increment()
  // is number-only.
  if (typeof amount !== 'bigint') {
    throw new Error('updateWalletStats: PVT amount must be a bigint');
  }
  if (amount < 0n) {
    throw new Error('updateWalletStats: PVT amount must be non-negative');
  }
  const ref = deps.db.collection('agent_wallets').doc(walletId);
  await deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as { economic_activity_pvt?: string }).economic_activity_pvt : '0';
    const previous = existing && /^[0-9]+$/.test(existing) ? BigInt(existing) : 0n;
    tx.update(ref, {
      pe_count: FieldValue.increment(1),
      economic_activity_pvt: (previous + amount).toString(),
      updated_at: now,
    });
  });
}
