/**
 * after a reboot the pidfile and the lock (both under $HOME) survive while pids restart from
 * 1, so the recorded pid may belong to an unrelated process. The node side must treat such a pid as
 * NOT our daemon — or `observe --if-not-running` (what the restart hook starts) would see the
 * stranger as a live lock holder and exit, leaving the device dark.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { claimObserverLock, isObserverProcess } from './service';
import { buildCaptureHealthReport } from './capture-health';

const kids: ChildProcess[] = [];
afterEach(() => { for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* gone */ } } });

describe('isObserverProcess', () => {
  it('recognizes the hosted bundle `observe`, the npm dispatcher `observe` and start-observer.js', () => {
    expect(isObserverProcess(1, () => '/home/box/.provian/node/bin/node\0/home/box/.provian/agent.js\0observe\0--if-not-running\0')).toBe(true);
    expect(isObserverProcess(1, () => '/usr/bin/node /x/dist/scripts/dispatch.js observe\n')).toBe(true);
    expect(isObserverProcess(1, () => '/usr/bin/node\0/x/dist/scripts/start-observer.js\0')).toBe(true);
    // review r1 defect 4: the package's `observe` bin run through its symlink.
    expect(isObserverProcess(1, () => 'node\0/usr/local/lib/node_modules/.bin/observe\0')).toBe(true);
    expect(isObserverProcess(1, () => '/usr/bin/node /home/u/node_modules/.bin/observe\n')).toBe(true);
  });

  it('RED control: a reused pid (a shell, the sandbox keeper, a zombie with no command line) is not ours', () => {
    expect(isObserverProcess(1, () => '/bin/bash\0-l\0')).toBe(false);
    expect(isObserverProcess(1, () => 'sand-exit-watch\0--observer\0')).toBe(false);
    expect(isObserverProcess(1, () => '')).toBe(false);
    // …and a path merely CONTAINING observe is not the bin.
    expect(isObserverProcess(1, () => '/usr/bin/python3\0/opt/observer/run.py\0')).toBe(false);
  });

  it('an unreadable command line answers true (never steal a live lock without evidence)', () => {
    expect(isObserverProcess(1, () => null)).toBe(true);
    expect(isObserverProcess(1, () => { throw new Error('EPERM'); })).toBe(true);
  });

  it('reads a real process: a stranger is not ours, a process started as `… agent.js observe` is', async () => {
    const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    const ours = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', '/tmp/x/.provian/agent.js', 'observe'], { stdio: 'ignore' });
    kids.push(stranger, ours);
    await new Promise((r) => setTimeout(r, 200));
    expect(isObserverProcess(stranger.pid as number)).toBe(false);
    expect(isObserverProcess(ours.pid as number)).toBe(true);
  });
});

describe('claimObserverLock after a reboot (default liveness)', () => {
  it('reclaims a lock whose recorded pid is now a live unrelated process', async () => {
    const lockDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provian-lock-')), 'observer.lock');
    const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    kids.push(stranger);
    await new Promise((r) => setTimeout(r, 200));
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'pid'), String(stranger.pid));
    expect(claimObserverLock({ pid: process.pid, ppid: process.ppid, env: {}, lockDir })).toEqual({ held: true });
    expect(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
  });

  it('RED control: a lock held by a live process that IS an observer is not reclaimed', async () => {
    const lockDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provian-lock-')), 'observer.lock');
    const ours = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', '/tmp/x/.provian/agent.js', 'observe'], { stdio: 'ignore' });
    kids.push(ours);
    await new Promise((r) => setTimeout(r, 200));
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'pid'), String(ours.pid));
    expect(claimObserverLock({ pid: process.pid, ppid: process.ppid, env: {}, lockDir })).toEqual({ held: false, holder: ours.pid });
  });
});

describe('capture-health restart_hook (closed set)', () => {
  const base = {
    harnesses: [], cursorTotal: 0, lastVerdictAtMs: null, lastVerdict: 'unknown' as const,
    lastCaptureAtMs: null, sqliteReadable: true, nowMs: 1,
  };
  it('reports shell_rc when the hook is in place, null otherwise', () => {
    expect(buildCaptureHealthReport({ ...base, restartHook: 'shell_rc' }).restart_hook).toBe('shell_rc');
    expect(buildCaptureHealthReport(base).restart_hook).toBeNull();
  });
  it('RED control: a value outside the closed set (a path) never reaches the wire', () => {
    const smuggled = '/home/box/.bashrc' as unknown as 'shell_rc';
    expect(buildCaptureHealthReport({ ...base, restartHook: smuggled }).restart_hook).toBeNull();
  });
});
