import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from '../pvt/beneficiary';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from '../pvt/wp11/ordinary-accrual-intake';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('../pvt/__test-helpers__/fake-firestore');
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
jest.mock('../pvt/beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
jest.unmock('./mint-compliance');
jest.unmock('./jurisdiction-policy');
jest.mock('../pvt/delegation-pe', () => ({ isDelegationQualifying: () => false, createDelegationPE: async () => {} }));
jest.mock('../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'institutional',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));


import { recordPEAccrual } from '../../pvt-accrual';
import { generatePE } from '../agent-bank/pe-utils';
import type { AgentBankDeps } from '../agent-bank/types';
import type { Firestore } from 'firebase-admin/firestore';
import { observeWalletSession } from './mint-compliance';
import { INITIAL_JURISDICTION_POLICIES } from './jurisdiction-policy';
import { meterActRow } from '../pvt/__test-helpers__/meter-acts';
import { buildOrdinaryAccrualIntake, ORDINARY_ACCRUAL_INTAKE_COLLECTION } from '../pvt/wp11/ordinary-accrual-intake';
const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CP = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
beforeEach(() => {
  mockDb.store.clear(); mockDb.ops.length = 0;
  mockDb.store.set('agent_wallets/aw1', { id: 'aw1', agent_id: 'actor', address: ADDRESS, status: 'active' });
  for (const [code, entry] of Object.entries(INITIAL_JURISDICTION_POLICIES)) mockDb.store.set(`jurisdiction_policy/${code}`, { ...entry });
  mockDb.store.set('jurisdiction_screening_v1/ofac_sdn', { checked_at_ms: Date.now(), published: '10/28/2026', sha256: 'a'.repeat(64),
    addresses: Array.from({ length: 100 }, (_, i) => `test-address-${i}`) });
});
const db = () => mockDb as unknown as Firestore;
it.each([['8.8.8.8', 'eligible'], ['5.34.192.1', 'pending_compliance'], ['114.114.114.114', 'deferred'], ['5.3.41.0', 'pending_compliance'], ['127.0.0.1', 'pending_compliance']])(
  'real accrual prices IP %s as %s', async (ip, expected) => {
    await observeWalletSession(db(), { ip }, [ADDRESS]);
    const params = { peId: 'pe_real', userId: 'actor', actionType: 'promise_funded', integrationSource: 'agent_bank_generate_pe',
      attestationDepth: 'software', peHash: 'a'.repeat(64), timestamp: Date.now(), ownerType: 'agent', walletAddress: ADDRESS,
      durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE, economicEvidenceState: 'verified',
      economicCanonicalEventId: 'base:8453:0x' + 'c'.repeat(64) + ':0', counterpartyAddress: CP,
    } as const;
    const intake = buildOrdinaryAccrualIntake({ prevHash: 'prev', peHash: params.peHash, accrualParams: params });
    mockDb.store.set(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${params.peId}`, { ...intake });
    await recordPEAccrual(params);
    const row = mockDb.store.get('pe_history/pe_real');
    expect(row).toMatchObject({ mint_status: expected });
    expect(BigInt(String(row?.estimated_pvt_atomic ?? '0')) > 0n).toBe(expected === 'eligible');
  });
it.each([['8.8.8.8', 'eligible'], ['5.34.192.1', 'pending_compliance'], ['114.114.114.114', 'deferred'], ['127.0.0.1', 'pending_compliance']])(
  'agent-bank generatePE through real relay meter prices IP %s as %s', async (ip, expected) => {
    await observeWalletSession(db(), { ip }, [ADDRESS]);
    const deps = { db: db(), peBuffer: { enqueue: () => { throw new Error('readable PE persisted'); } }, recordPEAccrual } as unknown as AgentBankDeps;
    const result = await generatePE(deps, { walletId: 'aw1', agentId: 'actor', actorAddress: ADDRESS, ownerType: 'agent',
      actionType: 'promise_funded', metadata: { verified: true, tx_hash: '0x' + 'd'.repeat(64) },
      observedCanonicalEventId: 'base:8453:0x' + 'd'.repeat(64) + ':0', counterpartyAddress: CP, awaitAccrual: true });
    const row = meterActRow(mockDb.store, result.peId);
    expect(row).toMatchObject({ mint_status: expected });
    const claims = [...mockDb.store.keys()].filter(key => key.startsWith('meter_pending_claims_v1/'));
    expect(claims.length > 0).toBe(expected === 'eligible');
    expect([...mockDb.store.keys()].some(key => key.startsWith('pe_history/'))).toBe(false);
  });

it('a metered deferred act releases only after its current actor and payee policy permit it', async () => {
  const { processDeferredReleaseBatch } = await import('../pvt/deferred-release');
  await observeWalletSession(db(), { ip: '114.114.114.114' }, [ADDRESS]);
  const deps = { db: db(), peBuffer: { enqueue: () => {} }, recordPEAccrual } as unknown as AgentBankDeps;
  const result = await generatePE(deps, { walletId: 'aw1', agentId: 'actor', actorAddress: ADDRESS, ownerType: 'agent',
    actionType: 'promise_funded', metadata: { verified: true }, observedCanonicalEventId: 'base:8453:deferred:0',
    counterpartyAddress: CP, awaitAccrual: true });
  expect(meterActRow(mockDb.store, result.peId)).toMatchObject({ mint_status: 'deferred' });
  const config = { jurisdiction: 'CN', daily_ceiling_percent: 100, re_attestation_required: false, activated_at: 1, active: true };
  expect(await processDeferredReleaseBatch(config, 1)).toBe(0);
  const heldKey = `meter_held_acts_v1/${result.peId}`;
  expect(mockDb.store.has(heldKey)).toBe(true);
  // An authorized policy change opens CN; the graduated release keeps the sealed price.
  mockDb.store.set('jurisdiction_policy/CN', { policy: 'immediate', reason: 'test prospective release', since: '2026-11-01' });
  jest.useFakeTimers().setSystemTime(Date.now() + 61000);
  try {
    expect(await processDeferredReleaseBatch(config, 1)).toBe(1);
    expect(mockDb.store.has(heldKey)).toBe(false);
    expect(meterActRow(mockDb.store, result.peId)).toMatchObject({ mint_status: 'eligible' });
    expect([...mockDb.store.keys()].some(key => key.startsWith('meter_pending_claims_v1/'))).toBe(true);
  } finally { jest.useRealTimers(); }
});
it('CN never hides a pending evidence bucket behind a destructive release', async () => {
  await observeWalletSession(db(), { ip: '114.114.114.114' }, [ADDRESS]);
  const deps = { db: db(), peBuffer: { enqueue: () => {} }, recordPEAccrual } as unknown as AgentBankDeps;
  const result = await generatePE(deps, { walletId: 'aw1', agentId: 'actor', actorAddress: ADDRESS, ownerType: 'agent',
    actionType: 'promise_funded', metadata: {}, counterpartyAddress: CP, awaitAccrual: true });
  expect(meterActRow(mockDb.store, result.peId)).toMatchObject({ mint_status: 'pending_evidence', jurisdiction_compliance_reason: 'jurisdiction_deferred' });
  const { resolveHeldAct } = await import('../meter/held-acts');
  expect(await resolveHeldAct(db(), result.peId, { mint_status: 'eligible' }, { nowMs: Date.now() }))
    .toMatchObject({ outcome: 'still_held', reason: 'jurisdiction_deferred' });
  expect([...mockDb.store.keys()].some(key => key.startsWith('meter_pending_claims_v1/'))).toBe(false);
});

async function sealComplianceAct(event = 'compliance', actionType = 'promise_funded') {
  const deps = { db: db(), peBuffer: { enqueue: () => {} }, recordPEAccrual } as unknown as AgentBankDeps;
  return generatePE(deps, { walletId: 'aw1', agentId: 'actor', actorAddress: ADDRESS, ownerType: 'agent',
    actionType, metadata: { verified: true },
    observedCanonicalEventId: `base:8453:${event}:0`, counterpartyAddress: CP, awaitAccrual: true,
    ...(event === 'same-completion' ? { completionCanonicalId: 'escrow:esc_compliance' } : {}) });
}
const claims = () => [...mockDb.store.entries()].filter(([key]) => key.startsWith('meter_pending_claims_v1/'));
it.each(['unknown', 'unavailable'])('metered %s evidence holds and automatically recovers its exact nonzero price once', async cause => {
  const { recoverComplianceHolds } = await import('../pvt/compliance-hold-recovery');
  await observeWalletSession(db(), { ip: cause === 'unknown' ? '127.0.0.1' : '8.8.8.8' }, [ADDRESS]);
  const feed = mockDb.store.get('jurisdiction_screening_v1/ofac_sdn')!;
  if (cause === 'unavailable') {
    mockDb.store.delete('jurisdiction_screening_v1/ofac_sdn');
    jest.useFakeTimers().setSystemTime(Date.now() + 61000);
  }
  try {
    const { peId } = await sealComplianceAct(cause);
    const before = meterActRow(mockDb.store, peId)!;
    expect(before.mint_status).toBe('pending_compliance');
    expect(mockDb.store.has(`meter_held_acts_v1/${peId}`)).toBe(true);
    expect(claims()).toHaveLength(0);
    expect((await recoverComplianceHolds(db())).resolved).toBe(0);
    await observeWalletSession(db(), { ip: '8.8.8.8' }, [ADDRESS]);
    mockDb.store.set('jurisdiction_screening_v1/ofac_sdn', { ...feed, checked_at_ms: Date.now() });
    expect((await recoverComplianceHolds(db())).resolved).toBe(1);
    expect(mockDb.store.has(`meter_held_acts_v1/${peId}`)).toBe(false);
    const after = meterActRow(mockDb.store, peId)!;
    expect(after.mint_status).toBe('eligible');
    expect(after.economic_snapshot).toEqual(before.economic_snapshot);
    expect(after.economic_snapshot_hash).toBe(before.economic_snapshot_hash);
    expect(BigInt(String(after.record_points_atomic))).toBeGreaterThan(0n);
    expect(claims()).toHaveLength(1);
    expect(claims()[0][1].record_points_atomic).toBe(after.record_points_atomic);
    await Promise.all([recoverComplianceHolds(db()), recoverComplianceHolds(db())]);
    expect(claims()).toHaveLength(1);
  } finally { jest.useRealTimers(); }
});
it.each([['114.114.114.114', 'deferred'], ['5.34.192.1', 'pending_compliance'], ['5.3.41.0', 'pending_compliance']])(
  'resolved location %s routes an unknown hold to %s without a claim', async (ip, expected) => {
    const { recoverComplianceHolds } = await import('../pvt/compliance-hold-recovery');
    await observeWalletSession(db(), { ip: '127.0.0.1' }, [ADDRESS]);
    const { peId } = await sealComplianceAct(ip);
    await observeWalletSession(db(), { ip }, [ADDRESS]);
    await recoverComplianceHolds(db());
    expect(meterActRow(mockDb.store, peId)?.mint_status).toBe(expected);
    expect(claims()).toHaveLength(0);
  });
it('a recovered feed that identifies an SDN address makes the hold terminal', async () => {
  const { recoverComplianceHolds } = await import('../pvt/compliance-hold-recovery');
  await observeWalletSession(db(), { ip: '127.0.0.1' }, [ADDRESS]);
  const { peId } = await sealComplianceAct('sdn-hit');
  const feed = mockDb.store.get('jurisdiction_screening_v1/ofac_sdn')!;
  mockDb.store.set('jurisdiction_screening_v1/ofac_sdn', { ...feed, addresses: [...feed.addresses as string[], ADDRESS] });
  jest.useFakeTimers().setSystemTime(Date.now() + 61000);
  try {
    await recoverComplianceHolds(db());
    expect(meterActRow(mockDb.store, peId)?.mint_status).toBe('ineligible');
    expect(claims()).toHaveLength(0);
  } finally { jest.useRealTimers(); }
});

it('legacy cache recovery cannot promote while current compliance is unresolved', async () => {
  const { mutatePeHistoryRowWithAggregate } = await import('../pvt/policy/economic-aggregate');
  mockDb.store.set('pe_history/legacy_unknown', { peId: 'legacy_unknown', userId: 'actor', mint_status: 'pending_cache' });
  const result = await mutatePeHistoryRowWithAggregate(db(), 'legacy_unknown', { mint_status: 'eligible' }, { nowMs: Date.now() });
  expect(result.outcome).toBe('precondition_failed');
  expect(mockDb.store.get('pe_history/legacy_unknown')?.mint_status).toBe('pending_cache');
  expect(claims()).toHaveLength(0);
});
it('unresolved evidence keeps its own recovery bucket while compliance is also unknown', async () => {
  const deps = { db: db(), peBuffer: { enqueue: () => {} }, recordPEAccrual } as unknown as AgentBankDeps;
  const { peId } = await generatePE(deps, { walletId: 'aw1', agentId: 'actor', actorAddress: ADDRESS, ownerType: 'agent',
    actionType: 'promise_funded', metadata: {}, counterpartyAddress: CP, awaitAccrual: true });
  expect(meterActRow(mockDb.store, peId)).toMatchObject({ mint_status: 'pending_evidence', jurisdiction_compliance_reason: 'jurisdiction_unknown' });
  const { resolveHeldAct } = await import('../meter/held-acts');
  expect(await resolveHeldAct(db(), peId, { mint_status: 'eligible' }, { nowMs: Date.now() })).toMatchObject({ outcome: 'still_held' });
  expect(claims()).toHaveLength(0);
});
it('an unknown held act owns its mint-once completion slot against a second witness', async () => {
  await observeWalletSession(db(), { ip: '127.0.0.1' }, [ADDRESS]);
  const first = await sealComplianceAct('same-completion');
  const second = await sealComplianceAct('same-completion');
  expect(meterActRow(mockDb.store, first.peId)?.mint_status).toBe('pending_compliance');
  expect(meterActRow(mockDb.store, second.peId)?.mint_status).not.toBe('eligible');
  const { recoverComplianceHolds } = await import('../pvt/compliance-hold-recovery');
  await observeWalletSession(db(), { ip: '8.8.8.8' }, [ADDRESS]);
  await recoverComplianceHolds(db());
  expect(claims()).toHaveLength(1);
});
it('legacy retry cursor passes unresolved rows rather than starving later resolved work', async () => {
  const { recoverComplianceHolds } = await import('../pvt/compliance-hold-recovery');
  const { peId } = await sealComplianceAct('legacy-cursor');
  const row = meterActRow(mockDb.store, peId)!;
  // Model the same sealed act in its pre-meter home; only its storage location changes.
  mockDb.store.delete(`meter_held_acts_v1/${peId}`);
  mockDb.store.delete(`meter_act_keys_v1/${peId}`);
  mockDb.store.set(`pe_history/${peId}`, { ...row });
  for (let i = 0; i < 100; i++) mockDb.store.set(`pe_history/a_unknown_${String(i).padStart(3, '0')}`, {
    userId: 'unresolved-actor', mint_status: 'pending_compliance',
  });
  await observeWalletSession(db(), { ip: '8.8.8.8' }, [ADDRESS]);
  expect((await recoverComplianceHolds(db())).resolved).toBe(0);
  expect(mockDb.store.get(`pe_history/${peId}`)?.mint_status).toBe('pending_compliance');
  expect((await recoverComplianceHolds(db())).resolved).toBe(1);
  expect(mockDb.store.get(`pe_history/${peId}`)).toMatchObject({ mint_status: 'eligible', economic_snapshot_hash: row.economic_snapshot_hash });
});

it('temporary compliance holds reserve the standing financial daily slot', async () => {
  const { peId } = await sealComplianceAct('financial-cap', 'send');
  expect(meterActRow(mockDb.store, peId)).toMatchObject({ mint_status: 'pending_compliance',
    activity_mint_reservation: { daily_slot_consumed: true } });
  expect([...mockDb.store.entries()].some(([key, value]) => key.startsWith('activity_mint_reservations/')
    && value.pe_id === peId && value.daily_slot_consumed === true)).toBe(true);
  expect(claims()).toHaveLength(0);
});

it.each(['IR', 'UA-40'])('a blocked %s act holds its nonzero sealed value until policy opens, then releases exactly once', async jurisdiction => {
  const { recoverComplianceHolds } = await import('../pvt/compliance-hold-recovery');
  await observeWalletSession(db(), { ip: jurisdiction === 'IR' ? '5.34.192.1' : '194.12.100.1' }, [ADDRESS]);
  const { peId } = await sealComplianceAct(`blocked-${jurisdiction}`);
  const before = meterActRow(mockDb.store, peId)!;
  expect(before).toMatchObject({ mint_status: 'pending_compliance', disposition_reason_code: 'jurisdiction_blocked',
    jurisdiction_context: jurisdiction });
  expect(BigInt(String(before.record_points_atomic))).toBeGreaterThan(0n);
  expect(claims()).toHaveLength(0);
  expect((await recoverComplianceHolds(db())).resolved).toBe(0);
  // A new allowed session cannot substitute for lifting the original block.
  await observeWalletSession(db(), { ip: '8.8.8.8' }, [ADDRESS]);
  expect((await recoverComplianceHolds(db())).resolved).toBe(0);
  mockDb.store.set(`jurisdiction_policy/${jurisdiction}`, { policy: 'immediate', reason: 'authorized opening', since: '2026-11-01' });
  jest.useFakeTimers().setSystemTime(Date.now() + 61000);
  try {
    expect((await recoverComplianceHolds(db())).resolved).toBe(1);
    const after = meterActRow(mockDb.store, peId)!;
    expect(after).toMatchObject({ mint_status: 'eligible', economic_snapshot_hash: before.economic_snapshot_hash,
      estimated_pvt_atomic: before.record_points_atomic });
    expect(after.economic_snapshot).toEqual(before.economic_snapshot);
    expect(claims()).toHaveLength(1);
    await recoverComplianceHolds(db());
    expect(claims()).toHaveLength(1);
  } finally { jest.useRealTimers(); }
});

it('an evidence-held blocked act cannot bypass its original jurisdiction through its primary resolver', async () => {
  await observeWalletSession(db(), { ip: '5.34.192.1' }, [ADDRESS]);
  const deps = { db: db(), peBuffer: { enqueue: () => {} }, recordPEAccrual } as unknown as AgentBankDeps;
  const { peId } = await generatePE(deps, { walletId: 'aw1', agentId: 'actor', actorAddress: ADDRESS, ownerType: 'agent',
    actionType: 'promise_funded', metadata: {}, counterpartyAddress: CP, awaitAccrual: true });
  expect(meterActRow(mockDb.store, peId)).toMatchObject({ mint_status: 'pending_evidence',
    jurisdiction_compliance_reason: 'jurisdiction_blocked', jurisdiction_context: 'IR' });
  await observeWalletSession(db(), { ip: '8.8.8.8' }, [ADDRESS]);
  const { resolveHeldAct } = await import('../meter/held-acts');
  expect(await resolveHeldAct(db(), peId, { mint_status: 'eligible' }, { nowMs: Date.now() }))
    .toMatchObject({ outcome: 'still_held', reason: 'jurisdiction_blocked' });
  expect(claims()).toHaveLength(0);
});
it('a blocked jurisdiction changed to deferred follows graduated release and an SDN hit remains terminal', async () => {
  const { recoverComplianceHolds } = await import('../pvt/compliance-hold-recovery');
  const { processDeferredReleaseBatch } = await import('../pvt/deferred-release');
  await observeWalletSession(db(), { ip: '5.34.192.1' }, [ADDRESS]);
  const { peId } = await sealComplianceAct('blocked-to-deferred');
  mockDb.store.set('jurisdiction_policy/IR', { policy: 'deferred', reason: 'authorized deferral', since: '2026-11-01' });
  jest.useFakeTimers().setSystemTime(Date.now() + 61000);
  try {
    await recoverComplianceHolds(db());
    expect(meterActRow(mockDb.store, peId)).toMatchObject({ mint_status: 'deferred', jurisdiction_context: 'IR' });
    expect(await processDeferredReleaseBatch({ jurisdiction: 'IR', daily_ceiling_percent: 100,
      re_attestation_required: false, activated_at: 1, active: true }, 1)).toBe(0);
    expect(claims()).toHaveLength(0);
    // The original blocked hold also becomes terminal on an actual SDN hit.
    mockDb.store.set('jurisdiction_policy/IR', { policy: 'blocked', reason: 'still blocked', since: '2026-11-01' });
    jest.setSystemTime(Date.now() + 61000);
    const sdn = await sealComplianceAct('blocked-sdn');
    const feed = mockDb.store.get('jurisdiction_screening_v1/ofac_sdn')!;
    mockDb.store.set('jurisdiction_screening_v1/ofac_sdn', { ...feed, checked_at_ms: Date.now(), addresses: [...feed.addresses as string[], ADDRESS] });
    jest.setSystemTime(Date.now() + 61000);
    await recoverComplianceHolds(db());
    expect(meterActRow(mockDb.store, sdn.peId)?.mint_status).toBe('ineligible');
    mockDb.store.set('jurisdiction_policy/IR', { policy: 'immediate', reason: 'open', since: '2026-11-01' });
    mockDb.store.set('jurisdiction_screening_v1/ofac_sdn', feed);
    jest.setSystemTime(Date.now() + 61000);
    await recoverComplianceHolds(db());
    expect(meterActRow(mockDb.store, sdn.peId)?.mint_status).toBe('ineligible');
  } finally { jest.useRealTimers(); }
});
