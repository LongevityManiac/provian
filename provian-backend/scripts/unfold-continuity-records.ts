/**
 * Continuity is not work — move the chain-continuity records (an idle
 * `compute_session` sealed `skipped_no_output`) that `actor_stats_v1` folded as work before the
 * ruling landed out of every work count, class, facet and share, into the continuity counters.
 * Plan and checks: `src/core/pvt/continuity-unfold.ts`. Zero mint effect: the only writes are the
 * vocabulary-counter document and the act totals (`actor_meter_totals_v1`); no sealed PE, claim, act
 * key or page is touched.
 *
 * FIRESTORE_DATABASE_ID=relay RELAY_SIGNING_KEY=… npx tsx scripts/unfold-continuity-records.ts # dry run, every actor
 * … --actor <userId> # one actor
 * … --store <actorId>=<path> (repeatable; that actor's own PE store dir or `provian export-pes` file —
 * confirms its residual days and decides a facet relay records cannot)
 * … --apply # write
 *
 * Each actor is written in ONE transaction that re-reads the stats document, the aggregate and the
 * act totals, and refuses when any of them differs at all from what the plan read (re-run). Exit code 2 when any actor was refused.
 */
import admin from 'firebase-admin';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scriptDb } from './lib/script-db';
import { privateRetentionCollection } from '../src/core/provenance/private-retention';
import {
  ACTOR_STATS_COLLECTION, coerceActorStats, deriveCompositionSignals, serializeActorStats, statsKey, utcDayKey,
  type CompositionSignals,
} from '../src/core/pvt/actor-stats';
import { normalizeWitnessClass } from '../src/core/pvt/policy/evidence-class';
import { ECONOMIC_AGGREGATE_COLLECTION } from '../src/core/pvt/policy/economic-aggregate';
import { METER_ACT_KEYS_COLLECTION, METER_BATCHES_COLLECTION, METER_HELD_ACTS_COLLECTION } from '../src/core/meter/meter-store';
import { ACTOR_METER_TOTALS_COLLECTION, coerceActorMeterTotals } from '../src/core/meter/actor-meter-totals';
import { METER_BATCH_ACTS_COLLECTION } from '../src/core/meter/meter-act-pages';
import { categorizeActionType } from '../src/pvt-accrual';
import { readComputeTokens } from '../src/core/pvt/origin-pricing-inputs';
import {
  applyContinuityUnfold, applyContinuityUnfoldToActorTotals, applyContinuityUnfoldToBeneficiaryTotals,
  continuityTotalsOf, planContinuityUnfold, CONTINUITY_ACTION_TYPE, CONTINUITY_MINT_STATUS,
  type RetainedAct, type StoreContinuityRecord,
} from '../src/core/pvt/continuity-unfold';

admin.initializeApp();

/** landed on 2026-10-07: from that UTC day on, a continuity record keeps no relay record. */
const CONTINUITY_RETENTION_CUT_LINE_DAY = '2026-10-07';

type Json = Record<string, unknown>;
const rec = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Json : null);

function aggregateContinuity(doc: Json | undefined): number {
  const n = rec(rec(rec(doc?.roles)?.contributor)?.pes_by_mint_status)?.[CONTINUITY_MINT_STATUS];
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : 0;
}

const nn = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The per-record work counters a stats bump adds besides the act count, class and facets. */
function bumpWorkCounters(bump: Json): number {
  const c = rec(bump.composition);
  const pay = typeof c?.witnessedPaymentAtomic === 'string' && /^[1-9]\d*$/.test(c.witnessedPaymentAtomic) ? 1 : 0;
  return nn(bump.witnessObservedTokens) + nn(bump.bodyDeclaredTokens) + nn(bump.independentOriginCount)
    + nn(bump.approvalsCited) + nn(c?.supervisionHumanTurns) + nn(c?.supervisionTotalTurns) + pay;
}

