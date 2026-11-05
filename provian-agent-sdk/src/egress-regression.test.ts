// Port of Codex's security-check-2026-10-10-evidence/egress-regression.test.ts.
// Synthetic credentials and loopback TLS/HTTP only; certificate and hostname checks stay enabled.
//
// No live DNS (2026-10-22). Every name this suite touches is answered by an injected resolver
// (the guard's `resolveHost` seam, or the fixture transport's socket `lookup`); the tripwire below
// records any lookup through `node:dns/promises` (the guard's default resolver, the egress
// resolver, the proxy resolver) and the suite fails if one happened. The fixture transport uses
// the `undici` package's own `fetch` with its own `Agent`. Node's built-in fetch is a different
// undici (Node 26 bundles undici 8): it refuses this package's Agent (`UND_ERR_INVALID_ARG`,
// "invalid onError method", surfacing as "fetch failed") and does not read the global dispatcher
// this package sets, so the fixture's socket mapping never applied and the name went to the
// system resolver (`getaddrinfo ENOTFOUND seller.example`). Node 20's built-in undici is the
// same major as this package, which is why the suite passed there.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent, fetch as undiciFetch, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { ProvianClient } from './ProvianClient';
import { validateEgressTarget } from './egress-guard';
import { createRequesterKeyFetcher } from './challenge';
import { defaultActDeps, runActVerbCli } from './act-verbs';
import { requestLink } from './request-link';
import { getErc20Balance } from './x402-signer';

const liveDnsLookups = vi.hoisted(() => [] as string[]);
vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>();
  const lookup = async (hostname: string) => { liveDnsLookups.push(hostname); throw Object.assign(new Error(`live DNS lookup in egress-regression suite: ${hostname}`), { code: 'ENOTFOUND' }); };
  return { ...real, default: { ...real, lookup }, lookup };
});
afterAll(() => expect(liveDnsLookups, 'the suite made a live DNS lookup').toEqual([]));

/** The `undici` package's fetch, typed as the global one (both speak WHATWG Request/Response). */
const packageFetch = undiciFetch as unknown as typeof fetch;

