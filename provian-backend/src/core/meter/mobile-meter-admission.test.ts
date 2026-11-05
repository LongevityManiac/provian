/**
 * Fix run 2026-10-24 (CC launch audit M1): the phone batch limiter keys on the authenticated
 * wallet, never on the device id the caller names in its own token, and server.ts wires the
 * admission, the chain-owner check and the owner-bound tip/proofs reads into the phone routes.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MOBILE_METER_BATCHES_PER_HOUR,
  admitMobileMeterBatch,
  isMobileMeterDeviceId,
  mobileMeterRateLimitKey,
} from './mobile-meter-admission';

/** A fixed-window limiter with the cache's contract: allowed while the key's count is within the limit. */
function fakeCache() {
  const counts = new Map<string, number>();
  return {
    counts,
    async checkRateLimit(key: string, limit: number) {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { allowed: n <= limit, current: n, limit };
    },
  };
}

describe('phone batch admission keys on the wallet', () => {
  test('rotating the device id does not buy a wallet more batches', async () => {
    const cache = fakeCache();
    for (let i = 0; i < MOBILE_METER_BATCHES_PER_HOUR; i += 1) {
      expect((await admitMobileMeterBatch(cache, 'user_a', `device_${i.toString(16).padStart(32, '0')}`)).ok).toBe(true);
    }
    const over = await admitMobileMeterBatch(cache, 'user_a', `device_${'f'.repeat(32)}`);
    expect(over).toMatchObject({ ok: false, status: 429 });
    // RED control: the limiter is not simply exhausted — another wallet is still admitted.
    expect((await admitMobileMeterBatch(cache, 'user_b', `device_${'f'.repeat(32)}`)).ok).toBe(true);
    expect([...cache.counts.keys()].sort()).toEqual([mobileMeterRateLimitKey('user_a'), mobileMeterRateLimitKey('user_b')].sort());
  });

  test('a namespaced or malformed device id is refused before the limiter', async () => {
    const cache = fakeCache();
    for (const bad of ['relay:user_victim', '', 'a/b', 'x'.repeat(129), 'device id']) {
      expect(isMobileMeterDeviceId(bad)).toBe(false);
      expect(await admitMobileMeterBatch(cache, 'user_a', bad)).toMatchObject({ ok: false, status: 400 });
    }
    expect(cache.counts.size).toBe(0);
    // The app's own id shape is admitted.
    expect(isMobileMeterDeviceId(`device_${'0a'.repeat(16)}`)).toBe(true);
  });
});

describe('server.ts wires the phone routes to the wallet', () => {
  const server = readFileSync(join(__dirname, '..', '..', 'server.ts'), 'utf8');
  const route = (path: string): string => {
    const start = server.indexOf(`app.${path}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = server.indexOf('\napp.', start + 1);
    return server.slice(start, end);
  };

  test('the batch route admits through the wallet-keyed helper and binds the chain to the wallet', () => {
    const batch = route("post('/v1/meter/batch/mobile'");
    expect(batch).toContain('admitMobileMeterBatch(cache, userId, tokenDeviceId)');
    expect(batch).toContain('ownerBoundChain: true');
    expect(batch).not.toContain('rl:meterbatch:${tokenDeviceId}');
  });

  test('the tip and proofs reads refuse a chain whose tip names another wallet', () => {
    for (const path of ["get('/v1/meter/mobile/tip'", "get('/v1/meter/mobile/proofs'"]) {
      const handler = route(path);
      expect(handler).toContain('isMobileMeterDeviceId(deviceId)');
      expect(handler).toMatch(/actor_id !== userId/);
      expect(handler).toContain("'batch_device_not_owned'");
    }
  });
});
