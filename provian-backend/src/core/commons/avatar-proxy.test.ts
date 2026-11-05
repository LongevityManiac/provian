/**
 * F30 — the Commons avatar proxy is an outbound relay fetch, so it must obey the
 * SSRF rules (Security Invariant #6). RED controls: a non-https URL, and a
 * hostname that resolves (in whole or in part) to a private/internal address —
 * including the DNS-rebinding shape where the PUBLIC A record hides a private
 * AAAA record — MUST be refused (null), never fetched.
 */
import { describe, it, expect, afterEach, beforeAll } from '@jest/globals';
import https from 'https';
import type { AddressInfo } from 'net';
import {
  fetchProxiedAvatar,
  fetchAvatarCached,
  AVATAR_CACHE_MISS_TTL_S,
  AVATAR_CACHE_HIT_TTL_S,
  AVATAR_DEADLINE_MS,
  type FetchedAvatar,
} from './avatar-proxy';
import { isPrivateIp } from '../net/private-ip';
import { makeSelfSignedCert, loopbackAgent, type TestCert } from '../../__test-helpers__/tls-test-server';

describe('fetchProxiedAvatar SSRF guard (F30)', () => {
  it('RED: refuses a non-https URL', async () => {
    // Never resolves/fetches; the resolver would throw if consulted.
    const bomb = () => { throw new Error('resolver must not run for a non-https url'); };
    expect(await fetchProxiedAvatar('http://example.com/a.png', { resolveHostname: bomb })).toBeNull();
    expect(await fetchProxiedAvatar('ftp://example.com/a.png', { resolveHostname: bomb })).toBeNull();
    expect(await fetchProxiedAvatar('not a url', { resolveHostname: bomb })).toBeNull();
  });

  it('RED: refuses a hostname that resolves to a private/loopback/metadata IP', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.5', '::1', 'fd00::1']) {
      const r = await fetchProxiedAvatar('https://evil.example/pixel.png', { resolveHostname: async () => [ip] });
      expect(r).toBeNull();
    }
  });

  it('RED: refuses when ANY resolved address is private (public A hiding a private AAAA — rebinding)', async () => {
    const r = await fetchProxiedAvatar('https://rebind.example/pixel.png', {
      resolveHostname: async () => ['203.0.113.7', 'fd00::dead'], // one public, one ULA
    });
    expect(r).toBeNull();
  });

  it('RED: refuses an https IP-literal that is private', async () => {
    // net.isIP short-circuits DNS; the private literal must still be blocked.
    const bomb = () => { throw new Error('resolver must not run for an IP literal'); };
    expect(await fetchProxiedAvatar('https://10.0.0.9/a.png', { resolveHostname: bomb })).toBeNull();
    expect(await fetchProxiedAvatar('https://[::1]/a.png', { resolveHostname: bomb })).toBeNull();
  });

  it('refuses a host that resolves to nothing', async () => {
    expect(await fetchProxiedAvatar('https://nxdomain.example/a.png', { resolveHostname: async () => [] })).toBeNull();
  });

  // Guard-integrity control: the predicate the proxy depends on actually
  // distinguishes public from private (not hard-wired to always-block).
  it('the shared private-IP predicate admits a public address (guard is not vacuous)', () => {
    expect(isPrivateIp('203.0.113.7')).toBe(false);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
  });
});

/**
 * the avatar fetch runs under ONE wall-clock deadline across DNS +
 * connect + TLS + headers + body. Before, only the socket-IDLE `timeout: 5000`
 * bounded it, so a host trickling a byte every few seconds held the request (and
 * up to 2 MiB) for hours. These run the REAL production path — SSRF validation
 * against a public address, the pinned https.request, the size/type checks —
 * against a local TLS server reached through a loopback agent.
 */
