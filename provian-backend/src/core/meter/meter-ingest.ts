import { memoizeMonetaryActivationForBatch } from '../pvt/policy/runtime-monetary-policy';
import { NoveltyCounterConflictError, isNoveltyCounterCreateCollision } from './batch-pricing-counters';
import { primeBatchCommitClaims, mintOnceClaimDocId, isSparseClaimCollision } from '../pvt/mint-once-claim';
/**
 * PE METER — ingest one signed batch.
 *
 * 1. Shape: the wire format's own validator (recomputes `acts_root`; never trusts it).
 * 2. Chain: the batch extends this device's latest accepted batch (seq + prev_batch_hash) and its
 * acts continue the device's PE chain. The SAME batch re-sent is answered with its stored
 * receipt; anything else that does not extend the tip is refused. The relay keeps only the
 * latest batch per device. Actor-wide packed occurrence membership also prevents replay
 * from a second device.
 * 3. Each act is priced in memory by `recordPEAccrual` under every rule, in order (acts can
 * depend on each other: novelty ordinals, mint-once slots). An act the lane refuses
 * or that is dated in the future stays in the fingerprint and earns nothing; an act older
 * than 30 days is recorded into totals and does not mint.
 * 4. Sealed copies for the linked human are staged in the mailbox; the batch commits.
 */

import { actFactsOf } from './meter-act-key';
import { BatchOccurrences, bindBatchOccurrences } from './batch-occurrences';
import { BatchPricingCounters, retryNoveltyConflict } from './batch-pricing-counters';
import { isSingleLaneActType } from './act-witness-lanes';
import type { Firestore } from 'firebase-admin/firestore';
import { recordPEAccrual, type RecordPEAccrualParams } from '../../pvt-accrual';
import { ACCRUAL_ENDED_REASON, accrualEndedAt } from '../pvt/accrual-end-line';
import { commitMeterBatch, MeterPreconditionChangedError, MeterTipConflictError, type MeterTxnHook } from './meter-commit';
import type { MeterActOutcome } from './meter-seal';
import type { SettlementDb } from '../pvt/wp4/durable-settlement-store';
import { stageSealedCopies } from './pe-mailbox';
import { newBatchOriginEdges } from '../pvt/origin-pricing-inputs';
import {
  meterRelayPeId,
  METER_DEVICE_TIPS_COLLECTION,
  METER_MAX_FUTURE_SKEW_MS,
  METER_MIN_BATCH_INTERVAL_MS,
  type MeterBatchReceipt,
  type MeterDeviceTip,
} from './meter-store';
import {
  batchHashOf,
  MAX_ACTS_PER_BATCH,
  METER_GENESIS_PREV_HASH,
  METER_MINT_WINDOW_MS,
  validateBatchShape,
  verifyActChain,
  type ActRecord,
} from './meter-wire';

export type LaneActMapping =
  | {
    readonly ok: true;
    readonly params: RecordPEAccrualParams;
    readonly note?: string;
    /** The submitter's wallet id (kept in the act's facts for later verifiers). */
    readonly walletId?: string | null;
  }
  | { readonly ok: false; readonly reason: string };

/** What a submitting surface supplies: who it is, and how one of its acts maps to pricing inputs. */
export interface MeterLane {
  readonly deviceId: string;
  readonly actorId: string;
  /** Resolve a sealed copy's role alias (`linked_human` / `owner`) to a recipient key, or null. */
  resolveSealedRecipient(to: string): string | null;
  mapAct(act: ActRecord, relayPeId: string): Promise<LaneActMapping>;
  /** Lane state committed with the batch (e.g. the session-lineage registry). */
  extraWrites(): readonly { readonly ref: FirebaseFirestore.DocumentReference; readonly doc: object }[];
  /** Read-then-write lane state committed with the batch (approval claims, chain-record queue). */
  txnHooks?(): readonly MeterTxnHook[];
  /**
   * : this lane's batches are hash-chained and sequenced per device, so an act type
   * only this lane can witness (`act-witness-lanes.ts`) keeps no per-act document. The device and
   * phone batch lanes set it; a lane that leaves it unset keeps every act's key and claims.
   */
  readonly singleLaneCut?: boolean;
  /**
   * Fix run 2026-10-24: the device id is a label the caller chose (the phone names it in its own
   * wallet token), so the chain it names belongs to the actor that opened it. A batch for a chain
   * whose tip names another actor is refused before anything is read or priced.
   */
  readonly ownerBoundChain?: boolean;
}

