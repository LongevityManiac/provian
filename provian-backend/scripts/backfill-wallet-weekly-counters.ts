/**
 * backfill-wallet-weekly-counters — seed the weekly leaderboard counters on
 * `wallets` from `pvt_accrual` for the CURRENT week (H2 close-out).
 *
 * The weekly board now ranks `wallets.weekly_pe_count` (guarded by
 * `weekly_week_start`), maintained by the durable-accrual effects on every PE
 * from the deploy onward. Wallets that accrued THIS week before the deploy
 * carry no counter yet and would rank 0 until their next PE; this script
 * copies the current week's `pvt_accrual.weeklyPEs` onto the wallet, summing
 * the id-space duality (an accrual doc under the wallet's user_id AND one
 * under its agent_id) exactly as the retired in-memory join did.
 *
 * Only the current week matters — a stale week never matches the board's
 * equality clause — so accrual docs whose `weekStart` is not this week are
 * skipped, and the script is a no-op once the week rolls. Idempotent: it
 * writes absolute values for the current week, and a live increment that
 * lands mid-run is at most one PE under-counted until that wallet's next PE
 * (the effects write `prior + 1` from the wallet's own field).
 *
 * CUTOVER ORDER: deploy the code, deploy the additive composite index on
 * `wallets` (weekly_week_start ASC, weekly_pe_count DESC), run this once.
 *
 * DRY-RUNS by default; writes only with --apply.
 *
 * Usage:
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-wallet-weekly-counters.ts # dry run
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-wallet-weekly-counters.ts --apply # LIVE
 */

import admin from 'firebase-admin';
import { getWeekStart } from '../src/core/pvt/week-start';
import {
  WALLET_WEEKLY_PE_COUNT_FIELD,
  WALLET_WEEKLY_WEEK_START_FIELD,
} from '../src/core/pvt/wallet-ranking-fields';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

async function resolveWalletId(userId: string): Promise<string | null> {
  for (const field of ['user_id', 'agent_id'] as const) {
    const snap = await db.collection('wallets').where(field, '==', userId).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
  }
  return null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const weekStart = getWeekStart(Date.now());
  console.log(`Mode: ${apply ? 'APPLY (live writes)' : 'DRY RUN'}; week start ${new Date(weekStart).toISOString()}\n`);

  const accruals = await db.collection('pvt_accrual').where('weekStart', '==', weekStart).get();
  const perWallet = new Map<string, number>();
  let unresolved = 0;
  for (const doc of accruals.docs) {
    const weekly = doc.data().weeklyPEs;
    if (typeof weekly !== 'number' || !Number.isFinite(weekly) || weekly <= 0) continue;
    const walletId = await resolveWalletId(doc.id);
    if (walletId === null) {
      unresolved += 1;
      console.log(`  (no wallets doc for accrual ${doc.id}; skipped)`);
      continue;
    }
    perWallet.set(walletId, (perWallet.get(walletId) ?? 0) + weekly);
  }

  console.log(`Accrual docs this week: ${accruals.size}; wallets to seed: ${perWallet.size}; unresolved: ${unresolved}`);
  for (const [walletId, count] of perWallet) console.log(`  ${walletId}: ${count}`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write.');
    return;
  }

  let batch = db.batch();
  let ops = 0;
  for (const [walletId, count] of perWallet) {
    batch.set(db.collection('wallets').doc(walletId), {
      [WALLET_WEEKLY_PE_COUNT_FIELD]: count,
      [WALLET_WEEKLY_WEEK_START_FIELD]: weekStart,
    }, { merge: true });
    ops += 1;
    if (ops === 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
