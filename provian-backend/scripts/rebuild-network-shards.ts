/**
 * WS4 network-shard rebuild — correct-state replication.
 *
 * The `pvt_network_stats/global/shards/*` counter fails OPEN historically: a PE
 * whose actor could not be resolved to a wallet (a doc-id-keyed PE before the
 * resolveWalletRef fallback, or a synthetic e2e/smoke id, or a test AGENT with no
 * wallets doc) counted as a real network PE. The forward `networkCountable`
 * fail-closed flip stops new leakage; this ONE-TIME rebuild corrects the
 * history. It is NOT a subtraction — the shard is an opaque append-only counter
 * not reconstructable to "minus 49". Instead each shard is REBUILT by bucketing
 * ONLY the real (non-test, resolvable) PE set, exactly as correct keying would
 * have produced.
 *
 * Countable actor = resolves to a NON-test wallet under the live rule: `wallets`
 * by user_id/agent_id FIELD, or a `wallet_`-doc-id (id-bound + human), or
 * `agent_wallets` by agent_id/doc-id. An actor resolving to nothing, or to a
 * test-platform wallet, is NOT counted (Unknown = Block + the /
 * test-exclusion discipline).
 *
 * AGGREGATE-ONLY. provenance_envelopes are only COUNTED — never read-to-modify or
 * written. No wallet doc, no PVT balance, no mint_status is touched. totalPEs is
 * exact (the real bucket count); totalEstimatedPVT is APPROXIMATE (the historical
 * per-PE estimate is not recoverable, so each shard's estimate is scaled by its
 * PE-count reduction — a non-payable display field, 0 settled PVT either way;
 * the operator accepted approximate).
 *
 * DRY-RUN by default. Pass --apply to write.
 * Usage: tsx scripts/rebuild-network-shards.ts [--apply]
 */
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

// H4 — IMPORTED, never replicated. This was a second pinned `= 10` copy
// ("Pinned replica of durable-accrual-effects.ts") that survived the raise to
// 100 and would have bucketed the real PE set with `% 10`, written ABSOLUTE
// totals to shard_0..9 only, and left shard_10..99 untouched — which
// `readNetworkCounters` still sums, so the network total would have become
// realTotal + residual. Its own verify loop would then have thrown AFTER the
// batch had already committed. A replica is not a source.
import { NETWORK_SHARD_COUNT } from '../src/core/pvt/durable-accrual-effects';
import { scriptDb } from './lib/script-db';

const shardOf = (peId: string): number =>
  Number.parseInt(crypto.createHash('sha256').update(peId).digest('hex').slice(0, 8), 16) % NETWORK_SHARD_COUNT;

type Doc = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

