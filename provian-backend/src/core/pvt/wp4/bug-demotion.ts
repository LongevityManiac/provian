/**
 * Single-PE bug demotion.
 *
 * A row can be removed from settlement only when a named, checked-in detector
 * proves the producer bug. Operator suspicion, value, or a free-form reason is
 * never sufficient. The sealed PE and economic snapshot are never rewritten.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { mutatePeHistoryRowWithAggregate } from '../policy/economic-aggregate';
import {
  BUG_DEMOTION_COLLECTION,
  CLAIM_LEDGER_COLLECTION,
  normalizePeId,
} from './durable-settlement-store';

export const BUG_DEMOTION_SCHEMA = 'pvt9-bug-demotion/v1';

export interface BugProof {
  readonly detector_id: string;
  readonly detector_version: string;
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
}

export interface BugDetectorContext {
  readonly db: Firestore;
  readonly peId: string;
  readonly row: Readonly<Record<string, unknown>>;
}

export interface BugDetector {
  readonly id: string;
  readonly version: string;
  prove(context: BugDetectorContext): Promise<BugProof | null>;
}

/**
 * `provian doctor`'s synthetic turn. Doctor posts a fabricated two-tool OTel trace to
 * prove the local pipeline; until release 38 the observer's OTel lane submitted it as an
 * `agent_tool_orchestration` PE, which sealed eligible (1.6 PVT) for a turn no agent ran. The
 * producer bug is proved from the SEALED envelope alone: the observer-OTel tool, the doctor's
 * orchestration name as the description, and EXACTLY the doctor's two probe tool names.
 * Mirrors `provian-agent-sdk/src/observer/doctor-probe.ts` (pinned by a parity test).
 */
export const DOCTOR_PROBE_ORCHESTRATION_NAME = 'provian doctor synthetic turn';
export const DOCTOR_PROBE_TOOL_NAMES: readonly string[] = ['provian_doctor_probe_1', 'provian_doctor_probe_2'];

export const doctorSyntheticTraceDetector: BugDetector = {
  id: 'doctor_synthetic_trace',
  version: '1',
  async prove({ db, peId, row }) {
    if (row.actionType !== 'agent_tool_orchestration') return null;
    const env = await db.collection('provenance_envelopes').doc(peId).get();
    if (!env.exists) return null;
    const e = env.data() as Record<string, unknown>;
    const m = (typeof e.metadata === 'object' && e.metadata !== null ? e.metadata : {}) as Record<string, unknown>;
    const names = Array.isArray(m.tool_names) ? m.tool_names : null;
    const want = [...DOCTOR_PROBE_TOOL_NAMES].sort();
    if (e.action_type !== 'agent_tool_orchestration') return null;
    if (m.tool !== 'provian-observer-otel') return null;
    if (typeof e.description !== 'string' || !e.description.startsWith(`${DOCTOR_PROBE_ORCHESTRATION_NAME} — `)) return null;
    if (names === null || names.length !== want.length || !names.every((n) => typeof n === 'string')) return null;
    if (![...(names as string[])].sort().every((n, i) => n === want[i])) return null;
    if (m.tool_count !== want.length) return null;
    return {
      detector_id: 'doctor_synthetic_trace',
      detector_version: '1',
      evidence: {
        envelope_tool: 'provian-observer-otel',
        description: e.description,
        tool_names: [...(names as string[])].sort().join(','),
        tool_count: want.length,
        trace_id: typeof m.trace_id === 'string' ? m.trace_id : null,
      },
    };
  },
};

/**
 * Adding a detector is reviewed code plus tests; it is not operator-entered policy.
 */
export const PRODUCTION_BUG_DETECTORS: Readonly<Record<string, BugDetector>> = Object.freeze({
  [doctorSyntheticTraceDetector.id]: doctorSyntheticTraceDetector,
});

export type BugDemotionResult =
  | { readonly kind: 'dry_run_proved'; readonly proof: BugProof; readonly claim_rows: number }
  | { readonly kind: 'demoted'; readonly demotion_id: string; readonly proof: BugProof; readonly claim_rows: number }
  | { readonly kind: 'already_demoted'; readonly demotion_id: string }
  | { readonly kind: 'refused'; readonly reason: string };

function proofDigest(proof: BugProof): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    detector_id: proof.detector_id,
    detector_version: proof.detector_version,
    evidence: Object.fromEntries(Object.entries(proof.evidence).sort(([a], [b]) => a.localeCompare(b))),
  })).digest('hex');
}

