import { describe, it, expect } from 'vitest';
import {
  buildSyntheticToolTrace,
  syntheticTraceEmitted,
  otelTraceIdsInLog,
  harnessEmissionFromLog,
  transcriptWatcherFromLog,
  transcriptEmissionFromLog,
  selectDoctorOutcome,
  parseDoctorArgs,
  installIntegrityCheck,
  materializedStoresFromLog,
  transcriptPEsRecordedFromLog,
  logLaneChecks,
  currentRunLog,
  lastStartedPidInLog,
  readRunLog,
  unwrittenMirrors,
  observerStartedMs,
  harnessEmittingCheck,
  finishDoctorReport,
  renderReportLines,
  type DoctorReport,
} from './doctor';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractScriptPaths } from '../observer/runtime-install';
import { parseOtlpTracePayload, classifySpanRole } from '../observer/plugins/OTelPlugin';

// The synthetic span the doctor sends must clear the observer's tool-orchestration
// floor. Prove it against the REAL parser/classifier, not a hand-asserted shape.
describe('buildSyntheticToolTrace', () => {
  const trace = buildSyntheticToolTrace('a'.repeat(32), 'r'.repeat(16), ['1'.repeat(16), '2'.repeat(16)], 1_700_000_000_000);

  it('parses into 3 spans (1 orchestration + 2 execute_tool) via the real parser', () => {
    const spans = parseOtlpTracePayload(trace);
    expect(spans).toHaveLength(3);
    const roles = spans.map((s) => classifySpanRole(s).role).sort();
    expect(roles).toEqual(['orchestration', 'tool', 'tool']);
  });

  it('the two tool spans classify as GenAI execute_tool with names', () => {
    const spans = parseOtlpTracePayload(trace);
    const tools = spans.map((s) => classifySpanRole(s)).filter((r) => r.role === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.convention === 'genai')).toBe(true);
    expect(tools.map((t) => t.toolName).sort()).toEqual(['provian_doctor_probe_1', 'provian_doctor_probe_2']);
  });
});

describe('log scanners', () => {
  const TID = 'deadbeef'.repeat(4);
  const emittedLine = `[observer info] otel doctor probe classified — never submitted {"trace_id":"${TID}","tool_calls":2,"verdict":"doctor_probe"}`;

  it('syntheticTraceEmitted matches the probe-classified line for our trace id', () => {
    expect(syntheticTraceEmitted(emittedLine, TID)).toBe(true);
  });
  // NEGATIVE CONTROLS: another trace id, and the pre- minting line (an older observer
  // that queued the probe as a PE) — doctor never reads a minted probe as a healthy pipeline.
  it('syntheticTraceEmitted is false for a different trace id, a below-threshold verdict, or the old minting line', () => {
    expect(syntheticTraceEmitted(emittedLine, 'f'.repeat(32))).toBe(false);
    const belowThreshold = `[observer info] otel trace not minted as tool orchestration {"trace_id":"${TID}","verdict":"below_orchestration_threshold"}`;
    expect(syntheticTraceEmitted(belowThreshold, TID)).toBe(false);
    expect(syntheticTraceEmitted(`[observer info] PE queued from OTel trace {"trace_id":"${TID}","tool_calls":2,"verdict":"emitted","action_type":"agent_tool_orchestration"}`, TID)).toBe(false);
    expect(syntheticTraceEmitted('', TID)).toBe(false);
  });

  it('otelTraceIdsInLog collects trace ids only from OTel lines', () => {
    const real = `[observer info] PE queued from OTel trace {"trace_id":"${'bb'.repeat(16)}","verdict":"emitted"}`;
    const log = [real, emittedLine, '[observer info] plugin PE submitted {"trace_id":"nototel"}'].join('\n');
    const ids = otelTraceIdsInLog(log);
    expect(ids.has('bb'.repeat(16))).toBe(true);
    expect(ids.has('nototel')).toBe(false); // not an OTel line
    // a doctor probe is never OTel work — a later doctor run cannot read an old probe as real.
    expect(ids.has(TID)).toBe(false);
    // …including an older observer's lines for a probe (the exact v37 shapes from the d495-bot cell).
    const OLD = '441ec891e7911a7900719db21c71feb9';
    const v37 = [
      `[observer info] PE queued from OTel trace {"trace_id":"${OLD}","tool_calls":2,"errored_tool_calls":0,"orchestration_span":"provian doctor synthetic turn","unclassified_spans":0,"flush_reason":"idle","action_type":"agent_tool_orchestration","verdict":"emitted"}`,
      `[observer info] otel trace not minted as API orchestration {"trace_id":"${OLD}","api_calls":0,"orchestration_span":"provian doctor synthetic turn","flush_reason":"idle","verdict":"no_independent_api_act"}`,
    ].join('\n');
    expect(otelTraceIdsInLog(v37).size).toBe(0);
    expect(harnessEmissionFromLog(v37, 'c'.repeat(32))).toBe('unknown');
  });
});

