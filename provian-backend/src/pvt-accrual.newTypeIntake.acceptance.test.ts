/**
 * NEW-TYPE INTAKE through the REAL lanes and the REAL accrual .
 *
 * A3 — the pending-policy queue gets rows ONLY from witnessed lanes. Every lane is enumerated:
 * bare sovereign (no witness) → refused, nothing queued; unmarked device act → refused,
 * nothing queued; phone batch unnamed type → recorded at actor_declared, NOT queued; marked
 * gateway act → recorded record_only, queued under `device_gateway_observer`; hardware
 * sovereign → recorded record_only, queued under `sovereign_hardware_witness`.
 * A4 — EARNS FROM SIGNING. With a SIGNED FIXTURE row (the runtime policy loader is wrapped in
 * this suite only — the real matrix and template never move): an act recorded before the
 * row's effective time seals record_only and is never repriced; an act after it mints once
 * at the row's price; a byte-identical replay records 0. RED controls: the same post-cut act
 * without the intake overlay (no durability claim), and with a record_only signed row, both
 * seal record_only.
 *
 * Device acts go through the real `deviceActToAccrualParams`; the co-committed ordinary-accrual
 * intake row a production lane writes is written here with the real builder, so the durability
 * fence is verified exactly as in production (never the `throwOnError` stand-in).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { BeneficiaryCacheEntry } from './core/pvt/beneficiary';
import type { FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';
import type { ActionMonetaryPolicy, MonetaryPolicyVersion } from './core/pvt/policy/monetary-accounting';
import type { ActionPolicyGateResolution } from './core/pvt/policy/action-policy-gate';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./core/pvt/__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
jest.mock('./cache', () => ({
  cache: {
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: async () => 1,
    incrementHourlyPECount: async () => {},
    commitPEAccountingCountersOnce: async () => ({ idempotent: false }),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
jest.mock('./core/pvt/beneficiary', () => ({
  resolveBeneficiary: async (): Promise<BeneficiaryCacheEntry> => ({
    linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
  }),
}));
jest.mock('./core/jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('./core/pvt/delegation-pe', () => ({ isDelegationQualifying: () => false, createDelegationPE: async () => {} }));
jest.mock('./core/provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'compute', recordActionTypeObservation: async () => {},
}));
jest.mock('./core/foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }), queueInitialMembershipGrants: async () => {},
}));

/** The SIGNED FIXTURE: when on, the runtime policy carries a named row for these types from `effectiveAtMs`. */
const mockSigned: { types: Set<string>; effectiveAtMs: number; row: ActionMonetaryPolicy | null } = {
  types: new Set(), effectiveAtMs: Number.MAX_SAFE_INTEGER, row: null,
};
/**
 * Signing an intake type is TWO edits: the signed matrix row (modelled by `mockSigned` above) AND
 * its `INTAKE_SIGNED_ACTION_TYPES` entry for the lane(s) the operator signed it for (mocked here, empty
 * until each test signs). The fixture type is not in the static matrix, so rule (i) still admits it
 * here; the named-from-load path, where the grant is load-bearing, is
 * `pvt-accrual.newTypeIntake.squat.acceptance.test.ts`.
 */
jest.mock('./core/pvt/policy/intake-signed-action-types', () => ({ INTAKE_SIGNED_ACTION_TYPES: {} }));
function intakeGrants(): Record<string, string[]> {
  return (jest.requireMock('./core/pvt/policy/intake-signed-action-types') as {
    INTAKE_SIGNED_ACTION_TYPES: Record<string, string[]>;
  }).INTAKE_SIGNED_ACTION_TYPES;
}
function signForIntake(type: string, disposition: 'eligible' | 'record_only', lanes: string[]): void {
  mockSigned.types = new Set([type]);
  mockSigned.effectiveAtMs = CUT;
  mockSigned.row = signedRow(type, disposition);
  intakeGrants()[type] = lanes;
}

