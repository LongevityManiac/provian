import { BatchPricingCounters, retryNoveltyConflict } from './batch-pricing-counters';
import { BatchOccurrences, bindBatchOccurrences, relayOccurrenceDigest } from './batch-occurrences';
import { isSingleLaneActType } from './act-witness-lanes';
import { newBatchOriginEdges } from '../pvt/origin-pricing-inputs';
import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * PE METER — PEs the relay itself authors (webhooks, chain watchers, x402 settlements, institution
 * events, Commons acts, Genesis grants, registrations).
 *
 * relay-created PEs go into the totals and reach their owner
 * the same way every other PE does, and the relay never keeps a readable PE. So a relay-authored
 * PE is built as a PE v2 (the owner can prove it exactly like a device PE), chained on the actor's
 * existing relay chain tip, and:
 *
 * 1. in the SAME transaction as the chain-tip advance (and any entity write the emitter commits
 * with it), a transient intake row is staged: the act record (identity + pricing inputs +
 * pe_hash — never free text), the accrual inputs, and the PE SEALED to its owner and the
 * owner's linked human (ciphertext the relay cannot open). That row is the replay source if
 * the process dies before pricing;
 * 2. the act is priced in memory as a one-act relay batch (`relay:<actor>`), committed through
 * the meter (compact claims, totals and the batch record the daily anchor covers), the
 * sealed copies wait in transit until the owner acknowledges them, and the intake row is deleted in that
 * same commit.
 *
 * A relay batch has no device chain to protect against replay — the per-actor PE chain orders it
 * and permanent packed occurrence membership makes a re-price a no-op. Cross-witness and
 * identity types retain their dedicated evidence keys. No relay batch advances a device tip.
 */

import { actFactsOf } from './meter-act-key';
import { relayDeviceId } from './meter-store';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import stableStringify from 'json-stable-stringify';
import { recordPEAccrual, type RecordPEAccrualParams } from '../../pvt-accrual';
import { ACCRUAL_ENDED_REASON, accrualEndedAt, isGenesisReservationSeal } from '../pvt/accrual-end-line';
import { readMessageKey } from '../commons/message-keys';
import { commitMeterBatch, type MeterTxnHook } from './meter-commit';
import { batchPricingReadDb, memoizedSettlementDb } from './meter-ingest';
import type { MeterActOutcome } from './meter-seal';
import { stageSealedCopies } from './pe-mailbox';
import { advanceChainTipAtomic } from '../../pe-chain-validator';
import { buildIdentityAct, isIdentityActType, stageIdentityActInTransaction } from './identity-acts';
import { expireAt, METER_RELAY_ACT_LIFETIME_MS, type MeterBatchReceipt } from './meter-store';
import { fromB64u, sealToKey, toB64u } from './sealed-box';
import {
  actRecordOf,
  actsRootOf,
  batchHashOf,
  peHashOf,
  canonicalJson,
  METER_GENESIS_PREV_HASH,
  METER_MINT_WINDOW_MS,
  PE_BATCH_SCHEMA,
  PE_V2_SCHEMA,
  type ActRecord,
  type PeBatch,
  type PeV2,
} from './meter-wire';

export const METER_RELAY_ACTS_COLLECTION = 'meter_relay_acts_v1';
/** An unpriced relay act is retried by the replay sweep; it never waits longer than this. */
export { METER_RELAY_ACT_LIFETIME_MS };
/** The replay sweep leaves a fresh intake alone (the emitter is still pricing it). */
export const METER_RELAY_ACT_REPLAY_AFTER_MS = 5 * 60_000;

export { relayDeviceId } from './meter-store';

/** The PE v2 the relay authors. `content` is everything but the identity fields. */
export function relayPeOf(input: {
  readonly peId: string;
  readonly actorId: string;
  readonly prevHash: string;
  readonly timestamp: number;
  readonly actionType: string;
  readonly content: Record<string, unknown>;
}): PeV2 {
  return {
    ...input.content,
    schema: PE_V2_SCHEMA,
    pe_id: input.peId,
    device_id: relayDeviceId(input.actorId),
    prev_hash: input.prevHash,
    timestamp: input.timestamp,
    action_type: input.actionType,
  };
}

