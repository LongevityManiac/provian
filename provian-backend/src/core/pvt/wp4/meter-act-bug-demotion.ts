import { privateRetentionCollection } from '../../provenance/private-retention';
/**
 * Bug demotion for a METERED act whose row lives on its batch's act page (a single-lane act,
 * — no act key).
 *
 * The same rule as `bug-demotion.ts` an act leaves settlement only when a named, checked-in
 * detector proves the exact producer bug. Operator suspicion, value, or a free-form reason is never
 * sufficient. The sealed PE and its economic snapshot are never rewritten; the act's row is moved to
 * `record_only` and its share is taken out of every still-pending claim, atomically
 * (`mutatePeHistoryRowWithAggregate` with the act's batch named), and an immutable audit records
 * the proof. A claim that has left `pending` refuses the demotion.
 *
 * The relay holds no PE, so a detector's evidence is PRESENTED — and is admitted only
 * where it binds to what the relay sealed: the presented PE must hash to the act's sealed
 * `pe_hash`, which covers the complete PE.
 */

import crypto from 'crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { mutatePeHistoryRowWithAggregate } from '../policy/economic-aggregate';
import { BUG_DEMOTION_COLLECTION, CLAIM_LEDGER_COLLECTION } from './durable-settlement-store';
import { METER_BATCHES_COLLECTION, METER_PENDING_CLAIMS_COLLECTION } from '../../meter/meter-store';
import { METER_BATCH_ACTS_COLLECTION, meterActPageId, type MeterPageAct } from '../../meter/meter-act-pages';
import { actClaimKeysOf } from '../../meter/meter-claims';
import { peHashOf, type PeV2 } from '../../meter/meter-wire';
import { DEMOTION_HOLD_DEFAULT_TTL_MS, DEMOTION_HOLD_MAX_TTL_MS, liveDemotionHold, openDemotionHold, releaseDemotionHold, renewDemotionHold } from '../../meter/meter-demotion-hold';
import { deviceSubmitPeContentFromStored, deviceSubmitPeHash } from '../../agent-wallet/device-submit-pe-hash';
import { deriveLegClaimId, type SealedEnvelopeIdentity } from '../wp-ev/claim-id';

export const METER_ACT_BUG_DEMOTION_SCHEMA = 'pvt9-meter-act-bug-demotion/v1';

export interface MeterActBugProof {
  readonly detector_id: string;
  readonly detector_version: string;
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
}

/** What a detector may read to bind presented evidence to records the relay sealed itself. */
export interface MeterActBugDetectorContext {
  /** The act's row on its batch's act page, or null. */
  readMeterAct(batchHash: string, relayPeId: string): Promise<MeterPageAct | null>;
  /** One `pvt9_claim_ledger_v1` row (pre-meter claims), or null. */
  readClaimLedger(claimKey: string): Promise<Record<string, unknown> | null>;
}

export interface MeterActBugDetector {
  readonly id: string;
  readonly version: string;
  /** Null unless the presented evidence proves the producer bug for THIS sealed act. */
  prove(input: { readonly act: MeterPageAct; readonly evidence: unknown; readonly ctx: MeterActBugDetectorContext }): Promise<MeterActBugProof | null>;
}

// ── transcript_rewitnessed_turn ───────────────────────────────────────────────────────────────

export const TRANSCRIPT_REWITNESSED_TURN_ID = 'transcript_rewitnessed_turn';

/** The transcript lane's call-id-anchored turn id (`provian-agent-sdk/src/observer/plugins/turn-identity.ts`). */
export function transcriptTurnIdOfCallIds(callIds: readonly string[]): string | null {
  const ids = [...new Set(callIds.map((c) => (typeof c === 'string' ? c.trim() : '')).filter((c) => c.length > 0))].sort();
  if (ids.length === 0) return null;
  return `tc:${crypto.createHash('sha256').update(ids.join('\x1f'), 'utf8').digest('hex')}`;
}

