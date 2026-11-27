/**
 * The capture-health heartbeat's longer-lived device cache entry: revocation overwrites it with a
 * tombstone, and a tombstone is read as a miss, so a revoked device's next heartbeat is decided by
 * Firestore. The heartbeat path is the only one that reads that entry.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../cache', () => {
  const store = new Map<string, unknown>();
  const del = jest.fn(async (key: string) => { store.delete(key); return 1; });
  const set = jest.fn(async (key: string, value: unknown) => { store.set(key, value); return 'OK'; });
  const get = jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null));
  return { __esModule: true, cache: { del, get, set, isEnabled: () => true }, __mocks: { del, set, get, store } };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mocks = (require('../../cache') as unknown as { __mocks: { set: jest.Mock; store: Map<string, unknown> } }).__mocks;

import { invalidateDeviceCache, isCaptureHealthHeartbeat } from './device-auth';

function fakeDb(prefix: string): never {
  return {
    collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ device_key_prefix: prefix, owner_type: 'agent' }) }) }) }),
  } as never;
}

describe('heartbeat device cache', () => {
  beforeEach(() => { mocks.store.clear(); mocks.set.mockClear(); });

  it('revocation leaves a tombstone on the heartbeat entry (RED: a cached device document would otherwise survive)', async () => {
    mocks.store.set('device:hb:pdk_prefix_000000000', { device_id: 'd1', owner_type: 'agent', status: 'active' });
    await invalidateDeviceCache(fakeDb('pdk_prefix_000000000'), 'd1');
    expect(mocks.store.get('device:hb:pdk_prefix_000000000')).toEqual({ device_cache_tombstone: true });
  });

  it('only the capture-health PUT is a heartbeat', () => {
    expect(isCaptureHealthHeartbeat({ method: 'PUT', originalUrl: '/v1/devices/me/capture-health' })).toBe(true);
    expect(isCaptureHealthHeartbeat({ method: 'PUT', originalUrl: '/V1/devices/me/capture-health?x=1' })).toBe(true);
    expect(isCaptureHealthHeartbeat({ method: 'POST', originalUrl: '/v1/meter/batch' })).toBe(false);
    expect(isCaptureHealthHeartbeat({ method: 'GET', originalUrl: '/v1/devices/me/capture-health' })).toBe(false);
  });
});
