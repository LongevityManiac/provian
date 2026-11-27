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
  const setNx = jest.fn(async (key: string, value: unknown) => { if (store.has(key)) return false; store.set(key, value); return true; });
  return { __esModule: true, cache: { del, get, set, setNx, isEnabled: () => true }, __mocks: { del, set, get, setNx, store } };
});
jest.mock('../../core/agent-wallet/api-key', () => ({ __esModule: true, verifyApiCredentialAsync: async () => true }));
jest.mock('../../core/jurisdiction/mint-compliance', () => ({ __esModule: true, observeActorSession: async () => undefined }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mocks = (require('../../cache') as unknown as { __mocks: { set: jest.Mock; store: Map<string, unknown> } }).__mocks;

import { createDeviceAuthMiddleware, invalidateDeviceCache, isCaptureHealthHeartbeat } from './device-auth';

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

  it('a heartbeat whose device read started before a revocation cannot put the old document back over the tombstone', async () => {
    const prefix = 'pdk_aaaaaaaaaaaaaaaa';
    const hbKey = `device:hb:${prefix}`;
    let status = 'active';
    let revokeDuringRead = true;
    const db = {
      collection: (name: string) => ({
        doc: () => ({
          get: async () => {
            if (name === 'device_key_index') return { exists: true, data: () => ({ device_id: 'd1' }) };
            const snapshot = { device_id: 'd1', device_key_prefix: prefix, owner_type: 'agent', owner_wallet_id: 'w1', status,
              device_key_hash: 'h', device_key_salt: 's' };
            if (revokeDuringRead) {
              // The revocation commits and invalidates while this read is in flight.
              revokeDuringRead = false;
              status = 'revoked';
              mocks.store.set(hbKey, { device_cache_tombstone: true });
            }
            return { exists: true, data: () => snapshot };
          },
        }),
      }),
    } as never;
    const middleware = createDeviceAuthMiddleware(db);
    const run = async () => {
      let code = 0;
      let passed = false;
      const req = { method: 'PUT', originalUrl: '/v1/devices/me/capture-health', url: '/v1/devices/me/capture-health', path: '/v1/devices/me/capture-health',
        headers: { authorization: `DeviceKey ${prefix}xyz:pds_secret` }, body: {}, query: {}, ip: '8.8.8.8' } as never;
      const res = { status: (c: number) => { code = c; return { json: () => undefined }; } } as never;
      await middleware(req, res, () => { passed = true; });
      return { code, passed };
    };
    // The in-flight heartbeat still answers from its (pre-revocation) read, as any request already past auth would.
    expect((await run()).passed).toBe(true);
    // RED: a plain set here would leave the active document cached for an hour.
    expect(mocks.store.get(hbKey)).toEqual({ device_cache_tombstone: true });
    // The next heartbeat is decided by Firestore: revoked.
    expect(await run()).toEqual({ code: 403, passed: false });
  });
});
