/**
 * process-lane/launcher — WHICH program launches the agent's commands.
 *
 * The process lane mints only commands the agent launched — never a process it did not start: the
 * OS's background jobs, other users' programs, or the platform's own housekeeping. On a hosted
 * sandbox every agent command is a first-level child of one long-running harness process (the
 * LAUNCHER), started with the harness's own command line (its WRAPPER); the harness also runs its
 * own checks from the same launcher with a different wrapper. So the lane needs two facts, observed
 * on the device and never declared: the launcher, and the wrapper its commands start with.
 *
 * Both come from a command the agent itself ran through its harness — the install line, `provian
 * doctor`, an act verb, or `provian process-lane record` that process walks its OWN ancestry,
 * skipping Provian's own processes, shells and shell helpers, to the first other program — the
 * launcher. The launcher's child on that walk is the command root, and its shape decides the MODE:
 * - `template` a fixed wrapper, started for this command, that carries nothing of the command
 * itself (a hosted sandbox's `bash … -c '<fixed script>'`, which reads the command from
 * elsewhere). Its argv is the template; a launcher child that starts the same way is a command,
 * any other start is the harness's own check. This is the shape the lane serves.
 * - `direct` the command reaches the launcher's child itself — embedded in its argv
 * (`sh -c "<cmd>"`), exec'd into it, or run from a long-lived shell. From the process table the
 * harness's own programs then look exactly like the agent's commands, and a long-lived shell
 * starts one child per pipeline step, so neither "only the agent's commands" nor "one act per
 * command" can be kept ( ). The lane records the shape, mints nothing, and
 * capture health reports it (`launcher_unsupported`) — never silently dark.
 * A person's terminal (sshd, login, a terminal app, tmux/screen, an IDE's terminal host) is never a
 * launcher.
 * The record keeps hashes only (`~/.provian/process-launcher.json`).
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** v2 ( ): the fingerprint no longer names the launcher's parent. A record in any
 * other shape is STALE: the lane has no usable record (`no_launcher`) and the agent re-records. */
export const LAUNCHER_RECORD_SCHEMA = 'provian.process-launcher.v2';

export function processLauncherPath(home = os.homedir()): string {
  return path.join(home, '.provian', 'process-launcher.json');
}

/** One process as the launcher logic needs it. `parentComm` is the parent's short name. */
export interface LauncherProc {
  readonly pid: number;
  readonly ppid: number;
  readonly comm: string;
  readonly argv: readonly string[];
  readonly exe?: string;
  readonly uid?: number;
  /** When the process started (ms; comparable only with other readings from the same reader). */
  readonly startedAtMs?: number;
  /** The process's identity as the lane's snapshot keys it (`snapshot.ts` startKey). */
  readonly startKey?: string;
}

export interface LauncherRecord {
  readonly schema: typeof LAUNCHER_RECORD_SCHEMA;
  /** sha256 over the launcher's program and whether its parent runs the same program (`launcherFingerprint`). */
  readonly fingerprint: string;
  /** How the launcher starts the agent's commands (see the module doc). */
  readonly mode: LauncherMode;
  /** `template` mode: sha256 per argv token of the command root (exact match). `direct`: empty. */
  readonly template: readonly string[];
  readonly recorded_at_ms: number;
  /** The launcher process the recording command walked to, as the lane keys processes (pid and start
   *  time): the one way a harness the agent started from inside one of its own commands becomes its
   *  launcher. A pid reused by another process never matches. */
  readonly launcher_start_key?: string;
  /** The recording command's own root (the launcher's child on the walk): the lane's first read may
   *  take it as the agent's command although it was already running (round 12). */
  readonly command_start_key?: string;
  /** Which command recorded it (closed set). */
  readonly source: LauncherRecordSource;
}

/** `cli` any other `provian` command run through the installed wrapper; `heal` a command under the
 * recorded launcher rewrote a record the lane had flagged. */
export type LauncherRecordSource = 'install' | 'doctor' | 'act_verb' | 'record' | 'cli' | 'heal';
export type LauncherMode = 'template' | 'direct';

