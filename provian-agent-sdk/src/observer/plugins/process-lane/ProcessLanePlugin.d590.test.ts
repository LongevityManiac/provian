/**
 * the process lane mints only the commands the agent's launcher started.
 *
 * Replays the process shapes measured on Grok's hosted sandbox (diagnostics 1–3, 2026-10-21): one
 * long-running harness `node` launches every command as a first-level `bash` with ONE fixed wrapper
 * line, follows each command with its own check (a second fixed line, one loopback fetch), and the
 * sandbox runs two `sleep 2` loops of its own. Each claim carries its RED control.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProcessLanePlugin, LAUNCHER_DRIFT_STREAK, FileActLedger, DISCOVERY_BOUND_MS, PROCESS_LANE_NO_LAUNCHER_INSTRUCTION, PROCESS_LANE_STATE_FILE_VERSION, PROCESS_LANE_ACTION_INSTRUCTION, PROCESS_LANE_INSIDE_COMMAND_INSTRUCTION, LAUNCHER_CHANGE_FLAG_COMMANDS } from './ProcessLanePlugin';
import { buildCaptureHealthReport, captureBrokenReason } from '../../capture-health';
import type { ProcEntry, ProcSnapshot, SnapshotReader } from './snapshot';
import type { ActLedger } from './acts';
import { launcherFingerprint, LAUNCHER_RECORD_SCHEMA, templateOf, writeLauncherRecord, readLauncherRecord, defaultLauncherProcReader } from './launcher';
import { defaultSnapshotReader, processStartedAtMs } from './snapshot';

// Several tests here run a whole lane over a timeline many times (each with its RED control): under a
// full-suite run they can pass 5 s of wall time.
vi.setConfig({ testTimeout: 30_000 });

class FakeLedger implements ActLedger {
  readonly minted = new Set<string>();
  readonly serviced = new Set<string>();
  hasMinted(k: string): boolean { return this.minted.has(k); }
  recordMinted(k: string): void { this.minted.add(k); }
  isServiced(i: string): boolean { return this.serviced.has(i); }
  recordServiced(i: string): void { this.serviced.add(i); }
  readonly claimed = new Set<string>();
  isClaimed(k: string): boolean { return this.claimed.has(k); }
  claim(keys: readonly string[]): void { for (const k of keys) this.claimed.add(k); }
  pruneClaims(isAlive: (k: string) => boolean): void { for (const k of [...this.claimed]) if (!isAlive(k)) this.claimed.delete(k); }
}
const observer = {
  getDeviceId: () => 'dev-grok', observerDeviceWitness: () => null, log: () => { /* silent */ },
} as unknown as import('../../ProvianObserver').ProvianObserver;

let nextPid = 10_000;
function proc(ppid: number, argv: string[], extra: Partial<ProcEntry> = {}): ProcEntry {
  const pid = extra.pid ?? nextPid++;
  return { pid, ppid, startKey: `${pid}:s`, argv, bytesWritten: 0, comm: path.basename(argv[0] ?? ''), uid: 1000, ...extra };
}

const INIT = proc(0, ['tini'], { pid: 1 });
const SANDBOX = proc(1, ['python3', '/sand/exit-watch.py'], { pid: 53, comm: 'sand-exit-watch' });
const HARNESS = proc(53, ['node', '/app/harness/server.js', '--port', '7000'], { pid: 388 });
const LOOP = proc(53, ['bash', '-c', 'while :; do sleep 2; ss -lnt | grep -q 7000; done'], { pid: 327 });
const OBSERVER = proc(1, ['node', '/home/u/.provian/agent.js', 'observe'], { pid: process.pid });
const FIXED = [INIT, SANDBOX, HARNESS, LOOP, OBSERVER];
/** The harness's command wrapper (its text carries a harness URL that must never price a command). */
const WRAPPER = ['bash', '--noprofile', '--norc', '-c', 'exec 3<>/run/cmd; cat <&3 | bash; curl -s https://harness.example.com/telemetry', 'wrap', 'x'];
/** The harness's own check after each command: a different fixed line, one loopback fetch. */
const CHECK = ['bash', '--noprofile', '--norc', '-c', 'curl -s http://127.0.0.1:7001/status; pwd', 'chk', 'y'];

function home(template: string[] = templateOf(WRAPPER)): { dir: string; launcherFile: string } {
  const mode = template.length > 0 ? 'template' as const : 'direct' as const;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
  const launcherFile = path.join(dir, 'process-launcher.json');
  writeLauncherRecord({
    schema: LAUNCHER_RECORD_SCHEMA,
    fingerprint: launcherFingerprint({ pid: HARNESS.pid, ppid: HARNESS.ppid, comm: HARNESS.comm ?? '', argv: HARNESS.argv }, null),
    mode, template, recorded_at_ms: 1, source: 'install',
  }, launcherFile);
  return { dir, launcherFile };
}

/** A timeline of snapshots, 250 ms apart; the loops relaunch `sleep 2` back to back every 2 s. */
class Timeline implements SnapshotReader {
  readonly snaps: ProcSnapshot[] = [];
  private i = 0;
  private loopSleep = proc(LOOP.pid, ['sleep', '2']);
  private t = 1000;
  step(extra: ProcEntry[] = []): void {
    if (this.snaps.length % 8 === 7) this.loopSleep = proc(LOOP.pid, ['sleep', '2']); // exits + next starts, same poll
    const procs = new Map<string, ProcEntry>();
    for (const e of [...FIXED, this.loopSleep, ...extra]) procs.set(e.startKey, e);
    this.snaps.push({ atMs: this.t, procs });
    this.t += 250;
  }
  idle(n: number): void { for (let k = 0; k < n; k++) this.step(); }
  /** One harness command: the wrapper tree for `polls` polls, then the harness's check for one poll. */
  command(children: ProcEntry[][], wrapperArgv = WRAPPER, uid = 1000): void {
    const root = proc(HARNESS.pid, wrapperArgv, { uid });
    for (const kids of children) this.step([root, ...kids.map((k) => ({ ...k, ppid: k.ppid === -1 ? root.pid : k.ppid }))]);
    const check = proc(HARNESS.pid, CHECK);
    this.step([check, proc(check.pid, ['curl', '-s', 'http://127.0.0.1:7001/status'])]);
  }
  read(): ProcSnapshot { const s = this.snaps[Math.min(this.i, this.snaps.length - 1)]; this.i += 1; return s; }
}

async function run(tl: Timeline, opts: { otherLane?: boolean; launcherFile?: string; dir?: string; uid?: number | null } = {}) {
  const h = opts.launcherFile ? { launcherFile: opts.launcherFile, dir: opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-')) } : home();
  const ledger = new FakeLedger();
  const plugin = new ProcessLanePlugin({
    reader: tl, ledger, identifyProgram: () => null, pollMs: 250, subtreeReader: null, platform: 'linux',
    otherLaneActive: () => opts.otherLane === true, launcherFile: h.launcherFile, stateDir: h.dir,
    uid: opts.uid === undefined ? 1000 : opts.uid,
    scanLight: () => new Map(FIXED.map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
    readEntry: (pid) => FIXED.find((e) => e.pid === pid) ?? null,
  });
  await plugin.init(observer);
  await plugin.start();
  await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
  return { plugin, ledger, dir: h.dir };
}

/** ls ~ (its own process too fast to see; the wrapper tree is), sleep 3, sleep 30 (with a fetch). */
function grokSession(tl: Timeline): void {
  tl.idle(2);
  tl.command([[]]);                                                       // ls ~
  tl.idle(10);
  tl.command(Array.from({ length: 12 }, () => [proc(-1, ['sleep', '3'], { pid: 20_001, startKey: '20001:s' })])); // sleep 3
  tl.idle(10);
  tl.command(Array.from({ length: 40 }, () => [
    proc(-1, ['sleep', '30'], { pid: 20_002, startKey: '20002:s' }),
    proc(-1, ['curl', '-s', 'https://api.example.org/v1/data'], { pid: 20_003, startKey: '20003:s' }),
  ]));                                                                      // sleep 30
  tl.idle(100);                                                             // past the 20 s seal grace
}

describe('one act per command the agent\'s launcher started (Grok\'s sandbox replay)', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  it('seals exactly three acts for ls ~, sleep 3, sleep 30 — none for the harness checks or the sandbox loops', async () => {
    const tl = new Timeline();
    grokSession(tl);
    const { plugin } = await run(tl);
    const pes = plugin.drainPEs();
    expect(pes).toHaveLength(3);
    expect(pes.every((pe) => pe.actionType === 'agent_tool_orchestration' && pe.metadata?.capture_lane === 'process' && pe.metadata?.tool_count === 1)).toBe(true);
    expect(new Set(pes.map((pe) => pe.idempotencyKey)).size).toBe(3);
    expect(plugin.getState()).toBe('active');
  });

  it('pricing parity: origins come from what the command ran, never from the harness wrapper every command shares', async () => {
    const tl = new Timeline();
    grokSession(tl);
    const { plugin } = await run(tl);
    const origins = plugin.drainPEs().flatMap((pe) => (pe.input_origins ?? []).map((o) => o.origin_identifier));
    expect(origins).toContain('domain:api.example.org');            // what sleep 30's command fetched
    expect(origins).not.toContain('domain:harness.example.com');   // the wrapper's own URL (RED in the old lane)
  });

  it('RED: the sandbox loops and the harness checks alone seal nothing', async () => {
    const tl = new Timeline();
    tl.idle(4);
    for (let k = 0; k < 5; k++) { const c = proc(HARNESS.pid, CHECK); tl.step([c]); tl.idle(3); }
    tl.idle(100);
    const { plugin } = await run(tl);
    expect(plugin.drainPEs()).toHaveLength(0);
  });

  it('a long command (past the 10-minute service cutoff) is still the agent\'s command and seals once', async () => {
    const tl = new Timeline();
    tl.idle(2);
    const kid = proc(-1, ['make', 'all'], { pid: 30_001, startKey: '30001:s' });
    tl.command(Array.from({ length: 4 * 60 * 11 }, () => [kid]));       // 11 minutes
    tl.idle(100);
    const { plugin } = await run(tl);
    expect(plugin.drainPEs()).toHaveLength(1);
  });

  it('another user\'s process under the launcher is never this agent\'s command (RED: the same command as this user seals)', async () => {
    const other = new Timeline();
    other.idle(2); other.command([[]], WRAPPER, 1001); other.idle(100);
    const mine = new Timeline();
    mine.idle(2); mine.command([[]], WRAPPER, 1000); mine.idle(100);
    expect((await run(other)).plugin.drainPEs()).toHaveLength(0);
    expect((await run(mine)).plugin.drainPEs()).toHaveLength(1);
  });
});

describe('one lane per program: inert where the agent has another lane', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  it('seals nothing when another lane is active (Atlas), and says so (RED: the same timeline seals three without it)', async () => {
    const a = new Timeline(); grokSession(a);
    const inert = await run(a, { otherLane: true });
    expect(inert.plugin.drainPEs()).toHaveLength(0);
    expect(inert.plugin.getState()).toBe('inert_other_lane');
    const b = new Timeline(); grokSession(b);
    expect((await run(b, { otherLane: false })).plugin.drainPEs()).toHaveLength(3);
  });

  it('seals nothing without a launcher record (unknown = block), and says so', async () => {
    const tl = new Timeline(); grokSession(tl);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
    const { plugin } = await run(tl, { launcherFile: path.join(dir, 'absent.json'), dir });
    expect(plugin.drainPEs()).toHaveLength(0);
    expect(plugin.getState()).toBe('no_launcher');
  });
});

describe(' addition 1 — a harness change never leaves the lane silently dark', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  const NEW_WRAPPER = ['bash', '--norc', '-c', 'v2 wrapper', 'wrap'];
  const NEW_CHECK = ['bash', '--norc', '-c', 'v2 check', 'chk'];

  it('the correction: launcher children that stop matching are a silent suspicion first — launcher_unconfirmed, no instruction file, nothing minted', async () => {
    const tl = new Timeline();
    tl.idle(2);
    for (let k = 0; k < LAUNCHER_DRIFT_STREAK / 2; k++) {
      tl.step([proc(HARNESS.pid, NEW_WRAPPER)]); tl.step([proc(HARNESS.pid, NEW_CHECK)]); tl.idle(2);
    }
    const { plugin, dir } = await run(tl);
    expect(plugin.getState()).toBe('launcher_unconfirmed');
    expect(fs.existsSync(path.join(dir, 'witness-action-required.json'))).toBe(false);
    expect(plugin.drainPEs()).toHaveLength(0);                       // nothing minted from the unmatched children
  });

  it('the correction: once the agent\'s commands have had their chance — that many of them ran the new way, each followed at once by the harness\'s check — and no `provian` command re-recorded the wrapper, the change is confirmed: launcher_changed with the instruction file, since the streak began (RED: one command short stays a suspicion)', async () => {
    const build = (commands: number) => {
      nextPid = 10_000;
      const tl = new Timeline();
      tl.idle(2);
      // The agent's next tool call comes seconds after the harness's check, never inside its window.
      for (let k = 0; k < commands; k++) { tl.step([proc(HARNESS.pid, NEW_WRAPPER)]); tl.step([proc(HARNESS.pid, NEW_CHECK)]); tl.idle(8); }
      return tl;
    };
    // Each command and its unlearned check both join the streak: the suspicion is written after
    // LAUNCHER_DRIFT_STREAK / 2 commands, and the agent's chance is the next LAUNCHER_CHANGE_FLAG_COMMANDS.
    const enough = LAUNCHER_DRIFT_STREAK / 2 + LAUNCHER_CHANGE_FLAG_COMMANDS;
    const short = await run(build(enough - 1));
    expect(short.plugin.getState()).toBe('launcher_unconfirmed');
    expect(fs.existsSync(path.join(short.dir, 'witness-action-required.json'))).toBe(false);
    const full = await run(build(enough));
    expect(full.plugin.getState()).toBe('launcher_changed');
    const action = JSON.parse(fs.readFileSync(path.join(full.dir, 'witness-action-required.json'), 'utf8'));
    expect(action).toEqual({ instruction: PROCESS_LANE_ACTION_INSTRUCTION, lane: 'process', state: 'launcher_changed' });
    const written = JSON.parse(fs.readFileSync(path.join(full.dir, 'process-lane-state.json'), 'utf8')) as { state: string; cause: string; v: number; since_ms: number; at_ms: number };
    expect(written).toMatchObject({ state: 'launcher_changed', cause: 'wrapper', v: PROCESS_LANE_STATE_FILE_VERSION });
    // The card's moment is when the first command went unwitnessed (each command here takes 1 s), never when it was flagged.
    expect(written.at_ms - written.since_ms).toBeGreaterThanOrEqual((enough - 1) * 2_500);
  });

  it('the correction: an idle harness whose own unlearned check differs run to run is never flagged however long it idles — nothing follows its check at once (RED: the same children each followed by another are)', async () => {
    const build = (followed: boolean) => {
      nextPid = 10_000;
      const tl = new Timeline();
      tl.idle(2);
      for (let k = 0; k < LAUNCHER_DRIFT_STREAK * 4; k++) {
        tl.step([proc(HARNESS.pid, k % 2 === 0 ? NEW_WRAPPER : NEW_CHECK)]);
        if (followed) tl.step([proc(HARNESS.pid, ['bash', '--norc', '-c', `next ${k}`, 'n'])]);
        tl.idle(4);
      }
      return tl;
    };
    const idle = await run(build(false));
    expect(idle.plugin.getState()).toBe('launcher_unconfirmed');
    expect(fs.existsSync(path.join(idle.dir, 'witness-action-required.json'))).toBe(false);
    expect((await run(build(true))).plugin.getState()).toBe('launcher_changed');
  });

  it('RED: the harness\'s one repeated check (no command for a while) is not a harness change', async () => {
    const tl = new Timeline();
    tl.idle(2);
    for (let k = 0; k < LAUNCHER_DRIFT_STREAK * 2; k++) { tl.step([proc(HARNESS.pid, CHECK)]); tl.idle(2); }
    const { plugin, dir } = await run(tl);
    expect(plugin.getState()).toBe('active');
    expect(fs.existsSync(path.join(dir, 'witness-action-required.json'))).toBe(false);
  });

  it('recovers: after the flag, a matching command clears the state and removes the lane\'s instruction', async () => {
    const tl = new Timeline();
    tl.idle(2);
    for (let k = 0; k < LAUNCHER_DRIFT_STREAK / 2; k++) { tl.step([proc(HARNESS.pid, NEW_WRAPPER)]); tl.step([proc(HARNESS.pid, NEW_CHECK)]); tl.idle(2); }
    tl.command([[]]);
    tl.idle(4);
    const { plugin, dir } = await run(tl);
    expect(plugin.getState()).toBe('active');
    expect(fs.existsSync(path.join(dir, 'witness-action-required.json'))).toBe(false);
  });
});

describe('a re-record never loses the command that is running or about to run', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  it('re-recording while a command runs does not re-baseline it away: that command still seals (RED with a re-baseline)', async () => {
    const h = home();
    const tl = new Timeline();
    tl.idle(4);
    tl.command(Array.from({ length: 24 }, () => [proc(-1, ['sleep', '6'], { pid: 40_001, startKey: '40001:s' })]));
    tl.idle(100);
    const ledger = new FakeLedger();
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger, identifyProgram: () => null, pollMs: 250, subtreeReader: null, platform: 'linux',
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map(FIXED.map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => FIXED.find((e) => e.pid === pid) ?? null,
    });
    await plugin.init(observer);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * 10);                 // the command is running
    const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));
    fs.writeFileSync(h.launcherFile, JSON.stringify({ ...rec, recorded_at_ms: 2, source: 'record' })); // `process-lane record`
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 11));
    expect(plugin.drainPEs()).toHaveLength(1);
  });
});

describe(' — fork before exec, re-record, a single changed wrapper, unknown owner', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  it('a launcher child first seen between fork and exec is decided once it execs: the command seals (RED: a fork that never execs seals nothing)', async () => {
    const tl = new Timeline();
    tl.idle(2);
    const fork = proc(HARNESS.pid, [...HARNESS.argv], { pid: 50_001, startKey: '50001:s' });   // still the harness's argv
    tl.step([fork]);
    const execd = { ...fork, argv: WRAPPER, comm: 'bash' };                               // same pid + start: exec'd
    tl.step([execd, proc(fork.pid, ['ls', '/root'])]);
    tl.step([execd]);
    tl.idle(100);
    expect((await run(tl)).plugin.drainPEs()).toHaveLength(1);

    nextPid = 10_000;
    const bare = new Timeline();
    bare.idle(2);
    const worker = proc(HARNESS.pid, [...HARNESS.argv], { pid: 50_002, startKey: '50002:s' });
    bare.step([worker]); bare.step([worker]);
    bare.idle(100);
    expect((await run(bare)).plugin.drainPEs()).toHaveLength(0);
  });

  it('a re-record clears launcher_unconfirmed at once, with no further command (RED: without it the flag stays)', async () => {
    const h = home();
    const tl = new Timeline();
    tl.idle(2);
    for (let k = 0; k < LAUNCHER_DRIFT_STREAK / 2; k++) {
      tl.step([proc(HARNESS.pid, ['bash', '--norc', '-c', 'v2 wrapper', 'wrap'])]);
      tl.step([proc(HARNESS.pid, ['bash', '--norc', '-c', 'v2 check', 'chk'])]);
      tl.idle(2);
    }
    tl.idle(40);
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, subtreeReader: null, platform: 'linux',
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map(FIXED.map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => FIXED.find((e) => e.pid === pid) ?? null,
    });
    await plugin.init(observer);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * 26);
    expect(plugin.getState()).toBe('launcher_unconfirmed');
    const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));
    fs.writeFileSync(h.launcherFile, JSON.stringify({ ...rec, template: templateOf(['bash', '--norc', '-c', 'v2 wrapper', 'wrap']), recorded_at_ms: 2, source: 'record' }));
    await vi.advanceTimersByTimeAsync(250 * 8);
    expect(plugin.getState()).toBe('active');
    expect(fs.existsSync(path.join(h.dir, 'witness-action-required.json'))).toBe(false);
  });

  it('a harness update to ONE new fixed wrapper is suspected: its commands run different trees; it is confirmed once each command is followed at once by the harness\'s check (RED: one repeated check is not suspected at all)', async () => {
    const tl = new Timeline();
    tl.idle(2);
    const W2 = ['bash', '--norc', '-c', 'v2 fixed wrapper', 'wrap'];
    const work = [['ls', '/root'], ['sleep', '3'], ['git', 'status'], ['cat', 'a.txt'], ['make'], ['pwd'], ['uname', '-a']];
    for (const argv of work) { const r = proc(HARNESS.pid, W2); tl.step([r, proc(r.pid, argv)]); tl.idle(8); }
    tl.idle(4);
    const { plugin, dir } = await run(tl);
    expect(plugin.getState()).toBe('launcher_unconfirmed');
    expect(fs.existsSync(path.join(dir, 'witness-action-required.json'))).toBe(false);   // a suspicion asks nothing yet
    nextPid = 10_000;
    const more = new Timeline();
    more.idle(2);
    for (let k = 0; k < 4 * LAUNCHER_CHANGE_FLAG_COMMANDS; k++) { const r = proc(HARNESS.pid, W2); more.step([r, proc(r.pid, work[k % work.length])]); more.idle(8); }
    more.idle(4);
    // Declared limit (the correction): a harness that starts nothing right after a command gives
    // no evidence its children are the agent's commands, so this stays an unshown suspicion until the
    // agent's next `provian` command re-records it.
    const unchecked = await run(more);
    expect(unchecked.plugin.getState()).toBe('launcher_unconfirmed');
    expect(fs.existsSync(path.join(unchecked.dir, 'witness-action-required.json'))).toBe(false);
    // The same harness running its check right after each command: confirmed.
    nextPid = 10_000;
    const checked = new Timeline();
    checked.idle(2);
    for (let k = 0; k < LAUNCHER_DRIFT_STREAK + LAUNCHER_CHANGE_FLAG_COMMANDS; k++) { const r = proc(HARNESS.pid, W2); checked.step([r, proc(r.pid, work[k % work.length])]); checked.step([proc(HARNESS.pid, CHECK)]); checked.idle(8); }
    checked.idle(4);
    const confirmed = await run(checked);
    expect(confirmed.plugin.getState()).toBe('launcher_changed');
    expect(fs.existsSync(path.join(confirmed.dir, 'witness-action-required.json'))).toBe(true);
  });

  it('a process whose owner the OS did not report is not this agent\'s (unknown = block; RED: the same with this uid seals)', async () => {
    const tl = new Timeline();
    tl.idle(2);
    const root = { ...proc(HARNESS.pid, WRAPPER), uid: undefined };
    tl.step([root]); tl.step([root]);
    tl.idle(100);
    expect((await run(tl)).plugin.drainPEs()).toHaveLength(0);
    nextPid = 10_000;
    const mine = new Timeline();
    mine.idle(2);
    const r2 = proc(HARNESS.pid, WRAPPER);
    mine.step([r2]); mine.step([r2]);
    mine.idle(100);
    expect((await run(mine)).plugin.drainPEs()).toHaveLength(1);
  });
});

describe(' — a launcher that hands the command to its child itself is unsupported, never minted', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  it('a direct-mode record mints nothing and reports launcher_unsupported (RED: the same commands under a template record seal)', async () => {
    const tl = new Timeline();
    grokSession(tl);
    const h = home([]);
    const { plugin } = await run(tl, { launcherFile: h.launcherFile, dir: h.dir });
    expect(plugin.drainPEs()).toHaveLength(0);
    expect(plugin.getState()).toBe('launcher_unsupported');
    const report = buildCaptureHealthReport({ harnesses: [], cursorTotal: 0, lastVerdictAtMs: null, lastVerdict: 'idle', lastCaptureAtMs: null, sqliteReadable: true, nowMs: 0,
      process: { active: true, watching: false, actsEverSealed: false, lastActAtMs: null, state: plugin.getState() } });
    expect(captureBrokenReason(report)).toBe('process_launcher_unsupported');
    nextPid = 10_000;
    const t2 = new Timeline(); grokSession(t2);
    expect((await run(t2)).plugin.drainPEs()).toHaveLength(3);
  });

  it('a template-mode root first read with no command line (mid-exec) is decided once readable, and seals once', async () => {
    const tl = new Timeline();
    tl.idle(2);
    const root = proc(HARNESS.pid, [], { pid: 60_001, startKey: '60001:s' });
    tl.step([root]);
    tl.step([{ ...root, argv: WRAPPER }]);
    tl.step([{ ...root, argv: WRAPPER }]);
    tl.idle(100);
    expect((await run(tl)).plugin.drainPEs()).toHaveLength(1);
  });
});

