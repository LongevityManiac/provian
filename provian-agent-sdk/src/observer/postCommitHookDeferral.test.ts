/**
 * End-to-end proof that the post-commit hook captures a coding_session PE on
 * the designed onboarding path — and does so EXACTLY ONCE.
 *
 * The gap this guards: the daemon runs with cwd=$HOME, so its GitPlugin watches
 * no repos; the old hook deferred to the running observer unconditionally, so a
 * commit was dropped by BOTH (hook deferred, GitPlugin wasn't watching). The
 * fix makes the hook defer only for repos in observer-git-repos.
 *
 * This renders the real hooks/post-commit.template (the exact file register-device
 * and setup-hook install), wires {{REPORT_PE_CMD}} to a marker script, drives a
 * real `git commit`, and asserts whether the marker fired.
 *
 * Negative control: the "watched" case asserts the marker does NOT fire — the
 * guard can be observed both firing and deferring, so a hook hard-wired to
 * always-fire (or always-defer) would fail one of these cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEMPLATE_PATH = path.resolve(__dirname, '../../hooks/post-commit.template');

function bash(script: string, env: NodeJS.ProcessEnv, cwd?: string): void {
  execFileSync('bash', ['-c', script], { env, cwd, stdio: 'pipe' });
}

function waitForFile(p: string, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return true;
    execFileSync('sleep', ['0.05']);
  }
  return false;
}

interface Fixture {
  home: string;
  repo: string;
  repoToplevel: string;
  marker: string;
  argsFile: string;
  provianDir: string;
  env: NodeJS.ProcessEnv;
}

// The hook is a POSIX shell script; exercise it only where bash + a POSIX
// `sleep` exist. The Windows helper path has its own capture story.
describe.skipIf(process.platform === 'win32')('post-commit hook repo-aware observer deferral', () => {
  let fx: Fixture;

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-hook-'));
    const home = path.join(root, 'home');
    const repo = path.join(root, 'repo');
    const provianDir = path.join(home, '.provian');
    fs.mkdirSync(provianDir, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
      PROVIAN_DISABLE_HOOK: '',
    };

    // Seed an initial commit FIRST (before the hook exists) so the hook only
    // ever fires for the per-test commit() calls, and so a normal (non-first)
    // commit path is exercised.
    bash('git init -q .', env, repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    bash('git add -A && git commit -q -m "seed"', env, repo);

    const marker = path.join(root, 'HOOK_FIRED');
    const argsFile = path.join(root, 'HOOK_ARGS');
    // A stand-in for `report-pe`: records that it ran and the args it received
    // (so we can assert the template forwards --commit-sha / --branch).
    const markerScript = path.join(root, 'marker.sh');
    fs.writeFileSync(
      markerScript,
      `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argsFile}"\necho fired >> "${marker}"\n`,
      { mode: 0o755 },
    );

    const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
    const hook = template.replace('{{REPORT_PE_CMD}}', `sh "${markerScript}"`);
    const hookPath = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hookPath, hook, { mode: 0o755 });

    const repoToplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
      env, encoding: 'utf-8',
    }).trim();

    fx = { home, repo, repoToplevel, marker, argsFile, provianDir, env };
  });

  afterEach(() => {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  });

  function commit(msg: string): void {
    fs.appendFileSync(path.join(fx.repo, 'a.txt'), `${msg}\n`);
    bash(`git add -A && git commit -q -m "${msg}"`, fx.env, fx.repo);
  }

  it('fires when no observer is running, as `--hook post-commit --commit-sha <the commit>` ', () => {
    commit('c1');
    expect(waitForFile(fx.marker)).toBe(true);
    const head = execFileSync('git', ['-C', fx.repo, 'rev-parse', 'HEAD'], { env: fx.env, encoding: 'utf-8' }).trim();
    const args = fs.readFileSync(fx.argsFile, 'utf-8').split('\n').filter((a) => a.length > 0);
    // The hook names only WHICH commit (captured synchronously); report-pe reads
    // branch/numstat from git and checks the commit is fresh + reachable. No
    // caller-chosen type or prose.
    expect(args).toEqual(['--hook', 'post-commit', '--commit-sha', head]);
  });

  it('RED ( ): `git commit -m a && git commit -m b` names a AND b, never b twice', () => {
    // Slow the stand-in so both backgrounded reports are still pending when the
    // second commit lands — the race the old hook lost (it passed no sha, and the
    // backgrounded report read HEAD after startup, so it saw b for both).
    const slow = path.join(path.dirname(fx.marker), 'slow.sh');
    fs.writeFileSync(slow, `#!/bin/sh\nsleep 0.5\nprintf '%s\\n' "$@" >> "${fx.argsFile}"\necho fired >> "${fx.marker}"\n`, { mode: 0o755 });
    const hookPath = path.join(fx.repo, '.git', 'hooks', 'post-commit');
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
    fs.writeFileSync(hookPath, template.replace('{{REPORT_PE_CMD}}', `sh "${slow}"`), { mode: 0o755 });
    fs.appendFileSync(path.join(fx.repo, 'a.txt'), 'a\n');
    bash('git add -A && git commit -q -m a && echo b >> a.txt && git add -A && git commit -q -m b', fx.env, fx.repo);
    const a = execFileSync('git', ['-C', fx.repo, 'rev-parse', 'HEAD~1'], { env: fx.env, encoding: 'utf-8' }).trim();
    const b = execFileSync('git', ['-C', fx.repo, 'rev-parse', 'HEAD'], { env: fx.env, encoding: 'utf-8' }).trim();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (fs.existsSync(fx.marker) && fs.readFileSync(fx.marker, 'utf-8').trim().split('\n').length >= 2) break;
      execFileSync('sleep', ['0.05']);
    }
    const args = fs.readFileSync(fx.argsFile, 'utf-8').split('\n').filter((x) => x.length > 0);
    const named = args.filter((_, i) => i > 0 && args[i - 1] === '--commit-sha');
    expect(named.sort()).toEqual([a, b].sort());
  });

  it('fires when the observer runs but is NOT watching this repo (the fixed gap)', () => {
    // Live observer pid (this test process is alive), empty watched set.
    fs.writeFileSync(path.join(fx.provianDir, 'observer.pid'), String(process.pid));
    fs.writeFileSync(path.join(fx.provianDir, 'observer-git-repos'), '');
    commit('c2');
    expect(waitForFile(fx.marker)).toBe(true);
  });

  it('defers (marker does NOT fire) when the observer IS watching this repo', () => {
    fs.writeFileSync(path.join(fx.provianDir, 'observer.pid'), String(process.pid));
    fs.writeFileSync(
      path.join(fx.provianDir, 'observer-git-repos'),
      `${fx.repoToplevel}\n`,
    );
    commit('c3');
    // The observer's GitPlugin owns this commit; the hook must stay silent.
    expect(waitForFile(fx.marker, 1000)).toBe(false);
  });

  it('fires when the recorded observer pid is dead (stale pid file)', () => {
    // A pid that is (almost certainly) not a live process.
    fs.writeFileSync(path.join(fx.provianDir, 'observer.pid'), '2147480000');
    fs.writeFileSync(
      path.join(fx.provianDir, 'observer-git-repos'),
      `${fx.repoToplevel}\n`,
    );
    commit('c4');
    expect(waitForFile(fx.marker)).toBe(true);
  });
});