export type MeterIngestResult =
  | { readonly status: 201 | 200; readonly body: MeterBatchReceipt }
  | { readonly status: 400 | 403 | 409 | 429; readonly body: Record<string, unknown> };

/** A per-batch read memo for payee resolution (every act of a batch resolves the same wallets). */
export function memoizedSettlementDb(db: Firestore): SettlementDb {
  return memoizedReadDb(db, () => true) as unknown as SettlementDb;
}

/**
 * The registry collections an act's PRICING only reads and nothing in a batch's pricing writes:
 * who the actor is (wallets, agent wallets, forge installs, proven and retired addresses), its
 * beneficiary relationship and the identity act that relationship is pinned to, and the
 * jurisdiction table. Every act of one batch reads the same documents, so a batch reads each
 * once — a snapshot of the registry at the batch's acceptance, the same for every act in it.
 * Never a mint-once claim, an act key, a counter, or anything a transaction guards: those are not
 * in this set and are always read live.
 */
export const BATCH_INVARIANT_READ_COLLECTIONS: ReadonlySet<string> = new Set([
  'wallets',
  'agent_wallets',
  'service_installs',
  'proven_addresses',
  'human_proven_addresses',
  'solana_proven_addresses', // follow-up: the Solana proof registry (read by the signer identity set)
  'agent_wallet_address_retirements_v1',
  'agent_beneficiary_relationships_v1',
  'identity_acts_v1',
  'identity_pes_legacy_v1',
  'jurisdiction_policy',
  'wallet_jurisdiction_sessions_v1',
  'jurisdiction_screening_v1',
  'meter_occurrence_carry_v1',
]);

/** The per-batch pricing read memo: memoizes non-transactional reads of the invariant registry. */
export function batchPricingReadDb(db: Firestore): Firestore {
  const reads = memoizedReadDb(db, (name) => BATCH_INVARIANT_READ_COLLECTIONS.has(name));
  memoizeMonetaryActivationForBatch(reads);
  return reads;
}

/**
 * A Firestore whose NON-transactional point reads (`collection(c).doc(id).get()`) and simple
 * queries (`collection(c).where(…)[.limit(n)].get()`) on collections `memoize` selects are read once
 * and shared. Everything else — other collections, transactions, writes, ordered or projected
 * queries — passes through untouched.
 */
