import { ProgramWitnessRegistry, programWitnessPath } from './program-witness';
/**
 * capture-health — what the daemon tells the relay about its own ability to see.
 *
 * The Atlas outage was not a hard failure. Nothing crashed, nothing 500'd,
 * nothing appeared in a log anyone was reading. The daemon was healthy, the
 * receiver was listening, the credentials were valid — and the machine had gone
 * completely blind. From the relay's side that is indistinguishable from an
 * agent taking five days off, which is exactly why it ran for five days.
 *
 * So the daemon reports its ABILITY TO SEE as a first-class fact, separately
 * from whether it saw anything: which harness is installed and at what version,
 * how many readable sources discovery found, where each cursor stands, when it
 * last reached a verdict, and what code is doing the looking. "Zero sources on
 * an installed harness" then reads as an alarm rather than as quiet.
 *
 * PRIVACY — the same binding as the PE path, and the sentinel test covers this
 * report too. What leaves: harness name, harness version, counts, cursor
 * integers, timestamps, verdict strings, daemon versions. What never
 * leaves: file paths, database paths, table names, session ids, cwd, project
 * names, tool arguments, message content. A cursor is an integer; a source count
 * is an integer. Neither can carry a path.
 */

import { SDK_VERSION } from '../version';
import { RESTART_MECHANISMS, type RestartMechanism } from './restart-hook';

export type CaptureVerdict = 'capturing' | 'zero_sources' | 'idle' | 'unknown';

/**
 * Which witness lane(s) are actually PRODUCING capture on this device.
 *
 * Different programs on a device can use different fixed witnesses: the transcript
 * watcher (reads the harness's own session store) and the OTel receiver (the
 * agent's process exports spans to it). The Atlas class of outage is a device
 * that LOOKS instrumented on both — receiver listening, harness installed — while
 * only ONE lane (or none) actually witnesses anything. OpenClaw 2026.8.2 is
 * exactly this: `diagnostics.otel` is enabled and the receiver listens, but no
 * span is ever exported under real activity (an OpenClaw-side exporter defect),
 * so transcript is the SOLE witness. This field makes a single-witness machine
 * read as single-witness rather than as doubly-covered.
 */
export type WitnessLane = 'transcript' | 'otel' | 'both' | 'none';

/**
 * The set of witness lanes producing capture on a device, in a canonical sorted
 * order. The coarse `WitnessLane` above stays for back-compat (transcript
 * vs otel, the two lanes that historically doubly-cover a turn); this list is the
 * complete truth including the model-proxy lane, so the phone card can show "the
 * proxy lane is live on this machine" without overloading the two-lane enum.
 */
export type WitnessLaneName = 'transcript' | 'otel' | 'model_proxy' | 'process';

/** How the daemon is kept running (closed set). */
export type SupervisionMethod = 'launchd' | 'systemd' | 'cron' | 'scheduled_task' | 'detached' | 'unknown';

/**
 * what brings a daemon with no service manager back after a reboot / instance move (closed
 * set). `shell_rc` the shell-startup restart hook (`observer/restart-hook.ts`) is in place.
 */
export const RESTART_HOOK_KINDS = ['shell_rc'] as const;
export type RestartHookKind = typeof RESTART_HOOK_KINDS[number];

/** The OTel receiver's own live state, as the daemon observes it. */
export interface OtelLaneState {
  /** The OTel plugin is registered and running. */
  active: boolean;
  /** The OTLP receiver socket is bound and listening. */
  receiverListening: boolean;
  /** At least one span has ever reached the receiver (the real-witness proof). */
  spansEverSeen: boolean;
  /** Epoch ms of the last span received; null if none ever arrived. */
  lastSpanAtMs: number | null;
}

const OTEL_LANE_OFF: OtelLaneState = {
  active: false,
  receiverListening: false,
  spansEverSeen: false,
  lastSpanAtMs: null,
};

/** A structure-only fingerprint of traffic the model-proxy forwarded but could
 * not parse. Content-free: a hash + provider + method + a count. */
