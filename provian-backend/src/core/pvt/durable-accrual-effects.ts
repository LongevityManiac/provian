/**
 * Durable derived-accounting outbox for PE accrual.
 *
 * `pe_history` and this exact payload are created in one transaction. All
 * Firestore aggregates are then applied in a second, single transaction that
 * also advances the outbox state. Redis counters use a persistent per-PE Lua
 * claim, so a crash after Redis commit but before the Firestore acknowledgement
 * replays as a no-op. This closes the old "pe_history exists, therefore return"
 * hole that could permanently omit counters after a partial failure.
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import stableStringify from 'json-stable-stringify';
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Transaction,
} from 'firebase-admin/firestore';

import { cache } from '../../cache';
import { isTestPlatformWallet } from './genesis-award-state-machine';
import { getWeekStart } from './week-start';
import { nextWalletWeeklyCounter } from './wallet-ranking-fields';
import { isSolanaAddress } from '../external-address/solana-keys';
import {
  SOLANA_PROVEN_ADDRESSES_COLLECTION,
  isSolanaProvenAddressRecord,
} from '../external-address/solana-link';
import {
  loadFoundationMembershipConfig,
  queueInitialMembershipGrants,
} from '../foundation-membership/client';

export const DURABLE_ACCRUAL_EFFECTS_COLLECTION = 'pvt_accrual_effects';
/**
 * Network counter write shards (H4).
 *
 * Firestore sustains roughly ONE write per second per document, so the shard
 * count IS the network-wide accrual write ceiling: at 10 shards the whole
 * network could not durably record more than ~10 PEs/sec. Raised to 100 for a
 * 10x headroom.
 *
 * SAFE TO RAISE, and safe to raise again: the shard is chosen by
 * `sha256(peId) % NETWORK_SHARD_COUNT`, and `readNetworkCounters` sums EVERY
 * document in the subcollection rather than iterating 0..N-1 — so existing
 * shards keep their values and are still counted, and no migration or backfill
 * is needed. Shards are created lazily on first write, so raising the count
 * costs nothing in reads until traffic actually spreads across them.
 *
 * EXPORTED because `scripts/rebuild-network-pe-counters.ts` needs the same
 * number: it re-declared its own copy, which is the duplicated-literal defect
 * the run contract names — a rebuild running with a stale count would leave the
 * shards above its horizon untouched and silently under-correct the totals.
 */
export const NETWORK_SHARD_COUNT = 100;

export type DurableAccrualCrashPoint =
  | 'before_firestore_effects'
  | 'after_activity_counters'
  | 'after_agent_accrual'
  | 'after_human_accrual'
  | 'after_wallet_aggregates'
  | 'after_network_aggregate'
  | 'after_streak'
  | 'after_x402_count'
  | 'after_firestore_effects'
  | 'before_redis_effects'
  | 'after_redis_effects'
  | 'after_foundation_membership';

export interface DurableAccrualPayload {
  readonly schemaVersion: 'pvt-accrual-effects/v1';
  readonly peId: string;
  readonly userId: string;
  readonly actionType: string;
  readonly category: string;
  readonly timestampMs: number;
  readonly attestationDepth: string;
  readonly estimatedPvt: number;
  readonly agentPvt: number;
  readonly humanPvt: number;
  readonly humanUserId: string | null;
  readonly ownerType: 'human' | 'agent' | null;
  readonly ownerWalletAddress: string | null;
  /** Retired compatibility field. Exact activity reservations are consumed before history. */
  readonly consumeActivityCaps: false;
  readonly counterpartyAddress: string | null;
  readonly countX402: boolean;
  readonly x402PayerAddress: string | null;
  readonly redisCountersRequired: boolean;
}

export interface DurableAccrualEffectDocument {
  readonly schema_version: 'pvt-accrual-effects/v1';
  readonly state: 'pending' | 'firestore_committed' | 'complete';
  readonly payload: DurableAccrualPayload;
  readonly payload_sha256: string;
  readonly attempts: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly firestore_committed_at_ms: number | null;
  readonly foundation_membership_required: boolean | null;
  /**
   * Whether this PE counts toward PUBLIC network aggregates (the
   * pvt_network_stats shards and the pvt:hour display buckets). false when
   * the actor's wallets doc is platform:'test' (the invariant: ,
   * 2026-08-13). Never gates the PE itself, pe_history, the wallet's own
   * pe_count, pvt_accrual, or the anti-abuse counters — PEs remain records;
   * only public statistics skip. Decided inside the firestore-effects
   * transaction; null/absent (pre-existing in-flight docs) means countable.
   */
  readonly network_countable?: boolean | null;
  readonly redis_committed_at_ms: number | null;
  readonly completed_at_ms: number | null;
}