describe('harnessEmissionFromLog', () => {
  const SYNTH = 'aaaa'.repeat(8);
  it('green when a REAL (non-synthetic) OTel trace line is present', () => {
    const realOther = `[observer info] otel trace not minted as tool orchestration {"trace_id":"bbbbcccc","verdict":"below_orchestration_threshold"}`;
    expect(harnessEmissionFromLog(realOther, SYNTH)).toBe('green');
  });
  it('green when a real emitter produced a receiver parse error', () => {
    expect(harnessEmissionFromLog('[observer warn] otel receiver: parse error {"encoding":"protobuf"}', SYNTH)).toBe('green');
  });
  // NEGATIVE CONTROL: the Atlas case — the ONLY OTel activity is our own synthetic
  // trace → cannot confirm the harness emits → 'unknown', never a false green.
  it('unknown when the only OTel activity is our own synthetic trace', () => {
    const onlySynthetic = `[observer info] PE queued from OTel trace {"trace_id":"${SYNTH}","verdict":"emitted"}`;
    expect(harnessEmissionFromLog(onlySynthetic, SYNTH)).toBe('unknown');
  });
  it('unknown for an empty log', () => {
    expect(harnessEmissionFromLog('', SYNTH)).toBe('unknown');
  });
});

describe('transcriptWatcherFromLog', () => {
  it('parses the watcher-active line (LAST one wins — the current daemon run)', () => {
    const log = [
      '[observer info] transcript watcher active {"harnesses":["openclaw"],"generic_roots":0,"files":2}',
      '[observer info] transcript watcher active {"harnesses":["openclaw","claude-code"],"generic_roots":1,"files":7}',
    ].join('\n');
    expect(transcriptWatcherFromLog(log)).toEqual({
      active: true, harnesses: ['openclaw', 'claude-code'], files: 7, materialized: [],
    });
  });
  // NEGATIVE CONTROL: an empty/unrelated log is inactive, never a guessed green.
  it('no watcher line → inactive', () => {
    expect(transcriptWatcherFromLog('')).toEqual({ active: false, harnesses: [], files: 0, materialized: [] });
    expect(transcriptWatcherFromLog('[observer info] otel plugin active {}')).toEqual({ active: false, harnesses: [], files: 0, materialized: [] });
  });
});

describe('transcriptEmissionFromLog', () => {
  it('green on a flush verdict — emitted or not-minted (both prove parsed tool activity)', () => {
    expect(transcriptEmissionFromLog('[observer info] PE queued from transcript turn {"verdict":"emitted"}')).toBe('green');
    expect(transcriptEmissionFromLog('[observer info] transcript turn not minted {"verdict":"below_orchestration_threshold"}')).toBe('green');
  });
  // NEGATIVE CONTROL: watcher-active alone is NOT emission evidence (an idle
  // harness and a silent one are indistinguishable — say unknown, never guess).
  it('unknown when only the watcher-active line exists', () => {
    expect(transcriptEmissionFromLog('[observer info] transcript watcher active {"files":3}')).toBe('unknown');
    expect(transcriptEmissionFromLog('')).toBe('unknown');
  });
});

