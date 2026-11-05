/**
 * (D) — the git commit hook must start Node on a box whose only Node is
 * the installer's private `~/.provian/node` (on nobody's PATH).
 *
 * Found in a live cloud-cell proof: the hook baked a bare `node`, so on the
 * exact boxes the hosted `curl | sh` line serves, every commit wrote
 * `post-commit: node: not found` into hook.log and no PE. These tests run the
 * baked invocation through a real `sh` with a PATH that has no `node`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { buildSection, composePostCommit, healGlobalHook, hookNodeInvocation, resolveReportPeCmd, shellQuote, HOOK_END_MARKER, HOOK_START_MARKER } from './hook-install';
import { extractScriptPaths } from './observer/runtime-install';

const NO_NODE_PATH = '/usr/bin:/bin';

function fakeNode(dir: string, name = 'node'): string {
  const bin = path.join(dir, name);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\necho "ran:$*" >> "$MARK"\n', { mode: 0o755 });
  return bin;
}

/** Run a hook-shaped `( <cmd> args >>log 2>&1 )` line in sh; returns what the fake node recorded + the log. */
function runHookLine(cmd: string, env: Record<string, string>): { mark: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-node-'));
  const mark = path.join(dir, 'mark');
  const log = path.join(dir, 'hook.log');
  execFileSync('/bin/sh', ['-c', `(${cmd} "/x/agent.js" "report-pe" --type coding_session >>"${log}" 2>&1) || true`], {
    env: { ...env, MARK: mark },
  });
  return {
    mark: fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '',
    log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
  };
}

describe('hookNodeInvocation (D)', () => {
  it('starts the ABSOLUTE node the installer ran under when PATH has no node', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priv-node-'));
    const bin = fakeNode(path.join(dir, '.provian', 'node', 'bin'));
    const r = runHookLine(hookNodeInvocation(bin), { PATH: NO_NODE_PATH });
    expect(r.mark).toContain('ran:/x/agent.js report-pe --type coding_session');
  });

  it('RED control: the pre-fix bare `node` on the same PATH records nothing (node: not found)', () => {
    const r = runHookLine('node', { PATH: NO_NODE_PATH });
    expect(r.mark).toBe('');
    expect(r.log).toMatch(/node: (command )?not found|node: No such file/);
  });

  it('falls back to PATH node when the baked binary was later removed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-node-'));
    fakeNode(path.join(dir, 'bin'));
    const r = runHookLine(hookNodeInvocation('/nonexistent/node'), { PATH: `${path.join(dir, 'bin')}:${NO_NODE_PATH}` });
    expect(r.mark).toContain('ran:/x/agent.js report-pe');
  });

  it('survives a path with spaces and a single quote', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it's a dir "));
    const bin = fakeNode(path.join(dir, 'b in'));
    const r = runHookLine(hookNodeInvocation(bin), { PATH: NO_NODE_PATH });
    expect(r.mark).toContain('ran:/x/agent.js');
  });

  it('the built section bakes the running node, not a bare `node` (machine-independent: an explicit bundle path)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
    const bundle = path.join(dir, 'agent.js');
    fs.writeFileSync(bundle, '// bundle');
    const prev = process.env.PROVIAN_BUNDLE_PATH;
    process.env.PROVIAN_BUNDLE_PATH = bundle;
    try {
      const section = buildSection();
      expect(section).toContain(`PROVIAN_NODE='${process.execPath}'`);
      expect(section).toContain(`'${fs.realpathSync(bundle)}' 'report-pe'`);
      expect(section).not.toMatch(/\(node "/);
    } finally {
      if (prev === undefined) delete process.env.PROVIAN_BUNDLE_PATH; else process.env.PROVIAN_BUNDLE_PATH = prev;
    }
  });
});

describe('resolveReportPeCmd on an npm-installed package', () => {
  // The layout npm installs: <pkg>/package.json + <pkg>/dist/{hook-install.js,scripts/report-pe.js}, no src/.
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-pkg-'));
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"@provian/agent-sdk"}');
  fs.mkdirSync(path.join(pkg, 'dist', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'dist', 'scripts', 'report-pe.js'), '//');
  const run = () => {
    const prev = process.env.PROVIAN_BUNDLE_PATH;
    delete process.env.PROVIAN_BUNDLE_PATH;
    try {
      return resolveReportPeCmd({ nodeBin: '/n/node', moduleDir: path.join(pkg, 'dist'), hostedBundle: path.join(pkg, 'no-bundle', 'agent.js') });
    } finally {
      if (prev !== undefined) process.env.PROVIAN_BUNDLE_PATH = prev;
    }
  };

  it('bakes <pkg>/dist/scripts/report-pe.js — a script that exists (never <pkg>/../dist)', () => {
    const cmd = run();
    const want = path.join(fs.realpathSync(pkg), 'dist', 'scripts', 'report-pe.js');
    expect(cmd).toContain(`'${want}'`);
    const baked = /'(\/[^']+report-pe\.js)'/.exec(cmd)?.[1];
    expect(baked && fs.existsSync(baked)).toBe(true);
  });

  it('bakes the script path single-quoted, so a `$`, backtick or backslash in the install path stays literal, and the heal probe still finds it', () => {
    const cmd = run();
    expect(cmd).toMatch(/ '\/[^']+report-pe\.js'$/);
    expect(cmd).not.toMatch(/"[^"]*report-pe\.js"/);
    const want = path.join(fs.realpathSync(pkg), 'dist', 'scripts', 'report-pe.js');
    expect(extractScriptPaths(cmd)).toEqual([want]);
    expect(shellQuote("/Users/o'brien/$HOME/`x`/report-pe.js")).toBe("'/Users/o'\\''brien/$HOME/`x`/report-pe.js'");
  });
});

