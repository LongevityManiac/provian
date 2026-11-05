/**
 * Cross-platform observer service installer.
 *
 * Installs a launchd LaunchAgent on macOS, a systemd user unit on Linux, and a
 * per-user Scheduled Task (runs at logon) on Windows, so the observer
 * auto-starts and survives a reboot on every desktop OS. Falls back to a
 * detached background process on anything else.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, execFileSync, spawn } from 'child_process';
import { homedir, platform } from 'os';
import { getProvianDir } from '../scripts/credentials';
import { OTLP_DEFAULT_PORT } from './plugins/OTelPlugin';
import { resolveRuntimeTarget, SourceTreeRefusal, type RuntimeProbe } from './runtime-install';
import { resolveStoreCapableNodeBin } from './node-runtime-heal';
import {
  installRestartHook, uninstallRestartHook, resolveRestartHookOptOut, restartHookInstalled,
  probeCronDaemon, probeInstallShellSourcesRc, recordInstallShellProbe, resolveRestartMechanism,
  restartHookFired, type RestartMechanism,
} from './restart-hook';
import { cliCommand, HOSTED_BUNDLE } from '../cli-command';
import { SHIM_ENV } from '../provian-shim';

export const PID_FILE = path.join(homedir(), '.provian', 'observer.pid');
export const OBSERVER_LOG = path.join(homedir(), '.provian', 'observer.log');

export const LAUNCHD_LABEL = 'ai.provian.observer';
const LAUNCHD_PLIST = path.join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_DIR = path.join(homedir(), '.config', 'systemd', 'user');
const SYSTEMD_UNIT = path.join(SYSTEMD_DIR, 'provian-observer.service');

export const WINDOWS_TASK_NAME = 'ProvianObserver';
const WINDOWS_TASK_XML = path.join(homedir(), '.provian', 'observer-task.xml');

export interface ServiceInstallResult {
  method: 'launchd' | 'systemd' | 'cron' | 'scheduled_task' | 'detached';
  path?: string;
  pid?: number;
  /** the shell-startup restart hook is in place (Linux detached / cron). */
  restartHook?: boolean;
  /**
   * what actually restarts the daemon on this box — a service
   * manager, a RUNNING cron, a startup file this box's shell really sources, or the agent.
   */
  restartMechanism?: RestartMechanism;
}

export interface ObserverEntrypoint {
  command: string;
  args: string[];
}

export interface ServiceInstallOptions {
  /** Extra env vars injected into the service environment at install time. */
  env?: Record<string, string>;
  /**
   * Explicit exec target for the service. Overrides the auto-detected entrypoint.
   * The hosted onboarding bundle passes `node ~/.provian/agent.js observe` here,
   * because in that context there is no npm-installed SDK and observerEntrypoint()
   * would fall back to `npx @provian/agent-sdk observe` — unpublished (E404),
   * which exited 78 and left the observer dead.
   */
  entrypoint?: ObserverEntrypoint;
}

/** The compiled observer script that ships beside this module in an npm install. */
export function installedObserverScriptPath(): string {
  return path.resolve(__dirname, '..', 'scripts', 'start-observer.js');
}

export interface ObserverEntrypointContext {
  /**
   * Path of the hosted single-file bundle (`~/.provian/agent.js`) when the
   * caller is running INSIDE the `curl … | sh` bootstrap (the sh wrapper exports
   * PROVIAN_BUNDLE_PATH). Absent for a normal npm install.
   */
  bundlePath?: string;
  /** Node binary the service should exec (default: the running `process.execPath`). */
  execPath?: string;
  /** Compiled observer script in the installed package (default: dist/scripts/start-observer.js). */
  distObserverScript?: string;
  /** File-existence probe — injectable so every branch is unit-testable on any host. */
  exists?: (p: string) => boolean;
  /** Runtime-resolution probe — injectable for the same reason. */
  probe?: RuntimeProbe;
  /** Hosted-bundle location override (tests). */
  hostedBundle?: string;
  /** Module directory used to locate the installed package (tests). */
  moduleDir?: string;
}

/**
 * The ONE decision of what the auto-start service execs, made explicit:
 *
 *   1. hosted bundle context (`bundlePath` set)  → `node <bundle> observe`
 *      Pre-publish there is no npm-installed SDK on the machine; the bundle is
 *      the only runnable artifact, so the service runs the daemon FROM it.
 *   2. npm install (the compiled script is on disk) → `node dist/scripts/start-observer.js`
 *      Runs the installed package directly so login-time start never depends
 *      on npx/network. This is the branch `npx @provian/agent-sdk onboard` takes.
 *   3. neither on disk                              → `npx @provian/agent-sdk observe`
 *      Last resort only; unreachable from an installed package and fatal
 *      (E404 → exit 78) while the package is unpublished.
 *
 * Pure. `installService` and the one-command bootstrap both call it, so the
 * hosted flow and the npm flow choose by the same rule.
 */
export function resolveObserverEntrypoint(ctx: ObserverEntrypointContext = {}): ObserverEntrypoint {
  // Persist only the private installer Node22 path. Async entrypoints prepare it
  // before service installation; stale services heal through the signed bundle.
  const execPath = ctx.execPath ?? resolveStoreCapableNodeBin();

  // The durable answer: a real copy under ~/.provian/runtime, or a genuine npm
  // install. resolveRuntimeTarget REFUSES a source checkout rather than baking
  // a path that dies with someone's working copy — the Atlas failure.
  try {
    const target = resolveRuntimeTarget({
      bundlePath: ctx.bundlePath || process.env.PROVIAN_BUNDLE_PATH,
      moduleDir: ctx.moduleDir ?? __dirname,
      probe: ctx.probe,
      hostedBundle: ctx.hostedBundle,
    });
    return { command: execPath, args: target.observerArgs };
  } catch (err) {
    if (!(err instanceof SourceTreeRefusal)) throw err;
    // A developer running from a checkout still gets a working service; what
    // they do NOT get is a baked source path, so the refusal is surfaced and
    // the entrypoint falls through to the explicit override or npx.
    if (ctx.distObserverScript) {
      const exists = ctx.exists ?? ((p: string) => fs.existsSync(p));
      if (exists(ctx.distObserverScript)) {
        return { command: execPath, args: [ctx.distObserverScript] };
      }
    }
    return { command: 'npx', args: ['@provian/agent-sdk', 'observe'] };
  }
}