/**
 * The model response a tool-call id names, when the harness embeds it. OpenClaw writes a call id
 * as `call-<uuid>-<n>|fc_<response id>_<k>`; the model proxy seals that response's id as
 * `metadata.response_id`. Null for any other shape.
 */
export function responseIdOfCallId(callId: string): string | null {
  const bar = callId.lastIndexOf('|');
  if (bar < 0) return null;
  const m = /^fc_(.+)_(\d+)$/.exec(callId.slice(bar + 1).trim());
  return m ? m[1] : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || x.trim().length === 0) return null;
    out.push(x.trim());
  }
  return out;
}

/** The tool calls a sealed witness covers: the calls its own `turn_id` binds, and the calls of the
 *  model response its `response_id` names. Calls not so bound are not covered. */
function coveredBy(metadata: unknown, presentedCalls: unknown, dupCalls: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (!isRecord(metadata)) return out;
  const calls = presentedCalls === undefined ? null : stringList(presentedCalls);
  if (calls !== null && typeof metadata.turn_id === 'string' && transcriptTurnIdOfCallIds(calls) === metadata.turn_id) {
    for (const c of calls) if (dupCalls.has(c)) out.add(c);
  }
  if (typeof metadata.response_id === 'string' && metadata.response_id.length > 0) {
    for (const c of dupCalls) if (responseIdOfCallId(c) === metadata.response_id) out.add(c);
  }
  return out;
}

const LEGACY_LEGS = ['sole', 'agent', 'beneficiary'] as const;

/**
 * A pre-meter device PE that MINTED: its stored content re-hashes to its `hash`
 * (`deviceSubmitPeHash`, the writer's own function), and a claim-ledger row keyed by its id carries
 * the claim id derived from its identity (which binds `user_id`) and is SETTLED on chain — never a
 * row that is still open, nor one a bug demotion stamped (settlement skips those for good). The
 * device is the act's device (`metadata.source_device_id`, inside the hash); the owner is the act's
 * actor; it is earlier. A settled claim cannot be undone, so this witness can never stop minting.
 */
async function legacyWitness(act: MeterPageAct, w: Record<string, unknown>, ctx: MeterActBugDetectorContext): Promise<{ id: string; ts: number; md: unknown; settled: boolean } | null> {
  const env = w.envelope;
  if (!isRecord(env)) return null;
  if (typeof env.id !== 'string' || typeof env.hash !== 'string' || typeof env.timestamp !== 'number') return null;
  if (deviceSubmitPeHash(deviceSubmitPeContentFromStored(env)) !== env.hash) return null;
  if (env.action_type !== act.action_type || env.user_id !== act.actor_id) return null;
  if (!isRecord(env.metadata) || env.metadata.source_device_id !== act.device_id) return null;
  if (!(env.timestamp < act.timestamp)) return null;
  let settled = false;
  for (const leg of LEGACY_LEGS) {
    const row = await ctx.readClaimLedger(`${env.id}#${leg}`);
    if (row === null) continue;
    const derived = deriveLegClaimId(env as unknown as SealedEnvelopeIdentity, leg);
    if (derived.kind !== 'derived' || row.claim_id !== derived.claimId || row.pe_key !== env.id) continue;
    if (row.bug_demoted_at_ms != null || row.bug_demotion_id != null) continue;
    if (row.settled === true && typeof row.settled_tx_hash === 'string' && row.settled_tx_hash.length > 0) settled = true;
  }
  if (!settled) return null;
  return { id: `legacy:${env.id}`, ts: env.timestamp, md: env.metadata, settled };
}

/**
 * An earlier metered act of the same device and actor that the relay sealed eligible (or that this
 * detector demoted, whose calls an earlier witness covers in turn — the witness order is strictly
 * earlier, so a chain always ends at a witness that mints). Once it witnesses a demotion it cannot
 * itself be demoted (`demoteBugProducedMeterAct` refuses an act named in a demotion's `witness_ids`),
 * so the chain cannot later be cut.
 */
