/** Trust Layer build §2.11 — `pkg:` owner resolution via the npm registry (fail-closed, cached). */
import { parseNpmCoordinate, lookupNpmPublisher, resolvePkgOwners, npmOwner } from './pkg-owner-resolver';
import type { InputOrigin } from '../provenance/input-origins';

const origin = (id: string): InputOrigin => ({ hash: 'sha256:x', origin_identifier: id, witnessed: false });

function fakeRegistry(doc: unknown, ok = true) {
  const calls: string[] = [];
  const fetcher = async (url: string) => { calls.push(url); return { ok, json: async () => doc }; };
  return { fetcher, calls };
}

describe('parseNpmCoordinate', () => {
  it('accepts the SDK forms pkg:npm:<name>@<ver>, pkg:npm/<name>, npm:<name> (scoped too)', () => {
    expect(parseNpmCoordinate('pkg:npm:@scope/lib@1.2.3')).toEqual({ name: '@scope/lib', version: '1.2.3' });
    expect(parseNpmCoordinate('pkg:npm/left-pad')).toEqual({ name: 'left-pad', version: null });
    expect(parseNpmCoordinate('npm:express@4.19.2')).toEqual({ name: 'express', version: '4.19.2' });
  });
  it('RED — any other scheme is not a package coordinate', () => {
    expect(parseNpmCoordinate('pkg:pypi:requests')).toBeNull();
    expect(parseNpmCoordinate('evm:0xabc')).toBeNull();
    expect(parseNpmCoordinate('pkg:npm:')).toBeNull();
  });
});

describe('lookupNpmPublisher', () => {
  it('owner = the cited version\'s publisher (`_npmUser.name`) as npm-user:<login>', async () => {
    const { fetcher, calls } = fakeRegistry({
      'dist-tags': { latest: '2.0.0' },
      versions: { '1.2.3': { _npmUser: { name: 'Alice' } }, '2.0.0': { _npmUser: { name: 'bob' } } },
      maintainers: [{ name: 'carol' }],
    });
    expect(await lookupNpmPublisher({ name: '@scope/lib', version: '1.2.3' }, fetcher)).toBe(npmOwner('alice'));
    expect(calls[0]).toBe('https://registry.npmjs.org/@scope%2Flib');
    expect(await lookupNpmPublisher({ name: '@scope/lib', version: null }, fetcher)).toBe('npm-user:bob');
  });
  it('falls back to the first maintainer when the version has no publisher; null when neither', async () => {
    const { fetcher } = fakeRegistry({ versions: { '1.0.0': {} }, maintainers: [{ name: 'carol' }] });
    expect(await lookupNpmPublisher({ name: 'x', version: '1.0.0' }, fetcher)).toBe('npm-user:carol');
    const { fetcher: none } = fakeRegistry({ versions: {} });
    expect(await lookupNpmPublisher({ name: 'x', version: '1.0.0' }, none)).toBeNull();
  });
  it('RED — a registry failure / non-ok / throw resolves null (never guessed)', async () => {
    const { fetcher } = fakeRegistry({}, false);
    expect(await lookupNpmPublisher({ name: 'x', version: null }, fetcher)).toBeNull();
    const boom = async () => { throw new Error('net'); };
    expect(await lookupNpmPublisher({ name: 'x', version: null }, boom as never)).toBeNull();
  });
});

describe('resolvePkgOwners (cached)', () => {
  it('resolves only package coordinates, caches hits and misses, never throws on a cache outage', async () => {
    const store = new Map<string, unknown>();
    const cache = {
      get: async <T,>(k: string) => (store.has(k) ? store.get(k) as T : null),
      set: async (k: string, v: unknown) => { store.set(k, v); },
    } as never;
    const { fetcher, calls } = fakeRegistry({ versions: { '1.0.0': { _npmUser: { name: 'dan' } } } });
    const m = await resolvePkgOwners(cache, [origin('pkg:npm:foo@1.0.0'), origin('evm:0xabc')], fetcher);
    expect(m.get('pkg:npm:foo@1.0.0')).toBe('npm-user:dan');
    expect(m.has('evm:0xabc')).toBe(false);
    const again = await resolvePkgOwners(cache, [origin('pkg:npm:foo@1.0.0')], fetcher);
    expect(again.get('pkg:npm:foo@1.0.0')).toBe('npm-user:dan');
    expect(calls).toHaveLength(1); // cache hit, no second registry call
    const broken = { get: async () => { throw new Error('redis'); }, set: async () => { throw new Error('redis'); } } as never;
    const m2 = await resolvePkgOwners(broken, [origin('pkg:npm:foo@1.0.0')], fetcher);
    expect(m2.get('pkg:npm:foo@1.0.0')).toBe('npm-user:dan');
  });
});