/** A wrapper started longer than this before the recording command is a long-lived shell, not a per-command wrapper. */
export const DELIVERY_MS = 3_000;

/** A person's terminal: login and session managers, terminal multiplexers and terminal apps. */
const SESSION_PROGRAMS = new Set([
  'sshd', 'sshd-session', 'login', 'getty', 'agetty', 'mosh-server', 'tmux', 'screen', 'SCREEN',
  'Terminal', 'iTerm2', 'gnome-terminal-server', 'konsole', 'xterm', 'alacritty', 'kitty', 'wezterm-gui',
]);
/** The OS's service managers: a harness may be their child, but they never launch the agent's commands. */
const SERVICE_MANAGERS = new Set(['systemd', 'launchd', 'init', 'cron', 'crond', 'atd']);
/** An IDE's terminal host (VS Code / code-server pty host, JetBrains), matched on the command line. */
const IDE_TERMINAL_HOST = /ptyHost|Code Helper|code-server|jetbrains|\/idea|pycharm|webstorm/i;

/** Shells and shell helpers between the launcher and the agent's command. */
const SHELLISH = new Set([
  'sh', 'bash', 'dash', 'zsh', 'ash', 'ksh', 'mksh', 'fish', 'busybox',
  'env', 'timeout', 'nohup', 'setsid', 'flock', 'sudo', 'su', 'doas', 'script', 'stdbuf', 'nice', 'ionice',
  'xargs', 'tee', 'unbuffer', 'time', 'chronic',
]);

/** A token that names the agent's own invocation of Provian (install line or a provian command):
 *  a root carrying one embeds the agent's command, so the launcher is in `direct` mode. */
