/**
 * Witness-class admission and named-row earning, with negative controls.
 *
 * - a NEVER-SEEN type is admitted for RECORDING under its witness class and seals record_only at
 * weight 0 at EVERY class (device / forge / chain / relay / hardware / actor_declared): the
 * witness gates recording, the policy setter signature on a named row gates earning;
 * - RED: the mintable class-base control (eligible at the class base) still mints through the same
 * kernel — so the record_only expectation above can fail, it is not vacuous;
 * - a hardware-rooted witness lifts an eligible NAMED row to exactly 4.0×;
 * - byte-identity: a named row under any non-hardware class prices exactly as with no class;
 * - the gate: no named row + a class → class_admitted; no class → pending_policy; a rejection
 * still wins; a read failure never admits (Unknown = Block).
 */
import { computeRecordSnapshot, type RecordCalculationInput } from './monetary-accounting';
import { materializeProposedMonetaryPolicy, classAdmittedAction, withWitnessClassOverride } from './runtime-monetary-policy';
import { PROPOSED_EVIDENCE_CLASS_BASES_BPS, WITNESS_CLASSES, type WitnessClass } from './evidence-class';
import { resolveActionPolicyAtRecordTime } from './action-policy-gate';
import { PROPOSED_MONETARY_POLICY_TEMPLATE } from './proposed-monetary-policy';
import type { Firestore } from 'firebase-admin/firestore';

const NOW = Date.UTC(2026, 8, 16, 12);
const policy = materializeProposedMonetaryPolicy(0);

function input(over: Partial<RecordCalculationInput> & { actionType: string }): RecordCalculationInput {
  return {
    peId: 'pe_test', economicActorId: 'actor_a', recordedAtMs: NOW, occurrenceOrdinal: 1, dailyOrdinal: 1,
    exactDuplicate: false, uniqueArtifact: true, attestationTier: 'software', linkageState: 'unlinked',
    evidenceState: 'verified', canonicalEventId: 'evt:1', selfReferencing: false, sharedBeneficialOwnership: false,
    pairChurnDetected: false, sessionLineageId: null, genesisReservation: null, beneficiaryAgentShareBps: 10_000,
    operationalDispositionOverride: null, ...over,
  } as RecordCalculationInput;
}

function admitted(actionType: string, cls: WitnessClass) {
  const action = classAdmittedAction(policy, actionType, cls);
  if (action === null) throw new Error('no class base');
  return Object.freeze({ ...policy, actions: Object.freeze({ ...policy.actions, [actionType]: action }) });
}