function payloadHash(payload: DurableAccrualPayload): string {
  return crypto.createHash('sha256')
    .update(stableStringify(payload) ?? '', 'utf8')
    .digest('hex');
}

export function createDurableAccrualEffect(
  payload: DurableAccrualPayload,
): DurableAccrualEffectDocument {
  if (payload.schemaVersion !== 'pvt-accrual-effects/v1'
    || !payload.peId || !payload.userId || !payload.actionType || !payload.category
    || !Number.isSafeInteger(payload.timestampMs) || payload.timestampMs < 0
    || !Number.isFinite(payload.estimatedPvt) || payload.estimatedPvt < 0
    || !Number.isFinite(payload.agentPvt) || payload.agentPvt < 0
    || !Number.isFinite(payload.humanPvt) || payload.humanPvt < 0
    || (payload.humanPvt > 0 && !payload.humanUserId)
    || (payload.countX402 && !payload.x402PayerAddress)
    || payload.consumeActivityCaps !== false) {
    throw new Error('durable_accrual_payload_invalid');
  }
  return {
    schema_version: 'pvt-accrual-effects/v1',
    state: 'pending',
    payload,
    payload_sha256: payloadHash(payload),
    attempts: 0,
    created_at_ms: payload.timestampMs,
    updated_at_ms: payload.timestampMs,
    firestore_committed_at_ms: null,
    foundation_membership_required: null,
    network_countable: null,
    redis_committed_at_ms: null,
    completed_at_ms: null,
  };
}

function parseEffect(value: unknown): DurableAccrualEffectDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('durable_accrual_effect_invalid');
  }
  const doc = value as DurableAccrualEffectDocument;
  if (doc.schema_version !== 'pvt-accrual-effects/v1'
    || !['pending', 'firestore_committed', 'complete'].includes(doc.state)
    || !doc.payload || doc.payload.schemaVersion !== 'pvt-accrual-effects/v1'
    || doc.payload.consumeActivityCaps !== false
    || doc.payload.peId.length === 0
    || doc.payload_sha256 !== payloadHash(doc.payload)) {
    throw new Error('durable_accrual_effect_invalid');
  }
  return doc;
}

function crash(point: DurableAccrualCrashPoint, requested?: DurableAccrualCrashPoint): void {
  if (point === requested) throw new Error(`injected_durable_accrual_crash:${point}`);
}

async function firstRef(
  db: Firestore,
  collection: string,
  field: string,
  value: string,
): Promise<DocumentReference | null> {
  const snap = await db.collection(collection).where(field, '==', value).limit(1).get();
  return snap.empty ? null : snap.docs[0].ref;
}

async function resolveWalletRef(db: Firestore, userId: string): Promise<DocumentReference | null> {
  const byField = (await firstRef(db, 'wallets', 'user_id', userId))
    ?? (await firstRef(db, 'wallets', 'agent_id', userId));
  if (byField) return byField;
  // WS4 class fix (the consumer side of the / doc-id defect, mirroring
  // resolveBasePayee in claim-inlet-source.ts): a forge witness seals the `wallets` DOC
  // id as the economic actor. Without this fallback that id matches neither the
  // `user_id` nor the `agent_id` field, so the actor's own pe_count/pvt_earned
  // increment is silently skipped. Resolve it by doc id, id-bound + human-typed;
  // the field queries above stay the primary path.
  if (userId.startsWith('wallet_')) {
    const ref = db.collection('wallets').doc(userId);
    const direct = await ref.get();
    const data = direct.exists ? direct.data() ?? null : null;
    if (data !== null && data.id === userId && data.type === 'human') {
      return ref;
    }
  }
  return null;
}

