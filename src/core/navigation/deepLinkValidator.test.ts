import { describe, it, expect } from 'vitest';
import { deepLinkValidator, isPromiseImportLink } from './deepLinkValidator';

// C3: the validator is the trust boundary for the promise-import link. It must
// allow EXACTLY the promise-import host/path (https://provian.ai/p and the
// provian://promise fallback) and keep rejecting everything else — while still
// accepting the pre-existing provian:// invite links.

describe('deepLinkValidator — promise-import allowlist (C3)', () => {
  it('accepts the https universal promise link and surfaces d (query) + k (fragment)', () => {
    const parsed = deepLinkValidator('https://provian.ai/p?d=CIPHERTEXT#k=SECRETKEY');
    expect(parsed).not.toBeNull();
    expect(isPromiseImportLink(parsed!)).toBe(true);
    expect(parsed!.params.d).toBe('CIPHERTEXT');
    expect(parsed!.fragment).toBe('k=SECRETKEY');
  });

  it('accepts the provian://promise fallback', () => {
    const parsed = deepLinkValidator('provian://promise?d=CIPHERTEXT#k=SECRETKEY');
    expect(parsed).not.toBeNull();
    expect(isPromiseImportLink(parsed!)).toBe(true);
    expect(parsed!.params.d).toBe('CIPHERTEXT');
    expect(parsed!.fragment).toBe('k=SECRETKEY');
  });

  it('strips the fragment from rawUrl so logging cannot leak the key', () => {
    const parsed = deepLinkValidator('https://provian.ai/p?d=CT#k=SECRETKEY');
    expect(parsed!.rawUrl.includes('SECRETKEY')).toBe(false);
    expect(parsed!.rawUrl.includes('#')).toBe(false);
  });

  it('does NOT truncate a large ciphertext (raises the param cap for the import link)', () => {
    const bigD = 'A'.repeat(5000); // > the 2048 default cap
    const parsed = deepLinkValidator(`https://provian.ai/p?d=${bigD}#k=K`);
    expect(parsed!.params.d).toBe(bigD);
    expect(parsed!.params.d.length).toBe(5000);
  });

  it('parses the provian://promise host correctly (device-faithful, not via the broken RN URL)', () => {
    // RN's URL polyfill returns host="" for custom schemes; the hand parser must
    // surface host="promise" so the import branch is reached on device.
    const parsed = deepLinkValidator('provian://promise?d=CT#k=SECRETKEY');
    expect(parsed!.host).toBe('promise');
    expect(isPromiseImportLink(parsed!)).toBe(true);
  });

  it('does NOT corrupt the fallback ciphertext d with a stray "/" (RN URL polyfill bug)', () => {
    // The base64url alphabet includes - and _ but never / ; the RN URL polyfill
    // glued a "/" onto the query of a custom-scheme link with a fragment. The
    // hand parser must return d byte-exact.
    const d = 'AAbb_cc-DD1234';
    const parsed = deepLinkValidator(`provian://promise?d=${d}#k=KEYKEY`);
    expect(parsed!.params.d).toBe(d);
    expect(parsed!.params.d.includes('/')).toBe(false);
    expect(parsed!.fragment).toBe('k=KEYKEY');
  });

  it('rawUrl excludes BOTH the query (d) and the fragment (k)', () => {
    const parsed = deepLinkValidator('https://provian.ai/p?d=CIPHERTEXT#k=SECRETKEY');
    expect(parsed!.rawUrl).toBe('https://provian.ai/p');
    expect(parsed!.rawUrl.includes('CIPHERTEXT')).toBe(false);
    expect(parsed!.rawUrl.includes('SECRETKEY')).toBe(false);
  });

  it('strips userinfo so an @-host cannot impersonate provian.ai', () => {
    // host is the part AFTER the last '@'.
    expect(deepLinkValidator('https://provian.ai@evil.com/p?d=x#k=y')).toBeNull();
    const ok = deepLinkValidator('https://evil.com@provian.ai/p?d=x#k=y');
    expect(ok).not.toBeNull();
    expect(ok!.host).toBe('provian.ai');
  });

  it('ignores an explicit port on the import host', () => {
    const parsed = deepLinkValidator('https://provian.ai:443/p?d=x#k=y');
    expect(parsed).not.toBeNull();
    expect(parsed!.host).toBe('provian.ai');
  });

  it('rejects https on any other host', () => {
    expect(deepLinkValidator('https://evil.com/p?d=x#k=y')).toBeNull();
    expect(deepLinkValidator('https://provian.ai.evil.com/p?d=x#k=y')).toBeNull();
  });

  it('rejects https on any other path (strict /p only)', () => {
    expect(deepLinkValidator('https://provian.ai/promise?d=x#k=y')).toBeNull();
    expect(deepLinkValidator('https://provian.ai/p/extra?d=x#k=y')).toBeNull();
    expect(deepLinkValidator('https://provian.ai/?d=x#k=y')).toBeNull();
  });

  it('rejects non-https/non-provian schemes for the import host', () => {
    expect(deepLinkValidator('http://provian.ai/p?d=x#k=y')).toBeNull();
    expect(deepLinkValidator('ftp://provian.ai/p?d=x#k=y')).toBeNull();
  });

  it('rejects an unknown provian host', () => {
    expect(deepLinkValidator('provian://evil?d=x#k=y')).toBeNull();
  });
});

describe('deepLinkValidator — pre-existing behavior preserved', () => {
  it('still accepts the agent-link invite over the provian scheme', () => {
    const parsed = deepLinkValidator('provian://link?invite=abc&agent_wallet=0x123');
    expect(parsed).not.toBeNull();
    expect(parsed!.host).toBe('link');
    expect(parsed!.params.invite).toBe('abc');
    expect(parsed!.params.agent_wallet).toBe('0x123');
    expect(isPromiseImportLink(parsed!)).toBe(false);
  });

  it('still rejects a foreign scheme', () => {
    expect(deepLinkValidator('myapp://link?invite=abc')).toBeNull();
  });

  it('caps ordinary (non-import) params at the tight default', () => {
    const big = 'a'.repeat(5000);
    const parsed = deepLinkValidator(`provian://link?invite=${big}`);
    expect(parsed!.params.invite.length).toBe(2048);
  });
});

