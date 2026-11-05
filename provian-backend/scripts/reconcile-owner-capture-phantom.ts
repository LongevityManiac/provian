/**
 * WS4 reconciliation — owner-capture phantom accrual.
 *
 * GitHub owner-capture webhook PEs were mis-keyed to the wallet DOC id (e.g.
 * `wallet_327eec36…`) instead of the wallet's `user_id` FIELD. `resolveWalletRef`
 * looks wallets up by the user_id/agent_id FIELD, so a doc-id-keyed PE:
 * - landed its accrual in a PHANTOM `pvt_accrual/<walletDocId>` doc, and
 * - never incremented the real `wallets/<walletDocId>.pe_count`.
 * The code fix (createOwnerCaptureMapping + resolveWalletRef, this branch) closes
 * it going forward. This ONE-TIME migration reconciles the already-sealed rows to
 * exactly the state correct keying would have produced.
 *
 * AGGREGATE-ONLY. It never reads-to-modify or writes a sealed PE (provenance_
 * envelopes / pe_history are only COUNTED). No mint_status flip, no re-pricing, no
 * settled-PVT movement — the reconciled PEs are record_only (0 PVT). the operator’s
 * ruling : correct-state replication.
 *
 * Writes (all derived from Firestore, nothing assumed):
 * 1. wallets/<walletDocId>.pe_count += <phantomCount> (pvt_earned UNCHANGED)
 * 2. merge phantom pvt_accrual/<walletDocId> INTO canonical pvt_accrual/<userId>
 * (totalPEs, pesByCategory, weeklyPEs [same-week only], totalEstimatedPVT,
 * estimatedPVTByCategory, lastPETimestamp)
 * 3. heal the owner-capture mapping doc(s) (agent_id -> userId, agent_address -> address)
 * 4. delete the phantom pvt_accrual/<walletDocId>
 *
 * DRY-RUN by default. Pass --apply to write. Fail-closed guards throughout:
 * - subject wallet must exist, be type 'human', and NOT platform 'test'
 * - the canonical accrual doc must already exist (we merge into it)
 * - the phantom's totalPEs MUST equal the live count of provenance_envelopes
 * keyed to the walletDocId (derived from the id-space, not assumed) — else STOP
 *
 * Usage:
 * tsx scripts/reconcile-owner-capture-phantom.ts [walletDocId] [--apply]
 */
import * as admin from 'firebase-admin';
import { scriptDb } from './lib/script-db';

const DEFAULT_WALLET_DOC_ID = 'wallet_327eec36-ef8b-4e98-8701-a4d1b98ab8a9';