jest.mock('./core/pvt/policy/runtime-monetary-policy', () => {
  const actual = jest.requireActual('./core/pvt/policy/runtime-monetary-policy') as typeof import('./core/pvt/policy/runtime-monetary-policy');
  return {
    ...actual,
    loadRuntimeMonetaryPolicy: async (db: unknown, recordedAtMs: number, resolution: ActionPolicyGateResolution): Promise<MonetaryPolicyVersion> => {
      const policy = await actual.loadRuntimeMonetaryPolicy(db as never, recordedAtMs, resolution);
      if (mockSigned.row === null || !mockSigned.types.has(resolution.actionType) || recordedAtMs < mockSigned.effectiveAtMs) return policy;
      // The signed matrix row is in force: a named row always wins over the class synthesis.
      return Object.freeze({ ...policy, actions: Object.freeze({ ...policy.actions, [resolution.actionType]: mockSigned.row }) });
    },
  };
});

import type { Firestore } from 'firebase-admin/firestore';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { recordPEAccrual, type RecordPEAccrualParams } from './pvt-accrual';
import { deviceActToAccrualParams, type DeviceBatchLane } from './core/meter/device-act';
import type { ActRecord } from './core/meter/meter-wire';
import type { DeviceDocument } from './routes/middleware/device-auth';
import { buildOrdinaryAccrualIntake, createOrdinaryAccrualIntakeInTransaction, ORDINARY_ACCRUAL_REPLAY_SOURCE } from './core/pvt/wp11/ordinary-accrual-intake';
import {
  DEVICE_GATEWAY_OBSERVER_SOURCE,
  OBSERVER_PLUGIN_SOURCE,
  SOVEREIGN_HARDWARE_WITNESS_SOURCE,
  newTypeIntakeCache,
} from './core/pvt/policy/new-type-intake';
import { createSovereignPERouter } from './routes/sovereign-pe';
import type { WitnessClass } from './core/pvt/policy/evidence-class';

const NOW = Date.UTC(2026, 9, 22, 12);
const CUT = NOW + 60_000;
const SENSOR = ['soil', 'moisture', 'reading', 'acceptance'].join('_');
const MARKER = { source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'sensor-gateway' };

/** A plausible row the operator might sign for a sensor reading (eligible, witness-class evidence). */
function signedRow(type: string, disposition: 'eligible' | 'record_only'): ActionMonetaryPolicy {
  const earns = disposition === 'eligible';
  return Object.freeze({
    category: 'compute', baseWeightBps: earns ? 10_000 : 0, policyOverrideBps: null,
    mintDisposition: disposition, mintReasonCode: earns ? 'policy_eligible' : 'policy_record_only',
    policyReviewState: 'not_required', policyReviewReasonCode: 'known_policy_entry',
    financialAttestationNeutral: false, attestationPricing: 'standard', allowVerifiedAttestationUpgrade: false,
    evidenceRequirement: earns ? 'verified_witness_class' : 'none', canonicalEventRequired: earns,
    canonicalEventGroup: `signed_fixture:${type}`,
    beneficialOwnershipPolicy: earns ? 'record_only_if_self_shared_or_churn' : 'not_applicable',
    sessionLineagePolicy: earns ? 'optional' : 'not_applicable', fixedGrantSource: 'none',
    evidenceResolutionMode: earns ? 'projection_with_verified_evidence' : 'not_applicable',
  } as ActionMonetaryPolicy);
}

function fs(): Firestore { return mockDb as unknown as Firestore; }

function deviceLane(): DeviceBatchLane {
  return {
    db: fs(),
    device: { owner_type: 'human', device_id: 'dev_gw_1', owner_user_id: 'human_gw', owner_wallet_id: 'w_gw', owner_address: '0xabc' } as DeviceDocument,
    ownerId: 'human_gw', signatureAuthenticated: true, bodyBound: true, attestationTier: 'software',
    receivedAtMs: NOW, lineage: null, lineageTouched: false, intakeCache: newTypeIntakeCache(),
  };
}