/** A bare timeline (no fixed harness), 250 ms per snapshot. */
class RawTimeline implements SnapshotReader {
  readonly snaps: ProcSnapshot[] = [];
  private t = 1000;
  i = 0;
  step(entries: ProcEntry[]): void {
    const procs = new Map<string, ProcEntry>();
    for (const e of entries) procs.set(e.startKey, e);
    this.snaps.push({ atMs: this.t, procs });
    this.t += 250;
  }
  read(): ProcSnapshot { const s = this.snaps[Math.min(this.i, this.snaps.length - 1)]; this.i += 1; return s; }
  current(): ProcSnapshot { return this.snaps[Math.min(Math.max(this.i - 1, 0), this.snaps.length - 1)]; }
}

/** A timeline indexed by the clock: the machine moves on while the lane reads nothing. */
class ClockTimeline extends RawTimeline {
  private t0 = Date.now();
  start(): void { this.t0 = Date.now(); }
  private at(): ProcSnapshot { return this.snaps[Math.min(Math.floor((Date.now() - this.t0) / 250), this.snaps.length - 1)]; }
  override read(): ProcSnapshot { this.i += 1; return this.at(); }
  override current(): ProcSnapshot { return this.at(); }
}

describe(' restart episode — a harness restart or machine update never stops the lane minting', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  /** The harness restarts as pid 777 through `sh -c "…; exec node server.js"`: for its first 4 s the
   *  process is `sh`, then (same pid, same start key) it is the harness. */
  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const PRE = proc(53, ['sh', '-c', 'sleep 3; exec node /app/harness/server.js --port 7000'], { pid: 777, startKey: '777:s', comm: 'sh' });
  const POST: ProcEntry = { ...PRE, argv: [...HARNESS.argv], comm: 'node' };

  function restartTimeline(): RawTimeline {
    const tl = new RawTimeline();
    for (let k = 0; k < 16; k++) tl.step([...BASE, PRE]);
    for (let k = 0; k < 20; k++) tl.step([...BASE, POST]);
    const root = proc(777, WRAPPER, { pid: 70_001, startKey: '70001:s' });
    const kid = proc(root.pid, ['ls', '/root'], { pid: 70_002, startKey: '70002:s' });
    for (let k = 0; k < 8; k++) tl.step([...BASE, POST, root, kid]);
    for (let k = 0; k < 400; k++) tl.step([...BASE, POST]);
    return tl;
  }

  async function runRestart(tl: RawTimeline, extra: Partial<import('./ProcessLanePlugin').ProcessLaneOptions> = {}) {
    const h = home();
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, subtreeReader: null, platform: 'linux',
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, discoveryMs: 500,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      ...extra,
    });
    await plugin.init(observer);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    return plugin;
  }

  /** The Linux fast reader's shape: only the subtrees of the launchers discovery found. */
  const subtreeOf = (tl: RawTimeline) => ({
    read(pids: readonly number[], atMs: number): ProcSnapshot {
      const all = [...tl.read().procs.values()];
      const keep = new Set<number>(pids);
      for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
      const procs = new Map<string, ProcEntry>();
      for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e);
      return { atMs, procs };
    },
  });

  it('discovery that first meets the restarted harness before its exec still binds to it: the command seals (RED: a fingerprint cached by start key alone never does)', async () => {
    expect((await runRestart(restartTimeline())).drainPEs()).toHaveLength(1);
    // The Linux fast reader (production): only discovery's launchers are read.
    const tl = restartTimeline();
    expect((await runRestart(tl, { subtreeReader: subtreeOf(tl), fastMs: 250 })).drainPEs()).toHaveLength(1);
  });

  it('the independent audit re-binds the lane when discovery misses the launcher, and the command seals (RED: without the audit, nothing seals)', async () => {
    const t1 = restartTimeline();
    const blind = await runRestart(t1, { readEntry: () => null, subtreeReader: subtreeOf(t1), fastMs: 250 });
    expect(blind.drainPEs()).toHaveLength(0);
    const tl = restartTimeline();
    const healed = await runRestart(tl, { readEntry: () => null, subtreeReader: subtreeOf(tl), fastMs: 250, auditMs: 1_000, auditScan: () => tl.current() });
    expect(healed.drainPEs()).toHaveLength(1);
    // The heal sticks: discovery keeps the audit's launcher, so it is re-bound once, not on every audit.
    expect(healed.takeCaptureWindow().launcherHeals).toBe(1);
  });

  it('capture health alarms when the launcher is live and starting matching commands but nothing seals (RED: when the lane seals them, no alarm)', async () => {
    // The lane's reader is blind to the command; the audit's fresh read is not.
    const shown = new RawTimeline();
    const hidden = new RawTimeline();
    const root = proc(HARNESS.pid, WRAPPER, { pid: 80_001, startKey: '80001:s' });
    for (let k = 0; k < 8; k++) { shown.step(FIXED); hidden.step(FIXED); }
    for (let k = 0; k < 12; k++) { shown.step([...FIXED, root]); hidden.step(FIXED); }
    for (let k = 0; k < 480; k++) { shown.step(FIXED); hidden.step(FIXED); }
    const h = home();
    const mk = (reader: RawTimeline) => new ProcessLanePlugin({
      reader, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, subtreeReader: null, platform: 'linux',
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, auditMs: 1_000,
      auditScan: () => shown.snaps[Math.min(reader.i - 1, shown.snaps.length - 1)],
      scanLight: () => new Map(FIXED.map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => FIXED.find((e) => e.pid === pid) ?? null,
    });
    const healthOf = (w: import('./ProcessLanePlugin').ProcessLaneWindow) => captureBrokenReason(buildCaptureHealthReport({
      harnesses: [], cursorTotal: 0, lastVerdictAtMs: null, lastVerdict: 'idle', lastCaptureAtMs: null, sqliteReadable: true, nowMs: 0,
      process: { active: true, watching: true, actsEverSealed: false, lastActAtMs: null, state: 'active', window: w } }));

    const blind = mk(hidden);
    await blind.init(observer); await blind.start();
    await vi.advanceTimersByTimeAsync(250 * (hidden.snaps.length - 1));
    expect(blind.drainPEs()).toHaveLength(0);
    const w = blind.takeCaptureWindow();
    expect(w.launcherLive).toBe(true);
    expect(w.commandsDue).toBe(1);
    expect(w.commandsDueSealed).toBe(0);
    expect(healthOf(w)).toBe('process_lane_silence');

    shown.i = 0;
    const seeing = mk(shown);
    await seeing.init(observer); await seeing.start();
    await vi.advanceTimersByTimeAsync(250 * (shown.snaps.length - 1));
    expect(seeing.drainPEs()).toHaveLength(1);
    const w2 = seeing.takeCaptureWindow();
    expect(w2.commandsDue).toBe(1);
    expect(w2.commandsDueSealed).toBe(1);
    expect(healthOf(w2)).toBeNull();
  });
});

describe(' — an instruction left by an earlier daemon does not outlive the fix', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  it('a restarted daemon that finds the lane healthy removes the process lane\'s stale action file (RED: another lane\'s file is kept)', async () => {
    const h = home();
    const action = path.join(h.dir, 'witness-action-required.json');
    fs.writeFileSync(action, JSON.stringify({ instruction: 'x', lane: 'process', state: 'launcher_changed' }));
    const tl = new Timeline(); tl.idle(8);
    await run(tl, { launcherFile: h.launcherFile, dir: h.dir });
    expect(fs.existsSync(action)).toBe(false);
    const h2 = home();
    const other = path.join(h2.dir, 'witness-action-required.json');
    fs.writeFileSync(other, JSON.stringify({ instruction: 'y', lane: 'transcript' }));
    const t2 = new Timeline(); t2.idle(8);
    await run(t2, { launcherFile: h2.launcherFile, dir: h2.dir });
    expect(fs.existsSync(other)).toBe(true);
  });
});

describe(' — no restart, update or background job darkens the lane or fakes an alarm', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  /** The full-scan lane (macOS, or Linux without per-thread children lists), audit reading the same machine. */
  async function runFull(tl: RawTimeline, o: { h?: { dir: string; launcherFile: string }; identify?: (e: { argv?: readonly string[] }) => string | null; subtree?: boolean; stopAfter?: boolean } = {}) {
    const h = o.h ?? home();
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: o.identify ?? (() => null), pollMs: 250, platform: 'linux',
      subtreeReader: o.subtree ? subtreeOf(tl) : null, ...(o.subtree ? { fastMs: 250 } : {}),
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      auditScan: () => tl.current(),
    });
    await plugin.init(observer);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    if (o.stopAfter) await plugin.stop();
    return { plugin, h };
  }
  const subtreeOf = (tl: RawTimeline) => ({
    read(pids: readonly number[], atMs: number): ProcSnapshot {
      const all = [...tl.read().procs.values()];
      const keep = new Set<number>(pids);
      for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
      const procs = new Map<string, ProcEntry>();
      for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e);
      return { atMs, procs };
    },
  });
  /** One command under `launcher`: the wrapper and a child for `polls` reads. */
  function command(tl: RawTimeline, fixed: ProcEntry[], launcher: number, polls = 2, child: string[] = ['ls', '/root']): void {
    const root = proc(launcher, WRAPPER);
    const kid = proc(root.pid, child);
    for (let k = 0; k < polls; k++) tl.step([...fixed, root, kid]);
  }

  it('a harness restarted AFTER the daemon started, through `sh -c "exec node …"`, is promoted the moment it execs: every command seals, including one started at once (RED: the same harness never exec\'ing — a shell, not the launcher — seals nothing)', async () => {
    const make = (execs: boolean): RawTimeline => {
      const tl = new RawTimeline();
      // Discovery reads every 2 s (8 reads): the harness execs at read 9 and its first command is
      // over by read 12, before the next discovery at read 16.
      for (let k = 0; k < 8; k++) tl.step(BASE);
      const pre = proc(53, ['sh', '-c', 'exec node /app/harness/server.js --port 7000'], { pid: 777, startKey: '777:s', comm: 'sh' });
      tl.step([...BASE, pre]);
      const post: ProcEntry = execs ? { ...pre, argv: [...HARNESS.argv], comm: 'node' } : pre;
      tl.step([...BASE, post]);
      command(tl, [...BASE, post], 777, 2);          // right after the exec, gone before the next discovery
      for (let k = 0; k < 12; k++) tl.step([...BASE, post]);
      for (let c = 0; c < 2; c++) { command(tl, [...BASE, post], 777, 2); for (let k = 0; k < 6; k++) tl.step([...BASE, post]); }
      for (let k = 0; k < 120; k++) tl.step([...BASE, post]);
      return tl;
    };
    const { plugin } = await runFull(make(true));
    expect(plugin.drainPEs()).toHaveLength(3);
    // The audit judges what it saw once it found the new launcher (every 15 s); each of those sealed.
    const w = plugin.takeCaptureWindow();
    expect(w.commandsDueSealed).toBe(w.commandsDue);
    nextPid = 10_000;
    expect((await runFull(make(false))).plugin.drainPEs()).toHaveLength(0);
  });

  it('a harness started through `npm start` after the daemon started is the launcher from its first read (RED: the npm process itself never is)', async () => {
    const tl = new RawTimeline();
    for (let k = 0; k < 4; k++) tl.step(BASE);
    const npm = proc(53, ['npm', 'start'], { pid: 880, startKey: '880:s' });
    const harness = proc(880, [...HARNESS.argv], { pid: 881, startKey: '881:s' });
    tl.step([...BASE, npm, harness]);
    const fixed = [...BASE, npm, harness];
    command(tl, fixed, 881, 2);
    for (let k = 0; k < 6; k++) tl.step(fixed);
    command(tl, fixed, 880, 2);                       // npm's own child: never a command
    for (let k = 0; k < 120; k++) tl.step(fixed);
    expect((await runFull(tl)).plugin.drainPEs()).toHaveLength(1);
  });

  it('the harness\'s supervisor exits (the harness is reparented) and the lane keeps minting, live and after a daemon restart (RED: a harness replaced by a different program is not the launcher)', async () => {
    const reparented: ProcEntry = { ...HARNESS, ppid: 1 };
    const make = (after: ProcEntry): RawTimeline => {
      const tl = new RawTimeline();
      for (let k = 0; k < 4; k++) tl.step([INIT, SANDBOX, HARNESS, OBSERVER]);
      for (let k = 0; k < 4; k++) tl.step([INIT, after, OBSERVER]);   // the supervisor (53) is gone
      command(tl, [INIT, after, OBSERVER], after.pid, 2);
      for (let k = 0; k < 120; k++) tl.step([INIT, after, OBSERVER]);
      return tl;
    };
    expect((await runFull(make(reparented))).plugin.drainPEs()).toHaveLength(1);
    nextPid = 10_000;
    { const tl = make(reparented); expect((await runFull(tl, { subtree: true })).plugin.drainPEs()).toHaveLength(1); }
    // A daemon started after the reparent: its first read already has the harness under init.
    nextPid = 10_000;
    const late = new RawTimeline();
    for (let k = 0; k < 4; k++) late.step([INIT, reparented, OBSERVER]);
    command(late, [INIT, reparented, OBSERVER], HARNESS.pid, 2);
    for (let k = 0; k < 120; k++) late.step([INIT, reparented, OBSERVER]);
    expect((await runFull(late)).plugin.drainPEs()).toHaveLength(1);
    nextPid = 10_000;
    const other: ProcEntry = proc(1, ['python3', '/app/other.py'], { pid: 389, startKey: '389:s' });
    expect((await runFull(make(other))).plugin.drainPEs()).toHaveLength(0);
  });

  it('the audit judges every lane read, so a lane that sees short commands but seals none alarms (RED: the same lane sealing them does not; a 15 s sample alone saw almost none)', async () => {
    const make = (): RawTimeline => {
      const tl = new RawTimeline();
      const fixed = [...BASE, HARNESS];
      for (let k = 0; k < 4; k++) tl.step(fixed);
      for (let c = 0; c < 5; c++) { command(tl, fixed, HARNESS.pid, 1); for (let k = 0; k < 9; k++) tl.step(fixed); }
      for (let k = 0; k < 400; k++) tl.step(fixed);
      return tl;
    };
    const healthOf = (w: import('./ProcessLanePlugin').ProcessLaneWindow) => captureBrokenReason(buildCaptureHealthReport({
      harnesses: [], cursorTotal: 0, lastVerdictAtMs: null, lastVerdict: 'idle', lastCaptureAtMs: null, sqliteReadable: true, nowMs: 0,
      process: { active: true, watching: true, actsEverSealed: false, lastActAtMs: null, state: 'active', window: w } }));
    // The lane's own judgement goes wrong (here: it wrongly takes the wrapper for another lane's program).
    const wrong = await runFull(make(), { identify: (e) => (e.argv?.[0] === 'bash' ? 'other' : null) });
    expect(wrong.plugin.drainPEs()).toHaveLength(0);
    const w = wrong.plugin.takeCaptureWindow();
    expect(w.commandsDue).toBe(5);
    expect(w.commandsDueSealed).toBe(0);
    expect(healthOf(w)).toBe('process_lane_silence');
    nextPid = 10_000;
    const right = await runFull(make());
    expect(right.plugin.drainPEs()).toHaveLength(5);
    const w2 = right.plugin.takeCaptureWindow();
    expect([w2.commandsDue, w2.commandsDueSealed]).toEqual([5, 5]);
    expect(healthOf(w2)).toBeNull();
  });

  it('a command that backgrounds a server seals when its own tree ends, and is no false alarm (RED: a server still under the wrapper keeps the command open, never due)', async () => {
    const make = (detaches: boolean): RawTimeline => {
      const tl = new RawTimeline();
      const fixed = [...BASE, HARNESS];
      for (let k = 0; k < 4; k++) tl.step(fixed);
      const root = proc(HARNESS.pid, WRAPPER);
      const server = proc(root.pid, ['python3', '-m', 'http.server']);
      tl.step([...fixed, root, server]);
      tl.step([...fixed, root, server]);
      for (let k = 0; k < 400; k++) tl.step(detaches ? [...fixed, { ...server, ppid: 1 }] : [...fixed, root, server]);
      return tl;
    };
    const { plugin } = await runFull(make(true));
    expect(plugin.drainPEs()).toHaveLength(1);
    const w = plugin.takeCaptureWindow();
    expect([w.commandsDue, w.commandsDueSealed]).toEqual([1, 1]);
    nextPid = 10_000;
    const still = await runFull(make(false));
    expect(still.plugin.drainPEs()).toHaveLength(0);
    expect(still.plugin.takeCaptureWindow().commandsDue).toBe(0);
  });

  it('a daemon restart keeps a flag the lane raised until it clears on its own evidence (RED: a flag raised under another record is cleared)', async () => {
    const h = home();
    const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));
    const recordKey = `${rec.fingerprint}:${rec.mode}:${rec.template.join(',')}:${rec.recorded_at_ms}`;
    const sha = (v: string) => require('crypto').createHash('sha256').update(v, 'utf8').digest('hex') as string;
    const action = path.join(h.dir, 'witness-action-required.json');
    const flag = (record: string, state = 'launcher_unconfirmed') => {
      fs.writeFileSync(path.join(h.dir, 'process-lane-state.json'), JSON.stringify({ state, at_ms: 5, since_ms: 1, v: PROCESS_LANE_STATE_FILE_VERSION, record }));
      fs.writeFileSync(action, JSON.stringify({ instruction: 'x', lane: 'process', state }));
    };
    flag(sha(recordKey));
    const quiet = new RawTimeline();
    for (let k = 0; k < 40; k++) quiet.step([...BASE, HARNESS]);
    const a = await runFull(quiet, { h });
    expect(a.plugin.getState()).toBe('launcher_unconfirmed');
    // the restored flag keeps the moment it was first raised.
    expect(a.plugin.getStateSinceMs()).toBe(1);
    // The correction: a suspicion asks nothing — an earlier daemon's instruction file for it goes.
    expect(fs.existsSync(action)).toBe(false);
    // A command the recorded way clears it.
    nextPid = 10_000;
    const busy = new RawTimeline();
    for (let k = 0; k < 4; k++) busy.step([...BASE, HARNESS]);
    command(busy, [...BASE, HARNESS], HARNESS.pid, 2);
    for (let k = 0; k < 20; k++) busy.step([...BASE, HARNESS]);
    const b = await runFull(busy, { h });
    expect(b.plugin.getState()).toBe('active');
    expect(fs.existsSync(action)).toBe(false);
    // RED: raised under a different record (the agent re-recorded while the daemon was down).
    flag(sha('another-record'));
    const quiet2 = new RawTimeline();
    for (let k = 0; k < 40; k++) quiet2.step([...BASE, HARNESS]);
    const c = await runFull(quiet2, { h });
    expect(c.plugin.getState()).toBe('active');
    expect(fs.existsSync(action)).toBe(false);
  });

  it(' a restored CONFIRMED change ends once a launcher is bound outside the agent\'s commands — an idle agent whose harness is back is never left reported broken (RED: with no launcher bound it stands, with its moment)', async () => {
    const sha = (v: string) => require('crypto').createHash('sha256').update(v, 'utf8').digest('hex') as string;
    const restart = async (withHarness: boolean) => {
      const h = home();
      const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));
      const record = sha(`${rec.fingerprint}:${rec.mode}:${rec.template.join(',')}:${rec.recorded_at_ms}`);
      fs.writeFileSync(path.join(h.dir, 'process-lane-state.json'), JSON.stringify({ state: 'launcher_changed', at_ms: 5, since_ms: 1, v: PROCESS_LANE_STATE_FILE_VERSION, record }));
      nextPid = 10_000;
      const quiet = new RawTimeline();
      for (let k = 0; k < 40; k++) quiet.step(withHarness ? [...BASE, HARNESS] : [...BASE]);
      const { plugin } = await runFull(quiet, { h });
      return { state: plugin.getState(), since: plugin.getStateSinceMs(), action: fs.existsSync(path.join(h.dir, 'witness-action-required.json')) };
    };
    expect(await restart(true)).toMatchObject({ state: 'active', action: false });
    expect(await restart(false)).toEqual({ state: 'launcher_changed', since: 1, action: true });
  });

  it(' a restart that lands in the state its predecessor wrote keeps that state\'s moment — no_launcher too (RED: a state written under another record starts now)', async () => {
    const sha = (v: string) => require('crypto').createHash('sha256').update(v, 'utf8').digest('hex') as string;
    const restart = async (record: string, v: number | null = PROCESS_LANE_STATE_FILE_VERSION) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
      fs.writeFileSync(path.join(dir, 'process-lane-state.json'), JSON.stringify({ state: 'no_launcher', at_ms: 5, since_ms: 2, v, record }));
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 8; k++) tl.step([...BASE, HARNESS]);
      const { plugin } = await runFull(tl, { h: { dir, launcherFile: path.join(dir, 'process-launcher.json') } });
      return { state: plugin.getState(), since: plugin.getStateSinceMs() };
    };
    expect(await restart(sha(''))).toEqual({ state: 'no_launcher', since: 2 });
    const other = await restart(sha('another-record'));
    expect(other.state).toBe('no_launcher');
    expect(other.since).not.toBe(2);
    // RED: a file from before this release names states in their old meaning — never carried over.
    expect((await restart(sha(''), null)).since).not.toBe(2);
  });

  it(' a flag file from before this release said launcher_changed for a suspicion too — it is restored as launcher_unconfirmed with its moment and no instruction, never as a confirmed change (RED: a file from this release stays confirmed)', async () => {
    const sha = (v: string) => require('crypto').createHash('sha256').update(v, 'utf8').digest('hex') as string;
    const restore = async (file: Record<string, unknown>, withHarness = true) => {
      const h = home();
      const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));
      const record = sha(`${rec.fingerprint}:${rec.mode}:${rec.template.join(',')}:${rec.recorded_at_ms}`);
      fs.writeFileSync(path.join(h.dir, 'process-lane-state.json'), JSON.stringify({ ...file, record }));
      nextPid = 10_000;
      const quiet = new RawTimeline();
      for (let k = 0; k < 40; k++) quiet.step(withHarness ? [...BASE, HARNESS] : [...BASE]);
      const { plugin } = await runFull(quiet, { h });
      const written = JSON.parse(fs.readFileSync(path.join(h.dir, 'process-lane-state.json'), 'utf8')) as { state: string; since_ms: number; v: number; cause?: string };
      const actionFile = path.join(h.dir, 'witness-action-required.json');
      const action = fs.existsSync(actionFile) ? JSON.parse(fs.readFileSync(actionFile, 'utf8')) as { state: string; instruction: string } : null;
      return { state: plugin.getState(), since: plugin.getStateSinceMs(), written, action };
    };
    const old = await restore({ state: 'launcher_changed', at_ms: 7 });
    expect(old.state).toBe('launcher_unconfirmed');
    expect(old.since).toBe(7);
    expect(old.written).toMatchObject({ state: 'launcher_unconfirmed', since_ms: 7, v: PROCESS_LANE_STATE_FILE_VERSION });
    expect(old.action).toBeNull();
    // With no launcher bound either, the old file's flag is still only a suspicion, never a confirmed change.
    expect((await restore({ state: 'launcher_changed', at_ms: 7 }, false)).state).toBe('launcher_unconfirmed');
    // RED: written by this release (and no launcher bound to end it), the same flag is a confirmed
    // change, with its own instruction.
    const cur = await restore({ state: 'launcher_changed', at_ms: 9, since_ms: 3, v: PROCESS_LANE_STATE_FILE_VERSION, cause: 'wrapper' }, false);
    expect(cur.state).toBe('launcher_changed');
    expect(cur.since).toBe(3);
    expect(cur.action?.instruction).toBe(PROCESS_LANE_ACTION_INSTRUCTION);
    expect(cur.written).toMatchObject({ cause: 'wrapper' });
  });

  it('the correction: a restored WRAPPER change is not ended by a bound launcher — only a command the recorded way or a re-record ends it; a restored inside-command change is (RED: the inside-command cause, and a file with no cause, end on the launcher)', async () => {
    const sha = (v: string) => require('crypto').createHash('sha256').update(v, 'utf8').digest('hex') as string;
    const restart = async (cause: string | undefined) => {
      const h = home();
      const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));
      const record = sha(`${rec.fingerprint}:${rec.mode}:${rec.template.join(',')}:${rec.recorded_at_ms}`);
      fs.writeFileSync(path.join(h.dir, 'process-lane-state.json'), JSON.stringify({ state: 'launcher_changed', at_ms: 5, since_ms: 1, v: PROCESS_LANE_STATE_FILE_VERSION, record, ...(cause === undefined ? {} : { cause }) }));
      nextPid = 10_000;
      const quiet = new RawTimeline();
      for (let k = 0; k < 40; k++) quiet.step([...BASE, HARNESS]);
      const { plugin } = await runFull(quiet, { h });
      return { state: plugin.getState(), since: plugin.getStateSinceMs(), action: fs.existsSync(path.join(h.dir, 'witness-action-required.json')) };
    };
    expect(await restart('wrapper')).toEqual({ state: 'launcher_changed', since: 1, action: true });
    expect(await restart('inside_command')).toMatchObject({ state: 'active', action: false });
    expect(await restart(undefined)).toMatchObject({ state: 'active', action: false });
  });

  it('a daemon stop right after a command never loses it; a command already running at a new daemon\'s first read that no daemon saw start is unknown, so it never mints (round 12; RED: one started after the first read seals)', async () => {
    const tl = new RawTimeline();
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
    command(tl, [...BASE, HARNESS], HARNESS.pid, 2);
    for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS]);   // 10 s, then the daemon self-updates
    expect((await runFull(tl, { stopAfter: true })).plugin.drainPEs()).toHaveLength(1);
    // The new daemon's first read already shows a command running.
    nextPid = 10_000;
    const late = new RawTimeline();
    const root = proc(HARNESS.pid, WRAPPER);
    const kid = proc(root.pid, ['sleep', '30']);
    for (let k = 0; k < 8; k++) late.step([...BASE, HARNESS, root, kid]);
    for (let k = 0; k < 20; k++) late.step([...BASE, HARNESS]);
    expect((await runFull(late)).plugin.drainPEs()).toHaveLength(0);
    nextPid = 10_000;
    const after = new RawTimeline();
    after.step([...BASE, HARNESS]);
    const root2 = proc(HARNESS.pid, WRAPPER);
    const kid2 = proc(root2.pid, ['sleep', '30']);
    for (let k = 0; k < 8; k++) after.step([...BASE, HARNESS, root2, kid2]);
    for (let k = 0; k < 20; k++) after.step([...BASE, HARNESS]);
    expect((await runFull(after)).plugin.drainPEs()).toHaveLength(1);
    nextPid = 10_000;
    const foreign = new RawTimeline();
    const fr = proc(LOOP.pid, WRAPPER);
    for (let k = 0; k < 8; k++) foreign.step([...BASE, HARNESS, fr]);
    for (let k = 0; k < 20; k++) foreign.step([...BASE, HARNESS]);
    expect((await runFull(foreign)).plugin.drainPEs()).toHaveLength(0);
  });

  it('a launcher record this version cannot read is no usable record — flagged for re-recording as no_launcher, never a harness change, never silently dark (RED: a readable record is active)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
    const launcherFile = path.join(dir, 'process-launcher.json');
    fs.writeFileSync(launcherFile, JSON.stringify({ schema: 'provian.process-launcher.v1', fingerprint: 'a'.repeat(64), template: [], recorded_at_ms: 1, source: 'install' }));
    const tl = new RawTimeline();
    for (let k = 0; k < 8; k++) tl.step([...BASE, HARNESS]);
    const { plugin } = await runFull(tl, { h: { dir, launcherFile } });
    // an unreadable record is not a harness change; its fix is the same one command.
    expect(plugin.getState()).toBe('no_launcher');
    const stale = JSON.parse(fs.readFileSync(path.join(dir, 'witness-action-required.json'), 'utf8')) as { lane: string; instruction: string };
    expect(stale.lane).toBe('process');
    expect(stale.instruction).toBe(PROCESS_LANE_NO_LAUNCHER_INSTRUCTION);
    // RED: the same machine with a record this version reads is active.
    nextPid = 10_000;
    const t0 = new RawTimeline();
    for (let k = 0; k < 8; k++) t0.step([...BASE, HARNESS]);
    expect((await runFull(t0)).plugin.getState()).toBe('active');
    nextPid = 10_000;
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
    const t2 = new RawTimeline();
    for (let k = 0; k < 8; k++) t2.step([...BASE, HARNESS]);
    const none = await runFull(t2, { h: { dir: dir2, launcherFile: path.join(dir2, 'process-launcher.json') } });
    expect(none.plugin.getState()).toBe('no_launcher');
    // follow-up : no record is not a harness change, but it is flagged in its
    // own right — the instruction names process-lane record, never the harness-change text.
    const left = JSON.parse(fs.readFileSync(path.join(dir2, 'witness-action-required.json'), 'utf8')) as { state: string; instruction: string };
    expect(left.state).toBe('no_launcher');
    expect(left.instruction).toBe(PROCESS_LANE_NO_LAUNCHER_INSTRUCTION);
  });

  it('the agent and the console name the same reason: a blind harness ranks ahead of the process lane, as on the relay', () => {
    const report = buildCaptureHealthReport({
      harnesses: [{ harness: 'openclaw', version: '2026.8.2', sources: 0, containers: [] }],
      cursorTotal: 0, lastVerdictAtMs: null, lastVerdict: 'idle', lastCaptureAtMs: null, sqliteReadable: true, nowMs: 0,
      process: { active: true, watching: true, actsEverSealed: false, lastActAtMs: null, state: 'launcher_changed' },
    });
    expect(captureBrokenReason(report)).toBe('no_readable_sources');
    const processOnly = buildCaptureHealthReport({
      harnesses: [], cursorTotal: 0, lastVerdictAtMs: null, lastVerdict: 'idle', lastCaptureAtMs: null, sqliteReadable: true, nowMs: 0,
      process: { active: true, watching: true, actsEverSealed: false, lastActAtMs: null, state: 'launcher_changed' },
    });
    expect(captureBrokenReason(processOnly)).toBe('process_launcher_changed');
  });

  it(' (the correction): a suspicion is no alarm; a confirmed harness change and a launcher no program matches are, and the state carries its age (RED: launcher_changed is)', () => {
    const report = (state: string, stateSinceMs: number | null = null) => buildCaptureHealthReport({
      harnesses: [], cursorTotal: 0, lastVerdictAtMs: null, lastVerdict: 'idle', lastCaptureAtMs: null, sqliteReadable: true, nowMs: 10_000,
      process: { active: true, watching: false, actsEverSealed: true, lastActAtMs: null, state, stateSinceMs },
    });
    expect(captureBrokenReason(report('launcher_unconfirmed'))).toBeNull();
    expect(report('launcher_unconfirmed').process_launcher_change_confirmed).toBe(false);
    // The correction: no running program matching the launcher is an alarm of its own.
    expect(captureBrokenReason(report('launcher_not_seen'))).toBe('process_launcher_not_seen');
    expect(report('launcher_not_seen').process_launcher_change_confirmed).toBe(false);
    const changed = report('launcher_changed', 4_000);
    expect(captureBrokenReason(changed)).toBe('process_launcher_changed');
    expect(changed.process_launcher_change_confirmed).toBe(true);
    expect(changed.process_lane_state_age_ms).toBe(6_000);
    expect(report('active').process_lane_state_age_ms).toBeNull();
  });
});