const wallet = { privateKeyHex: '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d', address: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1' };
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-egress-fixture-'));
const fixtureKey = path.join(fixture, 'key.pem'), fixtureCertificate = path.join(fixture, 'cert.pem');
beforeAll(() => execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', fixtureKey, '-out', fixtureCertificate, '-days', '1', '-subj', '/CN=seller.example', '-addext', 'subjectAltName=DNS:seller.example'], { stdio: 'ignore' }));
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true }));
async function listen(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function close(server: http.Server | https.Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
function tlsServer(handler: http.RequestListener) { return https.createServer({ key: fs.readFileSync(fixtureKey), cert: fs.readFileSync(fixtureCertificate) }, handler); }
function localTransport() {
  // Fixture adapter maps synthetic public seller.example to the local test service.
  // DNS-pinning regression below uses the real SDK transport, never this adapter.
  const dispatcher = new Agent({ connect: { ca: fs.readFileSync(fixtureCertificate), lookup: (_host, opts, cb) => {
    if (opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]); else cb(null, '127.0.0.1', 4);
  } } });
  const fetchFn: typeof fetch = (url, init) => packageFetch(url, { ...init, dispatcher } as RequestInit);
  return { dispatcher, fetchFn };
}
function paying(fetchFn?: typeof fetch, timeout = 1000, maxResponseBytes = 1024 * 1024) {
  return new ProvianClient({ relayUrl: 'https://relay.example' }).wrapFetchWithX402(wallet, { maxAmountAtomic: 10000n, fetchFn, requestTimeoutMs: timeout, maxResponseBytes, resolveHost: async () => ['93.184.216.34'] });
}
async function cliFetch(url: string, fetchFn: typeof fetch, timeout = 1000) {
  const lines: string[] = [];
  const deps = { ...defaultActDeps(),
    loadAgent: () => ({ walletId: 'wallet_aw_fixture', address: wallet.address, apiKey: 'pvn_live_fixture', apiSecret: 'pvns_fixture', config: { relayUrl: 'https://relay.example', walletId: 'wallet_aw_fixture', apiKey: 'pvn_live_fixture', apiSecret: 'pvns_fixture' }, withKey: async <T>(fn: (key: string) => Promise<T>) => fn(wallet.privateKeyHex) }),
    validateEgress: (target: string) => validateEgressTarget(target, { resolveHost: async () => ['93.184.216.34'] }),
    makeX402Fetch: () => paying(fetchFn, timeout),
  };
  const code = await runActVerbCli('x402-fetch', [url, '--max-usdc', '0.01'], deps, { stdout: line => { lines.push(line); } });
  return { code, output: JSON.parse(lines.join('\n')) };
}
const required = { x402Version: 2, resource: { url: 'https://seller.example/resource' }, accepted: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', maxTimeoutSeconds: 120 }] };

describe('security regressions (Codex 2026-10-10)', () => {
  it.each([NaN, Infinity, 0, -1])('invalid response limits are refused before any request (%s)', limit => {
    expect(() => paying(undefined, limit)).toThrow('invalid x402 response deadline');
    expect(() => paying(undefined, 1000, limit)).toThrow('invalid x402 response byte cap');
  });
  it('CONTROL: private literals and private DNS answers are refused', async () => {
    expect((await validateEgressTarget('https://127.0.0.1/')).ok).toBe(false);
    expect((await validateEgressTarget('https://seller.example/', { resolveHost: async () => ['127.0.0.1'] })).ok).toBe(false);
  });
  it('supported native fetch overrides cannot bypass the helper or balance-read guard', async () => {
    let hits = 0;
    const privateService = http.createServer((_req, res) => { hits++; res.end('{"result":"0x0","link_status":"pending"}'); });
    const port = await listen(privateService), url = `http://127.0.0.1:${port}`;
    try {
      expect((await fetch(url)).ok).toBe(true); expect(hits).toBe(1); hits = 0;
      const linked = await requestLink({relayUrl:url,walletId:'wallet_aw_fixture',connectionToken:'PROV-ABCDEFGHIJ',apiKey:'pvn_live_fixture',apiSecret:'pvns_fixture',fetchImpl:globalThis.fetch});
      expect(linked.ok).toBe(false);
      await expect(getErc20Balance(url,'0x'+'1'.repeat(40),wallet.address,globalThis.fetch)).rejects.toThrow('egress refused');
      expect(hits).toBe(0);
    } finally { await close(privateService); }
  });
  it('initial x402 request refuses the seller redirect; the CLI never reaches the private HTTP destination', async () => {
    let hits = 0;
    const privateServer = http.createServer((_req, res) => { hits++; res.end('private fixture'); });
    const privatePort = await listen(privateServer);
    const seller = tlsServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${privatePort}/private` }); res.end(); });
    const port = await listen(seller), transport = localTransport();
    try { expect((await cliFetch(`https://seller.example:${port}/resource`, transport.fetchFn)).code).not.toBe(0); expect(hits).toBe(0); }
    finally { await transport.dispatcher.close(); await close(seller); await close(privateServer); }
  });
  it('guard-approved DNS is bound to the SDK socket; a later private DNS answer cannot connect', async () => {
    let hits = 0;
    const service = tlsServer((_req, res) => { hits++; res.end('private fixture'); });
    const port = await listen(service), transport = localTransport();
    const url = `https://seller.example:${port}/resource`;
    try {
      // RED: a fetch on the ambient dispatcher, whose DNS answer is private, reaches the private TLS fixture.
      const ambient = getGlobalDispatcher();
      setGlobalDispatcher(transport.dispatcher);
      try {
      expect(await (await packageFetch(url)).text()).toBe('private fixture'); expect(hits).toBe(1); hits = 0;
      expect((await validateEgressTarget(url, { resolveHost: async () => ['93.184.216.34'] })).resolvedIps).toEqual(['93.184.216.34']);
      // The SDK connection instead attempts that public address, never the private fixture: the
      // SDK's pinned dispatcher replaces the ambient one. Driven through the same `undici` fetch
      // (no dispatcher of its own), so a pinned dispatcher dropped from the SDK would fall back to
      // the ambient fixture dispatcher and the hit below would count.
      await expect(paying(packageFetch, 80)(url)).rejects.toThrow(); expect(hits).toBe(0);
      } finally { setGlobalDispatcher(ambient); }
    } finally { await transport.dispatcher.close(); await close(service); }
  });
  it.each([async () => [], async () => { throw new Error('DNS unavailable'); }])('failed/empty DNS blocks requester-key reads before any HTTP request', async resolveHost => {
    let fetches = 0;
    const f = createRequesterKeyFetcher({ resolveHost, fetchFn: async () => { fetches++; return new Response('{"keys":[]}'); } });
    expect((await validateEgressTarget('https://seller.example/', { resolveHost })).ok).toBe(false);
    await expect(f('seller.example')).rejects.toThrow(); expect(fetches).toBe(0);
  });
  it.each(['initial', '402', 'paid'] as const)('%s response retains the deadline through a slow body', async stage => {
    const service = tlsServer((req, res) => {
      if (stage === 'paid' && !req.headers['payment-signature']) { res.writeHead(402); res.end(JSON.stringify(required)); return; }
      res.writeHead(stage === '402' ? 402 : 200); res.flushHeaders(); res.write('a');
      setTimeout(() => res.end('b'.repeat(256 * 1024)), 250);
    });
    const port = await listen(service), transport = localTransport();
    try { await expect(paying(transport.fetchFn, 80)(`https://seller.example:${port}/slow`)).rejects.toThrow(/timed out/); }
    finally { await transport.dispatcher.close(); await close(service); }
  });
  it.each(['initial', '402', 'paid'] as const)('%s response is aborted at the byte cap', async stage => {
    const service = tlsServer((req, res) => {
      if (stage === 'paid' && !req.headers['payment-signature']) { res.writeHead(402); res.end(JSON.stringify(required)); return; }
      res.writeHead(stage === '402' ? 402 : 200); res.end('b'.repeat(65537));
    });
    const port = await listen(service), transport = localTransport();
    try { await expect(paying(transport.fetchFn, 1000, 65536)(`https://seller.example:${port}/big`)).rejects.toThrow(/exceeds 65536 bytes/); }
    finally { await transport.dispatcher.close(); await close(service); }
  });
  it('CONTROL: slow headers still time out', async () => {
    const service = tlsServer((_req, res) => { setTimeout(() => res.end('late'), 250); });
    const port = await listen(service), transport = localTransport();
    try { await expect(paying(transport.fetchFn, 80)(`https://seller.example:${port}/slow-headers`)).rejects.toThrow(/timed out/); }
    finally { await transport.dispatcher.close(); await close(service); }
  });
});
