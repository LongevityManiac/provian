/**
 * PE METER — a cross-process lock file for the local PE store.
 *
 * The daemon, the git post-commit hook and the transcript backfill are separate processes that
 * all append to ONE device chain. Two of them reading the same head and both appending would fork
 * the chain (two PEs with the same `prev_hash`), which the relay refuses as `act_chain_broken` * and a PE, once written, is never rewritten. So every append happens under this lock.
 *
 * The lock is created WITH its content in one step: the holder writes `<pid>:<ms>` to a private
 * temp file and hard-links it to the lock path, which fails if the lock exists (exactly one creator
 * wins). Before the lock was created empty (`wx`) and the token written after; a rival that
 * read the empty file in that window parsed pid 0, judged the holder dead and took the lock while
 * it was held, and two post-commit hooks forked the operator’s MacBook chain at index 294.
 *
 * A lock is taken over ONLY when its holder is provably gone (the pid is not alive), or when it is
 * older than `staleMs` (an append takes milliseconds; a lock that old was left by a process whose
 * pid has since been reused). A lock whose content cannot be read as a holder is a creator caught
 * mid-write (a filesystem without hard links falls back to `wx`) and is taken over only once it is
 * older than UNREADABLE_GRACE_MS. A takeover removes only the exact lock it judged gone, re-read
 * under a takeover guard (`removeJudgedLock`), so a live lock is never moved or deleted. A live holder
 * is never robbed: the session-ordinal lock's "steal after 2 s" is acceptable there because the
 * relay refuses a forked ordinal, but a forked PE chain would be permanent.
 */

import * as fs from 'fs';

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock file whose content is not a holder is given this long to be written before it may be taken. */
export const UNREADABLE_GRACE_MS = 5_000;

/** What a lock file says, as judged: `missing` (gone), `unreadable` (no valid holder yet), or the holder. */
type Holder =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly raw: string; readonly mtimeMs: number }
  | { readonly kind: 'holder'; readonly raw: string; readonly pid: number; readonly atMs: number };

function readHolder(lockPath: string): Holder {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    return { kind: 'missing' };
  }
  const m = /^(\d+):(\d+)$/.exec(raw);
  const pid = m ? Number(m[1]) : NaN;
  if (!m || !Number.isSafeInteger(pid) || pid <= 0) return { kind: 'unreadable', raw, mtimeMs };
  return { kind: 'holder', raw, pid, atMs: Number(m[2]) };
}

export interface FileLockOptions {
  /** Give up after this long while a LIVE process holds the lock (throws `pe_store_locked`). */
  readonly timeoutMs: number;
  /** A lock older than this is treated as abandoned even if its pid is alive (pid reuse). 0 = never. */
  readonly staleMs: number;
  /**
   * True for a lock this process can only hold synchronously: a file naming our own pid is then a
   * leftover of an earlier run of this pid and is taken over.
   */
  readonly syncOnly: boolean;
  /** An async lock owned by our pid before this process image began cannot still be active (execve). */
  readonly ownPidBeforeMs?: number;
}

/** The lock's content when its holder is gone (to be removed exactly), `retry` when it vanished, null when it is held. */
export function judgeHolder(lockPath: string, options: FileLockOptions, nowMs: number): { gone: string } | 'retry' | null {
  const holder = readHolder(lockPath);
  if (holder.kind === 'missing') return 'retry'; // vanished between the open and the read
  if (holder.kind === 'unreadable') return nowMs - holder.mtimeMs > UNREADABLE_GRACE_MS ? { gone: holder.raw } : null;
  if (options.syncOnly && holder.pid === process.pid) return { gone: holder.raw };
  if (holder.pid === process.pid && options.ownPidBeforeMs !== undefined
    && holder.atMs < options.ownPidBeforeMs) return { gone: holder.raw };
  if (!pidAlive(holder.pid)) return { gone: holder.raw };
  const stale = options.staleMs > 0 && Number.isFinite(holder.atMs) && nowMs - holder.atMs > options.staleMs;
  return stale ? { gone: holder.raw } : null;
}