function observerEntrypoint(): ObserverEntrypoint {
  // Prefer running the compiled script directly so we don't depend on npx at
  // login time. Pass the installed dist script as the refusal fallback: on a
  // machine whose SDK is a source CHECKOUT (`npm install -g .`), resolveRuntime
  // REFUSES to bake the checkout path — but a built `dist/scripts/start-observer.js`
  // beside this module is a real, durable target and must be used before the
  // last-resort npx, which is unpublished (E404 → exit 78) and would install a
  // service that cannot start. Without this the refusal fell straight to that
  // dead npx, silently.
  const entrypoint = resolveObserverEntrypoint({
    distObserverScript: installedObserverScriptPath(),
  });
  // The one genuinely dead outcome while the package is unpublished: neither a
  // bundle, nor a real npm install, nor a built dist resolved, so the service
  // would exec `npx @provian/agent-sdk observe` and E404. Surface it — a service
  // that cannot start must never install in silence (the Atlas lesson).
  if (entrypoint.command === 'npx') {
    console.warn(HOSTED_BUNDLE
      ? '[provian] WARNING: no runnable observer artifact found (the hosted bundle ~/.provian/agent.js '
        + 'is missing). Paste your install line again.'
      : '[provian] WARNING: no runnable observer artifact found (no hosted bundle, no '
        + 'installed dist, source checkout refused). The service would exec `'
        + `${cliCommand('observe', false)}\`, which is not yet published and will not start. `
        + 'Run the hosted bootstrap, or build the SDK checkout (its `build` script) first.');
  }
  return entrypoint;
}

export function isObserverRunning(): number | null {
  if (!fs.existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (!pid) return null;
    try { process.kill(pid, 0); } catch { return null; }
    // a daemon that exited (a self-update's exit(0), a crash) under a
    // PID 1 that does not reap orphans stays a ZOMBIE — kill(pid, 0) still
    // succeeds on it, so every cron tick would believe an observer is running
    // and none ever restarts. A zombie is not running.
    if (isZombie(pid)) return null;
    // a pidfile that survived a reboot may name a pid now reused by an
    // unrelated process — that is not our daemon (and must never be signalled).
    return isObserverProcess(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * is `pid` an observer daemon — its command line carries the `observe` verb (the hosted
 * bundle, the npm dispatcher) or the npm `start-observer.js` entry? A pidfile and the lock both live
 * under $HOME and survive a reboot, while pids restart from 1, so after a reboot the recorded pid
 * may belong to anything (a shell, the sandbox keeper). Linux reads `/proc/<pid>/cmdline`; elsewhere
 * `ps -p <pid> -o command=`. A command line that cannot be read answers TRUE: never judge a live
 * process not-ours (and steal its lock) without evidence.
 */
export function isObserverProcess(
  pid: number,
  readCmdline: (pid: number) => string | null = readProcessCmdline,
): boolean {
  let cmd: string | null;
  try { cmd = readCmdline(pid); } catch { cmd = null; }
  if (cmd === null) return true;
  const argv = cmd.split(/[\0\s]+/).filter((a) => a.length > 0);
  if (argv.length === 0) return false; // a zombie / kernel thread: no command line at all
  // `observe` as a verb (`agent.js observe`), the package's own `observe` bin run through
  // its symlink (`node /…/bin/observe`), or the compiled entry itself.
  return argv.some((a) => a === 'observe' || path.basename(a) === 'observe' || a.endsWith('start-observer.js'));
}

function readProcessCmdline(pid: number): string | null {
  if (process.platform === 'linux') {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return null; }
  }
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
  } catch {
    return null;
  }
}

/** Linux: `/proc/<pid>/stat` state `Z` (zombie) or `X` (dead). Elsewhere: never. */
export function isZombie(pid: number, readStat: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): boolean {
  try {
    const stat = readStat(`/proc/${pid}/stat`);
    // "<pid> (<comm>) <state> …" — comm may contain spaces/parens; the state follows the LAST ')'.
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state === 'Z' || state === 'X';
  } catch {
    return false;
  }
}

export const OBSERVER_LOCK_DIR = path.join(homedir(), '.provian', 'observer.lock');
/** A lock dir younger than this with no pid inside is a claim in progress, not a stale one. */
const LOCK_CREATING_GRACE_MS = 15_000;

export type ObserverLockClaim = { held: true } | { held: false; holder: number | null };

/**
 *: ONE daemon per machine, atomically. cron the
 * @reboot line and the first every-minute tick (or two ticks during a slow
 * start) can launch two daemons at once; the pidfile alone was check-then-write,
 * so both passed, and the loser's startup-error cleanup deleted the WINNER's
 * pidfile — after which every tick started another daemon. The claim is an
 * `mkdir` (atomic on every POSIX filesystem) holding the owner's pid:
 * - created → this process owns the machine;
 * - exists, owner alive (not a zombie) and not us → another daemon holds it;
 * - exists, owner is us or (after a re-exec) our waiting parent → take it over;
 * - exists, owner dead → atomically rename it away (only one racer's rename
 * succeeds) and try again; a dir with no pid yet is a claim in progress.
 */
export function claimObserverLock(opts: {
  pid: number;
  ppid: number;
  env: NodeJS.ProcessEnv;
  /** May a re-exec take the lock over from its waiting parent? Never for a self-update successor. */
  parentHandover?: boolean;
  lockDir?: string;
  alive?: (pid: number) => boolean;
  nowMs?: () => number;
}): ObserverLockClaim {
  const lockDir = opts.lockDir ?? OBSERVER_LOCK_DIR;
  const alive = opts.alive ?? ((p: number) => {
    try { process.kill(p, 0); } catch { return false; }
    // after a reboot the lock's pid may be reused by an unrelated process.
    return !isZombie(p) && isObserverProcess(p);
  });
  const now = opts.nowMs ?? Date.now;
  const pidPath = path.join(lockDir, 'pid');
  const reexeced = opts.parentHandover !== false
    && (opts.env.PROVIAN_RUNTIME_ENV_REEXEC === '1' || opts.env.PROVIAN_NODE_SELFHEAL_REEXEC === '1');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(pidPath, String(opts.pid), { mode: 0o600 });
      return { held: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let holder: number | null = null;
    try { holder = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10) || null; } catch { holder = null; }
    if (holder === null) {
      let ageMs = Infinity;
      try { ageMs = now() - fs.statSync(lockDir).mtimeMs; } catch { continue; }
      if (ageMs < LOCK_CREATING_GRACE_MS) return { held: false, holder: null };
    } else if (holder === opts.pid || (reexeced && holder === opts.ppid)) {
      fs.writeFileSync(pidPath, String(opts.pid), { mode: 0o600 });
      return { held: true };
    } else if (alive(holder)) {
      return { held: false, holder };
    }
    // Stale. Reclaim under a SECOND mutex: a blind rename or
    // rm would move/delete whatever sits at lockDir NOW — possibly a live lock
    // another claimant created a moment ago. Only the holder of `<lock>.reclaim`
    // may replace the lock, and it RE-READS the lock under that mutex, replacing
    // it only if it still names the same stale holder.
    if (reclaimStaleLock(lockDir, holder, opts.pid, alive, now)) return { held: true };
  }
  return { held: false, holder: null };
}