describe('fetchProxiedAvatar wall-clock deadline ', () => {
  let cert: TestCert;
  const servers: https.Server[] = [];
  const timers: NodeJS.Timeout[] = [];
  const PUBLIC_IP = '203.0.113.9'; // passes the SSRF guard; the loopback agent dials 127.0.0.1

  beforeAll(() => {
    cert = makeSelfSignedCert(['avatar.test']);
  });

  afterEach(async () => {
    while (timers.length) clearInterval(timers.pop());
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
      s.closeAllConnections();
      s.close(() => resolve());
    })));
  });

  async function serveTls(handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void): Promise<number> {
    const server = https.createServer({ key: cert.key, cert: cert.cert }, handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  const deps = (deadlineMs: number) => ({
    resolveHostname: async () => [PUBLIC_IP],
    deadlineMs,
    agentForPinnedIp: (ip: string) => {
      // The seam receives the VALIDATED public address — the SSRF check ran first.
      expect(ip).toBe(PUBLIC_IP);
      return loopbackAgent(cert);
    },
  });

  it('control: a real image over the pinned TLS path is fetched (the seam is not vacuous)', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
    const port = await serveTls((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    });
    const r = await fetchProxiedAvatar(`https://avatar.test:${port}/a.png`, deps(3000));
    expect(r).not.toBeNull();
    expect(r!.contentType).toBe('image/png');
    expect(r!.body.equals(png)).toBe(true);
  });

  it('RED: a body trickled under the idle timeout is cut off at the wall-clock deadline', async () => {
    const port = await serveTls((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(Buffer.from([0x89]));
      timers.push(setInterval(() => res.write(Buffer.from([0x00])), 100)); // << 5 s idle timer
    });
    const started = Date.now();
    const outcome = await Promise.race([
      fetchProxiedAvatar(`https://avatar.test:${port}/a.png`, deps(600)).then((v) => ({ v })),
      new Promise<'still-open'>((resolve) => timers.push(setTimeout(() => resolve('still-open'), 3000))),
    ]);
    expect(outcome).toEqual({ v: null });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('RED: response headers trickled under the idle timeout are cut off at the deadline', async () => {
    const port = await serveTls((req) => {
      req.socket.write('HTTP/1.1 200 OK\r\n');
      timers.push(setInterval(() => req.socket.write('X-Pad: a\r\n'), 100));
    });
    const outcome = await Promise.race([
      fetchProxiedAvatar(`https://avatar.test:${port}/a.png`, deps(600)).then((v) => ({ v })),
      new Promise<'still-open'>((resolve) => timers.push(setTimeout(() => resolve('still-open'), 3000))),
    ]);
    expect(outcome).toEqual({ v: null });
  });

  it('RED: a DNS lookup that never answers is bounded by the deadline', async () => {
    const started = Date.now();
    const r = await fetchProxiedAvatar('https://slow-dns.example/a.png', {
      resolveHostname: () => new Promise<string[]>(() => undefined),
      deadlineMs: 300,
    });
    expect(r).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('the production deadline is a real wall-clock bound, shorter than a trickle could exploit', () => {
    expect(AVATAR_DEADLINE_MS).toBeGreaterThan(0);
    expect(AVATAR_DEADLINE_MS).toBeLessThanOrEqual(10_000);
  });
});

describe('fetchAvatarCached ', () => {
  function memCache() {
    const store = new Map<string, { value: unknown; ttl: number }>();
    return {
      store,
      get: async <T>(key: string): Promise<T | null> => (store.has(key) ? (store.get(key)!.value as T) : null),
      set: async (key: string, value: unknown, ttl: number): Promise<void> => { store.set(key, { value, ttl }); },
    };
  }

  it('RED: a failed fetch is remembered — a slow host is fetched once per window, not per request', async () => {
    const cache = memCache();
    let fetches = 0;
    const failing = async (): Promise<FetchedAvatar | null> => { fetches += 1; return null; };
    expect(await fetchAvatarCached(cache, 'w1', 'https://slow.example/a.png', failing)).toBeNull();
    expect(await fetchAvatarCached(cache, 'w1', 'https://slow.example/a.png', failing)).toBeNull();
    expect(await fetchAvatarCached(cache, 'w1', 'https://slow.example/a.png', failing)).toBeNull();
    expect(fetches).toBe(1);
    expect([...cache.store.values()][0].ttl).toBe(AVATAR_CACHE_MISS_TTL_S);
  });

  it('a success is served from cache; a changed avatar_url is fetched fresh', async () => {
    const cache = memCache();
    let fetches = 0;
    const ok = async (): Promise<FetchedAvatar | null> => {
      fetches += 1;
      return { contentType: 'image/png', body: Buffer.from([fetches]) };
    };
    const a = await fetchAvatarCached(cache, 'w1', 'https://h.example/a.png', ok);
    const b = await fetchAvatarCached(cache, 'w1', 'https://h.example/a.png', ok);
    expect(fetches).toBe(1);
    expect(b).toEqual(a);
    const c = await fetchAvatarCached(cache, 'w1', 'https://h.example/NEW.png', ok);
    expect(fetches).toBe(2);
    expect(c!.body.equals(Buffer.from([2]))).toBe(true);
    expect([...cache.store.values()].every((e) => e.ttl === AVATAR_CACHE_HIT_TTL_S)).toBe(true);
  });

  it('a cached entry with a disallowed content type is ignored (refetched), never served', async () => {
    const cache = memCache();
    let fetches = 0;
    const ok = async (): Promise<FetchedAvatar | null> => { fetches += 1; return { contentType: 'image/png', body: Buffer.from([1]) }; };
    await fetchAvatarCached(cache, 'w1', 'https://h.example/a.png', ok);
    const key = [...cache.store.keys()][0];
    cache.store.set(key, { value: JSON.stringify({ ok: true, ct: 'image/svg+xml', b64: 'PHN2Zz4=' }), ttl: 1 });
    const r = await fetchAvatarCached(cache, 'w1', 'https://h.example/a.png', ok);
    expect(fetches).toBe(2);
    expect(r!.contentType).toBe('image/png');
  });
});