type Doc = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function mergeCounts(target: Doc, source: Doc): Doc {
  const out: Doc = { ...target };
  for (const [k, v] of Object.entries(source)) out[k] = num(out[k]) + num(v);
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const walletDocId = args.find((a) => !a.startsWith('--')) ?? DEFAULT_WALLET_DOC_ID;

  if (admin.apps.length === 0) admin.initializeApp({ projectId: 'provian-ai' });
  const db = scriptDb();

  console.log(`\nWS4 owner-capture phantom reconciliation — ${apply ? 'APPLY (live writes)' : 'DRY RUN'}`);
  console.log(`subject wallet doc: ${walletDocId}\n`);

  // ── Read + guard the subject wallet.
  const walletSnap = await db.collection('wallets').doc(walletDocId).get();
  if (!walletSnap.exists) throw new Error(`STOP: wallets/${walletDocId} does not exist`);
  const wallet = walletSnap.data() as Doc;
  if (wallet.type !== 'human') throw new Error(`STOP: wallet type is '${wallet.type ?? 'undefined'}', not 'human'`);
  if (wallet.platform === 'test') throw new Error(`STOP: wallet is platform:'test' — test wallets are excluded from reconciliation`);
  const userId = str(wallet.user_id);
  const address = str(wallet.address);
  if (!userId) throw new Error('STOP: wallet has no user_id field');
  const peCountBefore = num(wallet.pe_count);
  const pvtEarnedBefore = num(wallet.pvt_earned);
  console.log(`  wallet: type=human user_id=${userId} address=${address ?? '(none)'} pe_count=${peCountBefore} pvt_earned=${pvtEarnedBefore}`);

  // ── Read + guard the phantom accrual.
  const phantomRef = db.collection('pvt_accrual').doc(walletDocId);
  const phantomSnap = await phantomRef.get();
  if (!phantomSnap.exists) throw new Error(`STOP: no phantom pvt_accrual/${walletDocId}`);
  const phantom = phantomSnap.data() as Doc;
  const phantomTotalPEs = num(phantom.totalPEs);

  // ── Derive the COMPLETE selection set from the id-space (the operator: query, not assume).
  const peSnap = await db.collection('provenance_envelopes').where('user_id', '==', walletDocId).get();
  const selection = peSnap.docs;
  const liveCount = selection.length;
  const byActionType = new Map<string, number>();
  for (const d of selection) {
    const at = str((d.data() as Doc).action_type) ?? '(none)';
    byActionType.set(at, (byActionType.get(at) ?? 0) + 1);
  }
  console.log(`\n  SELECTION SET — provenance_envelopes.user_id == ${walletDocId}: ${liveCount} PE(s)`);
  for (const [at, n] of [...byActionType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(4)}  ${at}`);
  }
  console.log(`  phantom pvt_accrual.totalPEs = ${phantomTotalPEs}`);
  if (liveCount !== phantomTotalPEs) {
    throw new Error(`STOP: live PE count ${liveCount} != phantom totalPEs ${phantomTotalPEs} — do not guess`);
  }

  // ── Read + guard the canonical accrual.
  const canonicalRef = db.collection('pvt_accrual').doc(userId);
  const canonicalSnap = await canonicalRef.get();
  if (!canonicalSnap.exists) throw new Error(`STOP: canonical pvt_accrual/${userId} does not exist (nothing to merge into)`);
  const canonical = canonicalSnap.data() as Doc;

  // ── Find the owner-capture mapping doc(s) to heal.
  const mapSnap = await db.collection('agent_author_mappings')
    .where('source_owner_wallet_id', '==', walletDocId).get();
  const toHeal = mapSnap.docs.filter((d) => {
    const m = d.data() as Doc;
    return m.verified_by === 'repo_owner_capture'
      && (m.agent_id !== userId || m.agent_address !== (address ?? ''));
  });

  // ── Compute the merged canonical (correct-state replication).
  const sameWeek = num(phantom.weekStart) === num(canonical.weekStart);
  const mergedCanonical: Doc = {
    ...canonical,
    totalPEs: num(canonical.totalPEs) + phantomTotalPEs,
    pesByCategory: mergeCounts((canonical.pesByCategory as Doc) ?? {}, (phantom.pesByCategory as Doc) ?? {}),
    totalEstimatedPVT: num(canonical.totalEstimatedPVT) + num(phantom.totalEstimatedPVT),
    estimatedPVTByCategory: mergeCounts((canonical.estimatedPVTByCategory as Doc) ?? {}, (phantom.estimatedPVTByCategory as Doc) ?? {}),
    lastPETimestamp: Math.max(num(canonical.lastPETimestamp), num(phantom.lastPETimestamp)),
    // Same-week only: the phantom's weeklyPEs belong to its own week bucket; adding
    // a stale-week count would corrupt the current-week ranking.
    weeklyPEs: sameWeek ? num(canonical.weeklyPEs) + num(phantom.weeklyPEs) : num(canonical.weeklyPEs),
  };

  // ── Show the exact plan.
  console.log('\n  PLANNED WRITES (aggregate-only, no sealed PE touched):');
  console.log(`   1. wallets/${walletDocId}.pe_count: ${peCountBefore} -> ${peCountBefore + phantomTotalPEs}   (pvt_earned stays ${pvtEarnedBefore})`);
  console.log(`   2. merge phantom -> canonical pvt_accrual/${userId}:`);
  console.log(`        totalPEs           ${num(canonical.totalPEs)} -> ${num(mergedCanonical.totalPEs)}`);
  console.log(`        pesByCategory      ${JSON.stringify(canonical.pesByCategory ?? {})} -> ${JSON.stringify(mergedCanonical.pesByCategory)}`);
  console.log(`        totalEstimatedPVT  ${num(canonical.totalEstimatedPVT)} -> ${num(mergedCanonical.totalEstimatedPVT)}   (relocated estimate; still 0 settled PVT)`);
  console.log(`        weeklyPEs          ${num(canonical.weeklyPEs)} -> ${num(mergedCanonical.weeklyPEs)}   (same-week=${sameWeek}; phantom weeklyPEs=${num(phantom.weeklyPEs)})`);
  console.log(`   3. heal ${toHeal.length} owner-capture mapping doc(s): agent_id -> ${userId}, agent_address -> ${address ?? '(empty)'}`);
  for (const d of toHeal) {
    const m = d.data() as Doc;
    console.log(`   ${d.id}: agent_id ${m.agent_id} -> ${userId} ; agent_address '${m.agent_address}' -> '${address ?? ''}'`);
  }
  console.log(`   4. delete phantom pvt_accrual/${walletDocId}`);

  if (!apply) {
    console.log('\nDRY RUN only. Review the plan above, then re-run with --apply.\n');
    return;
  }

  // ── APPLY, atomically.
  await db.runTransaction(async (txn) => {
    // Re-read pe_count inside the txn so a concurrent increment is not clobbered.
    const wSnap = await txn.get(db.collection('wallets').doc(walletDocId));
    const liveCount2 = num((wSnap.data() as Doc).pe_count);
    txn.update(db.collection('wallets').doc(walletDocId), { pe_count: liveCount2 + phantomTotalPEs });
    txn.set(canonicalRef, mergedCanonical);
    for (const d of toHeal) txn.update(d.ref, { agent_id: userId, agent_address: address ?? '' });
    txn.delete(phantomRef);
  });

  // ── Post-migration verification (the operator’s conditions).
  const wAfter = (await walletSnap.ref.get()).data() as Doc;
  const cAfter = (await canonicalRef.get()).data() as Doc;
  const pAfter = await phantomRef.get();
  const peCountAfter = num(wAfter.pe_count);
  const pvtEarnedAfter = num(wAfter.pvt_earned);
  const okPhantom = !pAfter.exists;
  const okPeCount = peCountAfter - peCountBefore === phantomTotalPEs;
  const okPvt = pvtEarnedAfter === pvtEarnedBefore;
  const okCanonical = num(cAfter.totalPEs) === num(canonical.totalPEs) + phantomTotalPEs;
  console.log('\n  VERIFICATION:');
  console.log(`   ${okPhantom ? '✓' : '✗'} phantom doc deleted (empty)`);
  console.log(`   ${okPeCount ? '✓' : '✗'} pe_count moved by exactly ${phantomTotalPEs} (${peCountBefore} -> ${peCountAfter})`);
  console.log(`   ${okPvt ? '✓' : '✗'} wallet pvt_earned UNCHANGED (${pvtEarnedBefore} -> ${pvtEarnedAfter}) — no settled PVT moved`);
  console.log(`   ${okCanonical ? '✓' : '✗'} canonical totalPEs += ${phantomTotalPEs}`);
  if (!okPhantom || !okPeCount || !okPvt || !okCanonical) {
    throw new Error('VERIFICATION FAILED — inspect above');
  }
  console.log('\nDone. Reconciliation applied and verified.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
