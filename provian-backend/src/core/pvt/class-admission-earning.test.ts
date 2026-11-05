import * as crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  classAdmittedWitnessedFields,
  isClassAdmittedAtRecordTime,
  isUnnamedActionTypeAtRecordTime,
  mobileLaneWitnessClass,
} from './class-admission-earning';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './wp11/ordinary-accrual-intake';
import { WITNESSED_CLASSES } from './policy/evidence-class';
import { materializeProposedMonetaryPolicy } from './policy/runtime-monetary-policy';

const NOW = 1_790_000_000_000;
const DIGEST = 'a'.repeat(64);
const TYPE = 'water_sensor_reading';
const hashOf = (canonical: string) => crypto.createHash('sha256').update(canonical).digest('hex');

describe('classAdmittedWitnessedFields — a never-seen type witnessed by a non-actor key mints at its class base', () => {
  const admit = (over: Partial<Parameters<typeof classAdmittedWitnessedFields>[0]> = {}) => classAdmittedWitnessedFields({
    actionType: TYPE,
    classAdmitted: true,
    witnessClass: 'device_tier',
    witnessId: 'device:dev_1',
    bodyDigestHex: DIGEST,
    ...over,
  });

  it('ADMIT: lifts the durability fence, stamps verified, and anchors mint-once on (type, device, body)', () => {
    const canonical = `class_admitted:${TYPE}:device:dev_1:${DIGEST}`;
    const overlay = admit();
    expect(overlay).toEqual({
      durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
      economicEvidenceState: 'verified',
      economicCanonicalEventId: canonical,
      deviceWitnessedOccurrenceHash: hashOf(canonical),
    });
  });

  it('ADMIT for every witnessed (non-actor) class, hardware_rooted included', () => {
    for (const cls of WITNESSED_CLASSES) {
      expect(admit({ witnessClass: cls }).durableReplaySource).toBe(ORDINARY_ACCRUAL_REPLAY_SOURCE);
    }
    expect(WITNESSED_CLASSES.size).toBeGreaterThan(0); // never a pass over an empty population
  });

  it('mint-once: a byte-identical replay hashes identically; another body or another device differs', () => {
    const a = admit().deviceWitnessedOccurrenceHash;
    expect(admit().deviceWitnessedOccurrenceHash).toBe(a);
    expect(admit({ bodyDigestHex: 'b'.repeat(64) }).deviceWitnessedOccurrenceHash).not.toBe(a);
    expect(admit({ witnessId: 'device:dev_2' }).deviceWitnessedOccurrenceHash).not.toBe(a);
    expect(admit({ actionType: 'soil_probe_reading' }).deviceWitnessedOccurrenceHash).not.toBe(a);
  });

  it('RED — the boundary: an actor-declared-only submission gets an EMPTY overlay (records at zero)', () => {
    expect(admit({ witnessClass: 'actor_declared' })).toEqual({});
  });

  it('RED — a NAMED type (not class-admitted) gets an EMPTY overlay: every named row stays byte-identical', () => {
    expect(admit({ classAdmitted: false })).toEqual({});
  });

  it('RED — fail closed: no witness identity or a malformed body digest records, never a 0-anchor mint', () => {
    expect(admit({ witnessId: null })).toEqual({});
    expect(admit({ witnessId: '   ' })).toEqual({});
    expect(admit({ witnessId: 'x'.repeat(257) })).toEqual({});
    expect(admit({ bodyDigestHex: 'not-a-digest' })).toEqual({});
    expect(admit({ bodyDigestHex: 'A'.repeat(64) })).toEqual({});
  });
});

