import { isAbsentBatchClaim } from '../pvt/mint-once-claim';
import { crossWitnessOccurrenceDigest } from './batch-occurrences';
import { privateRetentionCollection } from '../provenance/private-retention';
/** Price one act inside its verified batch. Single-lane work uses the batch's exact
 * actor-wide occurrence membership and counters. Only output trust and two-lane witnesses
 * retain per-act keys; the owner retains the PE. Totals, claims and device tip commit once
 * per batch. Cross-witness takeover coordinates pending claims transactionally.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { buildPEHistoryRow, type PEHistoryDocument, type WritePEHistoryParams } from '../../pe-history';
import {
  applyMintOnceClaimDecision,
  inspectPreparedMintOnceClaimInTransaction,
  type MintOnceClaimTransactionDecision,
} from '../pvt/mint-once-claim';
import {
  applyCommitTakeoverDecision,
  demotedIncumbentRow,
  inspectPreparedCommitTakeoverInTransaction,
  type CommitTakeoverDecision,
} from '../pvt/commit-takeover';
import {
  applyCompletionTakeoverDecision,
  demotedCompletionIncumbentRow,
  inspectPreparedCompletionTakeoverInTransaction,
  type CompletionTakeoverDecision,
} from '../pvt/completion-takeover';
import { EconomicAggregateWriter } from '../pvt/policy/economic-aggregate';
import { isContinuityStatsRow } from '../pvt/actor-stats';
import {
  finalizePendingPolicyObservation,
  upsertPendingPolicyObservationInTransaction,
  type PendingPolicyObservationResult,
} from '../pvt/policy/pending-policy-queue';
import { resolvePayee } from '../pvt/wp4/claim-inlet-source';
import type { DurableAccrualPayload } from '../pvt/durable-accrual-effects';
import type { InputOrigin } from '../provenance/input-origins';
import type { OriginEdge } from '../pvt/origin-reference-graph';
import type { BatchOriginEdges } from '../pvt/origin-pricing-inputs';
import type { BatchPricingCounters } from './batch-pricing-counters';
import type { BatchOccurrences } from './batch-occurrences';
import type { SettlementDb } from '../pvt/wp4/durable-settlement-store';
import { MintOnceClaimRaceError } from '../pvt/mint-once-claim';
import { actClaimsUncommitted, actTopupsUncommitted, resolveActBaseClaims, resolveActTopupClaims } from './act-claims';
import { withoutAct, type MeterActLeg } from './meter-claims';
import { prepareDemotedMeterRetention } from './retire-demoted-meter-keys';
import { slimActRow, outputTrustKey, type MeterActFacts, type MeterActKeyDoc } from './meter-act-key';
import {
  expireAt,
  METER_ACT_KEYS_COLLECTION,
  METER_KEY_LIFETIME_MS,
  type MeterPendingClaim,
} from './meter-store';

/** Mint statuses that wait for something and are kept as held acts. */
const HELD_STATUSES = new Set([
  'pending_evidence',
  'pending_review',
  'pending_cache',
  'pending_compliance',
  'beneficiary_pending',
  'deferred',
]);