describe(' — only what the launcher started is taken back; a command keeps everything it starts', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  async function runFull(tl: RawTimeline, h = home()) {
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      auditScan: () => tl.current(),
    });
    await plugin.init(observer);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    return { plugin, dir: h.dir };
  }
  const tracker = (plugin: ProcessLanePlugin) => (plugin as unknown as { tracker: import('./acts').ProcessActTracker }).tracker;

  it('a child the startup wrapper started before it exec\'d into the harness never mints, even matching the template; one the harness starts after does (RED)', async () => {
    const tl = new RawTimeline();
    for (let k = 0; k < 8; k++) tl.step(BASE);
    const pre = proc(53, ['sh', '/start.sh'], { pid: 777, startKey: '777:s', comm: 'sh' });
    const early = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });          // the wrapper's own child
    const brief = proc(777, ['true'], { pid: 779, startKey: '779:s' });          // exits in the exec read
    tl.step([...BASE, pre]);
    tl.step([...BASE, pre, early, brief]);
    const post: ProcEntry = { ...pre, argv: [...HARNESS.argv], comm: 'node' };
    for (let k = 0; k < 6; k++) tl.step([...BASE, post, early]);                // exec'd; `early` still running
    for (let k = 0; k < 4; k++) tl.step([...BASE, post]);
    const root = proc(777, WRAPPER);                                             // the harness's own command
    tl.step([...BASE, post, root]); tl.step([...BASE, post, root]);
    for (let k = 0; k < 120; k++) tl.step([...BASE, post]);
    const { plugin } = await runFull(tl);
    const pes = plugin.drainPEs();
    expect(pes).toHaveLength(1);
    expect(tracker(plugin).outcomeOf('778:s')).not.toBe('sealed');
    // Nothing is left open: the act the exec'ing wrapper held ended with its last child.
    for (const k of ['777:s', '778:s', '779:s']) expect(tracker(plugin).outcomeOf(k)).not.toBe('open');
  });

  it('a copy of the harness program an agent command starts — spawned or exec\'d into — is part of that command: one act, everything in it, no harness-change flag (RED: the same copy started outside any command is a launcher)', async () => {
    const fixed = [...BASE, HARNESS];
    for (const execs of [false, true]) {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 4; k++) tl.step(fixed);
      const root = proc(HARNESS.pid, WRAPPER);
      const sh = proc(root.pid, ['bash']);
      // The copy runs 20 s, past an audit identification; its children even include the command shape.
      const copy: ProcEntry = execs ? { ...sh, argv: ['node', '/app/harness/server.js', '--port', '7001'], comm: 'node' } : proc(sh.pid, ['node', '/app/harness/server.js', '--port', '7001']);
      tl.step([...fixed, root, sh]);
      const kids: ProcEntry[] = [];
      for (let i = 0; i < 80; i++) {
        const kid = proc(copy.pid, i % 8 === 3 ? WRAPPER : i % 2 ? ['make', 'all'] : ['ls', '-la']);
        kids.push(kid);
        tl.step(execs ? [...fixed, root, copy, kid] : [...fixed, root, sh, copy, kid]);
      }
      for (let k = 0; k < 400; k++) tl.step(fixed);                                // past the audit's due time
      const { plugin, dir } = await runFull(tl);
      const pes = plugin.drainPEs();
      expect(pes).toHaveLength(1);
      expect(pes[0].metadata?.process_count).toBe(execs ? 82 : 83);
      expect(plugin.getState()).toBe('active');
      expect(fs.existsSync(path.join(dir, 'witness-action-required.json'))).toBe(false);
      // The audit counts one command, not the copy's children (the copy is no launcher of its own).
      const w = plugin.takeCaptureWindow();
      expect([w.commandsDue, w.commandsDueSealed]).toEqual([1, 1]);
    }
    // RED: a copy started by the sandbox (outside any command) IS a launcher: its wrapper-shaped child mints.
    nextPid = 10_000;
    const t2 = new RawTimeline();
    const copy2 = proc(SANDBOX.pid, ['node', '/app/harness/server.js', '--port', '7001']);
    for (let k = 0; k < 4; k++) t2.step([...fixed, copy2]);
    const r2 = proc(copy2.pid, WRAPPER);
    t2.step([...fixed, copy2, r2]); t2.step([...fixed, copy2, r2]);
    for (let k = 0; k < 120; k++) t2.step([...fixed, copy2]);
    expect((await runFull(t2)).plugin.drainPEs()).toHaveLength(1);
  });

  it('a worker recorded as the launcher (under a master running the same program): a fork read before its exec still seals once it execs (RED: without the exec it never does)', async () => {
    const master = proc(SANDBOX.pid, ['node', '/app/harness/server.js'], { pid: 400, startKey: '400:s' });
    const worker = proc(400, ['node', '/app/harness/server.js'], { pid: 401, startKey: '401:s' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
    const launcherFile = path.join(dir, 'process-launcher.json');
    const asLP = (e: ProcEntry) => ({ pid: e.pid, ppid: e.ppid, comm: e.comm ?? '', argv: e.argv });
    writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: launcherFingerprint(asLP(worker), asLP(master)), mode: 'template', template: templateOf(WRAPPER), recorded_at_ms: 1, source: 'install' }, launcherFile);
    const fixed = [...BASE, master, worker];
    const make = (execs: boolean) => {
      const tl = new RawTimeline();
      for (let k = 0; k < 4; k++) tl.step(fixed);
      const fork = proc(401, [...worker.argv], { pid: 402, startKey: '402:s' });
      tl.step([...fixed, fork]);
      const after = execs ? { ...fork, argv: WRAPPER, comm: 'bash' } : fork;
      tl.step([...fixed, after, proc(402, ['ls', '/root'])]);
      tl.step([...fixed, after]);
      for (let k = 0; k < 120; k++) tl.step(fixed);
      return tl;
    };
    const { plugin } = await runFull(make(true), { dir, launcherFile });
    expect(plugin.drainPEs()).toHaveLength(1);
    nextPid = 10_000;
    expect((await runFull(make(false), { dir, launcherFile })).plugin.drainPEs()).toHaveLength(0);
  });
});

describe(' — the command that writes the launcher record is the agent\'s command too', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  const fixed = [INIT, SANDBOX, LOOP, OBSERVER, HARNESS];
  /** `provian doctor` (or `process-lane record`) runs through the harness and writes the record mid-run. */
  async function runWithRecordAt(stepOfRecord: number, write: (file: string, commandStartKey: string) => void, preRecord?: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
    const launcherFile = path.join(dir, 'process-launcher.json');
    if (preRecord) writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: launcherFingerprint({ pid: HARNESS.pid, ppid: HARNESS.ppid, comm: HARNESS.comm ?? '', argv: HARNESS.argv }, null), mode: 'template', template: preRecord, recorded_at_ms: 1, source: 'install' }, launcherFile);
    const tl = new RawTimeline();
    for (let k = 0; k < 4; k++) tl.step(fixed);
    const root = proc(HARNESS.pid, WRAPPER);
    const kid = proc(root.pid, ['node', '/home/u/.provian/agent.js', 'doctor']);
    for (let k = 0; k < 24; k++) tl.step([...fixed, root, kid]);              // a 6 s doctor run
    for (let k = 0; k < 120; k++) tl.step(fixed);
    // The machine as it is NOW (a lane with no record reads nothing, but the machine moves on).
    const t0 = Date.now();
    const now = (): ProcSnapshot => tl.snaps[Math.min(Math.floor((Date.now() - t0) / 250), tl.snaps.length - 1)];
    const plugin = new ProcessLanePlugin({
      reader: { read: now }, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
      otherLaneActive: () => false, launcherFile, stateDir: dir, uid: 1000,
      scanLight: () => new Map([...now().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...now().procs.values()].find((e) => e.pid === pid) ?? null,
    });
    await plugin.init(observer);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * stepOfRecord);
    write(launcherFile, root.startKey);
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1 - stepOfRecord));
    return plugin.drainPEs();
  }
  const fresh = (file: string, commandStartKey: string) => writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: launcherFingerprint({ pid: HARNESS.pid, ppid: HARNESS.ppid, comm: HARNESS.comm ?? '', argv: HARNESS.argv }, null), mode: 'template', template: templateOf(WRAPPER), recorded_at_ms: 2, source: 'doctor', command_start_key: commandStartKey }, file);

  it('on a box with no record, the doctor run that writes it seals once (RED: a record written after it ended does not reach back)', async () => {
    expect(await runWithRecordAt(8, fresh)).toHaveLength(1);
    nextPid = 10_000;
    expect(await runWithRecordAt(40, fresh)).toHaveLength(0);
  });

  it('a re-record while a command runs under the new wrapper: that command seals once (RED: a re-record to a wrapper it does not match leaves it the harness\'s own)', async () => {
    const OLD = templateOf(['bash', '--norc', '-c', 'old wrapper', 'wrap']);
    expect(await runWithRecordAt(8, fresh, OLD)).toHaveLength(1);
    nextPid = 10_000;
    const other = (file: string) => writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: launcherFingerprint({ pid: HARNESS.pid, ppid: HARNESS.ppid, comm: HARNESS.comm ?? '', argv: HARNESS.argv }, null), mode: 'template', template: templateOf(['bash', '-c', 'yet another', 'w']), recorded_at_ms: 3, source: 'record' }, file);
    expect(await runWithRecordAt(8, other, OLD)).toHaveLength(0);
  });
});

describe(' — a harness the agent restarts, a nested copy at a daemon restart, the audit\'s own blind spots', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  async function runFull(tl: RawTimeline, h = home(), ledger: FakeLedger = new FakeLedger(), stop = false) {
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger, identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      auditScan: () => tl.current(),
    });
    await plugin.init(observer);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    if (stop) await plugin.stop();
    return plugin;
  }
  const inner = (plugin: ProcessLanePlugin) => (plugin as unknown as { tracker: { admittedUnder: Map<string, string>; launchers: Set<string> } }).tracker;

  it('the agent restarts its harness from a command and the old one exits: flagged once it lasts past a restart gap, and after the agent re-records (naming that process) its commands seal (RED: without the re-record they never do)', async () => {
    const h = home();
    const tl = new RawTimeline();
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
    const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
    const bash = proc(600, ['bash'], { pid: 601, startKey: '601:s' });
    tl.step([...BASE, HARNESS, root, bash]);
    const copy: ProcEntry = { ...bash, argv: [...HARNESS.argv], comm: 'node' };          // bash execs the new harness
    tl.step([...BASE, HARNESS, root, copy]); tl.step([...BASE, HARNESS, root, copy]);
    const live = [...BASE, { ...root, ppid: 1 }, copy];                                // the old harness exits
    const commands = (n: number) => { for (let c = 0; c < n; c++) { const r = proc(601, WRAPPER); tl.step([...live, r, proc(r.pid, ['ls'])]); tl.step([...live, r]); for (let k = 0; k < 3; k++) tl.step(live); } };
    for (let k = 0; k < 130; k++) tl.step(live);                                     // past a supervisor's restart gap
    commands(2);
    const recordAt = tl.snaps.length;
    for (let k = 0; k < 12; k++) tl.step(live);
    commands(3);
    for (let k = 0; k < 120; k++) tl.step(live);
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
    });
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (recordAt - 1));
    expect(plugin.drainPEs()).toHaveLength(0);                                         // the copy is the command's
    expect(plugin.getState()).toBe('launcher_changed');
    // The correction: the live path names its cause (a restart restores it, and a bound launcher
    // ends only this cause) and gives the agent this cause's own instruction.
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'process-lane-state.json'), 'utf8'))).toMatchObject({ state: 'launcher_changed', cause: 'inside_command' });
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'witness-action-required.json'), 'utf8')))
      .toEqual({ instruction: PROCESS_LANE_INSIDE_COMMAND_INSTRUCTION, lane: 'process', state: 'launcher_changed' });
    // The agent re-records from its (new) harness: the walk names process 601.
    const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));
    fs.writeFileSync(h.launcherFile, JSON.stringify({ ...rec, launcher_start_key: '601:s', recorded_at_ms: 9, source: 'record' }));
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - recordAt));
    expect(plugin.drainPEs()).toHaveLength(3);
    expect(plugin.getState()).toBe('active');
  });

  it('round 6: a process counted in a sealed command never roots a second act — the fast reader after the harness exits, and a daemon restart (RED: without the claim it mints twice)', async () => {
    const make = () => {
      const tl = new RawTimeline();
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
      const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
      const bash = proc(600, ['bash'], { pid: 601, startKey: '601:s' });
      tl.step([...BASE, HARNESS, root, bash]);
      const copy: ProcEntry = { ...bash, argv: [...HARNESS.argv], comm: 'node' };
      const early = proc(601, WRAPPER, { pid: 602, startKey: '602:s' });
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, root, copy, early]);
      for (let k = 0; k < 120; k++) tl.step([...BASE, copy, early]);                 // old harness + root gone
      for (let k = 0; k < 40; k++) tl.step([...BASE, copy]);
      return tl;
    };
    const ledger = new FakeLedger();
    const h = home();
    const mk = (tl: RawTimeline, fast: boolean) => new ProcessLanePlugin({
      reader: tl, ledger, identifyProgram: () => null, pollMs: 250, platform: 'linux',
      subtreeReader: fast ? { read(pids: readonly number[], atMs: number): ProcSnapshot {
        const all = [...tl.read().procs.values()]; const keep = new Set<number>(pids);
        for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
        const procs = new Map<string, ProcEntry>(); for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e); return { atMs, procs };
      } } : null, ...(fast ? { fastMs: 250 } : {}),
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
    });
    const tl = make();
    const fast = mk(tl, true);
    await fast.init(observer); await fast.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    expect(fast.drainPEs()).toHaveLength(1);
    await fast.stop();
    // A daemon restart on the same machine (same ledger): the copy and `early` are still running.
    const again = new RawTimeline();
    const copy = { ...proc(600, ['bash'], { pid: 601, startKey: '601:s' }), argv: [...HARNESS.argv], comm: 'node', ppid: 1 };
    const early = proc(601, WRAPPER, { pid: 602, startKey: '602:s' });
    for (let k = 0; k < 8; k++) again.step([...BASE, copy, early]);
    for (let k = 0; k < 60; k++) again.step([...BASE, copy]);
    const restarted = mk(again, false);
    await restarted.init(observer); await restarted.start();
    await vi.advanceTimersByTimeAsync(250 * (again.snaps.length - 1));
    expect(restarted.drainPEs()).toHaveLength(0);
  });

  it('round 6: a test copy of the harness inside a command never launches, even after the supervisor replaced the real harness (RED: the replacement harness\'s own commands seal)', async () => {
    const tl = new RawTimeline();
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
    const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
    const npm = proc(600, ['npm', 'test'], { pid: 601, startKey: '601:s' });
    const copy = proc(601, ['node', '/app/harness/server.js', '--port', '7001'], { pid: 603, startKey: '603:s' });
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, root, npm, copy]);
    const l2 = proc(53, [...HARNESS.argv], { pid: 950, startKey: '950:s' });
    const live = [...BASE, l2, { ...root, ppid: 1 }, npm, copy];
    for (let k = 0; k < 64; k++) tl.step(live);                                        // past the audit's next pass
    for (let c = 0; c < 3; c++) { const r = proc(603, WRAPPER); tl.step([...live, r]); tl.step([...live, r]); tl.step(live); }
    const own = proc(950, WRAPPER);                                                     // L2's own command
    tl.step([...live, own]); tl.step([...live, own]);
    for (let k = 0; k < 4; k++) tl.step(live);
    for (let k = 0; k < 400; k++) tl.step([...BASE, l2]);
    const plugin = await runFull(tl);
    const pes = plugin.drainPEs();
    expect(pes).toHaveLength(2);                                                       // the npm test command + L2's command
    expect(pes.map((p) => p.metadata?.process_count).sort()).toEqual([1, 6]);
    // The audit counts the same two commands, not the copy's children.
    const w = plugin.takeCaptureWindow();
    expect([w.commandsDue, w.commandsDueSealed]).toEqual([2, 2]);                     // the npm test command + L2's
  });

  it('round 6: a re-record never reaches back to a child the startup wrapper started before its exec (RED: one the harness started after does)', async () => {
    const make = (after: boolean) => {
      const tl = new RawTimeline();
      const pre = proc(53, ['sh', '/start.sh'], { pid: 777, startKey: '777:s', comm: 'sh' });
      const post: ProcEntry = { ...pre, argv: [...HARNESS.argv], comm: 'node' };
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, pre]);
      const e = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
      if (!after) { tl.step([...BASE, HARNESS, pre, e]); for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, post, e]); }
      else { for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, post]); for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, post, e]); }
      for (let k = 0; k < 20; k++) tl.step([...BASE, HARNESS, post, e]);
      for (let k = 0; k < 120; k++) tl.step([...BASE, HARNESS, post]);
      return tl;
    };
    for (const after of [false, true]) {
      nextPid = 10_000;
      const h = home();
      const tl = make(after);
      const plugin = new ProcessLanePlugin({
        reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
        scanLight: () => new Map([...tl.current().procs.values()].map((x) => [x.pid, { startKey: x.startKey, ppid: x.ppid, comm: x.comm ?? '' }])),
        readEntry: (pid) => [...tl.current().procs.values()].find((x) => x.pid === pid) ?? null,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * 16);
      const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));                 // a doctor run re-writes the record
      fs.writeFileSync(h.launcherFile, JSON.stringify({ ...rec, recorded_at_ms: 5, source: 'doctor' }));
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 17));
      expect(plugin.drainPEs()).toHaveLength(after ? 1 : 0);
    }
  });

  it('round 6: a command a re-record turns into the agent\'s prices on its live processes\' destinations (RED: the same command from the start carries the same origins)', async () => {
    const OLD = templateOf(['bash', '--norc', '-c', 'old wrapper', 'wrap']);
    const run1 = async (template: string[]) => {
      nextPid = 10_000;
      const h = home(template);
      const tl = new RawTimeline();
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
      const root = proc(HARNESS.pid, WRAPPER);
      const curl = proc(root.pid, ['curl', '-s', 'https://api.example.org/v1/data']);
      for (let k = 0; k < 24; k++) tl.step([...BASE, HARNESS, root, curl]);
      for (let k = 0; k < 120; k++) tl.step([...BASE, HARNESS]);
      const plugin = new ProcessLanePlugin({
        reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
        scanLight: () => new Map([...tl.current().procs.values()].map((x) => [x.pid, { startKey: x.startKey, ppid: x.ppid, comm: x.comm ?? '' }])),
        readEntry: (pid) => [...tl.current().procs.values()].find((x) => x.pid === pid) ?? null,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * 10);
      const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));
      fs.writeFileSync(h.launcherFile, JSON.stringify({ ...rec, template: templateOf(WRAPPER), recorded_at_ms: 7, source: 'record' }));
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 11));
      return plugin.drainPEs().flatMap((pe) => (pe.input_origins ?? []).map((o) => o.origin_identifier));
    };
    expect(await run1(OLD)).toContain('domain:api.example.org');
    expect(await run1(templateOf(WRAPPER))).toContain('domain:api.example.org');
  });

  it('a daemon restart while a command runs a nested copy of the harness adopts the whole command as one act (RED: the copy\'s command-shaped child is never an act of its own)', async () => {
    const root = proc(HARNESS.pid, WRAPPER);
    const sh = proc(root.pid, ['bash']);
    const copy = proc(sh.pid, ['node', '/app/harness/server.js', '--port', '7001']);
    const kid = proc(copy.pid, WRAPPER);
    // The old daemon saw the command start, then stopped (an update) while it ran.
    const ledger = new FakeLedger(); const h = home();
    const first = new RawTimeline();
    for (let k = 0; k < 4; k++) first.step([...BASE, HARNESS]);
    for (let k = 0; k < 4; k++) first.step([...BASE, HARNESS, root, sh, copy, kid]);
    expect((await runFull(first, h, ledger, true)).drainPEs()).toHaveLength(0);
    const tl = new RawTimeline();
    for (let k = 0; k < 8; k++) tl.step([...BASE, HARNESS, root, sh, copy, kid]);
    for (let k = 0; k < 120; k++) tl.step([...BASE, HARNESS]);
    const plugin = await runFull(tl, h, ledger);
    const pes = plugin.drainPEs();
    expect(pes).toHaveLength(1);
    expect(pes[0].metadata?.process_count).toBe(4);
    // Nothing is left behind (no act of the copy's child, open forever).
    expect((plugin as unknown as { tracker: { acts: Map<string, unknown> } }).tracker.acts.size).toBe(0);
  });

  it('a command-shaped child the startup wrapper started before its exec, running on long after, is no false alarm (RED: one the harness starts after is counted and seals)', async () => {
    const tl = new RawTimeline();
    for (let k = 0; k < 8; k++) tl.step(BASE);
    const pre = proc(53, ['sh', '/start.sh'], { pid: 777, startKey: '777:s', comm: 'sh' });
    const early = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
    tl.step([...BASE, pre, early]);
    const post: ProcEntry = { ...pre, argv: [...HARNESS.argv], comm: 'node' };
    for (let k = 0; k < 160; k++) tl.step([...BASE, post, early]);                  // 40 s more, past an audit pass
    const r = proc(777, WRAPPER);
    tl.step([...BASE, post, r]); tl.step([...BASE, post, r]);
    for (let k = 0; k < 400; k++) tl.step([...BASE, post]);
    const plugin = await runFull(tl);
    expect(plugin.drainPEs()).toHaveLength(1);
    const w = plugin.takeCaptureWindow();
    expect([w.commandsDue, w.commandsDueSealed]).toEqual([1, 1]);
  });

  it('a long command that outlives its launcher (the supervisor replaced the harness) is no false alarm while it runs, and seals (RED: the window counts it sealed, never due-unsealed)', async () => {
    const tl = new RawTimeline();
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
    const root = proc(HARNESS.pid, WRAPPER, { pid: 900, startKey: '900:s' });
    for (let k = 0; k < 80; k++) tl.step([...BASE, HARNESS, root]);
    const next = proc(53, [...HARNESS.argv], { pid: 950, startKey: '950:s' });
    for (let k = 0; k < 600; k++) tl.step([...BASE, next, { ...root, ppid: 1 }]);   // 150 s more, reparented
    for (let k = 0; k < 400; k++) tl.step([...BASE, next]);
    const plugin = await runFull(tl);
    expect(plugin.drainPEs()).toHaveLength(1);
    const w = plugin.takeCaptureWindow();
    expect([w.commandsDue, w.commandsDueSealed]).toEqual([1, 1]);
  });

  it('recycled workers leave no state behind: the tracker\'s launcher bookkeeping stays bounded (RED: a live launcher is kept)', async () => {
    const master = proc(SANDBOX.pid, ['node', '/app/harness/server.js'], { pid: 400, startKey: '400:s' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
    const launcherFile = path.join(dir, 'process-launcher.json');
    const asLP = (e: ProcEntry) => ({ pid: e.pid, ppid: e.ppid, comm: e.comm ?? '', argv: e.argv });
    writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: launcherFingerprint(asLP(proc(400, ['node', '/app/harness/server.js'])), asLP(master)), mode: 'template', template: templateOf(WRAPPER), recorded_at_ms: 1, source: 'install' }, launcherFile);
    const tl = new RawTimeline();
    for (let k = 0; k < 4; k++) tl.step([...BASE, master]);
    let worker = proc(400, ['node', '/app/harness/server.js']);
    for (let n = 0; n < 50; n++) {
      worker = proc(400, ['node', '/app/harness/server.js']);
      for (let k = 0; k < 4; k++) tl.step([...BASE, master, worker]);
    }
    for (let k = 0; k < 20; k++) tl.step([...BASE, master, worker]);               // the last one stays
    const plugin = await runFull(tl, { dir, launcherFile });
    const t = inner(plugin);
    expect(t.launchers.size).toBe(1);
    expect(t.launchers.has(worker.startKey)).toBe(true);
    expect(t.admittedUnder.size).toBeLessThanOrEqual(1);
  });
});