let seq = 0;
function sensorAct(timestamp: number, metadata: Record<string, unknown> | null = MARKER, type = SENSOR): ActRecord {
  seq += 1;
  return {
    action_type: type, pe_id: `pe_dev_${seq}`, timestamp, prev_hash: `prev_${seq}`, pe_hash: `sha256:${seq.toString(16).padStart(64, '0')}`,
    pricing: { ...(metadata ? { metadata } : {}), output_digests: [{ hash: `sha256:${'c'.repeat(64)}`, kind: 'sensor' }] },
  };
}

/** Commit the ordinary-accrual intake row a durable lane co-writes, then run the REAL accrual. */
async function seal(params: RecordPEAccrualParams): Promise<{ disposition: string; points: bigint; duplicate: unknown; witness: unknown }> {
  if (params.durableReplaySource !== undefined) {
    const intake = buildOrdinaryAccrualIntake({ prevHash: 'prev', peHash: params.peHash, accrualParams: params });
    await mockDb.runTransaction(async (txn) => {
      createOrdinaryAccrualIntakeInTransaction(txn as never, fs() as never, intake);
    });
  }
  await recordPEAccrual(params);
  const row = mockDb.store.get(`pe_history/${params.peId}`) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`no pe_history row for ${params.peId}`);
  const factors = (row.economic_snapshot as { recordTimeFactors?: Record<string, unknown> } | null)?.recordTimeFactors;
  return {
    disposition: String(row.mint_disposition),
    points: BigInt(String(row.estimated_pvt_atomic ?? '0')),
    duplicate: factors?.exactDuplicate,
    witness: row.witness_class,
  };
}

type DeviceOutcome =
  | { readonly refused: string }
  | { readonly sealed: Awaited<ReturnType<typeof seal>>; readonly params: RecordPEAccrualParams };

async function sealDeviceAct(act: ActRecord, relayPeId: string): Promise<DeviceOutcome> {
  const mapped = await deviceActToAccrualParams(deviceLane(), act, relayPeId);
  if (!mapped.ok) return { refused: mapped.reason };
  return { sealed: await seal(mapped.params), params: mapped.params };
}

/** The sealed half of a device outcome; a refusal fails the test loudly. */
function recorded(out: DeviceOutcome): { sealed: Awaited<ReturnType<typeof seal>>; params: RecordPEAccrualParams } {
  if ('refused' in out) throw new Error(`refused: ${out.refused}`);
  return out;
}

function sovereignParams(peId: string, timestamp: number, actionType = SENSOR, witnessClass: WitnessClass = 'hardware_rooted'): RecordPEAccrualParams {
  // The exact accrual input generatePE builds for the sovereign route's admitted path.
  const signer = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
  const occurrence = `reading:${peId}`;
  return {
    peId, userId: 'agent_sov', actionType, integrationSource: 'agent_bank_generate_pe', attestationDepth: 'software',
    peHash: `h_${peId}`, timestamp, durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    sovereignWorkOccurrenceId: occurrence, sovereignWorkSignerAddress: signer,
    economicEvidenceState: 'verified', economicCanonicalEventId: `sovereign_work:${signer.toLowerCase()}:${occurrence}`,
    ownerType: 'agent', walletAddress: signer, witnessClass, witnessedAtMs: timestamp,
  } as RecordPEAccrualParams;
}

function queueRows(): Array<Record<string, unknown>> {
  return [...mockDb.store.entries()].filter(([k]) => k.startsWith('pvt_pending_policy_queue/')).map(([, v]) => v);
}

beforeEach(() => {
  mockDb.store.clear();
  mockDb.ops.length = 0;
  mockSigned.types = new Set();
  mockSigned.effectiveAtMs = Number.MAX_SAFE_INTEGER;
  mockSigned.row = null;
  for (const k of Object.keys(intakeGrants())) delete intakeGrants()[k];
  // The sovereign agent's wallet (the accrual's durable effects resolve the agent by agent_id).
  mockDb.store.set('agent_wallets/wallet_sov', {
    id: 'wallet_sov', agent_id: 'agent_sov', address: '0x90f8bf6a479f320ead074411a4b0e7944ea8c9c1', status: 'active',
  });
});