// the Grok Bot's agent-loop store is read whole by the materialized reader, which logs
// one line per read — never the tail's per-turn lines. Before this, doctor on a Grok Bot box
// that had minted turns said "no real tool activity … the watcher does not cover" (seen live on
// the d495-bot proof cell, release 36).
describe('transcript evidence on the materialized lane ', () => {
  const sub = (f: Record<string, unknown>): string => `[observer info] plugin PE submitted ${JSON.stringify(f)}`;
  const read = (f: string): string => `[observer info] materialized transcript store read {"harness":"grok-bot",${f}}`;

  it('a transcript PE the relay recorded as new is real activity', () => {
    const line = sub({ plugin: 'transcript', action_type: 'agent_tool_orchestration', pe_id: 'pe_1', idempotent_replay: false });
    expect(transcriptPEsRecordedFromLog(line)).toBe(1);
    expect(transcriptEmissionFromLog(line)).toBe('green');
  });

  // NEGATIVE CONTROLS (review r1–r3): history is never activity. A restart or a copy re-reads
  // the store and produces no PE; a re-send after lost state is replayed by the relay; a line
  // from an older daemon cannot say which it was; store-read counts (the exact v36 line from
  // the d495-bot cell among them) are never evidence; other plugins are not this lane.
  it('unknown for replays, older lines, store-read counts, and other plugins', () => {
    const V36 = read('"conversations":2,"subagent_transcripts":1,"unlinked_subagents":0,"turns_emitted":1,"turns_seeded_pre_registration":2,"turns_held_undated":0,"turns_held_until_registration_known":0,"turns_held_open":2,"link_spends_emitted":0,"link_spends_held_non_terminal":0');
    const cases = [
      sub({ plugin: 'transcript', action_type: 'agent_tool_orchestration', pe_id: 'pe_1', idempotent_replay: true }),
      sub({ plugin: 'transcript', action_type: 'agent_tool_orchestration', pe_id: 'pe_1' }),
      sub({ plugin: 'git', action_type: 'coding_session', pe_id: 'pe_2', idempotent_replay: false }),
      V36,
      read('"conversations":3,"tool_calls_recognized":40,"tool_calls_new":4,"turns_emitted_live":2'),
      '[observer info] plugin PE submitted {"plugin":"transcript",',
    ];
    for (const c of cases) expect(transcriptEmissionFromLog(c)).toBe('unknown');
    expect(transcriptPEsRecordedFromLog(cases.join('\n'))).toBe(0);
  });

  it('the store-read line names what is watched (last read wins)', () => {
    expect(materializedStoresFromLog([read('"conversations":2'), read('"conversations":3')].join('\n')))
      .toEqual([{ harness: 'grok-bot', conversations: 3 }]);
    expect(materializedStoresFromLog(read('"conversations":-1'))).toEqual([{ harness: 'grok-bot', conversations: 0 }]);
    expect(materializedStoresFromLog('[observer info] materialized transcript store read {"conversations":2}')).toEqual([]);
  });
});