async function resolveExistingAgentRef(
  db: Firestore,
  userId: string,
): Promise<DocumentReference | null> {
  const byAgent = await firstRef(db, 'agent_wallets', 'agent_id', userId);
  if (byAgent) return byAgent;
  const direct = await db.collection('agent_wallets').doc(userId).get();
  return direct.exists ? direct.ref : null;
}

async function resolveX402Ref(
  db: Firestore,
  address: string | null,
): Promise<DocumentReference | null> {
  if (!address) return null;
  // follow-up — a Solana payer (the x402 facilitator lane): the agent that proved
  // the address in `solana_proven_addresses` is credited, as a native EVM payer's agent wallet is.
  // A person's address, an unproven or invalid row: no agent wallet, no count (never a throw — a
  // display counter must not fail a seal).
  if (isSolanaAddress(address)) {
    const snap = await db.collection(SOLANA_PROVEN_ADDRESSES_COLLECTION).doc(address).get();
    const record: unknown = snap.exists ? snap.data() : undefined;
    if (!isSolanaProvenAddressRecord(record, address) || record.owner_type !== 'agent') return null;
    const wallet = db.collection('agent_wallets').doc(record.wallet_id);
    return (await wallet.get()).exists ? wallet : null;
  }
  let normalized: string;
  try {
    normalized = ethers.getAddress(address).toLowerCase();
  } catch {
    throw new Error('durable_accrual_x402_payer_invalid');
  }
  return firstRef(db, 'agent_wallets', 'address', normalized);
}

function nextAgentAccrual(
  prior: Record<string, unknown> | undefined,
  payload: DurableAccrualPayload,
): Record<string, unknown> {
  const weekStart = getWeekStart(payload.timestampMs);
  const priorWeek = typeof prior?.weekStart === 'number' ? prior.weekStart : null;
  const pesByCategory = { ...asNumberRecord(prior?.pesByCategory) };
  const pvtByCategory = { ...asNumberRecord(prior?.estimatedPVTByCategory) };
  pesByCategory[payload.category] = (pesByCategory[payload.category] ?? 0) + 1;
  pvtByCategory[payload.category] = (pvtByCategory[payload.category] ?? 0) + payload.agentPvt;
  return {
    ...(prior ?? {}),
    userId: payload.userId,
    totalPEs: numberOrZero(prior?.totalPEs) + 1,
    totalEstimatedPVT: numberOrZero(prior?.totalEstimatedPVT) + payload.agentPvt,
    pesByCategory,
    estimatedPVTByCategory: pvtByCategory,
    weeklyPEs: priorWeek === weekStart ? numberOrZero(prior?.weeklyPEs) + 1 : 1,
    weekStart,
    lastPETimestamp: Math.max(numberOrZero(prior?.lastPETimestamp), payload.timestampMs),
    attestationDepth: payload.attestationDepth,
  };
}

function nextHumanAccrual(
  prior: Record<string, unknown> | undefined,
  payload: DurableAccrualPayload,
): Record<string, unknown> {
  const humanUserId = payload.humanUserId!;
  const weekStart = getWeekStart(payload.timestampMs);
  const pvtByCategory = { ...asNumberRecord(prior?.estimatedPVTByCategory) };
  pvtByCategory[payload.category] = (pvtByCategory[payload.category] ?? 0) + payload.humanPvt;
  return {
    ...(prior ?? {}),
    userId: humanUserId,
    totalPEs: numberOrZero(prior?.totalPEs) + 1,
    totalEstimatedPVT: numberOrZero(prior?.totalEstimatedPVT) + payload.humanPvt,
    pesByCategory: prior?.pesByCategory ?? {},
    estimatedPVTByCategory: pvtByCategory,
    weeklyPEs: typeof prior?.weeklyPEs === 'number' ? prior.weeklyPEs : 0,
    weekStart,
    lastPETimestamp: Math.max(numberOrZero(prior?.lastPETimestamp), payload.timestampMs),
    // The beneficiary receives a routed share of this PE; linkage is not
    // attestation evidence. Mirror the source PE's actual tier exactly.
    attestationDepth: payload.attestationDepth,
  };
}

function asNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function deterministicNetworkShard(peId: string): number {
  return Number.parseInt(crypto.createHash('sha256').update(peId).digest('hex').slice(0, 8), 16)
    % NETWORK_SHARD_COUNT;
}

