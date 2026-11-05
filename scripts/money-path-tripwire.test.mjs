/**
 * Money-path tripwire guard.
 *
 * Per the standing doctrine — "a new assertion is not evidence until a negative
 * control has shown it failing" — the comparison function is driven with
 * deliberately violating inputs here, in-suite and permanently, rather than
 * being observed green once by hand. The three recurring failure shapes are
 * each addressed by name:
 *
 *   empty population   — the real tree is asserted to match a NON-ZERO number of
 *                        files, and the checker itself treats zero as a failure,
 *                        because a tripwire guarding nothing reports OK forever.
 *   self-referential   — MONEY_PATH_ROOTS is IMPORTED from the module under
 *                        test. This suite never declares its own copy of the
 *                        scope, so it cannot pass by agreeing with itself.
 *   unreachable branch — diffAgainstManifest takes both sides as parameters, so
 *                        every violating case (added / removed / modified) is
 *                        constructible without touching the real tree.
 */
import { describe, it, expect } from 'vitest';
import {
  MONEY_PATH_ROOTS,
  MANIFEST_PATH,
  moneyPathFiles,
  currentDigests,
  diffAgainstManifest,
  isClean,
} from './money-path-tripwire.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), MANIFEST_PATH), 'utf8')).files;

describe('money-path tripwire — negative controls', () => {
  const base = { 'a.ts': 'hash-a', 'b.ts': 'hash-b' };

  it('RED: reports a MODIFIED money-path file', () => {
    const v = diffAgainstManifest({ ...base, 'b.ts': 'hash-b-CHANGED' }, base);
    expect(v.modified).toEqual(['b.ts']);
    expect(isClean(v)).toBe(false);
  });

  it('RED: reports an ADDED money-path file', () => {
    const v = diffAgainstManifest({ ...base, 'c.ts': 'hash-c' }, base);
    expect(v.added).toEqual(['c.ts']);
    expect(isClean(v)).toBe(false);
  });

  it('RED: reports a REMOVED money-path file', () => {
    const v = diffAgainstManifest({ 'a.ts': 'hash-a' }, base);
    expect(v.removed).toEqual(['b.ts']);
    expect(isClean(v)).toBe(false);
  });

  it('GREEN only on an exact match', () => {
    expect(isClean(diffAgainstManifest(base, base))).toBe(true);
  });
});

describe('money-path tripwire — scope is real', () => {
  const files = moneyPathFiles();

  it('evaluates a non-empty population', () => {
    // A pass over zero files is not a pass. If a rename ever breaks the roots,
    // this fails here rather than silently reporting OK forever.
    expect(files.length).toBeGreaterThan(0);
  });

  it('every root matches at least one tracked file', () => {
    for (const root of MONEY_PATH_ROOTS) {
      expect(files.some((f) => f.startsWith(root)), `dead root: ${root}`).toBe(true);
    }
  });

  it('covers the only module that constructs a mint signer', () => {
    // Named explicitly: if operator-runtime.ts ever falls out of scope, the
    // tripwire would stop watching the single file that can move real PVT.
    expect(files).toContain('provian-backend/src/core/pvt/wp4/operator-runtime.ts');
  });

  it('covers the accrual entry point and the runtime address/ABI seam', () => {
    expect(files).toContain('provian-backend/src/pvt-accrual.ts');
    expect(files).toContain('config/pvt9-base.json');
  });

  it('covers the novelty-counter store (cache.ts) — and ONLY that file of the rest of src/', () => {
    // close-out: the `pvt:occ` ordinals in cache.ts price every PE and
    // their Lua commit is the exactly-once claim. H3 changed that
    // semantics and the tripwire said nothing. Exact path: `cache.test.ts`
    // and the rest of `provian-backend/src/` stay out of scope.
    expect(files).toContain('provian-backend/src/cache.ts');
    expect(files).not.toContain('provian-backend/src/cache.test.ts');
    expect(files.some((f) => f === 'provian-backend/src/server.ts')).toBe(false);
  });

  it('watches money-path tests too, not just implementation', () => {
    // A quietly weakened money-path test is the cheaper attack than editing the
    // money path itself.
    expect(files.some((f) => f.startsWith('provian-backend/src/core/pvt/') && f.endsWith('.test.ts'))).toBe(true);
  });
});

describe('money-path tripwire — the tree matches the manifest', () => {
  it('no unaccepted money-path change is present', () => {
    const v = diffAgainstManifest(currentDigests(), manifest);
    expect(
      { modified: v.modified, added: v.added, removed: v.removed },
      'money-path files changed; if intended, run `npm run money-path:accept` and commit the manifest',
    ).toEqual({ modified: [], added: [], removed: [] });
  });

  it('the manifest itself is non-empty', () => {
    expect(Object.keys(manifest).length).toBeGreaterThan(0);
  });
});
