import { test, expect, vi } from 'vitest';
import { snapshotLogRangeRefusal, snapshotRpcPort } from './snapshot-cli.mjs';
import { guardedFetch } from '../../provian-agent-sdk/dist/guarded-fetch.js';
vi.mock('../../provian-agent-sdk/dist/guarded-fetch.js', () => ({ guardedFetch: vi.fn() }));

test('operator HTTP range refusals shrink while quotas and unrelated failures never fan out', () => {
  for (const status of [200, 400, 413]) for (const message of [
    'ranges over 10000 blocks are not supported on free plan',
    'Log response size exceeded', 'too many results', 'query exceeds maximum results',
  ]) expect(snapshotLogRangeRefusal('eth_getLogs', status, { message })).toBe(true);
  for (const [method, status, message] of [
    ['eth_getLogs', 429, 'block range too large'],
    ['eth_getLogs', 400, 'request limit reached'],
    ['eth_getLogs', 200, 'rate limit: reduce block range'],
    ['eth_getLogs', 500, 'internal error'],
    ['eth_call', 400, 'block range too large'],
  ]) expect(snapshotLogRangeRefusal(method, status, { message })).toBe(false);
  expect(snapshotLogRangeRefusal('eth_getLogs', 400, null)).toBe(false);
});

test('quota retries keep the original range and pace each independent operator', async () => {
  vi.useFakeTimers();
  const calls = [], seen = new Map();
  vi.mocked(guardedFetch).mockImplementation(async (url, options) => {
    const body = JSON.parse(options.body), count = seen.get(url) ?? 0;
    seen.set(url, count + 1); calls.push({ url, time: Date.now(), params: body.params });
    return count === 0
      ? { status: 429, ok: false, json: async () => ({ error: { code: 15, message: 'request limit' } }) }
      : { status: 200, ok: true, json: async () => ({ result: [] }) };
  });
  try {
    const port = snapshotRpcPort(['https://mainnet.base.org', 'https://base.drpc.org']);
    const pending = port.logs('0x0000000000000000000000000000000000000001', 1, 100_000);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual([]);
    expect(calls).toHaveLength(6);
    for (const url of seen.keys()) {
      const leg = calls.filter(call => call.url === url);
      expect(leg[2].params).toEqual(leg[0].params);
      expect(leg[2].time - leg[0].time).toBeGreaterThanOrEqual(5000);
      expect(leg[1].time - leg[0].time).toBeGreaterThanOrEqual(1100);
      expect(leg[2].time - leg[1].time).toBeGreaterThanOrEqual(1100);
    }
  } finally { vi.useRealTimers(); vi.mocked(guardedFetch).mockReset(); }
});