describe('new-type intake — a never-seen type RECORDS at every class and never mints until a row is signed', () => {
  it.each(WITNESS_CLASSES.map((c) => [c] as const))('%s: record_only, weight 0, zero points, class_admitted', (cls) => {
    const type = `never_seen_${cls}`;
    expect(PROPOSED_MONETARY_POLICY_TEMPLATE.actions[type]).toBeUndefined();
    const tier = cls === 'hardware_rooted' ? 'hardware_full' : 'software';
    const snap = computeRecordSnapshot(admitted(type, cls), input({ actionType: type, attestationTier: tier, witnessClass: cls }));
    expect(snap.mintDisposition).toBe('record_only');
    expect(snap.mintReasonCode).toBe('policy_record_only');
    expect(snap.policyReviewState).toBe('class_admitted');
    expect(snap.policyReviewReasonCode).toBe('witness_class_admitted');
    expect(snap.recordTimeFactors.effectiveActionWeightBps).toBe(0);
    expect(snap.recordPointsAtomic).toBe('0');
  });

  it('the synthesized row is the non-earning shape at every class (no evidence, no canonical event)', () => {
    expect(WITNESS_CLASSES.length).toBe(6); // never a pass over an empty population
    for (const cls of WITNESS_CLASSES) {
      const row = classAdmittedAction(policy, 'never_seen_shape', cls);
      expect(row).toMatchObject({
        baseWeightBps: 0, mintDisposition: 'record_only', evidenceRequirement: 'none',
        canonicalEventRequired: false, policyReviewState: 'class_admitted', attestationPricing: 'standard',
      });
    }
  });

  it('a hardware-rooted report never lifts the unnamed row (the override only lifts an ELIGIBLE named row)', () => {
    const p = admitted('never_seen_hw_lift', 'hardware_rooted');
    expect(withWitnessClassOverride(p, 'never_seen_hw_lift', 'hardware_rooted')).toBe(p);
  });

  it('RED — the mintable class-base control (eligible at the class base) would mint through the SAME kernel', () => {
    // Reconstruct the row the pre-ruling `classAdmittedAction` synthesized for device_tier: if the
    // kernel priced that row at zero, the record_only assertions above would prove nothing.
    const preRuling = Object.freeze({
      ...classAdmittedAction(policy, 'never_seen_pre_ruling', 'device_tier')!,
      baseWeightBps: PROPOSED_EVIDENCE_CLASS_BASES_BPS.device_tier,
      mintDisposition: 'eligible' as const,
      mintReasonCode: 'policy_eligible' as const,
      evidenceRequirement: 'verified_witness_class' as const,
      canonicalEventRequired: true,
      beneficialOwnershipPolicy: 'record_only_if_self_shared_or_churn' as const,
      sessionLineagePolicy: 'optional' as const,
      evidenceResolutionMode: 'projection_with_verified_evidence' as const,
    });
    const p = Object.freeze({ ...policy, actions: Object.freeze({ ...policy.actions, never_seen_pre_ruling: preRuling }) });
    const snap = computeRecordSnapshot(p, input({ actionType: 'never_seen_pre_ruling', witnessClass: 'device_tier' }));
    expect(snap.mintDisposition).toBe('eligible');
    expect(BigInt(snap.recordPointsAtomic) > 0n).toBe(true);
  });

  it('the six bases are exactly the operator’s and are pinned in the signed template', () => {
    expect(PROPOSED_EVIDENCE_CLASS_BASES_BPS).toEqual({
      hardware_rooted: 40_000, chain_witnessed: 20_000, forge_witnessed: 30_000,
      relay_verified: 10_000, device_tier: 10_000, actor_declared: 0,
    });
    expect(PROPOSED_MONETARY_POLICY_TEMPLATE.evidenceClassBasesBps).toBe(PROPOSED_EVIDENCE_CLASS_BASES_BPS);
    expect([...WITNESS_CLASSES].every((c) => c in PROPOSED_EVIDENCE_CLASS_BASES_BPS)).toBe(true);
  });

  it('RED — a policy vintage without bases admits nothing (inactive/legacy → unknown, record_only)', () => {
    const { evidenceClassBasesBps: _drop, ...legacy } = policy;
    expect(classAdmittedAction(legacy as typeof policy, 'never_seen_x', 'device_tier')).toBeNull();
    const snap = computeRecordSnapshot(legacy as typeof policy, input({ actionType: 'never_seen_x', evidenceState: 'pending', canonicalEventId: null }));
    expect(snap.mintDisposition).toBe('record_only');
    expect(snap.policyReviewState).toBe('pending_policy');
  });
});