/** The batch an act is being metered in. */
export interface MeterActBatchContext {
  readonly batchHash: string;
  readonly deviceId: string;
  /** The device's own pe_id for this act. */
  readonly clientPeId: string;
  /** The act's pe_hash (covers the complete PE on the device). */
  readonly peHash: string;
  readonly prevHash: string;
  /** Occurrence time the 30-day key lifetime runs from (act timestamp, or a verified chain/forge time). */
  readonly occurrenceAtMs: number;
  /** Payee resolution reads (memoized per batch). */
  readonly payeeDb: SettlementDb;
  /**
   * The batch's pricing reads: the invariant registry is read once per batch
   * (`batchPricingReadDb`); every other read, and every transaction, is live.
   */
  readonly readDb?: Firestore;
  /** Receives the act's outcome. */
  readonly sink: (outcome: MeterActOutcome) => void;
  /** The act's identifier facts, kept on its key for later verifiers. */
  readonly facts?: MeterActFacts;
  /**
   * True when the batch was proven new against the device tip (`ingestMeterBatch`): an act key is
   * written only by the commit that advances that tip, and an act's id derives from its pe_hash,
   * which the device chain makes unique, so none of the batch's acts can have a key yet and the
   * replay probe is skipped. The commit's `create` of each key (with the tip check in the same
   * transaction) stays the guard. Relay-only single-lane batches instead prove novelty
   * through their batch record and permanent packed occurrence membership.
   */
  readonly freshBatch?: boolean;
  /**
   * The origin edges this batch's acts have staged (written by the batch commit). Shared by every
   * act of one batch so a later act's closed-loop walk sees an earlier act's edges.
   */
  readonly batchEdges?: BatchOriginEdges;
  /**
   * : this act's type is witnessed by ONE lane only
   * (`act-witness-lanes.ts`) and it arrived on a lane that opts in (device, phone or relay batches).
   * Its occurrence is packed into the actor-wide replay set. Outputless acts retain only batch economics; output-bearing acts keep a small trust key.
   */
  readonly singleLane?: boolean;
  /** The batch's in-memory first-sighting set for single-lane novelty / occurrence checks. */
  readonly batchSightings?: Set<string>;
  /** Earlier fresh acts' Redis increments, staged until the batch commits. */
  readonly pricingCounters?: BatchPricingCounters;
  readonly occurrences?: BatchOccurrences;
}

/** Per-act outputs the batch commit writes that are never stored on the act key. */
export interface MeterActTransient {
  /** The act's origin edges (written with their per-pair counts when the key is created). */
  readonly originEdges: readonly OriginEdge[] | null;
}

/** Per-act inputs the batch commit needs that are not on the row (stats, delegation, lineage). */
export interface MeterActSideInputs {
  readonly statsBump: Record<string, unknown> | null;
  readonly delegation: {
    readonly humanUserId: string;
    readonly agentUserId: string;
    readonly agentShareBps: number;
    readonly totalPvt: number;
    readonly humanShare: number;
  } | null;
  readonly corroborateIncumbentPeId: string | null;
  /** Always false since 2026-10-04: the relay keeps no per-output digest index. */
  readonly outputDigestsIndexed: boolean;
  /**
   * The act's derived display/accounting effects, folded once per batch. Null only on an act key
   * migrated from a pre-meter row, whose effects were applied when it was sealed (it never joins
   * a batch commit).
   */
  readonly effect: DurableAccrualPayload | null;
  /**
   * A commit-bearing act's input origins (identifiers and hashes, never content), so a second
   * witness of the same commit inside the 30-day window can union them (`findCommitOriginsBySha`).
   * Null on every other act.
   */
  readonly commitOrigins?: readonly InputOrigin[] | null;
  /** An outbound act's counterparty (lowercase), recorded as a per-pair relationship. */
  readonly outboundCounterparty?: string | null;
}

export interface MeterActOutcome {
  /** Transient counter allocation, committed with the seal; never retained on the act. */
  readonly ordinalCounters?: BatchPricingCounters;
  readonly relayPeId: string;
  readonly replay: boolean;
  readonly row: Record<string, unknown>;
  readonly legs: readonly MeterActLeg[];
  readonly unit: 'batch' | 'act' | 'window' | 'none';
  readonly heldReason: string | null;
  readonly side: MeterActSideInputs;
  /** The act key the batch commit writes (absent on a replay: it is already written). */
  readonly key?: MeterActKeyDoc;
  /** Minimal output-trust representation; the full pricing outcome exists only in memory. */
  readonly retainedKey?: MeterActKeyDoc;
  /** A receipt reason that names a meter rule (e.g. older than 30 days) over the policy code. */
  readonly receiptReason?: string;
  /** Something the device should act on even though the act priced (e.g. a lineage resync). */
  readonly receiptNote?: string;
  /** Fresh acts only: what the batch commit writes beside the key (never stored on it). */
  readonly transient?: MeterActTransient;
  /**
   * Retention home: a trust or cross-witness key (`key`), legacy page (`page`), compact batch economics (`batch`), or no act state for chain continuity (`none`).
   */
  readonly home?: 'key' | 'page' | 'none' | 'batch';
}

