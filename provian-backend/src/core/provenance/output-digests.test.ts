/** Trust Layer build §2.3 — `output_digests` normalizer, with RED controls per branch. */
import {
  normalizeOutputDigests,
  isValidStoredOutputDigests,
  outputDigestsState,
  canonicalOutputDigestHash,
  OUTPUT_DIGESTS_MAX_ENTRIES,
} from './output-digests';

const SHA = `sha256:${'a'.repeat(64)}`;

describe('normalizeOutputDigests', () => {
  it('three-state: non-array → null (absent); [] → present_empty; populated → canonical entries', () => {
    expect(normalizeOutputDigests(undefined)).toBeNull();
    expect(normalizeOutputDigests({})).toBeNull();
    expect(normalizeOutputDigests([])).toEqual([]);
    expect(normalizeOutputDigests([{ hash: SHA, kind: 'file' }])).toEqual([{ hash: SHA, kind: 'file' }]);
    expect(outputDigestsState(normalizeOutputDigests([]))).toBe('present_empty');
    expect(outputDigestsState(normalizeOutputDigests(null))).toBe('absent');
  });

  it('accepts the three hash grammars and lowercases hex', () => {
    const git = `git:${'B'.repeat(40)}`;
    const tx = `evmtx:0x${'C'.repeat(64)}`;
    const out = normalizeOutputDigests([
      { hash: SHA.toUpperCase(), kind: 'artifact' },
      { hash: git, kind: 'commit' },
      { hash: tx, kind: 'tx' },
    ])!;
    expect(out.map((d) => d.hash)).toEqual([SHA, git.toLowerCase(), tx.toLowerCase()]);
  });

  // RED controls — every rejection branch fires.
  it('RED — a malformed hash, an unknown kind, a missing field, a non-object are DROPPED (never fatal)', () => {
    const out = normalizeOutputDigests([
      { hash: 'sha256:short', kind: 'file' },
      { hash: SHA, kind: 'placeholder' },
      { kind: 'file' },
      'nope',
      null,
      { hash: `md5:${'a'.repeat(32)}`, kind: 'file' },
    ]);
    expect(out).toEqual([]);
  });

  it('RED — a private filesystem path never rides `locator`; a public URL / chain ref does', () => {
    const [a, b, c] = normalizeOutputDigests([
      { hash: SHA, kind: 'file', locator: '/Users/frank/secret/notes.md' },
      { hash: `sha256:${'b'.repeat(64)}`, kind: 'artifact', locator: 'https://github.com/o/r/blob/abc/x.ts' },
      { hash: `evmtx:0x${'c'.repeat(64)}`, kind: 'tx', locator: 'chain:eip155:8453' },
    ])!;
    expect(a.locator).toBeUndefined();
    expect(b.locator).toBe('https://github.com/o/r/blob/abc/x.ts');
    expect(c.locator).toBe('chain:eip155:8453');
  });

  it('dedupes by hash and caps at OUTPUT_DIGESTS_MAX_ENTRIES', () => {
    const many = Array.from({ length: OUTPUT_DIGESTS_MAX_ENTRIES + 10 }, (_, i) => ({
      hash: `sha256:${i.toString(16).padStart(64, '0')}`, kind: 'file',
    }));
    expect(normalizeOutputDigests(many)!).toHaveLength(OUTPUT_DIGESTS_MAX_ENTRIES);
    expect(normalizeOutputDigests([{ hash: SHA, kind: 'file' }, { hash: SHA, kind: 'artifact' }])!).toHaveLength(1);
  });
});

describe('isValidStoredOutputDigests (chain validators)', () => {
  it('absent OK; canonical OK; extra key / non-canonical hash / bad locator REFUSED', () => {
    expect(isValidStoredOutputDigests(undefined)).toBe(true);
    expect(isValidStoredOutputDigests([{ hash: SHA, kind: 'file' }])).toBe(true);
    expect(isValidStoredOutputDigests([{ hash: SHA, kind: 'file', extra: 1 }])).toBe(false);
    expect(isValidStoredOutputDigests([{ hash: SHA.toUpperCase(), kind: 'file' }])).toBe(false);
    expect(isValidStoredOutputDigests([{ hash: SHA, kind: 'file', locator: '/etc/passwd' }])).toBe(false);
    expect(isValidStoredOutputDigests('x')).toBe(false);
  });
  it('canonicalOutputDigestHash rejects anything outside the grammar', () => {
    expect(canonicalOutputDigestHash(`sha256:${'A'.repeat(64)}`)).toBe(SHA);
    expect(canonicalOutputDigestHash('sha1:abc')).toBeNull();
    expect(canonicalOutputDigestHash('')).toBeNull();
  });
});
