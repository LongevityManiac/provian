/**
 * the relay's domain-requester key fetch obeys Security Invariant #6 (SSRF), with RED
 * controls: private / loopback / metadata resolutions are refused before any request, a non-DNS
 * "domain" (IP literal, localhost) is refused, a malformed or key-less document is refused, and a
 * good document is fetched once then served from the short cache.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { fetchRequesterKeysGuarded, clearRequesterKeyCache, REQUESTER_KEYS_TIMEOUT_MS, REQUESTER_KEYS_DNS_TIMEOUT_MS } from './requester-keys';

const DOC = Buffer.from(JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', kid: 'k1' }] }));

beforeEach(() => clearRequesterKeyCache());

describe('fetchRequesterKeysGuarded', () => {
  it('RED (round-robin fairness): a resolver that never answers is abandoned at the DNS deadline, before any request', async () => {
    let requested = false;
    const started = Date.now();
    await expect(fetchRequesterKeysGuarded('slow-dns.example.com', {
      resolveHostname: () => new Promise<string[]>(() => undefined),
      get: async () => { requested = true; return DOC; },
    })).rejects.toThrow(/timed out/);
    expect(requested).toBe(false);
    expect(Date.now() - started).toBeLessThan(REQUESTER_KEYS_DNS_TIMEOUT_MS + 1000);
  }, REQUESTER_KEYS_DNS_TIMEOUT_MS + 3000);

  it('RED (round-robin fairness): a key document that never finishes (a trickling server) is abandoned at the end-to-end deadline', async () => {
    const started = Date.now();
    await expect(fetchRequesterKeysGuarded('trickle.example.com', {
      resolveHostname: async () => ['93.184.216.34'],
      get: () => new Promise<Buffer | null>(() => undefined),
    })).rejects.toThrow(/unreachable/);
    expect(Date.now() - started).toBeLessThan(REQUESTER_KEYS_TIMEOUT_MS + 1500);
  }, REQUESTER_KEYS_TIMEOUT_MS + 4000);

  it('fetches https://<domain>/.well-known/provian-requester.json pinned to the validated public IP', async () => {
    const calls: Array<[string, string]> = [];
    const keys = await fetchRequesterKeysGuarded('gate.example.com', {
      resolveHostname: async () => ['93.184.216.34'],
      get: async (url, ip) => { calls.push([url, ip]); return DOC; },
    });
    expect(keys).toEqual([{ kty: 'OKP', crv: 'Ed25519', x: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', kid: 'k1' }]);
    expect(calls).toEqual([['https://gate.example.com/.well-known/provian-requester.json', '93.184.216.34']]);
  });

  it.each([
    ['loopback', '127.0.0.1'], ['RFC1918', '10.0.0.5'], ['link-local metadata', '169.254.169.254'], ['IPv6 ULA', 'fd00::1'], ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
  ])('RED: a domain resolving to a %s address is refused before any request', async (_label, ip) => {
    let requested = false;
    await expect(fetchRequesterKeysGuarded('gate.example.com', { resolveHostname: async () => ['93.184.216.34', ip], get: async () => { requested = true; return DOC; } })).rejects.toThrow(/private/);
    expect(requested).toBe(false);
  });

  it.each(['127.0.0.1', 'localhost', '[::1]', 'gate.example.com:8443', 'Gate.Example.com'])('RED: a non-DNS-hostname requester id %s is refused', async (id) => {
    await expect(fetchRequesterKeysGuarded(id, { resolveHostname: async () => ['93.184.216.34'], get: async () => DOC })).rejects.toThrow();
  });

  it('RED: an unreachable / non-2xx document, a non-JSON body and a key-less document are refused', async () => {
    const resolveHostname = async () => ['93.184.216.34'];
    await expect(fetchRequesterKeysGuarded('a.example.com', { resolveHostname, get: async () => null })).rejects.toThrow(/unreachable/);
    await expect(fetchRequesterKeysGuarded('b.example.com', { resolveHostname, get: async () => Buffer.from('<html>') })).rejects.toThrow(/JSON/);
    await expect(fetchRequesterKeysGuarded('c.example.com', { resolveHostname, get: async () => Buffer.from('{"keys":[{"kty":"RSA","kid":"k"}]}') })).rejects.toThrow(/no Ed25519/);
  });

  it('caches a good document per domain (one fetch for two reads inside the window)', async () => {
    let n = 0;
    const deps = { resolveHostname: async () => ['93.184.216.34'], get: async () => { n += 1; return DOC; }, nowMs: () => 1_000 };
    await fetchRequesterKeysGuarded('gate.example.com', deps);
    await fetchRequesterKeysGuarded('gate.example.com', deps);
    expect(n).toBe(1);
  });
});