describe('isClassAdmittedAtRecordTime — the same resolver + loader the accrual reads, read-only', () => {
  function db(opts: { pointer?: Record<string, unknown> | null; queue?: Record<string, unknown> | null; throwOn?: 'pointer' | 'queue' } = {}): Firestore {
    const doc = (data: Record<string, unknown> | null | undefined, throws: boolean) => ({
      get: async () => {
        if (throws) throw new Error('unavailable');
        return { exists: data != null, data: () => data ?? undefined };
      },
      set: async () => { throw new Error('isClassAdmittedAtRecordTime must never write'); },
    });
    return {
      collection: (name: string) => ({
        doc: () => (name === 'pvt_action_policies'
          ? doc(opts.pointer, opts.throwOn === 'pointer')
          : doc(opts.queue, opts.throwOn === 'queue')),
      }),
    } as unknown as Firestore;
  }

  it('new-type intake : a never-seen type is class-admitted for RECORDING only → false at every witnessed class', async () => {
    // RED against the pre-ruling rail: there this returned true (the class-base row was eligible).
    expect(WITNESSED_CLASSES.size).toBe(5); // never a pass over an empty population
    for (const cls of WITNESSED_CLASSES) {
      expect([cls, await isClassAdmittedAtRecordTime(db(), { actionType: TYPE, recordedAtMs: NOW, witnessClass: cls })]).toEqual([cls, false]);
    }
  });

  it('RED — actor_declared → false (class base 0: records, never mints)', async () => {
    expect(await isClassAdmittedAtRecordTime(db(), { actionType: TYPE, recordedAtMs: NOW, witnessClass: 'actor_declared' })).toBe(false);
  });

  it('RED — a named launch identifier (and a named record_only row) → false: the overlay never touches a named row', async () => {
    expect(await isClassAdmittedAtRecordTime(db(), { actionType: 'coding_session', recordedAtMs: NOW, witnessClass: 'device_tier' })).toBe(false);
    expect(await isClassAdmittedAtRecordTime(db(), { actionType: 'device_register', recordedAtMs: NOW, witnessClass: 'device_tier' })).toBe(false);
    expect(await isClassAdmittedAtRecordTime(db(), { actionType: 'environment_attestation', recordedAtMs: NOW, witnessClass: 'device_tier' })).toBe(false);
  });

  it('RED — EVERY named row in the matrix → false for every witnessed class (the whole named set is byte-identical)', async () => {
    const named = Object.keys(materializeProposedMonetaryPolicy(0).actions);
    expect(named.length).toBeGreaterThan(200); // never a pass over an empty population
    const admitted: string[] = [];
    for (const actionType of named) {
      for (const cls of WITNESSED_CLASSES) {
        if (await isClassAdmittedAtRecordTime(db(), { actionType, recordedAtMs: NOW, witnessClass: cls })) admitted.push(`${actionType}/${cls}`);
      }
    }
    expect(admitted).toEqual([]);
  });

  it('RED — an effective rejection wins and a read failure never admits', async () => {
    const rejected = db({ queue: {
      action_type: TYPE, policy_review_state: 'rejected', effective_at: NOW - 10, effective_policy_version: 'v',
      rejection_reason_code: 'prohibited_circular_reward', rejected_at: NOW - 20, rejected_by: 'frank',
    } });
    expect(await isClassAdmittedAtRecordTime(rejected, { actionType: TYPE, recordedAtMs: NOW, witnessClass: 'device_tier' })).toBe(false);
    expect(await isClassAdmittedAtRecordTime(db({ throwOn: 'pointer' }), { actionType: TYPE, recordedAtMs: NOW, witnessClass: 'device_tier' })).toBe(false);
    expect(await isClassAdmittedAtRecordTime(db({ throwOn: 'queue' }), { actionType: TYPE, recordedAtMs: NOW, witnessClass: 'device_tier' })).toBe(false);
  });
});

describe('the MOBILE lane (2026-09-30, carried): a never-seen type is the human\'s own declaration', () => {
  function db(): Firestore {
    const doc = () => ({
      get: async () => ({ exists: false, data: () => undefined }),
      set: async () => { throw new Error('isUnnamedActionTypeAtRecordTime must never write'); },
    });
    return { collection: () => ({ doc }) } as unknown as Firestore;
  }

  it('mobileLaneWitnessClass: unnamed → actor_declared, with or without an App Attest report', () => {
    expect(mobileLaneWitnessClass({ hardwareAdmitted: false, unnamedActionType: true })).toBe('actor_declared');
    expect(mobileLaneWitnessClass({ hardwareAdmitted: true, unnamedActionType: true })).toBe('actor_declared');
  });

  it('mobileLaneWitnessClass: a named type keeps the lane class (device_tier / hardware_rooted) — RED control that the guard is not a constant', () => {
    expect(mobileLaneWitnessClass({ hardwareAdmitted: false, unnamedActionType: false })).toBe('device_tier');
    expect(mobileLaneWitnessClass({ hardwareAdmitted: true, unnamedActionType: false })).toBe('hardware_rooted');
  });

  it('an actor_declared never-seen type gets NO class-admission overlay and is not class-admitted (records at zero)', async () => {
    const cls = mobileLaneWitnessClass({ hardwareAdmitted: true, unnamedActionType: true });
    expect(await isClassAdmittedAtRecordTime(db(), { actionType: 'my_garden_work', recordedAtMs: NOW, witnessClass: cls })).toBe(false);
    expect(classAdmittedWitnessedFields({
      actionType: 'my_garden_work', classAdmitted: true, witnessClass: cls, witnessId: 'mobile:dev_1', bodyDigestHex: DIGEST,
    })).toEqual({});
  });

  it('isUnnamedActionTypeAtRecordTime: a never-seen type → true; named launch rows (ai_conversation, human_approval) → false', async () => {
    expect(await isUnnamedActionTypeAtRecordTime(db(), { actionType: 'my_garden_work', recordedAtMs: NOW })).toBe(true);
    expect(await isUnnamedActionTypeAtRecordTime(db(), { actionType: 'ai_conversation', recordedAtMs: NOW })).toBe(false);
    expect(await isUnnamedActionTypeAtRecordTime(db(), { actionType: 'human_approval', recordedAtMs: NOW })).toBe(false);
  });

  it('isUnnamedActionTypeAtRecordTime: EVERY named matrix row → false (the whole named set keeps its lane class)', async () => {
    const named = Object.keys(materializeProposedMonetaryPolicy(0).actions);
    expect(named.length).toBeGreaterThan(200); // never a pass over an empty population
    const unnamed: string[] = [];
    for (const actionType of named) {
      if (await isUnnamedActionTypeAtRecordTime(db(), { actionType, recordedAtMs: NOW })) unnamed.push(actionType);
    }
    expect(unnamed).toEqual([]);
  });

  it('isUnnamedActionTypeAtRecordTime fails CLOSED: a resolver that throws answers "unnamed" (actor_declared), never "named"', async () => {
    const throwing = { collection: () => { throw new Error('unavailable'); } } as unknown as Firestore;
    expect(await isUnnamedActionTypeAtRecordTime(throwing, { actionType: 'my_garden_work', recordedAtMs: NOW })).toBe(true);
  });
});