describe(' — once the command\'s, always the command\'s, across a daemon restart', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  async function runOn(tl: RawTimeline, ledger: FakeLedger, h: { dir: string; launcherFile: string }) {
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger, identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
    });
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    await plugin.stop();
    return plugin.drainPEs();
  }

  it('a process counted in a sealed command that the harness then adopts (a subreaper) is never a second act after a daemon restart (RED: a fresh one is)', async () => {
    const ledger = new FakeLedger(); const h = home();
    const tl = new RawTimeline();
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
    const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
    const nested = proc(600, WRAPPER, { pid: 601, startKey: '601:s' });             // shaped like a command
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, root, nested]);
    for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS, { ...nested, ppid: HARNESS.pid }]);   // adopted by the harness
    expect(await runOn(tl, ledger, h)).toHaveLength(1);
    const again = new RawTimeline();
    for (let k = 0; k < 4; k++) again.step([...BASE, HARNESS, { ...nested, ppid: HARNESS.pid }]);
    for (let k = 0; k < 40; k++) again.step([...BASE, HARNESS]);
    expect(await runOn(again, ledger, h)).toHaveLength(0);
    // RED: a command the harness starts after the restart, never counted before, seals.
    const fresh = new RawTimeline();
    const r2 = proc(HARNESS.pid, WRAPPER, { pid: 700, startKey: '700:s' });
    fresh.step([...BASE, HARNESS]);
    for (let k = 0; k < 4; k++) fresh.step([...BASE, HARNESS, r2]);
    for (let k = 0; k < 40; k++) fresh.step([...BASE, HARNESS]);
    expect(await runOn(fresh, ledger, h)).toHaveLength(1);
  });

  it('a harness copy inside a command still running is remembered across a daemon restart: spawned or exec\'d into, it never launches (RED: the real harness\'s command does)', async () => {
    for (const execs of [false, true]) {
      nextPid = 10_000;
      const ledger = new FakeLedger(); const h = home();
      const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
      const sh = proc(600, ['bash'], { pid: 601, startKey: '601:s' });
      const copy: ProcEntry = execs ? { ...sh, argv: ['node', '/app/harness/server.js', '--port', '7001'], comm: 'node' } : proc(601, ['node', '/app/harness/server.js', '--port', '7001'], { pid: 603, startKey: '603:s' });
      const tl = new RawTimeline();
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
      tl.step([...BASE, HARNESS, root, sh]);
      const during = execs ? [...BASE, HARNESS, root, copy] : [...BASE, HARNESS, root, sh, copy];
      for (let k = 0; k < 8; k++) tl.step(during);
      expect(await runOn(tl, ledger, h)).toHaveLength(0);                          // the command is still running
      // The daemon restarts after the real harness was replaced; the copy still runs inside the old command.
      const l2 = proc(53, [...HARNESS.argv], { pid: 950, startKey: '950:s' });
      const after = during.filter((e) => e.pid !== HARNESS.pid).map((e) => (e.pid === 600 ? { ...e, ppid: 1 } : e));
      const again = new RawTimeline();
      for (let k = 0; k < 4; k++) again.step([...after, l2]);
      const c = proc(copy.pid, WRAPPER);
      again.step([...after, l2, c]); again.step([...after, l2, c]);
      const own = proc(950, WRAPPER);
      again.step([...after, l2, own]); again.step([...after, l2, own]);
      for (let k = 0; k < 40; k++) again.step([...BASE, l2]);
      const pes = await runOn(again, ledger, h);
      expect(pes.map((p) => p.metadata?.process_count)).toEqual([1]);              // only L2's own command
    }
  });
});

describe(' — a restarted harness is found within one read on the fast reader', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  it('the harness exits and a new one starts: its first command, half a second in, seals (RED: a 2 s discovery alone misses it)', async () => {
    const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
    const make = () => {
      const tl = new RawTimeline();
      for (let k = 0; k < 12; k++) tl.step([...BASE, HARNESS]);
      tl.step(BASE);                                                                   // the old harness exits
      const next = proc(53, [...HARNESS.argv], { pid: 950, startKey: '950:s' });
      tl.step([...BASE, next]); tl.step([...BASE, next]);
      const r = proc(950, WRAPPER);
      tl.step([...BASE, next, r]);                                                     // one read long
      for (let k = 0; k < 40; k++) tl.step([...BASE, next]);
      return tl;
    };
    const run2 = async (discoveryMs: number, pollMs: number) => {
      nextPid = 10_000;
      const tl = make(); const h = home();
      const subtree = { read(pids: readonly number[], atMs: number): ProcSnapshot {
        const all = [...tl.read().procs.values()]; const keep = new Set<number>(pids);
        for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
        const procs = new Map<string, ProcEntry>(); for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e); return { atMs, procs };
      } };
      const plugin = new ProcessLanePlugin({
        reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs, fastMs: 250, discoveryMs, platform: 'linux', subtreeReader: subtree,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
        scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
        readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      return plugin.drainPEs().length;
    };
    expect(await run2(2_000, 250)).toBe(1);
  });
});

describe(' — the launcher rule needs no state; claims leave only with their process', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const subtreeOf = (tl: RawTimeline, drop?: (i: number, e: ProcEntry) => boolean) => ({
    read(pids: readonly number[], atMs: number): ProcSnapshot {
      const i = tl.i;
      const all = [...tl.read().procs.values()].filter((e) => !drop?.(i, e));
      const keep = new Set<number>(pids);
      for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
      const procs = new Map<string, ProcEntry>(); for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e); return { atMs, procs };
    },
  });
  type Over = Partial<import('./ProcessLanePlugin').ProcessLaneOptions>;
  async function run(tl: RawTimeline, over: Over & { h?: { dir: string; launcherFile: string }; steps?: number } = {}) {
    const h = over.h ?? home();
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      isAlive: (k) => tl.current().procs.has(k),
      ...over,
    });
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * ((over.steps ?? tl.snaps.length) - 1));
    return { plugin, h };
  }

  it('fast reader: a test copy a command starts AFTER the real harness exited never launches (RED: the same copy started by the sandbox does)', async () => {
    const make = (underCommand: boolean) => {
      const tl = new RawTimeline();
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
      const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
      const npm = proc(600, ['npm', 'test'], { pid: 601, startKey: '601:s' });
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, root, npm]);
      const after = [...BASE, { ...root, ppid: 1 }, npm];                            // the harness exits
      for (let k = 0; k < 4; k++) tl.step(after);
      const copy = proc(underCommand ? 601 : 53, ['node', '/app/harness/server.js', '--port', '7001'], { pid: 603, startKey: '603:s' });
      for (let k = 0; k < 4; k++) tl.step([...after, copy]);
      for (let c = 0; c < 3; c++) { const r = proc(603, WRAPPER); tl.step([...after, copy, r]); tl.step([...after, copy, r]); tl.step([...after, copy]); }
      for (let k = 0; k < 60; k++) tl.step([...after, copy]);
      return tl;
    };
    const tl = make(true);
    const { plugin } = await run(tl, { subtreeReader: subtreeOf(tl), fastMs: 250 });
    expect(plugin.drainPEs().filter((pe) => pe.metadata?.process_count === 1)).toHaveLength(0);
    nextPid = 10_000;
    const t2 = make(false);
    const other = await run(t2, { subtreeReader: subtreeOf(t2), fastMs: 250 });
    expect(other.plugin.drainPEs().filter((pe) => pe.metadata?.process_count === 1)).toHaveLength(3);
  });

  it('a daemon restart after the harness exited, while a command still runs a test copy: the copy is under a command-shaped process, so it never launches (RED: the same copy outside any command does)', async () => {
    const make = (underCommand: boolean) => {
      const tl = new RawTimeline();
      const root = proc(1, WRAPPER, { pid: 600, startKey: '600:s' });                  // reparented when the harness exited
      const npm = proc(underCommand ? 600 : 1, ['npm', 'test'], { pid: 601, startKey: '601:s' });
      const copy = proc(601, ['node', '/app/harness/server.js', '--port', '7001'], { pid: 603, startKey: '603:s' });
      const fixed = [...BASE, root, npm, copy];
      for (let k = 0; k < 4; k++) tl.step(fixed);
      for (let c = 0; c < 3; c++) { const r = proc(603, WRAPPER); tl.step([...fixed, r]); tl.step([...fixed, r]); tl.step(fixed); }
      for (let k = 0; k < 40; k++) tl.step(fixed);
      return tl;
    };
    expect((await run(make(true))).plugin.drainPEs()).toHaveLength(0);
    nextPid = 10_000;
    expect((await run(make(false))).plugin.drainPEs()).toHaveLength(3);
  });

  it('a copy under a process that was part of a command (its command-shaped root already gone) never launches (RED: under a process that never was)', async () => {
    const make = () => {
      const tl = new RawTimeline();
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
      const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
      const npm = proc(600, ['npm', 'run', 'dev'], { pid: 601, startKey: '601:s' });
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, root, npm]);
      const orphan: ProcEntry = { ...npm, ppid: 1 };                                    // the command ended; npm lives on
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, orphan]);
      const copy = proc(601, ['node', '/app/harness/server.js', '--port', '7001'], { pid: 603, startKey: '603:s' });
      const fixed = [...BASE, HARNESS, orphan, copy];
      for (let k = 0; k < 4; k++) tl.step(fixed);
      for (let c = 0; c < 3; c++) { const r = proc(603, WRAPPER); tl.step([...fixed, r]); tl.step([...fixed, r]); tl.step(fixed); }
      for (let k = 0; k < 40; k++) tl.step(fixed);
      return tl;
    };
    const { plugin } = await run(make());
    expect(plugin.drainPEs().map((pe) => pe.metadata?.process_count)).toEqual([2]);  // the npm command only
    // RED: a daemon started after that command ended never saw npm as part of it, nor its root: the
    // copy under it is outside every command it can know of, and launches.
    nextPid = 10_000;
    const tl = new RawTimeline();
    const orphan = proc(1, ['npm', 'run', 'dev'], { pid: 601, startKey: '601:s' });
    const copy = proc(601, ['node', '/app/harness/server.js', '--port', '7001'], { pid: 603, startKey: '603:s' });
    const fixed = [...BASE, HARNESS, orphan, copy];
    for (let k = 0; k < 4; k++) tl.step(fixed);
    for (let c = 0; c < 3; c++) { const r = proc(603, WRAPPER); tl.step([...fixed, r]); tl.step([...fixed, r]); tl.step(fixed); }
    for (let k = 0; k < 40; k++) tl.step(fixed);
    expect((await run(tl)).plugin.drainPEs()).toHaveLength(3);
  });

  it('a live claimed copy keeps its claim through a big build and a daemon restart, with the real ledger (RED: a copy never claimed launches)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
    const ledgerFile = path.join(dir, 'ledger.json');
    const h = home();
    // 1. The agent starts a dev copy in the background (it detaches to init) — claimed.
    const tl = new RawTimeline();
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
    const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
    const copy = proc(600, ['node', '/app/harness/server.js', '--port', '7001'], { pid: 603, startKey: '603:s' });
    tl.step([...BASE, HARNESS, root, copy]); tl.step([...BASE, HARNESS, root, copy]);
    const detached: ProcEntry = { ...copy, ppid: 1 };
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, detached]);
    // 2. A build of 6,000 processes.
    const build = proc(HARNESS.pid, WRAPPER, { pid: 700, startKey: '700:s' });
    const kids = Array.from({ length: 6000 }, (_, i) => proc(700, ['cc', `f${i}.c`], { pid: 100_000 + i, startKey: `${100_000 + i}:s` }));
    tl.step([...BASE, HARNESS, detached, build, ...kids]);
    for (let k = 0; k < 300; k++) tl.step([...BASE, HARNESS, detached]);            // past a claims prune
    const first = await run(tl, { h, ledger: new FileActLedger(ledgerFile) });
    expect(first.plugin.drainPEs()).toHaveLength(2);
    await first.plugin.stop();
    // 3. The daemon restarts after the real harness exited; the dev copy runs commands of its own.
    nextPid = 10_000;
    const again = new RawTimeline();
    for (let k = 0; k < 4; k++) again.step([...BASE, detached]);
    for (let c = 0; c < 3; c++) { const r = proc(603, WRAPPER); again.step([...BASE, detached, r]); again.step([...BASE, detached, r]); again.step([...BASE, detached]); }
    for (let k = 0; k < 40; k++) again.step([...BASE, detached]);
    const second = await run(again, { h, ledger: new FileActLedger(ledgerFile) });
    expect(second.plugin.drainPEs()).toHaveLength(0);
    // RED: on a fresh ledger (never claimed) the same copy is taken for the launcher.
    nextPid = 10_000;
    const t3 = new RawTimeline();
    for (let k = 0; k < 4; k++) t3.step([...BASE, detached]);
    for (let c = 0; c < 3; c++) { const r = proc(603, WRAPPER); t3.step([...BASE, detached, r]); t3.step([...BASE, detached, r]); t3.step([...BASE, detached]); }
    for (let k = 0; k < 40; k++) t3.step([...BASE, detached]);
    const third = await run(t3, { h, ledger: new FileActLedger(path.join(dir, 'fresh.json')) });
    expect(third.plugin.drainPEs()).toHaveLength(3);
  });

  it('FileActLedger: claims persist and reload, and a prune drops only exited processes (RED: an exited one is dropped)', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-led-')), 'ledger.json');
    const a = new FileActLedger(file);
    a.claim(['1:a', '2:b']);
    const b = new FileActLedger(file);
    expect([b.isClaimed('1:a'), b.isClaimed('2:b'), b.isClaimed('3:c')]).toEqual([true, true, false]);
    b.pruneClaims((k) => k === '1:a');
    const c = new FileActLedger(file);
    expect([c.isClaimed('1:a'), c.isClaimed('2:b')]).toEqual([true, false]);
  });

  it('a supervisor\'s restart gap beside a live claimed copy is no alarm (RED: a harness that stays inside a command is flagged)', async () => {
    const make = (gapReads: number) => {
      const tl = new RawTimeline();
      const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
      const copy = proc(600, ['node', '/app/harness/server.js', '--port', '7001'], { pid: 603, startKey: '603:s' });
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
      tl.step([...BASE, HARNESS, root, copy]); tl.step([...BASE, HARNESS, root, copy]);
      const detached: ProcEntry = { ...copy, ppid: 1 };
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, detached]);
      for (let k = 0; k < gapReads; k++) tl.step([...BASE, detached]);                // the supervisor restarts the harness
      const l2 = proc(53, [...HARNESS.argv], { pid: 950, startKey: '950:s' });
      for (let k = 0; k < 20; k++) tl.step([...BASE, detached, l2]);
      return tl;
    };
    for (const [gap, flagged] of [[8, false], [160, true]] as const) {
      nextPid = 10_000;
      const tl = make(gap);
      const states: string[] = [];
      const { plugin, h } = await run(tl, { steps: 10 + gap });
      states.push(plugin.getState());
      expect(fs.existsSync(path.join(h.dir, 'witness-action-required.json'))).toBe(flagged);
      expect(states[0]).toBe(flagged ? 'launcher_changed' : 'active');
    }
  });

  it('a re-record never turns a claimed process back into a command, even after a missed read (RED: an unclaimed one is)', async () => {
    const make = () => {
      const tl = new RawTimeline();
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
      const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
      const nested = proc(600, WRAPPER, { pid: 601, startKey: '601:s' });
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, root, nested]);
      for (let k = 0; k < 60; k++) tl.step([...BASE, HARNESS, { ...nested, ppid: HARNESS.pid }]);   // adopted; its command sealed
      for (let k = 0; k < 60; k++) tl.step([...BASE, HARNESS]);
      return tl;
    };
    const tl = make();
    const h = home();
    // One read misses the adopted process, so the lane reads it as new (a claimed root: never an act).
    const reader = subtreeOf(tl, (i, e) => i === 30 && e.pid === 601);
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, fastMs: 250, platform: 'linux', subtreeReader: reader,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      isAlive: (k) => tl.current().procs.has(k),
    });
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * 40);
    const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));
    fs.writeFileSync(h.launcherFile, JSON.stringify({ ...rec, recorded_at_ms: 11, source: 'doctor' }));
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 41));
    expect(plugin.drainPEs()).toHaveLength(1);                                       // the command, once
  });
});

