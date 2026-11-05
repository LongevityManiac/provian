import { prepareLocationCopyFence } from '../jurisdiction/location-copy-erasure';
import { planComplianceRetention, prepareComplianceRetention } from '../jurisdiction/location-retention';
import { createIndexedMeterClaims } from './pending-claim-index';
import { buildMeterKeyPages, meterKeyPointer, METER_KEY_PAGES } from './meter-key-pages';
import { isPrivateFirestore } from '../provenance/private-store';
import { privateRetentionCollection } from '../provenance/private-retention';
import { applyBatchEconomicTotals, batchEconomicTotals } from './batch-economics';
import { transitDigest, transitReceipt } from './transit-receipt';
import { batchWorkSummary } from './batch-work-summary';
/**
 * PE METER — the batch commit: ONE transaction that makes a batch's acts count.
 *
 * Every act was priced and its mint-once slots taken (`meter-seal.ts`). This writes, atomically
 * with the device tip that refuses any replay of this batch:
 * - small output trust keys and cross-witness keys; outputless single-lane acts retain batch economics only;
 * - the pending claims (earnings not yet minted): one per (leg, payee, class) for the batch's
 * ordinary acts, and one per (leg, payee, class) for its takeover-capable witnesses (a
 * `window` claim, each act registrable once its own takeover window closes — );
 * - the actor's running totals: economic aggregates (incl. the beneficiary role), the
 * reputation vocabulary counters (`actor_stats_v1`), the human's delegation totals
 * ("Atlas earned X for you" — ruling item 8, replacing the per-act delegation copy), and the
 * display/accounting effects (pvt_accrual, wallet totals, network shards, streak, x402);
 * - the batch record, until settlement, anchoring and delivery complete, then for 30 days.
 * Exact packed occurrence membership is permanent; no PE body is written.
 */

import {
  ACTOR_METER_TOTALS_COLLECTION,
  actorActIncrementOf,
  actorDayIncrementOf,
  applyActorActIncrement,
  applyBeneficiaryAct,
  beneficiaryOf,
  coerceActorMeterTotals,
  stageActorDayIncrement,
  stageNetworkHourIncrement,
  type ActorActIncrement,
  type ActorDayIncrement,
} from './actor-meter-totals';
import { recordOutboundPairInTransaction } from './counterparty-pairs';
import { stageNewOriginEdges } from '../pvt/origin-reference-graph';
import type { Firestore } from 'firebase-admin/firestore';
import admin from 'firebase-admin';
import type { PEHistoryDocument } from '../../pe-history';
import {
  applyActorStatsBump,
  coerceActorStats,
  serializeActorStats,
  ACTOR_STATS_COLLECTION,
  type ActorStatsBump,
  type ActorStatsDoc,
} from '../pvt/actor-stats';
import {
  applyMeterBatchEffects,
  commitMeterBatchCounters,
  prepareMeterBatchEffects,
  readMeterBatchEffects,
} from '../pvt/durable-accrual-effects';
import { EconomicAggregateWriter } from '../pvt/policy/economic-aggregate';
import {
  CONSOLE_ROLLUP_COLLECTION,
  consoleRollupDay,
  consoleRollupDocId,
  consoleRollupShard,
} from '../pvt/disposition-rollup';
import { CROSS_WITNESS_TAKEOVER_WINDOW_MS } from '../pvt/policy/monetary-accounting';
import type { MeterActKeyDoc } from './meter-act-key';
import { actPageRef, buildActPages } from './meter-act-pages';
import { aggregateBatchClaims, aggregateWindowClaims } from './meter-claims';
import { isChainContinuityRecord, type MeterActOutcome } from './meter-seal';
import {
  HUMAN_DELEGATION_TOTALS_COLLECTION,
  METER_ACT_KEYS_COLLECTION,
  METER_BATCHES_COLLECTION,
  METER_DEVICE_TIPS_COLLECTION,
  METER_HELD_ACTS_COLLECTION,
  METER_PENDING_CLAIMS_COLLECTION,
  type MeterActDisposition,
  type MeterActReceipt,
  type MeterBatchReceipt,
  type MeterDeviceTip,
  type MeterPendingClaim,
} from './meter-store';
import { actLeafOf, batchLeafOf, type PeBatch } from './meter-wire';

