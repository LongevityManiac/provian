import { describe, expect, it } from 'vitest';
import { ConnectionError } from './errors';
import { EgressRefusedError } from './guarded-fetch';
import { describeSetupFailure } from './setup-failure';

const ctx = { relayHost: 'api.provian.ai', retry: 'paste the command again' };
const wrap = (cause: unknown) => new ConnectionError('Failed to reach relay: egress refused', { cause });
const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('describeSetupFailure — the actual reason, connection advice only for connection faults', () => {
  it('egress guard, no address, behind a proxy: names the proxy and DoH, never the proxy credentials', () => {
    const f = describeSetupFailure(wrap(new EgressRefusedError('DNS_FAILED', "No valid DNS addresses for api.provian.ai (no answer from this machine's DNS; the DNS-over-HTTPS lookup through the proxy (1.1.1.1, 8.8.8.8) got no answer)")),
      { ...ctx, proxy: 'http://user:s3cret@proxy.local:3128' });
    expect(f.kind).toBe('egress_dns');
    expect(f.connection).toBe(true);
    expect(f.lines.join('\n')).toMatch(/DNS-over-HTTPS lookup through your proxy \(proxy\.local:3128\)/);
    expect(f.lines.join('\n')).toMatch(/allow 1\.1\.1\.1 and 8\.8\.8\.8/);
    expect(f.lines.join('\n')).not.toMatch(/s3cret|user:/);
  });

  it('egress guard, gateway stand-in answer: names the gateway case and the resolvers', () => {
    const f = describeSetupFailure(wrap(new EgressRefusedError('DNS_FAILED', "No valid DNS addresses for api.provian.ai (this machine's DNS gave only a gateway stand-in address (198.18.0.0/15); the DNS-over-HTTPS lookup (1.1.1.1, 8.8.8.8) got no answer)")), ctx);
    expect(f.lines.join('\n')).toMatch(/198\.18\.0\.0\/15/);
    expect(f.lines.join('\n')).toMatch(/allow 1\.1\.1\.1 and 8\.8\.8\.8/);
  });

  it('RED control ( ): no DNS and no proxy never claims a DoH lookup or asks to allow the resolvers', () => {
    const f = describeSetupFailure(wrap(new EgressRefusedError('DNS_FAILED', "No valid DNS addresses for api.provian.ai (no answer from this machine's DNS; no proxy set, so no DNS-over-HTTPS lookup was tried)")), ctx);
    const text = f.lines.join('\n');
    expect(text).toMatch(/no forward proxy is set/);
    expect(text).toMatch(/set HTTPS_PROXY/);
    expect(text).not.toMatch(/got no answer either|allow 1\.1\.1\.1/);
  });

  it('egress guard refused a substitute address', () => {
    const f = describeSetupFailure(wrap(new EgressRefusedError('SSRF_BLOCKED', 'Host api.provian.ai resolved to blocked IP 198.18.0.4')), ctx);
    expect(f.kind).toBe('egress_blocked');
    expect(f.lines.join('\n')).toMatch(/198\.18\.0\.4/);
  });

  it('an untrusted certificate (TLS-inspecting network) points at NODE_EXTRA_CA_CERTS', () => {
    const f = describeSetupFailure(wrap(coded('self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN')), ctx);
    expect(f.kind).toBe('tls');
    expect(f.lines.join('\n')).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  it('a refused proxy tunnel', () => {
    const f = describeSetupFailure(wrap(new Error('egress proxy tunnel refused')), { ...ctx, proxy: 'http://proxy:8080' });
    expect(f.kind).toBe('proxy');
    expect(f.lines[0]).toMatch(/proxy at proxy:8080/);
  });

  it('a relay HTTP error is not a connection fault and quotes the relay', () => {
    const f = describeSetupFailure(coded('Challenge service unavailable. Try again shortly.', 'HTTP_503'), ctx);
    expect(f.kind).toBe('relay_http');
    expect(f.connection).toBe(false);
    expect(f.lines.join('\n')).toMatch(/HTTP 503: Challenge service unavailable/);
    expect(f.lines.join('\n')).toMatch(/Provian's side/);
    expect(f.lines.join('\n')).not.toMatch(/internet connection|could not (reach|connect)/);
  });

  it('RED control: a local fault is never a connection message', () => {
    const f = describeSetupFailure(new Error('Pending agent wallet registration does not match this agent/config; refusing to create a second identity'), ctx);
    expect(f.kind).toBe('local');
    expect(f.connection).toBe(false);
    expect(f.lines.join('\n')).not.toMatch(/internet connection|could not (reach|connect)/);
  });

  it('masks long hex runs (keys, registration ids)', () => {
    const f = describeSetupFailure(new Error(`bad key ${'ab'.repeat(32)}`), ctx);
    expect(f.lines.join('\n')).toMatch(/\[hidden\]/);
    expect(f.lines.join('\n')).not.toMatch(/abababab/);
  });
});
