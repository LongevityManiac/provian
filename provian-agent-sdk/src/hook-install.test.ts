/**
 * hook-install — WS3 composition, RED-controlled.
 *
 * Fixtures are the REAL layout on this machine, not invented shapes: this repo
 * carries a repo-local `core.hooksPath =.githooks` holding a `pre-commit`
 * (the frozen-contract guard) and NO post-commit — the exact case that made the
 * Provian global hook never fire. The tests reproduce that layout in a temp dir.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composePostCommit,
  installGlobal,
  installIntoRepo,
  repoActiveHooksDir,
  resolveActiveHooksDir,
  HOOK_START_MARKER,
  HOOK_END_MARKER,
  type GitConfigIO,
} from './hook-install';

const SECTION = `${HOOK_START_MARKER}\necho provian-pe\n${HOOK_END_MARKER}`;

// The real .githooks/pre-commit this repo ships — the hook that must survive.
const REAL_PRE_COMMIT =
  '#!/bin/sh\n'
  + '# Refuses a commit that would capture a mutated frozen contract.\n'
  + 'exec node "$(git rev-parse --show-toplevel)/scripts/check-frozen-contracts.mjs"\n';

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-hook-')); });

/** A GitConfigIO backed by an in-memory config map, rooted at `dir`. */
function fakeGit(cfg: { local?: Record<string, string>; global?: Record<string, string> }): GitConfigIO {
  return {
    repoRoot: () => dir,
    get: (scope, key) => (cfg[scope]?.[key] ?? null),
    set: (scope, key, value) => { (cfg[scope] ??= {})[key] = value; },
    unset: (scope, key) => { delete cfg[scope]?.[key]; },
  };
}

// ---------------------------------------------------------------------------
describe('resolveActiveHooksDir — git precedence', () => {
  it('a repo-local core.hooksPath WINS over the global one (relative → repoRoot)', () => {
    expect(resolveActiveHooksDir({
      repoRoot: '/r', localHooksPath: '.githooks', globalHooksPath: '/home/.provian/hooks',
    })).toBe(path.join('/r', '.githooks'));
  });

  it('RED CONTROL: without a local override it falls back to the global path, NOT .git/hooks', () => {
    // If this returned .git/hooks while a global hooksPath was set, the global
    // Provian hook would be installed where git never looks for this repo.
    expect(resolveActiveHooksDir({
      repoRoot: '/r', localHooksPath: null, globalHooksPath: '/home/.provian/hooks',
    })).toBe('/home/.provian/hooks');
  });

  it('no hooksPath anywhere → the default .git/hooks', () => {
    expect(resolveActiveHooksDir({ repoRoot: '/r', localHooksPath: null, globalHooksPath: null }))
      .toBe(path.join('/r', '.git', 'hooks'));
  });

  it('an absolute local hooksPath is taken as-is', () => {
    expect(resolveActiveHooksDir({ repoRoot: '/r', localHooksPath: '/abs/hooks', globalHooksPath: null }))
      .toBe('/abs/hooks');
  });
});

// ---------------------------------------------------------------------------
describe('composePostCommit — never drop the user’s bytes', () => {
  it('no file yet → a fresh shebang + our section', () => {
    const out = composePostCommit(null, SECTION);
    expect(out.startsWith('#!/bin/sh')).toBe(true);
    expect(out).toContain('echo provian-pe');
  });

  it('our markers present → replace ONLY between them (idempotent update)', () => {
    const first = composePostCommit(null, SECTION);
    const updated = composePostCommit(first, `${HOOK_START_MARKER}\necho provian-v2\n${HOOK_END_MARKER}`);
    expect(updated).toContain('echo provian-v2');
    expect(updated).not.toContain('echo provian-pe');
    // idempotent: exactly one Provian block
    expect(updated.split(HOOK_START_MARKER).length - 1).toBe(1);
  });

  it('RED CONTROL: a FOREIGN post-commit is preserved verbatim, our section appended after', () => {
    const foreign = '#!/bin/sh\nnpx lint-staged\n';
    const out = composePostCommit(foreign, SECTION);
    // The foreign command must still be there — clobbering it is the whole bug.
    expect(out).toContain('npx lint-staged');
    expect(out).toContain('echo provian-pe');
    expect(out.indexOf('npx lint-staged')).toBeLessThan(out.indexOf('echo provian-pe'));
  });
});