/**
 * The vocabulary-counter bump one sealed act contributes to its batch (null when it carries none).
 * a chain-continuity record is continuity, not work — its bump is marked
 * so it moves the continuity facts only. Decided from the sealed row by 's own predicate.
 */
export function statsBumpOfOutcome(o: Pick<MeterActOutcome, 'side' | 'row'>): ActorStatsBump | null {
  const sealed = o.side.statsBump as unknown as ActorStatsBump | null;
  if (!sealed || !sealed.actorId) return null;
  return isChainContinuityRecord(o.row) ? { ...sealed, continuity: true } : sealed;
}

export class MeterTipConflictError extends Error {
  constructor() {
    super('meter_tip_conflict');
    this.name = 'MeterTipConflictError';
  }
}

export interface MeterBatchCommitInput {
  readonly pricingReadDb?: Firestore;
  readonly transitRecipients?: Readonly<Record<string, string>>;
  readonly batch: PeBatch;
  readonly batchHash: string;
  readonly actorId: string;
  /** The tip this batch extends (null for a device's first batch). */
  readonly expectedTip: MeterDeviceTip | null;
  /**
   * A one-act batch the relay authored itself (a webhook, a watcher, an institution event). It has
   * no device chain to protect against replay — the relay's own per-actor PE chain orders it — so
   * it neither reads nor advances a device tip. Its batch record is anchored like any other.
   */
  readonly relayAuthored?: boolean;
  readonly relaySingleLane?: boolean;
  readonly acceptedAtMs: number;
  /** One entry per act, in batch order: the outcome, or the reason it was refused before pricing. */
  readonly acts: readonly ({ readonly kind: 'priced'; readonly outcome: MeterActOutcome } | { readonly kind: 'refused'; readonly reason: string })[];
  /** Lane state that commits with the batch (e.g. the device's session-lineage registry). */
  readonly extraWrites?: readonly { readonly ref: FirebaseFirestore.DocumentReference; readonly doc: object }[];
  /**
   * Lane state that must commit atomically with the batch and depends on a read (e.g. claiming a
   * human-approval request, queueing a chain-record observation). `read` runs in the read phase;
   * it throws `MeterPreconditionChangedError` when the world moved since the act was priced.
   */
  readonly txnHooks?: readonly MeterTxnHook[];
}

export interface MeterTxnHook {
  read(txn: FirebaseFirestore.Transaction): Promise<void>;
  write(txn: FirebaseFirestore.Transaction): void;
}

/** A lane precondition changed between pricing and commit; the device re-sends the batch. */
export class MeterPreconditionChangedError extends Error {
  constructor(readonly detail: string) {
    super(`meter_precondition_changed:${detail}`);
  }
}

function dispositionOf(outcome: MeterActOutcome): { disposition: MeterActDisposition; reason: string } {
  const row = outcome.row;
  const status = String(row.mint_status ?? '');
  if (outcome.heldReason !== null) {
    // The held status, and why (e.g. `pending_review:mint_claim_unverifiable`), so a device can tell.
    const code = row.disposition_reason_code;
    return { disposition: 'held', reason: typeof code === 'string' && code !== outcome.heldReason ? `${outcome.heldReason}:${code}` : outcome.heldReason };
  }
  if (outcome.receiptReason !== undefined && status !== 'eligible') {
    return { disposition: 'record_only', reason: outcome.receiptReason };
  }
  if (status === 'eligible') return { disposition: 'eligible', reason: String(row.disposition_reason_code ?? 'policy_eligible') };
  if (status === 'corroborated_duplicate') return { disposition: 'duplicate', reason: 'mint_once_duplicate' };
  if (status === 'ineligible' || status === 'farm_capped' || status === 'x402_unverified' || status === 'skipped_no_output') {
    return { disposition: 'ineligible', reason: status };
  }
  return { disposition: 'record_only', reason: String(row.disposition_reason_code ?? status) };
}

