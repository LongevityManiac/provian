// This forwarding fixture uses a synthetic loopback upstream. Production guard tests
// exercise private refusal separately; only this file's upstream is adapted for the fixture.
vi.mock('../../egress-guard', async importOriginal => {
  const actual = await importOriginal<typeof import('../../egress-guard')>();
  return { ...actual, validateEgressTarget: async (url: string) => url.startsWith('http://127.0.0.1:')
    ? { ok: true, hostname: '127.0.0.1', resolvedIps: ['127.0.0.1'] }
    : actual.validateEgressTarget(url) };
});
/**
 * a web page in a browser can never post to the daemon's loopback
 * listeners; any local process still can with no user step.
 *
 * Every refusal below is exercised against the REAL listener (a real socket, raw
 * headers via `http.request` so Host/Origin are exactly what we send), and each
 * refusal is paired with the legitimate local sender that must still get through
 * so a guard that refused everything fails as surely as one that refused nothing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { ProvianObserver } from '../ProvianObserver';
import type { ParsedOtlpSpan } from './OTelPlugin';
import { OTelPlugin } from './OTelPlugin';
import { ModelProxyPlugin } from './ModelProxyPlugin';
import { upstreamOverrideEnvVar } from './model-proxy/routing';
import {
  mimeEssence, isLoopbackHost, carriesBrowserMarkers, screenLoopbackRequest,
} from './loopback-guard';

const silentObserver = { log: () => {}, observerDeviceWitness: () => ({ type: 'observer_device', identity: 'dev_t', attestation_tier: 'software' }) } as unknown as ProvianObserver;

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: opts.path, method: opts.method ?? 'POST',
      headers: opts.headers ?? {}, setHost: !(opts.headers && 'host' in opts.headers),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(opts.body ?? '');
  });
}

/** A page on the open web that the user happens to have open. */
const PAGE_ORIGIN = 'https://evil.example';

// ---------------------------------------------------------------------------
// Pure screen
// ---------------------------------------------------------------------------

