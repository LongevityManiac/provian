import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The box's DNS, per test. Default: none at all — every lookup fails the way getaddrinfo does in
// a proxy-only cell. `localAnswer` set: the box answers with those addresses (a fake-IP gateway
// answers 198.18.0.1 for every name).
const dnsState = vi.hoisted(() => ({ localAnswer: null as string[] | null }));
vi.mock('node:dns/promises', () => {
  const lookup = async () => {
    if (dnsState.localAnswer) return dnsState.localAnswer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
  };
  return { lookup, default: { lookup } };
});

import { DOH_RESOLVERS, clearDohCache, guardedFetch, isFakeIpAnswer, resolveViaDoh } from './guarded-fetch';
import { describeSetupFailure, proxyVarForRelay } from './setup-failure';
import { proxyUrlOf } from './pinned-connection';

// A proxy-only box (a hosted agent's runtime cell) has no DNS of its own. The guard must still
// resolve, check and pin the destination — so it asks DNS-over-HTTPS through the same proxy.
const TARGET = 'https://relay.doh-test.invalid/health';
const saved: Record<string, string | undefined> = {};
const KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

function dohAnswer(ip: string, type: 1 | 28 = 1): Response {
  return new Response(JSON.stringify({ Status: 0, Answer: [{ name: 'relay.doh-test.invalid', type: 5, data: 'cname.example.' }, { name: 'cname.example', type, data: ip }] }), { status: 200 });
}

function stub(answer: (url: string) => Response | Error) {
  const calls: string[] = [];
  const fetchFn = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    const out = answer(url);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof globalThis.fetch;
  return { calls, fetchFn };
}

beforeEach(() => { clearDohCache(); dnsState.localAnswer = null; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('guarded egress on a proxy-only box with no DNS', () => {
  it('resolves the destination over DNS-over-HTTPS through the proxy, then fetches it', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    const { calls, fetchFn } = stub((url) => url.startsWith(DOH_RESOLVERS[0]) ? dohAnswer('216.239.32.21') : new Response('ok', { status: 200 }));
    const res = await guardedFetch(TARGET, undefined, { fetchFn });
    expect(res.status).toBe(200);
    expect(calls[0]).toBe(`${DOH_RESOLVERS[0]}?name=relay.doh-test.invalid&type=A`);
    expect(calls.at(-1)).toBe(TARGET);
  });

  it('RED control: a resolver answer in a blocked range is refused and the destination is never fetched', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    for (const bad of ['10.0.0.5', '169.254.169.254', '100.64.1.1', '127.0.0.1']) {
      const { calls, fetchFn } = stub((url) => url.startsWith('https://1.1.1.1') ? dohAnswer(bad) : new Response('reached', { status: 200 }));
      await expect(guardedFetch(TARGET, undefined, { fetchFn })).rejects.toMatchObject({ code: 'EGRESS_SSRF_BLOCKED' });
      expect(calls).not.toContain(TARGET);
    }
  });

  it('falls back to the second resolver, and to AAAA', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    const { calls, fetchFn } = stub((url) => {
      if (url.startsWith(DOH_RESOLVERS[0])) return new Error('tunnel refused');
      if (url.startsWith(DOH_RESOLVERS[1]) && url.endsWith('type=A')) return new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 });
      if (url.startsWith(DOH_RESOLVERS[1])) return dohAnswer('2607:f8b0:4023:2801::79', 28);
      return new Response('ok', { status: 200 });
    });
    expect(await resolveViaDoh('relay.doh-test.invalid', fetchFn)).toEqual(['2607:f8b0:4023:2801::79']);
    expect(calls.filter(u => u.startsWith(DOH_RESOLVERS[1])).length).toBe(2);
  });

  it('refuses (unknown = block) when no resolver answers', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    const { calls, fetchFn } = stub((url) => url === TARGET ? new Response('reached') : new Response('nope', { status: 502 }));
    await expect(guardedFetch(TARGET, undefined, { fetchFn })).rejects.toMatchObject({ code: 'EGRESS_DNS_FAILED' });
    expect(calls).not.toContain(TARGET);
  });

  it('never asks a public resolver for a destination reached directly (no proxy)', async () => {
    const { calls, fetchFn } = stub(() => dohAnswer('216.239.32.21'));
    await expect(guardedFetch(TARGET, undefined, { fetchFn })).rejects.toMatchObject({ code: 'EGRESS_DNS_FAILED' });
    expect(calls).toEqual([]);
  });

  it('never asks a public resolver for a destination NO_PROXY sends direct', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    process.env.NO_PROXY = '.doh-test.invalid';
    const { calls, fetchFn } = stub(() => dohAnswer('216.239.32.21'));
    await expect(guardedFetch(TARGET, undefined, { fetchFn })).rejects.toMatchObject({ code: 'EGRESS_DNS_FAILED' });
    expect(calls).toEqual([]);
  });
});