function snapshotByPath(
  refs: readonly DocumentReference[],
  snaps: readonly DocumentSnapshot[],
): Map<string, DocumentSnapshot> {
  const out = new Map<string, DocumentSnapshot>();
  refs.forEach((ref, index) => out.set(refKey(ref), snaps[index]));
  return out;
}

function refKey(ref: DocumentReference): string {
  const testRef = ref as DocumentReference & { collectionPath?: string };
  return ref.path ?? `${testRef.collectionPath ?? ''}/${ref.id}`;
}

function setIncremented(
  txn: Transaction,
  ref: DocumentReference,
  snap: DocumentSnapshot | undefined,
  fields: Record<string, unknown>,
): void {
  void snap;
  txn.set(ref, fields, { merge: true });
}

interface ResolvedEffectRefs {
  readonly effect: DocumentReference;
  readonly history: DocumentReference;
  readonly agentAccrual: DocumentReference;
  readonly humanAccrual: DocumentReference | null;
  readonly agentWallet: DocumentReference | null;
  readonly humanWallet: DocumentReference | null;
  readonly streakAgent: DocumentReference | null;
  readonly x402Agent: DocumentReference | null;
  readonly networkShard: DocumentReference;
}

async function resolveRefs(
  db: Firestore,
  payload: DurableAccrualPayload,
): Promise<ResolvedEffectRefs> {
  const refs: ResolvedEffectRefs = {
    effect: db.collection(DURABLE_ACCRUAL_EFFECTS_COLLECTION).doc(payload.peId),
    history: db.collection('pe_history').doc(payload.peId),
    agentAccrual: db.collection('pvt_accrual').doc(payload.userId),
    humanAccrual: payload.humanPvt > 0 && payload.humanUserId
      ? db.collection('pvt_accrual').doc(payload.humanUserId)
      : null,
    agentWallet: await resolveWalletRef(db, payload.userId),
    humanWallet: payload.humanPvt > 0 && payload.humanUserId
      ? await resolveWalletRef(db, payload.humanUserId)
      : null,
    streakAgent: payload.ownerType === 'human'
      ? null
      : await resolveExistingAgentRef(db, payload.userId),
    x402Agent: payload.countX402
      ? await resolveX402Ref(db, payload.x402PayerAddress)
      : null,
    networkShard: db.collection('pvt_network_stats')
      .doc('global')
      .collection('shards')
      .doc(`shard_${deterministicNetworkShard(payload.peId)}`),
  };
  if (payload.humanPvt > 0 && refs.humanWallet === null) {
    throw new Error('durable_accrual_human_wallet_unresolved');
  }
  if (payload.ownerType === 'agent' && refs.streakAgent === null) {
    throw new Error('durable_accrual_agent_wallet_unresolved');
  }
  if (payload.countX402 && refs.x402Agent === null) {
    throw new Error('durable_accrual_x402_wallet_unresolved');
  }
  return refs;
}