export function memoizedReadDb(db: Firestore, memoize: (collection: string) => boolean): Firestore {
  const memo = new Map<string, Promise<unknown>>();
  const converters = new WeakMap<object, number>();
  let nextConverter = 1;
  const wrapQuery = (path: string, q: FirebaseFirestore.Query): FirebaseFirestore.Query => new Proxy(q, {
    get(target, prop, receiver) {
      if (prop === 'where') {
        return (field: string, op: FirebaseFirestore.WhereFilterOp, value: unknown) =>
          wrapQuery(`${path}|w:${field}${op}${JSON.stringify(value)}`, target.where(field, op, value));
      }
      if (prop === 'limit') {
        return (n: number) => wrapQuery(`${path}|l:${n}`, target.limit(n));
      }
      if (prop === 'get') {
        return () => {
          if (!memo.has(path)) memo.set(path, target.get());
          return memo.get(path);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const wrapCollection = (name: string, col = db.collection(name), cacheName = name): FirebaseFirestore.CollectionReference => {
    if (!memoize(name)) return col;
    return new Proxy(col, {
      get(target, prop, receiver) {
        if (prop === 'withConverter') {
          return (converter: FirebaseFirestore.FirestoreDataConverter<FirebaseFirestore.DocumentData> | null) => {
            if (converter === null) return wrapCollection(name, target.withConverter(null), name);
            let id = converters.get(converter);
            if (id === undefined) { id = nextConverter++; converters.set(converter, id); }
            return wrapCollection(name, target.withConverter(converter), `${name}|converter:${id}`);
          };
        }
        if (prop === 'where') {
          return (field: string, op: FirebaseFirestore.WhereFilterOp, value: unknown) =>
            wrapQuery(`${cacheName}|w:${field}${op}${JSON.stringify(value)}`, target.where(field, op, value));
        }
        if (prop === 'doc') {
          return (id: string) => {
            const ref = target.doc(id);
            return new Proxy(ref, {
              get(t, p, r) {
                if (p === 'get') {
                  return () => {
                    const key = `${cacheName}/${id}`;
                    if (!memo.has(key)) memo.set(key, t.get());
                    return memo.get(key);
                  };
                }
                return Reflect.get(t, p, r);
              },
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  };
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'collection') return (name: string) => wrapCollection(name);
      return Reflect.get(target, prop, receiver);
    },
  });
}

export async function ingestMeterBatch(db: Firestore, lane: MeterLane, raw: unknown,
  nowMs: number = Date.now()): Promise<MeterIngestResult> {
  // Mapping can stage lineage, approval and queue hooks. Do it once, then only re-price on CAS
  // conflict; every attempt gets new counters, first-sightings and origin-edge state.
  const mappings = new Map<string, Promise<LaneActMapping>>();
  const mappedLane: MeterLane = { ...lane, mapAct: (act, id) => {
    if (!mappings.has(id)) mappings.set(id, lane.mapAct(act, id));
    return mappings.get(id)!;
  } };
  return retryNoveltyConflict(() => ingestMeterBatchAttempt(db, mappedLane, raw, nowMs));
}

async function ingestMeterBatchAttempt(
  db: Firestore,
  lane: MeterLane,
  raw: unknown,
  nowMs: number = Date.now(),
): Promise<MeterIngestResult> {
  const shape = validateBatchShape(raw);
  if (!shape.ok) {
    return { status: 400, body: { error: 'batch_invalid', code: shape.error, ...(shape.index !== undefined ? { act_index: shape.index } : {}) } };
  }
  const batch = shape.batch;
  if (batch.device_id !== lane.deviceId) {
    return { status: 403, body: { error: 'batch_device_mismatch', message: 'A batch may only be submitted by the device that built it.' } };
  }
  const batchHash = batchHashOf(batch);

  const tipSnap = await db.collection(METER_DEVICE_TIPS_COLLECTION).doc(batch.device_id).get();
  const tip = tipSnap.exists ? (tipSnap.data() as MeterDeviceTip) : null;
  if (lane.ownerBoundChain === true && tip !== null && tip.actor_id !== lane.actorId) {
    return { status: 403, body: { error: 'batch_device_not_owned', message: 'This device chain belongs to another wallet.' } };
  }
  if (tip !== null && tip.batch_hash === batchHash) {
    return { status: 200, body: tip.receipt }; // the same batch, re-sent: the same answer
  }
  const expectedSeq = (tip?.seq ?? 0) + 1;
  const expectedPrev = tip?.batch_hash ?? METER_GENESIS_PREV_HASH;
  if (batch.seq !== expectedSeq || batch.prev_batch_hash !== expectedPrev) {
    return {
      status: 409,
      body: {
        error: batch.seq <= (tip?.seq ?? 0) ? 'batch_replay' : 'batch_chain_broken',
        expected_seq: expectedSeq,
        expected_prev_batch_hash: expectedPrev,
        last_pe_hash: tip?.last_pe_hash ?? METER_GENESIS_PREV_HASH,
      },
    };
  }
  const chain = verifyActChain(tip?.last_pe_hash ?? METER_GENESIS_PREV_HASH, batch.acts);
  if (!chain.ok) {
    return {
      status: 409,
      body: { error: 'act_chain_broken', act_index: chain.index, last_pe_hash: tip?.last_pe_hash ?? METER_GENESIS_PREV_HASH },
    };
  }
  // Clients send daily and before a presentation or on-demand payout. A device may land at most one batch per interval, unless it is draining a
  // backlog (its previous batch was full).
  if (tip !== null && nowMs - tip.accepted_at_ms < METER_MIN_BATCH_INTERVAL_MS
    && tip.receipt.acts.length < MAX_ACTS_PER_BATCH) {
    return {
      status: 429,
      body: { error: 'batch_too_soon', retry_after_ms: METER_MIN_BATCH_INTERVAL_MS - (nowMs - tip.accepted_at_ms) },
    };
  }

  const readDb = batchPricingReadDb(db);
  const payeeDb = memoizedSettlementDb(readDb);
  const commitIds: string[] = [];
  for (const act of batch.acts) {
    const mapping = await lane.mapAct(act, meterRelayPeId(act.pe_hash));
    if (mapping.ok && mapping.params.commitSha) commitIds.push(mintOnceClaimDocId('commit', mapping.params.userId, mapping.params.commitSha));
  }
  await primeBatchCommitClaims(readDb, commitIds.filter((id, i) => commitIds.indexOf(id) === i && commitIds.lastIndexOf(id) === i));
  const batchEdges = newBatchOriginEdges();
  const batchSightings = new Set<string>();
  const pricingCounters = new BatchPricingCounters(true, [...new Set(batch.acts.map(act => act.action_type))]);
  const occurrences = new BatchOccurrences(readDb);
  bindBatchOccurrences(readDb, occurrences);
  pricingCounters.addHook(occurrences);
  const acts: ({ kind: 'priced'; outcome: MeterActOutcome } | { kind: 'refused'; reason: string })[] = [];
  for (const act of batch.acts) {
    if (act.timestamp > nowMs + METER_MAX_FUTURE_SKEW_MS) {
      acts.push({ kind: 'refused', reason: 'timestamp_in_future' });
      continue;
    }
    const relayPeId = meterRelayPeId(act.pe_hash);
    const mapping = await lane.mapAct(act, relayPeId);
    if (!mapping.ok) {
      acts.push({ kind: 'refused', reason: mapping.reason });
      continue;
    }
    let captured: MeterActOutcome | null = null;
    const tooOld = nowMs - act.timestamp > METER_MINT_WINDOW_MS;
    // Shutdown coverage: an act received at or after the accrual end line is counted, never minted.
    const recordOnlyReason = accrualEndedAt(nowMs)
      ? ACCRUAL_ENDED_REASON
      : tooOld ? 'meter_act_older_than_30_days' : null;
    await recordPEAccrual({
      ...mapping.params,
      peId: relayPeId,
      peHash: act.pe_hash,
      timestamp: act.timestamp,
      ...(recordOnlyReason !== null ? { meterRecordOnly: recordOnlyReason } : {}),
      accrualReceivedAtMs: nowMs,
      meter: {
        batchHash,
        deviceId: batch.device_id,
        clientPeId: act.pe_id,
        peHash: act.pe_hash,
        prevHash: act.prev_hash,
        occurrenceAtMs: act.timestamp,
        payeeDb,
        readDb,
        batchEdges,
        // The tip check above proved this batch new: none of its acts has a key yet.
        freshBatch: true,
        singleLane: lane.singleLaneCut === true && isSingleLaneActType(act.action_type),
        batchSightings,
        pricingCounters,
        occurrences,
        sink: (outcome) => { captured = outcome; },
        facts: actFactsOf(act, {
          actorId: mapping.params.userId,
          walletId: mapping.walletId ?? null,
          counterpartyAddress: mapping.params.counterpartyAddress ?? null,
          actorAddress: mapping.params.walletAddress ?? null,
        }),
      },
    });
    if (captured === null) throw new Error(`meter_act_unsealed:${act.pe_id}`);
    const outcome: MeterActOutcome = captured;
    if (lane.singleLaneCut === true && isSingleLaneActType(act.action_type) && outcome.heldReason !== null) {
      // The owner retains the complete retry source. Do not acknowledge it into a relay archive.
      return { status: 409, body: { error: 'batch_retry', detail: outcome.heldReason,
        message: 'This batch is waiting on verifiable pricing state; retain it and resend unchanged.' } };
    }
    acts.push({
      kind: 'priced',
      outcome: {
        ...outcome,
        ...(recordOnlyReason !== null ? { receiptReason: recordOnlyReason } : {}),
        ...(mapping.note ? { receiptNote: mapping.note } : {}),
      },
    });
  }

  if (batch.sealed && batch.sealed.length > 0) {
    await stageSealedCopies(db, {
      batchHash,
      deviceId: batch.device_id,
      actorId: lane.actorId,
      sealed: batch.sealed,
      resolveRecipient: (to) => lane.resolveSealedRecipient(to),
      nowMs,
    });
  }

  try {
    const transitRecipients: Record<string, string> = {};
    for (const role of new Set((batch.sealed ?? []).map(s => s.to))) {
      const recipient = lane.resolveSealedRecipient(role);
      if (recipient !== null) transitRecipients[role] = recipient;
    }
    const receipt = await commitMeterBatch(db, {
      transitRecipients,
      pricingReadDb: readDb,
      batch,
      batchHash,
      actorId: lane.actorId,
      expectedTip: tip,
      acceptedAtMs: nowMs,
      acts,
      extraWrites: lane.extraWrites(),
      txnHooks: lane.txnHooks?.() ?? [],
    });
    return { status: 201, body: receipt };
  } catch (error) {
    if (isSparseClaimCollision(readDb, error) || isNoveltyCounterCreateCollision(error)) throw new NoveltyCounterConflictError();
    if (error instanceof MeterTipConflictError) {
      return { status: 409, body: { error: 'batch_concurrent', message: 'Another batch from this device landed first; re-send.' } };
    }
    if (error instanceof MeterPreconditionChangedError) {
      return { status: 409, body: { error: 'batch_retry', detail: error.detail, message: 'State an act depended on changed while pricing; re-send the same batch.' } };
    }
    throw error;
  }
}
