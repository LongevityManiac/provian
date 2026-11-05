import { describe, it, expect } from 'vitest';
import { validateEgressTarget, isSSRFTarget } from './egress-guard';

// A resolver that always returns whatever IPs we hand it (for DNS-rebinding tests).
const resolverReturning = (ips: string[]) => async () => ips;

describe('egress-guard SSRF enforcement (WS3)', () => {
  it('rejects a private/internal IPv4 target', async () => {
    const r = await validateEgressTarget('https://10.0.0.1/admin');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SSRF_BLOCKED');
  });

  it('rejects the cloud metadata endpoint', async () => {
    const r = await validateEgressTarget('https://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SSRF_BLOCKED');
  });

  it('rejects loopback (127.0.0.1) and IPv6 loopback', async () => {
    expect((await validateEgressTarget('https://127.0.0.1')).ok).toBe(false);
    expect((await validateEgressTarget('https://[::1]/')).ok).toBe(false);
  });

  it('rejects an IPv4-mapped IPv6 metadata address', async () => {
    const r = await validateEgressTarget('https://[::ffff:169.254.169.254]/');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SSRF_BLOCKED');
  });

  it('rejects a private IPv4 reached through NAT64, 6to4, an uncompressed mapped form, and IPv6 multicast (2026-10-17)', async () => {
    // RED control: NAT64 / 6to4 / multicast literals passed the guard before this.
    for (const host of ['[64:ff9b::7f00:1]', '[64:ff9b::a9fe:a9fe]', '[64:ff9b:1::a00:1]', '[2002:7f00:1::]', '[2002:a9fe:a9fe::]', '[0:0:0:0:0:ffff:7f00:1]', '[ff02::1]',
      // Reviewer 2026-10-17: the IPv4-translated form (SIIT) embeds the same private address.
      '[::ffff:0:7f00:1]', '[::ffff:0:a9fe:a9fe]']) {
      const r = await validateEgressTarget(`https://${host}/`);
      expect(r.ok, host).toBe(false);
      expect(r.code, host).toBe('SSRF_BLOCKED');
    }
    // A PUBLIC v4 behind NAT64 is a legitimate target on an IPv6-only network (DNS64).
    expect((await validateEgressTarget('https://[64:ff9b::5db8:d822]/')).code).not.toBe('SSRF_BLOCKED');
  });

  it('rejects a decimal-encoded loopback (127.0.0.1 = 2130706433)', async () => {
    const r = await validateEgressTarget('https://2130706433/');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SSRF_BLOCKED');
  });

  it('rejects non-HTTPS egress', async () => {
    const r = await validateEgressTarget('http://example.com');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('HTTPS_REQUIRED');
  });

  it('rejects credentials embedded in the URL', async () => {
    const r = await validateEgressTarget('https://user:pass@example.com', { resolveHost: resolverReturning(['93.184.216.34']) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CREDENTIALS_IN_URL');
  });

  it('rejects DNS rebinding: a public host that resolves to a private IP', async () => {
    const r = await validateEgressTarget('https://evil-but-public-looking.com', {
      resolveHost: resolverReturning(['127.0.0.1']),
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SSRF_BLOCKED');
    expect(r.reason).toContain('resolved to blocked IP');
  });

  it('accepts a public host that resolves to a public IP', async () => {
    const r = await validateEgressTarget('https://api.example.com/v1/data', {
      resolveHost: resolverReturning(['93.184.216.34']),
    });
    expect(r.ok).toBe(true);
    expect(r.hostname).toBe('api.example.com');
  });

  it('isSSRFTarget catches private-host rebinding patterns', () => {
    expect(isSSRFTarget('127.0.0.1.nip.io')).toBe(true);
    expect(isSSRFTarget('foo.internal')).toBe(true);
    expect(isSSRFTarget('api.example.com')).toBe(false);
  });
});