export interface UnrecognizedProxyFingerprint {
  fingerprint: string;
  provider: string | null;
  method: string;
  count: number;
}

/** The model-proxy receiver's own live state, as the daemon observes it. */
export interface ProxyLaneState {
  /** The model-proxy plugin is registered and running. */
  active: boolean;
  /** The loopback proxy socket is bound and listening. */
  listening: boolean;
  /** At least one model turn has ever been witnessed (the real-witness proof). */
  turnsEverSeen: boolean;
  /** Epoch ms of the last model turn witnessed; null if none ever arrived. */
  lastTurnAtMs: number | null;
  /** Traffic forwarded but unparsed, by shape — never a silent witness of nothing. */
  unrecognized: UnrecognizedProxyFingerprint[];
}

const PROXY_LANE_OFF: ProxyLaneState = {
  active: false,
  listening: false,
  turnsEverSeen: false,
  lastTurnAtMs: null,
  unrecognized: [],
};

/** The process lane's own live state — the fourth lane, agent VMs only. */
export interface ProcessLaneState {
  /** The process-lane plugin is registered and running. */
  active: boolean;
  /** The lane is reading the OS process table (it has polled at least once). */
  watching: boolean;
  /** At least one command act has ever sealed+minted (the real-witness proof). */
  actsEverSealed: boolean;
  /** Epoch ms of the last command act sealed; null if none. */
  lastActAtMs: number | null;
  /** the lane's own state (closed set, `ProcessLanePlugin` PROCESS_LANE_STATES). */
  state?: string | null;
  /** When that state began (a flag restored across a restart keeps the moment it was raised). */
  stateSinceMs?: number | null;
  /** / this window's independent audit — launcher seen running, commands it saw
   * that are due to have sealed, how many of those sealed, and launchers it re-bound the lane to. */
  window?: { launcherLive: boolean; commandsDue: number; commandsDueSealed: number; launcherHeals: number };
}

const PROCESS_LANE_OFF: ProcessLaneState = {
  active: false,
  watching: false,
  actsEverSealed: false,
  lastActAtMs: null,
};

/**
 * Derive the witness lane(s) from the two lanes' live state. PURE and exported so
 * the relay-side collector can re-derive it identically from the stored raw
 * fields (the two live in packages that cannot cross-import).
 *
 * A lane counts as WITNESSING only when it is actually producing:
 *   - transcript: discovery found at least one readable source (`total_sources > 0`);
 *   - otel: the receiver is active AND listening AND has actually seen a span.
 * A listening-but-never-fed OTel receiver is NOT a witness — that is the whole
 * point (it is the OpenClaw case), so `spansEverSeen` is load-bearing here.
 */
export function deriveWitnessLanes(input: { totalSources: number; otel: OtelLaneState }): WitnessLane {
  const transcript = input.totalSources > 0;
  const otel = input.otel.active && input.otel.receiverListening && input.otel.spansEverSeen;
  if (transcript && otel) return 'both';
  if (transcript) return 'transcript';
  if (otel) return 'otel';
  return 'none';
}

/**
 * The COMPLETE set of witness lanes actually producing capture, including the
 * model-proxy. A lane counts as witnessing only when it is producing:
 * - transcript: discovery found ≥1 readable source;
 * - otel: receiver active + listening + a span actually seen;
 * - model_proxy: proxy active + listening + a model turn actually witnessed.
 * A listening-but-never-fed lane is NOT a witness — the whole point of the
 * `*EverSeen` fields. Sorted + deduped for a deterministic wire shape.
 */
export function deriveWitnessLaneNames(input: {
  totalSources: number; otel: OtelLaneState; proxy: ProxyLaneState; process?: ProcessLaneState;
}): WitnessLaneName[] {
  const out: WitnessLaneName[] = [];
  if (input.totalSources > 0) out.push('transcript');
  if (input.otel.active && input.otel.receiverListening && input.otel.spansEverSeen) out.push('otel');
  if (input.proxy.active && input.proxy.listening && input.proxy.turnsEverSeen) out.push('model_proxy');
  // The process lane is producing only once a command has actually sealed — a lane that is
  // merely watching an idle box is NOT a witness (the `*EverSeen` discipline, as for the others).
  if (input.process && input.process.active && input.process.actsEverSealed) out.push('process');
  return out.sort();
}

