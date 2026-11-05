import {
  resolvableOrigin, privateOrigin, urlOrigins, domainOf,
  chainWatcherWitness, forgeWebhookWitness, mergeInputOrigins,
  WITNESS_CHAIN_WATCHER, WITNESS_FORGE_WEBHOOK, PRIVATE_FILE, PRIVATE_URL_PATH,
} from './origin-capture';

describe('origin-capture (backend) — privacy classifier + witnesses (Prompt 2)', () => {
  it('resolvableOrigin keeps the identifier in the clear + hashes it', () => {
    const o = resolvableOrigin('evm:0xabc', chainWatcherWitness('eip155:8453'));
    expect(o.origin_identifier).toBe('evm:0xabc');
    expect(o.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(o.witnessed).toBe(true);
    expect(o.witness).toEqual({ type: WITNESS_CHAIN_WATCHER, identity: 'eip155:8453' });
  });

  it('privateOrigin exposes ONLY a type tag; the raw value is hash-only', () => {
    const o = privateOrigin(PRIVATE_FILE, '/srv/secret/app.ts');
    expect(o.origin_identifier).toBe(PRIVATE_FILE);
    expect(o.origin_identifier).not.toContain('secret');
    expect(o.origin_identifier).not.toContain('/');
    expect(o.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it(' RED: urlOrigins drops userinfo before hashing — same digest as the credential-free URL', () => {
    const withCreds = urlOrigins('https://bot:ghp_AbCdEfGhIjKlMnOpQrStUv@api.corp.test/v1/items', null);
    expect(withCreds).toEqual(urlOrigins('https://api.corp.test/v1/items', null));
    expect(JSON.stringify(withCreds)).not.toContain('ghp_');
  });

  it('urlOrigins: domain resolvable, path private, no plaintext path/query leak', () => {
    const os = urlOrigins('https://api.corp.test/v1/secret?token=zzz', forgeWebhookWitness('github_app'));
    expect(os[0].origin_identifier).toBe('domain:api.corp.test');
    expect(os[0].witness).toEqual({ type: WITNESS_FORGE_WEBHOOK, identity: 'github_app' });
    expect(os[1].origin_identifier).toBe(PRIVATE_URL_PATH);
    for (const o of os) {
      expect(o.origin_identifier).not.toContain('secret');
      expect(o.origin_identifier).not.toContain('zzz');
    }
  });

  it('domainOf rejects non-http(s)/garbage', () => {
    expect(domainOf('ssh://x')).toBeNull();
    expect(domainOf('https://ok.test/a')).toBe('ok.test');
  });

  describe('mergeInputOrigins (the takeover union)', () => {
    it('dedups by (id, hash), prefers witnessed-true, caps at 64', () => {
      const unwit = resolvableOrigin('commit:abc');
      const wit = resolvableOrigin('commit:abc', chainWatcherWitness('c'));
      const merged = mergeInputOrigins([unwit], [wit]);
      expect(merged).toHaveLength(1);
      expect(merged[0].witnessed).toBe(true);
      const a = Array.from({ length: 50 }, (_, i) => resolvableOrigin(`domain:a${i}.test`));
      const b = Array.from({ length: 50 }, (_, i) => resolvableOrigin(`domain:b${i}.test`));
      expect(mergeInputOrigins(a, b)).toHaveLength(64);
    });

    // RED: a union of a device PE's origins and a forge PE's origins keeps BOTH
    // kinds — so the mint-winner is never left with only one witness's origins.
    it('RED: unions device (private_file) + forge (repo/commit) origins, none dropped', () => {
      const device = [privateOrigin(PRIVATE_FILE, '/a/b.ts'), resolvableOrigin('commit:parent1')];
      const forge = [resolvableOrigin('repo:owner/name'), resolvableOrigin('commit:parent1')];
      const merged = mergeInputOrigins(device, forge);
      const ids = merged.map((o) => o.origin_identifier).sort();
      // commit:parent1 dedups to one; the rest survive.
      expect(ids).toEqual(['commit:parent1', 'private_file', 'repo:owner/name']);
    });

    it('handles null inputs', () => {
      expect(mergeInputOrigins(null, undefined)).toEqual([]);
    });
  });
});