export interface RelaySealTarget {
  /** Mailbox recipient key: `agent:<agent_id>` or `human:<user_id>`. */
  readonly recipient: string;
  readonly pubkey_b64u: string;
}

/**
 * Whom a relay-authored PE is sealed to: its owner, and (for an agent) its linked human — each
 * under the message key they published. A party with no published key gets no copy yet.
 */
export async function resolveRelaySealTargets(
  db: Firestore,
  owner: { readonly actorId: string; readonly walletId: string; readonly ownerType?: 'human' | 'agent' },
): Promise<RelaySealTarget[]> {
  const targets: RelaySealTarget[] = [];
  const isAgent = owner.ownerType === 'agent' || owner.walletId.startsWith('wallet_aw_');
  if (isAgent) {
    const [own, wallet] = await Promise.all([
      readMessageKey(db, owner.walletId),
      db.collection('agent_wallets').doc(owner.walletId).get(),
    ]);
    if (own) targets.push({ recipient: `agent:${owner.actorId}`, pubkey_b64u: own.pubkey_b64u });
    const humanWalletId = wallet.exists ? wallet.data()?.linked_human_wallet_id : null;
    const humanUserId = wallet.exists ? wallet.data()?.linked_human_user_id : null;
    if (typeof humanWalletId === 'string' && humanWalletId && typeof humanUserId === 'string' && humanUserId) {
      const human = await readMessageKey(db, humanWalletId);
      if (human) targets.push({ recipient: `human:${humanUserId}`, pubkey_b64u: human.pubkey_b64u });
    }
    return targets;
  }
  // A person's message key is published under their `wallets` doc id. Most human emitters pass
  // that id; the rest (an address-keyed observation) resolve it from the unique `user_id`.
  const direct = await readMessageKey(db, owner.walletId);
  const key = direct ?? await (async () => {
    const wallets = await db.collection('wallets').where('user_id', '==', owner.actorId).get();
    const walletDocId = wallets.docs[0]?.id;
    return walletDocId ? readMessageKey(db, walletDocId) : null;
  })();
  if (key) targets.push({ recipient: `human:${owner.actorId}`, pubkey_b64u: key.pubkey_b64u });
  return targets;
}

/** Seal one PE's canonical JSON to each target. */
export function sealRelayPe(pe: PeV2, targets: readonly RelaySealTarget[]): { to: string; box: string }[] {
  const plaintext = Buffer.from(canonicalJson(pe), 'utf8');
  return targets.map((t) => ({ to: t.recipient, box: toB64u(sealToKey(fromB64u(t.pubkey_b64u), plaintext)) }));
}

export interface RelayActIntake {
  readonly schema: 'provian.meter-relay-act.v1';
  readonly pe_id: string;
  readonly actor_id: string;
  readonly act: ActRecord;
  /** The accrual inputs (pricing only; free-text summaries stripped). */
  readonly accrual: Record<string, unknown>;
  /** True when the emitter owns an acknowledged path (its accrual was `throwOnError`). */
  readonly durable: boolean;
  readonly sealed: readonly { readonly to: string; readonly box: string }[];
  readonly created_at_ms: number;
  readonly expire_at: FirebaseFirestore.Timestamp;
}

/** Build the intake row. PURE — safe to rebuild on a transaction retry. */
export function buildRelayActIntake(input: {
  readonly pe: PeV2;
  readonly actorId: string;
  readonly accrual: RecordPEAccrualParams;
  readonly sealed: readonly { readonly to: string; readonly box: string }[];
  readonly nowMs: number;
}): RelayActIntake {
  const act = actRecordOf(input.pe);
  if (input.accrual.peId !== input.pe.pe_id) throw new Error('relay_act_pe_id_mismatch');
  const {
    throwOnError, durableTestCrashAt: _crash, inputSummary: _in, outputSummary: _out, meter: _meter, ...rest
  } = input.accrual;
  const serialized = stableStringify({ ...rest, peHash: act.pe_hash });
  if (serialized === undefined) throw new Error('relay_act_accrual_unserializable');
  return {
    schema: 'provian.meter-relay-act.v1',
    pe_id: input.pe.pe_id,
    actor_id: input.actorId,
    act,
    accrual: JSON.parse(serialized) as Record<string, unknown>,
    durable: throwOnError === true,
    sealed: input.sealed,
    created_at_ms: input.nowMs,
    expire_at: expireAt(input.nowMs + METER_RELAY_ACT_LIFETIME_MS),
  };
}