// ---------------------------------------------------------------------------
describe('installIntoRepo — the custom-hooksPath repo (real .githooks layout)', () => {
  function seedGithooksRepo(): void {
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.githooks', 'pre-commit'), REAL_PRE_COMMIT, { mode: 0o755 });
  }

  it('installs post-commit into .githooks (the active path), NOT .git/hooks', () => {
    seedGithooksRepo();
    const git = fakeGit({ local: { 'core.hooksPath': '.githooks' } });
    const res = installIntoRepo(dir, { git, section: SECTION });

    expect(res.hooksDir).toBe(path.join(dir, '.githooks'));
    expect(fs.existsSync(path.join(dir, '.githooks', 'post-commit'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.githooks', 'post-commit'), 'utf-8')).toContain('echo provian-pe');
    // RED CONTROL: git would ignore a hook installed in .git/hooks here.
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('CONTROL: the pre-existing .githooks/pre-commit is UNTOUCHED (not clobbered)', () => {
    seedGithooksRepo();
    const git = fakeGit({ local: { 'core.hooksPath': '.githooks' } });
    installIntoRepo(dir, { git, section: SECTION });
    expect(fs.readFileSync(path.join(dir, '.githooks', 'pre-commit'), 'utf-8')).toBe(REAL_PRE_COMMIT);
  });

  it('RED CONTROL (uninstall symmetry): repoActiveHooksDir points --remove at .githooks, not .git/hooks', () => {
    // The reviewer defect: install moved to the active dir but removeLocal/removeAuto
    // still probed .git/hooks, so --remove could not find the installed hook. The
    // remove path now resolves through THIS, which must return .githooks here.
    seedGithooksRepo();
    const git = fakeGit({ local: { 'core.hooksPath': '.githooks' } });
    installIntoRepo(dir, { git, section: SECTION });
    expect(repoActiveHooksDir(dir, git)).toBe(path.join(dir, '.githooks'));
    // and it is exactly where the install wrote the hook --remove must delete
    expect(fs.existsSync(path.join(repoActiveHooksDir(dir, git)!, 'post-commit'))).toBe(true);
  });

  it('a foreign .githooks/post-commit is preserved and Provian appended', () => {
    seedGithooksRepo();
    fs.writeFileSync(path.join(dir, '.githooks', 'post-commit'), '#!/bin/sh\nnpx lefthook run post-commit\n', { mode: 0o755 });
    const git = fakeGit({ local: { 'core.hooksPath': '.githooks' } });
    installIntoRepo(dir, { git, section: SECTION });
    const body = fs.readFileSync(path.join(dir, '.githooks', 'post-commit'), 'utf-8');
    expect(body).toContain('npx lefthook run post-commit');
    expect(body).toContain('echo provian-pe');
  });
});

// ---------------------------------------------------------------------------
describe('installGlobal — merges prior global hooks (hole A)', () => {
  it('copies the user’s prior global hooks into the target before setting core.hooksPath', () => {
    const prior = path.join(dir, 'prior-hooks');
    const target = path.join(dir, 'provian-hooks');
    fs.mkdirSync(prior, { recursive: true });
    fs.writeFileSync(path.join(prior, 'pre-commit'), '#!/bin/sh\necho prior-pre-commit\n', { mode: 0o755 });

    const cfg = { global: { 'core.hooksPath': prior } };
    const git = fakeGit(cfg);
    const res = installGlobal({ git, section: SECTION, targetDir: target, prevFile: path.join(dir, '.prev') });

    // The prior pre-commit was merged (still runs under the new path)...
    expect(res.merged).toContain('pre-commit');
    expect(fs.existsSync(path.join(target, 'pre-commit'))).toBe(true);
    // ...our post-commit is installed...
    expect(fs.readFileSync(path.join(target, 'post-commit'), 'utf-8')).toContain('echo provian-pe');
    // ...core.hooksPath now points at us...
    expect(cfg.global['core.hooksPath']).toBe(target);
    // ...and the prior path is remembered for --remove.
    expect(fs.readFileSync(path.join(dir, '.prev'), 'utf-8')).toBe(prior);
  });
});