describe(' — any locale, a failed read, a plain-shell harness', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];

  it('a named process the lane cannot use only loses the exception, never the record (RED: a usable one is kept)', () => {
    const h = home();
    const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));
    fs.writeFileSync(h.launcherFile, JSON.stringify({ ...rec, launcher_start_key: '37048:mer. 21 oct. 01:41:10 2026' }));
    const read = readLauncherRecord(h.launcherFile);
    expect(read?.fingerprint).toBe(rec.fingerprint);
    expect(read?.launcher_start_key).toBeUndefined();
    fs.writeFileSync(h.launcherFile, JSON.stringify({ ...rec, launcher_start_key: '37048:Wed Oct 21 01:41:10 2026' }));
    expect(readLauncherRecord(h.launcherFile)?.launcher_start_key).toBe('37048:Wed Oct 21 01:41:10 2026');
  });

  it.runIf(process.platform === 'darwin')('macOS: the recording walk keys a process in the C locale whatever the caller\'s language, as the lane\'s own read does', () => {
    const before = process.env.LC_ALL;
    process.env.LC_ALL = 'fr_FR.UTF-8';
    try {
      const me = defaultLauncherProcReader('darwin')(process.pid);
      expect(me?.startKey).toMatch(/^\d+:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) /);
      const snap = defaultSnapshotReader('darwin').read();
      expect(snap.procs.has(me!.startKey!)).toBe(true);
    } finally { if (before === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = before; }
  });

  it('macOS liveness: a failed whole-table read never drops a live claim (RED: a read that sees the daemon and not the copy drops it)', async () => {
    for (const failed of [true, false]) {
      nextPid = 10_000;
      const ledger = new FakeLedger();
      const h = home();
      const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
      const copy = proc(600, ['node', '/app/harness/server.js', '--port', '7001'], { pid: 603, startKey: '603:s' });
      const detached: ProcEntry = { ...copy, ppid: 1 };
      const snaps: ProcSnapshot[] = [];
      const at = (procs: ProcEntry[]) => snaps.push({ atMs: 0, procs: new Map(procs.map((e) => [e.startKey, e])) });
      for (let k = 0; k < 4; k++) at([...BASE, HARNESS]);
      at([...BASE, HARNESS, root, copy]); at([...BASE, HARNESS, root, copy]);
      for (let k = 0; k < 8; k++) at([...BASE, HARNESS, detached]);
      // Around the minute's prune: reads that fail (nothing at all) — or, the control, that truly lack the copy.
      for (let k = 0; k < 300; k++) at(failed ? [] : [...BASE, HARNESS]);
      const t0 = Date.now();
      const now = (): ProcSnapshot => ({ ...snaps[Math.min(Math.floor((Date.now() - t0) / 250), snaps.length - 1)], atMs: Date.now() });
      const plugin = new ProcessLanePlugin({
        reader: { read: now }, ledger, identifyProgram: () => null, pollMs: 250, platform: 'darwin', subtreeReader: null,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, osLiveness: true,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (snaps.length - 1));
      expect(ledger.claimed.has('603:s')).toBe(failed);
    }
  });

  it('a harness that feeds a plain `bash`, restarted from a person\'s `bash` shell, launches again (RED: under a distinctive command shape it is the command\'s)', async () => {
    const run1 = async (template: string[], shellArgv: string[]) => {
      nextPid = 10_000;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
      const launcherFile = path.join(dir, 'process-launcher.json');
      const sshd = proc(1, ['sshd-session'], { pid: 60, startKey: '60:s' });
      const shell = proc(60, shellArgv, { pid: 70, startKey: '70:s' });
      const h1 = proc(70, [...HARNESS.argv], { pid: 388, startKey: '388:s' });
      const h2 = proc(70, [...HARNESS.argv], { pid: 389, startKey: '389:s' });
      writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: launcherFingerprint({ pid: 388, ppid: 70, comm: 'node', argv: HARNESS.argv }, null), mode: 'template', template: templateOf(template), launcher_start_key: '388:s', recorded_at_ms: 1, source: 'install' }, launcherFile);
      const tl = new RawTimeline();
      const base = [INIT, OBSERVER, sshd, shell];
      for (let k = 0; k < 4; k++) tl.step([...base, h1]);
      tl.step(base);                                                                   // the person restarts the harness
      for (let k = 0; k < 8; k++) tl.step([...base, h2]);
      for (let c = 0; c < 2; c++) { const r = proc(389, template); tl.step([...base, h2, r]); tl.step([...base, h2, r]); tl.step([...base, h2]); }
      for (let k = 0; k < 40; k++) tl.step([...base, h2]);
      const plugin = new ProcessLanePlugin({
        reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
        otherLaneActive: () => false, launcherFile, stateDir: dir, uid: 1000,
        scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
        readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      return plugin.drainPEs().length;
    };
    expect(await run1(['bash'], ['bash'])).toBe(2);
    expect(await run1(['sh', '-s'], ['sh', '-s'])).toBe(2);                           // two tokens: still short
    expect(await run1(['sh', '-s', 'x'], ['sh', '-s', 'x'])).toBe(0);                 // three: distinctive
    const W = ['bash', '-c', 'read cmd; eval "$cmd"', 'wrap'];
    expect(await run1(W, W)).toBe(0);
  });
});

describe(' — claims written as members join; a failed read is never judged; Linux liveness', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const SHORT = ['bash'];
  function shortHome(dir: string): string {
    const launcherFile = path.join(dir, 'process-launcher.json');
    writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: launcherFingerprint({ pid: HARNESS.pid, ppid: HARNESS.ppid, comm: 'node', argv: HARNESS.argv }, null), mode: 'template', template: templateOf(SHORT), recorded_at_ms: 1, source: 'install' }, launcherFile);
    return launcherFile;
  }
  async function runOn(tl: RawTimeline, ledgerFile: string, dir: string, launcherFile: string) {
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FileActLedger(ledgerFile), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
      otherLaneActive: () => false, launcherFile, stateDir: dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
    });
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    await plugin.stop();
    return plugin.drainPEs();
  }

  it('a short command shape: a daemon restart while a command still runs keeps its processes claimed, so a test copy it starts never launches (RED: a ledger that never saw them)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
    const launcherFile = shortHome(dir);
    const root = proc(HARNESS.pid, SHORT, { pid: 600, startKey: '600:s' });
    const npm = proc(600, ['npm', 'test'], { pid: 601, startKey: '601:s' });
    const first = new RawTimeline();
    for (let k = 0; k < 4; k++) first.step([...BASE, HARNESS]);
    const quick = proc(HARNESS.pid, SHORT, { pid: 590, startKey: '590:s' });          // its claim is written at once…
    first.step([...BASE, HARNESS, quick]);
    first.step([...BASE, HARNESS]);                                                    // it seals (a write)
    for (let k = 0; k < 2; k++) first.step([...BASE, HARNESS, root, npm]);           // …so these are buffered; the daemon stops half a second later
    expect(await runOn(first, path.join(dir, 'ledger.json'), dir, launcherFile)).toHaveLength(1);
    // While it was down the harness exited and npm started a copy; the new daemon reads it all fresh.
    const make = () => {
      const tl = new RawTimeline();
      const copy = proc(601, ['node', '/app/harness/server.js', '--port', '7001'], { pid: 603, startKey: '603:s' });
      const fixed = [...BASE, { ...root, ppid: 1 }, npm, copy];
      for (let k = 0; k < 4; k++) tl.step(fixed);
      for (let c = 0; c < 3; c++) { const r = proc(603, SHORT); tl.step([...fixed, r]); tl.step([...fixed, r]); tl.step(fixed); }
      for (let k = 0; k < 40; k++) tl.step(fixed);
      return tl;
    };
    nextPid = 20_000;
    expect(await runOn(make(), path.join(dir, 'ledger.json'), dir, launcherFile)).toHaveLength(0);
    nextPid = 20_000;
    expect(await runOn(make(), path.join(dir, 'fresh.json'), dir, launcherFile)).toHaveLength(3);
  });

  it('a whole-table read that failed is never judged: a running command keeps its later processes and their destinations (RED: the same read, not failed, is judged)', async () => {
    const h = home();
    const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
    const sleep = proc(600, ['sleep', '1'], { pid: 601, startKey: '601:s' });
    const curl = proc(600, ['curl', 'https://api.example.org/x'], { pid: 602, startKey: '602:s' });
    const snaps: ProcEntry[][] = [];
    for (let k = 0; k < 4; k++) snaps.push([...BASE, HARNESS]);
    for (let k = 0; k < 4; k++) snaps.push([...BASE, HARNESS, root, sleep]);
    snaps.push([]);                                                                     // one failed `ps`
    for (let k = 0; k < 4; k++) snaps.push([...BASE, HARNESS, root, curl]);
    for (let k = 0; k < 40; k++) snaps.push([...BASE, HARNESS]);
    const t0 = Date.now();
    const read = (): ProcSnapshot => { const procs = snaps[Math.min(Math.floor((Date.now() - t0) / 250), snaps.length - 1)]; return { atMs: Date.now(), procs: new Map(procs.map((e) => [e.startKey, e])) }; };
    const plugin = new ProcessLanePlugin({
      reader: { read }, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'darwin', subtreeReader: null,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, osLiveness: true,
    });
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (snaps.length - 1));
    const pes = plugin.drainPEs();
    expect(pes).toHaveLength(1);
    expect(pes[0].metadata?.process_count).toBe(3);
    expect((pes[0].input_origins ?? []).map((o) => o.origin_identifier)).toContain('domain:api.example.org');
  });

  it('Linux liveness: an unreadable /proc keeps every claim (RED: a readable one that lacks the copy drops it)', async () => {
    for (const unreadable of [true, false]) {
      nextPid = 10_000;
      const ledger = new FakeLedger(); const h = home();
      const tl = new RawTimeline();
      const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
      const copy = proc(600, ['node', '/app/harness/server.js', '--port', '7001'], { pid: 603, startKey: '603:s' });
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
      tl.step([...BASE, HARNESS, root, copy]); tl.step([...BASE, HARNESS, root, copy]);
      for (let k = 0; k < 300; k++) tl.step([...BASE, HARNESS]);                     // the copy has exited (or /proc fails)
      const plugin = new ProcessLanePlugin({
        reader: tl, ledger, identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, osLiveness: true,
        scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
        readEntry: (pid) => {
          const e = [...tl.current().procs.values()].find((x) => x.pid === pid) ?? null;
          return unreadable && tl.i > 10 ? null : e;
        },
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      expect(ledger.claimed.has('603:s')).toBe(unreadable);
    }
  });
});

describe(' 0 — a restarted daemon adopts the command in flight, with the same ledger', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  it('a command running across a daemon restart seals once, by the new daemon (RED: a process that was a member, not the root, is never a command of its own)', async () => {
    const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
    const h = home();
    const ledgerFile = path.join(dir, 'ledger.json');
    const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
    const kid = proc(600, ['sleep', '20'], { pid: 601, startKey: '601:s' });
    const inner = proc(601, WRAPPER, { pid: 602, startKey: '602:s' });               // a member shaped like a command
    const runOn = async (tl: RawTimeline) => {
      const plugin = new ProcessLanePlugin({
        reader: tl, ledger: new FileActLedger(ledgerFile), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
        scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
        readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      await plugin.stop();
      return plugin.drainPEs();
    };
    const first = new RawTimeline();
    for (let k = 0; k < 4; k++) first.step([...BASE, HARNESS]);
    for (let k = 0; k < 280; k++) first.step([...BASE, HARNESS, root, kid, inner]);  // past a claims prune
    expect(await runOn(first)).toHaveLength(0);                                       // still running at the stop
    const second = new RawTimeline();
    for (let k = 0; k < 8; k++) second.step([...BASE, HARNESS, root, kid, { ...inner, ppid: HARNESS.pid }]);   // inner adopted by the harness
    for (let k = 0; k < 8; k++) second.step([...BASE, HARNESS, { ...inner, ppid: HARNESS.pid }]);
    for (let k = 0; k < 40; k++) second.step([...BASE, HARNESS]);
    const pes = await runOn(second);
    expect(pes).toHaveLength(1);                                                      // the command, once; never `inner`
  });
});

describe(' 0 — a root missed for one read never seals twice', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  it('the fast reader misses a running command for one read: it seals once (RED: two different commands seal twice)', async () => {
    const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
    const make = (same: boolean) => {
      const tl = new RawTimeline();
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
      const a = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
      const b = same ? a : proc(HARNESS.pid, WRAPPER, { pid: 601, startKey: '601:s' });
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, a]);
      tl.step([...BASE, HARNESS]);                                                     // a missed read (or a real gap)
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, b]);
      for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS]);
      return tl;
    };
    for (const [same, n] of [[true, 1], [false, 2]] as const) {
      nextPid = 10_000;
      const tl = make(same); const h = home();
      const plugin = new ProcessLanePlugin({
        reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, fastMs: 250, platform: 'linux',
        subtreeReader: { read(pids: readonly number[], atMs: number): ProcSnapshot {
          const all = [...tl.read().procs.values()]; const keep = new Set<number>(pids);
          for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
          const procs = new Map<string, ProcEntry>(); for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e); return { atMs, procs };
        } },
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
        scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
        readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      expect(plugin.drainPEs()).toHaveLength(n);
    }
  });
});

describe(' 0 (fixes) — a pre-exec read keys on the exec, failing reads are not silent, writes are capped', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];

  it('a command first read before its exec, running across a daemon restart, seals once (RED: one that never execs never does)', async () => {
    for (const execs of [true, false]) {
      nextPid = 10_000;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
      const h = home();
      const ledgerFile = path.join(dir, 'ledger.json');
      const fork = proc(HARNESS.pid, [...HARNESS.argv], { pid: 600, startKey: '600:s' });
      const root: ProcEntry = execs ? { ...fork, argv: WRAPPER, comm: 'bash' } : fork;
      const kid = proc(600, ['sleep', '20'], { pid: 601, startKey: '601:s' });
      const runOn = async (tl: RawTimeline) => {
        const plugin = new ProcessLanePlugin({
          reader: tl, ledger: new FileActLedger(ledgerFile), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
          otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
          scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
          readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
        });
        await plugin.init(observer); await plugin.start();
        await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
        await plugin.stop();
        return plugin.drainPEs();
      };
      const first = new RawTimeline();
      for (let k = 0; k < 4; k++) first.step([...BASE, HARNESS]);
      first.step([...BASE, HARNESS, fork]);                                            // read before its exec
      for (let k = 0; k < 8; k++) first.step([...BASE, HARNESS, root, kid]);
      expect(await runOn(first)).toHaveLength(0);
      const second = new RawTimeline();
      for (let k = 0; k < 8; k++) second.step([...BASE, HARNESS, root, kid]);
      for (let k = 0; k < 40; k++) second.step([...BASE, HARNESS]);
      expect(await runOn(second)).toHaveLength(execs ? 1 : 0);
    }
  });

  it('whole-table reads that keep failing end in launcher_not_seen, never a silent active lane (RED: reads that work stay active)', async () => {
    for (const failing of [true, false]) {
      const h = home();
      const t0 = Date.now();
      const read = (): ProcSnapshot => {
        const failed = failing && Date.now() - t0 > 2_000;
        const procs = failed ? [] : [...BASE, HARNESS];
        return { atMs: Date.now(), procs: new Map(procs.map((e) => [e.startKey, e])) };
      };
      const plugin = new ProcessLanePlugin({
        reader: { read }, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'darwin', subtreeReader: null,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, osLiveness: true,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(plugin.getState()).toBe(failing ? 'launcher_not_seen' : 'active');
    }
  });

  it('FileActLedger writes buffered claims at most once a second; a forced flush writes now (RED: forced flushes write every time)', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-led-')), 'ledger.json');
    const ledger = new FileActLedger(file);
    // A write is visible on disk at once: count the flushes after which the newest claim is there.
    const onDisk = (k: string): boolean => { try { return (JSON.parse(fs.readFileSync(file, 'utf8')).claimed as string[]).includes(k); } catch { return false; } };
    const t0 = Date.now();
    let written = 0;
    for (let i = 0; i < 50; i++) { vi.setSystemTime(t0 + 5_000 + i * 20); ledger.claim([`${i}:s`]); ledger.flush(); if (onDisk(`${i}:s`)) written += 1; }
    expect(written).toBeLessThanOrEqual(2);
    let forced = 0;
    for (let i = 50; i < 60; i++) { ledger.claim([`${i}:s`]); ledger.flush(true); if (onDisk(`${i}:s`)) forced += 1; }
    expect(forced).toBe(10);
    expect(new FileActLedger(file).isClaimed('49:s')).toBe(true);
  });
});

describe(' 1 — a crash right after a command starts; a missed read on a pending root', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const mk = (tl: RawTimeline, h: { dir: string; launcherFile: string }, ledger: ActLedger, sub?: boolean) => new ProcessLanePlugin({
    reader: tl, ledger, identifyProgram: () => null, pollMs: 250, platform: 'linux',
    subtreeReader: sub ? { read(pids: readonly number[], atMs: number): ProcSnapshot {
      const i = tl.i; const all = [...tl.read().procs.values()].filter((e) => !(i === 7 && e.pid === 600)); const keep = new Set<number>(pids);
      for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
      const procs = new Map<string, ProcEntry>(); for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e); return { atMs, procs };
    } } : null, ...(sub ? { fastMs: 250 } : {}),
    otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
    scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
    readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
  });

  it('the daemon is killed hard half a second after a command starts: the restarted daemon still mints it (RED: a process that was only a member is never adopted)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
    const h = home(); const ledgerFile = path.join(dir, 'ledger.json');
    const root = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
    const first = new RawTimeline();
    for (let k = 0; k < 8; k++) first.step([...BASE, HARNESS]);                     // the ledger has been idle
    for (let k = 0; k < 2; k++) first.step([...BASE, HARNESS, root]);
    const a = mk(first, h, new FileActLedger(ledgerFile));
    await a.init(observer); await a.start();
    await vi.advanceTimersByTimeAsync(250 * (first.snaps.length - 1));
    // Killed: no stop(), no final flush.
    const second = new RawTimeline();
    for (let k = 0; k < 8; k++) second.step([...BASE, HARNESS, root]);
    for (let k = 0; k < 40; k++) second.step([...BASE, HARNESS]);
    const b = mk(second, h, new FileActLedger(ledgerFile));
    await b.init(observer); await b.start();
    await vi.advanceTimersByTimeAsync(250 * (second.snaps.length - 1));
    expect(b.drainPEs()).toHaveLength(1);
  });

  it('a root first read before its exec and then missed for one read, running 30 s: it seals once (RED: the same without the missed read)', async () => {
    for (const missed of [true, false]) {
      nextPid = 10_000;
      const h = home();
      const tl = new RawTimeline();
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS]);
      const fork = proc(HARNESS.pid, [...HARNESS.argv], { pid: 600, startKey: '600:s' });
      for (let k = 0; k < 3; k++) tl.step([...BASE, HARNESS, fork]);                  // reads 4–6: before its exec
      const root: ProcEntry = { ...fork, argv: WRAPPER, comm: 'bash' };
      for (let k = 0; k < 120; k++) tl.step([...BASE, HARNESS, root]);                // read 7 is missed (fast reader); runs 30 s
      for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS]);
      const plugin = mk(tl, h, new FakeLedger(), missed);
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      expect(plugin.drainPEs()).toHaveLength(1);
    }
  });
});

describe(' 2 — a child already running at a launcher\'s first sighting is unknown; a sealed root stays sealed', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const fast = (tl: RawTimeline, h: { dir: string; launcherFile: string }, extra: Partial<ConstructorParameters<typeof ProcessLanePlugin>[0]> = {}) => new ProcessLanePlugin({
    reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, fastMs: 250, platform: 'linux',
    subtreeReader: { read(pids: readonly number[], atMs: number): ProcSnapshot {
      const all = [...tl.read().procs.values()]; const keep = new Set<number>(pids);
      for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
      const procs = new Map<string, ProcEntry>(); for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e); return { atMs, procs };
    } },
    otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
    scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
    readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
    ...extra,
  });

  it('with the fast reader, a template-shaped child the startup wrapper started before it exec\'d into the harness never mints (RED: one the harness starts after it is bound does)', async () => {
    for (const before of [true, false]) {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 8; k++) tl.step(BASE);
      const pre = proc(53, ['sh', '/start.sh'], { pid: 777, startKey: '777:s', comm: 'sh' });
      const post: ProcEntry = { ...pre, argv: [...HARNESS.argv], comm: 'node' };
      const child = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
      const kid = proc(778, ['sleep', '30'], { pid: 779, startKey: '779:s' });
      if (before) {
        tl.step([...BASE, pre, child, kid]);
        for (let k = 0; k < 20; k++) tl.step([...BASE, post, child, kid]);       // exec'd; the wrapper's child runs on
      } else {
        for (let k = 0; k < 12; k++) tl.step([...BASE, post]);                    // bound first
        for (let k = 0; k < 20; k++) tl.step([...BASE, post, child, kid]);
      }
      for (let k = 0; k < 40; k++) tl.step([...BASE, post]);
      const plugin = fast(tl, home());
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      expect(plugin.drainPEs()).toHaveLength(before ? 0 : 1);
    }
  });

  it('with the fast reader, a restarted harness whose first command starts in the very read it exec\'d seals it (RED: a template-shaped child already there the read before is unknown)', async () => {
    for (const startedAfter of [true, false]) {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 8; k++) tl.step([...BASE, HARNESS]);                     // the old harness, bound
      for (let k = 0; k < 4; k++) tl.step(BASE);                                    // it exits
      const pre = proc(53, ['sh', '-c', 'exec node /app/harness/server.js --port 7000'], { pid: 777, startKey: '777:s', comm: 'sh' });
      const post: ProcEntry = { ...pre, argv: [...HARNESS.argv], comm: 'node' };
      const cmd = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
      const kid = proc(778, ['ls', '/root'], { pid: 779, startKey: '779:s' });
      tl.step(startedAfter ? [...BASE, pre] : [...BASE, pre, cmd, kid]);
      for (let k = 0; k < 2; k++) tl.step([...BASE, post, cmd, kid]);             // exec'd, and the command at once
      for (let k = 0; k < 40; k++) tl.step([...BASE, post]);
      const plugin = fast(tl, home());
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      expect(plugin.drainPEs()).toHaveLength(startedAfter ? 1 : 0);
    }
  });

  it('a command the harness starts while the daemon restarts is the harness\'s command: the new daemon mints it (RED: with no daemon ever bound to that harness, it is unknown)', async () => {
    for (const bound of [true, false]) {
      nextPid = 10_000;
      const ledger = new FakeLedger(); const h = home();
      if (bound) {
        const before = new RawTimeline();
        for (let k = 0; k < 8; k++) before.step([...BASE, HARNESS]);
        const p0 = fast(before, h, { ledger });
        await p0.init(observer); await p0.start();
        await vi.advanceTimersByTimeAsync(250 * (before.snaps.length - 1));
        await p0.stop();
      }
      const tl = new RawTimeline();
      const root = proc(HARNESS.pid, WRAPPER);
      const kid = proc(root.pid, ['sleep', '3']);
      for (let k = 0; k < 12; k++) tl.step([...BASE, HARNESS, root, kid]);        // started in the gap
      for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS]);
      const plugin = fast(tl, h, { ledger });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      expect(plugin.drainPEs()).toHaveLength(bound ? 1 : 0);
    }
  });

  it('a child found unknown stays unknown after a daemon restart (RED: a command the harness started after it was bound is minted by the new daemon)', async () => {
    const ledger = new FakeLedger(); const h = home();
    const pre = proc(53, ['sh', '/start.sh'], { pid: 777, startKey: '777:s', comm: 'sh' });
    const post: ProcEntry = { ...pre, argv: [...HARNESS.argv], comm: 'node' };
    const early = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
    const later = proc(777, WRAPPER, { pid: 790, startKey: '790:s' });
    const first = new RawTimeline();
    for (let k = 0; k < 8; k++) first.step(BASE);
    first.step([...BASE, pre, early]);
    for (let k = 0; k < 8; k++) first.step([...BASE, post, early]);
    for (let k = 0; k < 4; k++) first.step([...BASE, post, early, later]);
    const p1 = fast(first, h, { ledger });
    await p1.init(observer); await p1.start();
    await vi.advanceTimersByTimeAsync(250 * (first.snaps.length - 1));
    await p1.stop();
    expect(p1.drainPEs()).toHaveLength(0);
    const second = new RawTimeline();
    for (let k = 0; k < 8; k++) second.step([...BASE, post, early, later]);
    for (let k = 0; k < 40; k++) second.step([...BASE, post]);
    const p2 = fast(second, h, { ledger });
    await p2.init(observer); await p2.start();
    await vi.advanceTimersByTimeAsync(250 * (second.snaps.length - 1));
    const pes = p2.drainPEs();
    expect(pes).toHaveLength(1);
    expect(pes[0].metadata?.process_count).toBe(1);
  });

  it('a launcher record removed and written again leaves no stale "previous read": a child the startup wrapper started meanwhile is unknown (RED: a command started after the record is back mints)', async () => {
    const tl = new ClockTimeline();
    const pre = proc(53, ['sh', '/start.sh'], { pid: 777, startKey: '777:s', comm: 'sh' });
    const post: ProcEntry = { ...pre, argv: [...HARNESS.argv], comm: 'node' };
    const early = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
    const later = proc(777, WRAPPER, { pid: 790, startKey: '790:s' });
    for (let k = 0; k < 8; k++) tl.step(BASE);                                     // record present, no harness yet
    for (let k = 0; k < 8; k++) tl.step([...BASE, pre, early]);                    // record gone; the wrapper starts a child
    for (let k = 0; k < 8; k++) tl.step([...BASE, post, early]);                   // and execs into the harness
    for (let k = 0; k < 8; k++) tl.step([...BASE, post, early]);                   // record back
    for (let k = 0; k < 4; k++) tl.step([...BASE, post, early, later]);
    for (let k = 0; k < 40; k++) tl.step([...BASE, post]);
    const h = home();
    const saved = fs.readFileSync(h.launcherFile);
    const plugin = fast(tl, h);
    tl.start();
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * 3);
    fs.rmSync(h.launcherFile);                                                      // noticed within a second
    await vi.advanceTimersByTimeAsync(250 * 20);
    fs.writeFileSync(h.launcherFile, saved);
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 24));
    expect(plugin.drainPEs()).toHaveLength(1);
    expect((plugin as unknown as { tracker: import('./acts').ProcessActTracker }).tracker.outcomeOf('778:s')).not.toBe('sealed');
  });

  it('a command the fast reader misses for one read seals once and its root stays sealed, so the audit counts it sealed — no false silence (RED: a root that only ever read as another\'s is not sealed)', async () => {
    const tl = new RawTimeline();
    for (let k = 0; k < 8; k++) tl.step([...BASE, HARNESS]);
    const a = proc(HARNESS.pid, WRAPPER, { pid: 600, startKey: '600:s' });
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, a]);
    tl.step([...BASE, HARNESS]);                                                       // the missed read
    const kid = proc(600, ['sleep', '120'], { pid: 601, startKey: '601:s' });
    for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS, a, kid]);                  // runs on 10 s
    for (let k = 0; k < 400; k++) tl.step([...BASE, HARNESS, kid]);                    // its child outlives it, past the audit's due time
    for (let k = 0; k < 480; k++) tl.step([...BASE, HARNESS]);                         // past the audit's due time
    const plugin = fast(tl, home(), { auditMs: 1_000, auditScan: () => tl.current() });
    await plugin.init(observer); await plugin.start();
    const tr = (plugin as unknown as { tracker: import('./acts').ProcessActTracker }).tracker;
    await vi.advanceTimersByTimeAsync(250 * 25);                                       // read back after the miss
    expect(tr.outcomeOf('600:s')).toBe('sealed');
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 26));
    expect(plugin.drainPEs()).toHaveLength(1);
    expect(tr.outcomeOf('600:s')).toBe('sealed');
    const w = plugin.takeCaptureWindow();
    expect(w.commandsDue).toBeGreaterThan(0);
    expect(w.commandsDueSealed).toBe(w.commandsDue);
    expect(tr.outcomeOf('nope:s')).toBeNull();
  });
});