async function applyFirestoreEffects(
  db: Firestore,
  effect: DurableAccrualEffectDocument,
  crashAt?: DurableAccrualCrashPoint,
): Promise<void> {
  crash('before_firestore_effects', crashAt);
  const payload = effect.payload;
  const refs = await resolveRefs(db, payload);
  const allRefs = Object.values(refs).filter((ref): ref is DocumentReference => ref !== null);
  await db.runTransaction(async (txn) => {
    const snaps = await Promise.all(allRefs.map((ref) => txn.get(ref)));
    const byPath = snapshotByPath(allRefs, snaps);
    const effectSnap = byPath.get(refKey(refs.effect));
    const current = parseEffect(effectSnap?.data());
    if (current.state !== 'pending') return;
    if (current.payload_sha256 !== effect.payload_sha256) {
      throw new Error('durable_accrual_effect_conflict');
    }
    const history = byPath.get(refKey(refs.history));
    const historyData = history?.data() as Record<string, unknown> | undefined;
    if (!history?.exists
      || historyData?.peId !== payload.peId
      || historyData?.userId !== payload.userId
      || historyData?.actionType !== payload.actionType) {
      throw new Error('durable_accrual_history_binding_invalid');
    }

    // Activity-cap counters are never a derived effect. They were consumed by
    // the exact reservation transaction before this history/effect was sealed.
    crash('after_activity_counters', crashAt);

    const agentAccrualSnap = byPath.get(refKey(refs.agentAccrual));
    txn.set(refs.agentAccrual, nextAgentAccrual(agentAccrualSnap?.data(), payload));
    crash('after_agent_accrual', crashAt);

    if (refs.humanAccrual) {
      const humanAccrualSnap = byPath.get(refKey(refs.humanAccrual));
      txn.set(refs.humanAccrual, nextHumanAccrual(humanAccrualSnap?.data(), payload));
    }
    crash('after_human_accrual', crashAt);

    if (refs.agentWallet) {
      const snap = byPath.get(refKey(refs.agentWallet));
      setIncremented(txn, refs.agentWallet, snap, {
        pe_count: numberOrZero(snap?.data()?.pe_count) + 1,
        pvt_earned: numberOrZero(snap?.data()?.pvt_earned) + payload.agentPvt,
        // H2 — the ACTOR's weekly count lives on its wallet doc so the
        // weekly leaderboard is one bounded indexed query instead of a full
        // pvt_accrual scan. Actor only (not the beneficiary human): the weekly
        // board has always ranked the actor's own PEs, mirroring
        // nextAgentAccrual's weeklyPEs roll, which nextHumanAccrual never bumps.
        ...nextWalletWeeklyCounter(snap?.data(), payload.timestampMs),
      });
    }
    if (refs.humanWallet) {
      const snap = byPath.get(refKey(refs.humanWallet));
      setIncremented(txn, refs.humanWallet, snap, {
        pe_count: numberOrZero(snap?.data()?.pe_count) + 1,
        pvt_earned: numberOrZero(snap?.data()?.pvt_earned) + payload.humanPvt,
      });
    }
    crash('after_wallet_aggregates', crashAt);

    // Public-aggregate gate (WS4, Unknown = Block — the / test-exclusion
    // discipline, third surface): a test-platform actor's PE records fully (the
    // history binding, its own wallet pe_count, and pvt_accrual all wrote above)
    // but moves NO public network counter — AND an actor we cannot resolve to any
    // wallet at all is NOT counted either. The prior default-countable-on-missing
    // behavior FAILED OPEN: an unresolvable actor (a doc-id-keyed PE before the
    // resolveWalletRef doc-id fallback, or a synthetic e2e/smoke id) counted as a
    // real network PE. The resolveWalletRef doc-id fallback above is what keeps a
    // REAL doc-id actor resolvable (refs.agentWallet non-null), so it still counts;
    // this flip only stops the genuinely-unresolvable ones.
    //
    // (WS2 battery) — the actor ref is the `wallets` doc resolveWalletRef
    // found (human, or an agent that also has one), ELSE the agent_wallets doc.
    // `refs.streakAgent` is already resolved for EVERY non-human actor (see the
    // refs block: `ownerType === 'human' ? null : resolveExistingAgentRef(...)`),
    // so it is non-null for an `ownerType: 'agent'` PE AND for an ownerType-absent
    // one — and real financial PEs (receive/send) carry NO ownerType. Gating its
    // use on `ownerType === 'agent'` therefore dropped every real agent's financial
    // activity from the network total, contradicting this comment's own claim that
    // "a real agent with no wallets doc still counts." Use streakAgent whenever it
    // resolves: humans have none (they use agentWallet), a genuinely-unresolvable
    // actor still yields null → not counted (fail-closed intact), and a test-platform
    // agent is still excluded by isTestPlatformWallet below.
    const actorRef = refs.agentWallet ?? refs.streakAgent;
    const actorWalletSnap = actorRef ? byPath.get(refKey(actorRef)) : undefined;
    const networkCountable = actorRef !== null && !isTestPlatformWallet(actorWalletSnap?.data());

    if (networkCountable) {
      const networkSnap = byPath.get(refKey(refs.networkShard));
      setIncremented(txn, refs.networkShard, networkSnap, {
        totalPEs: numberOrZero(networkSnap?.data()?.totalPEs) + 1,
        totalEstimatedPVT: numberOrZero(networkSnap?.data()?.totalEstimatedPVT)
          + payload.estimatedPvt,
      });
    }
    crash('after_network_aggregate', crashAt);

    if (refs.streakAgent) {
      const snap = byPath.get(refKey(refs.streakAgent));
      const data = snap?.data() as Record<string, unknown> | undefined;
      if (snap?.exists && data?.platform !== 'test') {
        const today = new Date(payload.timestampMs).toISOString().slice(0, 10);
        const last = typeof data?.last_pe_date === 'string' && data.last_pe_date
          ? data.last_pe_date
          : null;
        const next = computeNextStreak(last, today, numberOrZero(data?.streak_days));
        if (next !== null) {
          setIncremented(txn, refs.streakAgent, snap, {
            streak_days: next,
            last_pe_date: today,
            updated_at: payload.timestampMs,
          });
        }
      }
    }
    crash('after_streak', crashAt);

    if (refs.x402Agent) {
      const snap = byPath.get(refKey(refs.x402Agent));
      if (snap?.exists && snap.data()?.platform !== 'test') {
        setIncremented(txn, refs.x402Agent, snap, {
          x402_payment_count: numberOrZero(snap.data()?.x402_payment_count) + 1,
          updated_at: payload.timestampMs,
        });
      }
    }
    crash('after_x402_count', crashAt);

    const now = Date.now();
    txn.set(refs.effect, {
      ...current,
      state: 'firestore_committed',
      attempts: current.attempts + 1,
      updated_at_ms: now,
      firestore_committed_at_ms: now,
      foundation_membership_required: payload.ownerType === 'human'
        && payload.ownerWalletAddress !== null
        && !agentAccrualSnap?.exists,
      network_countable: networkCountable,
    });
  });
  crash('after_firestore_effects', crashAt);
}