export interface HarnessHealth {
  harness: string;
  /** Installed harness version when it can be read locally; null otherwise. */
  version: string | null;
  /** Readable sources discovery found for this harness. Zero is the alarm. */
  sources: number;
  /** Containers in play, so a migration is visible as a shape change. */
  containers: Array<'file' | 'sqlite'>;
}

export interface CaptureHealthReport {
  schema: 'capture_health/v1';
  daemon_version: string;
  /** Node major, because the store reader needs 22.5+ and this explains a gap. */
  runtime: string;
  sqlite_readable: boolean;
  harnesses: HarnessHealth[];
  total_sources: number;
  /** Highest cursor per source, summed — a monotonic "how much have we read". */
  cursor_total: number;
  /** Epoch ms of the last time the watcher reached ANY verdict. */
  last_verdict_at_ms: number | null;
  last_verdict: CaptureVerdict;
  /** Epoch ms of the last PE this daemon actually queued. */
  last_capture_at_ms: number | null;
  // --- Sole-witness silence -------------------------------
  /**
   * Records the transcript watcher READ over the report window (recognized or
   * not). Zero means the sources were quiet — a genuinely idle agent, never an
   * alarm. Nonzero with `tool_calls_recognized_in_window === 0` is the alarm:
   * records are flowing but the extractor pulled no tool calls out of them (the
   * Sep-1 outage one layer down — a harness changed its record SHAPE).
   */
  records_consumed_in_window: number;
  /** Tool calls the extractor actually recognized over the report window. */
  tool_calls_recognized_in_window: number;
  // --- Witness lanes (item 5) ----------------------------------------
  /** OTel plugin registered and running. */
  otel_active: boolean;
  /** OTLP receiver socket bound and listening. */
  otel_receiver_listening: boolean;
  /** A span has ever reached the receiver — the OTel lane's real-witness proof. */
  otel_spans_ever_seen: boolean;
  /** Epoch ms of the last span received; null if none ever arrived. */
  otel_last_span_at_ms: number | null;
  /** Which witness lane(s) actually produce capture on this device. */
  lanes: WitnessLane;
  // --- Model-proxy witness lane (Lane 5,) ----------------------------
  /** The model-proxy plugin is registered and running. */
  proxy_active: boolean;
  /** The loopback proxy socket is bound and listening. */
  proxy_listening: boolean;
  /** A model turn has ever been witnessed — the proxy lane's real-witness proof. */
  proxy_turns_ever_seen: boolean;
  /** Epoch ms of the last model turn witnessed; null if none ever arrived. */
  proxy_last_turn_at_ms: number | null;
  /** Traffic the proxy forwarded but could not parse, by shape. */
  proxy_unrecognized: UnrecognizedProxyFingerprint[];
  // --- Process witness lane (Lane 4,) --------------------------------
  /** The process-lane plugin is registered and running (agent VMs only). */
  process_active: boolean;
  /** The lane is reading the OS process table. */
  process_watching: boolean;
  /** A command act has ever sealed+minted on this device — the lane's real-witness proof. */
  process_acts_ever_sealed: boolean;
  /** Epoch ms of the last command act sealed; null if none. */
  process_last_act_at_ms: number | null;
  /** the process lane's state (closed set); null when the lane is not registered. */
  process_lane_state: string | null;
  /** How long `process_lane_state` has stood, in ms (an age, so the relay places it on its own clock);
   *  null when unknown. */
  process_lane_state_age_ms: number | null;
  /** this daemon reports `launcher_changed` only as a flag (a suspicion is the unshown
   * `launcher_unconfirmed`). The relay trusts `launcher_changed` only with this set, because an older
   * daemon said `launcher_changed` for a suspicion too. */
  process_launcher_change_confirmed: boolean;
  /** the audit saw a process matching the recorded launcher running this window. */
  process_launcher_live: boolean;
  /** commands the audit saw the launcher start this window that are due to have sealed. */
  process_commands_due_in_window: number;
  /** of those, how many the lane sealed (none, with some due, is silence). */
  process_commands_due_sealed_in_window: number;
  /** launchers the audit re-bound the lane to this window (discovery had missed them). */
  process_launcher_heals_in_window: number;
  /** The complete witness-lane set, including model_proxy and process (superset of `lanes`). */
  lane_names: WitnessLaneName[];
  // --- Self-update outcome (item 2, ops-dashboard build) --------------------
  /**
   * The daemon's LAST self-update outcome status (e.g. applied / already_current / node_too_old /
   * rejected / pending_bundle). null when the self-update loop has never run (opt-out or first tick).
   * A daemon-only fact the relay cannot re-derive; it lets the console see a device frozen on an
   * old release. Structure-only — a short status token, never a path or payload.
   */
  self_update_outcome: string | null;
  /** Epoch ms of the last self-update attempt; null if none. */
  self_update_at_ms: number | null;
  /** The release version the daemon last applied/attempted; null if unknown. */
  self_update_version: number | null;
  // --- Blind-but-healthy + supervision (Grok Bot VM findings) ----------------
  /** Agent harness homes present on this machine, configured locally. */
  detected_harness_homes: string[];
  /** How this daemon is kept running (closed set). */
  supervision_method: SupervisionMethod;
  /** Under cron: whether a cron daemon process is running (null when not cron / unknowable). */
  cron_alive: boolean | null;
  /**
   * the restart mechanism beside `supervision_method` (closed set): `shell_rc` when the
   * shell-startup restart hook is in place (a detached / cron Linux box), null otherwise. A fact
   * about restarts only.
   */
  restart_hook: RestartHookKind | null;
  /**
   * what actually restarts this daemon (closed set) — a service
   * manager, a running cron, a startup file this box's shell really sources (`shell_rc`),
   * or the agent (`agent` nothing on the box does; the agent keeps it running as setup).
   * Null when unknown. The console alarms on a dark device on every box.
   */
  restart_mechanism: RestartMechanism | null;
  /** Epoch ms of the last work PE this daemon submitted on ANY lane; null if none. */
  last_work_pe_at_ms: number | null;
  format_broken_programs: string[];
  reported_at_ms: number;
}

