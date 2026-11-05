/**
 * the daemon provides the installer's Node itself, and re-points the
 * units a heal leaves behind.
 *
 * Negative-control doctrine: the one GREEN install path is paired with a RED for
 * every refusal (checksum mismatch, a binary that fails the probe, an unpinned
 * platform, the retry bound), each asserting the existing ~/.provian/node is
 * left byte-identical. The pin parity test binds to the backend prelude's SOURCE
 * (not a copy) and is shown failing on a drifted copy of that source.
 */

import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SpawnSyncReturns } from 'child_process';
import {
  PROVIAN_NODE_VERSION, PROVIAN_NODE_SHA256, NODE_FETCH_MARKER, NODE_FETCH_RETRY_MS,
  fetchProvianNode, nodeDistTarget, provianNodeBin,
} from './provian-node';
import { ensureStoreCapableNodeRuntime, SELFHEAL_FROM_ENV, SELFHEAL_GUARD_ENV } from './node-runtime-heal';
import {
  buildCronBlock, buildLaunchdPlist, buildSystemdUnit, CRON_BLOCK_START,
  repointCronNode, repointLaunchdNode, repointServiceNode, repointSystemdNode,
} from './service';

const BACKEND_PRELUDE = path.resolve(__dirname, '../../../provian-backend/src/core/bootstrap-node-ensure.ts');

/** The version + hash table as the backend prelude's SOURCE declares them. */
function preludePins(src: string): { version: string | null; pins: Record<string, string> } {
  const version = /BOOTSTRAP_NODE_VERSION\s*=\s*'([^']+)'/.exec(src)?.[1] ?? null;
  const table = /BOOTSTRAP_NODE_SHA256[^{]*\{([^}]*)\}/.exec(src)?.[1] ?? '';
  const pins: Record<string, string> = {};
  for (const m of table.matchAll(/'([a-z0-9-]+)':\s*'([0-9a-f]{64})'/g)) pins[m[1]] = m[2];
  return { version, pins };
}

describe('pin parity with the curl install line (bootstrap-node-ensure.ts)', () => {
  const src = fs.readFileSync(BACKEND_PRELUDE, 'utf8');

  it('the daemon fetches exactly the build the install line fetches', () => {
    const p = preludePins(src);
    expect(Object.keys(p.pins).length).toBe(6); // a pass over zero pins is not a pass
    expect(p.version).toBe(PROVIAN_NODE_VERSION);
    expect(p.pins).toEqual(PROVIAN_NODE_SHA256);
  });

  it('RED: a prelude whose pin drifted is caught', () => {
    const drifted = src.replace(PROVIAN_NODE_SHA256['linux-x64'], '0'.repeat(64));
    expect(drifted).not.toBe(src);
    expect(preludePins(drifted).pins).not.toEqual(PROVIAN_NODE_SHA256);
    const bumped = src.replace(`'${PROVIAN_NODE_VERSION}'`, "'v22.99.0'");
    expect(preludePins(bumped).version).not.toBe(PROVIAN_NODE_VERSION);
  });
});

describe('layout (mirrors the prelude)', () => {
  it('POSIX: ~/.provian/node/bin/node; Windows: the version-named subdir', () => {
    expect(provianNodeBin('/home/a', 'linux', 'x64')).toBe('/home/a/.provian/node/bin/node');
    expect(provianNodeBin('/Users/a', 'darwin', 'arm64')).toBe('/Users/a/.provian/node/bin/node');
    expect(provianNodeBin('/h', 'win32', 'x64')).toBe(path.join('/h', '.provian', 'node', `node-${PROVIAN_NODE_VERSION}-win-x64`, 'node.exe'));
  });

  it('archive per platform; RED: an unpinned platform has none', () => {
    expect(nodeDistTarget('linux', 'x64')).toEqual({ key: 'linux-x64', file: `node-${PROVIAN_NODE_VERSION}-linux-x64.tar.gz`, kind: 'tar.gz' });
    expect(nodeDistTarget('win32', 'arm64')?.kind).toBe('zip');
    expect(nodeDistTarget('freebsd', 'x64')).toBeNull();
    expect(nodeDistTarget('linux', 'ia32')).toBeNull();
  });
});

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'provian-node-'));
}
const ARCHIVE_BYTES = Buffer.from('a stand-in node archive');
const PINS = { 'linux-x64': crypto.createHash('sha256').update(ARCHIVE_BYTES).digest('hex') };
const write = async (_u: string, dest: string): Promise<void> => { fs.writeFileSync(dest, ARCHIVE_BYTES); };
const extractNode = (_a: string, dir: string): void => {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'node'), 'new-node', { mode: 0o755 });
};
function withOldRuntime(home: string): string {
  const bin = provianNodeBin(home, 'linux', 'x64');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, 'old-node');
  return bin;
}
const base = (home: string) => ({ home, platform: 'linux' as const, arch: 'x64', pins: PINS, download: write, extract: extractNode, log: () => undefined, now: () => 1_000_000 });

