/**
 * NEW-TYPE INTAKE, A4 — CLOSE AND NOTIFY, end to end against a SIGNED FIXTURE.
 *
 * 1. a gateway plugin's act of a never-seen type goes through the REAL device lane and the REAL
 * accrual: recorded record_only and queued (`pending_policy`, `device_gateway_observer`);
 * 2. the console ruling is `building`;
 * 3. the operator’s signed matrix lands — modelled by adding a FIXTURE row to the matrix entries this
 * suite loads (the real matrix file never moves) — and `digest_match` is true;
 * 4. `reconcileLiveActionTypes` marks the ruling live and `resolveQueueRowsLandedInSignedMatrix`
 * closes the queue row (`resolved_signed_matrix`);
 * 5. `runActionTypeActivationNotify` tells each submitter once: the human is pushed, the agent
 * gets an inbox event and a targeted webhook, the broadcast webhook fires once;
 * 6. a re-run of every step sends nothing.
 *
 * RED controls: before the fixture lands (or with `digest_match` false) nothing goes live, the
 * queue row stays `pending_policy`, and nobody is notified.
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { BeneficiaryCacheEntry } from './core/pvt/beneficiary';
import type { FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';
import type { ProposedActionPolicyEntry } from './core/pvt/policy/types';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./core/pvt/__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, { FieldValue: { increment: (n: number) => ({ __increment: n }) } });
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
/** The matrix entries as this suite loads them: the real rows, plus the fixture once "signed". */
const mockMatrixEntries: ProposedActionPolicyEntry[] = [];
jest.mock('./core/pvt/policy/proposed-action-policy', () => {
  const actual = jest.requireActual('./core/pvt/policy/proposed-action-policy') as typeof import('./core/pvt/policy/proposed-action-policy');
  mockMatrixEntries.push(...actual.PROPOSED_ACTION_POLICY_ENTRIES);
  return { ...actual, PROPOSED_ACTION_POLICY_ENTRIES: mockMatrixEntries };
});

/** Signing an intake type = the matrix row (`mockMatrixEntries`) AND its intake grant (mocked here). */
jest.mock('./core/pvt/policy/intake-signed-action-types', () => ({ INTAKE_SIGNED_ACTION_TYPES: {} }));

import type { Firestore } from 'firebase-admin/firestore';
import { recordPEAccrual } from './pvt-accrual';
import { deviceActToAccrualParams, type DeviceBatchLane } from './core/meter/device-act';
import type { DeviceDocument } from './routes/middleware/device-auth';
import { PROPOSED_ACTION_POLICY_ENTRIES } from './core/pvt/policy/proposed-action-policy';
import { DEVICE_GATEWAY_OBSERVER_SOURCE, OBSERVER_PLUGIN_SOURCE, newTypeIntakeCache } from './core/pvt/policy/new-type-intake';
import { PENDING_POLICY_COLLECTION, actionPolicyDocumentId } from './core/pvt/policy/pending-policy-queue';
import { reconcileLiveActionTypes, resolveQueueRowsLandedInSignedMatrix } from './core/pvt/policy/action-type-reconciler';
import { runActionTypeActivationNotify, type ActivationTargetedWebhookDispatcher } from './core/pvt/policy/action-type-activation-notify';
import { getPolicyRuling } from './core/pvt/policy/policy-rulings';
import { setPolicyRuling } from './core/pvt/__test-helpers__/policy-ruling-fixture';

const NOW = Date.UTC(2026, 9, 22, 12);
const SENSOR = ['soil', 'moisture', 'reading', 'notify'].join('_');

function fs(): Firestore { return mockDb as unknown as Firestore; }

function queueRow(): Record<string, unknown> | undefined {
  return mockDb.store.get(`${PENDING_POLICY_COLLECTION}/${actionPolicyDocumentId(SENSOR)}`);
}

