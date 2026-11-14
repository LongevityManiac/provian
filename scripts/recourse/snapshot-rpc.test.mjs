import { test, expect, vi } from 'vitest';
import { snapshotLogRangeRefusal, snapshotRpcPort } from './snapshot-cli.mjs';
import { guardedFetch } from '../../provian-agent-sdk/dist/guarded-fetch.js';
vi.mock('../../provian-agent-sdk/dist/guarded-fetch.js', () => ({ guardedFetch: vi.fn() }));

function stateReply(body) {return {status:200,ok:true,json:async()=>({result:body.method==='eth_chainId'?'0x2105':{number:body.params[0]==='finalized'?'0x30d40':body.params[0],hash:'0x'+'11'.repeat(32),parentHash:'0x'+'22'.repeat(32)}})};}

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
    const body = JSON.parse(options.body);
    if (body.method !== 'eth_getLogs') return stateReply(body);
    const count = seen.get(url) ?? 0;
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

test('custody topic filters survive provider range splitting and apply to both operators', async () => {
  vi.useFakeTimers();
  const calls = [], topics = ['0x' + '11'.repeat(32), null, ['0x' + '22'.repeat(32)]];
  vi.mocked(guardedFetch).mockImplementation(async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.method !== 'eth_getLogs') return stateReply(body);
    const filter = body.params[0]; calls.push({ url, filter });
    return filter.fromBlock !== filter.toBlock
      ? { status: 400, ok: false, json: async () => ({ error: { message: 'block range too large' } }) }
      : { status: 200, ok: true, json: async () => ({ result: [] }) };
  });
  try {
    const pending = snapshotRpcPort(['https://mainnet.base.org', 'https://base.drpc.org'])
      .logs('0x0000000000000000000000000000000000000001', 1, 2, topics);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual([]); expect(calls).toHaveLength(6);
    for (const call of calls) expect(call.filter.topics).toEqual(topics);
    expect(new Set(calls.map(call => call.url)).size).toBe(2);
    expect(calls.filter(call => call.filter.fromBlock === call.filter.toBlock)).toHaveLength(4);
  } finally { vi.useRealTimers(); vi.mocked(guardedFetch).mockReset(); }
});

test('production dRPC endpoint is recognized without counting its aliases as independent operators', () => {
  const drpc = 'https://lb.drpc.live';
  expect(snapshotRpcPort(['https://base-mainnet.g.alchemy.com/v2/test', drpc]).rpcs.map(r => r.operatorId))
    .toEqual(['alchemy', 'drpc']);
  expect(() => snapshotRpcPort(['https://base.drpc.org', drpc])).toThrow('snapshot_independent_operators_required');
  for (const unknown of ['https://lb.drpc.live.example.com', 'https://example.drpc.live']) {
    expect(() => snapshotRpcPort(['https://mainnet.base.org', unknown])).toThrow('snapshot_rpc_operator_unknown');
  }
});

test('explicit transaction absence is returned immediately; missing state and RPC errors still refuse', async () => {
  vi.useFakeTimers();
  try {
    for (const method of ['eth_getTransactionReceipt', 'eth_getTransactionByHash']) {
      vi.mocked(guardedFetch).mockReset().mockResolvedValue({ status: 200, ok: true, json: async () => ({ result: null }) });
      const pending = snapshotRpcPort(['https://mainnet.base.org', 'https://base.drpc.org']).rpcs[0].request(method, ['0x'+'11'.repeat(32)]);
      await vi.runAllTimersAsync(); expect(await pending).toBeNull(); expect(guardedFetch).toHaveBeenCalledTimes(1);
    }
    for (const [method, reply] of [
      ['eth_getTransactionReceipt', {}], ['eth_getTransactionByHash', {}],
      ['eth_getTransactionReceipt', { result: null, error: { code: -32000, message: 'unavailable' } }],
      ...['eth_call', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getLogs'].map(method => [method, { result: null }]),
    ]) {
      vi.mocked(guardedFetch).mockReset().mockResolvedValue({ status: 200, ok: true, json: async () => reply });
      const pending = snapshotRpcPort(['https://mainnet.base.org', 'https://base.drpc.org']).rpcs[0].request(method, []);
      const refused = expect(pending).rejects.toThrow('snapshot_rpc_unavailable');
      await vi.runAllTimersAsync(); await refused; expect(guardedFetch).toHaveBeenCalledTimes(8);
    }
  } finally { vi.useRealTimers(); vi.mocked(guardedFetch).mockReset(); }
});
