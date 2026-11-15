import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { protocolRpc } from './protocol-rpc';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const ok = (): Response => new Response(JSON.stringify({ result: '0x1' }));

it('works without AbortSignal.timeout and clears the deadline after a successful native read', async () => {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => { throw Error('unsupported native API'); });
  let signal: AbortSignal | null | undefined;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => { signal = init.signal; return ok(); });
  expect(await protocolRpc('https://native-timeout.example', fetcher).request('eth_chainId', [])).toBe('0x1');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(signal?.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('aborts a stalled native request at the deadline and leaves the lane usable', async () => {
  const fetcher = vi.fn((_url: string, init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(Error('aborted')));
  }));
  const rpc = protocolRpc('https://native-stalled.example', fetcher);
  const result = expect(rpc.request('eth_chainId', [])).rejects.toThrow('aborted');
  await vi.advanceTimersByTimeAsync(19_999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await result;
  expect(vi.getTimerCount()).toBe(0);
  fetcher.mockImplementation(async () => ok());
  expect(await rpc.request('eth_chainId', [])).toBe('0x1');
});

it('paces concurrent reads across factories while keeping independent providers independent', async () => {
  const starts: number[] = [];
  let active = 0, maximum = 0;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
    starts.push(Date.now()); maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 250));
    active--; return ok();
  });
  const a = protocolRpc('https://pace.example', fetcher);
  const b = protocolRpc('https://pace.example', fetcher);
  const other = vi.fn(async () => ok());
  const values = Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).request('eth_call', [i])));
  await protocolRpc('https://independent.example', other).request('eth_chainId', []);
  await vi.runAllTimersAsync();
  expect(await values).toHaveLength(40);
  expect(starts).toHaveLength(40);
  expect(starts.slice(1).every((at, i) => at - starts[i] >= 1_000)).toBe(true);
  expect(maximum).toBe(1);
  expect(other).toHaveBeenCalledTimes(1);
});

it.each(['2', new Date(102_000).toUTCString()])('honors Retry-After %s and retries the identical read', async header => {
  const times: number[] = [];
  const fetcher = vi.fn(async () => { times.push(Date.now()); return times.length === 1
    ? new Response('limited', { status: 429, headers: { 'retry-after': header } }) : ok(); });
  const result = protocolRpc(`https://retry-${encodeURIComponent(header)}.example`, fetcher).request('eth_getCode', ['0x123', 'latest']);
  await vi.runAllTimersAsync();
  expect(await result).toBe('0x1');
  expect(times).toEqual([100_000, 102_000]);
});

it('bounds repeated rate limits and allows a later independent read to recover', async () => {
  const fetcher = vi.fn(async () => new Response('limited', { status: 429 }));
  const rpc = protocolRpc('https://exhaust.example', fetcher);
  const result = expect(rpc.request('eth_chainId', [])).rejects.toThrow('protocol_rpc_unavailable');
  await vi.runAllTimersAsync(); await result;
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockImplementation(async () => ok());
  const recovered = rpc.request('eth_chainId', []);
  await vi.runAllTimersAsync(); expect(await recovered).toBe('0x1');
});

it.each(['60', 'invalid'])('refuses an unbounded or invalid Retry-After without an early retry: %s', async header => {
  const fetcher = vi.fn(async () => new Response('limited', { status: 429, headers: { 'retry-after': header } }));
  await expect(protocolRpc(`https://refuse-${header}.example`, fetcher).request('eth_call', [])).rejects.toThrow('protocol_rpc_unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not retry failures or interpret RPC errors as verified results', async () => {
  const denied = vi.fn(async () => new Response('denied', { status: 403 }));
  await expect(protocolRpc('https://denied.example', denied).request('eth_call', [])).rejects.toThrow('protocol_rpc_unavailable');
  expect(denied).toHaveBeenCalledTimes(1);
  const invalid = vi.fn(async () => new Response(JSON.stringify({ error: { code: -32000 }, result: '0x1' })));
  await expect(protocolRpc('https://invalid.example', invalid).request('eth_call', [])).rejects.toThrow('protocol_rpc_invalid');
  expect(invalid).toHaveBeenCalledTimes(1);
  const refused = vi.fn(async (): Promise<Response> => { throw new Error('egress_refused'); });
  await expect(protocolRpc('https://ssrf.example', refused).request('eth_call', [])).rejects.toThrow('egress_refused');
  expect(refused).toHaveBeenCalledTimes(1);
});

it('a long Retry-After also blocks already queued reads without issuing another fetch', async () => {
  const fetcher = vi.fn(async () => new Response('limited', { status: 429, headers: { 'retry-after': '60' } }));
  const rpc = protocolRpc('https://queued-cooldown.example', fetcher);
  const requests = Promise.allSettled([rpc.request('eth_call', []), rpc.request('eth_call', [])]);
  await vi.runAllTimersAsync();
  expect((await requests).map(r => r.status)).toEqual(['rejected', 'rejected']);
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockImplementation(async () => ok());
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await rpc.request('eth_call', [])).toBe('0x1');
});

it('retains the same deadline through response body consumption and clears it on rejection', async () => {
  let readBody = false;
  let aborted = false;
  const fetcher = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
    const response = new Response('{}');
    response.json = async () => {
      readBody = true;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { aborted = true; reject(Error('body aborted')); });
      });
    };
    return response;
  });
  const rpc = protocolRpc('https://body-timeout.example', fetcher);
  const request = rpc.request('eth_chainId', []);
  const refusal = expect(request).rejects.toThrow('body aborted');
  await vi.advanceTimersByTimeAsync(19_999);
  expect(readBody).toBe(true);
  expect(aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(aborted).toBe(true);
  await refusal;
  expect(vi.getTimerCount()).toBe(0);
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ result: '0x1' })));
  expect(await rpc.request('eth_chainId', [])).toBe('0x1');
});