describe('logLaneChecks — the log describes the last run ', () => {
  const TAIL = [
    '[observer info] transcript watcher active {"harnesses":[],"generic_roots":0,"sources":0,"file_sources":0,"store_sources":0}',
    '[observer info] model proxy listening on http://127.0.0.1:4320 {"hint":"…"}',
    '[observer info] materialized transcript store read {"harness":"grok-bot","conversations":3,"turns_emitted":0}',
  ].join('\n');
  const byName = (cs: ReturnType<typeof logLaneChecks>, n: string) => cs.find((c) => c.name === n);

  it('running: the watcher names the materialized store; the proxy is listening', () => {
    const cs = logLaneChecks(TAIL, true);
    expect(byName(cs, 'transcript_watcher')).toMatchObject({ status: 'green' });
    expect(byName(cs, 'transcript_watcher')?.detail).toContain('the grok-bot store (3 conversation(s))');
    expect(byName(cs, 'model_proxy')).toMatchObject({ status: 'green' });
    expect(byName(cs, 'model_proxy')?.detail).toContain('listening on');
  });

  // RED CONTROL: with the observer down, the same log must not read as live.
  it('observer down: nothing is claimed as watching or listening now', () => {
    const cs = logLaneChecks(TAIL, false);
    expect(byName(cs, 'transcript_watcher')?.status).toBe('red');
    expect(byName(cs, 'transcript_watcher')?.detail).toMatch(/^not running now \(the observer is down\); its last run: watching/);
    expect(byName(cs, 'model_proxy')?.status).toBe('skip');
    expect(byName(cs, 'model_proxy')?.detail).not.toContain('listening on');
  });

  it('the Atlas zero-sources RED is unchanged', () => {
    const cs = logLaneChecks('[observer info] transcript watcher active {"harnesses":["openclaw"],"sources":0}', true);
    expect(byName(cs, 'transcript_watcher')?.status).toBe('red');
    expect(byName(cs, 'transcript_watcher')?.detail).toContain('ZERO readable sources');
  });
});

describe('whose log is it — the Grok bot\'s stale observer.log (follow-up)', () => {
  // Shape of the operator’s bot log: the v35 daemon's run, ended by SIGTERM; the live daemon
  // (pid 1839490) was started from a shell and wrote nothing here.
  // The daemon's REAL order (review r1 #1): the lanes log inside observer.start(), BEFORE `started`.
  const STALE = [
    '[observer info] starting observer {"tick_ms":1000}',
    '[observer info] transcript watcher active {"harnesses":["grok"],"generic_roots":0,"sources":1,"file_sources":1,"store_sources":0}',
    '[observer info] model proxy listening on http://127.0.0.1:4320 {"hint":"…"}',
    '[observer] started (pid 1655284)',
    '[observer] received SIGTERM, shutting down',
    '[observer] observer stopped',
  ].join('\n');
  const byName = (cs: ReturnType<typeof logLaneChecks>, n: string) => cs.find((c) => c.name === n);

  it('the running pid has no start line: the log is some earlier run, and the lane checks say so (never "down", never green)', () => {
    expect(currentRunLog(STALE, 1839490)).toBeNull();
    expect(lastStartedPidInLog(STALE)).toBe(1655284);
    const cs = logLaneChecks(STALE, true, false);
    expect(byName(cs, 'transcript_watcher')?.status).toBe('red');
    expect(byName(cs, 'transcript_watcher')?.detail).toMatch(/^unknown — the running observer is not writing the log/);
    expect(byName(cs, 'transcript_watcher')?.detail).not.toContain('observer is down');
    expect(byName(cs, 'model_proxy')?.status).toBe('skip');
  });

  it('RED control: once the running daemon writes the log, its OWN run is read — the materialized store from its watcher line, the earlier run ignored', () => {
    const live = [
      STALE,
      '[observer] starting (pid 1839490)',
      '[observer info] starting observer {"tick_ms":1000}',
      '[observer info] transcript watcher active {"harnesses":["grok","grok-bot"],"generic_roots":0,"sources":4,"file_sources":1,"store_sources":0,"materialized_stores":[{"harness":"grok-bot","conversations":3}],"catalog_version":0}',
      '[observer info] model proxy listening on http://127.0.0.1:4320 {"hint":"…"}',
      '[observer] started (pid 1839490)',
    ].join('\n');
    const run = currentRunLog(live, 1839490);
    expect(run).not.toBeNull();
    expect(run).not.toContain('1655284');
    const w = transcriptWatcherFromLog(run!);
    expect(w.materialized).toEqual([{ harness: 'grok-bot', conversations: 3 }]);
    const cs = logLaneChecks(run!, true, true);
    expect(byName(cs, 'transcript_watcher')?.status).toBe('green');
    expect(byName(cs, 'transcript_watcher')?.detail).toContain('the grok-bot store (3 conversation(s))');
  });
});

