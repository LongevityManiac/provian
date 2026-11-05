#!/usr/bin/env node
import { currentProcessLaneState } from './process-lane';
import { processLauncherPath, readLauncherRecord } from '../observer/plugins/process-lane/launcher';
import { PROCESS_LANE_RECORD_COMMAND } from '../observer/capture-health';
import { guardedFetcher } from '../guarded-fetch';
/**
 * doctor — the self-verifying, anti-silent-failure check (`npx @provian/agent-sdk doctor` from the
 * npm package; `"$HOME/.provian/bin/provian" doctor` on the hosted curl|sh install,).
 *
 * The failure this productizes: an agent device where the observer's OTLP
 * receiver is up, the endpoint env is set, and yet ZERO tool-orchestration PEs
 * are produced — because the harness itself never EMITS OpenTelemetry (the Atlas
 * / OpenClaw case). Nobody noticed for days. `doctor` converts that
 * silent-nothing into a definitive, actionable readout.
 *
 * It does the manual isolation dance we did by hand, once, as a command:
 * 1. creds + observer + receiver are up;
 * 2. POST a synthetic 2×execute_tool OTLP/HTTP span to the local receiver and
 * confirm a PE is produced → proves the PROVIAN side end-to-end (GREEN/RED);
 * 3. check whether REAL (non-synthetic) harness spans have arrived recently →
 * tells the user if their HARNESS is actually emitting;
 * 4. print GREEN ("capture working — your agent is earning from tool calls") or
 * RED with the EXACT next step.
 *
 * Two audiences, one command: interactive human output by default; `--json`
 * emits a machine-readable report (GREEN/RED + `next_step` + `next_command`) so
 * an autonomous agent can self-check and self-remediate. In `--json` mode all
 * progress goes to stderr and only the JSON document is written to stdout.
 */

import { DOCTOR_PROBE_LOG_LINE, DOCTOR_PROBE_ORCHESTRATION_NAME, DOCTOR_PROBE_TOOL_NAMES } from '../observer/doctor-probe';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import {
  checkBakedTargets,
  extractScriptPaths,
  realProbe,
  type RuntimeProbe,
} from '../observer/runtime-install';
import { loadCredentials, getCredentialsPath } from './credentials';
import { isObserverRunning, OBSERVER_LOG, PID_FILE } from '../observer/service';
import { ProgramWitnessRegistry, programWitnessPath, recordSources, readSource, valuesAt } from '../observer/program-witness';
import { normalizeEpoch } from '../observer/plugins/transcript/record-store';
import {
  OTLP_DEFAULT_PORT,
  OTLP_BIND_HOST,
  detectAgentHarness,
} from '../observer/plugins/OTelPlugin';
import { harnessEnableGuidance } from './harness-guidance';
import { MODEL_PROXY_DEFAULT_PORT } from '../observer/plugins/model-proxy/routing';
import {
  probeLocalInferenceRuntimes,
  probeHasWitnessableSource,
  describeLocalInferenceProbe,
  type LocalInferenceProbe,
} from '../observer/plugins/local-inference/runtimes';
import { isDirectCliEntry } from './cli-entry';
import { cliCommand, HOSTED_BUNDLE } from '../cli-command';
import { defaultPeStoreRoot, FsPeStore, type PeStore } from '../meter/pe-store';
import { describeMeterStatus, meterStatusOf, PE_STORE_NOTICE } from '../meter/status';
import { createHttpMeterTransport, type MeterTransport } from '../meter/transport';
import { METER_GENESIS_PREV_HASH } from '../meter-wire';

// ---------------------------------------------------------------------------
// Report shape (also the --json contract)
// ---------------------------------------------------------------------------

export type CheckStatus = 'green' | 'red' | 'skip';
export type EmissionStatus = 'green' | 'red' | 'unknown';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  /** Overall: green ONLY when the pipeline works AND real capture is observed. */
  status: 'green' | 'red';
  checks: DoctorCheck[];
  /** Synthetic span → PE round-trip (the Provian side). */
  provian_side: CheckStatus;
  /**
   * AGGREGATE (kept for --json compat): green when real tool activity was
   * observed on EITHER path — OTel spans or transcript capture.
   */
  harness_emitting: EmissionStatus;
  /** Real (non-synthetic) OTel spans observed. */
  otel_emitting: EmissionStatus;
  /** Real tool activity observed via the transcript watcher. */
  transcript_emitting: EmissionStatus;
  /** Real command activity observed via the process lane. */
  process_emitting: EmissionStatus;
  /** Which path(s) real capture came from; null when none observed. */
  emission_source: 'otel' | 'transcript' | 'both' | 'process' | null;
  detected_harness: string | null;
  /**
   * Local inference (the human-lane producer): which runtimes were detected on
   * loopback right now, and whether the daemon has already captured an
   * `inference_session` PE. Advisory — it never flips the overall status,
   * which remains the tool-call capture contract.
   */
  local_inference: {
    detected: boolean;
    summary: string;
    runtimes: Array<{ runtime: string; reachable: boolean; installed: boolean; models: string[]; log: string | null }>;
    /** Whether the daemon has a log/JSONL source it can actually witness. */
    witnessable: boolean;
  };
  /** An inference_session PE was submitted by the daemon in the recent log window. */
  inference_emitting: EmissionStatus;
  /**
   * snapshot-written harness stores (e.g. grok-bot) whose newest record predates this
   * observer's start — the harness isn't writing its mirror. Empty when none.
   */
  mirror_unwritten: string[];
  /** One machine-actionable sentence when not green; null when green. */
  next_step: string | null;
  /** A copy-paste command for the next step, when applicable. */
  next_command: string | null;
}

export interface DoctorOptions {
  json?: boolean;
  /** Max ms to wait for the synthetic span to flush into a PE. */
  waitMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
  /** Progress sink (stderr). No-op in tests. */
  logSink?: (line: string) => void;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
  /** Home the harness stores are found under (tests). */
  home?: string;
  /** The observer pid file whose mtime dates its last start (tests). */
  pidFile?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing with negative controls)
// ---------------------------------------------------------------------------

/**
 * Build a synthetic OTLP/HTTP trace payload: a root orchestration span plus two
 * `execute_tool` child spans — comfortably clears the observer's
 * MIN_ORCHESTRATION_TOOL_CALLS floor (now 1) and mints one agent_tool_orchestration
 * PE, while exercising the tool-orchestration path. Pure so the shape is testable without
 * a receiver.
 */
