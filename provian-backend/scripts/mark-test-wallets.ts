/**
 * mark-test-wallets — consign every non-allowlisted wallet to test status.
 *
 * the invariant: public network statistics count
 * REAL wallets only; at ruling time the real set is exactly ONE human wallet
 * (the DEFAULT_REAL_WALLETS constant). This script sets `platform: 'test'`
 * on every other `wallets` doc — the same marker convention the seven
 * agent_wallets economic surfaces already filter via isTestPlatformWallet().
 *
 * WHAT THIS DOES NOT DO: it deletes nothing, touches no PE, no pe_history,
 * no accrual, no chain state. It is a statistics marker. It is also
 * REVERSIBLE: re-running with a wallet added to --real un-marks it, and
 * --sync-agent-wallets stashes the original agent_wallets platform label in
 * `pre_test_platform` (Atlas's label is 'atlas' never blindly overwritten).
 *
 * Deliberate side effect to know about: agent_wallets marked test are also
 * excluded from Genesis reservation/settlement by the state machine — for
 * consigned test wallets that is CORRECT (their backlog is test data).
 * A future fresh Atlas signup is a NEW agent_id and is unaffected.
 *
 * DRY-RUNS by default; writes only with --apply.
 *
 * Usage:
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/mark-test-wallets.ts # dry run, default allowlist
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/mark-test-wallets.ts --real=0x…,wallet_… # dry run, explicit allowlist
 * … --sync-agent-wallets --apply # LIVE
 */

import admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { parseAllowlistArgs, resolveAllowlist } from './lib/real-wallet-allowlist';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

const BATCH_LIMIT = 400;

async function main(): Promise<void> {
  const { entries, apply, syncAgentWallets } = parseAllowlistArgs(process.argv);
  console.log(`Allowlist entries: ${entries.join(', ')}`);
  console.log(`Mode: ${apply ? 'APPLY (live writes)' : 'DRY RUN'}\n`);

  const { realWalletIds, allWallets } = await resolveAllowlist(db, entries);

  type Action = 'mark_test' | 'unmark_real' | 'already_marked' | 'real_unchanged';
  const plan: Array<{ id: string; action: Action; row: (typeof allWallets)[number] }> = [];

  for (const w of allWallets) {
    const isReal = realWalletIds.has(w.id);
    const isMarked = w.data.platform === 'test';
    let action: Action;
    if (isReal && isMarked) action = 'unmark_real';
    else if (isReal) action = 'real_unchanged';
    else if (isMarked) action = 'already_marked';
    else action = 'mark_test';
    plan.push({ id: w.id, action, row: w });
  }

  console.log('doc id                                   | type   | address                                    | pe_count | platform | action');
  console.log('-'.repeat(140));
  for (const p of plan) {
    const d = p.row.data;
    console.log(
      `${p.id.padEnd(40)} | ${String(d.type ?? '?').padEnd(6)} | ${String(d.address ?? '').padEnd(42)} | ${String(d.pe_count ?? 0).padStart(8)} | ${String(d.platform ?? '-').padEnd(8)} | ${p.action}`,
    );
  }

  const counts = plan.reduce<Record<Action, number>>((acc, p) => {
    acc[p.action] = (acc[p.action] ?? 0) + 1;
    return acc;
  }, { mark_test: 0, unmark_real: 0, already_marked: 0, real_unchanged: 0 });
  console.log(`\nSummary: mark_test=${counts.mark_test} unmark_real=${counts.unmark_real} already_marked=${counts.already_marked} real_unchanged=${counts.real_unchanged}`);

  // Sanity: the allowlist must leave at least one real wallet standing.
  const realCount = counts.unmark_real + counts.real_unchanged;
  if (realCount === 0) {
    throw new Error('Plan leaves ZERO real wallets — aborting.');
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to execute.');
    return;
  }

  // wallets writes, batched
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops > 0) { await batch.commit(); batch = db.batch(); ops = 0; } };
  for (const p of plan) {
    if (p.action === 'mark_test') {
      batch.set(db.collection('wallets').doc(p.id), { platform: 'test' }, { merge: true });
      ops++;
    } else if (p.action === 'unmark_real') {
      batch.update(db.collection('wallets').doc(p.id), { platform: FieldValue.delete() });
      ops++;
    }
    if (ops >= BATCH_LIMIT) await flush();
  }
  await flush();
  console.log('wallets writes committed.');

  if (syncAgentWallets) {
    console.log(
      '\n--sync-agent-wallets: mirroring the marker into agent_wallets. NOTE: this'
      + '\nimmediately affects the already-filtered surfaces (agent leaderboard ~5min'
      + '\ncache, commons feed, milestones, watchers) AND excludes these wallets from'
      + '\nGenesis reservation/settlement — correct for consigned test data.',
    );
    let synced = 0;
    for (const p of plan) {
      if (p.row.data.type !== 'agent') continue;
      const isReal = realWalletIds.has(p.id);
      if (isReal) continue;
      const ref = db.collection('agent_wallets').doc(p.id);
      const snap = await ref.get();
      if (!snap.exists) continue;
      const current = snap.data()?.platform;
      if (current === 'test') continue;
      await ref.set(
        { pre_test_platform: current ?? null, platform: 'test' },
        { merge: true },
      );
      synced++;
    }
    console.log(`agent_wallets synced: ${synced} (original labels stashed in pre_test_platform).`);
  }

  console.log('\nDone. Re-run without --apply to verify the plan is now all already_marked/real_unchanged.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
