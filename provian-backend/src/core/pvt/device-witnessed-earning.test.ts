/**
 * ACCEPTANCE — device-witnessed VERIFIED earning (Build A).
 *
 * Two levels, both with the RED negative control the doctrine requires:
 * (A) the pure overlay `deviceWitnessedVerifiedFields` proves the WIRING
 * decision (body-bound + witnessed family + canonical → stamp; else {}).
 * This is the RED control for the devices.ts change: revert the function to
 * an unconditional stamp and the "must be empty" cases below go red.
 * (B) the MONEY OUTCOME — the same overlay driven through the REAL recordPEAccrual
 * against a fake Firestore (the durableOutbox harness): a body-bound
 * agent_tool_orchestration seals `eligible` and prices a NON-ZERO amount at
 * the software 0.8× tier; the identical submission WITHOUT the overlay seals
 * `record_only` and pays 0 (the RED control, on the pre-fix behaviour).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from './beneficiary';
import {
  DEVICE_WITNESSED_VERIFIED_FAMILIES,
  commitWitnessedVerifiedFields,
  deviceWitnessedCanonicalEvent,
  deviceWitnessedVerifiedFields,
} from './device-witnessed-earning';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './wp11/ordinary-accrual-intake';

// ---------------------------------------------------------------------------
// (A) The pure overlay — no I/O, no mocks.
// ---------------------------------------------------------------------------
describe('(A) deviceWitnessedVerifiedFields — the wiring decision', () => {
  const meta = { trace_id: 'trace-abc' };

  it('the family set is exactly the 4 non-colliding compute families + the link_spend witness (NOT coding_session)', () => {
    expect([...DEVICE_WITNESSED_VERIFIED_FAMILIES].sort()).toEqual([
      'agent_api_orchestration',
      'agent_tool_orchestration',
      'compute_session',
      'inference_session',
      'link_spend',
    ]);
    // coding_session is the dual-witness path (Build B), never a bare stamp here.
    expect(DEVICE_WITNESSED_VERIFIED_FAMILIES.has('coding_session')).toBe(false);
  });

  it('body-bound + witnessed family + trace → full verified/durable overlay', () => {
    const o = deviceWitnessedVerifiedFields({
      actionType: 'agent_tool_orchestration',
      bodyBound: true,
      metadata: meta,
      sessionLineageId: null,
    });
    expect(o.durableReplaySource).toBe(ORDINARY_ACCRUAL_REPLAY_SOURCE);
    expect(o.economicEvidenceState).toBe('verified');
    expect(o.economicCanonicalEventId).toBe('agent_tool_orchestration:trace-abc');
    expect(typeof o.artifact_hash).toBe('string');
    expect((o.artifact_hash as string).length).toBe(64);
  });

  it('RED: NOT body-bound → empty overlay (bearer with no HMAC stays record_only)', () => {
    expect(deviceWitnessedVerifiedFields({
      actionType: 'agent_tool_orchestration', bodyBound: false, metadata: meta, sessionLineageId: null,
    })).toEqual({});
  });

  it('RED: coding_session is EXCLUDED even when body-bound (dual-witness path owns it)', () => {
    expect(deviceWitnessedVerifiedFields({
      actionType: 'coding_session', bodyBound: true, metadata: { trace_id: 'x', commit_sha: 'deadbeef' }, sessionLineageId: 'L',
    })).toEqual({});
  });

  it('RED: a non-witnessed type is excluded even when body-bound', () => {
    expect(deviceWitnessedVerifiedFields({
      actionType: 'ai_conversation', bodyBound: true, metadata: meta, sessionLineageId: 'L',
    })).toEqual({});
  });

  it('FAIL-SAFE: witnessed + body-bound but NO canonical id → empty overlay', () => {
    expect(deviceWitnessedVerifiedFields({
      actionType: 'agent_tool_orchestration', bodyBound: true, metadata: {}, sessionLineageId: null,
    })).toEqual({});
    expect(deviceWitnessedVerifiedFields({
      actionType: 'compute_session', bodyBound: true, metadata: {}, sessionLineageId: null,
    })).toEqual({});
  });

  it('compute/inference key on the attested session lineage, orchestration on the trace', () => {
    expect(deviceWitnessedCanonicalEvent('compute_session', {}, 'sess-1')).toBe('compute_session:sess-1');
    expect(deviceWitnessedCanonicalEvent('inference_session', {}, 'sess-2')).toBe('inference_session:sess-2');
    expect(deviceWitnessedCanonicalEvent('agent_api_orchestration', { trace_id: 't9' }, null))
      .toBe('agent_api_orchestration:t9');
  });

  // ---- Part A: the cross-source turn identity keys the canonical event -------
  describe('Part A — deviceWitnessedCanonicalEvent keys on turn_id', () => {
    it('prefers metadata.turn_id over trace_id', () => {
      expect(deviceWitnessedCanonicalEvent(
        'agent_tool_orchestration', { turn_id: 'tc:abc', trace_id: 'trace-xyz' }, null,
      )).toBe('agent_tool_orchestration:tc:abc');
    });

    it('the TRANSCRIPT lane (turn_id present, NO trace_id) now yields a canonical event — so it EARNS', () => {
      // This is the parity fix: before turn_id, a transcript PE had no trace_id
      // → null canonical → record_only → 0. Now it keys on turn_id and earns.
      const ev = deviceWitnessedCanonicalEvent(
        'agent_tool_orchestration', { turn_id: 'tf:deadbeefdeadbeef:1', source: 'transcript' }, null,
      );
      expect(ev).toBe('agent_tool_orchestration:tf:deadbeefdeadbeef:1');
    });

    it('BACK-COMPAT: no turn_id → falls back to trace_id (byte-identical to pre-turn_id)', () => {
      expect(deviceWitnessedCanonicalEvent(
        'agent_tool_orchestration', { trace_id: 'trace-abc' }, null,
      )).toBe('agent_tool_orchestration:trace-abc');
    });

    it('(iii) the SAME turn_id from two different sources → the SAME canonical event (cross-source mint-once key)', () => {
      const otelSide = deviceWitnessedCanonicalEvent(
        'agent_tool_orchestration',
        { tool: 'provian-observer-otel', trace_id: 'traceZ', turn_id: 'tc:shared' }, null,
      );
      const transcriptSide = deviceWitnessedCanonicalEvent(
        'agent_tool_orchestration',
        { tool: 'provian-observer-transcript', source: 'transcript', session_fingerprint: 'ff', turn_id: 'tc:shared' }, null,
      );
      expect(otelSide).toBe(transcriptSide);
    });

    it('(i) distinct turn_ids → distinct canonical events (distinct work is never merged)', () => {
      expect(deviceWitnessedCanonicalEvent('agent_tool_orchestration', { turn_id: 'tc:one' }, null))
        .not.toBe(deviceWitnessedCanonicalEvent('agent_tool_orchestration', { turn_id: 'tc:two' }, null));
    });

    it('RED: a malformed / oversized turn_id is ignored and it falls back to trace_id', () => {
      const tooLong = 'x'.repeat(200);
      expect(deviceWitnessedCanonicalEvent(
        'agent_tool_orchestration', { turn_id: tooLong, trace_id: 'trace-fallback' }, null,
      )).toBe('agent_tool_orchestration:trace-fallback');
      expect(deviceWitnessedCanonicalEvent(
        'agent_tool_orchestration', { turn_id: 'has spaces/and\nnewline', trace_id: 'trace-fb2' }, null,
      )).toBe('agent_tool_orchestration:trace-fb2');
      // No turn_id AND no trace_id → still null (fail-safe, stays record_only).
      expect(deviceWitnessedCanonicalEvent('agent_tool_orchestration', { turn_id: '   ' }, null)).toBeNull();
    });

    it('tool vs api on the SAME turn_id do NOT collide (action_type folded in)', () => {
      expect(deviceWitnessedCanonicalEvent('agent_tool_orchestration', { turn_id: 'tc:t' }, null))
        .not.toBe(deviceWitnessedCanonicalEvent('agent_api_orchestration', { turn_id: 'tc:t' }, null));
    });
  });

  it('tool vs api on the SAME trace do NOT collide (action_type folded into the key/hash)', () => {
    const tool = deviceWitnessedVerifiedFields({
      actionType: 'agent_tool_orchestration', bodyBound: true, metadata: meta, sessionLineageId: null,
    });
    const api = deviceWitnessedVerifiedFields({
      actionType: 'agent_api_orchestration', bodyBound: true, metadata: meta, sessionLineageId: null,
    });
    expect(tool.economicCanonicalEventId).not.toBe(api.economicCanonicalEventId);
    expect(tool.artifact_hash).not.toBe(api.artifact_hash);
  });

  it('artifact_hash is deterministic (a replay prices identically)', () => {
    const a = deviceWitnessedVerifiedFields({
      actionType: 'compute_session', bodyBound: true, metadata: {}, sessionLineageId: 'sess-det',
    });
    const b = deviceWitnessedVerifiedFields({
      actionType: 'compute_session', bodyBound: true, metadata: {}, sessionLineageId: 'sess-det',
    });
    expect(a.artifact_hash).toBe(b.artifact_hash);
  });
});

// ---------------------------------------------------------------------------
// (A2) The commit-witness overlay — the Build B (unit 2) enrollment.
// ---------------------------------------------------------------------------
describe('(A2) commitWitnessedVerifiedFields — the coding_session enrollment', () => {
  it('body-bound coding_session + commit sha → durable + verified + canonical=commit', () => {
    const o = commitWitnessedVerifiedFields({
      actionType: 'coding_session', bodyBound: true, commitSha: 'DeadBeef01',
    });
    expect(o.durableReplaySource).toBe(ORDINARY_ACCRUAL_REPLAY_SOURCE);
    expect(o.economicEvidenceState).toBe('verified');
    expect(o.economicCanonicalEventId).toBe('coding_session:DeadBeef01');
    // Its mint-once is the EXISTING commit claim, NOT device_occurrence, and the
    // commit claim is the sole dedup — so neither anchor is set here.
    expect(o.deviceWitnessedOccurrenceHash).toBeUndefined();
    expect(o.artifact_hash).toBeUndefined();
  });

  it('RED: NOT body-bound → empty overlay (stays record_only, pre-fix)', () => {
    expect(commitWitnessedVerifiedFields({
      actionType: 'coding_session', bodyBound: false, commitSha: 'deadbeef',
    })).toEqual({});
  });

  it('RED: coding_session with NO commit sha → empty overlay', () => {
    expect(commitWitnessedVerifiedFields({
      actionType: 'coding_session', bodyBound: true, commitSha: null,
    })).toEqual({});
    expect(commitWitnessedVerifiedFields({
      actionType: 'coding_session', bodyBound: true, commitSha: '   ',
    })).toEqual({});
  });

  it('RED: a non-coding_session type is excluded even body-bound with a commit sha', () => {
    // The device-witnessed compute families own their OWN overlay; this one is
    // coding_session-only so the two never both fire for one PE.
    expect(commitWitnessedVerifiedFields({
      actionType: 'agent_tool_orchestration', bodyBound: true, commitSha: 'deadbeef',
    })).toEqual({});
    expect(commitWitnessedVerifiedFields({
      actionType: 'compute_session', bodyBound: true, commitSha: 'deadbeef',
    })).toEqual({});
  });

  it('the two overlays never both stamp one PE (mutually exclusive by action type)', () => {
    // coding_session gets the commit overlay and an EMPTY device overlay; a
    // compute family gets the device overlay and an EMPTY commit overlay.
    const codingDevice = deviceWitnessedVerifiedFields({
      actionType: 'coding_session', bodyBound: true, metadata: { trace_id: 't', commit_sha: 'c' }, sessionLineageId: 'L',
    });
    const codingCommit = commitWitnessedVerifiedFields({
      actionType: 'coding_session', bodyBound: true, commitSha: 'c',
    });
    expect(codingDevice).toEqual({});
    expect(Object.keys(codingCommit).length).toBeGreaterThan(0);

    const computeDevice = deviceWitnessedVerifiedFields({
      actionType: 'compute_session', bodyBound: true, metadata: {}, sessionLineageId: 'sess',
    });
    const computeCommit = commitWitnessedVerifiedFields({
      actionType: 'compute_session', bodyBound: true, commitSha: 'c',
    });
    expect(Object.keys(computeDevice).length).toBeGreaterThan(0);
    expect(computeCommit).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// (B) The money outcome — real recordPEAccrual against a fake Firestore.
//     Mock preamble mirrors pvt-accrual.durableOutbox.acceptance.test.ts.
// ---------------------------------------------------------------------------
let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
jest.mock('../../cache', () => ({
  cache: {
    getUserDailyPECountStrict: jest.fn(async () => 0),
    getUserActionTypeCountStrict: jest.fn(async () => 0),
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: jest.fn(async () => 1),
    incrementHourlyPECount: jest.fn(async () => {}),
    commitPEAccountingCountersOnce: jest.fn(async () => ({ idempotent: false })),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
const mockResolveBeneficiary = jest.fn<(...a: unknown[]) => Promise<BeneficiaryCacheEntry>>(async () => ({
  linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
}));
jest.mock('./beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
jest.mock('../jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('./delegation-pe', () => ({ isDelegationQualifying: () => false, createDelegationPE: async () => {} }));
jest.mock('../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'compute',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));

// eslint-disable-next-line import/first
import { recordPEAccrual, type RecordPEAccrualParams } from '../../pvt-accrual';
// eslint-disable-next-line import/first
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  buildOrdinaryAccrualIntake,
} from './wp11/ordinary-accrual-intake';

const TIMESTAMP = Date.UTC(2026, 7, 15, 12, 0);
let seq = 0;

interface PeRow {
  mint_status: string;
  mint_disposition: string;
  estimatedPVT: number;
  economic_snapshot: { recordPointsAtomic: string; recordTimeFactors?: { attestationMultiplierBps?: number } } | null;
}

/** The exact params the device handler builds for a body-bound witnessed PE. */
function deviceParams(over: Record<string, unknown> = {}): RecordPEAccrualParams {
  const peId = `pe_dev_${seq++}`;
  const overlay = deviceWitnessedVerifiedFields({
    actionType: 'agent_tool_orchestration',
    bodyBound: true,
    metadata: { trace_id: `trace_${peId}` },
    sessionLineageId: null,
  });
  return {
    peId,
    userId: 'agent1',
    actionType: 'agent_tool_orchestration',
    integrationSource: 'device_pe_submit',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    isDevicePE: true,
    ...overlay,
    ...over,
  } as RecordPEAccrualParams;
}