export function buildSyntheticToolTrace(
  traceId: string,
  rootSpanId: string,
  toolSpanIds: [string, string],
  nowMs: number,
): unknown {
  const startNano = (BigInt(nowMs) * 1_000_000n).toString();
  const endNano = (BigInt(nowMs + 10) * 1_000_000n).toString();
  const toolSpan = (spanId: string, toolName: string) => ({
    traceId,
    spanId,
    parentSpanId: rootSpanId,
    name: `execute_tool ${toolName}`,
    kind: 1,
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
      { key: 'gen_ai.tool.name', value: { stringValue: toolName } },
    ],
    status: { code: 1 },
  });
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'provian-doctor' } },
          { key: 'telemetry.sdk.name', value: { stringValue: 'provian-doctor' } },
        ],
      },
      scopeSpans: [{
        scope: { name: 'provian.doctor' },
        spans: [
          {
            traceId,
            spanId: rootSpanId,
            parentSpanId: '',
            name: DOCTOR_PROBE_ORCHESTRATION_NAME,
            kind: 1,
            startTimeUnixNano: startNano,
            endTimeUnixNano: endNano,
            attributes: [
              { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
            ],
            status: { code: 1 },
          },
          toolSpan(toolSpanIds[0], DOCTOR_PROBE_TOOL_NAMES[0]),
          toolSpan(toolSpanIds[1], DOCTOR_PROBE_TOOL_NAMES[1]),
        ],
      }],
    }],
  };
}

/**
 * True if the observer log shows our synthetic trace classified as the doctor probe
 *. The observer classifies it and never submits it: a fabricated turn is no act
 * of work, and before it minted (an eligible 1.6-PVT PE per doctor run).
 */
export function syntheticTraceEmitted(logText: string, traceId: string): boolean {
  for (const line of logText.split('\n')) {
    if (line.includes(DOCTOR_PROBE_LOG_LINE) && line.includes(`"trace_id":"${traceId}"`)) return true;
  }
  return false;
}