describe('fetchProvianNode', () => {
  it('GREEN: verified, probed, installed in place of a stale runtime', async () => {
    const home = tmpHome();
    const bin = withOldRuntime(home);
    const probe = vi.fn(() => true);
    const r = await fetchProvianNode({ ...base(home), probe });
    expect(r).toEqual({ outcome: 'installed', bin });
    expect(fs.readFileSync(bin, 'utf8')).toBe('new-node');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.join(home, '.provian')).sort()).toEqual(['node', NODE_FETCH_MARKER]);
  });

  it('RED: a checksum mismatch installs nothing and never extracts', async () => {
    const home = tmpHome();
    const bin = withOldRuntime(home);
    const extract = vi.fn(extractNode);
    const r = await fetchProvianNode({ ...base(home), pins: { 'linux-x64': '0'.repeat(64) }, extract, probe: () => true });
    expect(r.outcome).toBe('failed');
    expect(extract).not.toHaveBeenCalled();
    expect(fs.readFileSync(bin, 'utf8')).toBe('old-node');
  });

  it('RED: a downloaded binary that fails the store probe is not installed', async () => {
    const home = tmpHome();
    const bin = withOldRuntime(home);
    const r = await fetchProvianNode({ ...base(home), probe: () => false });
    expect(r.outcome).toBe('failed');
    expect(fs.readFileSync(bin, 'utf8')).toBe('old-node');
    expect(fs.readdirSync(path.join(home, '.provian')).filter((f) => f.startsWith('node.'))).toEqual([]);
  });

  it('RED: a failed download is not retried inside the bound; force overrides it', async () => {
    const home = tmpHome();
    const download = vi.fn(async () => { throw new Error('offline'); });
    expect((await fetchProvianNode({ ...base(home), download, probe: () => true })).outcome).toBe('failed');
    const again = await fetchProvianNode({ ...base(home), download, probe: () => true, now: () => 1_000_000 + NODE_FETCH_RETRY_MS - 1 });
    expect(again.outcome).toBe('skipped');
    expect(download).toHaveBeenCalledTimes(1);
    const later = await fetchProvianNode({ ...base(home), probe: () => true, now: () => 1_000_000 + NODE_FETCH_RETRY_MS });
    expect(later.outcome).toBe('installed');
    const forced = await fetchProvianNode({ ...base(home), download, probe: () => true, force: true });
    expect(forced.outcome).toBe('failed');
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('RED: an unpinned platform downloads nothing', async () => {
    const download = vi.fn(write);
    const r = await fetchProvianNode({ ...base(tmpHome()), platform: 'freebsd', download, probe: () => true });
    expect(r.outcome).toBe('skipped');
    expect(download).not.toHaveBeenCalled();
  });
});

function spawnResult(status: number): SpawnSyncReturns<Buffer> {
  return { pid: 1, output: [], stdout: Buffer.from(''), stderr: Buffer.from(''), status, signal: null } as SpawnSyncReturns<Buffer>;
}
const DARK = '/usr/bin/node';
const CAPABLE = '/home/a/.provian/node/bin/node';