/** A reclaim mutex older than this is left over from a crash mid-reclaim. */
const RECLAIM_STALE_MS = 15_000;

function readLockHolder(lockDir: string): number | null {
  try { return Number.parseInt(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim(), 10) || null; } catch { return null; }
}

/** The pid the machine's observer lock names (null: no lock, or one being created). */
export function observerLockHolder(lockDir: string = OBSERVER_LOCK_DIR): number | null {
  return readLockHolder(lockDir);
}

/** One process as the OS lists it (same user only). */
export interface ListedProcess {
  readonly pid: number;
  readonly ppid: number;
  /** Process group: a detached start (a self-update successor) leads its own. */
  readonly pgid: number;
  /** How long it has run. */
  readonly ageMs: number;
  /** argv, NUL- or space-separated as the OS gives it. */
  readonly command: string;
}

/** Every process of this user: /proc on Linux, `ps` elsewhere. Empty when the table cannot be read. */
export function listOwnProcesses(): ListedProcess[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (process.platform === 'linux') {
    const out: ListedProcess[] = [];
    let uptimeS = 0;
    try { uptimeS = Number.parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]); } catch { return []; }
    let names: string[];
    try { names = fs.readdirSync('/proc'); } catch { return []; }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (uid !== null && fs.statSync(`/proc/${name}`).uid !== uid) continue;
        const st = parseProcStat(fs.readFileSync(`/proc/${name}/stat`, 'utf8'), uptimeS);
        const command = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
        out.push({ pid: Number(name), ...st, command });
      } catch { /* gone */ }
    }
    return out;
  }
  if (process.platform === 'win32') return [];
  try {
    const text = execFileSync('ps', ['-x', '-o', 'pid=,ppid=,pgid=,uid=,etime=,command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    const out: ListedProcess[] = [];
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      if (uid !== null && Number(m[4]) !== uid) continue;
      out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), ageMs: parseEtime(m[5]), command: m[6] });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * One `/proc/<pid>/stat` line → parent, group, age. The fields after the command's closing `)` are
 * state, ppid, pgrp, …; starttime is field 22 (index 19 there), in clock ticks (USER_HZ = 100).
 */
export function parseProcStat(stat: string, uptimeS: number): { ppid: number; pgid: number; ageMs: number } {
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const startTicks = Number(rest[19]);
  return { ppid: Number(rest[1]), pgid: Number(rest[2]), ageMs: Math.max(0, (uptimeS - startTicks / 100) * 1000) };
}