/** A staged relay act, or null when none is staged (already priced, or never staged). */
export async function readRelayActIntake(db: Firestore, peId: string): Promise<RelayActIntake | null> {
  const snap = await privateRetentionCollection(db, METER_RELAY_ACTS_COLLECTION).doc(peId).get();
  if (!snap.exists) return null;
  const intake = snap.data() as RelayActIntake;
  if (intake.schema !== 'provian.meter-relay-act.v1' || intake.pe_id !== peId) {
    throw new Error(`relay_act_intake_invalid:${peId}`);
  }
  return intake;
}

export function stageRelayActInTransaction(txn: Transaction, db: Firestore, intake: RelayActIntake): void {
  txn.set(privateRetentionCollection(db, METER_RELAY_ACTS_COLLECTION).doc(intake.pe_id), { ...intake });
}

/** The one-act batch a relay-authored act settles and anchors under. Deterministic per act. */
export function relayBatchOf(actorId: string, act: ActRecord): PeBatch {
  return {
    schema: PE_BATCH_SCHEMA,
    device_id: relayDeviceId(actorId),
    seq: 1,
    prev_batch_hash: METER_GENESIS_PREV_HASH,
    created_at_ms: act.timestamp,
    acts: [act],
    acts_root: actsRootOf([act]),
  } as PeBatch;
}

/**
 * Price one staged relay act and commit it. Idempotent: an act already sealed replays as a no-op
 * commit that only deletes the intake row. Throws on a pricing error when the act is durable.
 */
export async function priceRelayAct(db: Firestore, intake: RelayActIntake,
  options: { readonly nowMs?: number; readonly record?: (params: RecordPEAccrualParams) => Promise<void> } = {},
): Promise<MeterBatchReceipt | null> {
  return retryNoveltyConflict(() => priceRelayActAttempt(db, intake, options));
}