// A fake-IP gateway (Grok Bot's box, 2026-10-20): every name resolves to 198.18.0.1 and the gateway
// carries the connection. The guard must check and pin the name's REAL addresses.
describe('guarded egress behind a fake-IP gateway', () => {
  it('a fake-IP answer is resolved over DNS-over-HTTPS and pinned to the real address (no proxy needed)', async () => {
    dnsState.localAnswer = ['198.18.0.1'];
    const { calls, fetchFn } = stub((url) => url.startsWith(DOH_RESOLVERS[0]) ? dohAnswer('216.239.32.21') : new Response('ok', { status: 200 }));
    const res = await guardedFetch(TARGET, undefined, { fetchFn });
    expect(res.status).toBe(200);
    expect(calls[0]).toBe(`${DOH_RESOLVERS[0]}?name=relay.doh-test.invalid&type=A`);
    expect(calls.at(-1)).toBe(TARGET);
  });

  it('RED control: a real answer in a blocked range is still refused behind a fake-IP gateway', async () => {
    dnsState.localAnswer = ['198.18.0.1'];
    const { calls, fetchFn } = stub((url) => url.startsWith('https://1.1.1.1') ? dohAnswer('10.1.2.3') : new Response('reached'));
    await expect(guardedFetch(TARGET, undefined, { fetchFn })).rejects.toMatchObject({ code: 'EGRESS_SSRF_BLOCKED' });
    expect(calls).not.toContain(TARGET);
  });

  it('RED control: no real answer behind a fake-IP gateway is refused, never pinned to 198.18', async () => {
    dnsState.localAnswer = ['198.18.0.1'];
    const { calls, fetchFn } = stub((url) => url === TARGET ? new Response('reached') : new Error('blocked'));
    await expect(guardedFetch(TARGET, undefined, { fetchFn })).rejects.toMatchObject({ code: 'EGRESS_DNS_FAILED' });
    expect(calls).not.toContain(TARGET);
  });

  it('a real local answer is used as-is — no public resolver is asked, and a blocked one still refuses', async () => {
    dnsState.localAnswer = ['216.239.32.21'];
    const ok = stub(() => new Response('ok', { status: 200 }));
    expect((await guardedFetch(TARGET, undefined, { fetchFn: ok.fetchFn })).status).toBe(200);
    expect(ok.calls).toEqual([TARGET]);

    dnsState.localAnswer = ['198.18.0.1', '10.0.0.9'];
    const mixed = stub(() => dohAnswer('216.239.32.21'));
    await expect(guardedFetch(TARGET, undefined, { fetchFn: mixed.fetchFn })).rejects.toMatchObject({ code: 'EGRESS_SSRF_BLOCKED' });
    expect(mixed.calls).toEqual([]);
  });

  it('isFakeIpAnswer: only an answer entirely inside 198.18.0.0/15', () => {
    expect(isFakeIpAnswer(['198.18.0.1'])).toBe(true);
    expect(isFakeIpAnswer(['198.19.255.4', '::ffff:198.18.0.7'])).toBe(true);
    expect(isFakeIpAnswer([])).toBe(false);
    expect(isFakeIpAnswer(['198.18.0.1', '216.239.32.21'])).toBe(false);
    expect(isFakeIpAnswer(['198.20.0.1'])).toBe(false);
    expect(isFakeIpAnswer(['10.0.0.1'])).toBe(false);
  });
});