export function isOwnInvocationToken(token: string): boolean {
  return /bootstrap\/agent|\.provian\/|agent\.js|@provian\/agent-sdk|(^|[\s/'"])provian(\s|$|['"])/.test(token);
}

const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');
const base = (v: string | undefined): string => (v ? path.basename(v) : '');

const NPM_PROGRAMS = new Set(['npx', 'npm']);

/** Provian's own processes (the bundle, the npm dispatcher, npx/npm) are never the launcher. */
function isProvianOwn(p: LauncherProc): boolean {
  const name = base(p.argv[0]) || p.comm;
  // npx / npm and npm's exec child (its process name is "npm" followed by the subcommand).
  if (NPM_PROGRAMS.has(name) || NPM_PROGRAMS.has(p.comm.split(' ')[0])) return true;
  // Decided by the SCRIPT, never the binary: a harness may run on any node, including Provian's own
  // runtime under ~/.provian/node — that does not make it Provian's process.
  return p.argv.slice(1).some((t) => /\.provian\/agent\.js|@provian\/agent-sdk|agent-sdk\/dist|npm-cli\.js|npx-cli\.js/.test(t))
    && /node|nodejs/.test(name || p.comm);
}

/** A login shell's name carries a leading dash (`-bash`, `-zsh`). */
const bare = (v: string): string => v.replace(/^-/, '');

function isShellish(p: LauncherProc): boolean {
  return SHELLISH.has(bare(base(p.argv[0]))) || SHELLISH.has(bare(p.comm));
}

function isSessionProgram(p: LauncherProc): boolean {
  const names = [bare(base(p.argv[0])), bare(p.comm), (p.argv[0] ?? '').split(/[:\s]/)[0]];
  return names.some((n) => SESSION_PROGRAMS.has(n)) || /^(sshd|sshd-session|tmux|screen):/i.test(p.argv[0] ?? '')
    || /^tmux: /.test(p.comm) || IDE_TERMINAL_HOST.test(p.argv.join(' '));
}

function isServiceManager(p: LauncherProc): boolean {
  return SERVICE_MANAGERS.has(bare(base(p.argv[0]))) || SERVICE_MANAGERS.has(bare(p.comm));
}

/** The launcher's script token: the first argv entry after the program that is not an option. */
function scriptToken(p: LauncherProc): string {
  for (const t of p.argv.slice(1)) if (!t.startsWith('-')) return t;
  return '';
}

/** A process's program: its executable, program name and script (never its pid, parent or start). */
export function launcherProgram(p: LauncherProc): string {
  return sha(['provian-launcher-program:v2', p.exe ?? '', base(p.argv[0]) || p.comm, scriptToken(p)].join('\0'));
}

/**
 * The stable identity of a launcher across its restarts (pids change; its program does not): its
 * program, and whether its parent runs the SAME program. Never the parent's name (review round
 * 3): a harness whose supervisor exits is reparented, and one restarted by an updated supervisor has
 * a new parent, and neither may stop the lane minting. The one bit keeps the launcher apart from its
 * own forks: a child the harness forked but has not yet exec'd runs the harness's program under the
 * harness, so it is never mistaken for the launcher.
 */
export function launcherFingerprintOf(program: string, parentProgram: string | null): string {
  return sha(['provian-launcher:v2', program, parentProgram === program ? 'nested' : 'top'].join('\0'));
}

export function launcherFingerprint(p: LauncherProc, parent: LauncherProc | null): string {
  const program = launcherProgram(p);
  return launcherFingerprintOf(program, parent ? launcherProgram(parent) : null);
}

/** A fixed wrapper's argv as a template: one hash per token, matched exactly. */
export function templateOf(argv: readonly string[]): string[] {
  return argv.map((t) => sha(t));
}

/** Does a launched child's argv start exactly the way the agent's commands start (template mode)? */
export function matchesTemplate(argv: readonly string[], template: readonly string[]): boolean {
  if (template.length === 0 || argv.length !== template.length) return false;
  for (let i = 0; i < argv.length; i++) {
    if (template[i] !== sha(argv[i])) return false;
  }
  return true;
}

export interface ObservedLauncher {
  readonly startKey: string | null;
  readonly commandStartKey: string | null;
  readonly fingerprint: string;
  readonly mode: LauncherMode;
  readonly template: string[];
}

/**
 * Walk up from `startPid` to the launcher. Null when the chain reaches pid 1 / an unreadable or
 * absent parent without a launcher, or the launcher would be a login/session manager (a person's
 * terminal): there is then no launcher to bind to, and the lane mints nothing (unknown = block).
 */
export function observeLauncher(read: (pid: number) => LauncherProc | null, startPid = process.pid): ObservedLauncher | null {
  let child: LauncherProc | null = null;
  const self = read(startPid);
  let p = self;
  for (let depth = 0; p && depth < 24; depth++) {
    const delivery = depth === 0 || isProvianOwn(p) || isShellish(p);
    if (!delivery) {
      if (!child || p.pid <= 1 || isSessionProgram(p) || isServiceManager(p)) return null;
      const parent = read(p.ppid);
      // The command reaches the launcher's child itself (embedded, exec'd, or a long-lived shell).
      const longLived = self?.startedAtMs !== undefined && child.startedAtMs !== undefined
        && self.startedAtMs - child.startedAtMs > DELIVERY_MS;
      const direct = child.pid === startPid || isProvianOwn(child) || child.argv.some(isOwnInvocationToken) || longLived;
      return {
        startKey: p.startKey ?? null,
        commandStartKey: direct ? null : (child.startKey ?? null),
        fingerprint: launcherFingerprint(p, parent),
        mode: direct ? 'direct' : 'template',
        template: direct ? [] : templateOf(child.argv),
      };
    }
    if (p.ppid <= 1) return null;
    child = p;
    p = read(p.ppid);
  }
  return null;
}

/** `absent`: no record; `stale`: a file is there but not a record this version reads (an older
 *  shape, or damaged) — the lane reports it as no record so the agent re-records; `ok`: a readable record. */
export function launcherRecordStatus(file = processLauncherPath()): 'absent' | 'stale' | 'ok' {
  if (readLauncherRecord(file) !== null) return 'ok';
  return fs.existsSync(file) ? 'stale' : 'absent';
}

export function readLauncherRecord(file = processLauncherPath()): LauncherRecord | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LauncherRecord>;
    if (j.schema !== LAUNCHER_RECORD_SCHEMA || typeof j.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(j.fingerprint)) return null;
    if (j.mode !== 'template' && j.mode !== 'direct') return null;
    if (!Array.isArray(j.template) || !j.template.every((t) => /^[0-9a-f]{64}$/.test(String(t)))) return null;
    if ((j.mode === 'template') !== (j.template.length > 0)) return null;
    // An unusable named process only loses the exception, never the record (round 8).
    const usable = (v: unknown): boolean => typeof v === 'string' && /^\d+:[\w :]{1,64}$/.test(v);
    const { launcher_start_key, command_start_key, ...rest } = j as LauncherRecord;
    return {
      ...rest,
      ...(launcher_start_key !== undefined && usable(launcher_start_key) ? { launcher_start_key } : {}),
      ...(command_start_key !== undefined && usable(command_start_key) ? { command_start_key } : {}),
    } as LauncherRecord;
  } catch { return null; }
}

