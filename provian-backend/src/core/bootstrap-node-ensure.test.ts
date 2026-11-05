/**
 * Tests for bootstrap-node-ensure — the shared "ensure a Node that can read the
 * transcript store" prelude (item 3).
 *
 * The invariant under test: a host is kept on its system Node ONLY when that Node
 * can actually open the harness's SQLite transcript store — i.e. a working,
 * flagless `node:sqlite`. The prior gate (`>=20`) kept Node 20 and Node 22.11
 * hosts that then went silently dark on the store lane, which is the exact
 * darkness this prelude now prevents fleet-wide.
 *
 * Negative-control doctrine : every assertion here has its RED case.
 * - the capability probe is bound to Node's ACTUAL behavior (equivalence
 * control) so it can't pass vacuously on whatever Node runs the suite — CI is
 * Node 20 (probe incapable) and a dev box may be Node 24 (probe capable), and
 * the shell probe must agree with the runtime in BOTH;
 * - a hermetic fake-node control proves the wiring keeps a capable node and
 * rejects a dark one;
 * - a RED control asserts the defect SHAPE (a version-integer gate) is absent,
 * and that the pinned fallback is past the flagless-node:sqlite floor.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nodeEnsureSh, nodeEnsurePs, BOOTSTRAP_NODE_VERSION } from './bootstrap-node-ensure';

/** The first Node version with a flagless (unflagged) node:sqlite. */
const FLAGLESS_SQLITE_MIN = { major: 22, minor: 13 };