describe('A3 — the queue gets rows ONLY from witnessed lanes (every lane enumerated)', () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  afterAll(() => errorSpy.mockRestore());

  it('bare sovereign (no witness) → refused at the route, nothing recorded, nothing queued', async () => {
    const agent = new ethers.Wallet('0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d');
    const fields = { action_type: SENSOR, agent_address: agent.address, occurrence_id: 'reading:bare:000001', nonce: `0x${'aa'.repeat(32)}`, iat: Date.now() };
    const message = ['provian_sovereign_work_v1', `action_type=${fields.action_type}`, `agent_address=${fields.agent_address.toLowerCase()}`,
      `iat=${fields.iat}`, `nonce=${fields.nonce}`, `occurrence_id=${fields.occurrence_id}`].join('\n');
    const app = express();
    app.use(express.json());
    app.use('/s', createSovereignPERouter({ db: fs(), cache: { setNx: async () => true, del: async () => 0, checkRateLimit: async () => ({ allowed: true }) } } as never));
    const res = await request(app).post('/s').send({ ...fields, signature: await agent.signMessage(message) });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('no_non_actor_witness');
    expect(queueRows()).toEqual([]);
    expect([...mockDb.store.keys()].filter((k) => k.startsWith('pe_history/'))).toEqual([]);
  });

  it('unmarked device act of a never-seen type → refused, nothing queued', async () => {
    const out = await sealDeviceAct(sensorAct(NOW, null), 'pe_unmarked');
    expect(out).toEqual({ refused: 'actor_declared:action_type_not_observed' });
    expect(queueRows()).toEqual([]);
  });

  it('phone batch unnamed type → recorded at actor_declared, record_only, NOT queued', async () => {
    const s = await seal({
      peId: 'pe_phone', userId: 'human_phone', actionType: SENSOR, integrationSource: 'mobile_pe_submit',
      attestationDepth: 'software', peHash: 'h_phone', timestamp: NOW, ownerType: 'human', witnessClass: 'actor_declared',
    } as RecordPEAccrualParams);
    expect(s).toMatchObject({ disposition: 'record_only', points: 0n, witness: 'actor_declared' });
    expect(queueRows()).toEqual([]);
  });

  it('marked gateway act → recorded record_only at device_tier, queued under device_gateway_observer', async () => {
    const out = await sealDeviceAct(sensorAct(NOW), 'pe_gw');
    expect(recorded(out).sealed).toMatchObject({ disposition: 'record_only', points: 0n, witness: 'device_tier' });
    const rows = queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action_type: SENSOR, policy_review_state: 'pending_policy', integration_sources: [DEVICE_GATEWAY_OBSERVER_SOURCE] });
  });

  it('hardware sovereign → recorded record_only at hardware_rooted, queued under sovereign_hardware_witness', async () => {
    const s = await seal(sovereignParams('pe_sov_hw', NOW));
    expect(s).toMatchObject({ disposition: 'record_only', points: 0n, witness: 'hardware_rooted' });
    const rows = queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action_type: SENSOR, integration_sources: [SOVEREIGN_HARDWARE_WITNESS_SOURCE] });
  });

  it('RED — the pre-ruling queue gate (any class_admitted) WOULD have queued the phone\'s actor-declared type', async () => {
    // The same phone submission at a witnessed class is exactly what the old gate queued for
    // actor_declared too; this shows the queue write itself is reachable from this harness, so the
    // empty-queue assertion above is not vacuous.
    await seal({
      peId: 'pe_phone_ctl', userId: 'human_phone', actionType: SENSOR, integrationSource: 'mobile_pe_submit',
      attestationDepth: 'software', peHash: 'h_phone_ctl', timestamp: NOW, ownerType: 'human', witnessClass: 'device_tier',
    } as RecordPEAccrualParams);
    expect(queueRows()).toHaveLength(1);
  });
});

