import { ProgramWitnessRegistry } from './program-witness';
/** Socket owners are identified by the OS executable and runtime script operand.
 * Only the client process names the program; ancestors and request contents cannot.
 */

import * as fs from 'fs';
import { execFile } from 'child_process';

export interface PeerProcessEntry {
  readonly pid: number;
  /** The full command line (argv joined by spaces) — a path with a space in it is not quoted. */
  readonly args: string;
  readonly argv?: readonly string[];
  /**
   * The executable's path as the OS reports it (darwin `ps -o comm=`, linux `/proc/<pid>/exe`,
   * win32 ExecutablePath), whole — spaces and all, and unchanged when a process overwrites its argv
   * with a title (`process.title`).
   */
  readonly exe?: string;
}

/** The client process first, then its ancestors (nearest first); only the first names the sender. */
export type PeerProcessChain = readonly PeerProcessEntry[];

/** Resolve the process owning the loopback client socket `clientPort` → `serverPort`. */
export type PeerLookup = (clientPort: number, serverPort: number) => Promise<PeerProcessChain | null>;

/** How long one lookup may take before the connection counts as unattributed. */
export const PEER_LOOKUP_TIMEOUT_MS = 3_000;

function run(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: PEER_LOOKUP_TIMEOUT_MS, maxBuffer: 1 << 25 }, (err, stdout) => {
      // lsof exits 1 when one of several selectors matched nothing; its output still counts.
      resolve(typeof stdout === 'string' && stdout.length > 0 ? stdout : (err ? null : ''));
    });
  });
}

/**
 * Parse `lsof -nP -iTCP:<clientPort> -Fpn`: the pid whose socket is LOCAL `clientPort` and REMOTE
 * `serverPort` on loopback (the daemon's own end of the connection is the reverse and never matches).
 */
export function parseLsofOwner(text: string, clientPort: number, serverPort: number): number | null {
  let pid: number | null = null;
  const loop = '(?:127\\.0\\.0\\.1|\\[::1\\]|localhost)';
  const want = new RegExp(`^n${loop}:${clientPort}->${loop}:${serverPort}$`);
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); continue; }
    if (pid !== null && want.test(line.trim())) return pid;
  }
  return null;
}

/** Parse `/proc/net/tcp` (or tcp6): the inode of the ESTABLISHED socket local `clientPort` → remote `serverPort`. */
export function parseProcNetTcpInode(text: string, clientPort: number, serverPort: number): number | null {
  const hex = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');
  // Loopback only: 127.0.0.1 (tcp), and ::1 or ::ffff:127.0.0.1 (tcp6), as /proc writes them.
  const loopback = new Set(['0100007F', '00000000000000000000000001000000', '0000000000000000FFFF00000100007F']);
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [laddr, local] = (f[1] ?? '').split(':');
    const [raddr, remote] = (f[2] ?? '').split(':');
    if (!loopback.has((laddr ?? '').toUpperCase()) || !loopback.has((raddr ?? '').toUpperCase())) continue;
    if (local === hex(clientPort) && remote === hex(serverPort) && f[3] === '01') {
      const inode = Number(f[9]);
      return Number.isFinite(inode) && inode > 0 ? inode : null;
    }
  }
  return null;
}

