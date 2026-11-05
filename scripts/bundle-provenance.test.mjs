import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyBundle, sourceDigest, assertCleanCheckout } from './bundle-provenance.mjs';
describe('bundled release provenance', () => {
  const stamp = JSON.stringify({ head: 'a'.repeat(40), sources: 'b'.repeat(64), channel: 'play' });
  it('verifies the bytes embedded in a bundle', () => {
    expect(sourceDigest()).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyBundle(Buffer.from('hermes' + stamp), stamp).channel).toBe('play');
  });
  it('refuses an earlier source, a different channel, and an empty bundle', () => {
    for (const wrong of [stamp.replace('play', 'website'), stamp.replace('a'.repeat(40), 'c'.repeat(40)), stamp.replace('b'.repeat(64), 'c'.repeat(64))]) {
      expect(() => verifyBundle(Buffer.from(wrong), stamp)).toThrow(/does not contain/);
    }
    expect(() => verifyBundle(Buffer.alloc(0), stamp)).toThrow(/does not contain/);
  });
});

it('refuses tracked edits and untracked imports before calling a release HEAD-bound', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-clean-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir });
  try {
    git('init', '-q');
    writeFileSync(join(dir, 'index.ts'), 'original');
    git('add', 'index.ts');
    git('-c', 'user.name=Build Test', '-c', 'user.email=build@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    expect(() => assertCleanCheckout(dir)).not.toThrow();
    writeFileSync(join(dir, 'index.ts'), 'modified');
    expect(() => assertCleanCheckout(dir)).toThrow(/clean committed checkout/);
    writeFileSync(join(dir, 'index.ts'), 'original');
    writeFileSync(join(dir, 'new-import.ts'), 'untracked');
    expect(() => assertCleanCheckout(dir)).toThrow(/untracked sources/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