async function gatewayAct(): Promise<void> {
  const lane: DeviceBatchLane = {
    db: fs(),
    device: { owner_type: 'human', device_id: 'dev_gw', owner_user_id: 'human_gw', owner_wallet_id: 'w_gw' } as DeviceDocument,
    ownerId: 'human_gw', signatureAuthenticated: true, bodyBound: true, attestationTier: 'software',
    receivedAtMs: NOW, lineage: null, lineageTouched: false, intakeCache: newTypeIntakeCache(),
  };
  const mapped = await deviceActToAccrualParams(lane, {
    action_type: SENSOR, pe_id: 'pe_gw_notify', timestamp: NOW, prev_hash: 'genesis', pe_hash: `sha256:${'d'.repeat(64)}`,
    pricing: { metadata: { source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'sensor-gateway' } },
  }, 'pe_gw_notify');
  if (!mapped.ok) throw new Error(`gateway act refused: ${mapped.reason}`);
  await recordPEAccrual(mapped.params);
}

/**
 * The submitters. The gateway's human submitter has NO act key ( , C: its act aged out
 * of the 31-day window while review ran) — it is reached only through the queue observation the
 * REAL accrual wrote in step 1. The agent submitter is reached through its act key.
 */
async function seedSubmitters(): Promise<void> {
  await mockDb.collection('meter_act_keys_v1').doc('pe_sov_notify').set({ relay_pe_id: 'pe_sov_notify', action_type: SENSOR, actor_id: 'agent_sensor', timestamp: NOW });
  await mockDb.collection('agent_wallets').doc('wallet_sensor').set({ id: 'wallet_sensor', agent_id: 'agent_sensor', status: 'active' });
}

function captures() {
  const pushes: string[] = [];
  const targeted: string[][] = [];
  const broadcasts: string[] = [];
  const dispatchTargetedWebhook: ActivationTargetedWebhookDispatcher = async (a) => { targeted.push(a.recipients); };
  return {
    pushes, targeted, broadcasts,
    deps: {
      now: NOW, env: {}, dispatchTargetedWebhook,
      dispatchWebhook: async (event: string) => { broadcasts.push(event); },
      pushToUser: (async (_db: Firestore, userId: string) => {
        pushes.push(userId);
        return { successCount: 1, failureCount: 0, invalidTokens: [], expoCount: 0, fcmCount: 1, hadTokens: true };
      }) as never,
    },
  };
}

function inbox(): Array<Record<string, unknown>> {
  return [...mockDb.store.entries()].filter(([k]) => k.startsWith('agent_wallets/wallet_sensor/inbox_v1/')).map(([, v]) => v);
}

/** the policy setter signature lands: the fixture row joins the matrix, and the served code matches it. */
function landSignedFixture(): void {
  const template = PROPOSED_ACTION_POLICY_ENTRIES.find((e) => e.mint_disposition === 'eligible');
  if (!template) throw new Error('no eligible row to model the fixture on');
  mockMatrixEntries.push({ ...template, action_type: SENSOR });
  (jest.requireMock('./core/pvt/policy/intake-signed-action-types') as {
    INTAKE_SIGNED_ACTION_TYPES: Record<string, string[]>;
  }).INTAKE_SIGNED_ACTION_TYPES[SENSOR] = [DEVICE_GATEWAY_OBSERVER_SOURCE];
}

