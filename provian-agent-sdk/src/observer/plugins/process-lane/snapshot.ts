/**
 * process-lane/snapshot — read the machine's live process table (and a coarse,
 * structure-only file-write signal) directly from the OS.
 *
 * the fourth capture lane. An agent that runs on its
 * own cloud VM keeps no session files, routes no model traffic through our proxy
 * and emits no OTel; the three described lanes see nothing of it. This lane
 * witnesses what the agent actually DOES on its box: the commands it launches,
 * read straight from the OS. The agent does not cooperate and cannot skip it.
 *
 * This module is the READER only — a pure parse of `/proc` (Linux) or `ps`
 * (macOS) into a process snapshot, plus a per-process bytes-written counter
 * (Linux `/proc/<pid>/io`). The decision of what mints lives in `acts.ts`
 * (pure), and the timer/durable-ledger wiring in `ProcessLanePlugin.ts`.
 *
 * Capture is CONTINUOUS (the plugin polls on a tight interval). It is not a
 * kernel exec tracer: a process that both starts and exits inside one poll gap
 * can be missed. That miss is always in the SAFE direction — a command the lane
 * never sees mints nothing; it never double-mints or mints a wrong amount. The
 * top-level command (the unit that mints) outlives a sub-second child and is
 * caught; a missed fast child only drops that child's supplementary structure,
 * never the act. Windows is out of scope for this build.
 */

import * as fs from 'fs';

/**
 * One process, with the fields the lane reasons over. `startKey` is a stable
 * per-process identity that survives PID reuse: `<pid>:<kernel-start-stamp>`
 * (Linux `/proc/<pid>/stat` field 22, the start time in clock ticks since boot;
 * macOS the process's `lstart`). Two different processes never share a startKey
 * even if the OS later reuses the pid, so an act's membership can never be
 * silently inherited by an unrelated later process on the same pid.
 */
export interface ProcEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly startKey: string;
  /** argv as the OS reports it; never stored or transmitted in the clear (acts.ts hashes it). */
  readonly argv: readonly string[];
  /** The executable path the OS reports (Linux `/proc/<pid>/exe`); used only for lane identification. */
  readonly exe?: string;
  /** Linux `/proc/<pid>/io` write_bytes — bytes this process sent to the storage layer. Coarse,
   *  structure-only: a count, never content. null when unreadable (macOS, or raced). */
  readonly bytesWritten: number | null;
  /** The process's short name (Linux `/proc/<pid>/stat` comm; macOS argv[0]'s basename). */
  readonly comm?: string;
  /** The owning user (Linux `/proc/<pid>` owner; macOS `ps` uid); undefined when unreadable. */
  readonly uid?: number;
}

/** A whole-machine process snapshot at one instant, keyed by `startKey`. */
export interface ProcSnapshot {
  readonly atMs: number;
  readonly procs: ReadonlyMap<string, ProcEntry>;
}

/** The reader the plugin injects (real OS by default; a fake in tests). */
export interface SnapshotReader {
  read(): ProcSnapshot;
}

const DIGITS = /^\d+$/;

/** One `/proc/<pid>` entry, read in full (argv, exe, owner, bytes written). Null when raced away. */
export function readLinuxProcEntry(pid: number): ProcEntry | null {
  let stat: string;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const parsed = parseLinuxStat(stat);
  if (!parsed) return null;
  let argv: string[] = [];
  try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((s) => s.length > 0); } catch { /* raced */ }
  let exe: string | undefined;
  try { exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''); } catch { exe = undefined; }
  let uid: number | undefined;
  try { uid = fs.statSync(`/proc/${pid}`).uid; } catch { uid = undefined; }
  return {
    pid, ppid: parsed.ppid, startKey: `${pid}:${parsed.startTicks}`, argv,
    ...(exe ? { exe } : {}), bytesWritten: linuxBytesWritten(pid), comm: linuxComm(stat), ...(uid !== undefined ? { uid } : {}),
  };
}

/** The comm field of a `/proc/<pid>/stat` line. */
export function linuxComm(stat: string): string {
  return stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
}

/** Parse one `/proc/<pid>/stat` line → { ppid, startTicks }. The comm field can
 *  contain spaces and parens, so split AFTER the last ')'. Returns null on any
 *  shape surprise (a raced read), never throws. */
export function parseLinuxStat(stat: string): { ppid: number; startTicks: string } | null {
  const rparen = stat.lastIndexOf(')');
  if (rparen < 0) return null;
  const rest = stat.slice(rparen + 2).trim().split(/\s+/);
  // rest[0] is field 3 (state); fieldN → rest[N-3]. ppid=field4→rest[1], starttime=field22→rest[19].
  const ppid = Number(rest[1]);
  const startTicks = rest[19];
  if (!Number.isInteger(ppid) || typeof startTicks !== 'string' || !DIGITS.test(startTicks)) return null;
  return { ppid, startTicks };
}