export async function demoteBugProducedPe(input: {
  db: Firestore;
  peId: string;
  detectorId: string;
  expectedSnapshotHash: string;
  execute: boolean;
  nowMs?: number;
  detectors?: Readonly<Record<string, BugDetector>>;
}): Promise<BugDemotionResult> {
  const peId = normalizePeId(input.peId);
  const detector = (input.detectors ?? PRODUCTION_BUG_DETECTORS)[input.detectorId];
  if (!detector) return { kind: 'refused', reason: 'unknown_or_unshipped_bug_detector' };
  const peRef = input.db.collection('pe_history').doc(peId);
  const peSnap = await peRef.get();
  if (!peSnap.exists) return { kind: 'refused', reason: 'pe_not_found' };
  const row = peSnap.data() as Record<string, unknown>;
  if (row.economic_snapshot_hash !== input.expectedSnapshotHash) {
    return { kind: 'refused', reason: 'snapshot_hash_mismatch' };
  }
  if (row.mint_status !== 'eligible' || row.mint_disposition !== 'eligible') {
    if (row.bug_demotion_id && typeof row.bug_demotion_id === 'string') {
      return { kind: 'already_demoted', demotion_id: row.bug_demotion_id };
    }
    return { kind: 'refused', reason: `pe_not_eligible:${String(row.mint_status)}` };
  }
  const proof = await detector.prove({ db: input.db, peId, row });
  if (proof === null || proof.detector_id !== detector.id || proof.detector_version !== detector.version) {
    return { kind: 'refused', reason: 'bug_not_proved' };
  }
  const ledgerSnap = await input.db.collection(CLAIM_LEDGER_COLLECTION)
    .where('pe_key', '==', peId).get();
  const claimRows = ledgerSnap.docs.length;
  for (const doc of ledgerSnap.docs) {
    const claim = doc.data() as Record<string, unknown>;
    if (claim.settled === true || typeof claim.settled_tx_hash === 'string') {
      return { kind: 'refused', reason: 'claim_already_settled' };
    }
    if (typeof claim.reserved_batch_id === 'string' && claim.reserved_batch_id.length > 0) {
      return { kind: 'refused', reason: 'claim_reserved_or_in_flight' };
    }
  }
  if (!input.execute) return { kind: 'dry_run_proved', proof, claim_rows: claimRows };

  const nowMs = input.nowMs ?? Date.now();
  const digest = proofDigest(proof);
  const demotionId = `bug_demotion_${digest.slice(0, 24)}_${peId}`;
  const demotionRef = input.db.collection(BUG_DEMOTION_COLLECTION).doc(peId);
  const ledgerRefs = ledgerSnap.docs.map((doc) => doc.ref);
  const coordinated = await input.db.runTransaction(async (txn) => {
    const [freshPe, existingDemotion] = [await txn.get(peRef), await txn.get(demotionRef)];
    const freshClaims = [];
    for (const ref of ledgerRefs) freshClaims.push(await txn.get(ref));
    if (existingDemotion.exists) {
      const existing = existingDemotion.data() as Record<string, unknown>;
      return existing.demotion_id === demotionId ? 'resume' as const : 'different_demotion' as const;
    }
    const freshRow = freshPe.exists ? freshPe.data() as Record<string, unknown> : null;
    if (freshRow === null || freshRow.mint_status !== 'eligible'
      || freshRow.economic_snapshot_hash !== input.expectedSnapshotHash) return 'pe_changed' as const;
    if (freshClaims.some((snap) => {
      const claim = snap.exists ? snap.data() as Record<string, unknown> : null;
      return claim === null || claim.settled === true
        || (typeof claim.reserved_batch_id === 'string' && claim.reserved_batch_id.length > 0);
    })) return 'claim_changed' as const;
    txn.create(demotionRef, {
      schema_version: BUG_DEMOTION_SCHEMA,
      demotion_id: demotionId,
      pe_id: peId,
      detector_id: detector.id,
      detector_version: detector.version,
      proof_digest: digest,
      evidence: proof.evidence,
      expected_snapshot_hash: input.expectedSnapshotHash,
      state: 'applying',
      created_at_ms: nowMs,
      completed_at_ms: null,
    });
    for (const ref of ledgerRefs) {
      txn.set(ref, {
        bug_demoted_at_ms: nowMs,
        bug_demotion_id: demotionId,
      }, { merge: true });
    }
    return 'created' as const;
  });
  if (coordinated === 'different_demotion' || coordinated === 'pe_changed' || coordinated === 'claim_changed') {
    return { kind: 'refused', reason: coordinated };
  }

  const mutation = await mutatePeHistoryRowWithAggregate(input.db as never, peId, {
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
    expect: (before) => before.economic_snapshot_hash === input.expectedSnapshotHash
      && ((before.mint_status === 'eligible' && before.mint_disposition === 'eligible')
        || before.bug_demotion_id === demotionId),
  });
  if (mutation.outcome !== 'applied') {
    return { kind: 'refused', reason: `pe_mutation_${mutation.outcome}` };
  }
  // Catch any claim registered immediately before the tombstone committed but
  // outside the initial read. The tombstone now blocks every new registration
  // and reservation, so this cleanup converges and cannot race another mint.
  const cleanup = await input.db.collection(CLAIM_LEDGER_COLLECTION).where('pe_key', '==', peId).get();
  for (const doc of cleanup.docs) {
    const claim = doc.data() as Record<string, unknown>;
    if (claim.settled === true || (typeof claim.reserved_batch_id === 'string' && claim.reserved_batch_id.length > 0)) {
      return { kind: 'refused', reason: 'post_coordination_claim_conflict' };
    }
    await doc.ref.set({ bug_demoted_at_ms: nowMs, bug_demotion_id: demotionId }, { merge: true });
  }
  await demotionRef.set({ state: 'complete', completed_at_ms: nowMs }, { merge: true });
  return { kind: 'demoted', demotion_id: demotionId, proof, claim_rows: cleanup.docs.length };
}