describe('review r1: the run log in the daemon\'s real order, however far back it starts', () => {
  const byName = (cs: ReturnType<typeof logLaneChecks>, n: string) => cs.find((c) => c.name === n);
  it('a pre-release-40 daemon (only `started`, AFTER its lanes): the run begins at its `starting observer` line — both lanes green', () => {
    const tail = [
      '[observer] observer stopped',
      '[observer info] starting observer {"tick_ms":1000}',
      '[observer info] transcript watcher active {"harnesses":["openclaw"],"sources":2}',
      '[observer info] model proxy listening on http://127.0.0.1:4320 {"hint":"…"}',
      '[observer] started (pid 74180)',
    ].join('\n');
    const run = currentRunLog(tail, 74180)!;
    expect(run.startsWith('[observer info] starting observer')).toBe(true);
    const cs = logLaneChecks(run, true, true);
    expect(byName(cs, 'transcript_watcher')?.status).toBe('green');
    expect(byName(cs, 'model_proxy')?.status).toBe('green');
    // RED control: slicing at the `started` marker (the defect) loses both lines.
    const wrong = tail.slice(tail.lastIndexOf('[observer] started (pid 74180)'));
    expect(byName(logLaneChecks(wrong, true, true), 'transcript_watcher')?.status).toBe('red');
  });

  it('a start marker scrolled out of the 512 KB tail is still found (readRunLog scans back)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
    try {
      const log = path.join(dir, 'observer.log');
      const filler = '[observer debug] tick {"n":0}\n'.repeat(40_000); // ~1.2 MB after the start
      fs.writeFileSync(log, [
        '[observer] starting (pid 4242)',
        '[observer info] transcript watcher active {"harnesses":["grok-bot"],"sources":3,"materialized_stores":[{"harness":"grok-bot","conversations":3}]}',
        '[observer info] model proxy listening on http://127.0.0.1:4320 {"hint":"…"}',
        '[observer] started (pid 4242)',
      ].join('\n') + '\n' + filler);
      expect(fs.statSync(log).size).toBeGreaterThan(1024 * 1024);
      const run = readRunLog(log, 4242);
      expect(run).not.toBeNull();
      expect(transcriptWatcherFromLog(run!).materialized).toEqual([{ harness: 'grok-bot', conversations: 3 }]);
      expect(readRunLog(log, 999)).toBeNull(); // RED control: another pid has no run here
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('selectDoctorOutcome', () => {
  const ok = {
    hasCreds: true, observerRunning: true, receiverReachable: true,
    provianSide: 'green' as const, harnessEmitting: 'green' as const,
    transcriptEmitting: 'unknown' as const, detectedHarness: 'langchain',
  };

  it('GREEN when creds + receiver + pipeline pass and OTel emission is observed', () => {
    expect(selectDoctorOutcome(ok).status).toBe('green');
    expect(selectDoctorOutcome(ok).next_step).toBeNull();
  });

  // The pull path alone satisfies the harness side — the whole point of the watcher.
  it('GREEN when only TRANSCRIPT emission is observed (no OTel at all)', () => {
    const r = selectDoctorOutcome({ ...ok, harnessEmitting: 'unknown', transcriptEmitting: 'green' });
    expect(r.status).toBe('green');
    expect(r.next_step).toBeNull();
  });

  // Each failing precondition → RED with the precise, actionable next step:
  it('no creds → register-device', () => {
    const r = selectDoctorOutcome({ ...ok, hasCreds: false });
    expect(r.status).toBe('red');
    expect(r.next_command).toContain('register-device');
  });
  it('receiver unreachable, observer down → start the observer', () => {
    const r = selectDoctorOutcome({ ...ok, receiverReachable: false, observerRunning: false });
    expect(r.status).toBe('red');
    expect(r.next_step).toContain('Start the observer');
  });
  it('receiver unreachable but observer RUNNING → names the port conflict, not a false "start it"', () => {
    const r = selectDoctorOutcome({ ...ok, receiverReachable: false, observerRunning: true });
    expect(r.status).toBe('red');
    expect(r.next_step).toContain('another collector');
  });
  it('provian pipeline red → check observer/log', () => {
    const r = selectDoctorOutcome({ ...ok, provianSide: 'red' });
    expect(r.status).toBe('red');
    expect(r.next_step).toMatch(/no PE|observer\.log/);
  });
  // The signature Atlas failure: pipeline works, NEITHER path shows real capture.
  it('pipeline green but neither path emitting → RED with run-a-turn + --description', () => {
    const r = selectDoctorOutcome({ ...ok, harnessEmitting: 'unknown', transcriptEmitting: 'unknown' });
    expect(r.status).toBe('red');
    expect(r.next_step).toContain('pipeline works');
    expect(r.next_step).toContain('--description');
    expect(r.next_command).toContain('start');
  });
});

describe('parseDoctorArgs', () => {
  it('detects --json and --help', () => {
    expect(parseDoctorArgs(['--json'])).toEqual({ json: true, help: false });
    expect(parseDoctorArgs(['-h'])).toEqual({ json: false, help: true });
    expect(parseDoctorArgs([])).toEqual({ json: false, help: false });
  });
});

// ---------------------------------------------------------------------------
// install_integrity — the check nothing performed on the Mac mini
// ---------------------------------------------------------------------------

describe('installIntegrityCheck', () => {
  const PLIST = [
    '<array>',
    '  <string>/opt/homebrew/bin/node</string>',
    '  <string>/Users/a/Projects/checkout/provian-agent-sdk/dist/scripts/start-observer.js</string>',
    '</array>',
  ].join('\n');
  const HOOK = 'node "/Users/a/Projects/checkout/provian-agent-sdk/dist/scripts/report-pe.js" --type coding_session';

  it('THE ATLAS STATE — baked paths that no longer exist are RED and say why', () => {
    const check = installIntegrityCheck(
      (p) => (p.endsWith('.plist') ? PLIST : p.endsWith('post-commit') ? HOOK : null),
      { exists: () => false, isDir: () => false, realpath: (p) => p },
    );
    expect(check.status).toBe('red');
    expect(check.detail).toMatch(/NO LONGER EXIST/);
    expect(check.detail).toMatch(/cannot restart/);
  });

  it('NEGATIVE CONTROL — when the same paths DO resolve, the check is green', () => {
    const check = installIntegrityCheck(
      (p) => (p.endsWith('.plist') ? PLIST : p.endsWith('post-commit') ? HOOK : null),
      { exists: () => true, isDir: () => false, realpath: (p) => p },
    );
    expect(check.status).toBe('green');
    expect(check.detail).not.toMatch(/NO LONGER EXIST/);
  });

  it('NEGATIVE CONTROL — a machine with no service and no hook is SKIP, not a false green', () => {
    const check = installIntegrityCheck(
      () => null,
      { exists: () => true, isDir: () => false, realpath: (p) => p },
    );
    // An empty population must be its own status, never a pass.
    expect(check.status).toBe('skip');
  });

  it('extracts every script path a plist or hook names, and nothing else', () => {
    expect(extractScriptPaths(PLIST)).toEqual([
      '/Users/a/Projects/checkout/provian-agent-sdk/dist/scripts/start-observer.js',
    ]);
    expect(extractScriptPaths(HOOK)).toEqual([
      '/Users/a/Projects/checkout/provian-agent-sdk/dist/scripts/report-pe.js',
    ]);
    // The node binary is not a script path and must not be probed as one.
    expect(extractScriptPaths(PLIST)).not.toContain('/opt/homebrew/bin/node');
  });
});
