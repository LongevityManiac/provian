/**
 * `device_pe_rate_limits` write distribution (M9).
 *
 * M9 was tracked as "single-doc contention for the 5/day credential types". Read
 * against the code, the contention risk is NOT present as keyed: the document id
 * is `{device_anchor}_{action_type}`, so writes are partitioned per PHYSICAL
 * DEVICE, and each partition is self-limited to 5 writes per day (1 per 90 days
 * for the setup types) by the very rule it enforces. Firestore's ~1 write/sec
 * per-document ceiling is orders of magnitude above that, and the arrays are
 * window-pruned on every write, so neither size nor contention bites.
 *
 * WHAT WOULD MAKE IT REAL is a COARSER key. Keyed by action type alone, every
 * device on the network would serialise through four documents — a genuine
 * hotspot, and the exact shape the original finding feared. That is a
 * one-character-class change away, and nothing was pinning it.
 *
 * So this file does not shard anything that is not hot. It pins the property
 * that keeps it cold, and the pin is written so that widening the key fails
 * loudly rather than quietly creating the hotspot years later.
 */

import type { Firestore } from 'firebase-admin/firestore';

import { createFakeFirestore, type FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';

let mockFirestore: Firestore;
jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: () => mockFirestore,
  },
}));

import { checkDevicePERateLimit } from './device-pe-rate-limiter';

const PREFIX = 'device_pe_rate_limits/';

function limiterDocIds(fake: FakeFirestore): string[] {
  return [...fake.store.keys()]
    .filter((k) => k.startsWith(PREFIX))
    .map((k) => k.slice(PREFIX.length))
    .sort();
}

describe('device rate-limit write partitioning (M9)', () => {
  let fake: FakeFirestore;
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    fake = createFakeFirestore();
    mockFirestore = fake as unknown as Firestore;
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });
  afterEach(() => nowSpy.mockRestore());

  it('gives every DEVICE its own document — no shared hot doc across devices', async () => {
    // Ten devices doing the same rate-limited action must not serialise through
    // one document. Ten devices in, ten documents out.
    const devices = Array.from({ length: 10 }, (_, i) => `device_${i}`);
    for (const device of devices) {
      await expect(checkDevicePERateLimit(device, null, 'credential_added', `pe_${device}`))
        .resolves.toMatchObject({ allowed: true });
    }

    const ids = limiterDocIds(fake);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    // The key must carry the device, not just the action — this is the assertion
    // that fails if the key is ever widened.
    for (const device of devices) expect(ids).toContain(`${device}_credential_added`);
  });

  it('gives every ACTION TYPE its own document within a device', async () => {
    await checkDevicePERateLimit('device_a', null, 'credential_added', 'pe_1');
    await checkDevicePERateLimit('device_a', null, 'credential_updated', 'pe_2');
    await checkDevicePERateLimit('device_a', null, 'wallet_created', 'pe_3');

    expect(limiterDocIds(fake)).toEqual([
      'device_a_credential_added',
      'device_a_credential_updated',
      'device_a_wallet_created',
    ]);
  });

  it('caps writes per document at the rule — 5/day, then denials write nothing', async () => {
    // The self-limiting property: a device cannot generate unbounded writes to
    // its own document, because the rule it is checking is what bounds them.
    for (let i = 0; i < 5; i += 1) {
      await expect(checkDevicePERateLimit('device_b', null, 'credential_added', `pe_${i}`))
        .resolves.toMatchObject({ allowed: true });
    }
    const afterFive = fake.store.get('device_pe_rate_limits/device_b_credential_added') as
      { recorded_at: number[] };
    expect(afterFive.recorded_at).toHaveLength(5);

    // Three more attempts: all denied, and the document is UNCHANGED — a denial
    // is a read, not a write, so a hammering client cannot drive write load.
    for (let i = 5; i < 8; i += 1) {
      await expect(checkDevicePERateLimit('device_b', null, 'credential_added', `pe_${i}`))
        .resolves.toMatchObject({ allowed: false });
    }
    expect(fake.store.get('device_pe_rate_limits/device_b_credential_added'))
      .toEqual(afterFive);
  });

  it('prunes the timestamp array to the window, so it cannot grow without bound', async () => {
    for (let i = 0; i < 5; i += 1) {
      await checkDevicePERateLimit('device_c', null, 'credential_added', `pe_${i}`);
    }
    // Step a day and a minute forward: the old window has fully lapsed.
    nowSpy.mockReturnValue(1_000_000 + 24 * 60 * 60 * 1000 + 60_000);
    await expect(checkDevicePERateLimit('device_c', null, 'credential_added', 'pe_next'))
      .resolves.toMatchObject({ allowed: true });

    const doc = fake.store.get('device_pe_rate_limits/device_c_credential_added') as
      { recorded_at: number[]; recorded_pe_ids: Record<string, number> };
    // One entry, not six: the five expired stamps were dropped, not appended to.
    expect(doc.recorded_at).toHaveLength(1);
    expect(Object.keys(doc.recorded_pe_ids)).toEqual(['pe_next']);
  });

  it('CONTROL — an unlisted action type writes NOTHING at all', async () => {
    // Without this, every case above could pass against an implementation that
    // never wrote a limiter document, which would make the partitioning claims
    // vacuous.
    await expect(checkDevicePERateLimit('device_d', null, 'coding_session', 'pe_x'))
      .resolves.toMatchObject({ allowed: true, anchor: 'none' });
    expect(limiterDocIds(fake)).toEqual([]);
  });
});