async function meterWitness(act: MeterPageAct, w: Record<string, unknown>, ctx: MeterActBugDetectorContext): Promise<{ id: string; ts: number; md: unknown; settled: boolean } | null> {
  if (typeof w.batch_hash !== 'string' || typeof w.relay_pe_id !== 'string' || !isRecord(w.pe)) return null;
  const sealed = await ctx.readMeterAct(w.batch_hash, w.relay_pe_id);
  if (sealed === null) return null;
  let hash: string;
  try { hash = peHashOf(w.pe as unknown as PeV2); } catch { return null; }
  if (hash !== sealed.pe_hash) return null;
  if (sealed.device_id !== act.device_id || sealed.actor_id !== act.actor_id || sealed.action_type !== act.action_type) return null;
  if (!(sealed.timestamp < act.timestamp)) return null;
  const row = sealed.row as Record<string, unknown>;
  const minting = row.mint_status === 'eligible' && row.mint_disposition === 'eligible';
  const demotedByThis = typeof row.bug_demotion_id === 'string' && row.bug_detector_id === TRANSCRIPT_REWITNESSED_TURN_ID;
  if (!minting && !demotedByThis) return null;
  return { id: `meter:${w.relay_pe_id}`, ts: sealed.timestamp, md: (w.pe as Record<string, unknown>).metadata, settled: false };
}


/**
 * 2026-10-07 (Atlas's Mini): delisting a harness from `proxy-routed-harnesses.json` and restarting
 * the daemon made the transcript lane re-read every stored session and emit its old turns as
 * minting `agent_tool_orchestration` acts — turns a sealed witness (the proxy, or the transcript
 * lane itself) had already minted when they ran.
 *
 * Proof, resting only on records the relay sealed:
 *   - the presented PE hashes to the act's sealed `pe_hash` and is the device's transcript-lane
 *     `agent_tool_orchestration`; the presented call ids hash to its sealed `turn_id`;
 *   - EVERY one of those calls is covered by an earlier witness of the same device and actor that
 *     minted: a pre-meter PE with a claim-ledger row bound to its identity, or an earlier metered
 *     act sealed eligible — each covering the calls its own sealed `turn_id` binds or the calls of
 *     the model response its sealed `response_id` names;
 *   - each presented witness covers at least one of the calls.
 * Nothing presented that the relay did not seal (a call time, an operator note) enters the proof.
 */
export const transcriptRewitnessedTurnDetector: MeterActBugDetector = {
  id: TRANSCRIPT_REWITNESSED_TURN_ID,
  version: '1',
  async prove({ act, evidence, ctx }) {
    if (act.action_type !== 'agent_tool_orchestration') return null;
    if (!isRecord(evidence) || !isRecord(evidence.pe) || !Array.isArray(evidence.witnesses) || evidence.witnesses.length === 0) return null;
    const pe = evidence.pe as unknown as PeV2;
    let hash: string;
    try { hash = peHashOf(pe); } catch { return null; }
    if (hash !== act.pe_hash) return null;
    if (pe.device_id !== act.device_id || pe.timestamp !== act.timestamp || pe.action_type !== act.action_type) return null;
    const md = isRecord(pe.metadata) ? pe.metadata : null;
    if (md === null || md.source !== 'transcript') return null;
    const turnId = typeof md.turn_id === 'string' ? md.turn_id : null;
    if (turnId === null || !turnId.startsWith('tc:')) return null;
    const calls = stringList(evidence.calls);
    if (calls === null || transcriptTurnIdOfCallIds(calls) !== turnId) return null;
    const dup = new Set(calls);

    const covered = new Set<string>();
    const ids: string[] = [];
    let earliest = Number.POSITIVE_INFINITY;
    let latest = Number.NEGATIVE_INFINITY;
    let settledLegacy = 0;
    for (const w of evidence.witnesses) {
      if (!isRecord(w)) return null;
      const found = w.kind === 'legacy_pe' ? await legacyWitness(act, w, ctx)
        : w.kind === 'meter_act' ? await meterWitness(act, w, ctx)
          : null;
      if (found === null || ids.includes(found.id)) return null;
      const cov = coveredBy(found.md, w.calls, dup);
      if (cov.size === 0) return null;
      for (const c of cov) covered.add(c);
      ids.push(found.id);
      earliest = Math.min(earliest, found.ts);
      latest = Math.max(latest, found.ts);
      if (found.settled) settledLegacy += 1;
    }
    if (covered.size !== dup.size) return null;
    return {
      detector_id: TRANSCRIPT_REWITNESSED_TURN_ID,
      detector_version: '1',
      evidence: {
        pe_hash: act.pe_hash,
        device_id: act.device_id,
        actor_id: act.actor_id,
        turn_id: turnId,
        session_fingerprint: typeof md.session_fingerprint === 'string' ? md.session_fingerprint : null,
        turn_index: typeof md.turn_index === 'number' ? md.turn_index : null,
        harness: typeof md.harness === 'string' ? md.harness : null,
        call_count: dup.size,
        witnesses: [...ids].sort().join(','),
        witness_count: ids.length,
        settled_legacy_witnesses: settledLegacy,
        earliest_witness_ms: earliest,
        latest_witness_ms: latest,
        sealed_at_ms: act.timestamp,
      },
    };
  },
};