describe('healGlobalHook (D) — repairs BROKEN hooks, never re-targets a working one', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-targets-'));
  const LIVE = path.join(tmp, 'live', 'agent.js');
  const OTHER = path.join(tmp, 'other', 'report-pe.js');
  for (const f of [LIVE, OTHER]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '//'); }
  const GONE = path.join(tmp, 'gone', 'agent.js');
  const GOOD = buildSection(`${hookNodeInvocation('/opt/n/bin/node')} "${LIVE}" "report-pe"`);
  const STALE = buildSection(`node "${LIVE}" "report-pe"`);

  function dirWith(content: string | null): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-'));
    if (content !== null) fs.writeFileSync(path.join(d, 'post-commit'), content, { mode: 0o755 });
    return d;
  }
  const read = (d: string) => fs.readFileSync(path.join(d, 'post-commit'), 'utf8');

  it('rewrites a pre-fix bare-`node` block and keeps the foreign content around it', () => {
    const d = dirWith(`#!/bin/sh\necho user-before\n${STALE}\necho user-after\n`);
    expect(healGlobalHook({ hooksDir: d, section: GOOD })).toBe('healed');
    const out = read(d);
    expect(out).toContain('echo user-before');
    expect(out).toContain('echo user-after');
    expect(out).toContain("PROVIAN_NODE='/opt/n/bin/node'");
    expect(out).not.toContain(`(node "${LIVE}"`);
    expect(out.split(HOOK_START_MARKER)).toHaveLength(2);
    expect(out.split(HOOK_END_MARKER)).toHaveLength(2);
  });

  it('rewrites a block whose baked script no longer exists', () => {
    const d = dirWith(composePostCommit(null, buildSection(`${hookNodeInvocation('/opt/n/bin/node')} "${GONE}" "report-pe"`)));
    expect(healGlobalHook({ hooksDir: d, section: GOOD })).toBe('healed');
    expect(read(d)).toContain(`"${LIVE}" "report-pe"`);
  });

  it('RED: a WORKING hook baked to a different, existing target is never re-targeted', () => {
    const working = composePostCommit(null, buildSection(`${hookNodeInvocation('/usr/bin/node')} "${OTHER}"`));
    const d = dirWith(working);
    expect(healGlobalHook({ hooksDir: d, section: GOOD })).toBe('current');
    expect(read(d)).toBe(working);
  });

  it('never writes a section whose own script does not exist', () => {
    const d = dirWith(composePostCommit(null, STALE));
    const deadWant = buildSection(`${hookNodeInvocation('/opt/n/bin/node')} "${GONE}" "report-pe"`);
    expect(healGlobalHook({ hooksDir: d, section: deadWant })).toBe('skipped');
    expect(read(d)).toBe(composePostCommit(null, STALE));
  });

  it('is a no-op on a current hook, and never creates one the user did not install', () => {
    const cur = dirWith(composePostCommit(null, GOOD));
    expect(healGlobalHook({ hooksDir: cur, section: GOOD })).toBe('current');
    const none = dirWith(null);
    expect(healGlobalHook({ hooksDir: none, section: GOOD })).toBe('absent');
    expect(fs.existsSync(path.join(none, 'post-commit'))).toBe(false);
    const foreign = dirWith('#!/bin/sh\necho only-theirs\n');
    expect(healGlobalHook({ hooksDir: foreign, section: GOOD })).toBe('absent');
    expect(read(foreign)).toBe('#!/bin/sh\necho only-theirs\n');
  });

  it('healing twice is idempotent — no shebang or marker accumulates', () => {
    const d = dirWith(composePostCommit(null, STALE));
    expect(healGlobalHook({ hooksDir: d, section: GOOD })).toBe('healed');
    const once = read(d);
    expect(healGlobalHook({ hooksDir: d, section: GOOD })).toBe('current');
    expect(read(d)).toBe(once);
    expect(once.match(/#!\/bin\/sh/g)?.length).toBe(composePostCommit(null, STALE).match(/#!\/bin\/sh/g)?.length);
  });

  it('a reinstall over an installed hook does not stack another shebang', () => {
    const first = composePostCommit(null, GOOD);
    const again = composePostCommit(first, GOOD);
    const shebangs = (t: string) => t.match(/#!\/bin\/sh/g)?.length;
    expect(shebangs(again)).toBe(shebangs(first));
    expect(composePostCommit(again, GOOD)).toBe(again);
  });

  it('never downgrades a broken hook to the npx fallback', () => {
    const d = dirWith(composePostCommit(null, STALE));
    expect(healGlobalHook({ hooksDir: d, section: buildSection('npx @provian/agent-sdk report-pe') })).toBe('skipped');
    expect(read(d)).toBe(composePostCommit(null, STALE));
  });
});

describe('the observer runs the heal at start', () => {
  const src = fs.readFileSync(path.join(__dirname, 'observer', 'run-daemon.ts'), 'utf8');
  const startAt = src.indexOf('await observer.start();');
  /** The heal call site: after the observer started, inside run-daemon. */
  const healCallAfterStart = (text: string): boolean => {
    const s = text.indexOf('await observer.start();');
    return s !== -1 && /\bhealGlobalHook\(\)/.test(text.slice(s));
  };
  it('run-daemon calls healGlobalHook() after observer.start()', () => {
    expect(startAt).toBeGreaterThan(0);
    expect(healCallAfterStart(src)).toBe(true);
  });
  it('RED control: the scan reports the call missing when it is removed', () => {
    const mutated = src.replace(/const healed = healGlobalHook\(\);/, 'const healed = "current" as string;');
    expect(mutated).not.toBe(src);
    expect(healCallAfterStart(mutated)).toBe(false);
  });
});