export interface CaptureHealthInput {
  harnesses: HarnessHealth[];
  cursorTotal: number;
  lastVerdictAtMs: number | null;
  lastVerdict: CaptureVerdict;
  lastCaptureAtMs: number | null;
  sqliteReadable: boolean;
  nowMs: number;
  nodeVersion?: string;
  /** OTel receiver state; defaults to "off" when the lane is absent. */
  otel?: OtelLaneState;
  /** Model-proxy lane state; defaults to "off" when the lane is absent. */
  proxy?: ProxyLaneState;
  /** Process lane state; defaults to "off" when the lane is absent. */
  process?: ProcessLaneState;
  /** records read this window; default 0 when the caller has no counter. */
  recordsConsumedInWindow?: number;
  /** tool calls recognized this window; default 0. */
  toolCallsRecognizedInWindow?: number;
  /** item 2: the daemon's last self-update outcome; default null when the loop never ran. */
  selfUpdate?: { outcome: string | null; atMs: number | null; version: number | null };
  /** Harness homes present (closed-set names); default []. */
  detectedHarnessHomes?: string[];
  supervision?: { method: SupervisionMethod; cronAlive: boolean | null };
  /** the restart hook in effect; default null. */
  restartHook?: RestartHookKind | null;
  /** what actually restarts the daemon; default null. */
  restartMechanism?: RestartMechanism | null;
  lastWorkPeAtMs?: number | null;
  formatBrokenPrograms?: string[];
}

/**
 * Build the report. Pure, so the privacy property is provable by inspection of
 * one function rather than by trusting every call site.
 */
