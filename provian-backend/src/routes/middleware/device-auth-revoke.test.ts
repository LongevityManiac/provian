/**
 * Audit Pass 2, Fix 5 - invalidateDeviceCache must drop BOTH cache keys.
 *
 * The legacy DeviceKey auth caches by `device:${device_key_prefix}`.
 * The DeviceSignature (signed-submission) auth caches by `device:id:${deviceId}`.
 * Pre-fix only the first was deleted, so revoked devices could continue to
 * pass auth via the signed path for up to DEVICE_CACHE_TTL_S seconds.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock the cache module before importing the unit under test.
jest.mock('../../cache', () => {
  const del = jest.fn(async (_key: string) => 1);
  return {
    __esModule: true,
    cache: {
      del,
      get: jest.fn(async () => null),
      set: jest.fn(async () => 'OK'),
      isEnabled: () => true,
    },
    __mocks: { del },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cacheMockModule = require('../../cache') as unknown as {
  __mocks: { del: jest.Mock };
};

import { invalidateDeviceCache } from './device-auth';

function makeFakeDb(opts: { exists: boolean; device_key_prefix?: string; owner_type?: unknown }): any {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: opts.exists,
          data: () => ({
            device_key_prefix: opts.device_key_prefix,
            owner_type: opts.owner_type,
          }),
        }),
      }),
    }),
  };
}

describe('Audit Pass 2 / Fix 5: invalidateDeviceCache', () => {
  beforeEach(() => {
    cacheMockModule.__mocks.del.mockClear();
  });

  it('deletes both cache keys when the device doc exists', async () => {
    const db = makeFakeDb({
      exists: true,
      device_key_prefix: 'prefix12345678901234',
      owner_type: 'human',
    });
    await invalidateDeviceCache(db, 'dev_abc123');

    const calls = cacheMockModule.__mocks.del.mock.calls.map((args: unknown[]) => args[0] as string);
    expect(calls).toContain('device:prefix12345678901234');
    expect(calls).toContain('device:id:dev_abc123');
    expect(calls).toHaveLength(2);
  });

  it('still drops the id-keyed cache entry when the device doc is missing', async () => {
    const db = makeFakeDb({ exists: false });
    await invalidateDeviceCache(db, 'dev_missing');

    const calls = cacheMockModule.__mocks.del.mock.calls.map((args: unknown[]) => args[0] as string);
    expect(calls).toContain('device:id:dev_missing');
    expect(calls).toHaveLength(1);
  });

  it('does not trust malformed ownership to derive a prefix cache key', async () => {
    const db = makeFakeDb({
      exists: true,
      device_key_prefix: 'prefix12345678901234',
      owner_type: 'unknown',
    });
    await invalidateDeviceCache(db, 'dev_invalid_owner');

    const calls = cacheMockModule.__mocks.del.mock.calls.map((args: unknown[]) => args[0] as string);
    expect(calls).toEqual(['device:id:dev_invalid_owner']);
  });
});
