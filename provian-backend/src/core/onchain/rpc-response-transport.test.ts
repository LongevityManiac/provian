import http from 'http';
import dns from 'dns';
import { gzipSync } from 'zlib';
import { ethers } from 'ethers';
import { linearRpcGetUrl, publicRpcLookup } from './rpc-response-transport';

let server: http.Server, port: number;
beforeEach(async () => {
  server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port_missing'); port = address.port;
  const original = http.request;
  jest.spyOn(http, 'request').mockImplementation(((url: URL, options: http.RequestOptions) => {
    // Route only this test's socket to its loopback fixture; production has no bypass.
    expect(url.hostname).toBe('rpc.public.example');
    return original(new URL(`http://127.0.0.1:${port}/`), options);
  }) as typeof http.request);
});
afterEach(async () => { jest.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function request(timeout = 2_000): ethers.FetchRequest {
  const req = new ethers.FetchRequest('http://rpc.public.example/'); req.timeout = timeout; req.getUrlFunc = linearRpcGetUrl; return req;
}
it.each([false, true])('keeps exact fragmented bytes with gzip=%s', async gzip => {
  const expected = Buffer.from(JSON.stringify({ text: '東京 🦊', data: 'ab'.repeat(4 * 1024 * 1024) }));
  server.on('request', (_req, res) => {
    const body = gzip ? gzipSync(expected) : expected;
    if (gzip) res.setHeader('content-encoding', 'gzip');
    for (let offset = 0; offset < body.length; offset += 1024) res.write(body.subarray(offset, offset + 1024));
    res.end();
  });
  let copiedBytes = 0;
  const set = Uint8Array.prototype.set;
  const spy = jest.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (this: Uint8Array, source, offset) {
    copiedBytes += source.length; return set.call(this, source, offset);
  });
  const response = await request().send(); spy.mockRestore();
  expect(Buffer.from(response.body ?? []).equals(expected)).toBe(true);
  expect(copiedBytes).toBeLessThan(expected.length * 8);

});
it('retains FetchRequest throttle retry behavior', async () => {
  let calls = 0;
  server.on('request', (_req, res) => { calls++; res.statusCode = calls === 1 ? 429 : 200; res.setHeader('retry-after', '0'); res.end('ok'); });
  const req = request(); req.setThrottleParams({ maxAttempts: 2, slotInterval: 1 });
  expect((await req.send()).statusCode).toBe(200); expect(calls).toBe(2);
});
it('retains headers, method and request body', async () => {
  server.on('request', (req, res) => { const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
    expect(req.method).toBe('POST'); expect(req.headers.authorization).toBe('Bearer test'); expect(Buffer.concat(chunks).toString()).toBe('rpc-body'); res.end('ok');
  }); });
  const req = request(); req.setHeader('authorization', 'Bearer test'); req.body = 'rpc-body';
  expect((await req.send()).statusCode).toBe(200);
});
it('destroys an endlessly trickling response at the elapsed deadline', async () => {
  let closed = false, interval: NodeJS.Timeout | undefined;
  server.on('request', (_req, res) => { interval = setInterval(() => res.write('a'), 5); res.on('close', () => { closed = true; clearInterval(interval); }); });
  await expect(request(80).send()).rejects.toMatchObject({ code: 'TIMEOUT' });
  await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBe(true); clearInterval(interval);
});
it('destroys the response on explicit cancellation', async () => {
  let closed = false, cancel!: () => void;
  const started = new Promise<void>(resolve => { cancel = resolve; });
  server.on('request', (_req, res) => { res.write('body'); res.on('close', () => { closed = true; }); cancel(); });
  const req = request(), work = req.send(); await started; req.cancel();
  await expect(work).rejects.toMatchObject({ code: 'CANCELLED' });
  await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBe(true);
});
it('rejects truncated bodies and invalid gzip instead of returning partial facts', async () => {
  server.on('request', (_req, res) => { res.setHeader('content-encoding', 'gzip'); res.end('invalid'); });
  await expect(request().send()).rejects.toThrow();
});
it.each([301, 302, 307, 308])('refuses redirect %s before any second destination', async status => {
  let calls = 0; server.on('request', (_req, res) => { calls++; res.writeHead(status, { location: 'http://127.0.0.1/' }); res.end(); });
  await expect(request().send()).rejects.toThrow('rpc_redirect_refused'); expect(calls).toBe(1);
});
it.each(['127.0.0.1', '169.254.169.254', '[::1]', '[::ffff:127.0.0.1]'])('blocks literal private destination %s before socket creation', async host => {
  await expect(linearRpcGetUrl(new ethers.FetchRequest(`http://${host}/`))).rejects.toThrow('rpc_private_destination');
  expect(http.request).not.toHaveBeenCalled();
});
it('rejects mixed public/private DNS and pins the validated public response', async () => {
  const lookup = jest.spyOn(dns, 'lookup');
  lookup.mockImplementation(((_host: string, _options: unknown, callback: (error: Error | null, addresses: dns.LookupAddress[]) => void) => callback(null,
    [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])) as typeof dns.lookup);
  await expect(new Promise((resolve, reject) => publicRpcLookup('rpc.public.example', { all: true }, (error, address) => error ? reject(error) : resolve(address))))
    .rejects.toThrow('rpc_private_destination');
  lookup.mockImplementation(((_host: string, _options: unknown, callback: (error: Error | null, addresses: dns.LookupAddress[]) => void) => callback(null,
    [{ address: '8.8.8.8', family: 4 }])) as typeof dns.lookup);
  await expect(new Promise((resolve, reject) => publicRpcLookup('rpc.public.example', { all: true }, (error, address) => error ? reject(error) : resolve(address))))
    .resolves.toEqual([{ address: '8.8.8.8', family: 4 }]);
  expect(lookup).toHaveBeenCalledTimes(2);
});
