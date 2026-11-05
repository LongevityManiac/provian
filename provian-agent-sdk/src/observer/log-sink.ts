/**
 * follow-up (the operator’s Grok bot, 2026-09-29): the daemon writes its OWN log.
 *
 * Every log-derived answer — `doctor`'s pipeline check, the transcript-watcher line,
 * harness emission — reads `~/.provian/observer.log`. A daemon started by the
 * installer, the restart hook, cron or a self-update successor has its stdout
 * pointed at that file by whoever spawned it. A daemon an agent's shell started
 * (a hosted bot's standing "restart the observer" instruction) wrote to that shell
 * instead, so the file stopped at the previous daemon's last line and doctor read a
 * dead run: the probe it had just sent was classified — in the shell — and doctor,
 * watching the file, reported it unclassified.
 *
 * So the daemon checks at start: if fd 1 already IS the log file (same device and
 * inode) nothing changes; otherwise every stdout/stderr write is also appended to
 * the log. The launching terminal still sees the output, and a terminal that goes
 * away (EPIPE) is dropped silently — a daemon never dies because the shell that
 * started it closed.
 */

import * as fs from 'fs';
import * as path from 'path';

export type LogSinkOutcome = 'already_logging' | 'teed' | 'failed';

export interface LogSinkDeps {
  fstat?: (fd: number) => { dev: number; ino: number };
  stat?: (p: string) => { dev: number; ino: number };
  open?: (p: string) => number;
  write?: (fd: number, chunk: string | Uint8Array) => void;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

type WriteFn = NodeJS.WriteStream['write'];

export function ensureDaemonWritesLog(logPath: string, deps: LogSinkDeps = {}): LogSinkOutcome {
  const fstat = deps.fstat ?? ((fd: number) => fs.fstatSync(fd));
  const stat = deps.stat ?? ((p: string) => fs.statSync(p));
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const out = fstat(1);
    const file = stat(logPath);
    if (out.dev === file.dev && out.ino === file.ino) return 'already_logging';
  } catch { /* the log may not exist yet, or fd 1 is closed — tee below */ }
  let fd: number;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    fd = (deps.open ?? ((p: string) => fs.openSync(p, 'a', 0o600)))(logPath);
  } catch {
    return 'failed';
  }
  const writeFile = deps.write ?? ((f: number, chunk: string | Uint8Array) => { if (typeof chunk === 'string') fs.writeSync(f, chunk); else fs.writeSync(f, chunk); });
  for (const stream of [stdout, stderr]) {
    let passthrough = true;
    // A launching terminal that went away must never take the daemon with it.
    stream.on('error', () => { passthrough = false; });
    const original = stream.write.bind(stream) as WriteFn;
    const teed = ((chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown): boolean => {
      try { writeFile(fd, chunk); } catch { /* a full disk never stops capture */ }
      const done = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      if (!passthrough) {
        if (typeof done === 'function') (done as () => void)();
        return true;
      }
      try {
        return (original as (c: string | Uint8Array, e?: unknown, c2?: unknown) => boolean)(chunk, encodingOrCb, cb);
      } catch {
        passthrough = false;
        return true;
      }
    }) as WriteFn;
    stream.write = teed;
  }
  return 'teed';
}