describe('§2.9 — hardware-rooted = 4.0× on an eligible named row; nothing else moves', () => {
  const named = 'coding_session';
  it('lifts the named row to the hardware base on the evidence-priced table at hardware_full → exactly 4.0 base points', () => {
    const lifted = withWitnessClassOverride(policy, named, 'hardware_rooted');
    const snap = computeRecordSnapshot(lifted, input({ actionType: named, attestationTier: 'hardware_full', witnessClass: 'hardware_rooted' }));
    expect(snap.mintDisposition).toBe('eligible');
    expect(BigInt(snap.recordPointsAtomic)).toBe(BigInt(PROPOSED_MONETARY_POLICY_TEMPLATE.basePointsAtomic) * 4n);
    expect(lifted.policyVersion).toContain('+hw:hardware_rooted');
  });
  it('RED — every non-hardware class leaves the named row BYTE-IDENTICAL to no class at all', () => {
    const baseline = computeRecordSnapshot(policy, input({ actionType: named }));
    for (const cls of ['device_tier', 'chain_witnessed', 'forge_witnessed', 'relay_verified', 'actor_declared'] as const) {
      const p = withWitnessClassOverride(policy, named, cls);
      expect(p).toBe(policy); // the SAME object — nothing synthesized
      const snap = computeRecordSnapshot(p, input({ actionType: named, witnessClass: cls }));
      expect(snap.recordPointsAtomic).toBe(baseline.recordPointsAtomic);
      expect(snap.recordTimeFactors.effectiveActionWeightBps).toBe(baseline.recordTimeFactors.effectiveActionWeightBps);
    }
  });
  it('RED — fixed grants, the birth certificate, and record_only rows are NOT lifted; an unnamed type is not (class admission owns it)', () => {
    expect(withWitnessClassOverride(policy, 'genesis_human_signup', 'hardware_rooted')).toBe(policy);
    expect(withWitnessClassOverride(policy, 'wallet_created', 'hardware_rooted')).toBe(policy);
    expect(withWitnessClassOverride(policy, 'device_register', 'hardware_rooted')).toBe(policy);
    expect(withWitnessClassOverride(policy, 'never_seen_hw', 'hardware_rooted')).toBe(policy);
    expect(withWitnessClassOverride(policy, named, 'not_a_class')).toBe(policy);
  });
});

describe('§2.8 — the gate: class admission is "no named ruling", never a read failure', () => {
  function db(opts: { pointer?: Record<string, unknown> | null; queue?: Record<string, unknown> | null; throwOn?: 'pointer' | 'queue' }): Firestore {
    const doc = (data: Record<string, unknown> | null | undefined, throws: boolean) => ({
      get: async () => {
        if (throws) throw new Error('unavailable');
        return { exists: data != null, data: () => data ?? undefined };
      },
    });
    return {
      collection: (name: string) => ({
        doc: () => (name === 'pvt_action_policies'
          ? doc(opts.pointer, opts.throwOn === 'pointer')
          : doc(opts.queue, opts.throwOn === 'queue')),
      }),
    } as unknown as Firestore;
  }
  const base = { actionType: 'never_seen_gate_type', recordedAtMs: NOW };

  it('no pointer + no queue doc + a class → class_admitted; without a class → pending_policy (pre-build outcome)', async () => {
    const r = await resolveActionPolicyAtRecordTime(db({}), { ...base, witnessClass: 'device_tier' });
    expect(r.status).toBe('class_admitted');
    expect(r.status === 'class_admitted' && r.witnessClass).toBe('device_tier');
    const r2 = await resolveActionPolicyAtRecordTime(db({}), base);
    expect(r2.status).toBe('pending_policy');
  });
  it('a queue entry that is merely pending is an override PROPOSAL, not a gate → class_admitted', async () => {
    const r = await resolveActionPolicyAtRecordTime(db({ queue: { action_type: base.actionType, policy_review_state: 'pending_policy' } }), { ...base, witnessClass: 'forge_witnessed' });
    expect(r.status).toBe('class_admitted');
  });
  it('RED — an effective REJECTION still wins; a read failure never admits', async () => {
    const rejected = await resolveActionPolicyAtRecordTime(db({ queue: {
      action_type: base.actionType, policy_review_state: 'rejected', effective_at: NOW - 10, effective_policy_version: 'v', rejection_reason_code: 'prohibited_circular_reward', rejected_at: NOW - 20, rejected_by: 'frank',
    } }), { ...base, witnessClass: 'device_tier' });
    expect(rejected.status).toBe('rejected');
    const failed = await resolveActionPolicyAtRecordTime(db({ throwOn: 'pointer' }), { ...base, witnessClass: 'device_tier' });
    expect(failed.status).toBe('pending_policy');
    const failedQueue = await resolveActionPolicyAtRecordTime(db({ throwOn: 'queue' }), { ...base, witnessClass: 'device_tier' });
    expect(failedQueue.status).toBe('pending_policy');
  });
  it('RED — a NAMED launch identifier never routes through class admission', async () => {
    const r = await resolveActionPolicyAtRecordTime(db({}), { actionType: 'coding_session', recordedAtMs: NOW, witnessClass: 'device_tier' });
    expect(r.status).toBe('known_launch_identifier');
  });
});
