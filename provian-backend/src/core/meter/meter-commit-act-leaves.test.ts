/**
 * PE export — the batch record keeps every act leaf (`meter-commit.ts`).
 *
 * `commitMeterBatch` is the ONE writer of `meter_batches_v1` for every lane: the device batch and
 * the phone batch (both through `ingestMeterBatch`) and relay-authored one-act batches
 * (`priceRelayAct`). This pins, on the fake Firestore with a batch whose acts were all refused
 * before pricing (so no pricing state is needed), that the record carries `act_leaves` equal to
 * `batch.acts.map(actLeafOf)` — refused acts included, because `acts_root` covers every act — and
 * that they recompute `acts_root`.
 * RED control: a leaf list built from a different batch does not equal the stored one.
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
import { METER_BATCHES_COLLECTION } from './meter-store';
import {
  actLeafOf, batchHashOf, buildBatch, merkleRootOf, METER_GENESIS_PREV_HASH, PE_V2_SCHEMA, peHashOf, type PeV2,
} from './meter-wire';

const T0 = Date.parse('2026-10-04T12:00:00Z');

function pes(deviceId: string, count: number, salt: string): PeV2[] {
  const out: PeV2[] = [];
  let prev = METER_GENESIS_PREV_HASH;
  for (let i = 0; i < count; i++) {
    const pe = {
      schema: PE_V2_SCHEMA, pe_id: `pe_${salt}_${i}`, device_id: deviceId, prev_hash: prev, timestamp: T0 + i,
      action_type: 'ai_conversation', metadata: { n: i, salt },
    } as unknown as PeV2;
    prev = peHashOf(pe);
    out.push(pe);
  }
  return out;
}

describe('commitMeterBatch — act_leaves on the batch record', () => {
  it('writes act_leaves = batch.acts.map(actLeafOf), recomputing acts_root', async () => {
    const fake = createFakeFirestore();
    const batch = buildBatch({ device_id: 'dev_x', seq: 1, prev_batch_hash: METER_GENESIS_PREV_HASH, created_at_ms: T0, pes: pes('dev_x', 4, 'a') });
    const batchHash = batchHashOf(batch);
    await commitMeterBatch(fake as unknown as Firestore, {
      batch, batchHash, actorId: 'agent_x', expectedTip: null, acceptedAtMs: T0,
      acts: batch.acts.map(() => ({ kind: 'refused' as const, reason: 'test_refused' })),
    });
    const doc = fake.store.get(`${METER_BATCHES_COLLECTION}/${batchHash}`) as Record<string, unknown> | undefined;
    expect(doc).toBeDefined();
    const leaves = doc?.act_leaves as string[];
    expect(leaves).toHaveLength(4);
    expect(leaves).toEqual(batch.acts.map(actLeafOf));
    expect(leaves.every((l) => /^[0-9a-f]{64}$/.test(l))).toBe(true);
    expect(merkleRootOf(leaves)).toBe(batch.acts_root);
    expect(doc?.act_count).toBe(4);

    // RED: another batch's leaves are not these.
    const other = buildBatch({ device_id: 'dev_x', seq: 1, prev_batch_hash: METER_GENESIS_PREV_HASH, created_at_ms: T0, pes: pes('dev_x', 4, 'b') });
    expect(leaves).not.toEqual(other.acts.map(actLeafOf));
  });
});