/** The lane's identity for a record (a re-record, even of the same launcher, is a new one). */
export function launcherRecordKey(rec: LauncherRecord): string {
  return `${rec.fingerprint}:${rec.mode}:${rec.template.join(',')}:${rec.recorded_at_ms}`;
}

/** The lane's states in which it is not recognising the agent's commands under this record. */
export const LAUNCHER_HEAL_STATES: ReadonlySet<string> = new Set(['launcher_unconfirmed', 'launcher_changed', 'launcher_not_seen']);

export function processLaneStatePath(home = os.homedir()): string {
  return path.join(home, '.provian', 'process-lane-state.json');
}

/** The lane's last written state, and the record (hash) it judged it under; null when unreadable. */
export function readProcessLaneStateFile(file = processLaneStatePath()): { state: string; record: string | null } | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { state?: unknown; record?: unknown };
    return typeof j.state === 'string' ? { state: j.state, record: typeof j.record === 'string' ? j.record : null } : null;
  } catch { return null; }
}

export function writeLauncherRecord(rec: LauncherRecord, file = processLauncherPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---- the OS reader ---------------------------------------------------------------------------

function readLinuxProc(pid: number): LauncherProc | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((s) => s.length > 0);
    let exe: string | undefined;
    try { exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''); } catch { exe = undefined; }
    let uid: number | undefined;
    try { uid = fs.statSync(`/proc/${pid}`).uid; } catch { uid = undefined; }
    // Start time in clock ticks since boot (field 22); ×10 is ms at the usual 100 Hz. Only compared
    // with other processes read the same way, so the tick rate never needs to be exact.
    const startTicks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const startedAtMs = Number.isFinite(startTicks) ? startTicks * 10 : undefined;
    return {
      pid, ppid, comm, argv, ...(exe ? { exe } : {}), ...(uid !== undefined ? { uid } : {}), ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(Number.isFinite(startTicks) ? { startKey: `${pid}:${startTicks}` } : {}),
    };
  } catch { return null; }
}

/** `ps -o etime=` → seconds ([[dd-]hh:]mm:ss). */
function etimeSeconds(v: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(v.trim());
  if (!m) return null;
  return (Number(m[1] ?? 0) * 86_400) + (Number(m[2] ?? 0) * 3_600) + (Number(m[3]) * 60) + Number(m[4]);
}

function readMacProc(pid: number): LauncherProc | null {
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    // The C locale, exactly as the lane's own snapshot reads `ps`, so the start key matches (round 8).
    const opts = { encoding: 'utf8' as const, timeout: 3000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } };
    const out = execFileSync('/bin/ps', ['-o', 'ppid=,uid=,etime=,comm=', '-p', String(pid)], opts).trim();
    const lstart = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], opts).trim().split(/\s+/).join(' ');
    const args = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], opts).trim();
    const m = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(out);
    if (!m) return null;
    const argv = args.split(/\s+/).filter(Boolean);
    const elapsed = etimeSeconds(m[3]);
    // The same short name the lane's `ps` snapshot uses (argv[0]'s basename), so fingerprints agree.
    return {
      pid, ppid: Number(m[1]), uid: Number(m[2]), comm: argv[0] ? path.basename(argv[0]) : path.basename(m[4]), argv,
      ...(elapsed !== null ? { startedAtMs: Date.now() - elapsed * 1000 } : {}),
      ...(lstart ? { startKey: `${pid}:${lstart}` } : {}),
    };
  } catch { return null; }
}