async function readAll(db: admin.firestore.Firestore, coll: string, fields: string[]): Promise<Doc[]> {
  const out: Doc[] = [];
  let q = db.collection(coll).select(...fields).limit(500);
  let last: admin.firestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    const snap = await (last ? q.startAfter(last).get() : q.get());
    if (snap.empty) break;
    for (const d of snap.docs) out.push({ __id: d.id, ...(d.data() as Doc) });
    if (snap.size < 500) break;
    last = snap.docs[snap.docs.length - 1];
  }
  return out;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  if (admin.apps.length === 0) admin.initializeApp({ projectId: 'provian-ai' });
  const db = scriptDb();

  console.log(`\nWS4 network-shard rebuild — ${apply ? 'APPLY (live writes)' : 'DRY RUN'}\n`);

  // ── Build the actor -> non-test-resolvable map from the wallet collections.
  const wallets = await readAll(db, 'wallets', ['user_id', 'agent_id', 'platform', 'type', 'id']);
  const agentWallets = await readAll(db, 'agent_wallets', ['agent_id', 'platform']);
  const byUserId = new Map<string, string | undefined>();   // user_id FIELD -> platform
  const byAgentId = new Map<string, string | undefined>();  // agent_id FIELD -> platform
  const byWalletDocId = new Map<string, { platform: string | undefined; type: string | undefined; id: string | undefined }>();
  const byAgentDocId = new Map<string, string | undefined>();
  for (const w of wallets) {
    const plat = str(w.platform);
    if (str(w.user_id)) byUserId.set(str(w.user_id)!, plat);
    if (str(w.agent_id)) byAgentId.set(str(w.agent_id)!, plat);
    byWalletDocId.set(str(w.__id)!, { platform: plat, type: str(w.type), id: str(w.id) });
  }
  for (const a of agentWallets) {
    const plat = str(a.platform);
    if (str(a.agent_id)) byAgentId.set(str(a.agent_id)!, plat);
    byAgentDocId.set(str(a.__id)!, plat);
  }

  // Countable iff the actor resolves to a NON-test wallet (mirrors the live
  // networkCountable resolution across both wallet spaces).
  const resolvePlatform = (actor: string): string | undefined | null => {
    if (byUserId.has(actor)) return byUserId.get(actor);
    if (byAgentId.has(actor)) return byAgentId.get(actor);
    if (actor.startsWith('wallet_')) {
      const w = byWalletDocId.get(actor);
      if (w && w.id === actor && w.type === 'human') return w.platform;
      if (byAgentDocId.has(actor)) return byAgentDocId.get(actor);
    }
    return null; // unresolvable
  };
  const isCountable = (actor: string | undefined): boolean => {
    if (!actor) return false;
    const plat = resolvePlatform(actor);
    return plat !== null && plat !== 'test';
  };

  // ── Bucket the REAL PE set by shard.
  const pes = await readAll(db, 'provenance_envelopes', ['user_id', 'action_type']);
  const newCount = new Array(NETWORK_SHARD_COUNT).fill(0);
  let totalReal = 0;
  const realActors = new Set<string>();
  for (const pe of pes) {
    const actor = str(pe.user_id);
    if (!isCountable(actor)) continue;
    newCount[shardOf(str(pe.__id)!)] += 1;
    totalReal += 1;
    realActors.add(actor!);
  }
  console.log(`  provenance_envelopes scanned: ${pes.length}`);
  console.log(`  REAL (non-test, resolvable) PEs: ${totalReal}  from ${realActors.size} actor(s): ${[...realActors].join(', ')}`);

  // ── Read the current shards.
  const shardCol = db.collection('pvt_network_stats').doc('global').collection('shards');
  const shardSnaps = await shardCol.get();
  const oldShard = new Map<number, { totalPEs: number; totalEstimatedPVT: number }>();
  for (const d of shardSnaps.docs) {
    const m = d.id.match(/^shard_(\d+)$/);
    if (!m) continue;
    const data = d.data() as Doc;
    oldShard.set(Number(m[1]), { totalPEs: num(data.totalPEs), totalEstimatedPVT: num(data.totalEstimatedPVT) });
  }

  // ── Per-shard plan.
  let oldTotalPEs = 0; let oldTotalEst = 0; let newTotalEst = 0;
  console.log('\n  shard | totalPEs old->new | totalEstimatedPVT old->new (approx)');
  console.log('  ' + '-'.repeat(64));
  const plan: Array<{ shard: number; newPEs: number; newEst: number }> = [];
  for (let s = 0; s < NETWORK_SHARD_COUNT; s += 1) {
    const old = oldShard.get(s) ?? { totalPEs: 0, totalEstimatedPVT: 0 };
    const newPEs = newCount[s];
    const newEst = old.totalPEs > 0 ? old.totalEstimatedPVT * (newPEs / old.totalPEs) : 0;
    oldTotalPEs += old.totalPEs; oldTotalEst += old.totalEstimatedPVT; newTotalEst += newEst;
    plan.push({ shard: s, newPEs, newEst });
    console.log(`   ${String(s).padStart(5)}  |  ${String(old.totalPEs).padStart(7)} -> ${String(newPEs).padEnd(7)}  |  ${old.totalEstimatedPVT.toFixed(2).padStart(9)} -> ${newEst.toFixed(2)}`);
  }
  console.log('  ' + '-'.repeat(64));
  console.log(`  TOTAL | ${oldTotalPEs} -> ${totalReal}  |  ${oldTotalEst.toFixed(2)} -> ${newTotalEst.toFixed(2)} (approx)`);
  console.log(`  (network PE total corrects from ${oldTotalPEs} to the real footprint ${totalReal})`);

  if (!apply) {
    console.log('\nDRY RUN only. Review the per-shard plan above, then re-run with --apply.\n');
    return;
  }

  // ── APPLY: rebuild each shard (merge so any non-counter fields survive).
  const batch = db.batch();
  for (const p of plan) {
    batch.set(shardCol.doc(`shard_${p.shard}`), { totalPEs: p.newPEs, totalEstimatedPVT: p.newEst }, { merge: true });
  }
  await batch.commit();

  // ── Verify each rebuilt shard against its real-PE bucket count.
  const after = await shardCol.get();
  let ok = true; let verifiedTotal = 0;
  for (const d of after.docs) {
    const m = d.id.match(/^shard_(\d+)$/); if (!m) continue;
    const s = Number(m[1]); const got = num((d.data() as Doc).totalPEs);
    verifiedTotal += got;
    if (got !== newCount[s]) { ok = false; console.log(`   ✗ shard_${s}: totalPEs ${got} != real bucket ${newCount[s]}`); }
  }
  console.log('\n  VERIFICATION:');
  console.log(`   ${ok ? '✓' : '✗'} every shard.totalPEs == its real-PE bucket count`);
  console.log(`   ${verifiedTotal === totalReal ? '✓' : '✗'} shard total ${verifiedTotal} == real PE count ${totalReal}`);
  if (!ok || verifiedTotal !== totalReal) throw new Error('VERIFICATION FAILED');
  console.log('\nDone. Network shards rebuilt to the real footprint and verified.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