describe(' 3 — unknown means seen before the launcher was one, on evidence', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const PYH = ['python3', '/app/harness.py'];
  function pyHome(): { dir: string; launcherFile: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d590-'));
    const launcherFile = path.join(dir, 'process-launcher.json');
    writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: launcherFingerprint({ pid: 388, ppid: 53, comm: 'python3', argv: PYH }, null), mode: 'template', template: templateOf(WRAPPER), recorded_at_ms: 1, source: 'install' }, launcherFile);
    return { dir, launcherFile };
  }
  const lightOf = (tl: RawTimeline) => () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }]));
  const entryOf = (tl: RawTimeline) => (pid: number) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null;

  for (const platform of ['linux', 'darwin'] as const) {
    it(`${platform}: a harness restarted by an exec that keeps the process name (python3 → python3) mints the command it starts after (RED: a child already there when the wrapper was read is unknown)`, async () => {
      for (const preExec of [false, true]) {
        nextPid = 10_000;
        const tl = new ClockTimeline();
        const L1 = proc(53, PYH, { pid: 388, startKey: '388:s', comm: 'python3' });
        const W = proc(53, ['python3', '/start.py'], { pid: 777, startKey: '777:s', comm: 'python3' });
        const L2: ProcEntry = { ...W, argv: [...PYH] };
        const C = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
        const kid = proc(778, ['sleep', '30'], { pid: 779, startKey: '779:s' });
        for (let k = 0; k < 8; k++) tl.step([...BASE, L1]);
        for (let k = 0; k < 4; k++) tl.step(BASE);
        tl.step(preExec ? [...BASE, W, C, kid] : [...BASE, W]);
        for (let k = 0; k < 3; k++) tl.step(preExec ? [...BASE, L2, C, kid] : [...BASE, L2]);
        for (let k = 0; k < 120; k++) tl.step([...BASE, L2, C, kid]);                // a 30 s build
        for (let k = 0; k < 200; k++) tl.step([...BASE, L2]);
        const h = pyHome();
        const plugin = new ProcessLanePlugin({
          reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform, subtreeReader: null,
          otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
          auditScan: () => tl.current(), ...(platform === 'linux' ? { scanLight: lightOf(tl), readEntry: entryOf(tl) } : {}),
        });
        tl.start();
        await plugin.init(observer); await plugin.start();
        await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
        expect(plugin.drainPEs()).toHaveLength(preExec ? 0 : 1);
      }
    });
  }

  for (const platform of ['linux', 'darwin'] as const) {
    it(`${platform}: a child the wrapper starts after it was first read, before its exec, is unknown — the latest read of the wrapper counts (RED: a command after the exec mints)`, async () => {
      const tl = new ClockTimeline();
      const L1 = proc(53, PYH, { pid: 388, startKey: '388:s', comm: 'python3' });
      const W = proc(53, ['sh', '/start.sh'], { pid: 777, startKey: '777:s', comm: 'sh' });
      const L2: ProcEntry = { ...W, argv: [...PYH], comm: 'python3' };
      const X = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
      const xk = proc(778, ['sleep', '60'], { pid: 779, startKey: '779:s' });
      const Y = proc(777, WRAPPER, { pid: 790, startKey: '790:s' });
      for (let k = 0; k < 8; k++) tl.step([...BASE, L1]);
      for (let k = 0; k < 4; k++) tl.step(BASE);
      for (let k = 0; k < 4; k++) tl.step([...BASE, W]);                          // the wrapper, read
      for (let k = 0; k < 16; k++) tl.step([...BASE, W, X, xk]);                  // starts X, read again (4 s)
      for (let k = 0; k < 12; k++) tl.step([...BASE, L2, X, xk]);                 // execs
      for (let k = 0; k < 8; k++) tl.step([...BASE, L2, X, xk, Y]);
      for (let k = 0; k < 200; k++) tl.step([...BASE, L2]);
      const h = pyHome();
      const plugin = new ProcessLanePlugin({
        reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform, subtreeReader: null,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
        ...(platform === 'linux' ? { scanLight: lightOf(tl), readEntry: entryOf(tl) } : {}),
      });
      tl.start();
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      const tr = (plugin as unknown as { tracker: import('./acts').ProcessActTracker }).tracker;
      expect(plugin.drainPEs()).toHaveLength(1);
      expect(tr.outcomeOf('790:s')).toBe('sealed');
    });
  }

  it('fast reader: a harness restarted by an exec that keeps the process name is found within a discovery interval, so a short command soon after seals (RED: it is found only by the audit, 15 s on)', async () => {
    const tl = new ClockTimeline();
    const L1 = proc(53, PYH, { pid: 388, startKey: '388:s', comm: 'python3' });
    const W = proc(53, ['python3', '/start.py'], { pid: 777, startKey: '777:s', comm: 'python3' });
    const L2: ProcEntry = { ...W, argv: [...PYH] };
    const C = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
    for (let k = 0; k < 8; k++) tl.step([...BASE, L1]);
    for (let k = 0; k < 4; k++) tl.step(BASE);
    for (let k = 0; k < 4; k++) tl.step([...BASE, W]);
    for (let k = 0; k < 16; k++) tl.step([...BASE, L2]);                          // exec'd, 4 s idle
    for (let k = 0; k < 4; k++) tl.step([...BASE, L2, C]);                        // a 1 s command
    for (let k = 0; k < 80; k++) tl.step([...BASE, L2]);
    const h = pyHome();
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, fastMs: 250, platform: 'linux',
      subtreeReader: { read(pids: readonly number[], atMs: number): ProcSnapshot {
        const all = [...tl.read().procs.values()]; const keep = new Set<number>(pids);
        for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
        const procs = new Map<string, ProcEntry>(); for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e); return { atMs, procs };
      } },
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
      scanLight: lightOf(tl), readEntry: entryOf(tl),
    });
    tl.start();
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    expect(plugin.drainPEs()).toHaveLength(1);
  });

  for (const gap of ['inert', 'no_record', 'direct'] as const) {
    it(`a wrapper read before the lane stopped reading (${gap}) that starts a child and execs meanwhile: the child never mints; a command after the lane resumes does (RED)`, async () => {
      const tl = new ClockTimeline();
      const W = proc(53, ['sh', '/start.sh'], { pid: 777, startKey: '777:s', comm: 'sh' });
      const L2: ProcEntry = { ...W, argv: [...HARNESS.argv], comm: 'node' };
      const X = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
      const xk = proc(778, ['sleep', '60'], { pid: 779, startKey: '779:s' });
      const Y = proc(777, WRAPPER, { pid: 790, startKey: '790:s' });
      for (let k = 0; k < 8; k++) tl.step([...BASE, HARNESS]);
      for (let k = 0; k < 8; k++) tl.step([...BASE, W]);                          // the wrapper, read
      for (let k = 0; k < 12; k++) tl.step([...BASE, W, X, xk]);                  // the lane reads nothing from here
      for (let k = 0; k < 20; k++) tl.step([...BASE, L2, X, xk]);
      for (let k = 0; k < 16; k++) tl.step([...BASE, L2, X, xk]);                 // resumed
      for (let k = 0; k < 8; k++) tl.step([...BASE, L2, X, xk, Y]);
      for (let k = 0; k < 200; k++) tl.step([...BASE, L2]);
      let inert = false;
      const h = home();
      const saved = fs.readFileSync(h.launcherFile, 'utf8');
      const plugin = new ProcessLanePlugin({
        reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
        otherLaneActive: () => inert, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
        scanLight: lightOf(tl), readEntry: entryOf(tl),
      });
      tl.start();
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * 12);
      if (gap === 'inert') inert = true;
      else if (gap === 'no_record') fs.rmSync(h.launcherFile);
      else fs.writeFileSync(h.launcherFile, JSON.stringify({ ...JSON.parse(saved), mode: 'direct', template: [] }));
      await vi.advanceTimersByTimeAsync(250 * 32);
      inert = false;
      fs.writeFileSync(h.launcherFile, saved);
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 45));
      const tr = (plugin as unknown as { tracker: import('./acts').ProcessActTracker }).tracker;
      expect(plugin.drainPEs()).toHaveLength(1);
      expect(tr.outcomeOf('790:s')).toBe('sealed');
    });
  }

  it('a child the startup wrapper starts while the lane is inert never mints; a command the harness starts after the lane resumes does (RED)', async () => {
    const tl = new ClockTimeline();
    const W = proc(53, ['sh', '/start.sh'], { pid: 777, startKey: '777:s', comm: 'sh' });
    const L2: ProcEntry = { ...W, argv: [...HARNESS.argv], comm: 'node' };
    const X = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
    const xk = proc(778, ['sleep', '60'], { pid: 779, startKey: '779:s' });
    const Y = proc(777, WRAPPER, { pid: 790, startKey: '790:s' });
    for (let k = 0; k < 16; k++) tl.step([...BASE, HARNESS]);
    for (let k = 0; k < 8; k++) tl.step(BASE);
    for (let k = 0; k < 20; k++) tl.step([...BASE, W, X, xk]);
    for (let k = 0; k < 40; k++) tl.step([...BASE, L2, X, xk]);
    for (let k = 0; k < 8; k++) tl.step([...BASE, L2, X, xk, Y]);
    for (let k = 0; k < 200; k++) tl.step([...BASE, L2]);
    let inert = false;
    const h = home();
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
      otherLaneActive: () => inert, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
      scanLight: lightOf(tl), readEntry: entryOf(tl),
    });
    tl.start();
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * 10);
    inert = true;
    await vi.advanceTimersByTimeAsync(250 * 40);
    inert = false;
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 51));
    const tr = (plugin as unknown as { tracker: import('./acts').ProcessActTracker }).tracker;
    expect(plugin.drainPEs()).toHaveLength(1);
    expect(tr.outcomeOf('790:s')).toBe('sealed');
    expect(tr.outcomeOf('778:s')).not.toBe('sealed');
  });
});

describe(' 4 — a harness first seen already as the harness owns the children seen with it', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const lightOf = (tl: RawTimeline) => () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }]));
  const entryOf = (tl: RawTimeline) => (pid: number) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null;
  /** The supervisor starts the next harness (beside the old, or after it exited); its first command `delay` reads later. */
  function restart(delaySteps: number, keepOld: boolean): ClockTimeline {
    const tl = new ClockTimeline();
    const next = proc(53, [...HARNESS.argv], { pid: 950, startKey: '950:s' });
    const cmd = proc(950, WRAPPER, { pid: 951, startKey: '951:s' });
    const kid = proc(951, ['sleep', '5'], { pid: 952, startKey: '952:s' });
    const old = keepOld ? [HARNESS] : [];
    for (let k = 0; k < 17; k++) tl.step([...BASE, HARNESS]);
    for (let k = 0; k < (keepOld ? 0 : 4); k++) tl.step(BASE);
    for (let k = 0; k < delaySteps; k++) tl.step([...BASE, ...old, next]);
    for (let k = 0; k < 20; k++) tl.step([...BASE, ...old, next, cmd, kid]);      // a 5 s command
    for (let k = 0; k < 200; k++) tl.step([...BASE, ...old, next]);
    return tl;
  }
  async function pes(tl: ClockTimeline, platform: 'linux' | 'darwin'): Promise<number> {
    const h = home();
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform, subtreeReader: null,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
      auditScan: () => tl.current(), ...(platform === 'linux' ? { scanLight: lightOf(tl), readEntry: entryOf(tl) } : {}),
    });
    tl.start();
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    return plugin.drainPEs().length;
  }
  for (const platform of ['linux', 'darwin'] as const) {
    it(`${platform}: beside a bound harness, a child first read in the very read its wrapper exec'd into the next harness is ambiguous and never mints (RED: one first read a read later does)`, async () => {
      for (const later of [false, true]) {
        nextPid = 10_000;
        const tl = new ClockTimeline();
        const W = proc(53, ['sh', '/start.sh'], { pid: 950, startKey: '950:s', comm: 'sh' });
        const L2: ProcEntry = { ...W, argv: [...HARNESS.argv], comm: 'node' };
        const X = proc(950, WRAPPER, { pid: 951, startKey: '951:s' });
        const xk = proc(951, ['sleep', '5'], { pid: 952, startKey: '952:s' });
        for (let k = 0; k < 9; k++) tl.step([...BASE, HARNESS]);
        for (let k = 0; k < 12; k++) tl.step([...BASE, HARNESS, W]);              // the wrapper, read by the lane
        if (later) tl.step([...BASE, HARNESS, L2]);
        for (let k = 0; k < 20; k++) tl.step([...BASE, HARNESS, L2, X, xk]);
        for (let k = 0; k < 200; k++) tl.step([...BASE, HARNESS, L2]);
        expect(await pes(tl, platform), `later=${later}`).toBe(later ? 1 : 0);
      }
    });

    it(`${platform}: a restarted harness's first command mints whenever it starts — in the harness's first read, or before discovery's next 2 s read beside the old one (RED: a command already running at the daemon's first read is unknown)`, async () => {
      for (const keepOld of [false, true]) {
        for (const d of [0, 1, 2, 4, 6, 9]) {
          nextPid = 10_000;
          expect(await pes(restart(d, keepOld), platform), `${platform} keepOld=${keepOld} delay=${d * 250} ms`).toBe(1);
        }
      }
      nextPid = 10_000;
      const first = new ClockTimeline();
      const root = proc(HARNESS.pid, WRAPPER, { pid: 951, startKey: '951:s' });
      for (let k = 0; k < 20; k++) first.step([...BASE, HARNESS, root]);
      for (let k = 0; k < 40; k++) first.step([...BASE, HARNESS]);
      expect(await pes(first, platform)).toBe(0);
    });
  }
});

describe(' 5 — a read that failed says nothing', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const lightOf = (t: RawTimeline) => () => new Map([...t.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }]));
  const entryOf = (t: RawTimeline) => (pid: number) => [...t.current().procs.values()].find((e) => e.pid === pid) ?? null;
  const subOf = (t: RawTimeline) => ({ read(pids: readonly number[], atMs: number): ProcSnapshot {
    const all = [...t.current().procs.values()]; const keep = new Set<number>(pids);
    for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
    const procs = new Map<string, ProcEntry>(); for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e); return { atMs, procs };
  } });
  /** `failReads` reads (discovery's, and on darwin the lane's too) come back empty first. */
  async function pes(t: ClockTimeline, mode: 'darwin' | 'linux-fast', failReads: number, audit: boolean): Promise<number> {
    const h = home();
    let reads = 0; let lights = 0;
    const empty = (): ProcSnapshot => ({ atMs: Date.now(), procs: new Map() });
    const light = lightOf(t);
    const darwin = mode === 'darwin';
    const plugin = new ProcessLanePlugin({
      reader: darwin ? { read: () => (++reads > failReads ? t.read() : empty()) } : t, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250,
      platform: darwin ? 'darwin' : 'linux', subtreeReader: darwin ? null : subOf(t), fastMs: 250,
      ...(darwin ? {} : { scanLight: () => (++lights > failReads ? light() : new Map()), readEntry: entryOf(t) }),
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => t.current().procs.has(k),
      ...(audit ? { auditScan: () => t.current() } : {}),
    });
    t.start();
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (t.snaps.length - 1));
    return plugin.drainPEs().length;
  }

  for (const mode of ['darwin', 'linux-fast'] as const) {
    for (const audit of [true, false]) {
      it(`${mode}${audit ? '' : ', no audit'}: a command already running when the daemon starts stays unknown through failed first reads (RED: one started after the first good read mints)`, async () => {
        for (const failReads of [0, 1, 2]) {
          nextPid = 10_000;
          const t = new ClockTimeline();
          const C = proc(HARNESS.pid, WRAPPER, { pid: 951, startKey: '951:s' });
          const k = proc(951, ['sleep', '5'], { pid: 952, startKey: '952:s' });
          for (let i = 0; i < 20; i++) t.step([...BASE, HARNESS, C, k]);
          for (let i = 0; i < 200; i++) t.step([...BASE, HARNESS]);
          expect(await pes(t, mode, failReads, audit), `failReads=${failReads}`).toBe(0);
        }
        nextPid = 10_000;
        const t = new ClockTimeline();
        const C = proc(HARNESS.pid, WRAPPER, { pid: 951, startKey: '951:s' });
        for (let i = 0; i < 8; i++) t.step([...BASE, HARNESS]);
        for (let i = 0; i < 8; i++) t.step([...BASE, HARNESS, C]);
        for (let i = 0; i < 200; i++) t.step([...BASE, HARNESS]);
        expect(await pes(t, mode, 2, audit)).toBe(1);
      });
    }
  }

  it('linux fast: a failed scan between a read of the wrapper and its exec never wipes what that read showed (RED: a command after the exec mints)', async () => {
    const t = new ClockTimeline();
    const W = proc(53, ['sh', '/start.sh'], { pid: 777, startKey: '777:s', comm: 'sh' });
    const L2: ProcEntry = { ...W, argv: [...HARNESS.argv], comm: 'node' };
    const X = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });
    const Y = proc(777, WRAPPER, { pid: 790, startKey: '790:s' });
    for (let i = 0; i < 8; i++) t.step([...BASE, HARNESS]);
    for (let i = 0; i < 4; i++) t.step(BASE);
    for (let i = 0; i < 4; i++) t.step([...BASE, W, X]);                           // the wrapper and its child, read
    for (let i = 0; i < 8; i++) t.step([...BASE, L2, X]);                          // exec'd
    for (let i = 0; i < 8; i++) t.step([...BASE, L2, X, Y]);
    for (let i = 0; i < 200; i++) t.step([...BASE, L2]);
    const h = home();
    const light = lightOf(t);
    let failNext = false;
    const plugin = new ProcessLanePlugin({
      reader: t, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: subOf(t), fastMs: 250,
      scanLight: () => { if (failNext) { failNext = false; return new Map(); } return light(); }, readEntry: entryOf(t),
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => t.current().procs.has(k),
    });
    t.start();
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * 15);
    failNext = true;                                                                 // the read just before the exec fails
    await vi.advanceTimersByTimeAsync(250 * (t.snaps.length - 16));
    const tr = (plugin as unknown as { tracker: import('./acts').ProcessActTracker }).tracker;
    expect(plugin.drainPEs()).toHaveLength(1);
    expect(tr.outcomeOf('790:s')).toBe('sealed');
  });
});

describe(' 5 — a failed audit read never blinds the alarm', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const FIXED_A = [INIT, SANDBOX, LOOP, OBSERVER, HARNESS];
  it('the lane is blind to a command and the audit read just before it failed: capture health still alarms (RED: a lane that sees it seals and does not)', async () => {
    for (const seeing of [false, true]) {
      nextPid = 10_000;
      const shown = new ClockTimeline();
      const root = proc(HARNESS.pid, WRAPPER, { pid: 80_001, startKey: '80001:s' });
      for (let k = 0; k < 41; k++) shown.step(FIXED_A);
      for (let k = 0; k < 12; k++) shown.step([...FIXED_A, root]);
      for (let k = 0; k < 480; k++) shown.step(FIXED_A);
      const hidden = new ClockTimeline();
      for (let k = 0; k < shown.snaps.length; k++) hidden.step(FIXED_A);
      const h = home();
      const t0 = Date.now();
      const plugin = new ProcessLanePlugin({
        reader: seeing ? shown : hidden, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, subtreeReader: null, platform: 'linux',
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, auditMs: 1_000,
        auditScan: () => { const dt = Date.now() - t0; return dt >= 9_500 && dt < 10_500 ? { atMs: Date.now(), procs: new Map() } : shown.current(); },
        scanLight: () => new Map(FIXED_A.map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
        readEntry: (pid) => FIXED_A.find((e) => e.pid === pid) ?? null,
      });
      shown.start(); hidden.start();
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (shown.snaps.length - 1));
      const w = plugin.takeCaptureWindow();
      expect(plugin.drainPEs()).toHaveLength(seeing ? 1 : 0);
      expect(w.commandsDue, `seeing=${seeing}`).toBe(1);
      expect(w.commandsDueSealed).toBe(seeing ? 1 : 0);
    }
  });
});