/**
 * the standing rule : a `compute_session` sealed `skipped_no_output` is a
 * chain-continuity record, not a mintable act. It can never mint, so the relay keeps nothing per
 * act for it — no act key, no act-page row, no mint-once claim. It stays in the device's chain
 * (the batch's `acts_root`, its receipt, the device tip) and is counted in the totals like any act.
 */
export function isChainContinuityRecord(row: Record<string, unknown>): boolean {
  // ONE predicate : the vocabulary counters read the same function, so a record
  // the meter treats as continuity is exactly a record the counters keep out of every work count.
  return isContinuityStatsRow(row);
}

/** A Genesis fixed-grant row (the accrual stamps the marker only from an exact Genesis snapshot). */
export function isGenesisRow(row: Record<string, unknown>): boolean {
  return row.is_genesis_grant === true;
}

function takeoverCapable(row: Record<string, unknown>): boolean {
  const sha = row.commit_sha;
  const completion = row.completion_witness;
  return (typeof sha === 'string' && sha.trim().length > 0)
    || completion === 'counterparty_confirmation'
    || completion === 'onchain_release';
}

async function resolveLegs(
  ctx: MeterActBatchContext,
  relayPeId: string,
  row: Record<string, unknown>,
): Promise<{ legs: MeterActLeg[]; refused: string | null }> {
  if (row.mint_status !== 'eligible') return { legs: [], refused: null };
  const total = String(row.record_points_atomic ?? '0');
  if (!/^[0-9]+$/.test(total) || BigInt(total) <= 0n) return { legs: [], refused: null };
  const payee = await resolvePayee(ctx.payeeDb, row, total, relayPeId);
  if (payee.kind !== 'resolved') return { legs: [], refused: `payee_${payee.reason}` };
  return {
    refused: null,
    legs: payee.legs.map((leg) => ({
      leg: leg.leg,
      contributor: leg.contributor.toLowerCase(),
      beneficiary_class: leg.beneficiaryClass as number,
      bps: leg.bps,
      points_atomic: leg.pointsAtomic,
    })),
  };
}

