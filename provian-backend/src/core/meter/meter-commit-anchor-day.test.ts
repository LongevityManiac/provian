/**
 * Every accepted batch is committed by some anchor. A batch's anchor day is decided inside its
 * commit transaction against the day's anchor record, and the day's close marks that record before
 * it selects: a batch whose acceptance day has already begun closing is stamped onto the next open
 * day, where the next close commits it. Drives the real batch commit and the real daily anchor on
 * the fake Firestore.
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

import { ethers } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { commitMeterBatch } from './meter-commit';
import { runDailyMeterAnchor } from './meter-anchor';
import { METER_ANCHOR_DAYS_COLLECTION, METER_ANCHOR_DAY_CLOSING_FIELD, METER_BATCHES_COLLECTION, openMeterAnchorDay } from './meter-store';
import { batchHashOf, buildBatch, METER_GENESIS_PREV_HASH, PE_V2_SCHEMA, type PeV2 } from './meter-wire';
import { PE_ANCHOR_ABI } from '../agent-bank/types';

const DAY = '2026-10-10';
const NEXT = '2026-10-11';
const BEFORE_MIDNIGHT = Date.parse(`${NEXT}T00:00:00Z`) - 500;

function fakeAnchorContract(): ethers.Contract {
  const roots = new Map<string, string>();
  const iface = new ethers.Interface(PE_ANCHOR_ABI);
  return {
    getBatch: async (id: string) => iface.decodeFunctionResult('getBatch',
      iface.encodeFunctionResult('getBatch', [roots.get(id) ?? ethers.ZeroHash, roots.has(id) ? 1 : 0, 1, 1, roots.has(id)])),
    anchorBatch: async (id: string, root: string) => {
      roots.set(id, root);
      return { hash: `0x${'d'.repeat(64)}`, wait: async () => ({ hash: `0x${'d'.repeat(64)}`, blockNumber: 1 }) };
    },
  } as unknown as ethers.Contract;
}

function fixture() {
  const fake = createFakeFirestore();
  Object.assign(fake, { bulkWriter: () => {
    const pending: (() => Promise<unknown>)[] = [];
    return {
      update(ref: { update(data: Record<string, unknown>): Promise<unknown> }, data: Record<string, unknown>) { pending.push(() => ref.update(data)); return Promise.resolve(); },
      async close() { for (const write of pending) await write(); },
    };
  } });
  const db = fake as unknown as Firestore;
  let now = BEFORE_MIDNIGHT;
  const deps = { db, peAnchorContract: fakeAnchorContract(), now: () => now };
  const commit = async (deviceId: string, acceptedAtMs: number): Promise<string> => {
    const pe = { schema: PE_V2_SCHEMA, pe_id: `pe_${deviceId}`, device_id: deviceId, prev_hash: METER_GENESIS_PREV_HASH, timestamp: acceptedAtMs, action_type: 'compute_session', metadata: {} } as unknown as PeV2;
    const batch = buildBatch({ device_id: deviceId, seq: 1, prev_batch_hash: METER_GENESIS_PREV_HASH, created_at_ms: acceptedAtMs, pes: [pe] });
    const batchHash = batchHashOf(batch);
    await commitMeterBatch(db, { batch, batchHash, actorId: `actor_${deviceId}`, expectedTip: null, acceptedAtMs, acts: [] });
    return batchHash;
  };
  const batchDoc = async (hash: string) => (await db.collection(METER_BATCHES_COLLECTION).doc(hash).get()).data() ?? {};
  return { db, deps, commit, batchDoc, setNow(ms: number) { now = ms; } };
}

describe('a batch accepted just before midnight whose commit lands after the day closed', () => {
  it('control: a batch committed while its day is open is stamped onto it and anchored by its close', async () => {
    const f = fixture();
    const early = await f.commit('dev_early', BEFORE_MIDNIGHT);
    expect((await f.batchDoc(early)).day).toBe(DAY);
    f.setNow(Date.parse(`${NEXT}T00:15:00Z`));
    expect((await runDailyMeterAnchor(f.deps)).processed).toMatchObject([{ day: DAY, status: 'anchored', batch_count: 1 }, { day: NEXT, status: 'day_not_closed' }]);
    expect((await f.batchDoc(early)).anchored).toBe(true);
  });

  it('RED: it joins the next open day and that day\'s close anchors it — it is never left unanchored', async () => {
    const f = fixture();
    const early = await f.commit('dev_early', BEFORE_MIDNIGHT);
    // The day closes and is anchored while the late batch is still being priced.
    f.setNow(Date.parse(`${NEXT}T00:15:00Z`));
    expect((await runDailyMeterAnchor(f.deps)).watermark).toBe(DAY);
    expect((await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(DAY).get()).data()).toMatchObject({ status: 'anchored' });

    // Its commit lands now, with the acceptance time it was given before midnight.
    const late = await f.commit('dev_late', BEFORE_MIDNIGHT + 1);
    expect(await f.batchDoc(late)).toMatchObject({ day: NEXT, accepted_at_ms: BEFORE_MIDNIGHT + 1, anchored: false });

    f.setNow(Date.parse('2026-10-12T00:15:00Z'));
    const run = await runDailyMeterAnchor(f.deps);
    expect(run.processed[0]).toMatchObject({ day: NEXT, status: 'anchored', batch_count: 1 });
    // Every accepted batch carries a proof under some anchored root.
    for (const hash of [early, late]) expect(await f.batchDoc(hash)).toMatchObject({ anchored: true, anchor: { leaf_count: 1 } });
  });

  it('RED: a day whose close has only BEGUN already takes no more batches', async () => {
    const f = fixture();
    await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(DAY).set({ day: DAY, [METER_ANCHOR_DAY_CLOSING_FIELD]: BEFORE_MIDNIGHT + 700_000 });
    const late = await f.commit('dev_late', BEFORE_MIDNIGHT);
    expect((await f.batchDoc(late)).day).toBe(NEXT);
  });

  it('the close marks the day in the transaction that takes its lease, and an open-day segment does not', async () => {
    const f = fixture();
    await f.commit('dev_early', BEFORE_MIDNIGHT);
    f.setNow(Date.parse(`${NEXT}T00:15:00Z`));
    await runDailyMeterAnchor(f.deps);
    expect(typeof (await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(DAY).get()).data()?.[METER_ANCHOR_DAY_CLOSING_FIELD]).toBe('number');
    expect((await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(NEXT).get()).data()?.[METER_ANCHOR_DAY_CLOSING_FIELD]).toBeUndefined();
  });

  it('refuses rather than stamp a batch onto a day when no open day is within reach', async () => {
    const f = fixture();
    for (let i = 0; i < 4; i += 1) {
      const day = new Date(BEFORE_MIDNIGHT + i * 86_400_000).toISOString().slice(0, 10);
      await f.db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(day).set({ day, status: 'anchored' });
    }
    await expect(f.db.runTransaction((txn) => openMeterAnchorDay(txn, f.db, BEFORE_MIDNIGHT))).rejects.toThrow('meter_anchor_day_unavailable');
  });
});