/** Adding a detector is reviewed code plus tests; it is not operator-entered policy. */
export const PRODUCTION_METER_ACT_BUG_DETECTORS: Readonly<Record<string, MeterActBugDetector>> = Object.freeze({
  [transcriptRewitnessedTurnDetector.id]: transcriptRewitnessedTurnDetector,
});

// ── the demotion ──────────────────────────────────────────────────────────────────────────────

export type MeterActBugDemotionResult =
  | { readonly kind: 'dry_run_proved'; readonly proof: MeterActBugProof; readonly claim_keys: readonly string[] }
  | { readonly kind: 'demoted'; readonly demotion_id: string; readonly proof: MeterActBugProof; readonly claim_keys: readonly string[] }
  | { readonly kind: 'already_demoted'; readonly demotion_id: string }
  | { readonly kind: 'refused'; readonly reason: string };

function proofDigest(proof: MeterActBugProof): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    detector_id: proof.detector_id,
    detector_version: proof.detector_version,
    evidence: Object.fromEntries(Object.entries(proof.evidence).sort(([a], [b]) => a.localeCompare(b))),
  })).digest('hex');
}

async function readPageAct(db: Firestore, batchHash: string, relayPeId: string): Promise<MeterPageAct | null> {
  const batch = await db.collection(METER_BATCHES_COLLECTION).doc(batchHash).get();
  const pages = batch.exists ? Number((batch.data() ?? {}).act_pages ?? 0) : 0;
  for (let i = 0; i < pages; i += 1) {
    const snap = await privateRetentionCollection(db, METER_BATCH_ACTS_COLLECTION).doc(meterActPageId(batchHash, i)).get();
    const acts = snap.exists ? (snap.data() ?? {}).acts : undefined;
    const act = isRecord(acts) ? acts[relayPeId] : undefined;
    if (isRecord(act) && isRecord(act.row) && act.batch_hash === batchHash) return act as unknown as MeterPageAct;
  }
  return null;
}

/** `readPageAct` inside a transaction (every read before any write). */
async function readPageActInTxn(
  txn: Transaction, db: Firestore, batchHash: string, relayPeId: string,
): Promise<MeterPageAct | null> {
  const batch = await txn.get(db.collection(METER_BATCHES_COLLECTION).doc(batchHash));
  const pages = batch.exists ? Number((batch.data() ?? {}).act_pages ?? 0) : 0;
  for (let i = 0; i < pages; i += 1) {
    const snap = await txn.get(privateRetentionCollection(db, METER_BATCH_ACTS_COLLECTION).doc(meterActPageId(batchHash, i)));
    const acts = snap.exists ? (snap.data() ?? {}).acts : undefined;
    const act = isRecord(acts) ? acts[relayPeId] : undefined;
    if (isRecord(act) && isRecord(act.row) && act.batch_hash === batchHash) return act as unknown as MeterPageAct;
  }
  return null;
}