describe('A4 — a never-seen type earns ONLY from the signed row\'s activation forward', () => {
  it('device gateway lane: before the cut record_only (never repriced); after the cut mints once; a replay records 0', async () => {
    // 1. Before the operator signs: recorded, queued, zero.
    const before = await sealDeviceAct(sensorAct(CUT - 1), 'pe_before');
    expect(recorded(before).sealed).toMatchObject({ disposition: 'record_only', points: 0n });

    // 2. the operator signs an eligible row effective at CUT.
    signForIntake(SENSOR, 'eligible', [DEVICE_GATEWAY_OBSERVER_SOURCE]);

    // An act whose record time predates the cut still finds no row in force → record_only.
    const late = await sealDeviceAct(sensorAct(CUT - 1), 'pe_late_record');
    expect(recorded(late).sealed).toMatchObject({ disposition: 'record_only', points: 0n });

    // 3. From the cut: mints once at the row's price.
    const act = sensorAct(CUT + 1);
    const after = await sealDeviceAct(act, 'pe_after');
    expect(recorded(after).sealed.disposition).toBe('eligible');
    expect(recorded(after).sealed.points > 0n).toBe(true);
    expect(recorded(after).params.economicCanonicalEventId).toMatch(/^new_type_intake:/);

    // 4. A byte-identical replay of that act (same body digest, new relay id) records 0.
    const replay = await sealDeviceAct(act, 'pe_after_replay');
    expect(recorded(replay).sealed).toMatchObject({ duplicate: true, points: 0n });

    // 5. Nothing sealed before the signature was repriced.
    expect((mockDb.store.get('pe_history/pe_before') as Record<string, unknown>).mint_disposition).toBe('record_only');
  });

  it('RED — the same post-cut act WITHOUT the intake overlay (no durability claim) seals record_only', async () => {
    signForIntake(SENSOR, 'eligible', [DEVICE_GATEWAY_OBSERVER_SOURCE]);
    const mapped = await deviceActToAccrualParams(deviceLane(), sensorAct(CUT + 1), 'pe_no_overlay');
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.params.durableReplaySource).toBe(ORDINARY_ACCRUAL_REPLAY_SOURCE); // the overlay fired…
    const { durableReplaySource: _d, economicCanonicalEventId: _c, deviceWitnessedOccurrenceHash: _h, economicEvidenceState: _e, ...stripped } = mapped.params;
    const s = await seal(stripped as RecordPEAccrualParams); // …and without it nothing mints
    expect(s).toMatchObject({ disposition: 'record_only', points: 0n });
  });

  it('RED — a record_only signed row gives no overlay and seals record_only', async () => {
    signForIntake(SENSOR, 'record_only', [DEVICE_GATEWAY_OBSERVER_SOURCE]);
    const out = await sealDeviceAct(sensorAct(CUT + 1), 'pe_ro_row');
    expect(recorded(out).params.durableReplaySource).toBeUndefined();
    expect(recorded(out).sealed).toMatchObject({ disposition: 'record_only', points: 0n });
  });

  it('sovereign lane: before the cut record_only; after the cut mints once on the occurrence; replay records 0', async () => {
    expect(await seal(sovereignParams('pe_sov_pre', CUT - 1))).toMatchObject({ disposition: 'record_only', points: 0n });
    signForIntake(SENSOR, 'eligible', [SOVEREIGN_HARDWARE_WITNESS_SOURCE]);
    const post = await seal(sovereignParams('pe_sov_post', CUT + 1));
    expect(post.disposition).toBe('eligible');
    expect(post.points > 0n).toBe(true);
    // Same (signer, occurrence) under a fresh pe id → the occurrence claim is taken → 0.
    const replay = await seal({ ...sovereignParams('pe_sov_post', CUT + 2), peId: 'pe_sov_post_replay', peHash: 'h_replay' });
    expect(replay).toMatchObject({ duplicate: true, points: 0n });
    expect((mockDb.store.get('pe_history/pe_sov_pre') as Record<string, unknown>).mint_disposition).toBe('record_only');
  });
});