/** `ps` elapsed time: [[dd-]hh:]mm:ss → ms (0 when unreadable). */
export function parseEtime(etime: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return 0;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0));
  return (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

/** A live observer daemon (not a zombie, not a stranger that reused the pid). */
export function isLiveObserver(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  return !isZombie(pid) && isObserverProcess(pid);
}

/**
 * Replace a stale lock with ours, serialized by `<lockDir>.reclaim` (atomic
 * mkdir). Returns true only if THIS process now holds the lock. Residual (named,
 * not hidden): a process that crashes while holding the reclaim mutex leaves it
 * for RECLAIM_STALE_MS; clearing that leftover is itself unguarded, so two
 * claimants racing the clearing of a crashed reclaim within one tick could still
 * both proceed — this needs a crash inside a millisecond-wide window first.
 */
function reclaimStaleLock(
  lockDir: string,
  staleHolder: number | null,
  pid: number,
  alive: (pid: number) => boolean,
  now: () => number,
): boolean {
  const mutex = `${lockDir}.reclaim`;
  try {
    fs.mkdirSync(mutex, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    try {
      if (now() - fs.statSync(mutex).mtimeMs > RECLAIM_STALE_MS) fs.rmSync(mutex, { recursive: true, force: true });
    } catch { /* gone already */ }
    return false; // someone else is reclaiming; the caller re-reads on its next attempt
  }
  try {
    const current = readLockHolder(lockDir);
    const lockExists = fs.existsSync(lockDir);
    // Still exactly the stale holder we judged (or gone)? Then it is ours to replace.
    const stillStale = !lockExists
      || (current === staleHolder && (current === null || !alive(current)));
    if (!stillStale) return false;
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(path.join(lockDir, 'pid'), String(pid), { mode: 0o600 });
    return true;
  } catch {
    return false;
  } finally {
    try { fs.rmSync(mutex, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

/** Release the claim only if THIS process still owns it. */
export function releaseObserverLock(pid: number, lockDir: string = OBSERVER_LOCK_DIR): void {
  try {
    if (Number.parseInt(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim(), 10) === pid) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch { /* not ours / already gone */ }
}

/** Remove the pidfile only if it names THIS process (never another daemon's). */
export function removeOwnPidFile(pid: number): void {
  try {
    if (Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10) === pid) fs.unlinkSync(PID_FILE);
  } catch { /* ok */ }
}

export function writePidFile(pid: number): void {
  const dir = getProvianDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PID_FILE, String(pid), { mode: 0o600 });
}

export function removePidFile(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ok */ }
}

export function installService(options: ServiceInstallOptions = {}): ServiceInstallResult {
  const env = options.env ?? {};
  const entrypoint = options.entrypoint ?? observerEntrypoint();
  const p = platform();
  if (p === 'darwin') return installLaunchd(entrypoint, env);
  if (p === 'linux') return installLinux(entrypoint, env);
  if (p === 'win32') return installWindows(entrypoint, env);
  return startDetached(entrypoint, env);
}

/**
 * (D): Linux supervision that does not assume a systemd USER manager.
 * A cloud-VM agent box (an nspawn cell, a Grok Bot microVM, most
 * containers) often has no `systemctl --user` the install used to throw
 * "systemctl: not found", leaving no observer and (because the hook install sat
 * after the throw) no git hook. Order: a working systemd user manager → the
 * unit; else `crontab` → an @reboot + every-minute `observe --if-not-running`
 * entry (the pidfile keeps it to ONE daemon) plus an immediate start; else a
 * detached start for this boot only.
 */
function installLinux(entrypoint: ObserverEntrypoint, env: Record<string, string>): ServiceInstallResult {
  if (systemdUserAvailable()) return installSystemd(entrypoint, env);
  const result = commandAvailable('crontab') ? installCron(entrypoint, env) : startDetached(entrypoint, env);
  // no service manager (detached), or cron — whose daemon may not be running after a
  // container restart — so the shell-startup restart hook brings the daemon back after a reboot
  // or an instance move. Best-effort; never fails the install.
  const hook = installRestartHookFor(entrypoint, { ...process.env, ...env });
  // Does the shell this install runs in read its startup files? (A hosted bot's exec-daemon
  // spawns `bash -c`, which reads none.) Recorded so the daemon reports the same answer.
  const installShellSourcesRc = probeInstallShellSourcesRc();
  recordInstallShellProbe(installShellSourcesRc);
  const restartMechanism = resolveRestartMechanism({
    method: result.method,
    cronAlive: result.method === 'cron' ? probeCronDaemon() : null,
    hookInstalled: hook,
    rcFired: restartHookFired(),
    installShellSourcesRc,
  });
  return { ...result, ...(hook ? { restartHook: true } : {}), restartMechanism };
}

/**
 * The restart hook for this entrypoint (skipped for the npx last resort, which has no absolute
 * node). True when it is in effect afterwards.
 */
function installRestartHookFor(entrypoint: ObserverEntrypoint, env: NodeJS.ProcessEnv): boolean {
  try {
    if (!path.isAbsolute(entrypoint.command)) return false;
    // Opted out (recorded, so later daemons honour it too): write the ensure script only (the
    // agent's `observe --if-not-running` runs it), never a startup file — so the hook is not in
    // effect and the mechanism resolves honestly. The script decides the daemon's supervision
    // label itself, at start time (cron only when crond is really running).
    installRestartHook({ entry: { command: entrypoint.command, args: entrypoint.args }, rc: !resolveRestartHookOptOut(env) });
    return restartHookInstalled();
  } catch {
    return false;
  }
}

/** True when a systemd user manager answers (not merely when the binary exists). */
export function systemdUserAvailable(): boolean {
  try {
    execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function commandAvailable(name: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export const CRON_BLOCK_START = '# >>> provian-observer (managed by Provian; `node ~/.provian/agent.js repair` rewrites it) >>>';
export const CRON_BLOCK_END = '# <<< provian-observer <<<';

/** POSIX-sh single-quote (cron runs its command line through /bin/sh). */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The crontab block for the observer (pure — unit-testable). `@reboot` brings
 * it up at boot; the every-minute tick restarts it after a crash or a
 * self-update's exit(0); `--if-not-running` makes a tick against a live daemon a
 * silent no-op. The egress environment is NOT inlined: every entry applies
 * ~/.provian/runtime.env itself (runtime-env.ts).
 */
export function buildCronBlock(entrypoint: ObserverEntrypoint, env: Record<string, string>, home: string = homedir()): string {
  // PROVIAN_SUPERVISOR=cron rides every tick, so a daemon cron (re)started
  // reports its supervision truthfully in capture-health (not `unknown`).
  const assignments = Object.entries({ ...env, [SUPERVISOR_ENV]: 'cron' })
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${shSingleQuote(v)}`);
  const argv = [entrypoint.command, ...entrypoint.args, '--if-not-running'].map(shSingleQuote);
  const log = shSingleQuote(path.join(home, '.provian', 'observer.log'));
  // Reviewer defect 5: crontab turns an unescaped `%` into a newline (the rest
  // becomes stdin) BEFORE /bin/sh sees the line; `\%` is cron's literal percent.
  const cmd = `cd ${shSingleQuote(home)} && ${[...assignments, ...argv].join(' ')} >> ${log} 2>&1`.replace(/%/g, '\\%');
  return [CRON_BLOCK_START, `@reboot ${cmd}`, `* * * * * ${cmd}`, CRON_BLOCK_END].join('\n');
}

/** Remove the Provian block from a crontab, keeping every other line (pure). */
export function stripCronBlock(existing: string): string {
  const lines = existing.split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line === CRON_BLOCK_START) { inBlock = true; continue; }
    if (inBlock && line === CRON_BLOCK_END) { inBlock = false; continue; }
    if (!inBlock) out.push(line);
  }
  return out.join('\n').replace(/\n+$/, '');
}

/** Replace (or add) the Provian block, keeping the user's own entries (pure). */
export function mergeCronBlock(existing: string, block: string): string {
  const kept = stripCronBlock(existing);
  return `${kept ? `${kept}\n` : ''}${block}\n`;
}

function readCrontab(): string {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    return ''; // "no crontab for <user>" exits non-zero
  }
}

function writeCrontab(content: string): void {
  execFileSync('crontab', ['-'], { input: content, stdio: ['pipe', 'ignore', 'inherit'], timeout: 5000 });
}

/** How a daemon started beside a freshly written crontab block labels its supervision (pure). */
export function cronStartLabel(cronAlive: boolean | null): 'cron' | 'detached' {
  return cronAlive === true ? 'cron' : 'detached';
}

function installCron(entrypoint: ObserverEntrypoint, env: Record<string, string>): ServiceInstallResult {
  writeCrontab(mergeCronBlock(readCrontab(), buildCronBlock(entrypoint, env)));
  // Start now rather than waiting up to a minute for the first tick, so the
  // model shim can be verified listening before the profile is written.
  // Labelled `cron` only when a cron daemon really runs (our block was just written): on a box with
  // a crontab but no crond (the Docker-cell case) nothing ticks, so the truth is `detached` — no Grok
  // repoint without a supervisor, and self-update re-execs (review r11 #1; the ensure script
  // makes the same decision).
  const started = isObserverRunning() ? null : startDetached(
    { command: entrypoint.command, args: [...entrypoint.args, '--if-not-running'] }, env, cronStartLabel(probeCronDaemon()),
  );
  return { method: 'cron', path: 'crontab', ...(started?.pid ? { pid: started.pid } : {}) };
}

function uninstallCron(): void {
  if (!commandAvailable('crontab')) return;
  const existing = readCrontab();
  if (!existing.includes(CRON_BLOCK_START)) return;
  const kept = stripCronBlock(existing);
  try {
    if (kept.trim().length === 0) execFileSync('crontab', ['-r'], { stdio: 'ignore', timeout: 5000 });
    else writeCrontab(`${kept}\n`);
  } catch { /* best-effort */ }
}

export function uninstallService(): void {
  const p = platform();
  if (p === 'darwin') uninstallLaunchd();
  else if (p === 'linux') { uninstallSystemd(); uninstallCron(); stopDetached(); }
  else if (p === 'win32') uninstallWindows();
  else stopDetached();
  // the shell-startup restart hook (removed on every platform; a no-op where absent).
  try { uninstallRestartHook(); } catch { /* best-effort */ }
  removePidFile();
}

/**
 * Restart an already-running observer so it reloads ~/.provian/credentials
 * (and any changed entrypoint/env). The observer reads its credentials from the
 * file ONCE at startup, so after a reconnect / key rotation the live process
 * keeps stale creds and fail-auths (401) until it is actually restarted — a
 * silent partial failure. `installService` alone does NOT cover this uniformly:
 * launchd unload+load restarts, but `systemctl enable --now` and `schtasks /Run`
 * (MultipleInstancesPolicy=IgnoreNew) leave a running instance in place. This
 * stops the live instance first, then (re)installs + starts it.
 */
export function restartService(options: ServiceInstallOptions = {}): ServiceInstallResult {
  const env = options.env ?? {};
  const entrypoint = options.entrypoint ?? observerEntrypoint();
  const p = platform();
  if (p === 'darwin') {
    // installLaunchd does `launchctl unload` (stop) then `load` (start).
    return installLaunchd(entrypoint, env);
  }
  if (p === 'linux') {
    if (!systemdUserAvailable()) {
      // Cron / detached supervision: stop the live daemon; installLinux starts it fresh.
      stopDetached();
      return installLinux(entrypoint, env);
    }
    const result = installSystemd(entrypoint, env);
    try {
      execSync('systemctl --user restart provian-observer.service', { stdio: 'inherit' });
    } catch { /* enable --now in installSystemd already started it */ }
    return result;
  }
  if (p === 'win32') {
    // Stop the live instance so the re-created task's /Run actually spawns fresh.
    try { execSync(`schtasks /End /TN "${WINDOWS_TASK_NAME}"`, { stdio: 'ignore' }); } catch { /* ok */ }
    return installWindows(entrypoint, env);
  }
  // No service manager: kill the detached process and respawn it.
  stopDetached();
  return startDetached(entrypoint, env);
}

/** The launchd plist text (pure; the node re-point reads the same shape). */
export function buildLaunchdPlist(entrypoint: ObserverEntrypoint, env: Record<string, string>, home: string = homedir(), log: string = OBSERVER_LOG): string {
  const { command, args } = entrypoint;
  const argv = [command, ...args].map(a => `    <string>${escapeXml(a)}</string>`).join('\n');
  const mergedEnv: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',
    ...env,
  };
  const envXml = Object.entries(mergedEnv)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key><string>${escapeXml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>WorkingDirectory</key><string>${home}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

function installLaunchd(entrypoint: ObserverEntrypoint, env: Record<string, string>): ServiceInstallResult {
  const plist = buildLaunchdPlist(entrypoint, env);
  fs.mkdirSync(path.dirname(LAUNCHD_PLIST), { recursive: true });
  fs.writeFileSync(LAUNCHD_PLIST, plist, { mode: 0o644 });

  // Unload first in case we're upgrading
  try { execSync(`launchctl unload "${LAUNCHD_PLIST}"`, { stdio: 'ignore' }); } catch { /* ok */ }
  execSync(`launchctl load "${LAUNCHD_PLIST}"`, { stdio: 'inherit' });

  return { method: 'launchd', path: LAUNCHD_PLIST };
}

function uninstallLaunchd(): void {
  try { execSync(`launchctl unload "${LAUNCHD_PLIST}"`, { stdio: 'ignore' }); } catch { /* ok */ }
  try { fs.unlinkSync(LAUNCHD_PLIST); } catch { /* ok */ }
}

/** The systemd user unit text (pure; the node re-point reads the same shape). */
export function buildSystemdUnit(entrypoint: ObserverEntrypoint, env: Record<string, string>, home: string = homedir(), log: string = OBSERVER_LOG): string {
  const { command, args } = entrypoint;
  const execStart = [command, ...args].map(a => shellQuote(a)).join(' ');
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment=${systemdEnvironmentAssignment(k, v)}`)
    .join('\n');
  return `[Unit]
Description=Provian Observer
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
# Always, not on-failure — a verified self-update ends with exit(0) and
# relies on the supervisor to relaunch it on the new bytes.
Restart=always
RestartSec=10
StandardOutput=append:${log}
StandardError=append:${log}
WorkingDirectory=${home}
${envLines ? envLines + '\n' : ''}
[Install]
WantedBy=default.target
`;
}

function installSystemd(entrypoint: ObserverEntrypoint, env: Record<string, string>): ServiceInstallResult {
  const unit = buildSystemdUnit(entrypoint, env);
  fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
  fs.writeFileSync(SYSTEMD_UNIT, unit, { mode: 0o644 });
  execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  execSync('systemctl --user enable --now provian-observer.service', { stdio: 'inherit' });
  return { method: 'systemd', path: SYSTEMD_UNIT };
}

function uninstallSystemd(): void {
  try { execSync('systemctl --user disable --now provian-observer.service', { stdio: 'ignore' }); } catch { /* ok */ }
  try { fs.unlinkSync(SYSTEMD_UNIT); } catch { /* ok */ }
  try { execSync('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch { /* ok */ }
}

/**
 * The every-minute repetition the Windows task carries : like cron's
 * minute tick, it brings the observer back after a crash or a self-update's
 * exit(0) — Task Scheduler does not relaunch a task whose process exited 0, and
 * RestartOnFailure alone gives up after three failures. With
 * MultipleInstancesPolicy IgnoreNew a tick while the observer runs is a no-op,
 * and `--if-not-running` makes one that races a live daemon exit 0 quietly.
 */
export const WINDOWS_TASK_MINUTE_TRIGGER = [
  '    <TimeTrigger>',
  '      <Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>',
  '      <StartBoundary>2020-01-01T00:00:00</StartBoundary>',
  '      <Enabled>true</Enabled>',
  '    </TimeTrigger>',
].join('\n');

/** Does an installed task definition carry the every-minute restart (a task written before does not)? */
export function windowsTaskRestartsDaemon(xml: string): boolean {
  return xml.includes('<Repetition><Interval>PT1M</Interval>') && xml.includes('--if-not-running');
}

/** Read the installed Windows task definition (UTF-16LE with a BOM, as installWindows writes it); null if absent. */
export function readInstalledWindowsTaskXml(file: string = WINDOWS_TASK_XML): string | null {
  try {
    const buf = fs.readFileSync(file);
    const body = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2) : buf;
    return body.toString('utf16le');
  } catch {
    return null;
  }
}

/**
 * Build the Task Scheduler XML for the observer (pure — unit-testable). Runs the
 * observer at every user logon and every minute (WINDOWS_TASK_MINUTE_TRIGGER),
 * hidden, restarting on failure. Task Scheduler XML has no clean per-task env
 * element, but the observer reads its credentials from ~/.provian/credentials
 * (file), so no env injection is needed.
 */
export function buildWindowsObserverTaskXml(
  command: string,
  args: string[],
  workingDir: string,
): string {
  const argStr = args.map(a => `"${a}"`).join(' ');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Provian Observer — turns your local work into Provenance Envelopes.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
${WINDOWS_TASK_MINUTE_TRIGGER}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(argStr)}</Arguments>
      <WorkingDirectory>${escapeXml(workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

function installWindows(entrypoint: ObserverEntrypoint, env: Record<string, string>): ServiceInstallResult {
  const { command, args } = entrypoint;
  // The minute tick relaunches the observer; `--if-not-running` keeps a tick
  // that races a live daemon a quiet exit 0 (, as the cron block does).
  const xml = buildWindowsObserverTaskXml(command, args.includes('--if-not-running') ? args : [...args, '--if-not-running'], homedir());
  try {
    fs.mkdirSync(path.dirname(WINDOWS_TASK_XML), { recursive: true });
    // schtasks wants the XML as UTF-16LE with a BOM.
    fs.writeFileSync(
      WINDOWS_TASK_XML,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]),
    );
    // Replace any prior task, register at logon, then start it now.
    try { execSync(`schtasks /Delete /TN "${WINDOWS_TASK_NAME}" /F`, { stdio: 'ignore' }); } catch { /* ok */ }
    execSync(`schtasks /Create /TN "${WINDOWS_TASK_NAME}" /XML "${WINDOWS_TASK_XML}" /F`, { stdio: 'inherit' });
    try { execSync(`schtasks /Run /TN "${WINDOWS_TASK_NAME}"`, { stdio: 'ignore' }); } catch { /* ok */ }
    return { method: 'scheduled_task', path: WINDOWS_TASK_XML };
  } catch {
    // If Task Scheduler is unavailable/locked down, don't fail setup: at least
    // start the observer for this session (it won't survive reboot, but the
    // device is registered and the git hook is installed either way).
    return startDetached(entrypoint, env);
  }
}

function uninstallWindows(): void {
  try { execSync(`schtasks /End /TN "${WINDOWS_TASK_NAME}"`, { stdio: 'ignore' }); } catch { /* ok */ }
  try { execSync(`schtasks /Delete /TN "${WINDOWS_TASK_NAME}" /F`, { stdio: 'ignore' }); } catch { /* ok */ }
  try { fs.unlinkSync(WINDOWS_TASK_XML); } catch { /* ok */ }
  stopDetached();
}

/**
 * tells the daemon who (if anyone) relaunches it after a verified
 * self-update's exit(0). Only `detached` changes behaviour: with no
 * supervisor, the daemon starts its own successor before exiting
 * (run-daemon.ts `selfUpdateReExec`).
 */
export const SUPERVISOR_ENV = 'PROVIAN_SUPERVISOR';

/**
 * The environment a detached daemon is spawned with. review r2 #1: never the wrapper's
 * marker — it describes the command the agent typed, not the daemon (a daemon that inherited it
 * would take itself for a second `observe` request and exit). Defence in depth beside
 * takeShimMarker at entry. Pure — unit-tested.
 */
export function detachedChildEnv(
  base: NodeJS.ProcessEnv,
  env: Record<string, string>,
  supervisor: 'detached' | 'cron',
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base, ...env, [SUPERVISOR_ENV]: supervisor };
  delete out[SHIM_ENV];
  return out;
}

function startDetached(
  entrypoint: ObserverEntrypoint,
  env: Record<string, string>,
  supervisor: 'detached' | 'cron' = 'detached',
): ServiceInstallResult {
  const { command, args } = entrypoint;
  const out = fs.openSync(OBSERVER_LOG, 'a');
  const err = fs.openSync(OBSERVER_LOG, 'a');
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: homedir(),
    env: detachedChildEnv(process.env, env, supervisor),
  });
  child.unref();
  if (child.pid) writePidFile(child.pid);
  return { method: 'detached', pid: child.pid };
}

/**
 * Start the daemon detached with no service install — the last resort of `provian observe
 * --if-not-running` when no ensure script can run (agent-observe.ts). Throws when spawn does.
 */
export function startDetachedObserver(entrypoint: ObserverEntrypoint): void {
  startDetached(entrypoint, {}, 'detached');
}

function stopDetached(): void {
  const pid = isObserverRunning();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ok */ }
  }
}

// ============================================================================
// Session-wide OTel endpoint publish (Lever 1)
//
// The OTLP receiver (OTelPlugin) always listens on 127.0.0.1:4318 on an agent
// device, but a span only becomes a PE if the AGENT'S OWN PROCESS exports to it.
// Historically the endpoint env (OTEL_EXPORTER_OTLP_ENDPOINT) was written ONLY
// into login-shell rc files — so a headless / launchd / systemd-launched agent
// (which sources no rc file) never inherited it and exported nothing, while the
// receiver sat idle. This publishes the endpoint to the whole USER SESSION so
// any subsequently-launched agent inherits it regardless of how it was started.
//
// Endpoint ONLY — deliberately NOT OTEL_SERVICE_NAME: a session-wide service
// name would mislabel every OTel emitter on the box. Best-effort and never
// throws: a failure here degrades to the rc-file path + the `npx @provian/agent-sdk run`
// wrapper, exactly the fallbacks that exist for it.
// ============================================================================

export interface SessionOtelPublishCommand {
  /** Executable, run WITHOUT a shell (execFile-style) so no value is interpolated. */
  command: string;
  args: string[];
}

export interface SessionOtelPublishFile {
  path: string;
  content: string;
}

export interface SessionOtelPublishPlan {
  platform: string;
  endpoint: string;
  /** Session/user-scope env publish commands (shell-free). */
  commands: SessionOtelPublishCommand[];
  /** Login-persistent files to write (Linux environment.d). */
  files: SessionOtelPublishFile[];
  /** One-line, honest statement of the mechanism's known caveats. */
  note: string;
}

export const SESSION_OTEL_ENV_KEY = 'OTEL_EXPORTER_OTLP_ENDPOINT';

/** The one-off launch hint: the npm package's `run` wrapper; the hosted bundle has none. */
function runOneOffHint(when: string): string {
  return HOSTED_BUNDLE
    ? `set ${SESSION_OTEL_ENV_KEY} in the agent's own environment ${when}`
    : `use \`${cliCommand('run')}\` ${when}`;
}

/**
 * Build the platform-specific plan for publishing the OTLP endpoint session-wide.
 * Pure (mirrors the `buildWindowsObserverTaskXml` convention) so each platform's
 * plan is unit-testable on any host. `plat`/`home` are injectable for the same
 * reason.
 */
export function buildSessionOtelPublishPlan(
  port: number = OTLP_DEFAULT_PORT,
  plat: string = platform(),
  home: string = homedir(),
): SessionOtelPublishPlan {
  const endpoint = `http://localhost:${port}`;
  if (plat === 'darwin') {
    return {
      platform: plat,
      endpoint,
      // launchctl setenv publishes to the current GUI/user domain; the observer
      // is RunAtLoad, so it re-publishes on every login/reboot (self-heal).
      commands: [{ command: 'launchctl', args: ['setenv', SESSION_OTEL_ENV_KEY, endpoint] }],
      files: [],
      note: 'Published to the macOS user session (launchctl setenv). An already-running agent needs one restart to inherit it, and a root LaunchDaemon in a different session will not see it — ' + runOneOffHint('for those') + '.',
    };
  }
  if (plat === 'linux') {
    return {
      platform: plat,
      endpoint,
      // set-environment covers the live systemd --user session; environment.d
      // makes it login-persistent across reboots.
      commands: [{
        command: 'systemctl',
        args: ['--user', 'set-environment', `${SESSION_OTEL_ENV_KEY}=${endpoint}`],
      }],
      files: [{
        path: path.join(home, '.config', 'environment.d', 'provian-otel.conf'),
        content: `${SESSION_OTEL_ENV_KEY}=${endpoint}\n`,
      }],
      note: 'Published to the systemd user session and ~/.config/environment.d (login-persistent). An already-running agent needs one restart to inherit it — ' + runOneOffHint('for a one-off') + '.',
    };
  }
  if (plat === 'win32') {
    return {
      platform: plat,
      endpoint,
      // setx persists to the user registry; new processes inherit it.
      commands: [{ command: 'setx', args: [SESSION_OTEL_ENV_KEY, endpoint] }],
      files: [],
      note: 'Persisted to the user registry (setx). New processes inherit it; the current shell and already-running agents need a restart — ' + runOneOffHint('for a one-off') + '.',
    };
  }
  return {
    platform: plat,
    endpoint,
    commands: [],
    files: [],
    note: `No session-wide env mechanism on ${plat}; ${HOSTED_BUNDLE ? '' : `launch the agent via \`${cliCommand('run -- <cmd>')}\` or `}set ${SESSION_OTEL_ENV_KEY}=${endpoint} in the agent's own environment.`,
  };
}

export interface SessionOtelPublishResult {
  published: boolean;
  platform: string;
  endpoint: string;
  ranCommands: number;
  wroteFiles: number;
  note: string;
  errors: string[];
}

/**
 * Execute the session-OTel publish plan. Best-effort: every step is guarded and
 * failures are collected, never thrown — the caller (daemon start / onboarding)
 * must never be blocked by an inability to publish env.
 */
export function publishSessionOtelEndpoint(
  port: number = OTLP_DEFAULT_PORT,
): SessionOtelPublishResult {
  const plan = buildSessionOtelPublishPlan(port);
  const errors: string[] = [];
  let ranCommands = 0;
  let wroteFiles = 0;

  for (const cmd of plan.commands) {
    try {
      execFileSync(cmd.command, cmd.args, { stdio: 'ignore', timeout: 5000 });
      ranCommands += 1;
    } catch (err) {
      errors.push(`${cmd.command}: ${(err as Error).message}`);
    }
  }
  for (const file of plan.files) {
    try {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.content);
      wroteFiles += 1;
    } catch (err) {
      errors.push(`write ${file.path}: ${(err as Error).message}`);
    }
  }

  return {
    published: ranCommands > 0 || wroteFiles > 0,
    platform: plan.platform,
    endpoint: plan.endpoint,
    ranCommands,
    wroteFiles,
    note: plan.note,
    errors,
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shellQuote(s: string): string {
  if (!/[\s"'$`\\]/.test(s)) return s;
  return `"${s.replace(/(["$`\\])/g, '\\$1')}"`;
}

