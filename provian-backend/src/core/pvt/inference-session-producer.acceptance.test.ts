/**
 * HUMAN-LANE INFERENCE PRODUCER — the money outcome, sealed through the REAL
 * accrual with the PE shaped EXACTLY as the zero-config local-inference
 * producer emits it (`provian-agent-sdk/src/observer/plugins/LLMPlugin.ts` →
 * `ProvianObserver.finalizeSession`, pinned on the SDK side by
 * `LLMPlugin.localInference.test.ts`):
 *
 * action_type: inference_session
 * metadata.inference: { runtime, requests, models, source, tokens_observed:false }
 * compute.tokens_processed: null (Ollama exposes no token counts — never fabricated)
 * economic_session_lineage: present (pesl2_…, minted by the attested observer session)
 * body-bound: yes (X-Provian-Body-HMAC on a bearer daemon / SE signature)
 *
 * The relay's record-time overlay for this family is `deviceWitnessedVerifiedFields`
 * (, `core/pvt/device-witnessed-earning.ts`, applied at `routes/devices.ts`
 * `witnessedVerifiedFields`). This suite drives THAT function — the single
 * source the route reads, never a redeclared literal — and then the REAL
 * `recordPEAccrual` against a fake Firestore (the / harness), and
 * asserts a body-bound producer PE seals `eligible` with NON-ZERO record points
 * at BOTH device tiers the daemon can hold (bearer → software 0.8×, Mac SE →
 * hardware_partial 1.0×).
 *
 * RED controls, in-suite and permanent:
 * - the SAME PE not body-bound → the overlay is empty → `record_only`, 0;
 * - the SAME PE with NO session lineage (an unattested daemon) → empty overlay → `record_only`, 0;
 * - a REPLAY of the identical session → `device_occurrence` exactDuplicate → 0 (mint-once);
 * - tokens are irrelevant to admission: `tokens_observed` true/false price identically
 * (an Ollama session is not discounted for a token count the runtime never exposes).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from './beneficiary';
import { deviceWitnessedVerifiedFields } from './device-witnessed-earning';

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

const TIMESTAMP = Date.UTC(2026, 8, 3, 17, 30);
let seq = 0;

/** The producer's `metadata` for an Ollama window, verbatim shape. */
function producerMetadata(over: Partial<{ requests: number; tokens_observed: boolean }> = {}): Record<string, unknown> {
  return {
    tool: 'provian-observer',
    session_reason: 'idle',
    network_calls: 0,
    inference: {
      runtime: 'ollama',
      requests: over.requests ?? 3,
      models: ['llama3.1:8b'],
      source: 'ollama_server_log',
      tokens_observed: over.tokens_observed ?? false,
    },
    plugin_artifacts: {
      llm: { runtime: 'ollama', requests_this_tick: 1, models: ['llama3.1:8b'], tokens_observed: false },
    },
  };
}

/** The producer's `compute` block for an Ollama window: duration only, tokens NULL. */
const PRODUCER_COMPUTE = {
  duration_ms: 42_000,
  cpu_seconds: null,
  memory_peak_mb: null,
  tokens_processed: null,
  output_cardinality: null,
  records_processed: null,
  energy_joules: null,
  gpu_seconds: null,
  model_parameters: null,
  framework: null,
  hardware_class: 'arm64',
};

interface PeRow {
  mint_status: string;
  mint_disposition: string;
  estimatedPVT: number;
  economic_snapshot: {
    recordPointsAtomic: string;
    recordTimeFactors?: { attestationMultiplierBps?: number; exactDuplicate?: boolean };
  } | null;
}

/**
 * The exact params `routes/devices.ts` builds for the producer's submission:
 * the base accrual inputs plus the REAL overlay for (bodyBound, lineage).
 */
function producerParams(input: {
  bodyBound: boolean;
  sessionLineageId: string | null;
  attestationDepth: 'software' | 'hardware_partial';
  metadata?: Record<string, unknown>;
  userId?: string;
}): RecordPEAccrualParams {
  const peId = `pe_inf_${seq++}`;
  const metadata = input.metadata ?? producerMetadata();
  const overlay = deviceWitnessedVerifiedFields({
    actionType: 'inference_session',
    bodyBound: input.bodyBound,
    metadata,
    sessionLineageId: input.sessionLineageId,
  });
  return {
    peId,
    userId: input.userId ?? 'human_ollama_user',
    actionType: 'inference_session',
    integrationSource: 'device_pe_submit',
    attestationDepth: input.attestationDepth,
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    isDevicePE: true,
    deviceAttestationId: 'dev_fixture_ollama',
    ...overlay,
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

/** A real-shaped lineage id (pesl2_ + 40 hex), as the SDK mints it. */
const LINEAGE = 'pesl2_' + 'a1b2c3d4e5f6a7b8c9d0'.repeat(2);

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.store.clear();
  mockDb.ops.length = 0;
  seq = 0;
});

