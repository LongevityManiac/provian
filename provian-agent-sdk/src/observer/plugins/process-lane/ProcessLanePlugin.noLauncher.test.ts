/**
 * follow-up : an agent device with the process lane on and no launcher record
 * (`~/.provian/process-launcher.json` absent) witnesses none of the agent's commands. Capture health
 * says so, names the fix, and the lane leaves the agent its instruction in witness-action-required.json.
 *
 * Proves, each beside its RED control:
 * - a device with no launcher record reports `process_no_launcher` (doctor's line, the health report
 * the daemon sends, and the instruction file);
 * - a device with a launcher record does not;
 * - a session-file agent (another lane witnesses it: Atlas) does not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProcessLanePlugin, PROCESS_LANE_NO_LAUNCHER_INSTRUCTION } from './ProcessLanePlugin';
import type { ProcSnapshot, ProcEntry, SnapshotReader } from './snapshot';
import type { ActLedger } from './acts';
import { launcherFingerprint, LAUNCHER_RECORD_SCHEMA, readLauncherRecord, templateOf, writeLauncherRecord } from './launcher';
import { logLaneChecks } from '../../../scripts/doctor';
import {
  buildCaptureHealthReport, captureBrokenReason, describeCaptureHealth, PROCESS_LANE_RECORD_COMMAND,
} from '../../capture-health';

const RUNTIME_PID = 424242;
const proc = (pid: number, ppid: number, argv: string[]): ProcEntry =>
  ({ pid, ppid, startKey: `${pid}:s`, argv, bytesWritten: 0, comm: path.basename(argv[0] ?? '') });
const BASE = [proc(process.pid, 1, ['node', 'observer']), proc(RUNTIME_PID, 1, ['agent-runtime'])];
const TABLE = [...BASE, proc(1, 0, ['init'])];
const reader: SnapshotReader = { read: (): ProcSnapshot => ({ atMs: Date.now(), procs: new Map(BASE.map((e) => [e.startKey, e])) }) };
const ledger: ActLedger = { hasMinted: () => false, recordMinted: () => {}, isServiced: () => false, recordServiced: () => {} };
const observer = {
  getDeviceId: () => 'dev-xyz', observerDeviceWitness: () => null, log: () => { /* silent */ },
} as unknown as import('../../ProvianObserver').ProvianObserver;

let dir: string;
beforeEach(() => { vi.useFakeTimers(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-nolauncher-')); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

const launcherFile = (): string => path.join(dir, 'process-launcher.json');
const actionFile = (): string => path.join(dir, 'witness-action-required.json');
const readAction = (): { lane?: string; state?: string; instruction?: string } | null => {
  try { return JSON.parse(fs.readFileSync(actionFile(), 'utf8')); } catch { return null; }
};
function recordLauncher(): void {
  writeLauncherRecord({
    schema: LAUNCHER_RECORD_SCHEMA,
    fingerprint: launcherFingerprint({ pid: RUNTIME_PID, ppid: 1, comm: 'agent-runtime', argv: ['agent-runtime'] }, null),
    mode: 'template', template: templateOf(['sh', '-c', 'exec 3<>/run/cmd; cat <&3 | sh']), recorded_at_ms: 1, source: 'record',
  }, launcherFile());
  // Not vacuous: the lane reads this record as a current, valid one.
  expect(readLauncherRecord(launcherFile())).not.toBeNull();
}

async function startLane(otherLaneActive: boolean): Promise<ProcessLanePlugin> {
  const plugin = new ProcessLanePlugin({
    reader, ledger, identifyProgram: () => null, pollMs: 250, subtreeReader: null, platform: 'linux',
    otherLaneActive: () => otherLaneActive, launcherFile: launcherFile(), stateDir: dir, uid: null,
    scanLight: () => new Map(TABLE.map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: e.comm ?? '' }])),
    readEntry: (pid: number) => TABLE.find((e) => e.pid === pid) ?? null,
  });
  await plugin.init(observer);
  await plugin.start();
  return plugin;
}

/** The health report the daemon sends, built from the lane exactly as run-daemon builds it. */
function health(plugin: ProcessLanePlugin, extra: Partial<Parameters<typeof buildCaptureHealthReport>[0]> = {}) {
  return buildCaptureHealthReport({
    harnesses: [], cursorTotal: 0, lastVerdictAtMs: null, lastVerdict: 'unknown', lastCaptureAtMs: null,
    sqliteReadable: true, nowMs: Date.now(),
    process: {
      active: plugin.isActive(), watching: plugin.isWatching(), actsEverSealed: plugin.actsEverSealed(),
      lastActAtMs: plugin.getLastActAtMs(), state: plugin.getState(), window: plugin.takeCaptureWindow(),
    },
    ...extra,
  });
}