export async function sealMeterAct(
  db: Firestore,
  writeParams: WritePEHistoryParams,
  ctx: MeterActBatchContext,
  side: MeterActSideInputs,
  transient: MeterActTransient = { originEdges: null },
): Promise<void> {
  const relayPeId = writeParams.peId;
  const keyRef = privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(relayPeId);

  // A retried batch: the act was already sealed. Replay its stored outcome; price nothing twice.
  // (`recordPEAccrual` probed already; this re-probe catches a concurrent seal of a relay act.)
  const prior = ctx.freshBatch === true ? null : await keyRef.get();
  if (prior !== null && prior.exists) {
    ctx.sink(outcomeFromKey(prior.data() as MeterActKeyDoc, true));
    return;
  }
  // NOTE: the act key, a held-act record and the pending claims are written by the BATCH commit
  // (one transaction with the device tip), never here: an act is committed exactly when its
  // batch is. This transaction takes only the act's mint-once slots (owned by the relay pe id, so
  // a retried batch finds them self-owned) and any takeover they carry.

  const built = await buildPEHistoryRow(writeParams);
  const row = slimActRow(built.doc);
  // A Genesis grant is paid ONLY on the Genesis lane: its reservation (kept until minted) is the
  // grant's one claim, settled at the exact fixed amount. It never takes a standard-lane meter
  // claim — that would pay the same grant twice.
  const resolved = isGenesisRow(row)
    ? { legs: [], refused: null }
    : await resolveLegs(ctx, relayPeId, row);
  const mintStatus = String(row.mint_status);
  const heldReason = resolved.refused
    ?? (HELD_STATUSES.has(mintStatus) ? mintStatus : null);
  const unit: MeterActKeyDoc['unit'] = resolved.legs.length === 0 || heldReason !== null
    ? 'none'
    // : a takeover-capable witness's earnings fold into its batch's `window` claim
    // (one per recipient per batch); each act still waits its own takeover window there.
    : (takeoverCapable(row) ? 'window' : 'batch');
  const nowMs = Date.now();
  const ttl = expireAt(ctx.occurrenceAtMs + METER_KEY_LIFETIME_MS);
  const keyDoc: MeterActKeyDoc = {
    schema: 'provian.meter-act-key.v1',
    relay_pe_id: relayPeId,
    client_pe_id: ctx.clientPeId,
    pe_hash: ctx.peHash,
    prev_hash: ctx.prevHash,
    device_id: ctx.deviceId,
    batch_hash: ctx.batchHash,
    actor_id: writeParams.userId,
    timestamp: writeParams.timestamp,
    action_type: writeParams.actionType,
    row,
    legs: resolved.legs.length > 0 ? resolved.legs : null,
    unit,
    held_reason: heldReason,
    created_at_ms: nowMs,
    side,
    facts: ctx.facts ?? null,
    // The beneficiary's projection tail is an indexed query on this (`row` is not indexed).
    beneficiary_id: typeof row.beneficiary_wallet_id === 'string' && row.beneficiary_wallet_id.length > 0
      ? row.beneficiary_wallet_id
      : null,
    // A Genesis grant settles on the Genesis lane from its reservation, which is kept until the
    // grant mints; its key is kept with it (the mint's writeback starts its 31 days).
    pending_retention_v1: true,
    expire_at: isGenesisRow(row) || row.mint_status === 'eligible' || heldReason !== null ? null : ttl,
  };

  const pendingPolicyNow = writeParams.pending_policy_observation?.now ?? nowMs;
  let pendingPolicyResult: PendingPolicyObservationResult | null = null;
  if (ctx.singleLane === true) {
    // A single-lane act takes no mint-once claim (`pvt-accrual.ts` prepared none) and no act key.
    // Fail closed if a plan appeared anyway: that would be a lane this table does not know.
    if (built.mintOncePlans.length > 0) {
      throw new Error(`meter_single_lane_act_has_mint_once_plan:${writeParams.actionType}`);
    }
    if (writeParams.pending_policy_observation) {
      pendingPolicyResult = await db.runTransaction((txn) => upsertPendingPolicyObservationInTransaction(
        db, txn, writeParams.pending_policy_observation!, pendingPolicyNow,
      ));
      try {
        await finalizePendingPolicyObservation(db, pendingPolicyResult, pendingPolicyNow, writeParams.pending_policy_alert_sender);
      } catch (error) {
        console.error('[meter] post-commit pending-policy alert failed', error);
      }
    }
    ctx.sink({ ...outcomeFromKey(keyDoc, false), key: keyDoc, transient,
      ...(writeParams.output_digests?.length && heldReason === null ? { retainedKey: outputTrustKey(keyDoc) } : {}),
      home: isChainContinuityRecord(row) ? 'none'
        : (writeParams.output_digests?.length || heldReason !== null) ? 'key' : 'batch' });
    return;
  }
  // a chain-continuity record keeps no act key, which only the single-lane cut can allow (the
  // device's sequenced batches, not a key, stop its replay). Fail closed on any other lane.
  if (isChainContinuityRecord(row)) {
    throw new Error(`meter_chain_continuity_record_off_single_lane:${writeParams.actionType}`);
  }
  const rememberClaimSlots = async (): Promise<void> => {
    if (!ctx.occurrences) return;
    for (const plan of built.mintOncePlans) {
      const claim = plan.evidence.claim;
      if (plan.evidence.relation === 'owner' && claim.claim_kind !== 'artifact') await ctx.occurrences.remember(claim.subject_id,
        claim.claim_kind === 'device_occurrence' ? claim.event_id : crossWitnessOccurrenceDigest(plan.claim_collection, claim.claim_id));
    }
  };
  if (ctx.pricingCounters && ctx.occurrences && built.mintOncePlans.length > 0
    && built.mintOncePlans.every(p => isAbsentBatchClaim(p) && !p.commit_takeover && !p.completion_takeover)
    && !writeParams.pending_policy_observation) {
    await rememberClaimSlots();
    const decisions = built.mintOncePlans.map(plan => ({ collection: plan.claim_collection,
      claimId: plan.evidence.claim.claim_id, physicalId: plan.evidence.claim.claim_id, documentToCreate: plan.evidence.claim }));
    ctx.pricingCounters.addHook({ inspect: async () => {}, commit: txn => {
      for (const decision of decisions) applyMintOnceClaimDecision(db, txn, decision, heldReason === null ? ttl : undefined);
    } });
    ctx.sink({ ...outcomeFromKey(keyDoc, false), key: keyDoc, transient }); return;
  }
  await db.runTransaction(async (txn) => {
    const mintOnceDecisions: MintOnceClaimTransactionDecision[] = [];
    const takeoverDecisions: CommitTakeoverDecision[] = [];
    const completionTakeoverDecisions: CompletionTakeoverDecision[] = [];
    for (const plan of built.mintOncePlans) {
      if (plan.commit_takeover !== undefined) {
        takeoverDecisions.push(await inspectPreparedCommitTakeoverInTransaction(db, txn, plan));
      } else if (plan.completion_takeover !== undefined) {
        completionTakeoverDecisions.push(await inspectPreparedCompletionTakeoverInTransaction(db, txn, plan));
      } else {
        mintOnceDecisions.push(await inspectPreparedMintOnceClaimInTransaction(db, txn, plan));
      }
    }
    // A demoted METERED incumbent's share leaves the claims that carry it, with the takeover: a
    // pre-fold act claim is voided; a window claim loses the act's entry and
    // points. on the meter: the incumbent must not have registered — every claim carrying
    // it must still be `pending` (a claim taken into a payout, registered or settled is committed
    // to mint, and the legacy ledger probe in `inspectPrepared…` cannot see a meter claim) — or
    // the takeover is a race the accrual retries into a corroboration of the incumbent.
    const demoted = [
      ...takeoverDecisions.map((d) => ({ peId: d.incumbentPeId, home: d.incumbentHandle.home })),
      ...completionTakeoverDecisions.map((d) => ({ peId: d.incumbentPeId, home: d.incumbentHandle.home })),
    ].filter((d) => d.home === 'meter');
    const incumbentKeySnaps = await Promise.all(demoted.map((d) => txn.get(privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(d.peId))));
    const incumbentLegs = (await Promise.all(incumbentKeySnaps.map((snap) => (snap.exists
      ? resolveActBaseClaims(db, (ref) => txn.get(ref), snap.data() as MeterActKeyDoc)
      : Promise.resolve([]))))).flat();
    // The incumbent's corroboration top-ups are its earnings too: one a run has taken is as
    // committed as a taken base claim (the takeover would mint the taker's base on top of the
    // incumbent's lift); one still pending leaves with the demotion.
    const incumbentTopups = (await Promise.all(incumbentKeySnaps.map((snap, i) => (snap.exists
      ? resolveActTopupClaims(db, (ref) => txn.get(ref), snap.data() as MeterActKeyDoc)
        .then((topups) => topups.map((t) => ({ ...t, peId: demoted[i].peId })))
      : Promise.resolve([]))))).flat();
    if (!actClaimsUncommitted(incumbentLegs) || !actTopupsUncommitted(incumbentTopups)) throw new MintOnceClaimRaceError();

    const deferredWrites: (() => unknown)[] = [];
    const claimOverrides = new Map<string, MeterPendingClaim>();
    // Each claim once (an incumbent's legs never share a claim; two incumbents of one batch can).
    const patched = new Map<string, { ref: FirebaseFirestore.DocumentReference; claim: MeterPendingClaim }>();
    for (const leg of incumbentLegs) {
      if (leg.claim === null) continue;
      const prior = patched.get(leg.ref.path);
      patched.set(leg.ref.path, { ref: leg.ref, claim: prior?.claim ?? leg.claim });
    }
    for (const entry of patched.values()) {
      const ref = entry.ref;
      let claim = entry.claim;
      // Defense in depth behind the guard above: a claim that has left `pending` is committed to
      // mint and is never trimmed or voided here.
      if (claim.state !== 'pending') throw new MintOnceClaimRaceError();
      for (const d of demoted) {
        if (!claim.acts.some((a) => a.relay_pe_id === d.peId)) continue;
        if (claim.unit === 'act') {
          claim = { ...claim, state: 'void' };
          continue;
        }
        const trim = withoutAct(claim, d.peId, nowMs);
        if (trim !== null) claim = { ...claim, ...trim } as MeterPendingClaim;
      }
      claimOverrides.set(ref.id, claim);
      if (claim.state === 'void') {
        // As before the fold: a voided claim names the witness that took its act over.
        deferredWrites.push(() => txn.update(ref, { state: 'void', voided_by: relayPeId, voided_at_ms: nowMs }));
      } else if (claim !== entry.claim) {
        deferredWrites.push(() => txn.update(ref, {
          acts: claim.acts,
          record_points_atomic: claim.record_points_atomic,
          ready_at_ms: claim.ready_at_ms,
          integrity_sha256: claim.integrity_sha256,
        }));
      }
    }
    // A pending top-up of a demoted incumbent is voided with it (as a bug demotion voids it).
    for (const topup of incumbentTopups) {
      if (topup.claim === null || topup.claim.state === 'void') continue;
      if (topup.claim.state !== 'pending') throw new MintOnceClaimRaceError();
      const voided = withoutAct(topup.claim, topup.peId, nowMs);
      if (voided !== null) { claimOverrides.set(topup.ref.id, { ...topup.claim, ...voided }); deferredWrites.push(() => txn.update(topup.ref, voided)); }
    }
    const retireDemoted = await prepareDemotedMeterRetention(db, txn, incumbentKeySnaps, claimOverrides, nowMs);
    // The demotion's aggregate delta lands with the demotion (M5). The taker's own
    // contribution is applied once per batch by the batch commit.
    const aggregateWriter = new EconomicAggregateWriter(db, txn, pendingPolicyNow);
    await aggregateWriter.load([
      ...takeoverDecisions.flatMap((d) => EconomicAggregateWriter.identitiesOf(d.incumbentBefore)),
      ...completionTakeoverDecisions.flatMap((d) => EconomicAggregateWriter.identitiesOf(d.incumbentBefore)),
    ]);
    if (writeParams.pending_policy_observation) {
      pendingPolicyResult = await upsertPendingPolicyObservationInTransaction(
        db, txn, writeParams.pending_policy_observation, pendingPolicyNow,
      );
    }

    for (const decision of mintOnceDecisions) applyMintOnceClaimDecision(db, txn, decision, heldReason === null ? ttl : undefined);
    for (const decision of takeoverDecisions) {
      applyCommitTakeoverDecision(db, txn, decision, writeParams.timestamp);
      txn.update(db.collection(decision.claimCollection).doc(decision.claimId), { expire_at: null });
      aggregateWriter.applyMutation(
        decision.incumbentBefore as unknown as PEHistoryDocument,
        demotedIncumbentRow(decision, writeParams.timestamp) as unknown as PEHistoryDocument,
      );
    }
    for (const decision of completionTakeoverDecisions) {
      applyCompletionTakeoverDecision(db, txn, decision, writeParams.timestamp);
      txn.update(db.collection(decision.claimCollection).doc(decision.claimId), { expire_at: null });
      aggregateWriter.applyMutation(
        decision.incumbentBefore as unknown as PEHistoryDocument,
        demotedCompletionIncumbentRow(decision, writeParams.timestamp) as unknown as PEHistoryDocument,
      );
    }
    for (const write of deferredWrites) write();
    retireDemoted();
    aggregateWriter.commit();
  });

  await rememberClaimSlots();
  if (pendingPolicyResult !== null) {
    try {
      await finalizePendingPolicyObservation(db, pendingPolicyResult, pendingPolicyNow, writeParams.pending_policy_alert_sender);
    } catch (error) {
      console.error('[meter] post-commit pending-policy alert failed', error);
    }
  }
  ctx.sink({ ...outcomeFromKey(keyDoc, false), key: keyDoc, transient });
}

export function outcomeFromKey(key: MeterActKeyDoc, replay: boolean): MeterActOutcome {
  return {
    relayPeId: key.relay_pe_id,
    replay,
    row: key.row,
    legs: key.legs ?? [],
    unit: key.unit,
    heldReason: key.held_reason,
    side: key.side,
  };
}