describe(' 6 — the not-seen clock: failed reads from the start, and a machine asleep', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const FIXED_D = [INIT, SANDBOX, LOOP, OBSERVER, HARNESS];
  const snap = (procs: ProcEntry[]): ProcSnapshot => ({ atMs: Date.now(), procs: new Map(procs.map((e) => [e.startKey, e])) });

  it('whole-table reads that fail from the daemon\'s start end in launcher_not_seen (RED: reads that work stay active)', async () => {
    for (const failing of [true, false]) {
      const h = home();
      const plugin = new ProcessLanePlugin({
        reader: { read: () => snap(failing ? [] : FIXED_D) }, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'darwin', subtreeReader: null,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, osLiveness: true,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(plugin.getState(), `failing=${failing}`).toBe(failing ? 'launcher_not_seen' : 'active');
      await plugin.stop();
    }
  });

  it('the machine sleeps 11 minutes and the first read after it wakes fails: no launcher_not_seen, no action file (RED: 11 minutes awake with failing reads flags it)', async () => {
    for (const asleep of [true, false]) {
      const h = home();
      let fail = false;
      const plugin = new ProcessLanePlugin({
        reader: { read: () => snap(fail ? [] : FIXED_D) }, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'darwin', subtreeReader: null,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, osLiveness: true,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(5_000);
      fail = true;
      if (asleep) vi.setSystemTime(Date.now() + 11 * 60_000);                         // suspended: no tick runs
      else await vi.advanceTimersByTimeAsync(11 * 60_000);
      await vi.advanceTimersByTimeAsync(250);
      expect(plugin.getState(), `asleep=${asleep}`).toBe(asleep ? 'active' : 'launcher_not_seen');
      expect(fs.existsSync(path.join(h.dir, 'witness-action-required.json'))).toBe(!asleep);
      await plugin.stop();
    }
  });
});

describe(' 7 — no clock runs while the lane reads nothing or the machine sleeps', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const BASE_E = [INIT, SANDBOX, LOOP, OBSERVER];
  const snap = (procs: ProcEntry[]): ProcSnapshot => ({ atMs: Date.now(), procs: new Map(procs.map((e) => [e.startKey, e])) });

  it('11 minutes inert, then a failed first read: no launcher_not_seen, no action file (RED: 11 minutes reading and failing flags it)', async () => {
    for (const inertSpell of [true, false]) {
      const h = home();
      let fail = false; let inert = false;
      const plugin = new ProcessLanePlugin({
        reader: { read: () => snap(fail ? [] : [...BASE_E, HARNESS]) }, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'darwin', subtreeReader: null,
        otherLaneActive: () => inert, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, osLiveness: true,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(5_000);
      fail = true;
      if (inertSpell) { inert = true; await vi.advanceTimersByTimeAsync(11 * 60_000); inert = false; await vi.advanceTimersByTimeAsync(2_000); }
      else await vi.advanceTimersByTimeAsync(11 * 60_000 + 2_000);
      expect(plugin.getState(), `inert=${inertSpell}`).toBe(inertSpell ? 'active' : 'launcher_not_seen');
      expect(fs.existsSync(path.join(h.dir, 'witness-action-required.json'))).toBe(!inertSpell);
      await plugin.stop();
    }
  });

  it('a harness restart gap beside a claimed copy, with the machine asleep an hour in the middle, is no false launcher_changed (RED: 31 s awake is flagged)', async () => {
    for (const asleep of [true, false]) {
      nextPid = 10_000;
      const h = home();
      const wrap = proc(HARNESS.pid, WRAPPER, { pid: 5000, startKey: '5000:s' });
      const copy = proc(5000, [...HARNESS.argv], { pid: 5001, startKey: '5001:s', comm: 'node' });
      let table: ProcEntry[] = [...BASE_E, HARNESS];
      const plugin = new ProcessLanePlugin({
        reader: { read: () => snap(table) }, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'darwin', subtreeReader: null,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, osLiveness: true,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(3_000);
      table = [...BASE_E, HARNESS, wrap, copy];                                      // a command runs a test copy
      await vi.advanceTimersByTimeAsync(5_000);
      table = [...BASE_E, wrap, copy];                                               // the supervisor restarts the harness
      await vi.advanceTimersByTimeAsync(2_500);
      if (asleep) { vi.setSystemTime(Date.now() + 60 * 60_000); await vi.advanceTimersByTimeAsync(2_500); }
      else await vi.advanceTimersByTimeAsync(31_000);
      expect(plugin.getState(), `asleep=${asleep}`).toBe(asleep ? 'active' : 'launcher_changed');
      expect(fs.existsSync(path.join(h.dir, 'witness-action-required.json'))).toBe(!asleep);
      await plugin.stop();
    }
  });
});

describe(' 8 — a record change is no exec: re-recording after a harness update keeps its running commands', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const OLDH = proc(53, ['node', '/app/harness-v1/server.js', '--port', '7000'], { pid: 388, startKey: '388:s' });
  const fp = (p: ProcEntry) => launcherFingerprint({ pid: p.pid, ppid: p.ppid, comm: p.comm ?? '', argv: p.argv }, null);
  /** The harness is updated (950), a command runs, and the agent re-records under the new harness. */
  async function run(platform: 'linux' | 'darwin', oldFp: string, oldTemplate: string[], viaWrapper: boolean) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-r18-'));
    const launcherFile = path.join(dir, 'process-launcher.json');
    writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: oldFp, mode: 'template', template: oldTemplate, recorded_at_ms: 1, source: 'install' }, launcherFile);
    const NEWH = proc(53, [...HARNESS.argv], { pid: 950, startKey: '950:s' });
    const W: ProcEntry = { ...NEWH, argv: ['sh', '/start.sh'], comm: 'sh' };
    const X = proc(950, WRAPPER, { pid: 940, startKey: '940:s' });                // the wrapper's own child
    const c1 = proc(950, WRAPPER, { pid: 951, startKey: '951:s' });
    const c1k = proc(951, ['sleep', '30'], { pid: 952, startKey: '952:s' });
    const r = proc(950, WRAPPER, { pid: 960, startKey: '960:s' });
    const rk = proc(960, ['node', '/home/u/.provian/agent.js', 'process-lane', 'record'], { pid: 961, startKey: '961:s' });
    const pre = viaWrapper ? [X] : [];
    const tl = new ClockTimeline();
    for (let k = 0; k < 9; k++) tl.step([...BASE, OLDH]);
    for (let k = 0; k < 4; k++) tl.step(BASE);
    if (viaWrapper) for (let k = 0; k < 4; k++) tl.step([...BASE, W, X]);
    for (let k = 0; k < 7; k++) tl.step([...BASE, NEWH, ...pre]);
    for (let k = 0; k < 20; k++) tl.step([...BASE, NEWH, ...pre, c1, c1k]);
    for (let k = 0; k < 8; k++) tl.step([...BASE, NEWH, ...pre, c1, c1k, r, rk]);
    for (let k = 0; k < 72; k++) tl.step([...BASE, NEWH, ...pre, c1, c1k]);
    for (let k = 0; k < 200; k++) tl.step([...BASE, NEWH]);
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform, subtreeReader: null,
      otherLaneActive: () => false, launcherFile, stateDir: dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
      auditScan: () => tl.current(),
      ...(platform === 'linux' ? {
        scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
        readEntry: (pid: number) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      } : {}),
    });
    tl.start();
    await plugin.init(observer); await plugin.start();
    const recordAt = 44 + (viaWrapper ? 4 : 0);
    await vi.advanceTimersByTimeAsync(250 * recordAt);
    writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: fp(NEWH), mode: 'template', template: templateOf(WRAPPER), recorded_at_ms: 2, source: 'record', launcher_start_key: '950:s', command_start_key: '960:s' }, launcherFile);
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1 - recordAt));
    const tr = (plugin as unknown as { tracker: import('./acts').ProcessActTracker }).tracker;
    return { n: plugin.drainPEs().length, c1: tr.outcomeOf('951:s'), x: tr.outcomeOf('940:s') };
  }
  for (const platform of ['linux', 'darwin'] as const) {
    it(`${platform}: the harness's fingerprint changed — the command in flight and the recording command both seal (RED: a child the wrapper started before its exec stays unknown)`, async () => {
      const a = await run(platform, fp(OLDH), templateOf(WRAPPER), false);
      expect(a.n).toBe(2);
      expect(a.c1).toBe('sealed');
      nextPid = 10_000;
      const b = await run(platform, fp(OLDH), templateOf(WRAPPER), true);
      expect(b.n).toBe(2);
      expect(b.c1).toBe('sealed');
      expect(b.x).not.toBe('sealed');
      nextPid = 10_000;
      const c = await run(platform, fp({ ...OLDH, argv: [...HARNESS.argv] }), templateOf(['bash', '--norc', '-c', 'old wrapper', 'wrap']), false);
      expect(c.n).toBe(2);                                                         // only the template changed
    });
  }
});

describe(' 8 — a stale read of the wrapper is still the wrapper', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const PYH = ['python3', '/app/harness.py'];
  it('fast reader, beside a bound harness: a same-name exec found only by the audit — the wrapper\'s own child stays unknown, the harness\'s command mints (RED)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-r18-'));
    const launcherFile = path.join(dir, 'process-launcher.json');
    writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: launcherFingerprint({ pid: 388, ppid: 53, comm: 'python3', argv: PYH }, null), mode: 'template', template: templateOf(WRAPPER), recorded_at_ms: 1, source: 'install' }, launcherFile);
    const L1 = proc(53, PYH, { pid: 388, startKey: '388:s', comm: 'python3' });
    const W = proc(53, ['python3', '/start.py'], { pid: 777, startKey: '777:s', comm: 'python3' });
    const L2: ProcEntry = { ...W, argv: [...PYH] };
    const X = proc(777, WRAPPER, { pid: 778, startKey: '778:s' });                // the wrapper's own child
    const Y = proc(777, WRAPPER, { pid: 790, startKey: '790:s' });                // the harness's command
    const tl = new ClockTimeline();
    for (let k = 0; k < 9; k++) tl.step([...BASE, L1]);
    for (let k = 0; k < 12; k++) tl.step([...BASE, L1, W, X]);                   // read as the wrapper (discovery: every 2 s)
    for (let k = 0; k < 20; k++) tl.step([...BASE, L1, L2, X]);                  // exec'd, same name
    for (let k = 0; k < 120; k++) tl.step([...BASE, L1, L2, X, Y]);              // past the audit's heal
    for (let k = 0; k < 200; k++) tl.step([...BASE, L1, L2]);
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, fastMs: 250, platform: 'linux',
      subtreeReader: { read(pids: readonly number[], atMs: number): ProcSnapshot {
        const all = [...tl.read().procs.values()]; const keep = new Set<number>(pids);
        for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
        const procs = new Map<string, ProcEntry>(); for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e); return { atMs, procs };
      } },
      otherLaneActive: () => false, launcherFile, stateDir: dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
      auditScan: () => tl.current(),
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid: number) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
    });
    tl.start();
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    const tr = (plugin as unknown as { tracker: import('./acts').ProcessActTracker }).tracker;
    expect(tr.outcomeOf('778:s')).not.toBe('sealed');
    expect(tr.outcomeOf('790:s')).toBe('sealed');
    expect(plugin.drainPEs()).toHaveLength(1);
  });
});

describe(' witness check on release 91 — the harness\'s own children never read as a harness change (Grok diagnostic 6)', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());

  // Measured on Grok's sandbox (2026-10-21, 18:38–19:35Z): every process running the harness program
  // — the recorded launcher, a long-lived copy that never launches the agent's commands (pid 392),
  // and each scheduled session's own harness — runs ONE fixed check line, about once a minute while
  // idle and many times around commands; its helpers differ run to run (13–22 tree shapes).
  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const BYST_SHELL = proc(53, ['bash', '-c', 'start-ui'], { pid: 385, startKey: '385:s', comm: 'bash' });
  const BYST = proc(385, [...HARNESS.argv], { pid: 392, startKey: '392:s', comm: 'node' });
  const FIXED_G = [...BASE, HARNESS, BYST_SHELL, BYST];
  const HELPERS: string[][][] = [[], [['curl', '-s', 'http://127.0.0.1:7001/status']], [['ss', '-lnt'], ['awk', '{print $4}']],
    [['pgrep', '-f', 'Xvfb'], ['sort'], ['sleep', '0.1']], [['xdpyinfo']]];

  function check(tl: RawTimeline, fixed: ProcEntry[], launcherPid: number, variant: number): void {
    const r = proc(launcherPid, CHECK);
    tl.step([...fixed, r, ...HELPERS[variant % HELPERS.length].map((a) => proc(r.pid, a))]);
    tl.step([...fixed, r]);
    tl.step(fixed);
  }
  function command(tl: RawTimeline, fixed: ProcEntry[], launcherPid: number, kid: string[], wrapper = WRAPPER): void {
    const r = proc(launcherPid, wrapper);
    const k = proc(r.pid, kid);
    tl.step([...fixed, r, k]); tl.step([...fixed, r, k]); tl.step(fixed);
  }
  /** Idle: both harness processes run their check every 2 s, with changing helpers. */
  function idle(tl: RawTimeline, fixed: ProcEntry[], seconds: number, launchers: number[] = [HARNESS.pid, BYST.pid]): void {
    for (let s = 0, v = 0; s < seconds; s += 2, v++) { check(tl, fixed, launchers[v % launchers.length], v); for (let k = 0; k < 5; k++) tl.step(fixed); }
  }
  async function runG(tl: RawTimeline, ledger: ActLedger, h = home()) {
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger, identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
    });
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    await plugin.stop();
    return { plugin, dir: h.dir };
  }
  const flagged = (dir: string): boolean => fs.existsSync(path.join(dir, 'witness-action-required.json'));
  // The correction: drift is a silent suspicion (launcher_unconfirmed, no instruction file) — an
  // idle harness's own check never gets past it — and a confirmed change (launcher_changed, with the
  // file) once the agent's commands ran the new way, each followed at once by the harness's check.

  it('idle after commands: the check every harness process runs, with changing helpers, is never a harness change (RED: seen after only one command, it still is)', async () => {
    const tl = new RawTimeline();
    for (let k = 0; k < 10; k++) tl.step(FIXED_G);
    command(tl, FIXED_G, HARNESS.pid, ['ls', '/root']); check(tl, FIXED_G, HARNESS.pid, 1);
    command(tl, FIXED_G, HARNESS.pid, ['df', '-h']); check(tl, FIXED_G, HARNESS.pid, 2);
    idle(tl, FIXED_G, 60);
    const a = await runG(tl, new FakeLedger());
    expect(a.plugin.getState()).toBe('active');
    expect(flagged(a.dir)).toBe(false);
    expect(a.plugin.drainPEs()).toHaveLength(2);
    // RED: one command, then idle — the check was never followed by a command of the process that ran it.
    nextPid = 10_000;
    const red = new RawTimeline();
    for (let k = 0; k < 10; k++) red.step(FIXED_G);
    command(red, FIXED_G, HARNESS.pid, ['ls', '/root']); check(red, FIXED_G, HARNESS.pid, 1);
    idle(red, FIXED_G, 60);
    const b = await runG(red, new FakeLedger());
    expect(b.plugin.getState()).toBe('launcher_unconfirmed');
    expect(flagged(b.dir)).toBe(false);
  });

  it('what the harness runs itself is remembered across a daemon restart (real ledger; RED: a fresh ledger flags the same idle)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-hk-'));
    const ledgerFile = path.join(dir, 'ledger.json');
    const tl = new RawTimeline();
    for (let k = 0; k < 10; k++) tl.step(FIXED_G);
    command(tl, FIXED_G, HARNESS.pid, ['ls', '/root']); check(tl, FIXED_G, HARNESS.pid, 1);
    command(tl, FIXED_G, HARNESS.pid, ['df', '-h']); check(tl, FIXED_G, HARNESS.pid, 2);
    for (let k = 0; k < 10; k++) tl.step(FIXED_G);
    await runG(tl, new FileActLedger(ledgerFile));
    expect(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).housekeeping).toHaveLength(1);
    const after = (): RawTimeline => { nextPid = 20_000; const t = new RawTimeline(); for (let k = 0; k < 10; k++) t.step(FIXED_G); idle(t, FIXED_G, 60); return t; };
    const again = await runG(after(), new FileActLedger(ledgerFile));
    expect(again.plugin.getState()).toBe('active');
    expect(flagged(again.dir)).toBe(false);
    const fresh = await runG(after(), new FileActLedger(path.join(dir, 'fresh.json')));
    expect(fresh.plugin.getState()).toBe('launcher_unconfirmed');
  });

  it('a new harness process with a changed wrapper is still flagged although the old one keeps running and launching matching commands (RED: the same process with the recorded wrapper is not)', async () => {
    const H2 = proc(53, [...HARNESS.argv], { pid: 900, startKey: '900:s', comm: 'node' });
    const W2 = ['bash', '--noprofile', '--norc', '-c', 'v2: read the command elsewhere', 'wrap', 'x'];
    const work = [['ls', '/root'], ['sleep', '3'], ['git', 'status'], ['cat', 'a.txt'], ['make'], ['pwd'], ['uname', '-a'], ['wc', '-l'], ['id'], ['du'], ['env'], ['date'], ['df'], ['w']];
    const build = (wrapper: string[]): RawTimeline => {
      nextPid = 10_000;
      const tl = new RawTimeline();
      const fx = [...FIXED_G, H2];
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      command(tl, FIXED_G, HARNESS.pid, ['ls', '/root']); check(tl, FIXED_G, HARNESS.pid, 1);
      command(tl, FIXED_G, HARNESS.pid, ['df', '-h']); check(tl, FIXED_G, HARNESS.pid, 2);
      for (let k = 0; k < 10; k++) tl.step(fx);                       // the new harness process starts
      command(tl, fx, H2.pid, work[0], wrapper); check(tl, fx, H2.pid, 3);
      command(tl, fx, HARNESS.pid, ['date']); check(tl, fx, HARNESS.pid, 4);   // the old one still matches
      for (const w of work.slice(1)) { command(tl, fx, H2.pid, w, wrapper); check(tl, fx, H2.pid, 0); }
      for (let k = 0; k < 10; k++) tl.step(fx);
      return tl;
    };
    const changed = await runG(build(W2), new FakeLedger());
    expect(changed.plugin.getState()).toBe('launcher_changed');
    expect(flagged(changed.dir)).toBe(true);
    const same = await runG(build(WRAPPER), new FakeLedger());
    expect(same.plugin.getState()).toBe('active');
    expect(same.plugin.drainPEs()).toHaveLength(3 + work.length);
  });

  it('the correction, : with the harness\'s check learned, the suspicion stands — healable by a `provian` command — through the agent\'s next commands before it is flagged (RED: a flag at the moment of suspicion)', async () => {
    const W2 = ['bash', '--noprofile', '--norc', '-c', 'v2: read the command elsewhere', 'wrap', 'x'];
    nextPid = 10_000;
    const tl = new RawTimeline();
    for (let k = 0; k < 10; k++) tl.step(FIXED_G);
    command(tl, FIXED_G, HARNESS.pid, ['ls', '/root']); check(tl, FIXED_G, HARNESS.pid, 1);
    command(tl, FIXED_G, HARNESS.pid, ['df', '-h']); check(tl, FIXED_G, HARNESS.pid, 2);
    const starts: number[] = [];                                            // the poll each new-wrapper command starts
    for (let c = 0; c < LAUNCHER_DRIFT_STREAK + LAUNCHER_CHANGE_FLAG_COMMANDS + 2; c++) {
      starts.push(tl.snaps.length); command(tl, FIXED_G, HARNESS.pid, ['id', String(c)], W2); check(tl, FIXED_G, HARNESS.pid, 0);
    }
    for (let k = 0; k < 10; k++) tl.step(FIXED_G);
    const h = home();
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
    });
    await plugin.init(observer); await plugin.start();
    const trace: string[] = [plugin.getState()];
    for (let i = 1; i < tl.snaps.length; i++) { await vi.advanceTimersByTimeAsync(250); trace.push(plugin.getState()); }
    await plugin.stop();
    const suspected = trace.indexOf('launcher_unconfirmed');
    const flaggedAt = trace.indexOf('launcher_changed');
    expect(suspected).toBeGreaterThan(0);
    expect(flaggedAt).toBeGreaterThan(suspected);
    // Commands started while the healable suspicion stood: the agent's chance.
    expect(starts.filter((p) => p > suspected && p < flaggedAt).length).toBeGreaterThanOrEqual(LAUNCHER_CHANGE_FLAG_COMMANDS);
    expect(fs.existsSync(path.join(h.dir, 'witness-action-required.json'))).toBe(true);
  });

  it('the recorded harness changing its wrapper without restarting is flagged: what it starts after its last matching command is never learned (RED: matching commands are not)', async () => {
    const W2 = ['bash', '--noprofile', '--norc', '-c', 'v2: read the command elsewhere', 'wrap', 'x'];
    const work = [['ls', '/root'], ['sleep', '3'], ['git', 'status'], ['cat', 'a.txt'], ['make'], ['pwd'], ['uname', '-a'], ['wc', '-l'], ['id'], ['du'], ['env'], ['date'], ['df'], ['w']];
    const build = (wrapper: string[]): RawTimeline => {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      command(tl, FIXED_G, HARNESS.pid, ['ls', '/root']); check(tl, FIXED_G, HARNESS.pid, 1);
      command(tl, FIXED_G, HARNESS.pid, ['df', '-h']); check(tl, FIXED_G, HARNESS.pid, 2);
      for (const w of work) { command(tl, FIXED_G, HARNESS.pid, w, wrapper); check(tl, FIXED_G, HARNESS.pid, 0); }
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      return tl;
    };
    const changed = await runG(build(W2), new FakeLedger());
    expect(changed.plugin.getState()).toBe('launcher_changed');
    const same = await runG(build(WRAPPER), new FakeLedger());
    expect(same.plugin.getState()).toBe('active');
  });

  it(' : one old-wrapper command landing after the change does not teach the new wrapper as housekeeping (RED: all old-wrapper commands are not flagged)', async () => {
    const W2 = ['bash', '--noprofile', '--norc', '-c', 'v2: read the command elsewhere', 'wrap', 'x'];
    const work = [['ls', '/root'], ['sleep', '3'], ['git', 'status'], ['cat', 'a.txt'], ['make'], ['pwd'], ['uname', '-a'], ['wc', '-l'], ['id'], ['du'], ['env'], ['date'], ['df'], ['w'], ['id', '-u']];
    const build = (wrapper: string[]): RawTimeline => {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      command(tl, FIXED_G, HARNESS.pid, ['ls', '/root']); check(tl, FIXED_G, HARNESS.pid, 1);
      command(tl, FIXED_G, HARNESS.pid, ['df', '-h']); check(tl, FIXED_G, HARNESS.pid, 2);
      command(tl, FIXED_G, HARNESS.pid, ['date'], wrapper); check(tl, FIXED_G, HARNESS.pid, 3);
      command(tl, FIXED_G, HARNESS.pid, ['whoami']); check(tl, FIXED_G, HARNESS.pid, 4);     // one more old-wrapper command
      for (const w of work) { command(tl, FIXED_G, HARNESS.pid, w, wrapper); check(tl, FIXED_G, HARNESS.pid, 0); }
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      return tl;
    };
    const changed = await runG(build(W2), new FakeLedger());
    expect(changed.plugin.getState()).toBe('launcher_changed');
    expect(changed.plugin.drainPEs()).toHaveLength(3);
    const same = await runG(build(WRAPPER), new FakeLedger());
    expect(same.plugin.getState()).toBe('active');
    expect(same.plugin.drainPEs()).toHaveLength(4 + work.length);
  });

  it(' : shapes seen under one record never complete under another — a rollback to the old record flags the new wrapper again (RED: under the new record its commands seal)', async () => {
    const H2 = proc(53, [...HARNESS.argv], { pid: 900, startKey: '900:s', comm: 'node' });
    const W2 = ['bash', '--noprofile', '--norc', '-c', 'v2: read the command elsewhere', 'wrap', 'x'];
    const fx = [...FIXED_G, H2];
    const tl = new RawTimeline();
    for (let k = 0; k < 10; k++) tl.step(fx);
    for (let c = 0; c < 4; c++) { command(tl, fx, H2.pid, ['ls', `/d${c}`], W2); check(tl, fx, H2.pid, c); }  // under record W1: flagged
    const phase1 = tl.snaps.length;
    for (let c = 0; c < 4; c++) { command(tl, fx, H2.pid, ['ls', `/e${c}`], W2); check(tl, fx, H2.pid, c); }  // under record W2: commands
    const phase2 = tl.snaps.length;
    const work = [['ls', '/root'], ['sleep', '3'], ['git', 'status'], ['cat', 'a.txt'], ['make'], ['pwd'], ['uname', '-a'], ['wc', '-l'], ['id'], ['du'], ['env'], ['date'], ['df'], ['w']];
    for (const w of work) { command(tl, fx, H2.pid, w, W2); check(tl, fx, H2.pid, 0); }                       // record W1 again
    for (let k = 0; k < 10; k++) tl.step(fx);
    const h = home();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-hk-'));
    const ledger = new FileActLedger(path.join(dir, 'ledger.json'));
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger, identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
      scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
      readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
    });
    await plugin.init(observer); await plugin.start();
    const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8'));
    await vi.advanceTimersByTimeAsync(250 * (phase1 - 1));
    expect(plugin.getState()).toBe('launcher_unconfirmed');
    fs.writeFileSync(h.launcherFile, JSON.stringify({ ...rec, template: templateOf(W2), recorded_at_ms: 2, source: 'record' }));
    await vi.advanceTimersByTimeAsync(250 * (phase2 - phase1));
    expect(plugin.drainPEs().length).toBeGreaterThanOrEqual(3);                 // RED: the new wrapper seals under its own record
    expect(ledger.housekeepingShapes()).toHaveLength(1);                         // its check (never the wrapper)
    fs.writeFileSync(h.launcherFile, JSON.stringify({ ...rec, recorded_at_ms: 3, source: 'record' }));
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - phase2));
    await plugin.stop();
    expect(plugin.getState()).toBe('launcher_changed');
    expect(fs.existsSync(path.join(h.dir, 'witness-action-required.json'))).toBe(true);
  });

  // The rule's parts, each with its own control ( mutations).
  const W2R = ['bash', '--noprofile', '--norc', '-c', 'v2: read the command elsewhere', 'wrap', 'x'];
  const WORK = [['ls', '/root'], ['sleep', '3'], ['git', 'status'], ['cat', 'a.txt'], ['make'], ['pwd'], ['uname', '-a'], ['wc', '-l']];
  /** A command whose tree ends in the poll where `next` starts (a fast harness): `next` roots appear that poll. */
  function commandThen(tl: RawTimeline, fixed: ProcEntry[], launcherPid: number, kid: string[], next: ProcEntry[][]): void {
    const r = proc(launcherPid, WRAPPER); const k = proc(r.pid, kid);
    tl.step([...fixed, r, k]); tl.step([...fixed, r, k]);
    for (const roots of next) tl.step([...fixed, ...roots]);
    tl.step(fixed);
  }
  const checkRoot = (launcherPid: number, variant: number): ProcEntry[] => { const r = proc(launcherPid, CHECK); return [r, ...HELPERS[variant % HELPERS.length].map((a) => proc(r.pid, a))]; };

  it('a check started in the very read the command ends is the harness\'s own (RED: a check started a second later is not)', async () => {
    const build = (late: boolean): RawTimeline => {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      for (const kid of [['ls', '/root'], ['df', '-h']]) {
        if (late) { command(tl, FIXED_G, HARNESS.pid, kid); for (let k = 0; k < 4; k++) tl.step(FIXED_G); check(tl, FIXED_G, HARNESS.pid, 1); }
        else { const c = checkRoot(HARNESS.pid, 1); commandThen(tl, FIXED_G, HARNESS.pid, kid, [c, [c[0]]]); }
      }
      idle(tl, FIXED_G, 60);
      return tl;
    };
    expect((await runG(build(false), new FakeLedger())).plugin.getState()).toBe('active');
    expect((await runG(build(true), new FakeLedger())).plugin.getState()).toBe('launcher_unconfirmed');
  });

  it('only the FIRST child after a command counts: a changed-wrapper command right behind the check is never learned (RED: without the check it is the first)', async () => {
    const build = (withCheck: boolean): RawTimeline => {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      for (const kid of [['ls', '/root'], ['df', '-h'], ['id']]) {
        const w2 = proc(HARNESS.pid, W2R); const w2k = proc(w2.pid, ['date']);
        const after = withCheck ? [[...checkRoot(HARNESS.pid, 1)], [w2, w2k], [w2]] : [[w2, w2k], [w2]];
        commandThen(tl, FIXED_G, HARNESS.pid, kid, after);
        for (let k = 0; k < 8; k++) tl.step(FIXED_G);
      }
      for (const w of WORK) { command(tl, FIXED_G, HARNESS.pid, w, W2R); for (let k = 0; k < 8; k++) tl.step(FIXED_G); }
      return tl;
    };
    expect((await runG(build(true), new FakeLedger())).plugin.getState()).toBe('launcher_unconfirmed');
    // The control: a harness that starts a command right behind the last with no check between —
    // the residual this rule declares (half a second, twice) — learns it.
    expect((await runG(build(false), new FakeLedger())).plugin.getState()).toBe('active');
  });

  it('only the SAME harness process\'s child counts: another harness process starting a changed-wrapper command right after is never learned (RED: the same process is)', async () => {
    const H2 = proc(53, [...HARNESS.argv], { pid: 900, startKey: '900:s', comm: 'node' });
    const fx = [...FIXED_G, H2];
    const build = (by: number): RawTimeline => {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 10; k++) tl.step(fx);
      for (const kid of [['ls', '/root'], ['df', '-h'], ['id']]) {
        const w2 = proc(by, W2R); const w2k = proc(w2.pid, ['date']);
        commandThen(tl, fx, HARNESS.pid, kid, [[w2, w2k], [w2]]);
        for (let k = 0; k < 8; k++) tl.step(fx);
      }
      for (const w of WORK) { command(tl, fx, by, w, W2R); for (let k = 0; k < 8; k++) tl.step(fx); }
      return tl;
    };
    expect((await runG(build(H2.pid), new FakeLedger())).plugin.getState()).toBe('launcher_unconfirmed');
    expect((await runG(build(HARNESS.pid), new FakeLedger())).plugin.getState()).toBe('active');
  });

  it('a sighting begun under one record never completes under another (RED: two sightings under one record do)', async () => {
    const run2 = async (rerecordBetween: boolean) => {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      command(tl, FIXED_G, HARNESS.pid, ['ls', '/root']); check(tl, FIXED_G, HARNESS.pid, 1);
      const mid = tl.snaps.length;
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      command(tl, FIXED_G, HARNESS.pid, ['df', '-h']); check(tl, FIXED_G, HARNESS.pid, 2);
      idle(tl, FIXED_G, 60);
      const h = home();
      const plugin = new ProcessLanePlugin({
        reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'linux', subtreeReader: null,
        otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000,
        scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
        readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
      });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (mid + 4));
      if (rerecordBetween) { const rec = JSON.parse(fs.readFileSync(h.launcherFile, 'utf8')); fs.writeFileSync(h.launcherFile, JSON.stringify({ ...rec, recorded_at_ms: 2, source: 'record' })); }
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - mid - 5));
      await plugin.stop();
      return plugin.getState();
    };
    expect(await run2(true)).toBe('launcher_unconfirmed');
    expect(await run2(false)).toBe('active');
  });

  it('a child started while the command was still running is not its post-command check (RED: one started as it ends is)', async () => {
    const build = (startedEarly: boolean): RawTimeline => {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      for (const kid of [['sleep', '5'], ['sleep', '6'], ['sleep', '7']]) {
        const r = proc(HARNESS.pid, WRAPPER); const k = proc(r.pid, kid);
        const w2 = proc(HARNESS.pid, W2R); const w2k = proc(w2.pid, ['tail', '-f', 'log']);
        for (let i = 0; i < 20; i++) tl.step([...FIXED_G, r, k, ...(startedEarly && i >= 8 ? [w2, w2k] : [])]);
        for (let i = 0; i < 12; i++) tl.step([...FIXED_G, w2, w2k]);       // the command has ended; the other runs on
        tl.step(FIXED_G);
        for (let i = 0; i < 8; i++) tl.step(FIXED_G);
      }
      for (const w of WORK) { command(tl, FIXED_G, HARNESS.pid, w, W2R); for (let k = 0; k < 8; k++) tl.step(FIXED_G); }
      return tl;
    };
    expect((await runG(build(true), new FakeLedger())).plugin.getState()).toBe('launcher_unconfirmed');
    expect((await runG(build(false), new FakeLedger())).plugin.getState()).toBe('active');
  });

  /** The review-round-2 shape: one process runs an old-wrapper command and, right behind it with no check, a new-wrapper one. */
  function mixedPair(tl: RawTimeline, fixed: ProcEntry[], c: number): void {
    const w2 = proc(HARNESS.pid, W2R); const w2k = proc(w2.pid, ['date']);
    commandThen(tl, fixed, HARNESS.pid, ['id', String(c)], [[w2, w2k], [w2]]);
    for (let k = 0; k < 8; k++) tl.step(fixed);
  }
  const baselineSpent = (tl: RawTimeline): void => {
    for (let c = 0; c < 10; c++) { command(tl, FIXED_G, HARNESS.pid, ['ls', `/b${c}`]); check(tl, FIXED_G, HARNESS.pid, c); }
  };

  it(' : after a record\'s first commands nothing more is learned — a later mixed old/new-wrapper harness is flagged (RED: the same pattern inside the first commands is learned, the declared exception)', async () => {
    const build = (late: boolean): RawTimeline => {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      if (late) baselineSpent(tl);
      mixedPair(tl, FIXED_G, 1); mixedPair(tl, FIXED_G, 2);
      for (const w of WORK) { command(tl, FIXED_G, HARNESS.pid, w, W2R); for (let k = 0; k < 8; k++) tl.step(FIXED_G); }
      return tl;
    };
    const late = await runG(build(true), new FakeLedger());
    expect(late.plugin.getState()).toBe('launcher_unconfirmed');
    expect(flagged(late.dir)).toBe(false);
    expect((await runG(build(false), new FakeLedger())).plugin.getState()).toBe('active');
  });

  it(' : the learning window is kept in the ledger — a daemon restart never reopens it (real ledger; RED: a fresh ledger does)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-hk-'));
    const ledgerFile = path.join(dir, 'ledger.json');
    const h = home();
    nextPid = 10_000;
    const first = new RawTimeline();
    for (let k = 0; k < 10; k++) first.step(FIXED_G);
    baselineSpent(first);
    for (let k = 0; k < 10; k++) first.step(FIXED_G);
    await runG(first, new FileActLedger(ledgerFile), h);
    expect(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).housekeeping_baseline.left).toBe(0);
    const after = (): RawTimeline => {
      nextPid = 30_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      mixedPair(tl, FIXED_G, 1); mixedPair(tl, FIXED_G, 2);
      for (const w of WORK) { command(tl, FIXED_G, HARNESS.pid, w, W2R); for (let k = 0; k < 8; k++) tl.step(FIXED_G); }
      return tl;
    };
    expect((await runG(after(), new FileActLedger(ledgerFile), h)).plugin.getState()).toBe('launcher_unconfirmed');
    expect((await runG(after(), new FileActLedger(path.join(dir, 'fresh.json')), h)).plugin.getState()).toBe('active');
  });

  it(' : a fork first read before the command\'s end, that then execs a new wrapper, is never its post-command check (RED: one first read as the command ends is)', async () => {
    const build = (forkEarly: boolean): RawTimeline => {
      nextPid = 10_000;
      const tl = new RawTimeline();
      for (let k = 0; k < 10; k++) tl.step(FIXED_G);
      for (const kid of [['ls', '/root'], ['df', '-h'], ['id']]) {
        const r = proc(HARNESS.pid, WRAPPER); const k = proc(r.pid, kid);
        const fork = proc(HARNESS.pid, [...HARNESS.argv], { comm: 'node' });
        const execd: ProcEntry = { ...fork, argv: W2R, comm: 'bash' };
        tl.step([...FIXED_G, r, k]);
        tl.step([...FIXED_G, r, k, ...(forkEarly ? [fork] : [])]);
        tl.step([...FIXED_G, fork]);                                    // the command's end is read here
        tl.step([...FIXED_G, execd]);                                   // the fork execs after it
        tl.step(FIXED_G);
        for (let i = 0; i < 8; i++) tl.step(FIXED_G);
      }
      for (const w of WORK) { command(tl, FIXED_G, HARNESS.pid, w, W2R); for (let k = 0; k < 8; k++) tl.step(FIXED_G); }
      return tl;
    };
    expect((await runG(build(true), new FakeLedger())).plugin.getState()).toBe('launcher_unconfirmed');
    expect((await runG(build(false), new FakeLedger())).plugin.getState()).toBe('active');
  });
});