describe('process lane with no launcher record (follow-up)', () => {
  it('a device with no launcher record reports process_no_launcher and names the fix', async () => {
    const plugin = await startLane(false);
    expect(plugin.getState()).toBe('no_launcher');
    const report = health(plugin);
    expect(report.process_lane_state).toBe('no_launcher');
    expect(captureBrokenReason(report)).toBe('process_no_launcher');
    expect(describeCaptureHealth(report)).toContain(PROCESS_LANE_RECORD_COMMAND);
    expect(PROCESS_LANE_RECORD_COMMAND).toBe('"$HOME/.provian/bin/provian" process-lane record');
    // The agent's standing instruction reads this file and acts on it.
    expect(readAction()).toEqual({ lane: 'process', state: 'no_launcher', instruction: PROCESS_LANE_NO_LAUNCHER_INSTRUCTION });
    expect(PROCESS_LANE_NO_LAUNCHER_INSTRUCTION).toContain(PROCESS_LANE_RECORD_COMMAND);
    await plugin.stop();
  });

  it('RED: a device with a launcher record does not', async () => {
    recordLauncher();
    const plugin = await startLane(false);
    expect(plugin.getState()).toBe('active');
    expect(captureBrokenReason(health(plugin))).toBeNull();
    expect(readAction()).toBeNull();
    await plugin.stop();
  });

  it('recording a launcher clears the flag and removes the instruction it left', async () => {
    const plugin = await startLane(false);
    expect(readAction()?.state).toBe('no_launcher');
    recordLauncher();
    await vi.advanceTimersByTimeAsync(1_500);       // the record is re-read within a second
    expect(plugin.getState()).toBe('active');
    expect(captureBrokenReason(health(plugin))).toBeNull();
    expect(readAction()).toBeNull();
    await plugin.stop();
  });

  it('RED: a session-file agent does not (Atlas: the lane is inert, no instruction, no flag)', async () => {
    const plugin = await startLane(true);
    expect(plugin.getState()).toBe('inert_other_lane');
    expect(captureBrokenReason(health(plugin))).toBeNull();
    expect(readAction()).toBeNull();
    await plugin.stop();
  });

  it('RED: producing session files, OTel or the proxy overrule a lane that says no_launcher', async () => {
    const plugin = await startLane(false);
    expect(captureBrokenReason(health(plugin, {
      harnesses: [{ harness: 'openclaw', version: null, sources: 2, containers: ['file'] }],
    }))).toBeNull();
    expect(captureBrokenReason(health(plugin, {
      otel: { active: true, receiverListening: true, spansEverSeen: true, lastSpanAtMs: 1 },
    }))).toBeNull();
    expect(captureBrokenReason(health(plugin, {
      proxy: { active: true, listening: true, turnsEverSeen: true, lastTurnAtMs: 1, unrecognized: [] },
    }))).toBeNull();
    await plugin.stop();
  });

  it('RED: a lane that is not running never flags (a human device has no lane)', () => {
    const report = buildCaptureHealthReport({
      harnesses: [], cursorTotal: 0, lastVerdictAtMs: null, lastVerdict: 'unknown', lastCaptureAtMs: null,
      sqliteReadable: true, nowMs: 1,
    });
    expect(captureBrokenReason(report)).toBeNull();
  });
});

describe('doctor names the state and its fix (follow-up)', () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-doctor-'));
    fs.mkdirSync(path.join(home, '.provian'));
    process.env.HOME = home;
  });
  afterEach(() => { process.env.HOME = prevHome; fs.rmSync(home, { recursive: true, force: true }); });
  const writeState = (state: string): void =>
    fs.writeFileSync(path.join(home, '.provian', 'process-lane-state.json'), JSON.stringify({ state, at_ms: 1 }));
  const laneCheck = () => logLaneChecks('', true, true).find((c) => c.name === 'process_lane')!;

  it('no launcher record → red, naming "$HOME/.provian/bin/provian" process-lane record', () => {
    expect(os.homedir()).toBe(home);
    writeState('no_launcher');
    const c = laneCheck();
    expect(c.status).toBe('red');
    expect(c.detail).toContain(PROCESS_LANE_RECORD_COMMAND);
    expect(c.detail).toContain('own session');
  });

  it('RED: a launcher record on disk (doctor just wrote one) is not flagged', () => {
    writeState('no_launcher');
    writeLauncherRecord({
      schema: LAUNCHER_RECORD_SCHEMA,
      fingerprint: launcherFingerprint({ pid: RUNTIME_PID, ppid: 1, comm: 'agent-runtime', argv: ['agent-runtime'] }, null),
      mode: 'template', template: templateOf(['sh', '-c', 'exec 3<>/run/cmd; cat <&3 | sh']), recorded_at_ms: 1, source: 'doctor',
    }, path.join(home, '.provian', 'process-launcher.json'));
    expect(laneCheck().status).not.toBe('red');
  });

  it('RED: a session-file agent (inert lane) is not flagged', () => {
    writeState('inert_other_lane');
    expect(laneCheck().status).not.toBe('red');
  });
});
