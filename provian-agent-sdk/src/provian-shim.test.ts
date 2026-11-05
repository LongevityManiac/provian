import { PROVIAN_NODE_BIN } from './observer/node-runtime-heal';
/**
 * `~/.provian/bin/provian` wraps `<absolute node> ~/.provian/agent.js "$@"`, written from the
 * bundle side (repair / daemon start / any act verb), idempotently, only for the hosted bundle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureProvianShim, provianShimContent, provianShimPath } from './provian-shim';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-shim-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('provian shim', () => {
  const NODE = '/home/bot/.provian/node/bin/node';

  it('execs the ABSOLUTE runtime on the hosted bundle with every argument (never a bare `node`)', () => {
    const c = provianShimContent('/home/bot/.provian/agent.js', NODE);
    expect(c.startsWith('#!/bin/sh\n')).toBe(true);
    expect(c).toContain(`exec '${NODE}' '/home/bot/.provian/agent.js' "$@"`);
    expect(c).not.toMatch(/exec node /);
  });

  it('quotes a path with a single quote safely', () => {
    expect(provianShimContent("/home/o'neil/.provian/agent.js", "/home/o'neil/.provian/node/bin/node"))
      .toContain(`exec '/home/o'\\''neil/.provian/node/bin/node' '/home/o'\\''neil/.provian/agent.js'`);
  });

  it.skipIf(process.platform === 'win32')('RED ( , defect 5): the written wrapper runs with NO node on PATH (a hosted box on the private runtime)', () => {
    const bundle = path.join(home, '.provian', 'agent.js');
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    expect(ensureProvianShim(bundle, home)).toBe('installed'); // bakes process.execPath
    const r = spawnSync('/bin/sh', [provianShimPath(home), 'help', 'a b'], { env: { PATH: '' }, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(['help', 'a b']);
  });

  it('a runtime move rewrites the wrapper on the next write (daemon start / repair / act verb)', () => {
    const bundle = path.join(home, '.provian', 'agent.js');
    expect(ensureProvianShim(bundle, home, '/usr/local/bin/node')).toBe('installed');
    expect(ensureProvianShim(bundle, home, '/usr/local/bin/node')).toBe('unchanged');
    expect(ensureProvianShim(bundle, home, NODE)).toBe('updated');
    expect(fs.readFileSync(provianShimPath(home), 'utf8')).toBe(provianShimContent(bundle, NODE));
  });

  it('RED: a non-absolute runtime is never baked (the wrapper must not depend on PATH)', () => {
    const bundle = path.join(home, '.provian', 'agent.js');
    expect(ensureProvianShim(bundle, home, 'node')).toBe('error');
    expect(fs.existsSync(provianShimPath(home))).toBe(false);
  });

  it('installs, then is unchanged, then heals a tampered copy; mode 0755', () => {
    const bundle = path.join(home, '.provian', 'agent.js');
    expect(ensureProvianShim(bundle, home)).toBe('installed');
    const target = provianShimPath(home);
    expect(fs.readFileSync(target, 'utf8')).toBe(provianShimContent(bundle, PROVIAN_NODE_BIN));
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    expect(ensureProvianShim(bundle, home)).toBe('unchanged');
    fs.writeFileSync(target, '#!/bin/sh\necho stale\n');
    expect(ensureProvianShim(bundle, home)).toBe('updated');
    expect(fs.readFileSync(target, 'utf8')).toBe(provianShimContent(bundle, PROVIAN_NODE_BIN));
  });

  it('RED: a package install or a test runner is never given a shim', () => {
    expect(ensureProvianShim('/usr/lib/node_modules/@provian/agent-sdk/dist/scripts/dispatch.js', home)).toBe('skipped');
    expect(ensureProvianShim(undefined, home)).toBe('skipped');
    expect(fs.existsSync(provianShimPath(home))).toBe(false);
  });
});