/** Linux `/proc/<pid>/io` → write_bytes, or null. */
function linuxBytesWritten(pid: number): number | null {
  try {
    const m = fs.readFileSync(`/proc/${pid}/io`, 'utf8').match(/^write_bytes:\s*(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function readLinuxSnapshot(nowMs: number): ProcSnapshot {
  const procs = new Map<string, ProcEntry>();
  let pids: string[];
  try { pids = fs.readdirSync('/proc').filter((n) => DIGITS.test(n)); } catch { return { atMs: nowMs, procs }; }
  for (const p of pids) {
    const pid = Number(p);
    let stat: string;
    try { stat = fs.readFileSync(`/proc/${p}/stat`, 'utf8'); } catch { continue; }
    const parsed = parseLinuxStat(stat);
    if (!parsed) continue;
    let argv: string[] = [];
    try { argv = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').filter((s) => s.length > 0); } catch { /* kernel thread / raced */ }
    let exe: string | undefined;
    try { exe = fs.readlinkSync(`/proc/${p}/exe`).replace(/ \(deleted\)$/, ''); } catch { exe = undefined; }
    let uid: number | undefined;
    try { uid = fs.statSync(`/proc/${p}`).uid; } catch { uid = undefined; }
    procs.set(`${pid}:${parsed.startTicks}`, {
      pid,
      ppid: parsed.ppid,
      startKey: `${pid}:${parsed.startTicks}`,
      argv,
      ...(exe ? { exe } : {}),
      bytesWritten: linuxBytesWritten(pid),
      comm: linuxComm(stat),
      ...(uid !== undefined ? { uid } : {}),
    });
  }
  return { atMs: nowMs, procs };
}

/**
 * the fast reader: the launcher processes and everything under them, read through each
 * thread's `/proc/<pid>/task/<tid>/children` list, so a 50 ms command tree is seen on a 20 ms tick
 * without reading the whole machine. Entries are cached by start key (argv/exe/owner are read once
 * per process). `unsupported` when the kernel exposes no children lists.
 */
export class LinuxLauncherSubtreeReader {
  private cache = new Map<string, ProcEntry>();
  private ticks = 0;
  /** pid → its thread ids (a harness may spawn from any thread, including one created a moment ago). */
  private tids = new Map<number, string[]>();

  /** Re-listed on every call: a thread-per-request harness runs each command from a fresh thread. */
  private threadsOf(pid: number): string[] {
    let t: string[];
    try { t = fs.readdirSync(`/proc/${pid}/task`); } catch { t = [String(pid)]; }
    this.tids.set(pid, t);
    return t;
  }

  /** Does any launcher thread have a child right now? (the idle fast path; every thread, every tick) */
  hasChildren(launcherPids: readonly number[]): boolean {
    this.ticks += 1;
    for (const pid of launcherPids) {
      for (const tid of this.threadsOf(pid)) {
        try { if (fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim().length > 0) return true; } catch { /* thread gone */ }
      }
    }
    return false;
  }

  read(launcherPids: readonly number[], nowMs: number): ProcSnapshot | 'unsupported' {
    this.ticks += 1;
    const next = new Map<string, ProcEntry>();
    const procs = new Map<string, ProcEntry>();
    const queue = [...launcherPids];
    const launcherSet = new Set(launcherPids);
    const visited = new Set<number>();
    let sawChildrenFile = false;
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid) || visited.size > 4096) continue;
      visited.add(pid);
      let stat: string;
      try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { continue; }
      const parsed = parseLinuxStat(stat);
      if (!parsed) continue;
      const key = `${pid}:${parsed.startTicks}`;
      let entry = this.cache.get(key);
      const comm = linuxComm(stat);
      // New, or exec'd. A launcher's own child is re-read every tick: its command line decides what it
      // is, and an exec that keeps the process name (python3 → python3 script.py) changes only that.
      if (!entry || entry.comm !== comm || launcherSet.has(parsed.ppid)) entry = readLinuxProcEntry(pid) ?? undefined;
      if (!entry) continue;
      // bytes written: refreshed every 10th tick (a coarse count, never on the hot path).
      if (this.ticks % 10 === 0 && !launcherPids.includes(pid)) entry = { ...entry, bytesWritten: linuxBytesWritten(pid) };
      next.set(key, entry);
      procs.set(key, entry);
      // Every thread's children list: a harness may spawn from its main thread (Node/libuv) or from
      // worker threads (a threaded Python server, Go, Java). Thread ids are re-listed every tick.
      for (const tid of this.threadsOf(pid)) {
        let children: string;
        try { children = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8'); sawChildrenFile = true; } catch { continue; }
        for (const c of children.split(' ')) if (c.trim()) queue.push(Number(c));
      }
    }
    this.cache = next;
    for (const pid of this.tids.keys()) if (!visited.has(pid)) this.tids.delete(pid);
    if (!sawChildrenFile && launcherPids.length > 0 && procs.size > 0) return 'unsupported';
    return { atMs: nowMs, procs };
  }
}

/** Whole-machine light scan (start key, ppid, comm only) for launcher discovery. */
export function scanLinuxLight(): Map<number, { readonly startKey: string; readonly ppid: number; readonly comm: string }> {
  const out = new Map<number, { startKey: string; ppid: number; comm: string }>();
  let pids: string[];
  try { pids = fs.readdirSync('/proc').filter((n) => DIGITS.test(n)); } catch { return out; }
  for (const p of pids) {
    let stat: string;
    try { stat = fs.readFileSync(`/proc/${p}/stat`, 'utf8'); } catch { continue; }
    const parsed = parseLinuxStat(stat);
    if (parsed) out.set(Number(p), { startKey: `${p}:${parsed.startTicks}`, ppid: parsed.ppid, comm: linuxComm(stat) });
  }
  return out;
}

/** Parse `ps -A -o pid=,ppid=,uid=,lstart=,command=` (macOS). lstart is a fixed 5-token
 *  ctime string, so the command begins at the 9th whitespace field. */
export function parseMacPs(text: string, nowMs: number): ProcSnapshot {
  const procs = new Map<string, ProcEntry>();
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 9) continue;
    const pid = Number(f[0]);
    const ppid = Number(f[1]);
    const uid = Number(f[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(uid)) continue;
    const lstart = f.slice(3, 8).join(' '); // "Mon Oct 20 13:00:00 2026"
    const argv = f.slice(8);
    procs.set(`${pid}:${lstart}`, {
      pid,
      ppid,
      startKey: `${pid}:${lstart}`,
      argv,
      bytesWritten: null,
      comm: argv[0] ? argv[0].slice(argv[0].lastIndexOf('/') + 1) : '',
      uid,
    });
  }
  return { atMs: nowMs, procs };
}

/** The real OS reader for this platform. Linux reads `/proc` synchronously; macOS
 *  shells out to `ps` once per poll (bounded). Any other platform reads nothing. */
export function defaultSnapshotReader(
  platform: NodeJS.Platform = process.platform,
  now: () => number = Date.now,
): SnapshotReader {
  if (platform === 'linux') return { read: () => readLinuxSnapshot(now()) };
  if (platform === 'darwin') {
    return {
      read: () => {
        try {
          const out = execFileSyncSafe('/bin/ps', ['-A', '-o', 'pid=,ppid=,uid=,lstart=,command=']);
          return out === null ? { atMs: now(), procs: new Map() } : parseMacPs(out, now());
        } catch {
          return { atMs: now(), procs: new Map() };
        }
      },
    };
  }
  return { read: () => ({ atMs: now(), procs: new Map() }) };
}

/** A bounded, throw-free `execFileSync` (macOS `ps`); null on any failure. */
function execFileSyncSafe(file: string, args: string[]): string | null {
  try {
    // Lazy require so the Linux path never loads child_process.execSync machinery.
    const { execFileSync } = require('child_process') as typeof import('child_process');
    // The C locale: `lstart` (part of every start key) must read the same whatever the agent's
    // language, or a record written in one locale never matches a read in another (round 8).
    return execFileSync(file, args, { encoding: 'utf8', timeout: 4000, maxBuffer: 1 << 26, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  } catch {
    return null;
  }
}

/** Linux's clock ticks per second for `/proc/<pid>/stat` start times (USER_HZ: 100 on every
 *  supported kernel; a wrong guess is held to the lane's own reads by the tracker). */
const LINUX_USER_HZ = 100;
let linuxBoot: { readAtMs: number; bootMs: number } | null = null;

/**
 * When the OS says the process with this start key started, in ms since the epoch: Linux from its
 * start in clock ticks since boot and `/proc/uptime`; macOS from `lstart` (to the second). Null when
 * the key or the clock cannot say.
 */
export function processStartedAtMs(startKey: string, platform: NodeJS.Platform, nowMs: number = Date.now()): number | null {
  const i = startKey.indexOf(':');
  if (i < 0) return null;
  const rest = startKey.slice(i + 1);
  if (platform === 'linux') {
    if (!/^\d+$/.test(rest)) return null;
    if (!linuxBoot || Math.abs(nowMs - linuxBoot.readAtMs) > 1_000) {
      let up: number;
      try { up = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]); } catch { return null; }
      if (!Number.isFinite(up)) return null;
      linuxBoot = { readAtMs: nowMs, bootMs: nowMs - up * 1000 };
    }
    return linuxBoot.bootMs + (Number(rest) * 1000) / LINUX_USER_HZ;
  }
  if (platform === 'darwin') {
    const t = Date.parse(rest);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