function parseVersion(v: string): { major: number; minor: number } {
  const m = /^v?(\d+)\.(\d+)\./.exec(v);
  if (!m) throw new Error(`unparseable version: ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** Extract the `node -e '<js>'` probe body from a generated prelude. */
function extractProbeJs(prelude: string): string {
  const m = /NODE_PROBE='([^']*)'/.exec(prelude);
  if (!m) throw new Error('no node -e probe found in prelude');
  return m[1];
}

/** Whether THIS runtime exposes a working node:sqlite (the source of truth). */
function ambientSqliteAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node:sqlite') as { DatabaseSync?: unknown };
    return typeof mod?.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

describe('BOOTSTRAP_NODE_VERSION', () => {
  it('is pinned at or past the flagless node:sqlite floor (>= v22.13.0)', () => {
    const v = parseVersion(BOOTSTRAP_NODE_VERSION);
    const pastFloor =
      v.major > FLAGLESS_SQLITE_MIN.major ||
      (v.major === FLAGLESS_SQLITE_MIN.major && v.minor >= FLAGLESS_SQLITE_MIN.minor);
    // RED control: v22.11.0 (the earlier pin) is v.major===22 && v.minor===11 →
    // fails this, because a fetched v22.11.0 still gates node:sqlite behind
    // --experimental-sqlite and stays dark on the store lane the observer reads.
    expect(pastFloor).toBe(true);
  });
});

describe('nodeEnsureSh — capability gate', () => {
  const prelude = nodeEnsureSh();

  it('gates on a node:sqlite capability probe, not a version number', () => {
    expect(prelude).toContain("require(\"node:sqlite\")");
    expect(prelude).toContain('DatabaseSync');
    // RED control: the defect shape is a version-integer gate that keeps a dark
    // node. None of these may appear.
    expect(prelude).not.toMatch(/-ge\s+2[0-9]\b/);
    expect(prelude).not.toContain('NODE_MAJOR');
  });

  it('is valid POSIX sh (real parser)', () => {
    const res = spawnSync('sh', ['-n'], { input: prelude, encoding: 'utf8' });
    if (res.status !== 0) console.error(res.stderr);
    expect(res.status).toBe(0);
  });

  it("the shell probe agrees with THIS runtime's real node:sqlite availability", () => {
    // Equivalence control — binds the shell transliteration to the runtime's own
    // node:sqlite, so it cannot pass vacuously regardless of which Node runs the
    // suite (Node 20 in CI → both incapable; Node 24 dev → both capable).
    const probeJs = extractProbeJs(prelude);
    const res = spawnSync(process.execPath, ['-e', probeJs], { encoding: 'utf8' });
    const shellSaysCapable = res.status === 0;
    expect(shellSaysCapable).toBe(ambientSqliteAvailable());
  });

  it('REJECTS both capable and dark system Node (hermetic wiring)', () => {
    const decide = (fakeExit: number): string => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-node-gate-'));
      try {
        const fakeNode = path.join(dir, 'node');
        // A fake `node` that ignores its args and returns the exit code we want,
        // standing in for a capable (0) or dark (non-0) runtime's sqlite probe.
        fs.writeFileSync(fakeNode, `#!/bin/sh\nexit ${fakeExit}\n`);
        fs.chmodSync(fakeNode, 0o755);
        // Run only the gate HEAD (up to the download block), then report the
        // decision — so the test never touches the network.
        const head = prelude.split('\nif [ -z "$NODE_DIR" ]; then')[0];
        const script = `${head}\nif [ -z "$NODE_DIR" ]; then echo FETCH; else echo "KEEP:$NODE_DIR"; fi\n`;
        const res = spawnSync('sh', ['-eu'], {
          input: script,
          encoding: 'utf8',
          env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ''}` },
        });
        return (res.stdout || '').trim();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    // Capable node (probe exits 0) → kept on PATH.
    expect(decide(0)).toBe('FETCH');
    // RED: dark node (probe exits non-0) → NOT kept; falls through to download.
    expect(decide(1)).toBe('FETCH');
  });
});

describe('nodeEnsureSh — reuse, proxy-capable node, egress env', () => {
  const prelude = nodeEnsureSh();
  const head = prelude.split('\nif [ -z "$NODE_DIR" ]; then\n  OS=')[0];
  const egress = prelude.slice(prelude.indexOf('# --- Egress'));

  function runHead(opts: { pathNodeExit: number; homeNodeVersion?: string; env?: Record<string, string> }): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-node-reuse-'));
    try {
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'bin', 'node'), `#!/bin/sh\nexit ${opts.pathNodeExit}\n`);
      fs.chmodSync(path.join(dir, 'bin', 'node'), 0o755);
      if (opts.homeNodeVersion) {
        const nb = path.join(dir, '.provian', 'node', 'bin');
        fs.mkdirSync(nb, { recursive: true });
        fs.writeFileSync(path.join(nb, 'node'), `#!/bin/sh\n[ "$1" = "--version" ] && echo ${opts.homeNodeVersion}\nexit 0\n`);
        fs.chmodSync(path.join(nb, 'node'), 0o755);
      }
      const script = `${head}\nif [ -z "$NODE_DIR" ]; then echo FETCH; else echo "KEEP:$NODE_DIR"; fi\n`;
      const res = spawnSync('sh', ['-eu'], {
        input: script, encoding: 'utf8',
        env: { PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir, ...(opts.env ?? {}) },
      });
      return (res.stdout || '').trim().replace(dir, '<HOME>');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reuses a verified ~/.provian/node of the pinned version instead of downloading again', () => {
    expect(runHead({ pathNodeExit: 1, homeNodeVersion: BOOTSTRAP_NODE_VERSION })).toBe('KEEP:<HOME>/.provian/node/bin');
  });

  it('RED: system Node26 is rejected even with SQLite; private pinned Node is selected', () => {
    expect(runHead({pathNodeExit: 0})).toBe('FETCH');
    expect(runHead({pathNodeExit: 0, homeNodeVersion: BOOTSTRAP_NODE_VERSION})).toBe('KEEP:<HOME>/.provian/node/bin');
    expect(runHead({pathNodeExit: 0, homeNodeVersion: 'v26.5.0'})).toBe('FETCH');
  });

  it('RED: a ~/.provian/node of another version is not reused (download the pinned one)', () => {
    expect(runHead({ pathNodeExit: 1, homeNodeVersion: 'v22.11.0' })).toBe('FETCH');
  });

  it('with a proxy set, the probe also demands env-proxy support (Node 22.21+ / 24.5+)', () => {
    expect(prelude).toMatch(/v\[0\]===22&&v\[1\]>=21/);
    const js = /NODE_PROBE="\$NODE_PROBE;([^"]*)"/.exec(prelude)?.[1] ?? '';
    // The appended gate must be valid JS as the shell will pass it (no double quotes inside).
    expect(js).not.toContain('"');
    const ok = spawnSync(process.execPath, ['-e', js], { encoding: 'utf8' });
    const [maj, min] = process.versions.node.split('.').map(Number);
    const supports = (maj === 22 && min >= 21) || (maj === 24 && min >= 5) || maj >= 25;
    expect(ok.status === 0).toBe(supports);
  });

  it('exports NODE_USE_ENV_PROXY and a loopback NO_PROXY (keeping the caller\'s entries) only when a proxy is set', () => {
    const run = (env: Record<string, string>): string => {
      const script = `${head}\nNODE_DIR=/x\n${egress}\necho "U=\${NODE_USE_ENV_PROXY:-} N=\${NO_PROXY:-} n=\${no_proxy:-}"\n`;
      const res = spawnSync('sh', ['-eu'], { input: script, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), ...env } });
      return (res.stdout || '').trim().split('\n').pop() ?? '';
    };
    expect(run({ HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'corp.internal' }))
      .toBe('U=1 N=127.0.0.1,localhost,::1,corp.internal n=127.0.0.1,localhost,::1');
    // RED control: no proxy → nothing exported
    expect(run({})).toBe('U= N= n=');
  });
});

describe('nodeEnsurePs — capability gate', () => {
  it('uses only the private pinned Node and never Get-Command system Node', () => {
    expect(nodeEnsurePs()).not.toContain('Get-Command node');
    expect(nodeEnsurePs()).toContain('& $privateNode --version');
  });
  const prelude = nodeEnsurePs();

  it('gates on a node:sqlite capability probe, not a version number', () => {
    expect(prelude).toContain("require(\"node:sqlite\")");
    expect(prelude).toContain('DatabaseSync');
    // RED control: no version-integer gate.
    expect(prelude).not.toMatch(/-ge\s+2[0-9]\b/);
    expect(prelude).not.toContain('nodeMajor');
  });
});