export async function commitMeterBatch(db: Firestore, input: MeterBatchCommitInput): Promise<MeterBatchReceipt> {
  const { batch, batchHash, actorId, acceptedAtMs } = input;
  const priced = input.acts
    .map((a, index) => ({ a, index }))
    .filter((x): x is { a: { kind: 'priced'; outcome: MeterActOutcome }; index: number } => x.a.kind === 'priced');
  const outcomes = priced.map((p) => p.a.outcome);
  // A replayed outcome belongs to an act some earlier commit already counted; it adds nothing.
  const fresh = outcomes.filter((o) => o.key !== undefined);
  const retentionAddresses = new Map<string, Promise<string[]>>();
  const retentionPlans = (await Promise.all(fresh.map(o => planComplianceRetention(db, o.relayPeId, o.row, acceptedAtMs, undefined, retentionAddresses)))).flat();

  // ── Pending claims (earnings not yet minted) ────────────────────────────────
  const batchUnit = fresh.filter((o) => o.unit === 'batch');
  const claims: MeterPendingClaim[] = aggregateBatchClaims({
    batch_hash: batchHash,
    device_id: batch.device_id,
    actor_id: actorId,
    created_at_ms: acceptedAtMs,
    acts: batchUnit.map((o) => ({ relay_pe_id: o.relayPeId, legs: o.legs })),
  });
  // : the takeover-capable witnesses fold into one WINDOW claim per (leg, payee,
  // class) for the whole batch. Each act keeps its own cross-witness takeover window :
  // a higher-base witness may still take it over, so its share waits, unregistered, until ITS
  // window closes (`ready_at_ms` per act, exactly the instant its own act claim waited for).
  claims.push(...aggregateWindowClaims({
    batch_hash: batchHash,
    device_id: batch.device_id,
    actor_id: actorId,
    created_at_ms: acceptedAtMs,
    acts: fresh
      .filter((o): o is MeterActOutcome & { key: MeterActKeyDoc } => o.unit === 'window' && o.key !== undefined)
      .map((o) => ({ relay_pe_id: o.relayPeId, legs: o.legs, ready_at_ms: o.key.timestamp + CROSS_WITNESS_TAKEOVER_WINDOW_MS })),
  }));
  // A fresh act still sealed into the pre-fold `act` unit would be a seal this commit does not
  // know: fail closed rather than leave its earnings in no claim.
  const unfolded = fresh.find((o) => o.unit === 'act');
  if (unfolded !== undefined) throw new Error(`meter_commit_act_unit_unexpected:${unfolded.relayPeId}`);

  // ── Receipt ──────────────────────────────────────────────────────────────────
  const batchLeaf = batchLeafOf({
    device_id: batch.device_id, actor_id: actorId, seq: batch.seq, batch_hash: batchHash, acts_root: batch.acts_root,
  });
  const actReceipts: MeterActReceipt[] = input.acts.map((entry, index) => {
    const act = batch.acts[index];
    if (entry.kind === 'refused') {
      return {
        pe_id: act.pe_id, pe_hash: act.pe_hash, relay_pe_id: '', leaf_index: index,
        disposition: 'refused', reason: entry.reason, record_points_atomic: '0', mint_status: null,
      };
    }
    const d = dispositionOf(entry.outcome);
    return {
      pe_id: act.pe_id,
      pe_hash: act.pe_hash,
      relay_pe_id: entry.outcome.relayPeId,
      leaf_index: index,
      disposition: d.disposition,
      reason: d.reason,
      record_points_atomic: d.disposition === 'eligible' ? String(entry.outcome.row.record_points_atomic ?? '0') : '0',
      mint_status: String(entry.outcome.row.mint_status ?? '') || null,
      ...(entry.outcome.receiptNote ? { note: entry.outcome.receiptNote } : {}),
    };
  });
  let eligiblePoints = 0n;
  let eligible = 0;
  for (const r of actReceipts) {
    if (r.disposition === 'eligible') {
      eligible += 1;
      eligiblePoints += BigInt(r.record_points_atomic);
    }
  }
  const receipt: MeterBatchReceipt = {
    ...(batch.sealed?.length && input.transitRecipients ? {
      transit_receipt: transitReceipt(actorId, batch.device_id, batchHash, input.transitRecipients, batch.sealed),
      transit_recipients: input.transitRecipients,
    } : {}),
    schema: 'provian.pe-batch-receipt.v1',
    device_id: batch.device_id,
    actor_id: actorId,
    seq: batch.seq,
    batch_hash: batchHash,
    acts_root: batch.acts_root,
    batch_leaf: batchLeaf,
    accepted_at_ms: acceptedAtMs,
    acts: actReceipts,
    totals: { eligible_points_atomic: eligiblePoints.toString(), acts: actReceipts.length, eligible },
  };
  const lastPeHash = batch.acts[batch.acts.length - 1].pe_hash;
  const economicTotals = batchEconomicTotals(fresh, acceptedAtMs);
  const tip: MeterDeviceTip = {
    device_id: batch.device_id,
    actor_id: actorId,
    seq: batch.seq,
    batch_hash: batchHash,
    last_pe_hash: lastPeHash,
    accepted_at_ms: acceptedAtMs,
    receipt,
  };

  // ── Derived effects (resolved outside the transaction) ─────────────────────
  const effectsPlan = await prepareMeterBatchEffects(input.pricingReadDb ?? db, fresh.map((o) => o.side.effect).filter((e): e is NonNullable<typeof e> => e !== null), batchHash);
  const statsByActor = new Map<string, ActorStatsBump[]>();
  for (const o of fresh) {
    const bump = statsBumpOfOutcome(o);
    if (bump === null) continue;
    const list = statsByActor.get(bump.actorId) ?? [];
    list.push(bump);
    statsByActor.set(bump.actorId, list);
  }
  const delegationByHuman = new Map<string, Map<string, { acts: number; total: number; human: number }>>();
  for (const o of fresh) {
    const d = o.side.delegation;
    if (!d) continue;
    const perAgent = delegationByHuman.get(d.humanUserId) ?? new Map();
    const t = perAgent.get(d.agentUserId) ?? { acts: 0, total: 0, human: 0 };
    perAgent.set(d.agentUserId, { acts: t.acts + 1, total: t.total + d.totalPvt, human: t.human + d.humanShare });
    delegationByHuman.set(d.humanUserId, perAgent);
  }
  // The per-actor totals the user-facing reads need (`actor-meter-totals.ts`): lifetime tiers,
  // corroboration, a human's beneficiary acts by agent and chain-verified financial totals, plus
  // the day counters the participation summary reads. Once per fresh act, like every total here.
  // a chain-continuity record is not an act — it counts in no act total here
  // (attestation tiers, a human's acts by agent), exactly as it counts in no work.* fact.
  const acts = fresh.filter((o) => !isChainContinuityRecord(o.row));
  const actorIncrements = acts
    .map((o) => actorActIncrementOf(o.row, o.key?.facts ?? null, o.heldReason !== null))
    .filter((inc): inc is ActorActIncrement => inc !== null);
  const beneficiaryActs = acts
    .map((o) => beneficiaryOf(o.row))
    .filter((b): b is { humanId: string; agentId: string } => b !== null);
  const dayIncrements = new Map<string, ActorDayIncrement>();
  for (const o of fresh) {
    const inc = actorDayIncrementOf(o.row);
    if (inc === null) continue;
    const key = `${inc.actorId}\n${inc.day}`;
    const prior = dayIncrements.get(key);
    dayIncrements.set(key, prior === undefined ? inc : {
      ...prior,
      agentActions: prior.agentActions + inc.agentActions,
      corroborated: prior.corroborated + inc.corroborated,
    });
  }
  const totalsIds = [...new Set([...actorIncrements.map((i) => i.actorId), ...beneficiaryActs.map((b) => b.humanId)])];

  const rollup = new Map<string, Record<string, number>>();
  for (const o of fresh) {
    const day = consoleRollupDay(Number(o.row.timestamp));
    const counts = rollup.get(day) ?? {};
    const disposition = String(o.row.mint_disposition ?? 'record_only');
    counts[disposition] = (counts[disposition] ?? 0) + 1;
    rollup.set(day, counts);
  }

  // : the single-lane acts' rows, one page per batch (chunked only when large).
  const actPages = buildActPages({
    batchHash,
    actorId,
    deviceId: batch.device_id,
    keys: fresh.filter((o) => o.home === 'page' && o.key !== undefined && o.heldReason === null)
      .map((o) => o.key as MeterActKeyDoc),
  });

  const keyPages = isPrivateFirestore(db) ? buildMeterKeyPages(batchHash, actorId,
    fresh.filter(o => o.key && o.home !== 'page' && o.home !== 'none' && o.home !== 'batch').map(o => o.retainedKey ?? o.key!)) : [];
  const pointers = new Map(keyPages.flatMap(({ id, page }) => Object.values(page.keys).map(key => [key.relay_pe_id, meterKeyPointer(key, id)] as const)));
  const tipRef = db.collection(METER_DEVICE_TIPS_COLLECTION).doc(batch.device_id);
  let networkCountable = new Map<string, boolean>();
  let committedReceipt = receipt;
  let applied = false;
  await db.runTransaction(async (txn) => {
    applied = false;
    // ── reads ──
    if (input.relayAuthored !== true) {
      const tipSnap = await txn.get(tipRef);
      const current = tipSnap.exists ? (tipSnap.data() as MeterDeviceTip) : null;
      const expected = input.expectedTip;
      if ((current === null) !== (expected === null)
        || (current !== null && expected !== null && (current.seq !== expected.seq || current.batch_hash !== expected.batch_hash))) {
        throw new MeterTipConflictError();
      }
    }
    // 2026-10-17: a relay-authored act re-priced by the replay sweep AFTER its emitter already
    // committed it (every outcome a replay, nothing fresh) must not rewrite the batch record:
    // that reset `anchored` / `anchor` / `day`, and the next anchor then included the same batch
    // leaf under a SECOND root (the one thing meter-anchor.ts says must never happen) while the
    // device's served proof silently changed. The intake delete (txnHooks) still runs.
    const batchRef = db.collection(METER_BATCHES_COLLECTION).doc(batchHash);
    const existingBatch = input.relayAuthored === true ? await txn.get(batchRef) : null;
    const keepExistingBatchRecord = existingBatch !== null && existingBatch.exists;
    if (keepExistingBatchRecord) {
      const prior = existingBatch!.data()!;
      if (prior.actor_id !== actorId || prior.acts_root !== batch.acts_root) throw new MeterPreconditionChangedError('relay_batch_identity_changed');
      for (const hook of input.txnHooks ?? []) await hook.read(txn);
      for (const hook of input.txnHooks ?? []) hook.write(txn);
      committedReceipt = (prior.relay_receipt as MeterBatchReceipt | undefined) ?? receipt;
      return;
    }
    const allocations = [...new Set(fresh.map(o => o.ordinalCounters).filter(a => a !== undefined))];
    for (const allocation of allocations) await allocation.inspect(txn);
    const aggregateWriter = new EconomicAggregateWriter(db, txn, acceptedAtMs);
    await aggregateWriter.load(fresh.flatMap((o) => EconomicAggregateWriter.identitiesOf(o.row)));
    const statsRefs = [...statsByActor.keys()].map((id) => db.collection(ACTOR_STATS_COLLECTION).doc(id));
    const statsSnaps = await Promise.all(statsRefs.map((r) => txn.get(r)));
    const delegationRefs = [...delegationByHuman.keys()].map((id) => db.collection(HUMAN_DELEGATION_TOTALS_COLLECTION).doc(id));
    const delegationSnaps = await Promise.all(delegationRefs.map((r) => txn.get(r)));
    const effectsState = await readMeterBatchEffects(txn, effectsPlan);
    const totalsRefs = totalsIds.map((id) => db.collection(ACTOR_METER_TOTALS_COLLECTION).doc(id));
    const totalsSnaps = await Promise.all(totalsRefs.map((r) => txn.get(r)));
    for (const hook of input.txnHooks ?? []) await hook.read(txn);

    const retainLocation = await prepareComplianceRetention(db, txn, retentionPlans, acceptedAtMs);

    await prepareLocationCopyFence(db, txn, actorId, fresh.flatMap(o => [o.row, ...(o.key ? [o.key.row] : []), ...(o.retainedKey ? [o.retainedKey.row] : [])]), acceptedAtMs, false, retainLocation.actorDeadlines.get(actorId));

    // ── writes ──
    retainLocation();
    for (const allocation of allocations) allocation.commit(txn);
    for (const o of fresh) {
      if (o.key) {
        // : a single-lane act's row goes on the batch's act page (below), not in a
        // per-act key; a chain-continuity record keeps neither. A held act still keeps its
        // own held record (it waits on something).
        if (o.home !== 'page' && o.home !== 'none' && o.home !== 'batch') txn.create(privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(o.relayPeId), { ...(pointers.get(o.relayPeId) ?? o.retainedKey ?? o.key) });
        if (o.heldReason !== null) {
          // a held act never expires.
          txn.create(privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).doc(o.relayPeId), {
            relay_pe_id: o.relayPeId,
            // Top-level (the `key` copy is not indexed) so an owner's data deletion finds its
            // held acts by actor, never by scanning.
            actor_id: o.key.actor_id,
            held_reason: o.heldReason,
            key: { ...o.key, expire_at: null } as unknown as MeterActKeyDoc,
            created_at_ms: acceptedAtMs,
          });
        }
      }
    }
    for (const { id, page } of keyPages) txn.create(db.collection(METER_KEY_PAGES).doc(id), page);
    for (const page of actPages) {
      txn.create(actPageRef(db, batchHash, page.page), { ...page });
    }
    createIndexedMeterClaims(db, txn, claims.map(claim => ({ ref: db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(claim.claim_key), claim })));
    // The act's origin edges (31-day TTL) and their permanent per-pair citation counts (ruling
    // item 7). Only a fresh act — one whose key this commit creates — writes them, so each edge
    // counts exactly once however often the batch is retried.
    const freshEdges = fresh.flatMap((o) => (o.key ? (o.transient?.originEdges ?? []) : []));
    if (freshEdges.length > 0) stageNewOriginEdges(txn, db, freshEdges);
    // The per-pair "has paid" record receive authorship reads (counterparty-pairs.ts). Only a
    // fresh act counts it, so a retried batch never double-counts.
    for (const o of fresh) {
      const counterparty = o.side.outboundCounterparty;
      if (typeof counterparty === 'string' && counterparty.length > 0) {
        recordOutboundPairInTransaction(txn, db, { actorId, counterparty, atMs: acceptedAtMs });
      }
    }
    for (const o of fresh) {
      aggregateWriter.applyRow(o.row as unknown as PEHistoryDocument, 1);
      if (o.home === 'batch') aggregateWriter.detachRetainedProjection(o.row as unknown as PEHistoryDocument);
    }
    applyBatchEconomicTotals(aggregateWriter, economicTotals, 1, false);
    aggregateWriter.commit();
    statsRefs.forEach((ref, i) => {
      let doc: ActorStatsDoc = coerceActorStats(ref.id, statsSnaps[i].exists ? statsSnaps[i].data() : null);
      for (const bump of statsByActor.get(ref.id) ?? []) doc = applyActorStatsBump(doc, bump, acceptedAtMs);
      txn.set(ref, serializeActorStats(doc));
    });
    delegationRefs.forEach((ref, i) => {
      const prior = (delegationSnaps[i].exists ? delegationSnaps[i].data() : {}) as Record<string, unknown>;
      const byAgent = { ...((prior.by_agent as Record<string, Record<string, number>>) ?? {}) };
      let totalActs = Number(prior.total_acts ?? 0);
      let totalHuman = Number(prior.total_human_share_pvt ?? 0);
      for (const [agent, t] of delegationByHuman.get(ref.id) ?? new Map()) {
        const p = byAgent[agent] ?? { acts: 0, total_pvt: 0, human_share_pvt: 0 };
        byAgent[agent] = {
          acts: Number(p.acts ?? 0) + t.acts,
          total_pvt: Number(p.total_pvt ?? 0) + t.total,
          human_share_pvt: Number(p.human_share_pvt ?? 0) + t.human,
          last_at_ms: acceptedAtMs,
        };
        totalActs += t.acts;
        totalHuman += t.human;
      }
      txn.set(ref, { human_user_id: ref.id, by_agent: byAgent, total_acts: totalActs, total_human_share_pvt: totalHuman, updated_at_ms: acceptedAtMs });
    });
    totalsRefs.forEach((ref, i) => {
      let doc = coerceActorMeterTotals(ref.id, totalsSnaps[i].exists ? totalsSnaps[i].data() : null);
      for (const inc of actorIncrements) if (inc.actorId === ref.id) doc = applyActorActIncrement(doc, inc, acceptedAtMs);
      for (const b of beneficiaryActs) if (b.humanId === ref.id) doc = applyBeneficiaryAct(doc, b.agentId, acceptedAtMs);
      txn.set(ref, { ...doc });
    });
    for (const inc of dayIncrements.values()) stageActorDayIncrement(txn, db, inc);
    networkCountable = applyMeterBatchEffects(txn, effectsPlan, effectsState).networkCountable;
    // The Firestore twin of the Redis hourly network buckets (`/v1/pvt/network-stats` reads it
    // when Redis is unavailable): the same network-countable acts, by commit hour.
    stageNetworkHourIncrement(txn, db, {
      atMs: acceptedAtMs,
      shardKey: batchHash,
      count: fresh.filter((o) => o.side.effect !== null && networkCountable.get(o.side.effect.peId) === true).length,
    });
    for (const [day, counts] of rollup) {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const increments: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(counts)) increments[k] = admin.firestore.FieldValue.increment(v);
      txn.set(db.collection(CONSOLE_ROLLUP_COLLECTION).doc(consoleRollupDocId(day, consoleRollupShard(batchHash))), {
        day,
        total: admin.firestore.FieldValue.increment(total),
        counts: increments,
      }, { merge: true });
    }
    if (!keepExistingBatchRecord) txn.set(batchRef, {
      batch_hash: batchHash,
      ...(input.transitRecipients ? { transit_recipients: input.transitRecipients, transit_digest: transitDigest(batch.sealed ?? []) } : {}),
      device_id: batch.device_id,
      actor_id: actorId,
      seq: batch.seq,
      acts_root: batch.acts_root,
      batch_leaf: batchLeaf,
      // Every act's leaf in `acts_root`, in batch order (PE export): an owner who received only
      // some of this batch's PEs — a sealed copy from a linked agent, or a relay-authored PE —
      // builds each one's path to `acts_root` from these (`POST /v1/meter/batch-proofs`).
      // Hashes only; never indexed (firestore.indexes.json fieldOverrides).
      act_leaves: batch.acts.map(actLeafOf),
      act_count: batch.acts.length,
      work_summary: batchWorkSummary(fresh.filter(o => statsBumpOfOutcome(o) !== null && !isChainContinuityRecord(o.row))),
      eligible_points_atomic: eligiblePoints.toString(),
      claim_keys: claims.map((c) => c.claim_key),
      act_pages: actPages.length,
      per_batch_pricing: true,
      ...(keyPages.length ? { key_page_ids: keyPages.map(p => p.id), topup_claim_keys: [] } : {}),
      ...(input.relaySingleLane ? { relay_single_lane: true, relay_receipt: receipt } : {}),
      retained_act_ids: fresh.filter(o => o.home !== 'batch' && o.home !== 'none').map(o => o.relayPeId),
      economic_totals: economicTotals,
      economic_claim_keys: economicTotals.length ? claims.filter(c => c.unit === 'batch').map(c => c.claim_key) : [],
      economic_paid_claim_keys: [],
      economic_settled: economicTotals.length === 0,
      settlement_complete: claims.length === 0 && fresh.every(o => o.heldReason === null),
      day: new Date(acceptedAtMs).toISOString().slice(0, 10),
      accepted_at_ms: acceptedAtMs,
      anchored: false,
      anchor: null,
    });
    for (const w of input.extraWrites ?? []) txn.set(w.ref, { ...w.doc });
    for (const hook of input.txnHooks ?? []) hook.write(txn);
    if (input.relayAuthored !== true) txn.set(tipRef, { ...tip });
    applied = true;
  });

  try {
    if (applied) await commitMeterBatchCounters(fresh.map((o) => o.side.effect).filter((e): e is NonNullable<typeof e> => e !== null), networkCountable);
  } catch (error) {
    // Novelty counters committed atomically above. Redis is a display mirror; its failure cannot
    // alter the next sealed ordinal. The batch is already committed.
    console.warn('[meter] post-commit counters failed (non-blocking):', error);
  }
  void priced;
  return committedReceipt;
}
