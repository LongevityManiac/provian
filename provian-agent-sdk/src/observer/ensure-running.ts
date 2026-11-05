/**
 * ensure-running — the Grok `SessionStart` command hook's body
 * (`node <entry> observe --ensure-running`).
 *
 * WHY. The daemon's Grok proxy repoint lives in Grok's own config file, so it is
 * durable: while it is in place, Grok sends every model call to the daemon's
 * loopback shim (127.0.0.1:4320). If the daemon is down when Grok starts, those
 * calls get "connection refused" and Grok is broken. The repoint is removed on a
 * clean daemon shutdown, on uninstall, on opt-out and when the shim fails to
 * bind; what remains is a daemon that died without cleaning up (a crash, a
 * kill -9, a power loss). For that case Grok's `SessionStart` hook runs this:
 *
 *   1. If the shim port is already accepting connections → exit 0 at once (the
 *      common case costs one loopback connect).
 *   2. Otherwise start the daemon through whatever supervises it on this box —
 *      `launchctl kickstart` (launchd), `systemctl --user start` (systemd) — or,
 *      with no supervisor installed, a detached `observe --if-not-running`
 *      (which is a no-op when a daemon already holds the lock).
 *   3. Wait until the shim is listening, bounded by `waitMs` (≤ 4 s — Grok's
 *      hook timeout is 5 s), then exit 0.
 *
 * FAIL-OPEN, ALWAYS. Every step is best-effort and the process always exits 0;
 * it never blocks Grok longer than the bound. It writes nothing to stdout
 * (Grok ignores SessionStart stdout anyway, and the hook discards it).
 *
 * RESIDUAL (stated in CAPTURE_ARCHITECTURE): on a box with no supervisor, a
 * daemon that crashes while a Grok session is ALREADY running leaves that
 * session's model calls failing until the next Grok start (which runs this hook).
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { homedir } from 'os';
import { execFileSync, spawn } from 'child_process';

/** Upper bound on how long the hook waits for the shim (Grok's own timeout is 5 s). */
export const ENSURE_RUNNING_MAX_WAIT_MS = 4_000;
const POLL_MS = 100;

export type EnsureOutcome = 'already_listening' | 'started_listening' | 'started_timeout' | 'start_failed';

export interface EnsureDeps {
  /** Is something accepting connections on 127.0.0.1:port? */
  probe(port: number): Promise<boolean>;
  /** Start the daemon (best-effort); returns how, or null when nothing could be started. */
  start(): string | null;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The pure control flow (testable with fakes). Never throws. */
export async function ensureDaemonRunning(port: number, deps: EnsureDeps, waitMs = ENSURE_RUNNING_MAX_WAIT_MS): Promise<EnsureOutcome> {
  const bound = Math.min(Math.max(0, waitMs), ENSURE_RUNNING_MAX_WAIT_MS);
  try {
    if (await deps.probe(port)) return 'already_listening';
    let how: string | null = null;
    try { how = deps.start(); } catch { how = null; }
    if (how === null) return 'start_failed';
    const deadline = deps.now() + bound;
    while (deps.now() < deadline) {
      await deps.sleep(POLL_MS);
      if (await deps.probe(port)) return 'started_listening';
    }
    return 'started_timeout';
  } catch {
    return 'start_failed';
  }
}

/** One loopback TCP connect with a short timeout. */
export function probeLoopbackPort(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Start the daemon the way this box supervises it. Returns the method used, or
 * null. Each supervisor call is bounded (2 s) and best-effort.
 */
export function startDaemonForEnsure(opts: {
  entry: string;
  execPath?: string;
  platform?: NodeJS.Platform;
  home?: string;
  launchdLabel: string;
  supervisorEnv: string;
  logFile: string;
}): string | null {
  const home = opts.home ?? homedir();
  const viaService = startInstalledService(opts);
  if (viaService !== null) return viaService;
  // No (working) supervisor: a detached daemon. `--if-not-running` makes it a
  // no-op when one already holds the lock (e.g. a cron-started daemon).
  try {
    const out = fs.openSync(opts.logFile, 'a');
    const child = spawn(opts.execPath ?? process.execPath, [opts.entry, 'observe', '--if-not-running'], {
      detached: true, stdio: ['ignore', out, out], cwd: home,
      env: { ...process.env, [opts.supervisorEnv]: 'detached' },
    });
    child.unref();
    return 'detached';
  } catch {
    return null;
  }
}

/** Is a Provian service installed on this box (a launchd plist / systemd user unit)? */
export function installedServiceKind(opts: { platform?: NodeJS.Platform; home?: string; launchdLabel: string }): 'launchd' | 'systemd' | null {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  if (platform === 'darwin' && fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${opts.launchdLabel}.plist`))) return 'launchd';
  if (platform === 'linux' && fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'provian-observer.service'))) return 'systemd';
  return null;
}

/**
 * Start the INSTALLED service (launchd kickstart/load, systemd --user start) — never a detached
 * daemon. Returns the method, or null when no service is installed or it would not start.
 */
export function startInstalledService(opts: { platform?: NodeJS.Platform; home?: string; launchdLabel: string }): 'launchd' | 'systemd' | null {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const quiet = { stdio: 'ignore' as const, timeout: 2_000 };
  if (platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${opts.launchdLabel}.plist`);
    if (fs.existsSync(plist)) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (uid !== null) {
        try { execFileSync('launchctl', ['kickstart', `gui/${uid}/${opts.launchdLabel}`], quiet); return 'launchd'; } catch { /* not loaded */ }
      }
      try { execFileSync('launchctl', ['load', plist], quiet); return 'launchd'; } catch { /* fall through */ }
    }
  }
  if (platform === 'linux') {
    const unit = path.join(home, '.config', 'systemd', 'user', 'provian-observer.service');
    if (fs.existsSync(unit)) {
      try { execFileSync('systemctl', ['--user', 'start', 'provian-observer.service'], quiet); return 'systemd'; } catch { /* no user manager */ }
    }
  }
  return null;
}