export function buildCaptureHealthReport(input: CaptureHealthInput): CaptureHealthReport {
  const otel = input.otel ?? OTEL_LANE_OFF;
  const proxy = input.proxy ?? PROXY_LANE_OFF;
  const processLane = input.process ?? PROCESS_LANE_OFF;
  const totalSources = input.harnesses.reduce((n, h) => n + h.sources, 0);
  return {
    schema: 'capture_health/v1',
    daemon_version: SDK_VERSION,
    runtime: `node${(input.nodeVersion ?? process.version).replace(/^v/, '').split('.')[0]}`,
    sqlite_readable: input.sqliteReadable,
    harnesses: input.harnesses.map((h) => ({
      harness: h.harness,
      version: h.version,
      sources: h.sources,
      containers: [...new Set(h.containers)].sort(),
    })),
    total_sources: totalSources,
    cursor_total: input.cursorTotal,
    last_verdict_at_ms: input.lastVerdictAtMs,
    last_verdict: input.lastVerdict,
    last_capture_at_ms: input.lastCaptureAtMs,
    records_consumed_in_window: input.recordsConsumedInWindow ?? 0,
    tool_calls_recognized_in_window: input.toolCallsRecognizedInWindow ?? 0,
    otel_active: otel.active,
    otel_receiver_listening: otel.receiverListening,
    otel_spans_ever_seen: otel.spansEverSeen,
    otel_last_span_at_ms: otel.lastSpanAtMs,
    lanes: deriveWitnessLanes({ totalSources, otel }),
    proxy_active: proxy.active,
    proxy_listening: proxy.listening,
    proxy_turns_ever_seen: proxy.turnsEverSeen,
    proxy_last_turn_at_ms: proxy.lastTurnAtMs,
    proxy_unrecognized: dedupeProxyFingerprints(proxy.unrecognized),
    process_active: processLane.active,
    process_watching: processLane.watching,
    process_acts_ever_sealed: processLane.actsEverSealed,
    process_last_act_at_ms: processLane.lastActAtMs,
    process_lane_state: processLane.state ?? null,
    process_lane_state_age_ms: typeof processLane.stateSinceMs === 'number' ? Math.max(0, input.nowMs - processLane.stateSinceMs) : null,
    process_launcher_change_confirmed: processLane.state === 'launcher_changed',
    process_launcher_live: processLane.window?.launcherLive === true,
    process_commands_due_in_window: processLane.window?.commandsDue ?? 0,
    process_commands_due_sealed_in_window: processLane.window?.commandsDueSealed ?? 0,
    process_launcher_heals_in_window: processLane.window?.launcherHeals ?? 0,
    lane_names: deriveWitnessLaneNames({ totalSources, otel, proxy, process: processLane }),
    self_update_outcome: input.selfUpdate?.outcome ?? null,
    self_update_at_ms: input.selfUpdate?.atMs ?? null,
    self_update_version: input.selfUpdate?.version ?? null,
    detected_harness_homes: [...new Set((input.detectedHarnessHomes ?? []).filter((h) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(h)))].sort(),
    supervision_method: input.supervision?.method ?? 'unknown',
    cron_alive: input.supervision?.cronAlive ?? null,
    restart_hook: input.restartHook != null && (RESTART_HOOK_KINDS as readonly string[]).includes(input.restartHook)
      ? input.restartHook : null,
    restart_mechanism: input.restartMechanism != null && RESTART_MECHANISMS.includes(input.restartMechanism)
      ? input.restartMechanism : null,
    last_work_pe_at_ms: input.lastWorkPeAtMs ?? null,
    format_broken_programs: (input.formatBrokenPrograms ?? []).filter(h => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(h)),
    reported_at_ms: input.nowMs,
  };
}