describe('ensureStoreCapableNodeRuntime (fetch, then re-exec)', () => {
  it('capable system Node26 still fetches and hands over to the pinned private runtime', async () => {
    let installed = false;
    const fetchNode = vi.fn(async () => { installed = true; return {outcome: 'installed' as const, bin: CAPABLE}; });
    const spawnSync = vi.fn((_file: string, _args?: readonly string[], _opts?: unknown) => spawnResult(0));
    await ensureStoreCapableNodeRuntime({currentCanRead: true, currentExecPath: DARK, candidateBin: CAPABLE, env: {}, exists: () => installed, probeBinary: () => true, fetchNode, spawnSync, exit: vi.fn() as unknown as (c: number) => never, log: () => undefined});
    expect(fetchNode).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0][0]).toBe(CAPABLE);
  });
  it('GREEN: a dark runtime with NO ~/.provian/node fetches it and re-execs onto it, naming where it came from', async () => {
    const onDisk = new Set<string>();
    const fetchNode = vi.fn(async () => { onDisk.add(CAPABLE); return { outcome: 'installed' as const, bin: CAPABLE }; });
    const spawnSync = vi.fn((_file: string, _args?: readonly string[], _opts?: unknown) => spawnResult(0));
    const exit = vi.fn() as unknown as (c: number) => never;
    await ensureStoreCapableNodeRuntime({
      currentCanRead: false, currentExecPath: DARK, candidateBin: CAPABLE, env: {}, argv: ['/home/a/.provian/agent.js', 'observe'],
      exists: (p) => onDisk.has(p), probeBinary: () => true, fetchNode, spawnSync, exit, log: () => undefined,
    });
    expect(fetchNode).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = spawnSync.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(bin).toBe(CAPABLE);
    expect(argv).toEqual(['/home/a/.provian/agent.js', 'observe']);
    expect(opts.env[SELFHEAL_GUARD_ENV]).toBe('1');
    expect(opts.env[SELFHEAL_FROM_ENV]).toBe(DARK);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a capable ~/.provian/node already present is used without a fetch', async () => {
    const fetchNode = vi.fn();
    const spawnSync = vi.fn((_file: string, _args?: readonly string[], _opts?: unknown) => spawnResult(0));
    await ensureStoreCapableNodeRuntime({
      currentCanRead: false, currentExecPath: DARK, candidateBin: CAPABLE, env: {}, argv: ['x'],
      exists: () => true, probeBinary: () => true, fetchNode, spawnSync, exit: vi.fn() as unknown as (c: number) => never, log: () => undefined,
    });
    expect(fetchNode).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('RED: a capable runtime fetches nothing and re-execs nothing', async () => {
    const fetchNode = vi.fn();
    const spawnSync = vi.fn();
    await ensureStoreCapableNodeRuntime({ currentCanRead: true, currentExecPath: CAPABLE, candidateBin: CAPABLE, env: {}, fetchNode, spawnSync, log: () => undefined });
    expect(fetchNode).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('RED: a failed fetch re-execs nothing (the heartbeat alarm reports the darkness)', async () => {
    const spawnSync = vi.fn();
    const exit = vi.fn();
    await expect(ensureStoreCapableNodeRuntime({
      currentCanRead: false, currentExecPath: DARK, candidateBin: CAPABLE, env: {}, exists: () => false, probeBinary: () => true,
      fetchNode: async () => ({ outcome: 'failed' as const, reason: 'offline' }), spawnSync, exit: exit as unknown as (c: number) => never, log: () => undefined,
    })).rejects.toThrow('Installer Node 22 unavailable');
    expect(spawnSync).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('RED (loop guard): an already re-exec\'d child never fetches', async () => {
    const fetchNode = vi.fn();
    const spawnSync = vi.fn();
    await expect(ensureStoreCapableNodeRuntime({
      currentCanRead: false, currentExecPath: CAPABLE, env: { [SELFHEAL_GUARD_ENV]: '1' }, exists: () => false,
      fetchNode, spawnSync, log: () => undefined,
    })).rejects.toThrow('handover failed');
    expect(fetchNode).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe('repoint the units a heal leaves behind (against the installers\' own text)', () => {
  const EP = { command: DARK, args: ['/home/a/.provian/agent.js', 'observe'] };

  it('cron: only Provian\'s block, every line', () => {
    const user = `0 5 * * * ${"'"}${DARK}${"'"} /opt/backup.js`;
    const crontab = `${user}\n${buildCronBlock(EP, {}, '/home/a')}\n`;
    const next = repointCronNode(crontab, DARK, CAPABLE);
    expect(next).toBe(`${user}\n${buildCronBlock({ ...EP, command: CAPABLE }, {}, '/home/a')}\n`);
    expect(next?.split('\n')[0]).toBe(user); // RED control: the user's own line keeps its node
    expect(next).toContain(CRON_BLOCK_START);
  });

  it('systemd: ExecStart only', () => {
    const unit = buildSystemdUnit(EP, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }, '/home/a', '/home/a/.provian/observer.log');
    expect(repointSystemdNode(unit, DARK, CAPABLE)).toBe(buildSystemdUnit({ ...EP, command: CAPABLE }, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }, '/home/a', '/home/a/.provian/observer.log'));
  });

  it('launchd: ProgramArguments[0] only', () => {
    const plist = buildLaunchdPlist(EP, {}, '/Users/a', '/Users/a/.provian/observer.log');
    expect(repointLaunchdNode(plist, DARK, CAPABLE)).toBe(buildLaunchdPlist({ ...EP, command: CAPABLE }, {}, '/Users/a', '/Users/a/.provian/observer.log'));
  });

  it('RED: a unit baked with a different node is left alone', () => {
    const other = { ...EP, command: '/opt/node22/bin/node' };
    expect(repointCronNode(buildCronBlock(other, {}, '/home/a'), DARK, CAPABLE)).toBeNull();
    expect(repointSystemdNode(buildSystemdUnit(other, {}, '/home/a', '/l'), DARK, CAPABLE)).toBeNull();
    expect(repointLaunchdNode(buildLaunchdPlist(other, {}, '/Users/a', '/l'), DARK, CAPABLE)).toBeNull();
    // a node path that only PREFIXES the baked one is not a match
    expect(repointSystemdNode(buildSystemdUnit({ ...EP, command: `${DARK}20` }, {}, '/home/a', '/l'), DARK, CAPABLE)).toBeNull();
  });

  it('driver: writes what changed, daemon-reloads systemd, never restarts; RED: from === to does nothing', () => {
    const files = new Map<string, string>([
      ['/u/plist', buildLaunchdPlist(EP, {}, '/home/a', '/l')],
      ['/u/unit', buildSystemdUnit(EP, {}, '/home/a', '/l')],
    ]);
    let crontab = buildCronBlock(EP, {}, '/home/a');
    const daemonReload = vi.fn();
    const deps = {
      plistPath: '/u/plist', systemdUnitPath: '/u/unit',
      readFile: (p: string) => files.get(p) ?? null, writeFile: (p: string, c: string) => { files.set(p, c); },
      readCrontab: () => crontab, writeCrontab: (c: string) => { crontab = c; }, daemonReload,
    };
    expect(repointServiceNode(DARK, DARK, deps)).toEqual([]);
    expect(daemonReload).not.toHaveBeenCalled();
    expect(repointServiceNode(DARK, CAPABLE, deps)).toEqual(['launchd', 'systemd', 'cron']);
    expect(daemonReload).toHaveBeenCalledTimes(1);
    expect(files.get('/u/unit')).toContain(`ExecStart=${CAPABLE} `);
    expect(crontab).toContain(`'${CAPABLE}' `);
    expect(repointServiceNode(DARK, CAPABLE, deps)).toEqual([]); // idempotent
  });
});

describe('review fixes ', () => {
  it('GREEN: a daemon running ON a stale ~/.provian/node (the v22.11.0 pin) fetches over it and re-execs onto the replaced path', async () => {
    const spawnSync = vi.fn((_file: string, _args?: readonly string[], _opts?: unknown) => spawnResult(0));
    const exit = vi.fn() as unknown as (c: number) => never;
    const fetchNode = vi.fn(async () => ({ outcome: 'installed' as const, bin: CAPABLE }));
    await ensureStoreCapableNodeRuntime({
      currentCanRead: false, currentExecPath: CAPABLE, candidateBin: CAPABLE, env: {}, argv: ['a.js', 'observe'],
      exists: () => true, probeBinary: () => false, fetchNode, spawnSync, exit, log: () => undefined,
    });
    expect(fetchNode).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect((spawnSync.mock.calls[0] as unknown as [string])[0]).toBe(CAPABLE);
  });

  it('RED: the same stale path with a failed fetch re-execs nothing', async () => {
    const spawnSync = vi.fn();
    await expect(ensureStoreCapableNodeRuntime({
      currentCanRead: false, currentExecPath: CAPABLE, candidateBin: CAPABLE, env: {}, exists: () => true, probeBinary: () => false,
      fetchNode: async () => ({ outcome: 'failed' as const, reason: 'offline' }), spawnSync, exit: vi.fn() as unknown as (c: number) => never, log: () => undefined,
    })).rejects.toThrow('Installer Node 22 unavailable');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('Windows: the new build moves into its own version subdir; a running older build\'s dir is never renamed', async () => {
    const home = tmpHome();
    const oldDir = path.join(home, '.provian', 'node', 'node-v22.11.0-win-x64');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'node.exe'), 'old-node');
    const extractWin = (_a: string, dir: string): void => {
      const sub = path.join(dir, `node-${PROVIAN_NODE_VERSION}-win-x64`);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 'node.exe'), 'new-node');
    };
    const r = await fetchProvianNode({ ...base(home), platform: 'win32', pins: { 'win-x64': PINS['linux-x64'] }, extract: extractWin, probe: () => true });
    const bin = provianNodeBin(home, 'win32', 'x64');
    expect(r).toEqual({ outcome: 'installed', bin });
    expect(fs.readFileSync(bin, 'utf8')).toBe('new-node');
    expect(fs.readFileSync(path.join(oldDir, 'node.exe'), 'utf8')).toBe('old-node');
    expect(fs.readdirSync(path.join(home, '.provian')).filter((f) => f.startsWith('node.'))).toEqual([]);
  });
});

describe('daemon wiring (run-daemon.ts)', () => {
  it('a healed child gets back the node it came from and both markers leave its environment', async () => {
    const { prepareNodeRuntimeAtStart } = await import('./run-daemon.js');
    const env: NodeJS.ProcessEnv = { [SELFHEAL_GUARD_ENV]: '1', [SELFHEAL_FROM_ENV]: DARK, KEEP: 'x' };
    const ensure = vi.fn(async () => undefined);
    expect(await prepareNodeRuntimeAtStart({ env, ensure })).toBe(DARK);
    expect(ensure).toHaveBeenCalledWith(env);
    expect(env).toEqual({ KEEP: 'x' }); // RED control: a leaked guard would disable the successor's heal
    expect(await prepareNodeRuntimeAtStart({ env: {}, ensure })).toBeNull();
  });

  it('re-points units only after a heal', async () => {
    const { repointUnitsAfterHeal } = await import('./run-daemon.js');
    const repoint = vi.fn(() => ['systemd']);
    expect(repointUnitsAfterHeal(null, CAPABLE, repoint, () => undefined)).toEqual([]);
    expect(repoint).not.toHaveBeenCalled();
    expect(repointUnitsAfterHeal(DARK, CAPABLE, repoint, () => undefined)).toEqual(['systemd']);
    expect(repoint).toHaveBeenCalledWith(DARK, CAPABLE);
  });

  it('the startup step runs for every device (before the owner type exists) and its result feeds the repoint', () => {
    const src = fs.readFileSync(path.join(__dirname, 'run-daemon.ts'), 'utf8');
    const calls = src.match(/await prepareNodeRuntimeAtStart\(\)/g) ?? [];
    expect(calls.length).toBe(1);
    const at = src.indexOf('const healedFromNode = await prepareNodeRuntimeAtStart();');
    const owner = src.indexOf("const ownerType = creds.ownerType ?? 'human';");
    expect(at).toBeGreaterThan(0);
    expect(owner).toBeGreaterThan(at); // RED: wrapping it in `if (isAgentDevice)` cannot compile here
    expect((src.match(/repointUnitsAfterHeal\(healedFromNode, process\.execPath\)/g) ?? []).length).toBe(1);
  });
});