async function darwinLookup(clientPort: number, serverPort: number): Promise<PeerProcessChain | null> {
  const out = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${clientPort}`, '-Fpn']);
  if (out === null) return null;
  const pid = parseLsofOwner(out, clientPort, serverPort);
  if (pid === null || pid === process.pid) return null;
  const ps = await run('/bin/ps', ['-o', 'args=', '-p', String(pid)]);
  if (ps === null) return null;
  const args = ps.trim();
  if (args.length === 0) return null;
  // The executable's path, one whole field (a path with spaces kept whole; unchanged by a title).
  const comm = ((await run('/bin/ps', ['-o', 'comm=', '-p', String(pid)])) ?? '').trim();
  return [{ pid, args, ...(comm.length > 0 ? { exe: comm } : {}) }];
}

function linuxProcRow(pid: number): { args: string; argv: string[]; exe?: string } | null {
  let argv: string[];
  try {
    argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((s) => s.length > 0);
  } catch {
    return null;
  }
  let exe: string | undefined;
  try { exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''); } catch { exe = undefined; }
  return { args:argv.join(' '), argv, ...(exe ? { exe } : {}) };
}

async function linuxLookup(clientPort: number, serverPort: number): Promise<PeerProcessChain | null> {
  let inode: number | null = null;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try { inode = parseProcNetTcpInode(fs.readFileSync(f, 'utf8'), clientPort, serverPort); } catch { inode = null; }
    if (inode !== null) break;
  }
  if (inode === null) return null;
  const target = `socket:[${inode}]`;
  let owner: number | null = null;
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return null; }
  for (const p of pids) {
    const pid = Number(p);
    if (pid === process.pid) continue;
    let fds: string[] = [];
    try { fds = fs.readdirSync(`/proc/${p}/fd`); } catch { continue; }
    for (const fd of fds) {
      try { if (fs.readlinkSync(`/proc/${p}/fd/${fd}`) === target) { owner = pid; break; } } catch { /* raced */ }
    }
    if (owner !== null) break;
  }
  if (owner === null) return null;
  const row = linuxProcRow(owner);
  return row && row.args.length > 0 ? [{ pid: owner, ...row }] : null;
}

/** Parse `netstat -ano -p TCP` (Windows): the pid owning the ESTABLISHED loopback client `clientPort` → `serverPort`. */
export function parseNetstatOwner(text: string, clientPort: number, serverPort: number): number | null {
  const loop = '(?:127\\.0\\.0\\.1|\\[::1\\])';
  const want = new RegExp(`^TCP\\s+${loop}:${clientPort}\\s+${loop}:${serverPort}\\s+ESTABLISHED\\s+(\\d+)$`, 'i');
  for (const line of text.split(/\r?\n/)) {
    const m = want.exec(line.trim());
    if (m) return Number(m[1]);
  }
  return null;
}

async function win32Lookup(clientPort: number, serverPort: number): Promise<PeerProcessChain | null> {
  const out = await run('netstat', ['-ano', '-p', 'TCP']);
  if (out === null) return null;
  const pid = parseNetstatOwner(out, clientPort, serverPort);
  if (pid === null || pid === process.pid) return null;
  const cmd = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; Write-Output ('' + $p.ExecutablePath); Write-Output ('' + $p.CommandLine)`]);
  const lines = (cmd ?? '').split(/\r?\n/).map((l) => l.trim());
  const exe = lines[0] ?? '';
  const args = lines.slice(1).join(' ').trim();
  return args.length > 0 ? [{ pid, args, ...(exe.length > 0 ? { exe } : {}) }] : null;
}

/** The platform's lookup (darwin, linux, win32), else one that names no sender. */
export function defaultPeerLookup(platform: NodeJS.Platform = process.platform): PeerLookup {
  if (platform === 'darwin') return darwinLookup;
  if (platform === 'linux') return linuxLookup;
  if (platform === 'win32') return win32Lookup;
  return async () => null;
}

interface SocketLike { readonly remotePort?: number; readonly localPort?: number }

/**
 * Attribute connections, once per socket (a keep-alive connection is looked up once). Never
 * throws; a lookup that fails or outlasts PEER_LOOKUP_TIMEOUT_MS is null.
 */
export class PeerAttributor {
  /** Per connection, the process that opened it (looked up once; an unknown result is not kept). */
  private readonly cache = new WeakMap<object, Promise<PeerProcessChain | null>>();
  private readonly lookup: PeerLookup;
  private readonly identifyProgram?: (p: PeerProcessEntry) => string | null;
  constructor(opts: { readonly lookup?: PeerLookup; readonly identifyProgram?: (p: PeerProcessEntry) => string | null } = {}) {
    const registry = new ProgramWitnessRegistry();
    this.identifyProgram = opts.identifyProgram ?? (p => registry.identify(p));
    this.lookup = opts.lookup ?? defaultPeerLookup();
  }

  attribute(socket: SocketLike): Promise<string | null> {
    let chain = this.cache.get(socket);
    if (!chain) {
      const client = socket.remotePort;
      const server = socket.localPort;
      const p: Promise<PeerProcessChain | null> = typeof client !== 'number' || typeof server !== 'number'
        ? Promise.resolve(null)
        : new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), PEER_LOOKUP_TIMEOUT_MS);
          if (typeof timer.unref === 'function') timer.unref();
          this.lookup(client, server)
            .then((c) => { clearTimeout(timer); resolve(c && c.length > 0 ? c : null); })
            .catch(() => { clearTimeout(timer); resolve(null); });
        });
      // Unknown is never remembered: the connection's next request looks it up again.
      chain = p.then((c) => { if (c === null) this.cache.delete(socket); return c; });
      this.cache.set(socket, chain);
    }
    return chain.then(c => c?.[0] ? this.identifyProgram!(c[0]) : null);
  }

}