async function priceRelayActAttempt(
  db: Firestore,
  intake: RelayActIntake,
  options: {
    readonly nowMs?: number;
    /** Injected for tests; production prices through the real accrual. */
    readonly record?: (params: RecordPEAccrualParams) => Promise<void>;
  } = {},
): Promise<MeterBatchReceipt | null> {
  const nowMs = options.nowMs ?? Date.now();
  const record = options.record ?? recordPEAccrual;
  const batch = relayBatchOf(intake.actor_id, intake.act);
  const batchHash = batchHashOf(batch);
  const singleLane = isSingleLaneActType(intake.act.action_type) && !isIdentityActType(intake.act.action_type);
  const intakeRef = privateRetentionCollection(db, METER_RELAY_ACTS_COLLECTION).doc(intake.pe_id);
  const deliver = async (): Promise<void> => {
    if (intake.sealed.length) await stageSealedCopies(db, {
      batchHash, deviceId: batch.device_id, actorId: intake.actor_id,
      sealed: intake.sealed.map(s => ({ to: s.to, pe_id: intake.pe_id, box: s.box })), resolveRecipient: to => to, nowMs,
    });
  };
  if (singleLane) {
    const prior = (await db.collection('meter_batches_v1').doc(batchHash).get()).data();
    if (prior) {
      if (prior.actor_id !== intake.actor_id || prior.acts_root !== batch.acts_root) throw new Error('relay_batch_identity_changed');
      await deliver(); await intakeRef.delete();
      return (prior.relay_receipt as MeterBatchReceipt | undefined) ?? null;
    }
    const carry = (await db.collection('meter_occurrence_carry_v1').doc('live').get()).data();
    if (carry?.relay_single_lane_complete !== true) {
      const old = await privateRetentionCollection(db, 'meter_act_keys_v1').doc(intake.pe_id).get();
      if (old.exists) {
        if (old.data()?.pe_hash !== intake.act.pe_hash) throw new Error('relay_occurrence_body_changed');
        await deliver(); await intakeRef.delete(); return null;
      }
    }
  }
  const readDb = batchPricingReadDb(db), pricingCounters = new BatchPricingCounters(true, [intake.act.action_type]), occurrences = new BatchOccurrences(readDb);
  bindBatchOccurrences(readDb, occurrences);
  pricingCounters.addHook(occurrences);
  if (singleLane && !await occurrences.claim(intake.actor_id, relayOccurrenceDigest(intake.pe_id))) {
    // An expired batch cannot be re-priced, counted or re-anchored. Its owner keeps the PE.
    await intakeRef.delete(); return null;
  }
  let captured: MeterActOutcome | null = null;
  // The 30-day rule, on relay acts exactly as on device acts: an act whose
  // occurrence (a chain or forge time when the emitter has one) is more than 30 days old is
  // counted in totals and does not mint. Permanent packed occurrence membership also rejects
  // a replay with a changed observation time. A Genesis grant
  // is exempt — its reservation is its mint-once, kept until it mints, and forbids any
  // time-based reduction of a qualified grant.
  const isGenesisGrant = (intake.accrual as { isGenesisGrant?: unknown }).isGenesisGrant === true;
  const tooOld = !isGenesisGrant && nowMs - intake.act.timestamp > METER_MINT_WINDOW_MS;
  // Shutdown coverage: past the accrual end line a relay act is counted, never minted. It is
  // judged by when the relay committed its intake, so a replay after the line of an act staged
  // before it still settles. The sealing of an existing Genesis reservation is exempt (admission
  // refuses every act from the line; a reservation made before it stays payable).
  const recordOnlyReason = !isGenesisReservationSeal(intake.accrual)
    && accrualEndedAt(intake.created_at_ms)
    ? ACCRUAL_ENDED_REASON
    : tooOld ? 'meter_act_older_than_30_days' : null;
  await record({
    ...(intake.accrual as unknown as RecordPEAccrualParams),
    peId: intake.pe_id,
    peHash: intake.act.pe_hash,
    timestamp: intake.act.timestamp,
    ...(intake.durable ? { throwOnError: true } : {}),
    ...(recordOnlyReason !== null ? { meterRecordOnly: recordOnlyReason } : {}),
    accrualReceivedAtMs: intake.created_at_ms,
    meter: {
      batchHash,
      deviceId: batch.device_id,
      clientPeId: intake.pe_id,
      peHash: intake.act.pe_hash,
      prevHash: intake.act.prev_hash,
      occurrenceAtMs: intake.act.timestamp,
      readDb, pricingCounters, occurrences, singleLane, freshBatch: singleLane,
      batchSightings: new Set<string>(), batchEdges: newBatchOriginEdges(),
      payeeDb: memoizedSettlementDb(db),
      sink: (outcome) => { captured = outcome; },
      facts: actFactsOf(intake.act, { actorId: intake.actor_id, relayAuthored: true }),
    },
  });
  if (captured === null) return null; // a stubbed accrual (tests) sealed nothing
  const outcome: MeterActOutcome = captured;
  await deliver();
  const dropIntake: MeterTxnHook = {
    read: async () => {},
    write: (txn) => { txn.delete(intakeRef); },
  };
  return commitMeterBatch(db, {
    batch,
    batchHash,
    actorId: intake.actor_id,
    expectedTip: null,
    relayAuthored: true,
    relaySingleLane: singleLane,
    acceptedAtMs: nowMs,
    acts: [{ kind: 'priced', outcome }],
    extraWrites: [],
    txnHooks: [dropIntake],
  });
}

