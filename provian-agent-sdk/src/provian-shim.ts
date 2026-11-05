/**
 * `~/.provian/bin/provian` a one-line wrapper so a hosted agent can type
 * `"$HOME/.provian/bin/provian" <verb>` from its shell instead of `<node> ~/.provian/agent.js <verb>`
 *.
 *
 * The wrapper execs an ABSOLUTE node — the runtime that wrote it (`process.execPath`), exactly as
 * the git hook bakes its node (`hook-install.ts::resolveReportPeCmd`). A hosted box may have no
 * `node` on PATH at all: the bootstrap prelude fetches a private runtime to
 * `~/.provian/node/bin/node` and runs the bundle with it, so a bare `exec node` would fail there
 * ( , defect 5). Because the content names the runtime, the wrapper is rewritten
 * whenever the runtime moves: it is (re)written on every daemon start, on `repair`, and whenever
 * an act verb runs, each by the node running the bundle — so a runtime heal (the daemon re-exec'd
 * onto a store-capable node) carries into the wrapper on the next start.
 *
 * Idempotent (rewritten only when its content differs), 0755, and it only ever names the hosted
 * bundle path. Never throws.
 */
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { resolveStoreCapableNodeBin } from './observer/node-runtime-heal';

export function provianShimPath(home: string = homedir()): string {
  return path.join(home, '.provian', 'bin', 'provian');
}

/** Set by the wrapper on a command the agent typed (see the `observe` verb in bootstrap.ts). */
export const SHIM_ENV = 'PROVIAN_VIA_SHIM';

/**
 * Read AND remove the wrapper's marker from this process's environment (review r2 #1).
 * The marker describes the command the agent typed — it must never ride into a daemon this
 * process spawns (`configure` / `repair` restart the observer; a daemon that inherited it
 * would read itself as a second `observe` request and exit). Call once, at entry.
 */
export function takeShimMarker(env: NodeJS.ProcessEnv = process.env): boolean {
  const via = env[SHIM_ENV] === '1';
  delete env[SHIM_ENV];
  return via;
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The wrapper's exact bytes (pure — unit-testable). `nodeBin` is an absolute node path. */
export function provianShimContent(bundlePath: string, nodeBin: string): string {
  return [
    '#!/bin/sh',
    '# Provian agent verbs — `provian help` lists them. Written by the Provian install; safe to delete.',
    '# Marks a command the agent typed: `observe` through this wrapper starts the daemon detached and',
    '# returns (never runs it in the agent\'s shell).',
    `${SHIM_ENV}=1 exec ${shQuote(nodeBin)} ${shQuote(bundlePath)} "$@"`,
    '',
  ].join('\n');
}

export type ShimOutcome = 'installed' | 'updated' | 'unchanged' | 'skipped' | 'error';

/**
 * Write the wrapper for `bundlePath`, when the running artifact IS the hosted single-file bundle
 * (`~/.provian/agent.js`). A package install has its own `provian`/`agent-sdk` bins; nothing is
 * written for it. `nodeBin` defaults to the store-capable runtime; a non-absolute value is refused
 * ('error') rather than baked, since the whole point is not to depend on PATH.
 */
export function ensureProvianShim(
  bundlePath: string | undefined,
  home: string = homedir(),
  // the store-capable node (the running one when it can read the harness
  // stores, else ~/.provian/node), never a Node 20 that happened to run the writer.
  nodeBin: string = resolveStoreCapableNodeBin(),
): ShimOutcome {
  try {
    const hosted = path.join(home, '.provian', 'agent.js');
    if (!bundlePath || path.resolve(bundlePath) !== path.resolve(hosted)) return 'skipped';
    if (!nodeBin || !path.isAbsolute(nodeBin)) return 'error';
    const target = provianShimPath(home);
    const content = provianShimContent(hosted, nodeBin);
    let existing: string | null = null;
    try { existing = fs.readFileSync(target, 'utf8'); } catch { existing = null; }
    if (existing === content) return 'unchanged';
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o755 });
    fs.renameSync(tmp, target);
    try { fs.chmodSync(target, 0o755); } catch { /* best effort on non-POSIX FS */ }
    return existing === null ? 'installed' : 'updated';
  } catch {
    return 'error';
  }
}