describe('the wire shape → the overlay (single source: deviceWitnessedVerifiedFields)', () => {
  it('a body-bound producer PE with a lineage gets the full durable/verified overlay keyed on the session', () => {
    const o = deviceWitnessedVerifiedFields({
      actionType: 'inference_session', bodyBound: true, metadata: producerMetadata(), sessionLineageId: LINEAGE,
    });
    expect(o.economicEvidenceState).toBe('verified');
    expect(o.economicCanonicalEventId).toBe(`inference_session:${LINEAGE}`);
    expect(typeof o.deviceWitnessedOccurrenceHash).toBe('string');
    expect(typeof o.durableReplaySource).toBe('string');
  });

  it('the producer\'s compute block carries tokens_processed:null — the overlay never reads tokens, so null is not a demotion', () => {
    expect(PRODUCER_COMPUTE.tokens_processed).toBeNull();
    const noTokens = deviceWitnessedVerifiedFields({
      actionType: 'inference_session', bodyBound: true, metadata: producerMetadata({ tokens_observed: false }), sessionLineageId: LINEAGE,
    });
    const withTokens = deviceWitnessedVerifiedFields({
      actionType: 'inference_session', bodyBound: true, metadata: producerMetadata({ tokens_observed: true }), sessionLineageId: LINEAGE,
    });
    expect(noTokens).toEqual(withTokens);
  });
});

describe('MONEY OUTCOME — a body-bound inference_session shaped as the producer emits it MINTS', () => {
  it('bearer daemon (software tier): eligible, NON-ZERO record points, priced 0.8× (8000 bps)', async () => {
    const sealed = await seal(producerParams({ bodyBound: true, sessionLineageId: LINEAGE, attestationDepth: 'software' }));
    expect(sealed.mint_disposition).toBe('eligible');
    expect(sealed.mint_status).toBe('eligible');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
    expect(BigInt(sealed.economic_snapshot!.recordPointsAtomic)).toBeGreaterThan(0n);
    expect(sealed.economic_snapshot!.recordTimeFactors?.attestationMultiplierBps).toBe(8000);
    expect(sealed.economic_snapshot!.recordTimeFactors?.exactDuplicate).toBe(false);
  });

  it('Mac Secure Enclave daemon (hardware_partial tier): eligible, NON-ZERO, priced at its normal lane class under ', async () => {
    const sealed = await seal(producerParams({ bodyBound: true, sessionLineageId: LINEAGE, attestationDepth: 'hardware_partial' }));
    expect(sealed.mint_disposition).toBe('eligible');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
    expect(BigInt(sealed.economic_snapshot!.recordPointsAtomic)).toBeGreaterThan(0n);
    expect(sealed.economic_snapshot!.recordTimeFactors?.attestationMultiplierBps).toBe(8000);
  });

  it('an SE signature without App Attest prices like its bearer lane for the identical window', async () => {
    const bearer = await seal(producerParams({ bodyBound: true, sessionLineageId: LINEAGE, attestationDepth: 'software', userId: 'u_bearer' }));
    const se = await seal(producerParams({ bodyBound: true, sessionLineageId: LINEAGE, attestationDepth: 'hardware_partial', userId: 'u_se' }));
    expect(se.economic_snapshot!.recordPointsAtomic).toBe(bearer.economic_snapshot!.recordPointsAtomic);
  });
});

describe('RED CONTROLS — the same PE under the pre-fix / forbidden conditions records 0', () => {
  it('NOT body-bound (bearer with no body-HMAC) → empty overlay → record_only, 0', async () => {
    const params = producerParams({ bodyBound: false, sessionLineageId: LINEAGE, attestationDepth: 'software' });
    // The overlay contributed nothing: exactly what devices.ts seals for an unbound submit.
    expect(params.economicEvidenceState).toBeUndefined();
    expect(params.economicCanonicalEventId).toBeUndefined();
    const sealed = await seal(params);
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.estimatedPVT).toBe(0);
  });

  it('NO session lineage (an unattested daemon, or a PE captured outside its session) → record_only, 0', async () => {
    const params = producerParams({ bodyBound: true, sessionLineageId: null, attestationDepth: 'software' });
    expect(params.economicCanonicalEventId).toBeUndefined();
    const sealed = await seal(params);
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.estimatedPVT).toBe(0);
  });

  it('a REPLAY of the identical session (same lineage, same actor) → device_occurrence exactDuplicate → 0 (mint-once holds)', async () => {
    const first = await seal(producerParams({ bodyBound: true, sessionLineageId: LINEAGE, attestationDepth: 'software' }));
    expect(first.estimatedPVT).toBeGreaterThan(0);

    const replay = await seal(producerParams({ bodyBound: true, sessionLineageId: LINEAGE, attestationDepth: 'software' }));
    expect(replay.mint_status).toBe('corroborated_duplicate');
    expect(replay.estimatedPVT).toBe(0);
    expect(replay.economic_snapshot!.recordTimeFactors?.exactDuplicate).toBe(true);
  });

  it('RED reachability: a DIFFERENT session (new lineage) mints again — dedup is per session, not a blanket zero', async () => {
    const a = await seal(producerParams({ bodyBound: true, sessionLineageId: LINEAGE, attestationDepth: 'software' }));
    const other = 'pesl2_' + 'f0e1d2c3b4a5968778695a4b'.repeat(1) + '0011223344556677';
    const b = await seal(producerParams({ bodyBound: true, sessionLineageId: other, attestationDepth: 'software' }));
    expect(a.estimatedPVT).toBeGreaterThan(0);
    expect(b.estimatedPVT).toBeGreaterThan(0);
    expect(b.mint_status).not.toBe('corroborated_duplicate');
  });
});