function computeNextStreak(lastPeDate: string | null, today: string, prevStreak: number): number | null {
  if (!lastPeDate) return 1;
  if (lastPeDate === today) return null;
  const diffDays = Math.round((Date.parse(today) - Date.parse(lastPeDate)) / 86_400_000);
  if (diffDays === 1) return Math.max(0, prevStreak) + 1;
  if (diffDays >= 2) return 1;
  return null;
}

/** Resume every omitted derived effect exactly once. */
export async function resumeDurableAccrualEffects(
  db: Firestore,
  peId: string,
  crashAt?: DurableAccrualCrashPoint,
): Promise<'complete' | 'recovered'> {
  const ref = db.collection(DURABLE_ACCRUAL_EFFECTS_COLLECTION).doc(peId);
  let snap = await ref.get();
  if (!snap.exists) throw new Error('durable_accrual_effect_missing');
  let effect = parseEffect(snap.data());
  if (effect.payload.peId !== peId) throw new Error('durable_accrual_effect_id_mismatch');
  if (effect.state === 'complete') return 'complete';
  if (effect.state === 'pending') {
    await applyFirestoreEffects(db, effect, crashAt);
    snap = await ref.get();
    effect = parseEffect(snap.data());
  }
  if (effect.state !== 'firestore_committed') {
    throw new Error('durable_accrual_effect_state_invalid');
  }
  crash('before_redis_effects', crashAt);
  if (effect.payload.redisCountersRequired) {
    // Anti-abuse counters (pe_rate/occ) are ALWAYS consumed — a test wallet
    // spends its rate slots like anyone else. Only the pvt:hour display
    // bucket is skipped when the firestore leg marked this PE not network
    // countable (absent field on pre-existing in-flight docs = countable).
    await cache.commitPEAccountingCountersOnce({
      peId,
      userId: effect.payload.userId,
      actionType: effect.payload.actionType,
      timestampMs: effect.payload.timestampMs,
      countNetworkHourly: effect.network_countable !== false,
    });
  }
  crash('after_redis_effects', crashAt);
  if (effect.foundation_membership_required === true && effect.payload.ownerWalletAddress) {
    await queueInitialMembershipGrants(
      db,
      loadFoundationMembershipConfig(),
      effect.payload.userId,
      effect.payload.ownerWalletAddress,
    );
  }
  crash('after_foundation_membership', crashAt);
  await db.runTransaction(async (txn) => {
    const currentSnap = await txn.get(ref);
    const current = parseEffect(currentSnap.data());
    if (current.state === 'complete') return;
    if (current.state !== 'firestore_committed'
      || current.payload_sha256 !== effect.payload_sha256) {
      throw new Error('durable_accrual_effect_conflict');
    }
    const now = Date.now();
    txn.set(ref, {
      ...current,
      state: 'complete',
      updated_at_ms: now,
      redis_committed_at_ms: effect.payload.redisCountersRequired ? now : null,
      completed_at_ms: now,
    });
  });
  return 'recovered';
}