describe(' witness check on release 92 — a new session harness beside the bound one has its first command sealed (Grok, 19:04:54Z)', () => {
  beforeEach(() => { vi.useFakeTimers(); nextPid = 10_000; });
  afterEach(() => vi.useRealTimers());
  const BASE = [INIT, SANDBOX, LOOP, OBSERVER];
  const fast = (tl: RawTimeline, h: { dir: string; launcherFile: string }, extra: Partial<ConstructorParameters<typeof ProcessLanePlugin>[0]> = {}) => new ProcessLanePlugin({
    reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, fastMs: 250, platform: 'linux',
    subtreeReader: { read(pids: readonly number[], atMs: number): ProcSnapshot {
      const all = [...tl.read().procs.values()]; const keep = new Set<number>(pids);
      for (let grew = true; grew;) { grew = false; for (const e of all) if (!keep.has(e.pid) && keep.has(e.ppid)) { keep.add(e.pid); grew = true; } }
      const procs = new Map<string, ProcEntry>(); for (const e of all) if (keep.has(e.pid)) procs.set(e.startKey, e); return { atMs, procs };
    } },
    otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
    scanLight: () => new Map([...tl.current().procs.values()].map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
    readEntry: (pid) => [...tl.current().procs.values()].find((e) => e.pid === pid) ?? null,
    ...extra,
  });
  /** The scheduler starts a session harness beside the bound one; its first command, `delay` reads later, is read once. */
  async function sessionFirstCommand(delay: number, extra: Partial<ConstructorParameters<typeof ProcessLanePlugin>[0]> = {}): Promise<number> {
    nextPid = 10_000;
    const tl = new RawTimeline();
    const session = proc(53, [...HARNESS.argv], { pid: 950, startKey: '950:s' });
    const cmd = proc(950, WRAPPER, { pid: 951, startKey: '951:s' });
    for (let k = 0; k < 9; k++) tl.step([...BASE, HARNESS]);
    for (let k = 0; k < delay; k++) tl.step([...BASE, HARNESS, session]);
    tl.step([...BASE, HARNESS, session, cmd]);                                        // under 100 ms: one read
    for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS, session]);
    const plugin = fast(tl, home(), extra);
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    return plugin.drainPEs().length;
  }

  it('its first command seals once, however soon after the session harness appears (RED: with discovery every 2 s, one 1.5 s after it never does)', async () => {
    for (const d of [1, 2, 3, 4, 5, 6, 7]) expect(await sessionFirstCommand(d), `delay=${d * 250} ms`).toBe(1);
    const red: number[] = [];
    for (const d of [1, 2, 3, 4, 5, 6, 7]) red.push(await sessionFirstCommand(d, { discoveryMs: 2_000 }));
    expect(red.filter((n) => n === 0).length).toBeGreaterThan(0);
  });

  it('a session harness first read before it exec\'d (a fork of a same-named scheduler) is bound at its exec, and its first command seals once (RED: kept on the 60 s cached read, it never does)', async () => {
    for (const d of [2, 4, 6]) {
      nextPid = 10_000;
      const tl = new RawTimeline();
      const scheduler = proc(53, ['node', '/app/scheduler.js'], { pid: 400, startKey: '400:s' });
      const forked = proc(400, ['node', '/app/scheduler.js'], { pid: 950, startKey: '950:s' });
      const session: ProcEntry = { ...forked, argv: [...HARNESS.argv] };
      const cmd = proc(950, WRAPPER, { pid: 951, startKey: '951:s' });
      for (let k = 0; k < 9; k++) tl.step([...BASE, HARNESS, scheduler]);
      for (let k = 0; k < 2; k++) tl.step([...BASE, HARNESS, scheduler, forked]);    // not yet exec'd
      for (let k = 0; k < d; k++) tl.step([...BASE, HARNESS, scheduler, session]);
      tl.step([...BASE, HARNESS, scheduler, session, cmd]);
      for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS, scheduler, session]);
      const plugin = fast(tl, home());
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      expect(plugin.drainPEs(), `delay=${d * 250} ms`).toHaveLength(1);
    }
  });

  it('a record carries when its command ran: its start, held between the read before its first sighting and that sighting (RED: the read that found it ended)', async () => {
    // The command starts 100 ms after read 9, runs 2 s (8 reads) and is first read at read 10.
    const run = async (startedAtMs: ((p: ProcEntry) => number | null) | undefined): Promise<{ at: number; t0: number }> => {
      nextPid = 10_000;
      const tl = new RawTimeline();
      const cmd = proc(HARNESS.pid, WRAPPER, { pid: 951, startKey: '951:s' });
      for (let k = 0; k < 10; k++) tl.step([...BASE, HARNESS]);
      for (let k = 0; k < 8; k++) tl.step([...BASE, HARNESS, cmd]);
      for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS]);
      const t0 = Date.now();
      const plugin = fast(tl, home(), startedAtMs ? { startedAtMs } : {});
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      const pes = plugin.drainPEs();
      expect(pes).toHaveLength(1);
      return { at: pes[0].occurredAtMs ?? NaN, t0 };
    };
    const right = await run((p) => (p.startKey === '951:s' ? Date.now() - 150 : null));   // read 10 at t0 + 2500
    expect(right.at - right.t0).toBe(2_350);
    const early = await run((p) => (p.startKey === '951:s' ? Date.now() - 3_600_000 : null));   // a paused sandbox's clock
    expect(early.at - early.t0).toBe(2_250);                                          // the read before it
    const late = await run((p) => (p.startKey === '951:s' ? Date.now() + 3_600_000 : null));
    expect(late.at - late.t0).toBe(2_500);                                            // its first read
    const none = await run(() => null);
    expect(none.at - none.t0).toBe(2_500);
    expect(none.at - none.t0).toBeLessThan(2_500 + 8 * 250);                          // never its end (RED)
  });

  it('with the fast reader, beside a bound harness, a child first read in the very read its wrapper exec\'d into a session harness never mints (RED: one first read a read later does)', async () => {
    for (const later of [false, true]) {
      nextPid = 10_000;
      const tl = new RawTimeline();
      const W = proc(53, ['sh', '/start.sh'], { pid: 950, startKey: '950:s', comm: 'sh' });
      const L2: ProcEntry = { ...W, argv: [...HARNESS.argv], comm: 'node' };
      const X = proc(950, WRAPPER, { pid: 951, startKey: '951:s' });
      for (let k = 0; k < 9; k++) tl.step([...BASE, HARNESS]);
      for (let k = 0; k < 12; k++) tl.step([...BASE, HARNESS, W]);
      if (later) tl.step([...BASE, HARNESS, L2]);
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, L2, X]);
      for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS, L2]);
      const plugin = fast(tl, home());
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      expect(plugin.drainPEs(), `later=${later}`).toHaveLength(later ? 1 : 0);
    }
  });

  it('a harness bound only after it was reparented (it exec\'d long before) owns the children first read then (RED: taken for one that exec\'d in that read)', async () => {
    nextPid = 10_000;
    const tl = new RawTimeline();
    const Q = proc(53, ['node', '/app/harness/server.js', '--port', '7000'], { pid: 959, startKey: '959:s' });
    const P0 = proc(959, ['sh', '/x.sh'], { pid: 960, startKey: '960:s', comm: 'sh' });
    const P1: ProcEntry = { ...P0, argv: [...HARNESS.argv], comm: 'node' };
    const P2: ProcEntry = { ...P1, ppid: 53 };                                         // Q exits: reparented
    const X = proc(960, WRAPPER, { pid: 961, startKey: '961:s' });
    for (let k = 0; k < 9; k++) tl.step([...BASE, HARNESS, Q]);
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, Q, P0]);
    for (let k = 0; k < 8; k++) tl.step([...BASE, HARNESS, Q, P1]);                   // exec'd, nested: not a launcher
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, P2, X]);                   // bound the read it starts X
    for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS, P2]);
    const plugin = fast(tl, home());
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    expect(plugin.drainPEs()).toHaveLength(1);
  });

  it('on a full reader, a command taken back when discovery binds its harness carries its first read, not the bind (RED: the bind)', async () => {
    nextPid = 10_000;
    const tl = new ClockTimeline();
    const W = proc(53, ['sh', '/start.sh'], { pid: 950, startKey: '950:s', comm: 'sh' });
    const L2: ProcEntry = { ...W, argv: [...HARNESS.argv], comm: 'node' };
    const X = proc(950, WRAPPER, { pid: 951, startKey: '951:s' });
    for (let k = 0; k < 9; k++) tl.step([...BASE, HARNESS]);
    for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, W]);
    tl.step([...BASE, HARNESS, L2]);                                                  // read 13: exec'd
    for (let k = 0; k < 20; k++) tl.step([...BASE, HARNESS, L2, X]);                 // read 14: X; bound at read 16
    for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS, L2]);
    const h = home();
    const plugin = new ProcessLanePlugin({
      reader: tl, ledger: new FakeLedger(), identifyProgram: () => null, pollMs: 250, platform: 'darwin', subtreeReader: null,
      otherLaneActive: () => false, launcherFile: h.launcherFile, stateDir: h.dir, uid: 1000, isAlive: (k) => tl.current().procs.has(k),
      auditScan: () => tl.current(), startedAtMs: () => null,
    });
    tl.start();
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    const pes = plugin.drainPEs();
    expect(pes).toHaveLength(1);
    expect(pes[0].occurredAtMs).toBe(tl.snaps[14].atMs);                             // the full read's own clock
  });

  it('with the fast reader, beside a bound harness, a child the wrapper started before it exec\'d (a name-changing exec) never mints, though discovery read its command line only once (RED: one it starts after the exec does)', async () => {
    for (const afterExec of [false, true]) {
      nextPid = 10_000;
      const tl = new RawTimeline();
      const W = proc(53, ['sh', '/start.sh'], { pid: 950, startKey: '950:s', comm: 'sh' });
      const L2: ProcEntry = { ...W, argv: [...HARNESS.argv], comm: 'node' };
      const X = proc(950, WRAPPER, { pid: 951, startKey: '951:s' });
      for (let k = 0; k < 9; k++) tl.step([...BASE, HARNESS]);
      for (let k = 0; k < 6; k++) tl.step([...BASE, HARNESS, W]);                  // 1.5 s
      if (afterExec) {
        for (let k = 0; k < 6; k++) tl.step([...BASE, HARNESS, W]);
        for (let k = 0; k < 2; k++) tl.step([...BASE, HARNESS, L2]);
        for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, L2, X]);
      } else {
        for (let k = 0; k < 6; k++) tl.step([...BASE, HARNESS, W, X]);             // started by `sh`, 1.5 s
        for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, L2, X]);            // exec'd; X lives 1 s more
      }
      for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS, L2]);
      const plugin = fast(tl, home());
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      expect(plugin.drainPEs(), `afterExec=${afterExec}`).toHaveLength(afterExec ? 1 : 0);
    }
  });

  it('a session harness whose first command is first read in the harness\'s own first read seals it (RED: taken for one that exec\'d in that read)', async () => {
    nextPid = 10_000;
    const tl = new RawTimeline();
    const session = proc(53, [...HARNESS.argv], { pid: 950, startKey: '950:s' });
    const cmd = proc(950, WRAPPER, { pid: 951, startKey: '951:s' });
    for (let k = 0; k < 9; k++) tl.step([...BASE, HARNESS]);
    for (let k = 0; k < 3; k++) tl.step([...BASE, HARNESS, session, cmd]);
    for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS, session]);
    const plugin = fast(tl, home());
    await plugin.init(observer); await plugin.start();
    await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
    expect(plugin.drainPEs()).toHaveLength(1);
  });

  it('a command a restarted daemon adopts in flight carries when it ran, by the OS held to the daemon\'s clock (RED: the restart\'s read)', async () => {
    for (const skewMs of [0, -3_600_000]) {
      nextPid = 10_000;
      const ledger = new FakeLedger(); const h = home();
      const before = new RawTimeline();
      for (let k = 0; k < 8; k++) before.step([...BASE, HARNESS]);
      const p0 = fast(before, h, { ledger });
      await p0.init(observer); await p0.start();
      await vi.advanceTimersByTimeAsync(250 * (before.snaps.length - 1));
      await p0.stop();
      const tl = new RawTimeline();
      const root = proc(HARNESS.pid, WRAPPER, { pid: 951, startKey: '951:s' });
      const check = proc(HARNESS.pid, ['sleep', '1'], { pid: 960, startKey: '960:s' });
      const late = proc(HARNESS.pid, ['sleep', '2'], { pid: 970, startKey: '970:s' });
      const session = proc(53, [...HARNESS.argv], { pid: 980, startKey: '980:s' });   // 30 s old when first read
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, root]);
      for (let k = 0; k < 2; k++) tl.step([...BASE, HARNESS, root, check]);        // first read between two close reads
      for (let k = 0; k < 2; k++) tl.step([...BASE, HARNESS, root]);
      for (let k = 0; k < 3; k++) tl.step([...BASE, HARNESS, root, late]);         // first read after a 30 s pause: says little
      for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, root, session]);      // a session harness, bound: enters the read old
      for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS, session]);
      const ranAt = Date.now() - 480_000;                                           // 8 min before the restart
      const plugin = fast(tl, h, { ledger, startedAtMs: (p) => (p.startKey === '951:s' ? ranAt + skewMs : p.startKey === '960:s' ? Date.now() - 100 + skewMs : p.startKey === '970:s' ? Date.now() - 15_000 + skewMs : p.startKey === '980:s' ? Date.now() - 30_000 + skewMs : null) });
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * 7);
      vi.setSystemTime(Date.now() + 30_000);
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 8));
      const pes = plugin.drainPEs();
      expect(pes).toHaveLength(1);
      expect(Math.abs((pes[0].occurredAtMs ?? NaN) - ranAt), `skew=${skewMs}`).toBeLessThanOrEqual(250);
    }
  });

  it('with the fast reader, beside a bound harness, a long-lived process under the harness\'s name that execs into it keeping the name is found at once: a command its earlier program started never mints (RED: one the harness starts after does)', async () => {
    for (const afterExec of [false, true]) {
      nextPid = 10_000;
      const tl = new RawTimeline();
      const W = proc(53, ['node', '/app/worker.js'], { pid: 950, startKey: '950:s' });
      const L2: ProcEntry = { ...W, argv: [...HARNESS.argv] };
      const X = proc(950, WRAPPER, { pid: 951, startKey: '951:s' });
      for (let k = 0; k < 9; k++) tl.step([...BASE, HARNESS]);
      for (let k = 0; k < 60; k++) tl.step([...BASE, HARNESS, W]);                 // 15 s under the name `node`
      if (afterExec) {
        for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, L2]);
        for (let k = 0; k < 8; k++) tl.step([...BASE, HARNESS, L2, X]);
      } else {
        for (let k = 0; k < 4; k++) tl.step([...BASE, HARNESS, W, X]);             // started by the worker
        for (let k = 0; k < 280; k++) tl.step([...BASE, HARNESS, L2, X]);          // exec'd; X runs 70 s on
      }
      for (let k = 0; k < 40; k++) tl.step([...BASE, HARNESS, L2]);
      const plugin = fast(tl, home());
      await plugin.init(observer); await plugin.start();
      await vi.advanceTimersByTimeAsync(250 * (tl.snaps.length - 1));
      expect(plugin.drainPEs(), `afterExec=${afterExec}`).toHaveLength(afterExec ? 1 : 0);
    }
  });

  it('processStartedAtMs reads the OS start time from a start key', () => {
    expect(processStartedAtMs('951:Mon Oct 20 13:00:00 2026', 'darwin')).toBe(new Date(2026, 9, 20, 13, 0, 0).getTime());
    expect(processStartedAtMs('951:s', 'linux')).toBeNull();
    expect(processStartedAtMs('951', 'darwin')).toBeNull();
    expect(processStartedAtMs('951:5', 'win32')).toBeNull();
    if (process.platform === 'linux') expect(Math.abs((processStartedAtMs(`${process.pid}:${fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]}`, 'linux') ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(2_000);
  });

  it('discovery runs every read while a launcher is bound', () => {
    expect(DISCOVERY_BOUND_MS).toBeLessThanOrEqual(250);
  });
});
