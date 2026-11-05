/**
 * ProcessLanePlugin + snapshot parsers.
 *
 * Proves the plugin maps a sealed command act to a parity-priced
 * `agent_tool_orchestration` PE on the `process` daemon lane, advances its
 * durable ledger only on a committed outcome (retrying a transient failure under
 * the same key), and that the OS parsers read real `/proc` and `ps` shapes.
 * Each claim carries its RED control.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProcessLanePlugin, FileActLedger, processLaneLedgerPath } from './ProcessLanePlugin';
import { parseLinuxStat, parseMacPs, type ProcSnapshot, type ProcEntry, type SnapshotReader } from './snapshot';
import type { ActLedger } from './acts';
import { launcherFingerprint, LAUNCHER_RECORD_SCHEMA, templateOf, writeLauncherRecord } from './launcher';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const OBSERVER_PID = process.pid;
const RUNTIME_PID = 424242;

function proc(pid: number, ppid: number, argv: string[], extra: Partial<ProcEntry> = {}): ProcEntry {
  return { pid, ppid, startKey: `${pid}:s`, argv, bytesWritten: 0, comm: argv[0] ? path.basename(argv[0]) : '', ...extra };
}
const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

/** A temp home with a launcher record naming `launcher` (parent named `parentComm`) and `template`. */
function recordHome(launcher: ProcEntry, parentComm: string, template: string[]): { dir: string; launcherFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-rec-'));
  const launcherFile = path.join(dir, 'process-launcher.json');
  writeLauncherRecord({
    schema: LAUNCHER_RECORD_SCHEMA,
    fingerprint: launcherFingerprint({ pid: launcher.pid, ppid: launcher.ppid, comm: launcher.comm ?? '', argv: launcher.argv }, null),
    mode: template.length > 0 ? 'template' : 'direct', template, recorded_at_ms: 1, source: 'install',
  }, launcherFile);
  return { dir, launcherFile };
}

/** Discovery from a fixed table (never consumes the scripted reader). */
function scanFrom(entries: ProcEntry[], comms: Record<number, string>) {
  return {
    scanLight: () => new Map(entries.map((e) => [e.pid, { startKey: e.startKey, ppid: e.ppid, comm: comms[e.pid] ?? e.comm ?? '' }])),
    readEntry: (pid: number) => entries.find((e) => e.pid === pid) ?? null,
  };
}
function snap(atMs: number, entries: ProcEntry[]): ProcSnapshot {
  const procs = new Map<string, ProcEntry>();
  for (const e of entries) procs.set(e.startKey, e);
  return { atMs, procs };
}

/** A scripted reader: returns each snapshot in turn, repeating the last. */
class ScriptedReader implements SnapshotReader {
  private i = 0;
  constructor(private readonly snaps: ProcSnapshot[]) {}
  read(): ProcSnapshot { const s = this.snaps[Math.min(this.i, this.snaps.length - 1)]; this.i += 1; return s; }
}

class FakeLedger implements ActLedger {
  readonly minted = new Set<string>();
  readonly serviced = new Set<string>();
  hasMinted(k: string): boolean { return this.minted.has(k); }
  recordMinted(k: string): void { this.minted.add(k); }
  isServiced(i: string): boolean { return this.serviced.has(i); }
  recordServiced(i: string): void { this.serviced.add(i); }
}

function fakeObserver() {
  return {
    getDeviceId: () => 'dev-xyz',
    observerDeviceWitness: () => null,
    log: () => { /* silent */ },
  } as unknown as import('../../ProvianObserver').ProvianObserver;
}

const BASE = [proc(OBSERVER_PID, 1, ['node', 'observer']), proc(RUNTIME_PID, 1, ['agent-runtime'])];