/**
 * One systemd `Environment=` assignment, double-quoted the way systemd.service(5) reads it, so a
 * value with a space, `"` or `\` (a home directory with a space in it) is carried intact instead
 * of splitting the line or breaking the unit (2026-10-17 bug check). A newline cannot be carried
 * at all, and a name that is not an environment name is refused rather than written.
 */
export function systemdEnvironmentAssignment(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`systemd environment name refused: ${name}`);
  if (/[\r\n]/.test(value)) throw new Error(`systemd environment value for ${name} cannot carry a newline`);
  return `"${name}=${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// re-point a service unit at the store-capable node after a heal.
//
// A unit baked with a node that cannot read the harness stores (Node 20) starts
// every restart on that node, which then re-execs onto ~/.provian/node. Once a
// daemon has healed (it knows the node it came FROM), it swaps that exact baked
// path for the node it now runs on — in the unit text only, never restarting
// itself: systemd gets a daemon-reload (the next start uses it), cron's next tick
// reads the new crontab, launchd reads the plist at its next load. Only the exact
// quoted token the installer wrote is replaced, and only in Provian's own unit.

/** The cron block with `from` swapped for `to` in its argv, or null when unchanged (pure). */
export function repointCronNode(crontab: string, from: string, to: string): string | null {
  const lines = crontab.split('\n');
  const fromTok = `${shSingleQuote(from)} `;
  const toTok = `${shSingleQuote(to)} `;
  let inBlock = false;
  let changed = false;
  const out = lines.map((line) => {
    if (line === CRON_BLOCK_START) { inBlock = true; return line; }
    if (line === CRON_BLOCK_END) { inBlock = false; return line; }
    if (!inBlock || !line.includes(fromTok)) return line;
    changed = true;
    return line.split(fromTok).join(toTok);
  });
  return changed ? out.join('\n') : null;
}

/** The systemd unit with ExecStart's node swapped, or null when it does not start with `from` (pure). */
export function repointSystemdNode(unit: string, from: string, to: string): string | null {
  const prefix = `ExecStart=${shellQuote(from)} `;
  let changed = false;
  const out = unit.split('\n').map((line) => {
    if (!line.startsWith(prefix)) return line;
    changed = true;
    return `ExecStart=${shellQuote(to)} ${line.slice(prefix.length)}`;
  });
  return changed ? out.join('\n') : null;
}

/** The launchd plist with ProgramArguments[0] swapped, or null when it is not `from` (pure). */
export function repointLaunchdNode(plist: string, from: string, to: string): string | null {
  const head = '<key>ProgramArguments</key>\n  <array>\n';
  const i = plist.indexOf(head);
  if (i < 0) return null;
  const first = `    <string>${escapeXml(from)}</string>`;
  const at = i + head.length;
  if (!plist.startsWith(first, at)) return null;
  return `${plist.slice(0, at)}    <string>${escapeXml(to)}</string>${plist.slice(at + first.length)}`;
}

export interface RepointServiceNodeDeps {
  readFile?: (p: string) => string | null;
  writeFile?: (p: string, content: string) => void;
  readCrontab?: () => string | null;
  writeCrontab?: (content: string) => void;
  daemonReload?: () => void;
  plistPath?: string;
  systemdUnitPath?: string;
}

/**
 * Swap `from` for `to` in every Provian unit that bakes it. Returns what changed
 * ('launchd' | 'systemd' | 'cron'). Never restarts the running daemon. Never throws.
 */
export function repointServiceNode(from: string, to: string, deps: RepointServiceNodeDeps = {}): string[] {
  const changed: string[] = [];
  if (!from || !to || path.resolve(from) === path.resolve(to)) return changed;
  const readFile = deps.readFile ?? ((p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } });
  const writeFile = deps.writeFile ?? ((p: string, c: string) => fs.writeFileSync(p, c, { mode: 0o644 }));
  try {
    const plistPath = deps.plistPath ?? LAUNCHD_PLIST;
    const plist = readFile(plistPath);
    const next = plist === null ? null : repointLaunchdNode(plist, from, to);
    if (next !== null) { writeFile(plistPath, next); changed.push('launchd'); }
  } catch { /* leave it */ }
  try {
    const unitPath = deps.systemdUnitPath ?? SYSTEMD_UNIT;
    const unit = readFile(unitPath);
    const next = unit === null ? null : repointSystemdNode(unit, from, to);
    if (next !== null) {
      writeFile(unitPath, next);
      (deps.daemonReload ?? (() => execSync('systemctl --user daemon-reload', { stdio: 'ignore', timeout: 10_000 })))();
      changed.push('systemd');
    }
  } catch { /* leave it */ }
  try {
    const read = deps.readCrontab ?? (() => (commandAvailable('crontab') ? readCrontab() : null));
    const crontab = read();
    const next = crontab === null ? null : repointCronNode(crontab, from, to);
    if (next !== null) { (deps.writeCrontab ?? writeCrontab)(next); changed.push('cron'); }
  } catch { /* leave it */ }
  return changed;
}