// =============================================================================
// PE METER — the same derived effects, applied ONCE PER BATCH (2026-10-03)
// =============================================================================
//
// A metered batch keeps no per-PE outbox: its acts' derived effects (pvt_accrual, the wallet
// pe_count/pvt_earned display totals, the network shards, the streak, the x402 count) are folded
// in memory with the SAME `nextAgentAccrual` / `nextHumanAccrual` / streak rules and written in
// the batch's commit transaction. The device tip in that transaction is what makes them apply
// exactly once: a re-sent batch is answered from the tip and never re-applies anything.

export interface MeterBatchEffectsPlan {
  readonly payloads: readonly DurableAccrualPayload[];
  readonly refsByPeId: ReadonlyMap<string, Omit<ResolvedEffectRefs, 'effect' | 'history'>>;
  readonly allRefs: readonly DocumentReference[];
}

/**
 * Resolve every document the batch's effects touch (outside the transaction; memoized per actor).
 * `networkShardKey` (the batch hash) puts ALL of a batch's network increments on ONE shard: the
 * network totals are the sum over every shard, so the totals are identical, and the shard spread
 * still comes from many batches — one shard read and write per batch instead of one per act.
 */
export async function prepareMeterBatchEffects(
  db: Firestore,
  payloads: readonly DurableAccrualPayload[],
  networkShardKey?: string,
): Promise<MeterBatchEffectsPlan> {
  const walletMemo = new Map<string, Promise<DocumentReference | null>>();
  const agentMemo = new Map<string, Promise<DocumentReference | null>>();
  const x402Memo = new Map<string, Promise<DocumentReference | null>>();
  const wallet = (id: string) => {
    if (!walletMemo.has(id)) walletMemo.set(id, resolveWalletRef(db, id));
    return walletMemo.get(id) as Promise<DocumentReference | null>;
  };
  const agent = (id: string) => {
    if (!agentMemo.has(id)) agentMemo.set(id, resolveExistingAgentRef(db, id));
    return agentMemo.get(id) as Promise<DocumentReference | null>;
  };
  const x402 = (address: string | null) => {
    const key = address ?? '';
    if (!x402Memo.has(key)) x402Memo.set(key, resolveX402Ref(db, address));
    return x402Memo.get(key) as Promise<DocumentReference | null>;
  };
  const refsByPeId = new Map<string, Omit<ResolvedEffectRefs, 'effect' | 'history'>>();
  const unique = new Map<string, DocumentReference>();
  for (const payload of payloads) {
    const refs = {
      agentAccrual: db.collection('pvt_accrual').doc(payload.userId),
      humanAccrual: payload.humanPvt > 0 && payload.humanUserId
        ? db.collection('pvt_accrual').doc(payload.humanUserId)
        : null,
      agentWallet: await wallet(payload.userId),
      humanWallet: payload.humanPvt > 0 && payload.humanUserId ? await wallet(payload.humanUserId) : null,
      streakAgent: payload.ownerType === 'human' ? null : await agent(payload.userId),
      x402Agent: payload.countX402 ? await x402(payload.x402PayerAddress) : null,
      networkShard: db.collection('pvt_network_stats').doc('global').collection('shards')
        .doc(`shard_${deterministicNetworkShard(networkShardKey ?? payload.peId)}`),
    };
    refsByPeId.set(payload.peId, refs);
    for (const ref of Object.values(refs)) {
      if (ref) unique.set(refKey(ref), ref);
    }
  }
  return { payloads, refsByPeId, allRefs: [...unique.values()] };
}