describe('ProcessLanePlugin — sealed command → one parity PE', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function run(): Promise<{ plugin: ProcessLanePlugin; ledger: FakeLedger }> {
    const cmd = proc(500, RUNTIME_PID, ['sh', '-c', 'exec 3<>/run/cmd; cat <&3 | sh']);   // the fixed wrapper
    const fetch = proc(501, 500, ['curl', 'https://api.example.com']);                   // what the command ran
    const reader = new ScriptedReader([
      snap(1000, BASE),                       // start() baseline
      snap(1250, [...BASE, cmd, fetch]),      // command starts
      snap(1500, BASE),                       // command exits → completedAt = 1500
      snap(1500 + 21_000, BASE),              // snapshot clock past the 20 s seal grace → seal
    ]);
    const ledger = new FakeLedger();
    const home = recordHome(BASE[1], 'init', templateOf(cmd.argv));
    const plugin = new ProcessLanePlugin({
      reader, ledger, identifyProgram: () => null, pollMs: 250, subtreeReader: null, platform: 'linux',
      otherLaneActive: () => false, launcherFile: home.launcherFile, stateDir: home.dir, uid: null,
      ...scanFrom([...BASE, proc(1, 0, ['init'])], { 1: 'init' }),
    });
    await plugin.init(fakeObserver());
    await plugin.start();                       // baseline poll
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(250); // three more polls
    return { plugin, ledger };
  }

  it('drains one agent_tool_orchestration PE on the process lane, tool_count 1, with the captured origin', async () => {
    const { plugin } = await run();
    const pes = plugin.drainPEs();
    expect(pes).toHaveLength(1);
    const pe = pes[0];
    expect(pe.actionType).toBe('agent_tool_orchestration');
    expect(pe.metadata).toMatchObject({ source: 'process', tool: 'provian:process', capture_lane: 'process', tool_count: 1 });
    expect(String(pe.metadata!.turn_id).startsWith('pl:')).toBe(true);
    expect(pe.idempotencyKey).toBe(pe.metadata!.turn_id);
    expect(pe.skipDedupClaim).toBe(true);
    expect(pe.identityDecided).toBe(true);
    expect((pe.input_origins ?? []).some((o) => o.origin_identifier === 'domain:api.example.com')).toBe(true);
  });

  it('advances the ledger only on a committed outcome; a transient failure is retried under the same key', async () => {
    const { plugin, ledger } = await run();
    const [pe] = plugin.drainPEs();
    expect(ledger.minted.size).toBe(0);              // nothing recorded before the relay answers

    plugin.onCommitted(pe, 'failed');                 // transient failure → not recorded, re-queued
    expect(ledger.minted.size).toBe(0);
    const retry = plugin.drainPEs();
    expect(retry).toHaveLength(1);
    expect(retry[0].idempotencyKey).toBe(pe.idempotencyKey); // SAME key (relay dedups the resend)

    plugin.onCommitted(retry[0], 'submitted');        // accepted → recorded, lane proof flips
    expect(ledger.minted.size).toBe(1);
    expect(plugin.actsEverSealed()).toBe(true);
    expect(plugin.drainPEs()).toHaveLength(0);
  });

  it('RED: a rejected PE is NOT retried and NOT recorded (a content judgement is terminal)', async () => {
    const { plugin, ledger } = await run();
    const [pe] = plugin.drainPEs();
    plugin.onCommitted(pe, 'rejected');
    expect(ledger.minted.size).toBe(0);
    expect(plugin.drainPEs()).toHaveLength(0);        // never re-queued
  });
});

describe('snapshot parsers read real OS shapes', () => {
  it('parseLinuxStat pulls ppid and start-ticks past a comm with spaces and parens', () => {
    // field2 comm is "(se)rvice (x)" with spaces/parens; ppid=field4, starttime=field22.
    const fields = ['9', '(se)rvice (x)', 'S', '200', ...Array.from({ length: 17 }, (_, i) => String(i)), '889900', 'z'];
    const parsed = parseLinuxStat(fields.join(' '));
    expect(parsed).toEqual({ ppid: 200, startTicks: '889900' });
  });

  it('RED: parseLinuxStat returns null on a truncated/garbled line (never a guessed row)', () => {
    expect(parseLinuxStat('9 (short)')).toBeNull();
    expect(parseLinuxStat('no paren here')).toBeNull();
  });

  it('parseMacPs reads pid/ppid/uid past a 5-token lstart into the command', () => {
    const text = '500 200 501 Mon Oct 20 13:00:00 2026 /bin/sh -c echo hi\n';
    const s = parseMacPs(text, 9000);
    const e = [...s.procs.values()][0];
    expect(e.pid).toBe(500);
    expect(e.ppid).toBe(200);
    expect(e.uid).toBe(501);
    expect(e.argv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
  });
});

describe('FileActLedger — durable mint-once across restarts ', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ledger-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('a minted key survives a reload (the daemon\'s own record, back after a VM replacement)', () => {
    const file = path.join(dir, 'ledger.json');
    const a = new FileActLedger(file);
    a.recordMinted('key-1');
    a.recordServiced('svc-1');
    const b = new FileActLedger(file);                // a fresh process reads the same home-dir file
    expect(b.hasMinted('key-1')).toBe(true);
    expect(b.isServiced('svc-1')).toBe(true);
    expect(b.hasMinted('key-2')).toBe(false);          // RED control: an unrelated key is not minted
  });

  it('processLaneLedgerPath lives under ~/.provian', () => {
    expect(processLaneLedgerPath('/home/x')).toBe('/home/x/.provian/process-lane-ledger.json');
  });
});
