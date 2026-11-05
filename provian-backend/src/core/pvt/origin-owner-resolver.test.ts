/**
 * origin-owner-resolver (, Prompt 3). Each resolvable scheme maps to a stable owner party;
 * private/hashed and lookup-needed schemes resolve to null. RED controls: subdomains of one holder
 * dedup to one owner (never inflate); a private tag is never resolvable.
 */

import { resolveOriginOwner, registrableDomain } from './origin-owner-resolver';

describe('resolveOriginOwner', () => {
  it('on-chain address -> that address (lowercased identifier as party)', () => {
    expect(resolveOriginOwner('evm:0xabc0000000000000000000000000000000000001'))
      .toEqual({ owner: 'evm:0xabc0000000000000000000000000000000000001', privateHashed: false });
  });

  it('domain -> the DNS holder, reduced to the registrable domain', () => {
    expect(resolveOriginOwner('domain:arxiv.org').owner).toBe('domain:arxiv.org');
    // RED control: subdomains of ONE holder must dedup to ONE owner, never inflate the count.
    expect(resolveOriginOwner('domain:export.arxiv.org').owner).toBe('domain:arxiv.org');
    expect(resolveOriginOwner('domain:www.bbc.co.uk').owner).toBe('domain:bbc.co.uk');
  });

  it('DOI -> its registrant (the prefix namespace)', () => {
    expect(resolveOriginOwner('doi:10.1145/3372297.3417231').owner).toBe('doi-registrant:10.1145');
  });

  it('public repo -> the repo owner (account path minus the repo name)', () => {
    expect(resolveOriginOwner('repo:torvalds/linux').owner).toBe('repo-owner:torvalds');
    expect(resolveOriginOwner('repo:github.com/torvalds/linux').owner).toBe('repo-owner:github.com/torvalds');
    expect(resolveOriginOwner('repo:torvalds/linux@v6.1').owner).toBe('repo-owner:torvalds');
    // a single segment cannot name an owner
    expect(resolveOriginOwner('repo:torvalds').owner).toBeNull();
  });

  it('private/hashed values are unresolvable BY CONSTRUCTION (independence unverifiable)', () => {
    for (const tag of ['private_file', 'private_url_path', 'private_pkg', 'private_project', 'private_host']) {
      expect(resolveOriginOwner(tag)).toEqual({ owner: null, privateHashed: true });
    }
    expect(resolveOriginOwner('private_anything_new').privateHashed).toBe(true);
  });

  it('lookup-needed schemes resolve to null (recorded, count zero until a resolver exists) — never guessed', () => {
    expect(resolveOriginOwner('commit:deadbeef00000000000000000000000000000000').owner).toBeNull();
    expect(resolveOriginOwner('pkg:npm/left-pad').owner).toBeNull();
    expect(resolveOriginOwner('someunknownscheme:xyz').owner).toBeNull();
    expect(resolveOriginOwner('').owner).toBeNull();
  });

  it('two origins of the SAME external party resolve to the SAME owner (the dedup key)', () => {
    expect(resolveOriginOwner('domain:arxiv.org').owner)
      .toBe(resolveOriginOwner('domain:arxiv.org').owner);
    // different parties -> different owners
    expect(resolveOriginOwner('domain:arxiv.org').owner)
      .not.toBe(resolveOriginOwner('domain:openai.com').owner);
  });
});

describe('registrableDomain', () => {
  it('reduces to eTLD+1, handling multi-label suffixes', () => {
    expect(registrableDomain('arxiv.org')).toBe('arxiv.org');
    expect(registrableDomain('export.arxiv.org')).toBe('arxiv.org');
    expect(registrableDomain('a.b.c.example.com')).toBe('example.com');
    expect(registrableDomain('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('foo.com.au')).toBe('foo.com.au');
  });
});
