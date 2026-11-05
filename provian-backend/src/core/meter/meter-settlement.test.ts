/**
 * PE METER — an act-unit claim outlives its 31-day act key.
 *
 * The act key is the per-act record the relay keeps for 31 days; a pending claim is kept until it
 * settles. A settlement held past 31 days must still be able to re-derive and pay an act-unit
 * claim, so the claim carries the act identity under its own integrity commitment. RED controls:
 * a claim with no identity and no key is refused (`act_identity_unavailable`), and a claim whose
 * identity disagrees with a live key is refused (`act_identity_mismatch`).
 */
import { describe, it, expect } from '@jest/globals';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { buildPendingClaim, meterActClaimId, meterActClaimKey } from './meter-claims';
import { isCarriedOverLegacyClaim, runMeterClaimInlet, verifyMeterClaimMembers } from './meter-settlement';
import { METER_ACT_KEYS_COLLECTION, METER_PENDING_CLAIMS_COLLECTION, type MeterPendingClaim } from './meter-store';
import type { SealedEnvelopeIdentity } from '../pvt/wp-ev/claim-id';

const PE = 'pe_relay_act_1';
const identity: SealedEnvelopeIdentity = {
  id: PE,
  prev_hash: 'a'.repeat(64),
  hash: 'b'.repeat(64),
  timestamp: 1_790_000_000_000,
  action_type: 'service:github_commit',
  user_id: 'agent_x',
};

function claimOf(withIdentity: SealedEnvelopeIdentity | undefined): MeterPendingClaim {
  const built = buildPendingClaim({
    claim_key: meterActClaimKey(PE, 'sole'),
    unit: 'act',
    batch_hash: 'c'.repeat(64),
    device_id: 'relay:agent_x',
    actor_id: 'agent_x',
    leg: 'sole',
    contributor: '0x00000000000000000000000000000000000000aa',
    beneficiary_class: 1,
    record_points_atomic: '1000',
    acts: [{ relay_pe_id: PE, points_atomic: '1000' }],
    claim_id: meterActClaimId(identity, 'sole'),
    ...(withIdentity ? { act_identity: withIdentity } : {}),
    created_at_ms: 1,
    ready_at_ms: 0,
  });
  return { ...built, state: 'registered' };
}

async function verdictFor(claim: MeterPendingClaim, key?: Record<string, unknown>) {
  const db = createFakeFirestore();
  await db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(claim.claim_key).set({ ...claim });
  if (key) await db.collection(METER_ACT_KEYS_COLLECTION).doc(PE).set(key);
  const verdicts = await verifyMeterClaimMembers(db as never, [
    { pe_id: claim.claim_key, leg: 'sole', claim_id: claim.claim_id },
  ]);
  return verdicts.get(claim.claim_key);
}

const liveKey = (overrides: Record<string, unknown> = {}) => ({
  relay_pe_id: PE,
  prev_hash: identity.prev_hash,
  pe_hash: identity.hash,
  timestamp: identity.timestamp,
  action_type: identity.action_type,
  actor_id: identity.user_id,
  row: { mint_status: 'eligible' },
  ...overrides,
});

describe('meter act-unit claims outlive their act key', () => {
  it('verifies an act claim whose 31-day key has expired, from its own identity', async () => {
    expect(await verdictFor(claimOf(identity))).toMatchObject({ ok: true, recordPointsAtomic: '1000' });
  });

  it('verifies while the key is live and names the same act', async () => {
    expect(await verdictFor(claimOf(identity), liveKey())).toMatchObject({ ok: true });
  });

  it('RED: no identity on the claim and no key — refused', async () => {
    expect(await verdictFor(claimOf(undefined))).toEqual({ ok: false, reason: 'meter_claim_id_act_identity_unavailable' });
  });

  it('RED: a claim whose identity disagrees with the live key — refused', async () => {
    expect(await verdictFor(claimOf(identity), liveKey({ pe_hash: 'd'.repeat(64) })))
      .toEqual({ ok: false, reason: 'meter_claim_id_act_identity_mismatch' });
  });

  it('RED: an identity edited after the claim was built breaks its integrity commitment', async () => {
    const tampered = { ...claimOf(identity), act_identity: { ...identity, timestamp: identity.timestamp + 1 } };
    expect(await verdictFor(tampered)).toEqual({ ok: false, reason: 'meter_claim_integrity' });
  });
});

describe(': carried-over legacy claims are paid now', () => {
  const legacy = (overrides: Partial<Pick<MeterPendingClaim, 'batch_hash' | 'device_id' | 'unit'>>) => ({
    batch_hash: 'legacy_pre_meter', device_id: 'legacy:user_x', unit: 'act' as const, ...overrides,
  });

  it('marks a migration-carried act claim as carried over', () => {
    expect(isCarriedOverLegacyClaim(legacy({}))).toBe(true);
  });

  it('RED: an ordinary act claim, a batch claim, or a half-marked claim is not', () => {
    expect(isCarriedOverLegacyClaim(legacy({ batch_hash: 'c'.repeat(64) }))).toBe(false);
    expect(isCarriedOverLegacyClaim(legacy({ device_id: 'relay:agent_x' }))).toBe(false);
    expect(isCarriedOverLegacyClaim(legacy({ unit: 'batch' }))).toBe(false);
  });

  it('the inlet registers a carried-over claim before its window and leaves an ordinary one waiting', async () => {
    const db = createFakeFirestore();
    const nowMs = 1_800_000_000_000;
    const make = (pe: string, carried: boolean) => buildPendingClaim({
      claim_key: meterActClaimKey(pe, 'sole'),
      unit: 'act',
      batch_hash: carried ? 'legacy_pre_meter' : 'c'.repeat(64),
      device_id: carried ? 'legacy:agent_x' : 'relay:agent_x',
      actor_id: 'agent_x',
      leg: 'sole',
      contributor: '0x00000000000000000000000000000000000000aa',
      beneficiary_class: 1,
      record_points_atomic: '1000',
      acts: [{ relay_pe_id: pe, points_atomic: '1000' }],
      claim_id: meterActClaimId({ ...identity, id: pe }, 'sole'),
      act_identity: { ...identity, id: pe },
      created_at_ms: 1,
      ready_at_ms: nowMs + 3 * 86_400_000,
    });
    const carried = make('pe_legacy_1', true);
    const ordinary = make('pe_relay_2', false);
    for (const c of [carried, ordinary]) await db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(c.claim_key).set({ ...c });
    const report = await runMeterClaimInlet(db as never, { nowMs });
    expect(report.notReady).toBe(1);
    expect((await db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(carried.claim_key).get()).data()?.state).toBe('aggregated');
    expect((await db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(ordinary.claim_key).get()).data()?.state).toBe('pending');
  });
});