function commitIntake(params: RecordPEAccrualParams): void {
  const doc = buildOrdinaryAccrualIntake({
    prevHash: `prev_${params.peId}`, peHash: params.peHash, accrualParams: params,
  });
  mockDb.store.set(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${params.peId}`, { ...doc });
}
function row(peId: string): PeRow {
  const r = mockDb.store.get(`pe_history/${peId}`) as PeRow | undefined;
  if (!r) throw new Error(`no pe_history row for ${peId}`);
  return r;
}
async function seal(params: RecordPEAccrualParams): Promise<PeRow> {
  commitIntake(params);
  await recordPEAccrual(params);
  return row(params.peId);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.store.clear();
  mockDb.ops.length = 0;
});

describe('(B) a body-bound agent_tool_orchestration MINTS; without the overlay it does not', () => {
  it('with the overlay → eligible, NON-ZERO, priced at software 0.8× (8000 bps)', async () => {
    const sealed = await seal(deviceParams());
    expect(sealed.mint_disposition).toBe('eligible');
    expect(sealed.mint_status).toBe('eligible');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
    expect(BigInt(sealed.economic_snapshot!.recordPointsAtomic)).toBeGreaterThan(0n);
    // evidence-priced software tier = 0.8× = 8000 bps.
    expect(sealed.economic_snapshot!.recordTimeFactors?.attestationMultiplierBps).toBe(8000);
  });

  it('RED (pre-fix behaviour): the SAME submission WITHOUT the overlay seals record_only, 0', async () => {
    // Strip the overlay fields → exactly what devices.ts produced before.
    const params = deviceParams();
    const bare = { ...params };
    delete (bare as Record<string, unknown>).durableReplaySource;
    delete (bare as Record<string, unknown>).economicEvidenceState;
    delete (bare as Record<string, unknown>).economicCanonicalEventId;
    delete (bare as Record<string, unknown>).artifact_hash;
    const sealed = await seal(bare as RecordPEAccrualParams);
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.estimatedPVT).toBe(0);
  });

  it('RED: durable but NOT verified (evidence gate) → pending_evidence, 0', async () => {
    const params = deviceParams();
    const noEvidence = { ...params };
    delete (noEvidence as Record<string, unknown>).economicEvidenceState;
    const sealed = await seal(noEvidence as RecordPEAccrualParams);
    expect(sealed.mint_disposition).toBe('pending_evidence');
    expect(sealed.estimatedPVT).toBe(0);
  });

  it('a body-bound coding_session with a commit sha MINTS at compute base × software 0.8×', async () => {
    // The commit-witness enrollment lifts the same two fences the compute-family
    // overlay does, but keyed on the EXISTING (user, commit_sha) claim. Solo
    // daemon (no competing forge witness) → it owns the commit claim and mints.
    const peId = `pe_cs_${seq++}`;
    // A valid 40-hex git sha: prepareCommitMintClaim validates the shape.
    const commit = 'deadbeef'.repeat(5);
    const overlay = commitWitnessedVerifiedFields({
      actionType: 'coding_session', bodyBound: true, commitSha: commit,
    });
    const params = {
      peId,
      userId: 'agent1',
      actionType: 'coding_session',
      integrationSource: 'device_pe_submit',
      attestationDepth: 'software',
      peHash: `h_${peId}`,
      timestamp: TIMESTAMP,
      isDevicePE: true,
      // The device route passes commitSha at the top level (from metadata); the
      // overlay lifts the fences. Both are needed for the mintable commit witness.
      commitSha: commit,
      ...overlay,
    } as RecordPEAccrualParams;
    const sealed = await seal(params);
    expect(sealed.mint_disposition).toBe('eligible');
    expect(sealed.mint_status).toBe('eligible');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
    expect(sealed.economic_snapshot!.recordTimeFactors?.attestationMultiplierBps).toBe(8000);
  });

  it('RED (pre-fix): the SAME coding_session WITHOUT the commit overlay seals record_only, 0', async () => {
    // Exactly what devices.ts produced before for a coding_session: commitSha
    // present (it always claimed the slot) but NO durable/verified fences lifted.
    const peId = `pe_cs_${seq++}`;
    const bare = {
      peId,
      userId: 'agent1',
      actionType: 'coding_session',
      integrationSource: 'device_pe_submit',
      attestationDepth: 'software',
      peHash: `h_${peId}`,
      timestamp: TIMESTAMP,
      isDevicePE: true,
      commitSha: 'cafebabe'.repeat(5),
    } as RecordPEAccrualParams;
    const sealed = await seal(bare);
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.estimatedPVT).toBe(0);
  });

  it('repetition is priced by NOVELTY DECAY, not a hard mint-once (the artifact claim is wired)', async () => {
    // The canonical event rides `artifact_hash`, which drives the per-user
    // artifact-novelty claim (`artifact-novelty-claim.ts`). A repeated artifact
    // is NOT sealed terminal (it is absent from the `exactDuplicate` set in
    // monetary-accounting.ts); it is priced DOWN by novelty decay — the operator’s
    // stated Sybil bound (per-device + real compute + novelty decay), Q2.
    // Novelty decay is Redis-backed and mocked OFF in this harness, so both seal
    // eligible here; the decay itself is covered by the novelty suite. What THIS
    // asserts is that the overlay supplies the artifact_hash the novelty
    // machinery keys on — the input without which repetition could not be priced.
    // NOTE : the sovereign path uses a HARD per-occurrence
    // mint-once (occurrence claim); device orchestration relies on novelty decay.
    // The hard-mint-once parity question is flagged in the run log.
    const sealed = await seal(deviceParams());
    expect(sealed.mint_disposition).toBe('eligible');
    expect(typeof (sealed as unknown as { economic_snapshot: { recordTimeFactors?: unknown } })
      .economic_snapshot).toBe('object');
    // The artifact_hash the novelty claim keys on is present on the overlay.
    const overlay = deviceWitnessedVerifiedFields({
      actionType: 'agent_tool_orchestration', bodyBound: true, metadata: { trace_id: 't' }, sessionLineageId: null,
    });
    expect(typeof overlay.artifact_hash).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// (C) Part A — the relay mint-once for a tool turn, driven end-to-end through
// recordPEAccrual. These are the RED controls the operator named: distinct turns
//     ALWAYS mint; the same turn mints exactly once, whether resubmitted from
//     one source or arriving from both. The guard is the EXISTING device_occurrence
//     claim, now reachable by BOTH lanes because both stamp a shared turn_id.
// ---------------------------------------------------------------------------
/** Params for a body-bound agent_tool_orchestration turn keyed on `turnId`. */
function turnParams(turnId: string, metaExtra: Record<string, unknown> = {}): RecordPEAccrualParams {
  const peId = `pe_turn_${seq++}`;
  const overlay = deviceWitnessedVerifiedFields({
    actionType: 'agent_tool_orchestration',
    bodyBound: true,
    metadata: { turn_id: turnId, ...metaExtra },
    sessionLineageId: null,
  });
  return {
    peId,
    userId: 'agent1',
    actionType: 'agent_tool_orchestration',
    integrationSource: 'device_pe_submit',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    isDevicePE: true,
    ...overlay,
  } as RecordPEAccrualParams;
}

describe('(C) Part A — relay mint-once for a tool turn (RED controls i/ii/iii)', () => {
  it('(i) two DIFFERENT turns in one session BOTH mint — distinct work is never refused', async () => {
    const a = await seal(turnParams('tc:turnA'));
    const b = await seal(turnParams('tc:turnB'));
    expect(a.mint_disposition).toBe('eligible');
    expect(b.mint_disposition).toBe('eligible');
    expect(a.estimatedPVT).toBeGreaterThan(0);
    expect(b.estimatedPVT).toBeGreaterThan(0);
  });

  it('(ii) the SAME turn resubmitted mints exactly once — the second records as a duplicate, 0', async () => {
    const first = await seal(turnParams('tc:same'));       // distinct PE ids,
    const second = await seal(turnParams('tc:same'));      // same turn identity
    expect(first.mint_disposition).toBe('eligible');
    expect(first.estimatedPVT).toBeGreaterThan(0);
    expect(second.mint_status).toBe('corroborated_duplicate');
    expect(second.estimatedPVT).toBe(0);
  });

  it('(iii) the SAME turn from BOTH sources mints exactly once', async () => {
    // The OTel PE and the transcript PE for ONE turn carry the SAME turn_id
    // (their tool-call id sets match); the second to arrive is the duplicate.
    const otel = await seal(turnParams('tc:cross', { tool: 'provian-observer-otel', trace_id: 'traceX' }));
    const transcript = await seal(turnParams('tc:cross', { tool: 'provian-observer-transcript', source: 'transcript' }));
    expect(otel.mint_disposition).toBe('eligible');
    expect(otel.estimatedPVT).toBeGreaterThan(0);
    expect(transcript.mint_status).toBe('corroborated_duplicate');
    expect(transcript.estimatedPVT).toBe(0);
  });

  it('the TRANSCRIPT lane alone now EARNS (turn_id gives it the canonical event trace_id never did)', async () => {
    // The parity fix, end to end: a transcript-source PE with a turn_id but NO
    // trace_id seals eligible and non-zero — it minted 0 before this pass.
    const sealed = await seal(turnParams('tf:deadbeefdeadbeef:7', { tool: 'provian-observer-transcript', source: 'transcript' }));
    expect(sealed.mint_disposition).toBe('eligible');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// link_spend — the Stripe Link spend witness on the daemon (device) route.
// ---------------------------------------------------------------------------
describe(' link_spend on the device route', () => {
  const spend = {
    link_spend_id: 'lsrq_1AbCdEfGhIjKlMnOpQrStUv', amount: 3500, currency: 'usd', status: 'succeeded',
    merchant_name: 'Example Books', merchant_url: 'https://books.example.com/x',
  };

  it('body-bound + SUCCEEDED spend → verified overlay keyed on the spend-request id', () => {
    const o = deviceWitnessedVerifiedFields({
      actionType: 'link_spend', bodyBound: true, metadata: spend, sessionLineageId: null,
    });
    expect(o.economicEvidenceState).toBe('verified');
    expect(o.durableReplaySource).toBe(ORDINARY_ACCRUAL_REPLAY_SOURCE);
    expect(o.economicCanonicalEventId).toBe('link_spend:lsrq_1AbCdEfGhIjKlMnOpQrStUv');
    expect(typeof o.deviceWitnessedOccurrenceHash).toBe('string');
  });

  it('MINT-ONCE: a replay of the same spend-request id (any other field changed) keys to the SAME occurrence hash', () => {
    const a = deviceWitnessedVerifiedFields({ actionType: 'link_spend', bodyBound: true, metadata: spend, sessionLineageId: null });
    const b = deviceWitnessedVerifiedFields({
      actionType: 'link_spend', bodyBound: true, sessionLineageId: null,
      metadata: { ...spend, amount: 1, merchant_name: 'Other', approved_at: 42 },
    });
    expect(b.deviceWitnessedOccurrenceHash).toBe(a.deviceWitnessedOccurrenceHash);
    const c = deviceWitnessedVerifiedFields({
      actionType: 'link_spend', bodyBound: true, sessionLineageId: null,
      metadata: { ...spend, link_spend_id: 'lsrq_ZzYyXxWwVvUuTtSsRrQq' },
    });
    expect(c.deviceWitnessedOccurrenceHash).not.toBe(a.deviceWitnessedOccurrenceHash);
  });

  it('RED : a transcript-lane record with no Link invocation binding → empty overlay; with one → verified', () => {
    const transcript = { ...spend, source: 'transcript', tool: 'provian:transcript' };
    expect(deviceWitnessedVerifiedFields({
      actionType: 'link_spend', bodyBound: true, metadata: transcript, sessionLineageId: null,
    })).toEqual({});
    expect(deviceWitnessedVerifiedFields({
      actionType: 'link_spend', bodyBound: true, metadata: { ...transcript, link_spend_binding: 'link_cli:retrieve' }, sessionLineageId: null,
    }).economicCanonicalEventId).toBe('link_spend:lsrq_1AbCdEfGhIjKlMnOpQrStUv');
  });

  it('RED: a non-succeeded terminal (failed) → empty overlay (records, mints nothing)', () => {
    expect(deviceWitnessedVerifiedFields({
      actionType: 'link_spend', bodyBound: true, metadata: { ...spend, status: 'failed' }, sessionLineageId: null,
    })).toEqual({});
  });

  it('RED: a malformed spend-request id → empty overlay', () => {
    expect(deviceWitnessedVerifiedFields({
      actionType: 'link_spend', bodyBound: true, metadata: { ...spend, link_spend_id: 'pi_123' }, sessionLineageId: null,
    })).toEqual({});
  });

  it('RED: NOT body-bound → empty overlay even for a clean succeeded spend', () => {
    expect(deviceWitnessedVerifiedFields({
      actionType: 'link_spend', bodyBound: false, metadata: spend, sessionLineageId: null,
    })).toEqual({});
  });
});