/** The fold buckets an act on `utcDayKey(min(timestamp, batch accepted_at_ms))`. */
function retainedOf(act: Json, compositionKnown: boolean, acceptedByBatch: ReadonlyMap<string, number>, pageDeviceId: string | null = null): RetainedAct {
  const row = rec(act.row) ?? {};
  const bump = rec(rec(act.side)?.statsBump);
  const ts = Number(act.timestamp);
  const accepted = acceptedByBatch.get(String(act.batch_hash ?? '')) ?? Number(act.created_at_ms);
  const day = utcDayKey(Number.isFinite(accepted) && accepted > 0 ? Math.min(ts, accepted) : ts);
  // The act totals key their counts the way `actorActIncrementOf` / `beneficiaryOf` read the row.
  const tier = typeof row.attestationDepth === 'string' && row.attestationDepth.length > 0 ? row.attestationDepth : null;
  const human = typeof row.beneficiary_wallet_id === 'string' && row.beneficiary_wallet_id.length > 0 ? row.beneficiary_wallet_id : null;
  return {
    relayPeId: String(act.relay_pe_id ?? row.peId ?? ''),
    bucketDay: day,
    tier,
    beneficiary: human !== null && human !== row.userId ? human : null,
    actionType: String(act.action_type ?? row.actionType ?? ''),
    mintStatus: typeof row.mint_status === 'string' ? row.mint_status : null,
    witnessClass: normalizeWitnessClass(bump?.witnessClass ?? row.witness_class),
    family: statsKey(bump?.family ?? row.category) ?? 'other',
    composition: compositionKnown && bump ? (bump.composition as CompositionSignals | null) : null,
    compositionKnown: compositionKnown && bump !== null,
    deviceId: typeof act.device_id === 'string' && act.device_id.length > 0 ? act.device_id : pageDeviceId,
    workCounters: compositionKnown && bump ? bumpWorkCounters(bump) : null,
  };
}

const jsonLines = (path: string): Json[] =>
  readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => rec(JSON.parse(l)) ?? {});

/**
 * The owner's own PEs → its continuity records' non-hardware facets. Either a device PE-store
 * directory (`pes.jsonl` + `receipts.jsonl`, or a root holding one per device) or a
 * `provian.pe-export.v1` file (`provian export-pes`, which also pulls back PE Archive days).
 */
