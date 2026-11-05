/**
 * REVIEW FIX 1 (money safety) — squatting a name another lane owns, through the REAL device lane
 * and the REAL accrual.
 *
 * The attack: an intake lane records a name before it is signed, then the operator signs that name for a
 * DIFFERENT lane (a forge, the relay). If rule (ii) admitted the intake lane on that queue row, the
 * intake lane would mint the other lane's price with no such witness. Here a type that is NAMED
 * from load (the signed fixture), with an eligible signed row in force, is submitted by a marked
 * gateway act against two queue rows:
 * - the row ALSO lists a forge/relay source (`agent_bank_generate_pe`) → refused, nothing sealed;
 * - RED control: the identical row listing ONLY the gateway lane → admitted and mints once, so the
 * refusal above is the source check, not an inert harness.
 * A relay-owned name (`service:github_issues`) is refused outright on the same lane.
 *
 * , A — rule (ii) is a POSITIVE grant. The fixture is signed for the gateway lane in
 * `INTAKE_SIGNED_ACTION_TYPES` (mocked here, as the signing change would add it). RED: the same
 * intake-only resolved row WITHOUT the grant is refused and nothing is sealed, and a relay type
 * emitted from constants (`bond_slashed`) pre-queued by the gateway is refused with an
 * eligible row in force — it never mints at the relay row's price (without the grant it sealed
 * eligible and minted 1.6 PVT here).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { BeneficiaryCacheEntry } from './core/pvt/beneficiary';
import type { FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';
import type { ActionMonetaryPolicy, MonetaryPolicyVersion } from './core/pvt/policy/monetary-accounting';
import type { ActionPolicyGateResolution } from './core/pvt/policy/action-policy-gate';

const SIGNED_FIXTURE = ['kiln', 'cycle', 'signed', 'fixture'].join('_');
/** The fixture is a NAMED matrix row from load (the operator has signed it), not a launch emitter. */
jest.mock('./core/pvt/policy/proposed-action-policy', () => {
  const actual = jest.requireActual('./core/pvt/policy/proposed-action-policy') as typeof import('./core/pvt/policy/proposed-action-policy');
  const template = actual.PROPOSED_ACTION_POLICY_ENTRIES.find((e) => e.mint_disposition === 'eligible');
  if (!template) throw new Error('no eligible row');
  return { ...actual, PROPOSED_ACTION_POLICY_ENTRIES: [...actual.PROPOSED_ACTION_POLICY_ENTRIES, { ...template, action_type: ['kiln', 'cycle', 'signed', 'fixture'].join('_') }] };
});

/** Signing = the matrix row (above) AND the intake grant for the lane the operator signed it for. */
jest.mock('./core/pvt/policy/intake-signed-action-types', () => ({
  INTAKE_SIGNED_ACTION_TYPES: { [['kiln', 'cycle', 'signed', 'fixture'].join('_')]: ['device_gateway_observer'] },
}));
function setIntakeGrant(type: string, lanes: string[] | undefined): void {
  const list = (jest.requireMock('./core/pvt/policy/intake-signed-action-types') as {
    INTAKE_SIGNED_ACTION_TYPES: Record<string, string[]>;
  }).INTAKE_SIGNED_ACTION_TYPES;
  if (lanes === undefined) delete list[type]; else list[type] = lanes;
}

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
import { recordPEAccrual, type RecordPEAccrualParams } from './pvt-accrual';
import { deviceActToAccrualParams, type DeviceBatchLane } from './core/meter/device-act';
import type { ActRecord } from './core/meter/meter-wire';
import type { DeviceDocument } from './routes/middleware/device-auth';
import { buildOrdinaryAccrualIntake, createOrdinaryAccrualIntakeInTransaction } from './core/pvt/wp11/ordinary-accrual-intake';
import { DEVICE_GATEWAY_OBSERVER_SOURCE, OBSERVER_PLUGIN_SOURCE, isNeverSeenActionType, newTypeIntakeCache } from './core/pvt/policy/new-type-intake';
import { PENDING_POLICY_COLLECTION, actionPolicyDocumentId } from './core/pvt/policy/pending-policy-queue';

const NOW = Date.UTC(2026, 9, 23, 12);
const CUT = NOW - 60_000;
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



function lane(): DeviceBatchLane {
  return {
    db: fs(),
    device: { owner_type: 'human', device_id: 'dev_gw_1', owner_user_id: 'human_gw', owner_wallet_id: 'w_gw', owner_address: '0xabc' } as DeviceDocument,
    ownerId: 'human_gw', signatureAuthenticated: true, bodyBound: true, attestationTier: 'software',
    receivedAtMs: NOW, lineage: null, lineageTouched: false, intakeCache: newTypeIntakeCache(),
  };
}

let seq = 0;
function act(type: string): ActRecord {
  seq += 1;
  return {
    action_type: type, pe_id: `pe_sq_${seq}`, timestamp: NOW, prev_hash: `prev_${seq}`, pe_hash: `sha256:${seq.toString(16).padStart(64, '0')}`,
    pricing: { metadata: MARKER, output_digests: [{ hash: `sha256:${'f'.repeat(64)}`, kind: 'sensor' }] },
  };
}