/** Read every touched document inside the batch transaction (all reads before any write). */
export async function readMeterBatchEffects(
  txn: Transaction,
  plan: MeterBatchEffectsPlan,
): Promise<Map<string, Record<string, unknown> | undefined>> {
  const snaps = await Promise.all(plan.allRefs.map((ref) => txn.get(ref)));
  const state = new Map<string, Record<string, unknown> | undefined>();
  plan.allRefs.forEach((ref, i) => state.set(refKey(ref), snaps[i].exists ? (snaps[i].data() as Record<string, unknown>) : undefined));
  return state;
}

/** Fold every payload over the read state and write each touched document once. */
export function applyMeterBatchEffects(
  txn: Transaction,
  plan: MeterBatchEffectsPlan,
  state: Map<string, Record<string, unknown> | undefined>,
): { networkCountable: Map<string, boolean> } {
  const dirty = new Map<string, DocumentReference>();
  const networkCountable = new Map<string, boolean>();
  const put = (ref: DocumentReference, next: Record<string, unknown>) => {
    state.set(refKey(ref), next);
    dirty.set(refKey(ref), ref);
  };
  const get = (ref: DocumentReference) => state.get(refKey(ref));
  for (const payload of plan.payloads) {
    const refs = plan.refsByPeId.get(payload.peId);
    if (!refs) continue;
    put(refs.agentAccrual, nextAgentAccrual(get(refs.agentAccrual), payload));
    if (refs.humanAccrual) put(refs.humanAccrual, nextHumanAccrual(get(refs.humanAccrual), payload));
    if (refs.agentWallet) {
      const prior = get(refs.agentWallet);
      put(refs.agentWallet, {
        ...(prior ?? {}),
        pe_count: numberOrZero(prior?.pe_count) + 1,
        pvt_earned: numberOrZero(prior?.pvt_earned) + payload.agentPvt,
        ...nextWalletWeeklyCounter(prior, payload.timestampMs),
      });
    }
    if (refs.humanWallet) {
      const prior = get(refs.humanWallet);
      put(refs.humanWallet, {
        ...(prior ?? {}),
        pe_count: numberOrZero(prior?.pe_count) + 1,
        pvt_earned: numberOrZero(prior?.pvt_earned) + payload.humanPvt,
      });
    }
    const actorRef = refs.agentWallet ?? refs.streakAgent;
    const countable = actorRef !== null && !isTestPlatformWallet(get(actorRef));
    networkCountable.set(payload.peId, countable);
    if (countable) {
      const prior = get(refs.networkShard);
      put(refs.networkShard, {
        ...(prior ?? {}),
        totalPEs: numberOrZero(prior?.totalPEs) + 1,
        totalEstimatedPVT: numberOrZero(prior?.totalEstimatedPVT) + payload.estimatedPvt,
      });
    }
    if (refs.streakAgent) {
      const prior = get(refs.streakAgent);
      if (prior !== undefined && prior.platform !== 'test') {
        const today = new Date(payload.timestampMs).toISOString().slice(0, 10);
        const last = typeof prior.last_pe_date === 'string' && prior.last_pe_date ? prior.last_pe_date : null;
        const next = computeNextStreak(last, today, numberOrZero(prior.streak_days));
        if (next !== null) {
          put(refs.streakAgent, { ...prior, streak_days: next, last_pe_date: today, updated_at: payload.timestampMs });
        }
      }
    }
    if (refs.x402Agent) {
      const prior = get(refs.x402Agent);
      if (prior !== undefined && prior.platform !== 'test') {
        put(refs.x402Agent, { ...prior, x402_payment_count: numberOrZero(prior.x402_payment_count) + 1, updated_at: payload.timestampMs });
      }
    }
  }
  for (const [key, ref] of dirty) txn.set(ref, state.get(key) as Record<string, unknown>, { merge: true });
  return { networkCountable };
}

/** The Redis economic counters, once per act (idempotent per pe id), after the batch commits. */
export async function commitMeterBatchCounters(
  payloads: readonly DurableAccrualPayload[],
  networkCountable: ReadonlyMap<string, boolean>,
): Promise<void> {
  for (const payload of payloads) {
    if (!payload.redisCountersRequired) continue;
    await cache.commitPEAccountingCountersOnce({
      peId: payload.peId,
      userId: payload.userId,
      actionType: payload.actionType,
      timestampMs: payload.timestampMs,
      countNetworkHourly: networkCountable.get(payload.peId) !== false,
    });
  }
}
