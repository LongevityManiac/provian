// The SDK's egress transport on every supported Node (2026-10-23, follow-up).
//
// The pinned dispatcher was a plain `undici@6` Agent. Node 26's built-in fetch (undici 8) hands a
// dispatcher a controller-style handler, which that Agent refuses (`UND_ERR_INVALID_ARG`, "invalid
// onError method"), so every SDK egress through the built-in fetch — or through a caller's own
// wrapper of it, like the paid payout verb's — failed on Node 26. The dispatcher is now a
// `PinnedAgent` (`pinned-agent.ts`), which takes both handler APIs.
//
// Two kinds of proof, both through a local forward proxy that records the CONNECT authority (a
// request that reached it went through the SDK's pinned connector, and the authority is the
// guard-approved IP, never the name):
//  - on ANY Node: the dispatcher each path hands its fetch is driven with a controller-style handler
//    (what Node 26's fetch sends). The old Agent throws "invalid onError method" here on Node 20 too;
//  - on the running Node: the real built-in fetch, default / injected / a delegating wrapper / a
//    runtime Request / the x402 payout verb, reaches the proxy. Run on Node 20 and Node 26.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent, type Dispatcher } from 'undici';
import { guardedFetch } from './guarded-fetch';
import { PinnedAgent, classicHandlerFor, parseRawHeaderPairs, type ControllerDispatchHandler } from './pinned-agent';
import { defaultActDeps } from './act-verbs';