/** Dedupe proxy fingerprints by fingerprint and sort — same stability rule. */
function dedupeProxyFingerprints(fps: UnrecognizedProxyFingerprint[]): UnrecognizedProxyFingerprint[] {
  const byFp = new Map<string, UnrecognizedProxyFingerprint>();
  for (const f of fps) if (!byFp.has(f.fingerprint)) byFp.set(f.fingerprint, f);
  return [...byFp.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

/**
 * The SOLE-WITNESS SILENCE alarm — the Sep-1 outage one layer
 * down. Sources are readable and records ARE flowing (the watcher read some this
 * window), but the extractor recognized ZERO tool calls. That is a harness whose
 * unrecognized record SHAPE under a reader that still finds the store. Known
 * tool-free responses and ignored records remain healthy. Parsed, but
 * blind to the work. Distinct from genuine idle — an idle agent produces NO
 * records this window (`records_consumed_in_window === 0`), which never alarms.
 */
/** The process lane's silence (, the 09-12 parity): the independent audit saw the recorded
 * launcher running and starting commands that are past the time they must have sealed by, and the
 * lane sealed none of them. An idle agent (no commands due) never alarms. */
export function isProcessLaneSilent(report: CaptureHealthReport): boolean {
  return report.process_active
    && report.process_launcher_live
    && report.process_commands_due_in_window > 0
    && report.process_commands_due_sealed_in_window === 0;
}

/** The fix the agent runs, once, from its own session, when no launcher is recorded. */
export const PROCESS_LANE_RECORD_COMMAND = '"$HOME/.provian/bin/provian" process-lane record';

/** The process lane is this agent's witness and has no launcher record (follow-up). Same order
 * and rule as the relay (`routes/devices.ts`). */
export function isProcessLaneUnrecorded(report: CaptureHealthReport): boolean {
  return report.process_active
    && report.process_lane_state === 'no_launcher'
    && report.total_sources === 0
    && !(report.otel_active && report.otel_receiver_listening && report.otel_spans_ever_seen)
    && !(report.proxy_active && report.proxy_listening && report.proxy_turns_ever_seen);
}

export function isSoleWitnessSilent(report: CaptureHealthReport): boolean {
  return (
    report.last_verdict === 'unknown'
    && report.total_sources > 0
    && report.records_consumed_in_window > 0
    && report.tool_calls_recognized_in_window === 0
  );
}

/**
 * Why is this report an alarm (or null if it is not)? Two reasons, in priority:
 * a blind harness (nothing readable) beats a silent one (readable but no tool
 * calls recognized), since a blind harness cannot even reach the silence test.
 */
export function captureBrokenReason(
  report: CaptureHealthReport,
): 'no_readable_sources' | 'sole_witness_silence' | 'session_format_broken' | 'process_launcher_changed' | 'process_launcher_not_seen' | 'process_no_launcher' | 'process_launcher_unsupported' | 'process_lane_silence' | null {
  if (report.format_broken_programs.length) return 'session_format_broken';
  // The same order the relay judges in (`routes/devices.ts`), so the agent's doctor and the console
  // name the same reason ( ).
  if (report.harnesses.length > 0) {
    // PER-HARNESS, not a device total. A device can run two harnesses; if OpenClaw
    // reads zero sources while a second harness reads three, the device SUM is
    // three and a total-based rule calls it healthy — which is the exact Atlas
    // shape (one harness migrated its store out from under a file-only reader)
    // reporting as fine. The alarm is "an installed harness we can see NOTHING
    // from", and a single blind harness is enough to raise it.
    if (report.harnesses.some((h) => h.sources === 0)) return 'no_readable_sources';
  }
  if (isSoleWitnessSilent(report)) return 'sole_witness_silence';
  // addition 1, as the design requires it : no live process matches the recorded launcher's
  // fingerprint, or the launcher's wrapper changed and the agent's own commands did not re-record it.
  // The unshown suspicion (`launcher_unconfirmed`) is never an alarm.
  if (report.process_active && report.process_lane_state === 'launcher_changed' && report.process_launcher_change_confirmed) return 'process_launcher_changed';
  if (report.process_active && report.process_lane_state === 'launcher_not_seen') return 'process_launcher_not_seen';
  // follow-up : the lane is this agent's witness and no launcher is recorded,
  // so it witnesses none of the agent's commands. An agent another lane witnesses never shows it: the
  // lane is then `inert_other_lane`, and producing session files, OTel or proxy overrule it here too.
  if (isProcessLaneUnrecorded(report)) return 'process_no_launcher';
  // : the harness hands each command to its child itself; the lane cannot serve it.
  if (report.process_active && report.process_lane_state === 'launcher_unsupported') return 'process_launcher_unsupported';
  // / the launcher is live and launching matching commands, but nothing seals.
  if (isProcessLaneSilent(report)) return 'process_lane_silence';
  return null;
}

/**
 * Is this report an alarm?
 *
 * Two rules now : the original Atlas rule — a harness is
 * installed and we can read NOTHING from it — AND its next layer, sole-witness
 * silence (readable, records flowing, zero tool calls recognized). Both mean the
 * device is NOT producing capture; neither is "we saw no work" (an idle agent),
 * which stays quiet.
 */
export function isCaptureBroken(report: CaptureHealthReport): boolean {
  return captureBrokenReason(report) !== null;
}

/** One line an operator can read without decoding JSON. */
export function describeCaptureHealth(report: CaptureHealthReport): string {
  const reason = captureBrokenReason(report);
  // A process-lane box (an agent VM) has no harness files; its own alarms must still be named.
  if (reason === 'process_launcher_changed') return 'NOT RECEIVING — the agent must re-record its launcher (process-lane record)';
  if (reason === 'process_launcher_not_seen') return 'NOT RECEIVING — no running program matches the recorded launcher; the agent re-records it (process-lane record)';
  if (reason === 'process_no_launcher') return `NOT RECEIVING — no launcher is recorded, so none of the agent's commands are witnessed; the agent runs ${PROCESS_LANE_RECORD_COMMAND} once from its own session`;
  if (reason === 'process_lane_silence') return 'NOT RECEIVING — the launcher is running the agent\'s commands but none sealed';
  if (reason === 'process_launcher_unsupported') return 'NOT RECEIVING — this harness hands each command to its child itself, so the process lane cannot tell its commands from its own programs';
  if (report.harnesses.length === 0) return 'no agent harness installed on this device';
  const parts = report.harnesses.map(
    (h) => `${h.harness}${h.version ? ` ${h.version}` : ''}: ${h.sources} source(s)${h.containers.length ? ` [${h.containers.join('+')}]` : ''}`,
  );
  const head = reason === 'session_format_broken' ? 'NOT RECEIVING — the agent must re-describe its session format'
    : reason === 'no_readable_sources'
    ? 'NOT RECEIVING — an agent harness is installed but nothing is readable'
    : reason === 'sole_witness_silence'
      ? 'NOT RECEIVING — records are readable but the parser recognized no tool calls'
      : 'receiving';
  // The complete witness set — includes the model_proxy lane — so a
  // proxy-only device (no transcript harness) still reads as witnessed.
  const witness = report.lane_names.length > 0 ? report.lane_names.join('+') : report.lanes;
  const proxyNote = report.proxy_active
    ? ` · proxy=${report.proxy_turns_ever_seen ? 'live' : (report.proxy_listening ? 'listening' : 'off')}`
    : '';
  const processNote = report.process_active
    ? ` · process=${report.process_acts_ever_sealed ? 'live' : (report.process_watching ? 'watching' : 'off')}${report.process_lane_state === 'launcher_unconfirmed' ? ' (unrecognised launcher children; a provian command re-records the wrapper)' : ''}`
    : '';
  return `${head} · witness=${witness}${proxyNote}${processNote} · ${parts.join(' · ')}`;
}

/**
 * Which known agent harness homes exist under `home` (closed-set names only —
 * never a path). Never throws.
 */
export function detectHarnessHomes(home: string, _isDir: (p: string) => boolean): string[] {
  try { return new ProgramWitnessRegistry(programWitnessPath(home)).programs().map(p => p.program).sort(); } catch { return []; }
}