export async function demoteBugProducedMeterAct(input: {
  readonly db: Firestore;
  readonly relayPeId: string;
  readonly batchHash: string;
  readonly detectorId: string;
  readonly expectedSnapshotHash: string;
  readonly evidence: unknown;
  readonly execute: boolean;
  readonly nowMs?: number;
  readonly detectors?: Readonly<Record<string, MeterActBugDetector>>;
  /**
   * The demotion hold this run opened over the act's claims (`meter-demotion-hold.ts`). Executing
   * requires every pending claim of the act to carry it, live: no demotion runs while settlement
   * could take its claims.
   */
  readonly holdId?: string;
}): Promise<MeterActBugDemotionResult> {
  const detector = (input.detectors ?? PRODUCTION_METER_ACT_BUG_DETECTORS)[input.detectorId];
  if (!detector) return { kind: 'refused', reason: 'unknown_or_unshipped_bug_detector' };
  const act = await readPageAct(input.db, input.batchHash, input.relayPeId);
  if (act === null) return { kind: 'refused', reason: 'act_not_found' };
  const row = act.row as Record<string, unknown>;
  if (row.economic_snapshot_hash !== input.expectedSnapshotHash) return { kind: 'refused', reason: 'snapshot_hash_mismatch' };
  const demotionRef = input.db.collection(BUG_DEMOTION_COLLECTION).doc(input.relayPeId);
  if (row.mint_status !== 'eligible' || row.mint_disposition !== 'eligible') {
    if (typeof row.bug_demotion_id === 'string' && row.bug_demotion_id.length > 0) {
      // A run that died between the act's demotion and the audit's completion leaves it `applying`.
      if (input.execute) {
        const audit = await demotionRef.get();
        const a = audit.exists ? (audit.data() ?? {}) : null;
        if (a !== null && a.demotion_id === row.bug_demotion_id && a.state === 'applying') {
          await demotionRef.set({ state: 'complete', completed_at_ms: input.nowMs ?? Date.now() }, { merge: true });
        }
      }
      return { kind: 'already_demoted', demotion_id: row.bug_demotion_id };
    }
    return { kind: 'refused', reason: `act_not_eligible:${String(row.mint_status)}` };
  }
  const ctx: MeterActBugDetectorContext = {
    readMeterAct: (batchHash, relayPeId) => readPageAct(input.db, batchHash, relayPeId),
    readClaimLedger: async (claimKey) => {
      const snap = await input.db.collection(CLAIM_LEDGER_COLLECTION).doc(claimKey).get();
      return snap.exists ? (snap.data() ?? null) : null;
    },
  };
  // An act another demotion rests on is never demoted itself (that would leave the other turn with
  // no witness that mints).
  const witnessOf = await input.db.collection(BUG_DEMOTION_COLLECTION)
    .where('witness_ids', 'array-contains', `meter:${input.relayPeId}`).limit(1).get();
  if (!witnessOf.empty) return { kind: 'refused', reason: 'act_is_witness_of_a_demotion' };
  const proof = await detector.prove({ act, evidence: input.evidence, ctx });
  if (proof === null || proof.detector_id !== detector.id || proof.detector_version !== detector.version) {
    return { kind: 'refused', reason: 'bug_not_proved' };
  }
  const claimKeys = actClaimKeysOf(act);
  for (const key of claimKeys) {
    const snap = await input.db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(key).get();
    if (!snap.exists) continue;
    const state = String((snap.data() ?? {}).state ?? '');
    if (state !== 'pending' && state !== 'void') return { kind: 'refused', reason: `claim_not_pending:${state}` };
  }
  if (!input.execute) return { kind: 'dry_run_proved', proof, claim_keys: claimKeys };

  const nowMs = input.nowMs ?? Date.now();
  for (const key of claimKeys) {
    const snap = await input.db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(key).get();
    if (!snap.exists) continue;
    const claim = snap.data() ?? {};
    if (claim.state === 'void') continue;
    const hold = liveDemotionHold(claim, nowMs);
    if (input.holdId === undefined || hold === null || hold.hold_id !== input.holdId) {
      return { kind: 'refused', reason: 'no_live_demotion_hold' };
    }
  }
  const digest = proofDigest(proof);
  const demotionId = `bug_demotion_${digest.slice(0, 24)}_${input.relayPeId}`;
  const witnessIds = typeof proof.evidence.witnesses === 'string' && proof.evidence.witnesses.length > 0
    ? proof.evidence.witnesses.split(',') : [];
  const audit = {
    schema_version: METER_ACT_BUG_DEMOTION_SCHEMA,
    demotion_id: demotionId,
    pe_id: input.relayPeId,
    batch_hash: input.batchHash,
    detector_id: detector.id,
    detector_version: detector.version,
    proof_digest: digest,
    evidence: proof.evidence,
    witness_ids: witnessIds,
    expected_snapshot_hash: input.expectedSnapshotHash,
    claim_keys: claimKeys,
    created_at_ms: nowMs,
  };
  const opened = await input.db.runTransaction(async (txn) => {
    const existing = await txn.get(demotionRef);
    if (existing.exists) {
      return (existing.data() ?? {}).demotion_id === demotionId ? 'resume' as const : 'different_demotion' as const;
    }
    txn.create(demotionRef, { ...audit, state: 'applying', completed_at_ms: null });
    return 'created' as const;
  });
  if (opened === 'different_demotion') return { kind: 'refused', reason: opened };

  const mutation = await mutatePeHistoryRowWithAggregate(input.db as never, input.relayPeId, {
    mint_status: 'record_only',
    mint_disposition: 'record_only',
    disposition_reason_code: 'policy_record_only',
    estimatedPVT: 0,
    estimated_pvt_atomic: '0',
    economic_eligibility_projection: null,
    mint_status_updated_at: nowMs,
    bug_demoted_at_ms: nowMs,
    bug_demotion_id: demotionId,
    bug_detector_id: detector.id,
    bug_proof_digest: digest,
  }, {
    nowMs,
    pageBatchHash: input.batchHash,
    expect: (before) => before.economic_snapshot_hash === input.expectedSnapshotHash
      && before.mint_status === 'eligible' && before.mint_disposition === 'eligible',
    // The run's hold, live on every claim, in the transaction that withdraws the act's share.
    claimExpect: (claim) => liveDemotionHold(claim, nowMs)?.hold_id === input.holdId,
  });
  if (mutation.outcome !== 'applied') {
    // Whether the act moved under THIS demotion (a concurrent run of the same proof applied it) is
    // read from the act itself, in the same transaction as the audit: if it did, the audit stands
    // and is completed; if not, no audit stands for it — an `applying` record left behind would
    // refuse every later attempt as a different demotion.
    const settledBy = await input.db.runTransaction(async (txn) => {
      const cur = await txn.get(demotionRef);
      const now = await readPageActInTxn(txn, input.db, input.batchHash, input.relayPeId);
      if (now !== null && (now.row as Record<string, unknown>).bug_demotion_id === demotionId) {
        txn.set(demotionRef, { ...audit, state: 'complete', completed_at_ms: nowMs }, { merge: true });
        return 'applied_elsewhere' as const;
      }
      if (cur.exists && (cur.data() ?? {}).demotion_id === demotionId && (cur.data() ?? {}).state === 'applying') txn.delete(demotionRef);
      return 'not_applied' as const;
    });
    if (settledBy === 'applied_elsewhere') return { kind: 'already_demoted', demotion_id: demotionId };
    return { kind: 'refused', reason: `act_mutation_${mutation.outcome}` };
  }
  await demotionRef.set({ ...audit, state: 'complete', completed_at_ms: nowMs }, { merge: true });
  return { kind: 'demoted', demotion_id: demotionId, proof, claim_keys: claimKeys };
}