// The payout verb's x402 fetch reads this machine's credentials; the test never uses real ones.
vi.mock('./scripts/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scripts/credentials')>()),
  loadCredentials: () => null,
}));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-transport-fixture-'));
const key = path.join(fixture, 'key.pem'), cert = path.join(fixture, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=seller.example', '-addext', 'subjectAltName=DNS:seller.example'], { stdio: 'ignore' });

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

/**
 * A forward proxy that records each CONNECT authority and pipes the tunnel to a local TLS service
 * presenting a self-signed `seller.example` certificate (the client must still verify it, so the
 * handshake ends in a certificate error — after the SNI shows which name the client asked for).
 */
async function proxyToTls() {
  const tunnels: string[] = [];
  const serverNames: string[] = [];
  const tls = https.createServer({
    key: fs.readFileSync(key), cert: fs.readFileSync(cert),
    SNICallback: (name, cb) => { serverNames.push(name); cb(null, undefined); },
  }, (_req, res) => res.end('reached'));
  const tlsPort = await listen(tls);
  const proxy = http.createServer();
  proxy.on('connect', (req, client) => {
    tunnels.push(req.url!);
    const upstream = net.connect(tlsPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${proxyPort}`); vi.stubEnv('https_proxy', '');
  vi.stubEnv('NO_PROXY', ''); vi.stubEnv('no_proxy', '');
  const close = async () => {
    tls.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(r => tls.close(r)), new Promise(r => proxy.close(r))]);
  };
  return { tunnels, serverNames, close };
}

const approve = async () => ['93.184.216.34'];
const WALLET = { privateKeyHex: '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d', address: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1' };

/** The paid payout verb's fetch exactly as `provian payout --yes` builds it (a wrapper of the global fetch). */
function payoutVerbFetch(): typeof fetch {
  return defaultActDeps().makeX402Fetch('https://api.provian.ai', WALLET, 1_000_000n, undefined, { onPaymentSent: () => undefined });
}

const PATHS: Array<[string, (url: string) => Promise<Response>]> = [
  ['no fetch injected', (url) => guardedFetch(url, undefined, { resolveHost: approve })],
  ['the built-in fetch injected', (url) => guardedFetch(url, undefined, { fetchFn: globalThis.fetch, resolveHost: approve })],
  ['a wrapper delegating to the global fetch', (url) => guardedFetch(url, undefined, { fetchFn: (i, n) => globalThis.fetch(i, n), resolveHost: approve })],
  ['a runtime Request as input', (url) => guardedFetch(new Request(url, { method: 'POST', body: 'x' }), undefined, { resolveHost: approve })],
  ['the x402 payout verb (its own wrapper of the global fetch)', (url) => payoutVerbFetch()(url)],
];

/** Drive `dispatcher` with a controller-style handler — the shape Node 26's built-in fetch sends. */
function dispatchLikeNode26(dispatcher: Dispatcher): Promise<{ threw: string | null; started: boolean; error: Error | null }> {
  return new Promise((resolve) => {
    let started = false;
    const handler: ControllerDispatchHandler = {
      onRequestStart: () => { started = true; },
      onResponseStart: () => resolve({ threw: null, started, error: null }),
      onResponseData: () => undefined,
      onResponseEnd: () => undefined,
      onResponseError: (_c, error) => resolve({ threw: null, started, error }),
    };
    try {
      dispatcher.dispatch({ origin: 'https://seller.example', path: '/probe', method: 'GET' }, handler as unknown as Dispatcher.DispatchHandlers);
    } catch (err) {
      resolve({ threw: (err as Error).message, started, error: null });
    }
  });
}

describe('every egress path hands its fetch a dispatcher Node 26\'s built-in fetch accepts (any Node)', () => {
  it.each(PATHS)('%s', async (_label, send) => {
    const box = await proxyToTls();
    const probes: Array<Awaited<ReturnType<typeof dispatchLikeNode26>>> = [];
    // The global fetch the path ends in: it records the dispatcher it was handed and drives it the
    // way Node 26's fetch does, before answering.
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      const dispatcher = (init as { dispatcher?: Dispatcher } | undefined)?.dispatcher;
      expect(dispatcher).toBeInstanceOf(PinnedAgent);
      probes.push(await dispatchLikeNode26(dispatcher!));
      return new Response('ok');
    });
    try {
      expect(await (await send('https://seller.example/resource')).text()).toBe('ok');
      expect(probes).toHaveLength(1);
      // Accepted (no "invalid onError method"), and it left through the pinned tunnel to the approved
      // IP, where the self-signed fixture certificate is refused — certificate checks stay on.
      expect(probes[0].threw).toBeNull();
      expect(probes[0].error).not.toBeNull();
      expect((probes[0].error as Error & { code?: string }).code).not.toBe('UND_ERR_INVALID_ARG');
      expect(box.tunnels).toEqual(['93.184.216.34:443']);
      expect(box.serverNames).toEqual(['seller.example']);
    } finally { await box.close(); }
  });

  it('RED — a plain undici@6 Agent refuses the same handler on this Node (the defect, reproduced)', async () => {
    const agent = new Agent();
    try { expect((await dispatchLikeNode26(agent)).threw).toMatch(/invalid onError method/); }
    finally { await agent.close(); }
  });
});

describe('guarded egress over the real built-in fetch (run on Node 20 and Node 26)', () => {
  it.each(PATHS)('%s: the request leaves through the pinned connector, CONNECT names the approved IP', async (_label, send) => {
    const box = await proxyToTls();
    try {
      // The self-signed fixture certificate is refused — certificate checks stay on.
      await expect(send('https://seller.example/resource')).rejects.toThrow();
      expect(box.tunnels).toEqual(['93.184.216.34:443']);
      expect(box.tunnels).not.toContain('seller.example:443');
      expect(box.serverNames).toEqual(['seller.example']);
    } finally { await box.close(); }
  });

  it('CONTROL: a private DNS answer is refused before anything leaves the machine', async () => {
    const box = await proxyToTls();
    try {
      for (const ip of ['10.0.0.5', '127.0.0.1', '169.254.169.254', 'fd00::1']) {
        await expect(guardedFetch('https://seller.example/', undefined, { resolveHost: async () => [ip] }))
          .rejects.toMatchObject({ code: 'EGRESS_SSRF_BLOCKED' });
        await expect(guardedFetch('https://seller.example/', undefined, { fetchFn: (i, n) => globalThis.fetch(i, n), resolveHost: async () => [ip] }))
          .rejects.toMatchObject({ code: 'EGRESS_SSRF_BLOCKED' });
      }
      await expect(guardedFetch('https://127.0.0.1/')).rejects.toMatchObject({ code: 'EGRESS_SSRF_BLOCKED' });
      expect(box.tunnels).toEqual([]);
    } finally { await box.close(); }
  });
});

describe('PinnedAgent', () => {
  it('passes a classic handler through untouched (Node 20–24 byte-for-byte as before) and bridges a controller one', () => {
    const seen: unknown[] = [];
    const spy = vi.spyOn(Agent.prototype, 'dispatch').mockImplementation((_o, h) => { seen.push(h); return true; });
    try {
      const pinned = new PinnedAgent();
      const classic: Dispatcher.DispatchHandlers = { onConnect: () => undefined, onError: () => undefined, onHeaders: () => true, onData: () => true, onComplete: () => undefined };
      pinned.dispatch({ origin: 'https://seller.example', path: '/', method: 'GET' }, classic);
      expect(seen[0]).toBe(classic);
      pinned.dispatch({ origin: 'https://seller.example', path: '/', method: 'GET' }, { onRequestStart: () => undefined } as unknown as Dispatcher.DispatchHandlers);
      expect(seen[1]).not.toBe(classic);
      expect(typeof (seen[1] as Dispatcher.DispatchHandlers).onError).toBe('function');
    } finally { spy.mockRestore(); }
  });

  it('maps the controller onto the classic callbacks: pause holds the read, resume releases it, abort reaches undici once', () => {
    const events: string[] = [];
    let ctl: Parameters<NonNullable<ControllerDispatchHandler['onRequestStart']>>[0] | null = null;
    const bridged = classicHandlerFor({
      onRequestStart: (c) => { ctl = c; events.push('start'); },
      onResponseStart: (c, status, headers) => { events.push(`headers:${status}:${headers['content-type']}`); c.pause(); },
      onResponseData: (_c, chunk) => events.push(`data:${chunk.toString()}`),
      onResponseEnd: (_c, trailers) => events.push(`end:${Object.keys(trailers).length}`),
      onResponseError: (_c, e) => events.push(`error:${e.message}`),
    });
    let resumed = 0, aborted = 0;
    bridged.onConnect!(() => { aborted++; });
    expect(bridged.onHeaders!(200, [Buffer.from('Content-Type'), Buffer.from('text/plain')], () => { resumed++; }, 'OK')).toBe(false);
    ctl!.resume();
    expect(resumed).toBe(1);
    expect(bridged.onData!(Buffer.from('hi'))).toBe(true);
    bridged.onComplete!(null);
    ctl!.abort(new Error('stop')); ctl!.abort(new Error('again'));
    expect(aborted).toBe(1);
    expect(ctl!.aborted).toBe(true);
    bridged.onError!(new Error('boom'));
    expect(events).toEqual(['start', 'headers:200:text/plain', 'data:hi', 'end:0', 'error:boom']);
  });

  it('RED — server header names cannot write through a prototype (__proto__, constructor), duplicates collect, latin1 decodes', () => {
    const parsed = parseRawHeaderPairs([
      Buffer.from('__proto__'), Buffer.from('polluted'),
      Buffer.from('constructor'), Buffer.from('x'),
      Buffer.from('Set-Cookie'), Buffer.from('a=1'), Buffer.from('set-cookie'), Buffer.from('b=2'),
      Buffer.from('X-Name'), Buffer.from([0xe9]),
    ]);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(parsed['__proto__']).toBe('polluted');
    expect(parsed.constructor).toBe('x');
    expect(parsed['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(parsed['x-name']).toBe('\u00e9');
    expect(parseRawHeaderPairs(null)).toEqual({});
  });
});