/** Re-price relay acts whose emitter died before pricing them (bounded per run). */
export async function replayStuckRelayActs(
  db: Firestore,
  options: { readonly nowMs?: number; readonly limit?: number } = {},
): Promise<{ readonly scanned: number; readonly priced: number; readonly failed: number }> {
  const nowMs = options.nowMs ?? Date.now();
  const snap = await privateRetentionCollection(db, METER_RELAY_ACTS_COLLECTION)
    .where('created_at_ms', '<=', nowMs - METER_RELAY_ACT_REPLAY_AFTER_MS)
    .orderBy('created_at_ms', 'asc')
    .limit(options.limit ?? 200)
    .get();
  let priced = 0;
  let failed = 0;
  for (const doc of snap.docs) {
    try {
      await priceRelayAct(db, doc.data() as RelayActIntake, { nowMs });
      priced += 1;
    } catch (err) {
      failed += 1;
      console.error(`[meter-relay] replay of ${doc.id} failed:`, err);
    }
  }
  return { scanned: snap.docs.length, priced, failed };
}

/**
 * Advance an actor's relay chain with a relay-authored act, for the emitters that do not go
 * through `generatePE` (work-product, onramp, action reports, Genesis ingress, device
 * registration/revocation, human wallet registration). In ONE transaction with the chain-tip
 * advance: the act's intake (act record + accrual inputs + the PE sealed to its owner), its
 * identity act when the type is identity-bearing, and the caller's own co-writes. No envelope.
 * The caller then prices the returned intake with `priceRelayAct` (awaited or not, as before).
 */
export async function advanceRelayAct(
  db: Firestore,
  input: {
    readonly actorId: string;
    readonly walletId: string;
    readonly ownerType?: 'human' | 'agent';
    readonly peId: string;
    readonly timestamp: number;
    readonly actionType: string;
    /** The type the act is priced under, when it differs from the PE's. */
    readonly policyActionType?: string;
    /** Every PE field except the identity slots (schema, pe_id, device_id, prev_hash, timestamp, action_type). */
    readonly content: Record<string, unknown>;
    /** The accrual inputs, from the committed PE hash. Pure. */
    readonly accrual: (peHash: string) => RecordPEAccrualParams;
    /** Set when the caller validated the PE time against the tip before the meter (monotonic order). */
    readonly validateTimestampAgainstTip?: boolean;
    readonly atomicPrecondition?: (txn: Transaction, context: { prevHash: string }) => Promise<void>;
    readonly atomicCoWrite?: (txn: Transaction, context: { prevHash: string; peHash: string }) => void;
    readonly atomicSecondaryWrite?: (txn: Transaction, context: { prevHash: string; peHash: string }) => void;
  },
): Promise<{ readonly prevHash: string; readonly peHash: string; readonly intake: RelayActIntake }> {
  const targets = await resolveRelaySealTargets(db, {
    actorId: input.actorId, walletId: input.walletId, ownerType: input.ownerType,
  });
  const peFor = (prevHash: string): PeV2 => relayPeOf({
    peId: input.peId,
    actorId: input.actorId,
    prevHash,
    timestamp: input.timestamp,
    actionType: input.actionType,
    content: input.content,
  });
  let staged: RelayActIntake | null = null;
  const { prev_hash, new_hash } = await advanceChainTipAtomic(
    db,
    input.actorId,
    (prevHash) => peHashOf(peFor(prevHash)),
    input.validateTimestampAgainstTip === true ? input.timestamp : undefined,
    (txn, { prevHash, newHash }) => {
      const pe = peFor(prevHash);
      const intake = buildRelayActIntake({
        pe,
        actorId: input.actorId,
        accrual: input.accrual(newHash),
        sealed: sealRelayPe(pe, targets),
        nowMs: Date.now(),
      });
      staged = intake;
      stageRelayActInTransaction(txn, db, intake);
      if (isIdentityActType(input.actionType)) {
        stageIdentityActInTransaction(txn, db, buildIdentityAct({
          actorId: input.actorId,
          walletId: input.walletId,
          policyActionType: input.policyActionType ?? input.actionType,
          act: intake.act,
          nowMs: Date.now(),
        }));
      }
      input.atomicCoWrite?.(txn, { prevHash, peHash: newHash });
      input.atomicSecondaryWrite?.(txn, { prevHash, peHash: newHash });
    },
    input.atomicPrecondition,
  );
  const intake = staged as RelayActIntake | null;
  if (intake === null || intake.act.pe_hash !== new_hash) throw new Error('relay_act_not_staged');
  return { prevHash: prev_hash, peHash: new_hash, intake };
}