async function sealOrRefuse(type: string, relayPeId: string): Promise<{ refused: string } | { disposition: string; points: bigint }> {
  const mapped = await deviceActToAccrualParams(lane(), act(type), relayPeId);
  if (!mapped.ok) return { refused: mapped.reason };
  const params: RecordPEAccrualParams = mapped.params;
  if (params.durableReplaySource !== undefined) {
    const intake = buildOrdinaryAccrualIntake({ prevHash: 'prev', peHash: params.peHash, accrualParams: params });
    await mockDb.runTransaction(async (txn) => { createOrdinaryAccrualIntakeInTransaction(txn as never, fs() as never, intake); });
  }
  await recordPEAccrual(params);
  const row = mockDb.store.get(`pe_history/${params.peId}`) as Record<string, unknown>;
  return { disposition: String(row.mint_disposition), points: BigInt(String(row.estimated_pvt_atomic ?? '0')) };
}

async function seedQueueRow(type: string, sources: string[]): Promise<void> {
  await mockDb.collection(PENDING_POLICY_COLLECTION).doc(actionPolicyDocumentId(type)).set({
    // A complete row, as the queue writes it.
    action_type: type, first_seen_at: CUT - 1000, last_seen_at: CUT - 1000, observation_count: 1, sample_pe_ids: ['pe_seen'],
    integration_sources: sources, mint_disposition: 'record_only', disposition_reason_code: 'unknown_action_type',
    policy_review_state: 'resolved_signed_matrix', observed_under_policy_version: 'pvt-action-policy/v1',
    alert_status: 'delivered', alert_attempts: 1, next_alert_due_at: CUT, last_alert_attempt_at: CUT - 900,
    last_alert_delivered_at: CUT - 900, last_alert_kind: 'first_sight', last_alert_error: null,
    resolved_at: CUT, resolved_by: 'signed_matrix',
  });
}

beforeEach(() => {
  mockDb.store.clear();
  mockSigned.types = new Set([SIGNED_FIXTURE]);
  mockSigned.effectiveAtMs = CUT;
  mockSigned.row = signedRow(SIGNED_FIXTURE, 'eligible');
});

describe('review fix 1 — an intake lane cannot squat a name signed for another lane', () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  afterAll(() => errorSpy.mockRestore());

  it('the fixture is NAMED (rule ii applies), and its signed row is eligible', () => {
    expect(isNeverSeenActionType(SIGNED_FIXTURE)).toBe(false);
  });

  it('a queue row listing a forge/relay source beside the gateway (resolved_signed_matrix) → refused, nothing sealed, nothing minted', async () => {
    await seedQueueRow(SIGNED_FIXTURE, ['agent_bank_generate_pe', DEVICE_GATEWAY_OBSERVER_SOURCE]);
    expect(await sealOrRefuse(SIGNED_FIXTURE, 'pe_squat')).toEqual({ refused: 'actor_declared:named_type_witnessed_elsewhere' });
    expect(mockDb.store.has('pe_history/pe_squat')).toBe(false);
  });

  it('RED control — the SAME row listing ONLY the gateway lane is admitted and mints once', async () => {
    await seedQueueRow(SIGNED_FIXTURE, [DEVICE_GATEWAY_OBSERVER_SOURCE]);
    const out = await sealOrRefuse(SIGNED_FIXTURE, 'pe_owned');
    expect(out).toMatchObject({ disposition: 'eligible' });
    expect('points' in out && out.points > 0n).toBe(true);
  });

  it('RED ( , A) — the same intake-only row WITHOUT the intake grant → refused, nothing sealed', async () => {
    setIntakeGrant(SIGNED_FIXTURE, undefined);
    try {
      await seedQueueRow(SIGNED_FIXTURE, [DEVICE_GATEWAY_OBSERVER_SOURCE]);
      expect(await sealOrRefuse(SIGNED_FIXTURE, 'pe_ungranted')).toEqual({ refused: 'actor_declared:named_type_witnessed_elsewhere' });
      expect(mockDb.store.has('pe_history/pe_ungranted')).toBe(false);
    } finally {
      setIntakeGrant(SIGNED_FIXTURE, [DEVICE_GATEWAY_OBSERVER_SOURCE]);
    }
  });

  it('RED ( , A) — a relay type emitted from constants, pre-queued by the gateway, never mints at the relay row\'s price', async () => {
    const relayType = 'bond_slashed';
    await seedQueueRow(relayType, [DEVICE_GATEWAY_OBSERVER_SOURCE]);
    mockSigned.types = new Set([relayType]);
    mockSigned.row = signedRow(relayType, 'eligible');
    expect(await sealOrRefuse(relayType, 'pe_relay_squat')).toEqual({ refused: 'actor_declared:named_type_witnessed_elsewhere' });
    expect(mockDb.store.has('pe_history/pe_relay_squat')).toBe(false);
  });

  it('a relay-owned name (service:github_issues) is refused on the gateway whatever the queue says', async () => {
    await seedQueueRow('service:github_issues', [DEVICE_GATEWAY_OBSERVER_SOURCE]);
    mockSigned.types = new Set(['service:github_issues']);
    expect(await sealOrRefuse('service:github_issues', 'pe_forge_name')).toEqual({ refused: 'actor_declared:relay_owned_namespace' });
  });
});