export function defaultLauncherProcReader(platform: NodeJS.Platform = process.platform): (pid: number) => LauncherProc | null {
  if (platform === 'linux') return readLinuxProc;
  if (platform === 'darwin') return readMacProc;
  return () => null;
}

/**
 * Record the launcher this command was started from. `force` (the install, `process-lane record`)
 * overwrites; otherwise an absent record is written (doctor, act verbs, any `provian` command on an
 * install that predates the record), and an existing one is HEALED : while the
 * lane reports it is not recognising the agent's commands under that record, a command whose walk
 * reaches a launcher with the RECORDED FINGERPRINT rewrites the record, so a harness that changed its
 * wrapper (or restarted) is witnessed again with no one asked to do anything. The invariant: a heal
 * only ever comes from a process under the fingerprinted launcher — a walk to any other program, to a
 * person's terminal, or in `direct` mode never rewrites a record. Never throws; returns what happened.
 */
export function recordLauncher(opts: {
  readonly source: LauncherRecordSource;
  readonly force: boolean;
  readonly file?: string;
  readonly stateFile?: string;
  readonly read?: (pid: number) => LauncherProc | null;
  readonly startPid?: number;
  readonly now?: () => number;
}): 'recorded' | 'healed' | 'kept' | 'no_launcher' | 'failed' {
  try {
    const file = opts.file ?? processLauncherPath();
    const existing = opts.force ? null : readLauncherRecord(file);
    if (existing !== null) {
      const lane = readProcessLaneStateFile(opts.stateFile ?? path.join(path.dirname(file), 'process-lane-state.json'));
      if (!lane || !LAUNCHER_HEAL_STATES.has(lane.state) || lane.record !== sha(launcherRecordKey(existing))) return 'kept';
      if (existing.mode !== 'template') return 'kept';
      const walked = observeLauncher(opts.read ?? defaultLauncherProcReader(), opts.startPid ?? process.pid);
      if (walked === null || walked.mode !== 'template' || walked.fingerprint !== existing.fingerprint) return 'kept';
      writeLauncherRecord(recordFrom(walked, 'heal', (opts.now ?? Date.now)()), file);
      return 'healed';
    }
    const observed = observeLauncher(opts.read ?? defaultLauncherProcReader(), opts.startPid ?? process.pid);
    if (observed === null) return 'no_launcher';
    writeLauncherRecord(recordFrom(observed, opts.source, (opts.now ?? Date.now)()), file);
    return 'recorded';
  } catch { return 'failed'; }
}

/**
 * The correction : ANY `provian` command the agent runs through the installed
 * wrapper fills a missing launcher record and heals a flagged one when its walk reaches the recorded
 * launcher's fingerprint (`recordLauncher`), so a harness that changed its wrapper is witnessed again
 * with no one asked. Only through the wrapper: the daemon's own service start is never the agent's command.
 */
export function recordLauncherForProvianCommand(
  viaShim: boolean, verb: string | null, record: typeof recordLauncher = recordLauncher,
): ReturnType<typeof recordLauncher> | 'not_via_wrapper' {
  if (!viaShim) return 'not_via_wrapper';
  return record({ source: verb === null ? 'act_verb' : 'cli', force: false });
}

function recordFrom(observed: ObservedLauncher, source: LauncherRecordSource, at: number): LauncherRecord {
  return {
    schema: LAUNCHER_RECORD_SCHEMA,
    fingerprint: observed.fingerprint,
    mode: observed.mode,
    template: observed.template,
    ...(observed.startKey ? { launcher_start_key: observed.startKey } : {}),
    ...(observed.commandStartKey ? { command_start_key: observed.commandStartKey } : {}),
    recorded_at_ms: at,
    source,
  };
}