describe('DNS-over-HTTPS answers are cached for their TTL (at most 5 minutes)', () => {
  it('a second fetch to the same name asks no resolver; the guard still checks the cached answer', async () => {
    dnsState.localAnswer = ['198.18.0.1'];
    const { calls, fetchFn } = stub((url) => url.startsWith(DOH_RESOLVERS[0]) ? new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '216.239.32.21', TTL: 300 }] })) : new Response('ok'));
    await guardedFetch(TARGET, undefined, { fetchFn });
    await guardedFetch(TARGET, undefined, { fetchFn });
    expect(calls.filter(u => u.startsWith('https://1.1.1.1')).length).toBe(1);
    expect(calls.filter(u => u === TARGET).length).toBe(2);
  });

  it('a zero-TTL answer is not cached', async () => {
    dnsState.localAnswer = ['198.18.0.1'];
    const { calls, fetchFn } = stub((url) => url.startsWith(DOH_RESOLVERS[0]) ? new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '216.239.32.21', TTL: 0 }] })) : new Response('ok'));
    await guardedFetch(TARGET, undefined, { fetchFn });
    await guardedFetch(TARGET, undefined, { fetchFn });
    expect(calls.filter(u => u.startsWith('https://1.1.1.1')).length).toBe(2);
  });
});

