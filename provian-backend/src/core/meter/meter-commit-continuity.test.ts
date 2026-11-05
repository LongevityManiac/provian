/**
 * the standing rule, at the call site: `commitMeterBatch` folds a chain-continuity record
 * into the vocabulary counters as continuity, and counts it in no act total, while an act of
 * work in the SAME batch folds as work. Drives the real batch commit on the fake Firestore and reads
 * the stored documents back, so bypassing the wiring at the call site fails here.
 */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../../cache', () => ({
  cache: {
    checkRateLimit: async () => ({ allowed: true }),
    get: async () => null,
    set: async () => {},
    del: async () => {},
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { commitMeterBatch } from './meter-commit';
import type { MeterActOutcome } from './meter-seal';
import { ACTOR_STATS_COLLECTION, coerceActorStats, type ActorStatsBump } from '../pvt/actor-stats';
import { ACTOR_METER_TOTALS_COLLECTION } from './actor-meter-totals';
import { buildBatch, METER_GENESIS_PREV_HASH, PE_V2_SCHEMA, peHashOf, type PeV2 } from './meter-wire';
import { batchHashOf } from './meter-wire';

const T0 = Date.parse('2026-10-10T12:00:00Z');
const MS = `sha256:${'79'.repeat(32)}`;

function chain(deviceId: string, types: readonly string[]): PeV2[] {
  const out: PeV2[] = [];
  let prev = METER_GENESIS_PREV_HASH;
  types.forEach((action_type, i) => {
    const pe = { schema: PE_V2_SCHEMA, pe_id: `pe_c_${i}`, device_id: deviceId, prev_hash: prev, timestamp: T0 + i, action_type, metadata: { i } } as unknown as PeV2;
    prev = peHashOf(pe);
    out.push(pe);
  });
  return out;
}

function priced(i: number, actionType: string, mintStatus: string): { kind: 'priced'; outcome: MeterActOutcome } {
  const relayPeId = `pe_relay_${i}`;
  const row = {
    peId: relayPeId, userId: 'agent_m', actionType, mint_status: mintStatus, timestamp: T0 + i,
    attestationDepth: 'software', mint_disposition: mintStatus === 'eligible' ? 'eligible' : 'record_only',
    beneficiary_wallet_id: 'human_h',
  };
  const statsBump: ActorStatsBump = {
    actorId: 'agent_m', peId: relayPeId, actionType, family: actionType === 'compute_session' ? 'other' : 'agent',
    witnessClass: 'hardware_rooted', timestampMs: T0 + i, attestationTier: 'software', witnessObservedTokens: null,
    bodyDeclaredTokens: null, independentOriginCount: 0, approvalsCited: 0,
    composition: { modelFamilies: [], environmentClass: 'vm', hardwareRegion: null, hardwareMeasurement: MS, witnessedPaymentAtomic: null, supervisionHumanTurns: null, supervisionTotalTurns: null },
  };
  const side = { statsBump: statsBump as unknown as Record<string, unknown>, delegation: null, corroborateIncumbentPeId: null, outputDigestsIndexed: false, effect: null };
  const key = {
    schema: 'provian.meter-act-key.v1', relay_pe_id: relayPeId, actor_id: 'agent_m', device_id: 'dev_m', action_type: actionType,
    timestamp: T0 + i, created_at_ms: T0 + i, pe_hash: `${i}`.padStart(64, '0'), prev_hash: METER_GENESIS_PREV_HASH, client_pe_id: `pe_c_${i}`,
    beneficiary_id: null, legs: [], unit: 'none', held_reason: null, row, side, facts: null, expire_at: null, batch_hash: '',
  };
  const outcome = {
    relayPeId, replay: false, row, legs: [], unit: 'none', heldReason: null, side, key,
    home: mintStatus === 'skipped_no_output' ? 'none' : 'page',
  } as unknown as MeterActOutcome;
  return { kind: 'priced', outcome };
}

describe('commitMeterBatch — continuity is not work (call site)', () => {
  it('an idle record folds as continuity and an act as work, in one batch', async () => {
    // Fixture rows carry no economic snapshot; the aggregate's integrity log is expected noise here.
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeFirestore();
    const types = ['compute_session', 'compute_session', 'coding_session'];
    const batch = buildBatch({ device_id: 'dev_m', seq: 1, prev_batch_hash: METER_GENESIS_PREV_HASH, created_at_ms: T0, pes: chain('dev_m', types) });
    await commitMeterBatch(fake as unknown as Firestore, {
      batch, batchHash: batchHashOf(batch), actorId: 'agent_m', expectedTip: null, acceptedAtMs: T0 + 10,
      acts: [priced(0, 'compute_session', 'skipped_no_output'), priced(1, 'compute_session', 'skipped_no_output'), priced(2, 'coding_session', 'eligible')],
    });

    const stats = coerceActorStats('agent_m', fake.store.get(`${ACTOR_STATS_COLLECTION}/agent_m`) ?? null);
    expect(stats.pe_count).toBe(1);
    expect(stats.continuity_records).toBe(2);
    expect(stats.by_family_class).toEqual({ agent__hardware_rooted: 1 });
    expect(stats.by_type).toEqual({ coding_session: 1 });
    expect(stats.measurements).toEqual({ [MS]: 1 });
    expect(stats.environments).toEqual({ vm: 1 });
    expect(stats.days['2026-10-10']).toMatchObject({ n: 1, cr: 2 });

    // The act totals count the one act, never the idle records.
    const totals = fake.store.get(`${ACTOR_METER_TOTALS_COLLECTION}/agent_m`) as Record<string, unknown> | undefined;
    expect(totals?.by_attestation_tier).toEqual({ software: 1 });
    // ...and the linked human's acts by this agent count the one act too.
    const human = fake.store.get(`${ACTOR_METER_TOTALS_COLLECTION}/human_h`) as Record<string, unknown> | undefined;
    expect(human?.beneficiary_acts_by_agent).toEqual({ agent_m: 1 });
  });
});