/**
 * A takeover guard is abandoned when its holder's pid is dead, or (pid reuse) when it is older than
 * this. A stalled but live taker keeps its guard for this long (a takeover takes microseconds).
 */
export const TAKEOVER_GUARD_STALE_MS = 60_000;

/**
 * Clear an abandoned takeover guard, only while it still holds exactly what was judged abandoned.
 * review: a clear by age alone could delete a fresh guard another taker had just made.
 */
export function clearAbandonedGuard(guard: string, nowMs: number): boolean {
  const held = readHolder(guard);
  if (held.kind === 'missing') return false;
  const abandoned = held.kind === 'unreadable'
    ? nowMs - held.mtimeMs > TAKEOVER_GUARD_STALE_MS
    : !pidAlive(held.pid) || (Number.isFinite(held.atMs) && nowMs - held.atMs > TAKEOVER_GUARD_STALE_MS);
  if (!abandoned) return false;
  return unlinkIfStill(guard, held.raw);
}

/** Unlink `file` only while it still holds exactly `judged` (a fresh file made since is kept). */
export function unlinkIfStill(file: string, judged: string): boolean {
  try {
    if (fs.readFileSync(file, 'utf8') !== judged) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the lock only if it still says `judged`, under the takeover guard `<lock>.takeover`.
 * While the guard is held nobody else removes the lock, and a lock that still names the dead
 * holder cannot change (no one can create over it; its owner is gone), so the content checked is
 * the content removed. A live lock is never moved or deleted by a taker (review: a rename
 * aside could take a live lock that changed hands and drop it when the link-back failed).
 */
export function removeJudgedLock(lockPath: string, judged: string): boolean {
  const guard = `${lockPath}.takeover`;
  const token = `${process.pid}:${Date.now()}`;
  if (!createLockWithContent(guard, token)) {
    clearAbandonedGuard(guard, Date.now());
    return false; // another taker is at work (or its abandoned guard was just cleared): retry later
  }
  try {
    return unlinkIfStill(lockPath, judged);
  } finally {
    try { if (fs.readFileSync(guard, 'utf8') === token) fs.unlinkSync(guard); } catch { /* ok */ }
  }
}

/** Create the lock with its token already inside: true when it is ours, false when it exists. */
function createLockWithContent(lockPath: string, token: string): boolean {
  const tmp = `${lockPath}.new.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, token, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw err;
    // No hard links here: `wx` (a reader may see it empty for an instant, which the grace covers).
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
      return true;
    } catch (wxErr) {
      if ((wxErr as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw wxErr;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ok */ }
  }
}

/** Try once. Returns a release function, or null when a live process holds the lock. */
export function tryAcquireFileLock(lockPath: string, options: FileLockOptions): (() => void) | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = `${process.pid}:${Date.now()}`;
    if (createLockWithContent(lockPath, token)) {
      return () => {
        // Release only our own lock (a takeover by another process after `staleMs` must survive).
        try {
          if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath);
        } catch { /* already gone */ }
      };
    }
    const verdict = judgeHolder(lockPath, options, Date.now());
    if (verdict === null) return null;
    if (verdict !== 'retry') removeJudgedLock(lockPath, verdict.gone);
  }
  return null;
}

/** Block (synchronously, bounded) until the lock is ours, run `fn`, release. */
export function withFileLockSync<T>(lockPath: string, options: FileLockOptions, fn: () => T): T {
  const deadline = Date.now() + options.timeoutMs;
  let release = tryAcquireFileLock(lockPath, options);
  while (release === null) {
    if (Date.now() >= deadline) throw new Error(`pe_store_locked: ${lockPath} is held by a running process`);
    sleepSync(5);
    release = tryAcquireFileLock(lockPath, options);
  }
  try {
    return fn();
  } finally {
    release();
  }
}
