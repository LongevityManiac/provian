/**
 * 2026-10-17: a relay-authored act re-priced by the replay sweep AFTER its emitter committed it
 * (every outcome a replay) must leave the committed batch record alone. Before this, the commit
 * unconditionally rewrote `meter_batches_v1/{batchHash}` with `anchored: false`, a new `day` and
 * empty `claim_keys`, so the daily anchor re-included the same batch leaf under a second root and
 * the device's served proof silently changed.
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
import { METER_BATCHES_COLLECTION } from './meter-store';
import { buildBatch, METER_GENESIS_PREV_HASH, PE_V2_SCHEMA, batchHashOf, type PeV2 } from './meter-wire';

const T0 = Date.parse('2026-10-17T12:00:00Z');
const RELAY_DEVICE = 'relay:user_h';

function outcomeOf(i: number, replay: boolean): { kind: 'priced'; outcome: MeterActOutcome } {
  const relayPeId = `pe_relay_${i}`;
  const row = {
    peId: relayPeId, userId: 'user_h', actionType: 'wallet_created', mint_status: 'eligible', timestamp: T0 + i,
    attestationDepth: 'software', mint_disposition: 'eligible', record_points_atomic: '1000',
  };
  const side = { statsBump: null, delegation: null, corroborateIncumbentPeId: null, outputDigestsIndexed: false, effect: null };
  const key = {
    schema: 'provian.meter-act-key.v1', relay_pe_id: relayPeId, actor_id: 'user_h', device_id: RELAY_DEVICE,
    action_type: 'wallet_created', timestamp: T0 + i, created_at_ms: T0 + i, pe_hash: `${i}`.padStart(64, '0'),
    prev_hash: METER_GENESIS_PREV_HASH, client_pe_id: `pe_c_${i}`, beneficiary_id: null, legs: [], unit: 'none',
    held_reason: null, row, side, facts: null, expire_at: null, batch_hash: '',
  };
  const outcome = {
    relayPeId, replay, row, legs: [], unit: 'none', heldReason: null, side,
    ...(replay ? {} : { key, home: 'page' }),
  } as unknown as MeterActOutcome;
  return { kind: 'priced', outcome };
}

function relayBatch() {
  const pe = {
    schema: PE_V2_SCHEMA, pe_id: 'pe_c_0', device_id: RELAY_DEVICE, prev_hash: METER_GENESIS_PREV_HASH,
    timestamp: T0, action_type: 'wallet_created', metadata: {},
  } as unknown as PeV2;
  const batch = buildBatch({ device_id: RELAY_DEVICE, seq: 1, prev_batch_hash: METER_GENESIS_PREV_HASH, created_at_ms: T0, pes: [pe] });
  return { batch, batchHash: batchHashOf(batch) };
}

describe('commitMeterBatch — a relay-authored replay keeps the committed record (2026-10-17)', () => {
  it('after the emitter committed and the day anchored, the replay sweep\'s commit changes nothing but still runs its hooks', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeFirestore();
    const { batch, batchHash } = relayBatch();
    const base = { batch, batchHash, actorId: 'user_h', expectedTip: null, relayAuthored: true, extraWrites: [] as never[] };
    await commitMeterBatch(fake as unknown as Firestore, { ...base, acceptedAtMs: T0 + 10, acts: [outcomeOf(0, false)] });
    const key = `${METER_BATCHES_COLLECTION}/${batchHash}`;
    const committed = fake.store.get(key) as Record<string, unknown>;
    expect(committed).toMatchObject({ anchored: false, day: '2026-10-17' });

    // The daily anchor lands.
    fake.store.set(key, { ...committed, anchored: true, anchor: { day: '2026-10-17', segment: 1 }, anchored_at_ms: T0 + 100 });

    // The sweep re-prices the same act six minutes later on another day: every outcome a replay.
    let hookRan = 0;
    const replayDay = Date.parse('2026-10-18T00:02:00Z');
    await commitMeterBatch(fake as unknown as Firestore, {
      ...base, acceptedAtMs: replayDay, acts: [outcomeOf(0, true)],
      txnHooks: [{ read: async () => {}, write: () => { hookRan += 1; } }],
    });
    expect(hookRan).toBe(1);
    expect(fake.store.get(key)).toMatchObject({ anchored: true, anchor: { day: '2026-10-17', segment: 1 }, day: '2026-10-17' });
  });

  it('control: a FRESH relay-authored commit still writes its record', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeFirestore();
    const { batch, batchHash } = relayBatch();
    await commitMeterBatch(fake as unknown as Firestore, {
      batch, batchHash, actorId: 'user_h', expectedTip: null, relayAuthored: true, acceptedAtMs: T0 + 10,
      acts: [outcomeOf(0, false)], extraWrites: [],
    });
    expect(fake.store.get(`${METER_BATCHES_COLLECTION}/${batchHash}`)).toMatchObject({ anchored: false, batch_hash: batchHash });
  });
});
