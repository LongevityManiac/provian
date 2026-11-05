/**
 * GitPlugin publishes the repo roots it watches to observer-git-repos so the
 * post-commit hook can defer only for those repos (see post-commit.template and
 * postCommitHookDeferral.test.ts for the hook side).
 *
 * Negative control for the "empty population" shape: the no-repo case asserts
 * the published file is EMPTY, not merely present — the property under test is
 * "the hook sees nothing to defer to," which a stub that always wrote a repo
 * would violate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitPlugin } from './GitPlugin';
import type { ProvianObserver } from '../ProvianObserver';

function fakeObserver(): ProvianObserver {
  return { log: () => { /* noop */ } } as unknown as ProvianObserver;
}

function makeRepo(root: string): void {
  const refsDir = path.join(root, '.git', 'refs', 'heads');
  fs.mkdirSync(refsDir, { recursive: true });
  fs.writeFileSync(path.join(refsDir, 'main'), `${'a'.repeat(40)}\n`);
}

describe('GitPlugin watched-repos publication', () => {
  let tmp: string;
  let watchedFile: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-git-watch-'));
    watchedFile = path.join(tmp, 'observer-git-repos');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes the watched repo root on start and removes the file on stop', async () => {
    const repo = path.join(tmp, 'proj');
    makeRepo(repo);
    const plugin = new GitPlugin([repo], watchedFile);
    await plugin.init(fakeObserver());
    await plugin.start();

    const listed = fs.readFileSync(watchedFile, 'utf-8').trim().split('\n');
    expect(listed).toContain(path.resolve(repo));

    await plugin.stop();
    expect(fs.existsSync(watchedFile)).toBe(false);
  });

  it('writes an EMPTY file when no repo is watched (hook must fire, not defer)', async () => {
    // cwd outside any git repo so cwd-discovery finds nothing either.
    process.chdir(tmp);
    const plugin = new GitPlugin([], watchedFile);
    await plugin.init(fakeObserver());
    await plugin.start();

    expect(fs.existsSync(watchedFile)).toBe(true);
    expect(fs.readFileSync(watchedFile, 'utf-8')).toBe('');

    await plugin.stop();
  });

  it('overwrites a stale list rather than appending', async () => {
    fs.mkdirSync(path.dirname(watchedFile), { recursive: true });
    fs.writeFileSync(watchedFile, '/old/stale/repo\n');

    const repo = path.join(tmp, 'proj');
    makeRepo(repo);
    const plugin = new GitPlugin([repo], watchedFile);
    await plugin.init(fakeObserver());
    await plugin.start();

    const contents = fs.readFileSync(watchedFile, 'utf-8');
    expect(contents).not.toContain('/old/stale/repo');
    expect(contents).toContain(path.resolve(repo));
  });
});
