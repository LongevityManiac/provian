/**
 * self-update-io — the REAL filesystem side effects for self-update, kept apart
 * from the pure decision logic (`self-update.ts`) so that logic stays testable
 * with fakes and the file-touching bytes live in one small, auditable place.
 *
 * The apply is deliberately a temp-write → fsync → atomic rename: the running
 * bundle is either the whole old file or the whole new one, never a half-written
 * mix, even if the process dies mid-write. Re-exec is `process.exit(0)`: the
 * daemon is deployed under a KeepAlive supervisor (launchd / systemd), which
 * relaunches it — reading the just-swapped bytes. `isObserverRunning` liveness-
 * checks the pidfile (`process.kill(pid,0)`), so the exited process's stale
 * pidfile does not block that relaunch.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SelfUpdateIO } from './self-update';

/** Where the last-applied release version is persisted (monotonic guard). */
export const RELEASE_VERSION_FILE = path.join(os.homedir(), '.provian', 'release-version');

/**
 * Atomically replace `target` with `bytes`. Writes a sibling temp file in the
 * SAME directory (so the rename stays on one filesystem and is atomic), fsyncs
 * it, preserves the original file's mode, and renames over the target. On any
 * failure before the rename the original file is untouched.
 */
export function atomicReplaceFile(target: string, bytes: Buffer): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.new-${process.pid}-${Date.now()}`);
  let mode = 0o644;
  try { mode = fs.statSync(target).mode; } catch { /* new file → default mode */ }
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(tmp, mode); } catch { /* best-effort */ }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* leave no temp behind */ }
    throw err;
  }
}

export interface RealSelfUpdateIODeps {
  fetchManifest: () => Promise<{ body: unknown; bytes: number }>;
  fetchBundle: () => Promise<Buffer>;
  targetPath: string;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  /** Override for tests; production re-exec is exit(0) → supervisor relaunch. */
  reExec?: () => void;
  /** Override for tests. */
  versionFile?: string;
}

/** Build a real `SelfUpdateIO` backed by the filesystem. */
export function buildSelfUpdateIO(deps: RealSelfUpdateIODeps): SelfUpdateIO {
  const versionFile = deps.versionFile ?? RELEASE_VERSION_FILE;
  return {
    fetchManifest: deps.fetchManifest,
    fetchBundle: deps.fetchBundle,
    readCurrent: () => {
      try { return fs.readFileSync(deps.targetPath); } catch { return null; }
    },
    applyBytes: (bytes) => atomicReplaceFile(deps.targetPath, bytes),
    readVersion: () => {
      try {
        const v = parseInt(fs.readFileSync(versionFile, 'utf8').trim(), 10);
        return Number.isInteger(v) && v > 0 ? v : 0;
      } catch { return 0; }
    },
    writeVersion: (v) => {
      try {
        fs.mkdirSync(path.dirname(versionFile), { recursive: true });
        fs.writeFileSync(versionFile, String(v), 'utf8');
      } catch { /* best-effort — the identical-bytes check still breaks any loop */ }
    },
    reExec: deps.reExec ?? (() => process.exit(0)),
    log: deps.log,
    nodeVersion: process.version,
  };
}