describe('close-and-notify, end to end', () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  afterAll(() => errorSpy.mockRestore());

  it('queued → building → (RED: nothing before the signature) → signed + digest_match → live, resolved, each submitter told once', async () => {
    // 1. the gateway act is recorded and queued.
    await gatewayAct();
    expect(queueRow()).toMatchObject({ policy_review_state: 'pending_policy', integration_sources: [DEVICE_GATEWAY_OBSERVER_SOURCE] });
    expect((mockDb.store.get('pe_history/pe_gw_notify') as Record<string, unknown>).mint_disposition).toBe('record_only');
    // The observation carries its submitter, so the notice reaches it after its act key ages out.
    const observations = [...mockDb.store.entries()].filter(([k]) => k.startsWith('pvt_pending_policy_observations/')).map(([, v]) => v);
    expect(observations).toEqual([expect.objectContaining({ action_type: SENSOR, actor_id: 'human_gw' })]);
    expect([...mockDb.store.entries()].some(([k, v]) => k.startsWith('meter_act_keys_v1/') && (v as Record<string, unknown>).actor_id === 'human_gw')).toBe(false);

    // 2. the console ruling is building; the submitters' act keys exist.
    await setPolicyRuling(fs(), { actionType: SENSOR, ruling: 'building', issueUrl: 'https://g/i/1', operatorId: 'op:frank', now: NOW });
    await seedSubmitters();
    const c = captures();

    // RED — before the signature (digest matches, but the type is no row): nothing goes live.
    await mockDb.collection('system_status').doc('monetary_activation').set({ digest_match: true, effective_at_ms: NOW });
    expect((await reconcileLiveActionTypes(fs(), NOW)).newly_live).toEqual([]);
    expect((await resolveQueueRowsLandedInSignedMatrix(fs(), NOW)).resolved).toEqual([]);
    expect((await runActionTypeActivationNotify(fs(), c.deps)).examined).toBe(0);
    expect(queueRow()?.policy_review_state).toBe('pending_policy');

    // RED — the row lands but the served code and the signed activation disagree: still nothing.
    landSignedFixture();
    await mockDb.collection('system_status').doc('monetary_activation').set({ digest_match: false, effective_at_ms: NOW });
    expect((await reconcileLiveActionTypes(fs(), NOW)).newly_live).toEqual([]);
    expect((await resolveQueueRowsLandedInSignedMatrix(fs(), NOW)).resolved).toEqual([]);
    expect(c.pushes.length + c.targeted.length + c.broadcasts.length).toBe(0);

    // 3–4. digest_match → live + resolved.
    await mockDb.collection('system_status').doc('monetary_activation').set({ digest_match: true, effective_at_ms: NOW + 1 });
    expect((await reconcileLiveActionTypes(fs(), NOW + 2)).newly_live).toEqual([SENSOR]);
    expect((await resolveQueueRowsLandedInSignedMatrix(fs(), NOW + 2)).resolved).toEqual([SENSOR]);
    expect(queueRow()).toMatchObject({ policy_review_state: 'resolved_signed_matrix', resolved_by: 'signed_matrix' });
    expect((await getPolicyRuling(fs(), SENSOR))?.live_at).toBe(NOW + 2);

    // 5. each submitter told once.
    const first = await runActionTypeActivationNotify(fs(), c.deps);
    expect(first.examined).toBe(1);
    expect(first.fanned_out[0]).toMatchObject({ action_type: SENSOR, humans_notified: 1, agents_notified: 1, webhook_dispatched: true });
    expect(c.pushes).toEqual(['human_gw']);
    expect(c.targeted).toEqual([['wallet_sensor']]);
    expect(c.broadcasts).toEqual(['action_type_activated']);
    expect(inbox()).toHaveLength(1);
    expect(inbox()[0]).toMatchObject({ event: 'action_type_activated', entity_id: SENSOR });

    // 6. a re-run of every step sends nothing and moves nothing.
    expect((await reconcileLiveActionTypes(fs(), NOW + 3)).newly_live).toEqual([]);
    expect((await resolveQueueRowsLandedInSignedMatrix(fs(), NOW + 3)).resolved).toEqual([]);
    expect((await runActionTypeActivationNotify(fs(), { ...c.deps, now: NOW + 3 })).examined).toBe(0);
    expect(c.pushes).toHaveLength(1);
    expect(c.targeted).toHaveLength(1);
    expect(c.broadcasts).toHaveLength(1);
    expect(inbox()).toHaveLength(1);
  });
});