// : the installer's wording is bound to what the REAL guard + resolver produce,
// not to hand-copied strings — a reworded resolver note or a guard that drops it goes red here.
describe('installer wording from the real guard and resolver', () => {
  const ctx = { relayHost: 'relay.doh-test.invalid', retry: 'paste the command again' };
  const failureText = async (fetchFn: typeof globalThis.fetch, proxy?: string): Promise<string> => {
    const err = await guardedFetch(TARGET, undefined, { fetchFn }).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    return describeSetupFailure(err, { ...ctx, ...(proxy ? { proxy } : {}), proxyVar: proxyVarForRelay() }).lines.join('\n');
  };
  const deadResolvers = stub((url) => url === TARGET ? new Response('reached') : new Error('unreachable')).fetchFn;

  it('no proxy, no DNS: no DoH claimed; says set HTTPS_PROXY', async () => {
    const text = await failureText(deadResolvers);
    expect(text).toMatch(/no forward proxy is set/);
    expect(text).not.toMatch(/allow 1\.1\.1\.1|DNS-over-HTTPS lookup through/);
  });

  it('proxied, no DNS, DoH dead: names the DoH lookup through the proxy and the resolvers', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    const text = await failureText(deadResolvers, process.env.HTTPS_PROXY);
    expect(text).toMatch(/DNS-over-HTTPS lookup through your proxy \(127\.0\.0\.1:3128\) got no answer/);
    expect(text).toMatch(/allow 1\.1\.1\.1 and 8\.8\.8\.8/);
  });

  it('fake-IP gateway, DoH dead: names the gateway stand-in and the resolvers', async () => {
    dnsState.localAnswer = ['198.18.0.1'];
    const text = await failureText(deadResolvers);
    expect(text).toMatch(/gateway's stand-in address \(in 198\.18\.0\.0\/15\)/);
    expect(text).toMatch(/allow 1\.1\.1\.1 and 8\.8\.8\.8/);
  });

  it(' : only HTTP_PROXY set (an https request ignores it): says set HTTPS_PROXY, never NO_PROXY', async () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:3128';
    const text = await failureText(deadResolvers);
    expect(text).toMatch(/no forward proxy is set \(HTTPS_PROXY\)/);
    expect(text).not.toMatch(/NO_PROXY/);
  });

  it(' : a proxy written without a scheme is read as http://, as curl reads it', async () => {
    // (Proxy HOSTNAMES resolve through this test's no-DNS mock, so the full path is checked with an
    // IP proxy; proxyUrlOf below covers the hostname form.)
    for (const value of ['127.0.0.1:3128']) {
      process.env.HTTPS_PROXY = value;
      const { calls, fetchFn } = stub((url) => url.startsWith(DOH_RESOLVERS[0]) ? dohAnswer('216.239.32.21') : new Response('ok'));
      clearDohCache();
      expect((await guardedFetch(TARGET, undefined, { fetchFn })).status).toBe(200);
      expect(calls[0]).toContain('1.1.1.1');
    }
    expect(proxyUrlOf('proxy.local:3128')?.href).toBe('http://proxy.local:3128/');
    expect(proxyUrlOf('https://p:8443')?.protocol).toBe('https:');
    expect(proxyUrlOf('socks5://127.0.0.1:1080')).toBeNull();
    expect(proxyUrlOf('')).toBeNull();
  });

  it(' : a non-http proxy scheme says so, never that a DoH lookup failed', async () => {
    process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';
    const text = await failureText(deadResolvers, process.env.HTTPS_PROXY);
    expect(text).toMatch(/not an http:\/\/ or https:\/\/ proxy/);
    expect(text).toMatch(/Set HTTPS_PROXY to the proxy as http:\/\/host:port/);
    expect(text).not.toMatch(/got no answer either|allow 1\.1\.1\.1/);
  });

  it(' : a gateway stand-in answer with an unusable proxy names the stand-in, not "no answer"', async () => {
    dnsState.localAnswer = ['198.18.0.7'];
    process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';
    const text = await failureText(deadResolvers, process.env.HTTPS_PROXY);
    expect(text).toMatch(/stand-in address \(in 198\.18\.0\.0\/15\), and the proxy setting \(HTTPS_PROXY\) is not an http/);
    expect(text).not.toMatch(/gave no answer/);
  });

  it(' : advice names the lowercase variable when it is the one in effect', async () => {
    dnsState.localAnswer = ['198.18.0.7'];
    process.env.https_proxy = 'socks5://127.0.0.1:1080';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    const text = await failureText(deadResolvers, process.env.https_proxy);
    expect(text).toMatch(/proxy setting \(https_proxy\) is not an http/);
    expect(text).toMatch(/Set https_proxy to the proxy/);
    expect(text).not.toMatch(/Set HTTPS_PROXY/);

    dnsState.localAnswer = null;
    delete process.env.https_proxy;
    process.env.no_proxy = '*';
    const excluded = await failureText(deadResolvers, process.env.HTTPS_PROXY);
    expect(excluded).toMatch(/no_proxy sends relay\.doh-test\.invalid direct/);
    expect(excluded).toMatch(/out of no_proxy/);
  });

  it(' : real DNS with an unusable proxy says nothing was sent — never that the proxy refused', async () => {
    dnsState.localAnswer = ['216.239.32.21'];
    process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';
    const err = await guardedFetch(TARGET, undefined, { fetchFn: deadResolvers }).then(() => null, (e: unknown) => e);
    const f = describeSetupFailure(err, { ...ctx, proxy: process.env.HTTPS_PROXY, proxyVar: proxyVarForRelay() });
    expect(f.connection).toBe(false);
    expect(f.lines.join('\n')).toMatch(/proxy setting \(HTTPS_PROXY\) is not an http:\/\/ or https:\/\/ proxy, so nothing was sent/);
    expect(f.lines.join('\n')).not.toMatch(/refused or dropped|allow relay/);
  });

  it('a proxy set but NO_PROXY covering the host: names NO_PROXY, never "no proxy is set"', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    process.env.NO_PROXY = '*';
    const text = await failureText(deadResolvers, process.env.HTTPS_PROXY);
    expect(text).toMatch(/NO_PROXY sends relay\.doh-test\.invalid direct/);
    expect(text).toMatch(/out of NO_PROXY/);
    expect(text).not.toMatch(/no forward proxy is set/);
  });
});