describe('loopback-guard — pure helpers', () => {
  it('mimeEssence parses type/subtype and drops parameters', () => {
    expect(mimeEssence('application/json')).toBe('application/json');
    expect(mimeEssence('Application/JSON; charset=utf-8')).toBe('application/json');
    expect(mimeEssence('text/plain; application/json')).toBe('text/plain');
    expect(mimeEssence('text/plain;application/json')).toBe('text/plain');
    expect(mimeEssence('application/json, text/plain')).toBeNull();
    expect(mimeEssence('application/json/x')).toBeNull();
    expect(mimeEssence('')).toBeNull();
    expect(mimeEssence(undefined)).toBeNull();
  });

  it('isLoopbackHost accepts exactly the three loopback spellings on the arrival port', () => {
    expect(isLoopbackHost('127.0.0.1:4319', 4319)).toBe(true);
    expect(isLoopbackHost('LOCALHOST:4319', 4319)).toBe(true);
    expect(isLoopbackHost('[::1]:4319', 4319)).toBe(true);
    // RED controls — rebinding hostnames, wrong port, no port, absent.
    expect(isLoopbackHost('evil.example:4319', 4319)).toBe(false);
    expect(isLoopbackHost('127.0.0.1.nip.io:4319', 4319)).toBe(false);
    expect(isLoopbackHost('127.0.0.1:4320', 4319)).toBe(false);
    expect(isLoopbackHost('127.0.0.1', 4319)).toBe(false);
    expect(isLoopbackHost(undefined, 4319)).toBe(false);
    expect(isLoopbackHost('127.0.0.1:4319', null)).toBe(false);
  });

  it("browser markers: Origin / Sec-Fetch-Site / -Dest / -User refused; Node fetch's lone sec-fetch-mode: cors admitted", () => {
    expect(carriesBrowserMarkers({ origin: 'null' })).toBe(true);
    expect(carriesBrowserMarkers({ 'sec-fetch-site': 'cross-site' })).toBe(true);
    expect(carriesBrowserMarkers({ 'sec-fetch-dest': 'empty' })).toBe(true);
    expect(carriesBrowserMarkers({ 'sec-fetch-user': '?1' })).toBe(true);
    expect(carriesBrowserMarkers({ 'sec-fetch-mode': 'no-cors' })).toBe(true);
    expect(carriesBrowserMarkers({ 'sec-fetch-mode': 'navigate' })).toBe(true);
    expect(carriesBrowserMarkers({ 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site' })).toBe(true);
    // Admitted: what curl / Python / Node http send (nothing), and undici fetch.
    expect(carriesBrowserMarkers({})).toBe(false);
    expect(carriesBrowserMarkers({ 'sec-fetch-mode': 'cors' })).toBe(false);
  });

  it('screenLoopbackRequest orders browser → host → media type', () => {
    const ok = { host: '127.0.0.1:1', 'content-type': 'application/json' };
    expect(screenLoopbackRequest({ headers: ok }, { port: 1, contentTypes: ['application/json'] })).toBeNull();
    expect(screenLoopbackRequest({ headers: { ...ok, origin: PAGE_ORIGIN } }, { port: 1 })?.status).toBe(403);
    expect(screenLoopbackRequest({ headers: { ...ok, host: 'evil:1' } }, { port: 1 })?.error).toBe('host_not_loopback');
    expect(screenLoopbackRequest({ headers: { ...ok, 'content-type': 'text/plain' } }, { port: 1, contentTypes: ['application/json'] })?.status).toBe(415);
  });
});

// ---------------------------------------------------------------------------
// OTLP receiver (4318) — its handler served on an ephemeral port
// ---------------------------------------------------------------------------

describe('OTelPlugin receiver — a browser page cannot feed spans; an OTLP exporter can', () => {
  let server: http.Server | null = null;
  afterEach(async () => { if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; } });

  const OTLP_JSON = JSON.stringify({
    resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{
      traceId: '0102030405060708090a0b0c0d0e0f10', spanId: '0102030405060708', name: 'tool.Read',
      startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000', attributes: [],
    }] }] }],
  });

  async function start(): Promise<{ port: number; ingested: number[] }> {
    const plugin = new OTelPlugin({ journalPath: null, forceActive: true });
    await plugin.init(silentObserver);
    const ingested: number[] = [];
    plugin.ingestParsedSpans = (spans: ParsedOtlpSpan[]) => { ingested.push(spans.length); };
    const handle = (plugin as unknown as { handle: (q: http.IncomingMessage, s: http.ServerResponse) => void }).handle.bind(plugin);
    const s = http.createServer(handle);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    server = s;
    return { port: (s.address() as AddressInfo).port, ingested };
  }

  it('RED — Origin → 403, spans never ingested', async () => {
    const { port, ingested } = await start();
    const r = await raw(port, { path: '/v1/traces', headers: { origin: PAGE_ORIGIN, 'content-type': 'application/json' }, body: OTLP_JSON });
    expect(r.status).toBe(403);
    expect(ingested).toEqual([]);
  });

  it('RED — Host rebinding → 403', async () => {
    const { port, ingested } = await start();
    const r = await raw(port, { path: '/v1/traces', headers: { host: `evil.example:${port}`, 'content-type': 'application/json' }, body: OTLP_JSON });
    expect(r.status).toBe(403);
    expect(ingested).toEqual([]);
  });

  it('RED — "text/plain; application/json" (old substring test admitted it) → 415', async () => {
    const { port, ingested } = await start();
    for (const ct of ['text/plain; application/json', 'text/plain', 'text/plain; x=application/x-protobuf']) {
      const r = await raw(port, { path: '/v1/traces', headers: { 'content-type': ct }, body: OTLP_JSON });
      expect(r.status, ct).toBe(415);
    }
    expect(ingested).toEqual([]);
  });

  it('GREEN — an OTLP/HTTP JSON exporter (no Origin, application/json) is 200 and ingested', async () => {
    const { port, ingested } = await start();
    const r = await raw(port, { path: '/v1/traces', headers: { 'content-type': 'application/json', 'user-agent': 'OTel-OTLP-Exporter-JavaScript/0.52.0' }, body: OTLP_JSON });
    expect(r.status).toBe(200);
    expect(ingested).toEqual([1]);
  });

  it('GREEN — an OTLP/HTTP protobuf exporter content type is still accepted (empty request decodes to zero spans)', async () => {
    const { port, ingested } = await start();
    const r = await raw(port, { path: '/v1/traces', headers: { 'content-type': 'application/x-protobuf', 'user-agent': 'OTel-OTLP-Exporter-Go/1.28.0' }, body: '' });
    expect(r.status).toBe(200);
    expect(ingested).toEqual([0]);
  });

  it("GREEN — a local Node exporter using the built-in fetch (it sends a lone sec-fetch-mode: cors) still posts", async () => {
    const { port, ingested } = await start();
    const r = await fetch(`http://127.0.0.1:${port}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: OTLP_JSON });
    expect(r.status).toBe(200);
    expect(ingested).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Model proxy (4320)
// ---------------------------------------------------------------------------

describe('ModelProxyPlugin — a browser page cannot drive the shim; a local CLI can', () => {
  let upstream: http.Server | null = null;
  let plugin: ModelProxyPlugin | null = null;
  const received: string[] = [];
  afterEach(async () => {
    if (plugin) { await plugin.stop(); plugin = null; }
    if (upstream) { await new Promise<void>((r) => upstream!.close(() => r())); upstream = null; }
    delete process.env[upstreamOverrideEnvVar('anthropic')];
    received.length = 0;
  });

  const CANNED = JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a' } }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  async function start(): Promise<{ p: ModelProxyPlugin; port: number }> {
    const up = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { received.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'application/json' }); res.end(CANNED); });
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
    upstream = up;
    process.env[upstreamOverrideEnvVar('anthropic')] = `http://127.0.0.1:${(up.address() as AddressInfo).port}`;
    const p = new ModelProxyPlugin({ port: 0 });
    await p.init(silentObserver);
    await p.start();
    plugin = p;
    return { p, port: p.boundPort()! };
  }

  const settle = () => new Promise((r) => setTimeout(r, 100));

  it('RED — Origin → 403: nothing forwarded upstream, no turn witnessed', async () => {
    const { p, port } = await start();
    const r = await raw(port, { path: '/anthropic/v1/messages', headers: { origin: PAGE_ORIGIN, 'content-type': 'text/plain' }, body: '{"model":"x","messages":[]}' });
    await settle();
    expect(r.status).toBe(403);
    expect(received).toEqual([]);
    expect(p.drainPEs()).toHaveLength(0);
  });

  it('RED — Host rebinding → 403: nothing forwarded', async () => {
    const { p, port } = await start();
    const r = await raw(port, { path: '/anthropic/v1/messages', headers: { host: `evil.example:${port}`, 'content-type': 'application/json' }, body: '{"model":"x","messages":[]}' });
    await settle();
    expect(r.status).toBe(403);
    expect(received).toEqual([]);
    expect(p.drainPEs()).toHaveLength(0);
  });

  it('GREEN — a local CLI (no Origin, Host 127.0.0.1:<port>) is forwarded and witnessed', async () => {
    const { p, port } = await start();
    const r = await raw(port, { path: '/anthropic/v1/messages', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: '{"model":"x","messages":[]}' });
    await settle();
    expect(r.status).toBe(200);
    expect(received).toEqual(['/v1/messages']);
    expect(p.drainPEs()).toEqual([]); // Unconfigured peers forward but cannot mint.
  });
});