export interface MeterActDemotionEntry {
  readonly relay_pe_id: string;
  readonly batch_hash: string;
  readonly detector: string;
  readonly expected_snapshot_hash: string;
  readonly evidence: unknown;
}

/** The claim keys of every listed act (its batch claims and any top-ups), read from its page row. */
export async function meterActsClaimKeys(db: Firestore, entries: readonly Pick<MeterActDemotionEntry, 'relay_pe_id' | 'batch_hash'>[]): Promise<string[]> {
  const keys = new Set<string>();
  for (const e of entries) {
    const act = await readPageAct(db, e.batch_hash, e.relay_pe_id);
    if (act !== null) for (const k of actClaimKeysOf(act)) keys.add(k);
  }
  return [...keys].sort();
}

/**
 * Demote a manifest of metered acts under ONE demotion hold : the hold is opened
 * over every claim the acts live in before the first demotion and released after the last, however
 * the run ends, so no settlement path — scheduled, run by hand, or an on-demand payout — can take
 * those claims while the demotions are in flight. A hold that cannot be opened (a claim already left
 * `pending`, or another run holds it) refuses the whole run before anything moves. A dry run opens
 * no hold.
 */
export async function demoteBugProducedMeterActs(input: {
  readonly db: Firestore;
  readonly entries: readonly MeterActDemotionEntry[];
  readonly execute: boolean;
  readonly holdId: string;
  readonly nowMs?: () => number;
  readonly holdTtlMs?: number;
  readonly detectors?: Readonly<Record<string, MeterActBugDetector>>;
  readonly onResult?: (entry: MeterActDemotionEntry, result: MeterActBugDemotionResult) => void;
}): Promise<{ readonly kind: 'ran'; readonly results: readonly MeterActBugDemotionResult[]; readonly held: number } | { readonly kind: 'hold_refused'; readonly reason: string }> {
  const now = input.nowMs ?? Date.now;
  const ttl = Math.min(Math.max(1, input.holdTtlMs ?? DEMOTION_HOLD_DEFAULT_TTL_MS), DEMOTION_HOLD_MAX_TTL_MS);
  let expiresAt = 0;
  let heldKeys: readonly string[] = [];
  const run = async (holdId: string | undefined) => {
    const results: MeterActBugDemotionResult[] = [];
    for (const e of input.entries) {
      // A long run keeps its hold: renewed whenever less than half its term is left, so a claim
      // the run has not reached yet never comes out from under it.
      const t = now();
      if (holdId !== undefined && expiresAt - t < ttl / 2) {
        const renewed = await renewDemotionHold(input.db, { claimKeys: heldKeys, holdId, nowMs: t, ttlMs: ttl });
        expiresAt = renewed.expires_at_ms;
      }
      const result = await demoteBugProducedMeterAct({
        db: input.db, relayPeId: e.relay_pe_id, batchHash: e.batch_hash, detectorId: e.detector,
        expectedSnapshotHash: e.expected_snapshot_hash, evidence: e.evidence, execute: input.execute,
        nowMs: t, ...(input.detectors ? { detectors: input.detectors } : {}), ...(holdId !== undefined ? { holdId } : {}),
      });
      results.push(result);
      input.onResult?.(e, result);
    }
    return results;
  };
  if (!input.execute) return { kind: 'ran', results: await run(undefined), held: 0 };
  const claimKeys = await meterActsClaimKeys(input.db, input.entries);
  const opened = await openDemotionHold(input.db, {
    claimKeys, holdId: input.holdId, reason: 'meter_act_bug_demotion', nowMs: now(), ...(input.holdTtlMs !== undefined ? { ttlMs: input.holdTtlMs } : {}),
  });
  if (opened.kind === 'refused') return { kind: 'hold_refused', reason: opened.reason };
  expiresAt = opened.expires_at_ms;
  heldKeys = opened.held;
  try {
    return { kind: 'ran', results: await run(input.holdId), held: opened.held.length };
  } finally {
    await releaseDemotionHold(input.db, { claimKeys: opened.held, holdId: input.holdId });
  }
}