/** Extract every trace_id mentioned on an OTel receiver/flush log line. */
export function otelTraceIdsInLog(logText: string): Set<string> {
  const ids = new Set<string>();
  const re = /"trace_id":"([0-9a-fA-F]+)"/;
  // A doctor probe is never harness activity. Release 38+ logs no `otel trace` line for it;
  // an older observer's lines for a probe carry its orchestration name — skipped, or a
  // previous doctor run reads as real OTel work until it rolls out of the window.
  const probeSpan = `"orchestration_span":"${DOCTOR_PROBE_ORCHESTRATION_NAME}"`;
  for (const line of logText.split('\n')) {
    if (!/otel trace|OTel trace/.test(line)) continue;
    if (line.includes(probeSpan)) continue;
    const m = re.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/**
 * Decide whether a REAL harness is emitting, from a recent log window. A harness
 * turn only surfaces in the log when its trace FLUSHES (any verdict), so any
 * OTel trace line whose id differs from our synthetic proves real emission. A
 * receiver parse-error (a real emitter sending a malformed body) also counts.
 * Absent any such line we return 'unknown' — we cannot tell an idle harness from
 * one that emits nothing (both are silent), and we say so rather than guess.
 */
export function harnessEmissionFromLog(logText: string, syntheticTraceId: string): EmissionStatus {
  for (const id of otelTraceIdsInLog(logText)) {
    if (id !== syntheticTraceId) return 'green';
  }
  if (logText.includes('otel receiver: parse error')) return 'green';
  return 'unknown';
}

export interface TranscriptWatcherStatus {
  active: boolean;
  harnesses: string[];
  files: number;
  /** The snapshot-written stores the line names (release 40+); empty on an older line. */
  materialized: Array<{ harness: string; conversations: number }>;
}

/**
 * Parse the transcript watcher's startup line
 * (`transcript watcher active {"harnesses":[…],"generic_roots":N,"files":N}`)
 * from the recent log window. The LAST such line wins (the current daemon run).
 */
/**
 * Are the long-lived hooks pointing at artifacts that still exist?
 *
 * Reads the INSTALLED files (plist / unit / post-commit) and resolves every
 * script path they name. Deliberately not "recompute what we would write now" —
 * the failure mode is a stale file that looks perfectly correct.
 */
export function installIntegrityCheck(
  read: (p: string) => string | null = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
  probe: RuntimeProbe = realProbe,
): DoctorCheck {
  const artifacts = [
    path.join(homedir(), 'Library', 'LaunchAgents', 'ai.provian.observer.plist'),
    path.join(homedir(), '.config', 'systemd', 'user', 'provian-observer.service'),
    path.join(homedir(), '.provian', 'hooks', 'post-commit'),
  ];
  const referenced: string[] = [];
  for (const a of artifacts) {
    const content = read(a);
    if (content === null) continue;
    referenced.push(...extractScriptPaths(content));
  }
  if (referenced.length === 0) {
    return {
      name: 'install_integrity',
      status: 'skip',
      detail: 'no installed service or hook found on this machine',
    };
  }
  const health = checkBakedTargets(referenced, probe);
  return {
    name: 'install_integrity',
    status: health.ok ? 'green' : 'red',
    detail: health.ok
      ? `${health.checked.length} baked path(s) resolve — the service and git hook point at artifacts that exist`
      : `${health.broken.length} of ${health.checked.length} baked path(s) NO LONGER EXIST. The observer cannot restart and the git hook is silently dead. Re-run the install so the service and hook point at a real artifact.`,
  };
}

export function transcriptWatcherFromLog(logText: string): TranscriptWatcherStatus {
  let latest: TranscriptWatcherStatus = { active: false, harnesses: [], files: 0, materialized: [] };
  for (const line of logText.split('\n')) {
    const idx = line.indexOf('transcript watcher active');
    if (idx === -1) continue;
    const braceIdx = line.indexOf('{', idx);
    if (braceIdx === -1) { latest = { active: true, harnesses: [], files: 0, materialized: [] }; continue; }
    try {
      const extra = JSON.parse(line.slice(braceIdx)) as Record<string, unknown>;
      const mat = Array.isArray(extra.materialized_stores) ? extra.materialized_stores : [];
      latest = {
        active: true,
        materialized: mat.flatMap((m) => {
          const r = m as Record<string, unknown>;
          return typeof r.harness === 'string' && r.harness !== ''
            ? [{ harness: r.harness, conversations: typeof r.conversations === 'number' && r.conversations > 0 ? r.conversations : 0 }]
            : [];
        }),
        harnesses: Array.isArray(extra.harnesses)
          ? extra.harnesses.filter((h): h is string => typeof h === 'string')
          : [],
        // `sources` is the container-agnostic count (files + store sessions);
        // `files` is the pre-2026-09-07 field, still read so an older log line
        // is not misreported as zero.
        files: typeof extra.sources === 'number' ? extra.sources
          : typeof extra.files === 'number' ? extra.files : 0,
      };
    } catch {
      latest = { active: true, harnesses: [], files: 0, materialized: [] };
    }
  }
  return latest;
}

/**
 * The log text written by the observer running NOW, from the start of its run. A release-40+
 * daemon marks its start with `[observer] starting (pid N)` BEFORE its lanes log (the watcher and
 * proxy lines come from `observer.start()`); an older daemon printed only `[observer] started
 * (pid N)`, AFTER them, so for it the run begins at the `starting observer` line before that
 * marker. Null when the log holds neither marker for that pid — the running daemon is not writing
 * this file (an observer before release 40 started from a shell wrote to the shell), so the log
 * describes some earlier run.
 */
export function currentRunLog(tail: string, pid: number): string | null {
  const early = tail.lastIndexOf(`[observer] starting (pid ${pid})`);
  if (early !== -1) return tail.slice(early);
  const late = tail.lastIndexOf(`[observer] started (pid ${pid})`);
  if (late === -1) return null;
  const begin = tail.lastIndexOf('starting observer', late);
  return tail.slice(begin === -1 ? late : tail.lastIndexOf('\n', begin) + 1);
}

/** The pid of the last `[observer] starting|started (pid N)` line in the log, if any. */
export function lastStartedPidInLog(tail: string): number | null {
  const all = [...tail.matchAll(/\[observer\] start(?:ing|ed) \(pid (\d+)\)/g)];
  if (all.length === 0) return null;
  return Number.parseInt(all[all.length - 1][1], 10);
}

/**
 * Whether REAL tool activity was observed via the transcript watcher. Any flush
 * verdict line proves it — a segment only opens on a parsed tool call, so both
 * `PE queued from transcript turn` and `transcript turn not minted` are evidence
 * the harness's session records carry tool calls we parse. `unknown` otherwise:
 * an idle harness and an unwatched one are indistinguishable, and we say so
 * rather than guess.
 */
/** The model-endpoint proxy (Lane 5,) lane's live state from the log tail:
 * whether the shim is listening, whether a tool turn has been witnessed, and
 * whether it forwarded traffic it could not parse (the fingerprint case). Pure,
 * so the exact log-line contract is unit-tested. */
export interface ModelProxyLogStatus { listening: boolean; toolTurnsSeen: boolean; unrecognized: boolean }
export function modelProxyFromLog(logText: string): ModelProxyLogStatus {
  return {
    listening: logText.includes('model proxy listening on'),
    toolTurnsSeen: logText.includes('model proxy: tool turn witnessed'),
    unrecognized: logText.includes('model proxy: unrecognized response shape'),
  };
}

export function transcriptEmissionFromLog(logText: string): EmissionStatus {
  if (logText.includes('PE queued from transcript turn')) return 'green';
  if (logText.includes('transcript turn not minted')) return 'green';
  // a materialized store (the Grok Bot's agent-loop transcripts) is read whole and
  // logs no per-turn line; its evidence is a PE the relay newly recorded.
  if (transcriptPEsRecordedFromLog(logText) > 0) return 'green';
  return 'unknown';
}

/**
 * Transcript-lane PEs the relay recorded as NEW in the log window : `plugin PE
 * submitted` lines from the transcript plugin that carry `idempotent_replay: false`. A
 * replay (a resubmission answered with the PE already made — e.g. a restart that lost its
 * lane state re-sending history) is not activity, and neither is a line from a daemon that
 * predates the field (it cannot say which it was). A store the harness stopped writing,
 * re-read whole at every start or copied, produces no PE and so no line.
 */
export function transcriptPEsRecordedFromLog(logText: string): number {
  let n = 0;
  for (const line of logText.split('\n')) {
    const idx = line.indexOf('plugin PE submitted');
    if (idx === -1) continue;
    const braceIdx = line.indexOf('{', idx);
    if (braceIdx === -1) continue;
    let extra: Record<string, unknown>;
    try { extra = JSON.parse(line.slice(braceIdx)) as Record<string, unknown>; } catch { continue; }
    if (extra.plugin === 'transcript' && extra.idempotent_replay === false) n += 1;
  }
  return n;
}

/**
 * Process-lane PEs the relay recorded as NEW in the log window : `plugin PE submitted`
 * lines from the `process_lane` plugin carrying `idempotent_replay: false`. A replay (resend
 * after a restart) is not activity, the same discipline as the transcript counter above. This
 * is the real-witness proof for an agent whose only lane is the OS process table.
 */
export function processPEsRecordedFromLog(logText: string): number {
  let n = 0;
  for (const line of logText.split('\n')) {
    const idx = line.indexOf('plugin PE submitted');
    if (idx === -1) continue;
    const braceIdx = line.indexOf('{', idx);
    if (braceIdx === -1) continue;
    let extra: Record<string, unknown>;
    try { extra = JSON.parse(line.slice(braceIdx)) as Record<string, unknown>; } catch { continue; }
    if (extra.plugin === 'process_lane' && extra.idempotent_replay === false) n += 1;
  }
  return n;
}

/** Process-lane emission status from the log tail : green iff a new command act sealed. */
export function processEmissionFromLog(logText: string): EmissionStatus {
  return processPEsRecordedFromLog(logText) > 0 ? 'green' : 'unknown';
}

/** A materialized transcript store's last read in the log window (; one per harness). */
export interface MaterializedStoreRead { harness: string; conversations: number }

/**
 * Parse `materialized transcript store read {…}` lines — what the watcher check names as
 * watched. Never activity evidence: every start re-reads the whole store.
 */
export function materializedStoresFromLog(logText: string): MaterializedStoreRead[] {
  const byHarness = new Map<string, MaterializedStoreRead>();
  for (const line of logText.split('\n')) {
    const idx = line.indexOf('materialized transcript store read');
    if (idx === -1) continue;
    const braceIdx = line.indexOf('{', idx);
    if (braceIdx === -1) continue;
    let extra: Record<string, unknown>;
    try { extra = JSON.parse(line.slice(braceIdx)) as Record<string, unknown>; } catch { continue; }
    if (typeof extra.harness !== 'string' || extra.harness === '') continue;
    const c = extra.conversations;
    byHarness.set(extra.harness, {
      harness: extra.harness,
      conversations: typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : 0,
    });
  }
  return [...byHarness.values()];
}

/**
 * Whether the daemon has captured LOCAL INFERENCE: an `inference_session` PE
 * submitted in the recent log window (`session PE submitted
 * {"action_type":"inference_session",…}`). `unknown` otherwise — a runtime that
 * simply ran no model work and a runtime we cannot see are indistinguishable
 * from the log alone, and we say so rather than guess.
 */
export function inferenceEmissionFromLog(logText: string): EmissionStatus {
  for (const line of logText.split('\n')) {
    if (line.includes('session PE submitted') && line.includes('"action_type":"inference_session"')) {
      return 'green';
    }
  }
  return 'unknown';
}

/** The `local_inference` report block from a probe (pure; shared by --json and rendering). */
export function localInferenceReport(probe: LocalInferenceProbe): DoctorReport['local_inference'] {
  return {
    detected: probe.detected,
    summary: describeLocalInferenceProbe(probe),
    runtimes: probe.runtimes
      .filter((r) => r.reachable || r.installed)
      .map((r) => ({ runtime: r.runtime, reachable: r.reachable, installed: r.installed, models: r.loadedModels, log: r.logPath })),
    witnessable: probeHasWitnessableSource(probe),
  };
}

/**
 * The `local_inference` check line. Green: a runtime is running AND its log is
 * tailable (or a JSONL source is set). Red: a runtime is running but no log
 * was found — work happens and cannot be witnessed, which is exactly the
 * silent-nothing this command exists to surface. Skip: nothing local at all.
 */
export function localInferenceCheck(probe: LocalInferenceProbe): DoctorCheck {
  const running = probe.runtimes.filter((r) => r.reachable);
  const summary = describeLocalInferenceProbe(probe);
  if (running.length === 0 && probe.jsonlLogPath === null) {
    return {
      name: 'local_inference',
      status: 'skip',
      detail: probe.detected
        ? `${summary} — start it and local model work is witnessed as inference_session PEs`
        : summary,
    };
  }
  if (probeHasWitnessableSource(probe)) {
    return { name: 'local_inference', status: 'green', detail: `${summary} — local model work is witnessed as inference_session PEs` };
  }
  const missing = running.map((r) => r.runtime).join(', ');
  const hint = running.map((r) => (
    r.runtime === 'ollama' ? 'PROVIAN_OLLAMA_LOG=<path to Ollama server.log>'
      : r.runtime === 'lmstudio' ? 'PROVIAN_LMSTUDIO_LOG=<path to an LM Studio server log>'
        : 'PROVIAN_LLAMA_SERVER_LOG=<file llama-server stderr is redirected to>'
  )).join('; ');
  return {
    name: 'local_inference',
    status: 'red',
    detail: `${missing} running but its request log was not found, so requests cannot be witnessed — point the daemon at it (${hint}) and restart the observer`,
  };
}

/**
 * Pure outcome selection from the gathered signals. GREEN requires a working
 * pipeline AND real capture observed on at least one path — OTel spans OR
 * transcript capture. (A green pipeline with zero real capture is the Atlas
 * failure this check exists to surface.)
 */
export interface UnwrittenMirror {
  harness: string;
  root: string;
  newestRecordMs: number;
  observerStartedMs: number;
}

/**
 * snapshot-written stores (the materialized layout, e.g. `grok-bot`) whose newest dated
 * record predates the observer's last start. A harness that writes its mirror leaves a record
 * newer than that start once it runs a turn; one that never writes it (Grok Bot's runtime, seen on
 * the operator’s box: the store is the instance-creation snapshot) never does — that is "the harness
 * isn't writing its mirror", never "the harness may be idle". A store with no dated line, no
 * conversation, or an unknown start says nothing.
 */
export function unwrittenMirrors(input: {
  home: string;
  observerStartedMs: number | null;
}): UnwrittenMirror[] {
  if (input.observerStartedMs === null) return [];
  const out: UnwrittenMirror[] = [];
  for (const p of new ProgramWitnessRegistry(programWitnessPath(input.home)).programs()) {
    if (!p.session) continue;
    const sources = recordSources(p.session);
    const dates = sources.flatMap(src => readSource(p.session!, src, p.session!.sqlite ? Math.max(0, src.tip-1000) : 0).records
      .map(r => normalizeEpoch(valuesAt(r.record, p.session!.timestamp)[0]) ?? r.atMs).filter((v): v is number => v !== null));
    const newest = dates.length ? Math.max(...dates) : null;
    if (newest !== null && newest < input.observerStartedMs) out.push({ harness: p.program, root: p.session.root, newestRecordMs: newest, observerStartedMs: input.observerStartedMs });
  }
  return out;
}

/** When the running observer last started: its pid file, rewritten on every start (a self-update handover included). */
export function observerStartedMs(pidFile: string = PID_FILE): number | null {
  try { return fs.statSync(pidFile).mtimeMs; } catch { return null; }
}

function mirrorSentence(ms: readonly UnwrittenMirror[]): string {
  return ms.map((m) => `the ${m.harness} harness isn't writing its mirror: the newest record in ${m.root} (${new Date(m.newestRecordMs).toISOString()}) predates this observer's start (${new Date(m.observerStartedMs).toISOString()}).`).join(' ');
}

/** The harness_emitting check line (an unwritten mirror is named, never "may be idle"). */
export function harnessEmittingCheck(input: {
  eitherGreen: boolean;
  emissionSource: DoctorReport['emission_source'];
  detectedHarness: string | null;
  mirrors: readonly UnwrittenMirror[];
}): DoctorCheck {
  const { eitherGreen, emissionSource, detectedHarness, mirrors } = input;
  return {
    name: 'harness_emitting',
    // `eitherGreen` is the any-lane-green signal (otel / transcript / process —).
    status: eitherGreen ? 'green' : 'red',
    detail: eitherGreen
      ? `real tool activity observed via ${emissionSource}${detectedHarness ? ` (${detectedHarness})` : ''}`
      : mirrors.length > 0
        ? `no real tool activity observed on either path — ${mirrorSentence(mirrors)} Its tool calls cannot be witnessed until it writes there`
        : `no real tool activity observed on either path${detectedHarness ? ` from ${detectedHarness}` : ''} — the harness may be idle, or its session log is somewhere the watcher does not cover`,
  };
}

export function selectDoctorOutcome(input: {
  hasCreds: boolean;
  observerRunning: boolean;
  receiverReachable: boolean;
  provianSide: CheckStatus;
  harnessEmitting: EmissionStatus;
  transcriptEmitting: EmissionStatus;
  /** command activity observed via the process lane (an agent VM's own commands). */
  processEmitting?: EmissionStatus;
  detectedHarness: string | null;
  /** stores whose harness isn't writing its mirror (see unwrittenMirrors). */
  unwrittenMirrors?: readonly UnwrittenMirror[];
}): { status: 'green' | 'red'; next_step: string | null; next_command: string | null } {
  if (!input.hasCreds) {
    // The hosted install registers the device as part of the install line; there is no separate
    // register step to name there (no npx on the hosted path).
    return HOSTED_BUNDLE
      ? {
        status: 'red',
        next_step: 'This machine has no Provian device credentials. Generate a fresh code in the Provian app under "Connect an agent" and paste the install line again, then re-run doctor.',
        next_command: null,
      }
      : {
        status: 'red',
        next_step: 'This device is not registered. Register it, then re-run doctor.',
        next_command: cliCommand('register-device'),
      };
  }
  if (!input.receiverReachable) {
    return {
      status: 'red',
      next_step: input.observerRunning
        ? `The observer is running but the OTLP receiver is not answering on http://localhost:${OTLP_DEFAULT_PORT} (another collector may hold the port). Restart the observer, then re-run doctor.`
        : `The observer/OTLP receiver is not reachable on http://localhost:${OTLP_DEFAULT_PORT}. Start the observer, then re-run doctor.`,
      next_command: startObserverCommand(),
    };
  }
  if (input.provianSide !== 'green') {
    return {
      status: 'red',
      next_step: 'The receiver accepted a test span but no PE was produced within the wait window. Check ~/.provian/observer.log; ensure the observer is running with valid credentials.',
      next_command: startObserverCommand(),
    };
  }
  // The harness side is satisfied by ANY lane: real OTel spans, real tool activity read from
  // the harness's own session records, or — commands the process lane witnessed on an
  // agent's own VM. A box whose only lane is the process lane is GREEN once a command sealed.
  const noLaneGreen = input.harnessEmitting !== 'green' && input.transcriptEmitting !== 'green' && input.processEmitting !== 'green';
  if (noLaneGreen && (input.unwrittenMirrors?.length ?? 0) > 0) {
    // Not idle, and nothing to enable: the harness has not written its store since this
    // observer started (Grok Bot's runtime never writes its transcript mirror).
    return {
      status: 'red',
      next_step: `The Provian pipeline works, but ${mirrorSentence(input.unwrittenMirrors ?? [])} Its tool calls cannot be witnessed until the harness writes there — nothing on this machine changes that; the observer stays armed on that directory and mints the first turn written to it. Commits, Commons acts and on-chain acts earn meanwhile.`,
      next_command: null,
    };
  }
  if (noLaneGreen) {
    const guidance = harnessEnableGuidance(input.detectedHarness);
    return {
      status: 'red',
      next_step: `The Provian pipeline works and the transcript watcher is up, but no real tool activity has been observed on either path (OTel spans or harness session records) — ${guidance.summary} Run one agent turn with a tool call or two, then re-run doctor. If your harness stores its session log in a custom location, add it with \`${cliCommand('witness configure --description <local-json-file>')}\`.`,
      // The hosted bundle has no `start` verb: re-run doctor after the turn.
      next_command: HOSTED_BUNDLE ? cliCommand('doctor') : cliCommand('start'),
    };
  }
  return { status: 'green', next_step: null, next_command: null };
}

/**
 * How to (re)start the observer here. Hosted: `repair` re-installs the service / detached daemon
 * (and the restart hook) and returns — a foreground `observe` would block the agent's tool call.
 */
function startObserverCommand(): string {
  return HOSTED_BUNDLE ? cliCommand('repair') : cliCommand('observe');
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function readLogFrom(p: string, offset: number): string {
  try {
    const size = fileSize(p);
    if (size <= offset) return '';
    const fd = fs.openSync(p, 'r');
    try {
      const len = size - offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Byte offset of the last occurrence of any of `markers` in the file, scanning backwards in
 * chunks (so a daemon whose start line scrolled out of the 512 KB tail is still found). -1 if none.
 */
export function findLastMarkerOffset(p: string, markers: readonly string[], chunk = 1024 * 1024): number {
  const size = fileSize(p);
  if (size === 0) return -1;
  const overlap = Math.max(...markers.map((m) => Buffer.byteLength(m))) - 1;
  let fd: number;
  try { fd = fs.openSync(p, 'r'); } catch { return -1; }
  try {
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk);
      const len = Math.min(size, end + overlap) - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      let best = -1;
      for (const m of markers) best = Math.max(best, buf.lastIndexOf(m));
      if (best !== -1) return start + best;
      end = start;
    }
    return -1;
  } catch {
    return -1;
  } finally {
    fs.closeSync(fd);
  }
}

function readBytes(p: string, offset: number, len: number): Buffer {
  if (len <= 0) return Buffer.alloc(0);
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, offset);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * The running observer's part of the log, found however far back its start is: the first 256 KB
 * of the run (its start-up lines — watcher, proxy) plus the last 512 KB (what it said lately).
 * Null when the file holds no start marker for this pid.
 */
export function readRunLog(p: string, pid: number): string | null {
  let offset = findLastMarkerOffset(p, [`[observer] starting (pid ${pid})`]);
  if (offset === -1) {
    // A pre-release-40 daemon marked its start only AFTER its lanes logged: back up to the
    // `starting observer` line before that marker (within 256 KB).
    const late = findLastMarkerOffset(p, [`[observer] started (pid ${pid})`]);
    if (late === -1) return null;
    const from = Math.max(0, late - 256 * 1024);
    const window = readBytes(p, from, late - from);
    const s = window.lastIndexOf('starting observer');
    if (s === -1) offset = late;
    else {
      const nl = window.lastIndexOf('\n', s);
      offset = from + (nl === -1 ? 0 : nl + 1);
    }
  }
  const size = fileSize(p);
  const HEAD = 256 * 1024;
  const TAIL = 512 * 1024;
  if (size - offset <= HEAD + TAIL) return readBytes(p, offset, size - offset).toString('utf-8');
  return `${readBytes(p, offset, HEAD).toString('utf-8')}\n${readBytes(p, size - TAIL, TAIL).toString('utf-8')}`;
}

function readLogTail(p: string, maxBytes = 512 * 1024): string {
  const size = fileSize(p);
  if (size === 0) return '';
  return readLogFrom(p, Math.max(0, size - maxBytes));
}

async function postSyntheticSpan(
  payload: unknown,
  fetchImpl: typeof fetch,
  timeoutMs = 5000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${OTLP_BIND_HOST}:${OTLP_DEFAULT_PORT}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The check engine (reused by the npm package's `start`)
// ---------------------------------------------------------------------------

/**
 * The transcript-watcher and model-proxy checks, read from the observer log tail (pure,
 * so the log contract and the observer-down wording are unit-tested). `running` is
 * whether an observer process is alive now: the log describes its LAST run.
 */
export function logLaneChecks(tail: string, running: boolean, logCurrent: boolean = running): DoctorCheck[] {
  // Running but writing no log here: the lines describe an earlier run — say that,
  // never "the observer is down" (it is up; the observer check says so).
  const notLogging = running && !logCurrent;
  const out: DoctorCheck[] = [];
  const watcher = transcriptWatcherFromLog(tail);
  // A watcher that is RUNNING but sees nothing is the Atlas failure: the daemon
  // was alive for five days with zero readable sources and said nothing. An
  // active watcher with zero sources is RED, not green.
  const zeroSources = watcher.active && watcher.files === 0 && watcher.harnesses.length > 0;
  const stores = watcher.materialized.length > 0 ? watcher.materialized : materializedStoresFromLog(tail);
  const storesText = stores.map((s) => `the ${s.harness} store (${s.conversations} conversation(s))`).join(', ');
  // The log describes the LAST run; with no observer running nothing is watched or
  // listening now, and saying so in the present tense would contradict the observer check.
  const watcherDetail = zeroSources
    ? `running, but ZERO readable sources for an installed harness${watcher.harnesses.length ? ` [${watcher.harnesses.join(', ')}]` : ''} — the harness likely changed where it keeps sessions. Update the SDK, or point the watcher at it with \`${cliCommand('witness configure --description <local-json-file>')}\`.`
    : watcher.active
      ? `watching ${watcher.files} session source(s)${watcher.harnesses.length ? ` [${watcher.harnesses.join(', ')}]` : ''}${storesText ? ` and ${storesText}` : ''} — harness session records are captured with no harness changes`
      : 'not active in the recent log — agent devices start it with the observer; on a human device it is off by design';
  out.push({
    name: 'transcript_watcher',
    status: running && logCurrent && watcher.active && !zeroSources ? 'green' : 'red',
    detail: notLogging
      ? `unknown — the running observer is not writing the log (see observer_log); the last logged run: ${watcherDetail}`
      : running || !watcher.active ? watcherDetail : `not running now (the observer is down); its last run: ${watcherDetail}`,
  });

  // Lane 5 — the model-endpoint proxy witness lane. Default-on; it does
  // nothing until a model base URL is repointed at it, so "listening but no turns"
  // is a prompt to repoint, never an alarm. Informational (never flips the verdict).
  const proxy = modelProxyFromLog(tail);
  out.push({
    name: 'model_proxy',
    status: running && logCurrent && proxy.listening ? 'green' : 'skip',
    detail: notLogging
      ? 'unknown — the running observer is not writing the log (see observer_log)'
      : !running
      ? 'not listening — the proxy runs inside the observer, which is down'
      : proxy.listening
      ? (proxy.toolTurnsSeen
        ? `witnessing model turns (tool calls) on http://localhost:${MODEL_PROXY_DEFAULT_PORT}${proxy.unrecognized ? ' — some traffic was unparseable (fingerprinted to capture-health)' : ''}`
        : `listening on http://localhost:${MODEL_PROXY_DEFAULT_PORT} — point your model base URL at /anthropic|/openai|/xai|/gemini here and restart to be witnessed`)
      : 'not active in the recent log — default-on unless PROVIAN_MODEL_PROXY=0; (re)start the observer',
  });

  // Lane 4 — the process lane. On an agent VM it witnesses the commands the agent runs,
  // read straight from the OS, for work no described lane sees. Agent devices only; a human device
  // never runs it. Informational (the harness_emitting line carries the verdict).
  const processWatching = tail.includes('process lane watching');
  const processActs = processPEsRecordedFromLog(tail);
  // the lane's own state, as the observer last wrote it.
  const laneState = currentProcessLaneState();
  // red for a flag (no running program matches the recorded launcher, or its
  // wrapper changed and was not re-recorded); the unshown suspicion is never red — this very command
  // re-records the wrapper when it runs under the recorded launcher (above).
  const flagged = laneState === 'launcher_changed' || laneState === 'launcher_not_seen';
  const unconfirmed = laneState === 'launcher_unconfirmed';
  // follow-up : no launcher recorded → the lane witnesses none of the agent's
  // commands. Doctor records one when run from the agent's own session (above, before this report), and
  // the observer reads it within seconds; until a record exists the state is flagged with its fix.
  const unrecorded = laneState === 'no_launcher' && readLauncherRecord(processLauncherPath()) === null;
  out.push({
    name: 'process_lane',
    status: flagged || unrecorded || laneState === 'launcher_unsupported' ? 'red' : running && logCurrent && processActs > 0 ? 'green' : 'skip',
    detail: laneState === 'launcher_unsupported'
      ? 'not witnessing — your harness hands each command to its child itself (in its command line, or from a long-lived shell), so the process lane cannot tell your commands from its own programs and mints nothing'
      : flagged
      ? `${laneState === 'launcher_changed' ? 'your harness changed how it starts your commands' : 'no running program matches the recorded launcher of your commands'} — run \`${cliCommand('process-lane record')}\` from your own harness, as an ordinary command`
      : unconfirmed
      ? 'checking — your harness is starting programs that do not start the recorded way; a provian command run from your own harness re-records it'
      : laneState === 'inert_other_lane'
        ? 'off — this agent has another witness lane (session files, the model proxy or OTel), which witnesses its work'
        : unrecorded
          ? `not witnessing commands — no launcher is recorded; run \`${PROCESS_LANE_RECORD_COMMAND}\` once from your own session, as an ordinary command`
          : laneState === 'no_launcher' || laneState === 'starting'
          ? 'starting — a launcher was just recorded; the observer reads it within seconds'
          : notLogging
      ? 'unknown — the running observer is not writing the log (see observer_log)'
      : !running
        ? 'not active — the process lane runs inside the observer, which is down'
        : processActs > 0
          ? `witnessing this machine's commands — ${processActs} command act(s) sealed in the recent log`
          : processWatching
            ? 'watching the OS process table — a command the agent runs here seals one PE; idle until then'
            : 'not active in the recent log — agent devices start it with the observer; on a human device it is off by design',
  });
  return out;
}

/**
 * PE meter : this device's PE store — how many PEs it keeps and where,
 * the last batch the relay accepted (seq, time, receipt totals), what is not yet batched, proofs
 * fetched, mailbox PEs received. Red only when batching has halted (the relay's chain cannot be
 * continued from this store); a store that cannot be read is red too. Never throws.
 */
export async function peStoreCheck(store: PeStore | null): Promise<DoctorCheck> {
  if (store === null) {
    return { name: 'pe_store', status: 'skip', detail: 'no device id in the credentials yet; the observer learns it from the relay on first start' };
  }
  try {
    const status = await meterStatusOf(store);
    return { name: 'pe_store', status: status.halted ? 'red' : 'green', detail: `${describeMeterStatus(status)}. ${PE_STORE_NOTICE}` };
  } catch (err) {
    return { name: 'pe_store', status: 'red', detail: `the PE store at ${store.location} could not be read: ${(err as Error).message}` };
  }
}

/**
 * The relay, reached the way the observer's PE meter reaches it (Grok bot, 2026-10-20): this
 * machine's own guarded fetch and device key — not curl, which can succeed where the daemon's path
 * cannot. Green when the relay answers this device's tip; when the store is halted
 * relay_chain_diverged and that tip equals this device's last accepted batch, it says the halt is
 * stale (the running observer clears it on its next re-check). Red, with the exact failure, when the
 * relay cannot be read on this path: no batch can go until it can. Read-only; never throws.
 */
export async function relayMeterCheck(transport: MeterTransport | null, store: PeStore | null): Promise<DoctorCheck> {
  if (transport === null) return { name: 'relay', status: 'skip', detail: 'no device credentials yet' };
  let tip: { status: number | null; body: unknown; error: string | null };
  try { tip = await transport.getTip(); } catch (err) { tip = { status: null, body: null, error: (err as Error).message }; }
  const body = (tip.body !== null && typeof tip.body === 'object' && !Array.isArray(tip.body)) ? tip.body as Record<string, unknown> : null;
  if (!(tip.status === 200 && body && typeof body.seq === 'number' && typeof body.batch_hash === 'string' && typeof body.last_pe_hash === 'string')) {
    const how = tip.status === null ? 'no answer' : `HTTP ${tip.status}`;
    return {
      name: 'relay',
      status: 'red',
      detail: `this machine's meter path cannot read the relay (${how}${tip.error ? `: ${tip.error.slice(0, 200)}` : ''}) — no batch can be sent until it can`,
    };
  }
  let last: { seq: number; batch_hash: string; last_pe_hash: string } | null = null;
  let halt: { reason: string } | null = null;
  try { last = store ? await store.lastBatch() : null; } catch { last = null; }
  try { halt = store ? await store.halt() : null; } catch { halt = null; }
  const local = last ?? { seq: 0, batch_hash: METER_GENESIS_PREV_HASH, last_pe_hash: METER_GENESIS_PREV_HASH };
  const matches = body.seq === local.seq && body.batch_hash === local.batch_hash && body.last_pe_hash === local.last_pe_hash;
  if (halt?.reason === 'relay_chain_diverged' && matches) {
    return {
      name: 'relay',
      status: 'green',
      detail: `relay reachable on this machine's meter path; its tip (seq ${body.seq}) equals this device's, so the relay_chain_diverged halt is stale — the running observer clears it on its next re-check`,
    };
  }
  return { name: 'relay', status: 'green', detail: `relay reachable on this machine's meter path (relay tip seq ${body.seq}, this device seq ${local.seq})` };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const waitMs = options.waitMs ?? 45_000;
  const pollMs = options.pollMs ?? 2_000;
  const log = options.logSink ?? (() => {});
  const fetchImpl = guardedFetcher(options.fetchImpl);
  // Fixed loopback IPC probes stay local; external HTTP uses the guarded transport.
  const localFetch = options.fetchImpl ?? globalThis.fetch;

  const checks: DoctorCheck[] = [];
  const detectedHarness = detectAgentHarness();
  // Local inference is probed up front (loopback, bounded) so the readout is
  // there whether or not the rest of the pipeline is up.
  const inferenceProbe = await probeLocalInferenceRuntimes({ fetchImpl: localFetch, timeoutMs: 750 });
  const localInference = localInferenceReport(inferenceProbe);

  // 1) Credentials
  const creds = loadCredentials();
  if (!creds) {
    checks.push({ name: 'credentials', status: 'red', detail: `No credentials in env or ${getCredentialsPath()}` });
    checks.push(localInferenceCheck(inferenceProbe));
    const outcome = selectDoctorOutcome({
      hasCreds: false, observerRunning: false, receiverReachable: false, provianSide: 'skip',
      harnessEmitting: 'unknown', transcriptEmitting: 'unknown', detectedHarness,
    });
    return {
      status: outcome.status, checks, provian_side: 'skip', harness_emitting: 'unknown',
      otel_emitting: 'unknown', transcript_emitting: 'unknown', process_emitting: 'unknown', emission_source: null,
      detected_harness: detectedHarness, local_inference: localInference, inference_emitting: 'unknown',
      mirror_unwritten: [], next_step: outcome.next_step, next_command: outcome.next_command,
    };
  }
  checks.push({
    name: 'credentials',
    status: 'green',
    detail: `owner_type=${creds.ownerType ?? 'human'}${creds.agentWalletId ? ` agent_wallet=${creds.agentWalletId}` : ''}`,
  });

  // 1b) PE meter: where this device's PEs live, and how far the daily batches have got.
  const meterStore = creds.deviceId ? new FsPeStore(creds.deviceId, defaultPeStoreRoot()) : null;
  checks.push(await peStoreCheck(meterStore));
  // 1c) The relay, on the observer's own meter path (guarded fetch + device key).
  checks.push(await relayMeterCheck(creds.deviceKey && creds.deviceSecret && creds.relayUrl
    ? createHttpMeterTransport({
      relayUrl: creds.relayUrl,
      boundEnvelope: async () => { throw new Error('doctor sends nothing'); },
      authHeaders: () => ({ Authorization: `DeviceKey ${creds.deviceKey}:${creds.deviceSecret}` }),
      timeoutMs: 10_000,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
    : null, meterStore));

  // 2) Observer process
  const pid = isObserverRunning();
  checks.push({
    name: 'observer',
    status: pid ? 'green' : 'red',
    detail: pid ? `running (pid ${pid})` : 'not running',
  });

  // 2a) Whose log is this? Every log-derived check below reads ~/.provian/observer.log;
  //     they describe the running observer only if it is the one writing that file.
  const fullTail = readLogTail(OBSERVER_LOG);
  const runLog = pid ? readRunLog(OBSERVER_LOG, pid) : null;
  const logIsCurrent = pid != null && runLog !== null;
  if (pid) {
    const lastPid = lastStartedPidInLog(fullTail);
    checks.push({
      name: 'observer_log',
      status: logIsCurrent ? 'green' : 'red',
      detail: logIsCurrent
        ? `the running observer (pid ${pid}) writes ${OBSERVER_LOG}`
        : `the running observer (pid ${pid}) is not writing ${OBSERVER_LOG} — the log's last start is ${lastPid ? `pid ${lastPid}` : 'not in its recent window'}, so every check read from the log describes that run, not this one. An observer before release 40 that a shell started writes to that shell; release 40+ writes its own log (it arrives by self-update).`,
    });
  }

  // 2b) Local inference (the human-lane producer): what is running here, and
  //     whether an inference_session has already been captured.
  checks.push(localInferenceCheck(inferenceProbe));
  const inferenceEmitting = inferenceEmissionFromLog(readLogTail(OBSERVER_LOG));
  checks.push({
    name: 'inference_capture',
    status: inferenceEmitting === 'green' ? 'green' : 'skip',
    detail: inferenceEmitting === 'green'
      ? 'inference_session PE(s) submitted from local model work in the recent log window'
      : (localInference.witnessable
        ? 'no inference_session submitted yet in the recent log window — run a local model request; the window closes 30s after the last request'
        : 'no local inference source to witness'),
  });

  // 3) Provian side — synthetic span → PE.
  log('Sending a test tool-orchestration span to the local receiver…');
  const traceId = randomBytes(16).toString('hex');
  const rootSpanId = randomBytes(8).toString('hex');
  const toolSpanIds: [string, string] = [randomBytes(8).toString('hex'), randomBytes(8).toString('hex')];
  const startOffset = fileSize(OBSERVER_LOG);
  const payload = buildSyntheticToolTrace(traceId, rootSpanId, toolSpanIds, Date.now());
  const accepted = await postSyntheticSpan(payload, localFetch);

  checks.push({
    name: 'receiver',
    status: accepted ? 'green' : 'red',
    detail: accepted
      ? `accepted OTLP/HTTP on http://localhost:${OTLP_DEFAULT_PORT}/v1/traces`
      : `unreachable on http://localhost:${OTLP_DEFAULT_PORT}`,
  });

  let provianSide: CheckStatus = 'skip';
  if (accepted) {
    log(`Waiting for the observer to classify the trace (up to ${Math.round(waitMs / 1000)}s)…`);
    const deadline = Date.now() + waitMs;
    let emitted = false;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const since = readLogFrom(OBSERVER_LOG, startOffset);
      emitted = syntheticTraceEmitted(since, traceId);
      if (emitted) break;
    }
    provianSide = emitted ? 'green' : 'red';
    checks.push({
      name: 'provian_pipeline',
      status: provianSide,
      detail: emitted
        ? 'synthetic span received and classified as a 2-tool agent turn (a probe is never submitted — it is no work)'
        : pid && !logIsCurrent
          ? `synthetic span accepted, but the running observer (pid ${pid}) is not writing ${OBSERVER_LOG}, so its classification cannot be read here (see observer_log)`
          : 'synthetic span accepted but the observer did not classify it within the wait window (an observer older than release 38 would mint it instead — update, then re-run)',
    });
  } else {
    checks.push({ name: 'provian_pipeline', status: 'skip', detail: 'skipped — receiver unreachable' });
  }

  // 4) Real capture, both paths (scan the recent log window; the synthetic
  //    OTel trace is excluded from the OTel-side evidence).
  const tail = readLogTail(OBSERVER_LOG);
  const otelEmitting = harnessEmissionFromLog(tail, traceId);
  const transcriptEmitting = transcriptEmissionFromLog(tail);
  const processEmitting = processEmissionFromLog(tail);
  // The watcher/proxy lines describe a RUN: read them from the running observer's own
  // part of the log. When it writes no log here, they come from the last run and say so.
  checks.push(...logLaneChecks(runLog ?? tail, pid != null, logIsCurrent));

  // Install integrity: do the paths baked into the launchd plist / systemd unit
  // and the global git hook still resolve? Nothing checked this on the Mac mini,
  // which is why a dangling symlink went unnoticed for eleven days while the
  // observer survived only because its process never exited.
  const integrity = installIntegrityCheck();
  checks.push(integrity);

  return finishDoctorReport({
    checks, pid, accepted, provianSide, otelEmitting, transcriptEmitting, processEmitting, detectedHarness,
    localInference, inferenceEmitting, home: options.home ?? homedir(), pidFile: options.pidFile,
  });
}

/**
 * The last step of a doctor run, over what the probes found (exported so the wiring is
 * tested end to end): the unwritten-mirror read (only with an observer running and no real
 * capture), the harness_emitting line, the verdict and the report.
 */
export function finishDoctorReport(input: {
  checks: DoctorCheck[];
  pid: number | null;
  accepted: boolean;
  provianSide: CheckStatus;
  otelEmitting: EmissionStatus;
  transcriptEmitting: EmissionStatus;
  processEmitting?: EmissionStatus;
  detectedHarness: string | null;
  localInference: DoctorReport['local_inference'];
  inferenceEmitting: EmissionStatus;
  home: string;
  pidFile?: string;
}): DoctorReport {
  const { checks, pid, otelEmitting, transcriptEmitting, detectedHarness } = input;
  const processEmitting: EmissionStatus = input.processEmitting ?? 'unknown';
  // ANY lane green satisfies the harness side, including the process lane (a Grok Bot
  // VM whose only witness is the OS process table). The name `eitherGreen` is kept for the
  // call sites it threads into.
  const eitherGreen = otelEmitting === 'green' || transcriptEmitting === 'green' || processEmitting === 'green';
  const mirrors = pid && !eitherGreen
    ? unwrittenMirrors({ home: input.home, observerStartedMs: observerStartedMs(input.pidFile) })
    : [];
  const emissionSource: DoctorReport['emission_source'] =
    otelEmitting === 'green' && transcriptEmitting === 'green' ? 'both'
      : otelEmitting === 'green' ? 'otel'
        : transcriptEmitting === 'green' ? 'transcript'
          : processEmitting === 'green' ? 'process'
            : null;
  checks.push(harnessEmittingCheck({ eitherGreen, emissionSource, detectedHarness, mirrors }));

  const outcome = selectDoctorOutcome({
    hasCreds: true,
    observerRunning: pid != null,
    receiverReachable: input.accepted,
    provianSide: input.provianSide,
    harnessEmitting: otelEmitting,
    transcriptEmitting,
    processEmitting,
    detectedHarness,
    unwrittenMirrors: mirrors,
  });

  return {
    status: outcome.status,
    checks,
    provian_side: input.provianSide,
    harness_emitting: eitherGreen ? 'green' : 'unknown',
    otel_emitting: otelEmitting,
    transcript_emitting: transcriptEmitting,
    process_emitting: processEmitting,
    emission_source: emissionSource,
    detected_harness: detectedHarness,
    local_inference: input.localInference,
    inference_emitting: input.inferenceEmitting,
    mirror_unwritten: mirrors.map((m) => m.harness),
    next_step: outcome.next_step,
    next_command: outcome.next_command,
  };
}

// ---------------------------------------------------------------------------
// Human-readable rendering
// ---------------------------------------------------------------------------

export function renderReportLines(report: DoctorReport): string[] {
  const out: string[] = [];
  const mark = (s: CheckStatus) => (s === 'green' ? '✓' : s === 'red' ? '✗' : '–');
  out.push('');
  out.push('  Provian capture doctor');
  out.push('');
  for (const c of report.checks) {
    out.push(`  ${mark(c.status)} ${c.name}: ${c.detail}`);
  }
  out.push('');
  if (report.local_inference.detected) {
    out.push(`  Local inference: ${report.local_inference.summary}`);
    out.push(report.inference_emitting === 'green'
      ? '    inference_session PEs are being captured from local model work.'
      : (report.local_inference.witnessable
        ? '    Run a local model request; its window becomes an inference_session PE ~30s after the last request.'
        : '    Its request log was not found — see the local_inference line above.'));
    out.push('');
  }
  if (report.status === 'green') {
    out.push('  GREEN — capture is working. Your agent is earning from tool calls.');
  } else {
    out.push('  RED — capture is NOT confirmed yet.');
    if (report.next_step) out.push(`  Next: ${report.next_step}`);
    // When the blocker is the harness, print its exact enable step.
    // Nothing to enable when the harness isn't writing its mirror.
    if (report.provian_side === 'green' && report.harness_emitting !== 'green' && report.mirror_unwritten.length === 0) {
      const guidance = harnessEnableGuidance(report.detected_harness);
      out.push('');
      out.push(`  Enable tool-call capture for ${guidance.label}:`);
      for (const line of guidance.steps) out.push(`  ${line}`);
    }
    if (report.next_command) {
      out.push('');
      out.push(`  Then run: ${report.next_command}`);
    }
  }
  out.push('');
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseDoctorArgs(argv: string[]): { json: boolean; help: boolean } {
  return {
    json: argv.includes('--json'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

/**
 * The doctor CLI body — the npm `doctor` bin and the hosted bundle's `doctor` verb
 * (`"$HOME/.provian/bin/provian" doctor`,) both run this.
 */
export async function runDoctorCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { json, help } = parseDoctorArgs(argv);
  if (help) {
    console.log(`
Usage: ${cliCommand('doctor')} [--json]

Verifies tool-call capture end-to-end: credentials, the observer, the OTLP
receiver, a synthetic span → PE round-trip (the Provian side), and whether your
harness is actually emitting OpenTelemetry. Prints GREEN, or RED with the exact
next step. Also reports local inference: which runtimes (Ollama / LM Studio /
llama.cpp llama-server) are detected on this machine, whether their request log
can be witnessed, and whether an inference_session PE has been captured yet. And
the model-endpoint proxy (Lane 5): whether the loopback shim is listening and
whether it has witnessed a model turn (tool calls) — point your model
base URL at http://localhost:${MODEL_PROXY_DEFAULT_PORT}/<provider> to be witnessed.

  --json    Machine-readable report (status + next_step + next_command) on
            stdout; progress on stderr. For autonomous agents / CI.
`);
    process.exit(0);
  }

  // doctor is a command the agent ran through its harness; an install from before the
  // launcher record existed gets it here (never overwritten — `process-lane record` does that).
  try {
    const { recordLauncher } = await import('../observer/plugins/process-lane/launcher.js');
    recordLauncher({ source: 'doctor', force: false });
  } catch { /* best-effort */ }
  // In --json mode, keep stdout clean for the JSON document — progress → stderr.
  const logSink = (line: string) => process.stderr.write(`  ${line}\n`);
  const report = await runDoctor({ json, logSink });

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    for (const line of renderReportLines(report)) console.log(line);
  }
  process.exit(report.status === 'green' ? 0 : 1);
}

if (isDirectCliEntry(module)) {
  runDoctorCli().catch((err) => {
    console.error(`Unexpected error: ${err}`);
    process.exit(1);
  });
}