function readStore(path: string): StoreContinuityRecord[] {
  const sources: Array<{ pes: Json[]; receipts: Json[] }> = [];
  if (path.endsWith('.jsonl') && existsSync(path)) {
    const lines = jsonLines(path);
    sources.push({
      pes: lines.filter((o) => o.type === 'pe').map((o) => rec(o.pe) ?? {}),
      receipts: lines.filter((o) => o.type === 'batch').map((o) => rec(o.receipt) ?? {}),
    });
  } else {
    const devDirs = existsSync(join(path, 'receipts.jsonl')) ? [path] : readdirSync(path).map((d) => join(path, d)).filter((d) => existsSync(join(d, 'receipts.jsonl')));
    for (const d of devDirs) {
      sources.push({
        pes: jsonLines(join(d, 'pes.jsonl')).map((e) => {
          const pe = rec(e.pe) ?? e;
          return { ...pe, pe_hash: pe.pe_hash ?? e.pe_hash };
        }),
        receipts: jsonLines(join(d, 'receipts.jsonl')),
      });
    }
  }
  const out: StoreContinuityRecord[] = [];
  for (const src of sources) {
    const pes = new Map<string, Json>();
    for (const pe of src.pes) if (typeof pe.pe_hash === 'string') pes.set(pe.pe_hash, pe);
    const seen = new Set<string>();
    for (const r of src.receipts) {
      for (const a of (r.acts as Json[] | undefined) ?? []) {
        if (a.mint_status !== CONTINUITY_MINT_STATUS || seen.has(String(a.pe_hash))) continue;
        seen.add(String(a.pe_hash));
        const pe = pes.get(String(a.pe_hash));
        if (!pe || pe.action_type !== CONTINUITY_ACTION_TYPE) continue;
        const c = deriveCompositionSignals(pe.metadata, pe.execution_env, { witnessClass: 'device_tier', sealedHardwareWitness: null });
        const origins = Array.isArray(pe.input_origins) ? pe.input_origins.length : 0;
        const pay = typeof c?.witnessedPaymentAtomic === 'string' && /^[1-9]\d*$/.test(c.witnessedPaymentAtomic) ? 1 : 0;
        out.push({
          bucketDay: utcDayKey(Math.min(Number(pe.timestamp), Number(r.accepted_at_ms ?? pe.timestamp))),
          deviceId: typeof pe.device_id === 'string' ? pe.device_id : null,
          environmentClass: c?.environmentClass ?? null,
          modelFamilies: c?.modelFamilies ?? [],
          workCounters: (readComputeTokens(pe.compute) ?? 0) + origins
            + nn(c?.supervisionHumanTurns) + nn(c?.supervisionTotalTurns) + pay,
        });
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const actorIdx = args.indexOf('--actor');
  const only = actorIdx >= 0 ? args[actorIdx + 1] ?? null : null;
  const stores = new Map<string, StoreContinuityRecord[]>();
  args.forEach((a, i) => {
    if (a !== '--store') return;
    const spec = args[i + 1] ?? '';
    const at = spec.indexOf('=');
    if (at <= 0) throw new Error(`--store needs <actorId>=<path>, got ${spec}`);
    const actor = spec.slice(0, at);
    stores.set(actor, [...(stores.get(actor) ?? []), ...readStore(spec.slice(at + 1))]);
  });

  const db = scriptDb();
  const aggs = only
    ? [await db.collection(ECONOMIC_AGGREGATE_COLLECTION).doc(only).get()]
    : (await db.collection(ECONOMIC_AGGREGATE_COLLECTION).get()).docs;
  const family = statsKey(categorizeActionType(CONTINUITY_ACTION_TYPE)) ?? 'other';
  let refused = 0;
  for (const agg of aggs) {
    const actorId = agg.id;
    const total = aggregateContinuity(agg.data());
    if (total === 0) continue;
    const statsRef = db.collection(ACTOR_STATS_COLLECTION).doc(actorId);
    const stats = coerceActorStats(actorId, (await statsRef.get()).data() ?? null);
    const keys = await privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).where('actor_id', '==', actorId).get();
    const pages = await privateRetentionCollection(db, METER_BATCH_ACTS_COLLECTION).where('actor_id', '==', actorId).get();
    const held = await privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).where('actor_id', '==', actorId).get();
    const batches = await db.collection(METER_BATCHES_COLLECTION).where('actor_id', '==', actorId).get();
    const acceptedByBatch = new Map<string, number>();
    for (const b of batches.docs) {
      const at = Number((b.data() as Json).accepted_at_ms);
      if (Number.isFinite(at)) acceptedByBatch.set(b.id, at);
    }
    const retained: RetainedAct[] = [
      ...keys.docs.map((k) => retainedOf(k.data() as Json, true, acceptedByBatch)),
      ...pages.docs.flatMap((p) => {
        const page = p.data() as Json;
        const dev = typeof page.device_id === 'string' ? page.device_id : null;
        return Object.values(rec(page.acts) ?? {}).map((a) => retainedOf(a as Json, false, acceptedByBatch, dev));
      }),
      // A held act keeps no key or page row: its own held record carries the key.
      ...held.docs.map((h) => retainedOf(rec((h.data() as Json).key) ?? {}, true, acceptedByBatch)),
    ];
    const expected = total - stats.continuity_records;
    const result = planContinuityUnfold({
      actorId, stats, expectedRecords: expected, retained, residualFromDay: CONTINUITY_RETENTION_CUT_LINE_DAY, continuityFamily: family, store: stores.get(actorId),
    });
    if (!result.ok) {
      if (result.reason !== 'nothing_to_unfold') refused += 1;
      console.log(JSON.stringify({ actor: actorId, aggregate: total, already_continuity: stats.continuity_records, refused: result.reason }));
      continue;
    }
    const { plan } = result;
    const now = Date.now();
    const next = applyContinuityUnfold(stats, plan, now);
    // The act totals the old fold also counted (actor_meter_totals_v1): the actor's tiers and each
    // linked human's acts by this agent. Subtracted from the live documents in the same transaction.
    const totalsDelta = continuityTotalsOf(plan);
    const totalsRef = db.collection(ACTOR_METER_TOTALS_COLLECTION).doc(actorId);
    const humanRefs = Object.keys(totalsDelta.beneficiary).map((h) => db.collection(ACTOR_METER_TOTALS_COLLECTION).doc(h));
    const totalsNow = coerceActorMeterTotals(actorId, (await totalsRef.get()).data() ?? null);
    applyContinuityUnfoldToActorTotals(totalsNow, plan, now); // dry-run underflow check
    for (const ref of humanRefs) {
      applyContinuityUnfoldToBeneficiaryTotals(coerceActorMeterTotals(ref.id, (await ref.get()).data() ?? null), actorId, totalsDelta.beneficiary[ref.id], now);
    }
    const summary = {
      actor: actorId, records: plan.records, retained: plan.retained, residual: plan.residual,
      pe_count: [stats.pe_count, next.pe_count],
      hardware_rooted: [
        Object.entries(stats.by_family_class).filter(([k]) => k.endsWith('__hardware_rooted')).reduce((a, [, n]) => a + n, 0),
        Object.entries(next.by_family_class).filter(([k]) => k.endsWith('__hardware_rooted')).reduce((a, [, n]) => a + n, 0),
      ],
      by_family_class: next.by_family_class, environments: next.environments, measurements: next.measurements, issuers: next.issuers,
      act_totals: { tiers_before: totalsNow.by_attestation_tier, minus: totalsDelta },
      days: plan.days, decisions: plan.decisions,
    };
    console.log(JSON.stringify(summary));
    if (!apply) continue;
    // Refuse unless every document is byte-for-byte the one the plan was computed from: any bump
    // since (even one stamped with the same accepted-at millisecond) would otherwise be overwritten.
    const planned = JSON.stringify(serializeActorStats(stats));
    const plannedTotals = JSON.stringify(totalsNow);
    const plannedHumans = await Promise.all(humanRefs.map(async (r) => JSON.stringify(coerceActorMeterTotals(r.id, (await r.get()).data() ?? null))));
    await db.runTransaction(async (txn) => {
      const [s, a, t, ...hs] = await Promise.all([
        txn.get(statsRef), txn.get(db.collection(ECONOMIC_AGGREGATE_COLLECTION).doc(actorId)), txn.get(totalsRef),
        ...humanRefs.map((r) => txn.get(r)),
      ]);
      const live = coerceActorStats(actorId, s.data() ?? null);
      const liveTotals = coerceActorMeterTotals(actorId, t.data() ?? null);
      const liveHumans = humanRefs.map((ref, i) => coerceActorMeterTotals(ref.id, hs[i].data() ?? null));
      if (JSON.stringify(serializeActorStats(live)) !== planned || aggregateContinuity(a.data()) !== total
        || JSON.stringify(liveTotals) !== plannedTotals || liveHumans.some((h, i) => JSON.stringify(h) !== plannedHumans[i])) {
        throw new Error(`moved_since_plan:${actorId}`);
      }
      txn.set(statsRef, serializeActorStats(next));
      txn.set(totalsRef, { ...applyContinuityUnfoldToActorTotals(liveTotals, plan, now) });
      humanRefs.forEach((ref, i) => {
        txn.set(ref, { ...applyContinuityUnfoldToBeneficiaryTotals(liveHumans[i], actorId, totalsDelta.beneficiary[ref.id], now) });
      });
    });
    console.log(JSON.stringify({ actor: actorId, applied: true }));
  }
  if (refused > 0) process.exitCode = 2;
}

main().catch((err) => { console.error(err); process.exit(1); });
