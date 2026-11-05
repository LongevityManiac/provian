import { isDoctorProbeTrace, DOCTOR_PROBE_LOG_LINE, DOCTOR_PROBE_TOOL_NAMES, DOCTOR_PROBE_ORCHESTRATION_NAME } from '../doctor-probe';
import * as http from 'http';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ObserverPlugin } from './PluginInterface';
import type { ProvianObserver } from '../ProvianObserver';
import type { PluginContribution, PluginPE, SessionState } from '../types';
import type { PECommitOutcome } from './PluginInterface';
import type { InputOrigin } from '../../input-origins';
import { PeerAttributor } from '../peer-process';
import { ProgramWitnessRegistry, hash, writeLocal } from '../program-witness';
import { resolvableOrigin } from '../origin-capture';
import { mimeEssence, screenBrowserAndHost } from './loopback-guard';
import { cliCommand, HOSTED_BUNDLE } from '../../cli-command';
import { listenWithRetry } from './port-retry';

export const OTLP_DEFAULT_PORT = 4318;
export const OTLP_BIND_HOST = '127.0.0.1';
/** OTLP/HTTP body encodings the receiver decodes (exact MIME essences,). */
export const OTLP_CONTENT_TYPES: readonly string[] = ['application/json', 'application/x-protobuf', 'application/protobuf'];

/**
 * A trace whose spans stopped arriving this long ago is flushed and classified.
 * OTel BatchSpanProcessor exports on span-end with a default 5s schedule and a
 * parent (turn) span ends AFTER its children, so a multi-tool turn can arrive
 * across several export batches. Idle-flush accumulates the whole turn before
 * classifying, so `tool_count` reflects the real turn, not one batch of it.
 */
export const TRACE_IDLE_FLUSH_MS = 15_000;
/** Memory guards for the per-trace accumulator and the flushed-trace guard. */
const MAX_OPEN_TRACES = 50_000;

/**
 * Relay intake floor for `agent_tool_orchestration` (devices.ts: metadata.tool_count >= 1).
 *
 * "EVERY ACT MINTS ONCE AT ITS BEST-SUPPORTED VALUE". A turn
 * with ONE tool call is a PE — the prior 2+ floor discarded genuine single-tool
 * work, and there is no anti-Sybil case for it: device registration, attestation
 * tier, novelty decay, and mint-once are the anti-Sybil controls, not a minimum
 * count. So this floor is now 1: a turn must contain at least one real tool call
 * to be tool-orchestration (a zero-tool OTel trace is still correctly nothing —
 * `no_tool_activity`). The relay literal in `devices.ts` is bound to this constant
 * by `orchestration-floor-parity.test.ts` (source-read) so the two can't diverge.
 */
export const MIN_ORCHESTRATION_TOOL_CALLS = 1;

/**
 * Relay intake floor for `agent_api_orchestration` (devices.ts: metadata.api_count >= 1).
 * Same 2026-as the tool floor (which this mirrored at 2): one external
 * API hop is a PE; a zero-hop trace is still nothing. Bound to the relay literal by
 * `orchestration-floor-parity.test.ts`.
 */
export const MIN_ORCHESTRATION_API_CALLS = 1;

/**
 * Self-diagnosis (Lever 4). If the receiver has been listening this long with
 * ZERO spans ever received, emit ONE line saying so. This is the anti-silent-
 * failure device: "receiver up, no agent connected" is the signal that would
 * have surfaced the OpenClaw "endpoint set but harness emits nothing" case
 * immediately, instead of leaving an agent silently earning nothing.
 */
export const NO_SPAN_WARN_MS = 5 * 60 * 1000;

/**
 * Decide whether the one-shot no-span warning should fire now. Pure and
 * exported so the exact predicate (including its negative cases) is unit-testable
 * without binding a real receiver or a real clock.
 */
export function shouldWarnNoSpans(state: {
  active: boolean;
  receiverListening: boolean;
  spansEverSeen: boolean;
  alreadyWarned: boolean;
  receiverUpSinceMs: number | null;
  nowMs: number;
  thresholdMs: number;
}): boolean {
  if (!state.active) return false;
  if (!state.receiverListening) return false;   // no receiver → nothing to diagnose
  if (state.spansEverSeen) return false;         // spans arriving → all good
  if (state.alreadyWarned) return false;         // one-shot
  if (state.receiverUpSinceMs == null) return false;
  return state.nowMs - state.receiverUpSinceMs >= state.thresholdMs;
}


/** OTel SpanKind enum values we discriminate on (proto/JSON both normalize here). */
const SPAN_KIND_SERVER = 2;
const SPAN_KIND_CLIENT = 3;

/**
 * True if a local OTel-instrumented agent framework is reachable from the
 * current environment. Exported so callers (e.g. register-device) can decide
 * whether to pre-populate OTEL_EXPORTER_OTLP_ENDPOINT on the service unit.
 */
export function detectOTelFramework(): boolean {
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return true;
  if (process.env.OTEL_SERVICE_NAME) return true;
  return detectAgentHarness() != null;
}

/**
 * Return the name of a known agent harness running on this host (the first match
 * from KNOWN_AGENT_PROCESSES), or null. Used by `npx @provian/agent-sdk start`/`npx @provian/agent-sdk doctor`
 * to name the detected harness and print its exact enable step. Unlike
 * detectOTelFramework it does NOT consider OTEL_* env vars — it answers "which
 * harness is running", not "is any OTel target reachable".
 */
export function detectAgentHarness(): string | null {
  return new ProgramWitnessRegistry().programs().find(p => p.lane === 'otel')?.program ?? null;
}

/**
 * Auto-detects a local OTel-instrumented agent framework. When active, starts
 * a minimal OTLP/HTTP receiver on 127.0.0.1:4318 (localhost only) and routes
 * incoming spans through the per-trace orchestration classifier. When no
 * framework is detected, stays dormant with zero overhead.
 *
 * Captures tool-using work for a program assigned to OTel at setup. Each completed
 * program trace produces one PE: tool orchestration including observed external
 * hosts, or API orchestration when it contains only external API work. Model-only
 * traces never mint. Assignment and socket identity come from the local registry
 * and the operating system; model, provider and sign-in cannot change the lane.
 * Classification uses semantic attributes rather than harness-specific formats.
 */
export interface OTelPluginOptions {
  /**
   * Force the OTLP receiver to start regardless of framework detection.
   * Set true on agent devices (where all compute is agent compute and we
   * always want spans captured, even before any framework is running).
   */
  forceActive?: boolean;
  programRegistry?: ProgramWitnessRegistry;
  peerAttributor?: PeerAttributor | null;
  /** null is an ephemeral test receiver; production persists before acknowledging spans. */
  journalPath?: string | null;
}

/** OTel GenAI operation names that denote a MODEL call (never a tool). */
const MODEL_OPERATIONS = new Set([
  'chat', 'text_completion', 'generate_content', 'embeddings',
]);

/**
 * Compact per-span record retained until flush so the API lane can resolve
 * ancestry (was an HTTP-client span nested under a tool/model span, or is it
 * independent external API orchestration?). Ancestry cannot be decided as
 * spans arrive: OTel exports on span-END and children end before parents, so a
 * child can arrive before the tool span that would exclude it.
 */
interface RetainedSpan {
  spanId: string;
  parentSpanId: string;
  role: SpanRole;
  startTimeUnixMs?:number;
  endTimeUnixMs?:number;
  responseId?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  responseCalls?: Array<{id:string;name:string}>;
  spanStatus: 'ok' | 'error' | 'unknown';
  // Present only when role === 'api'.
  apiHost: string | null;
  apiMethod: string | null;
  apiStatus: number | null;
  apiConvention: HttpConvention | null;
}

/** Accumulated state for one in-flight trace (one agent turn). */
interface TraceAccumulator {
  traceId: string;
  firstStart: number;
  lastEnd: number;
  lastSeenAtMs: number;
  /**
   * The harness (or process) that exported this trace's spans, from the process table: undefined
   * until a span arrives over the receiver; null when unknown, or when spans came from more than one.
   */
  sender?: string | null;
  /** Daemon clock: when its first and last spans arrived. */
  arrivedFirstMs: number;
  arrivedLastMs: number;
  toolNames: string[];
  toolCount: number;
  erroredToolCount: number;
  /** Tool-call correlation ids seen this turn — the cross-source turn anchor. */
  toolCallIds: string[];
  conventions: Set<ToolConvention>;
  /** Non-tool spans seen, for the visible "not classified as tool work" report. */
  otherSpanNames: string[];
  /** Best orchestration/turn span name found (explicit signal, else root). */
  orchestrationName: string | null;
  framework: string | null;
  /** Retained spans for flush-time API-lane ancestry resolution (bounded). */
  spans: RetainedSpan[];
  /** Total spans seen (may exceed spans.length if truncated). */
  spanTotal: number;
  seenSpanIds: Set<string>;
}

export type ToolConvention = 'genai' | 'openinference' | 'openllmetry';
/** Which HTTP semantic-convention family an external-API span was read from. */
export type HttpConvention = 'http-stable' | 'http-legacy';
export type SpanRole = 'tool' | 'orchestration' | 'model' | 'api' | 'other';

export interface SpanRoleResult {
  role: SpanRole;
  toolName?: string;
  convention?: ToolConvention;
  // Tool-call correlation id (GenAI `gen_ai.tool.call.id` + common variants),
  // present only when role === 'tool' and the span carries one. This is the
  // CROSS-SOURCE turn anchor: a harness that both emits OTel and writes a
  // transcript records the SAME call id in both, so both lanes derive the same
  // turn_id (see turn-identity.ts). Null when the shape carries no call id.
  toolCallId?: string | null;
  // External-API (HTTP client) detail, present only when role === 'api'.
  apiHost?: string | null;
  apiMethod?: string | null;
  apiStatus?: number | null;
  apiConvention?: HttpConvention;
}

export class OTelPlugin implements ObserverPlugin {
  readonly name = 'otel';
  private observer!: ProvianObserver;
  private active = false;
  private queue: PluginPE[] = [];
  private server: http.Server | null = null;
  private listeningPort: number | null = null;
  private binding: { retry: () => void; cancel: () => void } | null = null;
  private readonly forceActive: boolean;

  /** Open traces keyed by trace_id, awaiting idle-flush. */
  private readonly traces = new Map<string, TraceAccumulator>();
  /** Durable committed response identity; a late span cannot mint a second PE. */
  private readonly flushed = new Set<string>();
  private readonly spanOwners: Record<string,string> = {};
  /** Durable ancestry survives exporter delays and zero-tool flushes. */
  private readonly spanHistory:Record<string,Record<string,RetainedSpan>>={};
  private traceKey(traceId: string, sender: string | null | undefined): string { return JSON.stringify([sender ?? null,traceId]); }

  // --- Self-diagnosis state (Lever 4) --------------------------------------
  /** True once ANY span has been received — proof the harness is exporting. */
  private spansEverSeen = false;
  /** Epoch ms of the last span received; null until the first one arrives. */
  private lastSpanAtMs: number | null = null;
  /** Wall-clock ms the receiver began listening (null until it binds). */
  private receiverUpSinceMs: number | null = null;
  /** One-shot latch so the no-span warning fires at most once. */
  private noSpanWarned = false;

  private readonly journalPath: string | null;
  private pending: Record<string, PluginPE> = {};
  private readonly brokenPrograms=new Set<string>();
  getFormatBrokenPrograms():string[]{return [...this.brokenPrograms];}
  constructor(options: OTelPluginOptions = {}) {
    this.journalPath = options.journalPath === undefined ? path.join(os.homedir(), ".provian", "otel-program-turns.json") : options.journalPath;
    if (this.journalPath && fs.existsSync(this.journalPath)) {
      const saved = JSON.parse(fs.readFileSync(this.journalPath, "utf8"));
      for (const t of saved.traces ?? []) this.traces.set(this.traceKey(t.traceId,t.sender), { ...t, conventions: new Set(t.conventions), seenSpanIds: new Set(t.seenSpanIds ?? t.spans.map((s: RetainedSpan)=>s.spanId)) });
      Object.assign(this.spanOwners,saved.spanOwners ?? {});
      Object.assign(this.spanHistory,saved.spanHistory ?? {});
      for(const trace of this.traces.values())this.spanHistory[this.traceKey(trace.traceId,trace.sender)]??=Object.fromEntries(trace.spans.map(span=>[span.spanId,span]));
      for (const id of saved.flushed ?? []) this.flushed.add(id);
      this.pending = saved.pending ?? {}; this.queue = Object.values(this.pending);
    }
    this.forceActive = options.forceActive ?? false;
    this.programs = options.programRegistry ?? new ProgramWitnessRegistry();
    this.peers = options.peerAttributor !== undefined ? options.peerAttributor
      : new PeerAttributor({ identifyProgram: p => this.programs.identify(p) });
  }
  private readonly programs: ProgramWitnessRegistry;
  private readonly peers: PeerAttributor | null;
  onCommitted(pe: PluginPE, outcome: PECommitOutcome): void {
    if (outcome === 'failed') { this.queue.push(pe); return; }
    if (pe.idempotencyKey) delete this.pending[pe.idempotencyKey];
    this.save();
  }
  private queueToolPE(pe: PluginPE, _callIds: readonly string[], arrival: { sender: string | null; firstMs: number; lastMs: number }): void {
    if (!this.programs.allows(arrival.sender, 'otel')) return;
    pe.metadata = { ...pe.metadata, program: arrival.sender, source: 'otel' };
    pe.idempotencyKey = String(pe.metadata.turn_id);
    const existing=this.pending[pe.idempotencyKey];
    if(existing){
      // Enrich the same uncommitted PE; callers holding the drained object see
      // this evidence too. A committed seal is never changed or emitted again.
      Object.assign(existing,pe);this.save();return;
    }
    pe.identityDecided = true;
    pe.occurredAtMs = Math.min(Math.trunc(pe.windowEnd), Date.now());
    this.pending[pe.idempotencyKey!] = pe; this.save(); this.queue.push(pe);
  }
  private save(): void {
    if (this.journalPath) writeLocal(this.journalPath, { traces: [...this.traces.values()].map(t => ({...t, conventions: [...t.conventions], seenSpanIds:[...t.seenSpanIds]})), flushed: [...this.flushed], spanOwners:this.spanOwners,spanHistory:this.spanHistory, pending: this.pending });
  }

  async init(observer: ProvianObserver): Promise<void> {
    this.observer = observer;
    this.active = this.forceActive || detectOTelFramework();
  }

  async start(): Promise<void> {
    if (!this.active) {
      this.observer.log('debug', 'otel plugin dormant (no agent framework detected)');
      return;
    }
    this.observer.log('info', 'otel plugin active', {
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
      service: process.env.OTEL_SERVICE_NAME || null,
    });
    await this.startReceiver();
  }

  async stop(): Promise<void> {
    // A restart preserves incomplete traces; it never closes a turn merely because the daemon stopped.
    this.save();
    this.binding?.cancel();
    this.binding = null;
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
      // force-close after 2s if lingering connections
      setTimeout(() => resolve(), 2000).unref();
    });
  }

  /**
   * Idle-flush sweep. Runs on every observer tick (~1s). A trace is classified only after its completed root arrived and exports have
   * been quiet for TRACE_IDLE_FLUSH_MS. An unfinished trace survives restarts.
   */
  tick(_session: SessionState | null): PluginContribution | null {
    if (!this.active) return null;

    const now = Date.now();
    for (const [traceId, acc] of this.traces) {
      if (now - acc.lastSeenAtMs >= TRACE_IDLE_FLUSH_MS) {
        if(this.flushTrace(acc, 'idle')) this.traces.delete(traceId);
      }
    }

    this.save();
    // Self-diagnosis: receiver up for a while but nothing ever arrived. Turns
    // the silent-nothing that hid Atlas's zero-capture into one actionable line.
    if (shouldWarnNoSpans({
      active: this.active,
      receiverListening: this.listeningPort != null,
      spansEverSeen: this.spansEverSeen,
      alreadyWarned: this.noSpanWarned,
      receiverUpSinceMs: this.receiverUpSinceMs,
      nowMs: now,
      thresholdMs: NO_SPAN_WARN_MS,
    })) {
      this.noSpanWarned = true;
      this.observer.log('warn', 'otel receiver up but no agent spans received', {
        endpoint: `http://localhost:${OTLP_DEFAULT_PORT}`,
        waited_ms: NO_SPAN_WARN_MS,
        hint: `Your agent is not exporting OpenTelemetry to the receiver. Set OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${OTLP_DEFAULT_PORT} in the agent's OWN process${HOSTED_BUNDLE ? '' : `, or launch it via \`${cliCommand('run -- <cmd>')}\``}. If your harness does not emit OTel, transcript capture may already cover it — run \`${cliCommand('doctor')}\` to see which path is live.`,
      });
    }
    return null;
  }

  drainPEs(): PluginPE[] {

    const out = this.queue;
    this.queue = [];
    return out;
  }

  /**
   * Ingest a batch of parsed OTLP spans (used by the OTLP receiver and by host
   * integrations that push spans directly). Groups spans into per-trace
   * accumulators; classification happens on idle-flush.
   */
  ingestParsedSpans(spans: ParsedOtlpSpan[], sender: string | null = null): void {
    if (!this.active) return;
    for (const s of spans) this.accumulate(s, sender);
    this.save();
  }

  /** Ingest a single parsed OTLP span. */
  ingestSpan(span: ParsedOtlpSpan): void {
    if (!this.active) return;
    this.accumulate(span);
    this.save();
  }

  isActive(): boolean {
    return this.active;
  }

  /** The lock holder stopped a stray observer: if 4318 was taken at start, try it again now. */
  rebindIfWaiting(): void { this.binding?.retry(); }

  getListeningPort(): number | null {
    return this.listeningPort;
  }

  /** Has ANY span ever reached the receiver? The OTel lane's "is it a real witness". */
  hasSeenSpans(): boolean {
    return this.spansEverSeen;
  }

  /** Epoch ms of the last span received; null if none ever arrived. */
  getLastSpanAtMs(): number | null {
    return this.lastSpanAtMs;
  }

  /** Fold one span into its trace accumulator. */
  private accumulate(s: ParsedOtlpSpan, sender: string | null = null): void {
    // A parsed span reached us — the harness IS exporting to the receiver.
    // Recorded before the traceId guard so even a malformed span counts as
    // "something is emitting" for the self-diagnosis latch.
    this.spansEverSeen = true;
    this.lastSpanAtMs = Date.now();
    if (!s.traceId) return;
    // Other programs cannot contribute to, close or poison this program's turn.
    const probe = s.name===DOCTOR_PROBE_ORCHESTRATION_NAME || DOCTOR_PROBE_TOOL_NAMES.includes(classifySpanRole(s).toolName ?? s.name);
    // A known other lane establishes only the distributed parent boundary; it contributes no work.
    if(sender!==null && (this.programs.allows(sender,'otel') || this.programs.allows(sender,'model_proxy') || this.programs.allows(sender,'transcript'))) this.spanOwners[JSON.stringify([s.traceId,s.spanId])]=sender;
    if (!this.programs.allows(sender,'otel') && !probe) return;
    const key = this.traceKey(s.traceId,sender);
    if (this.flushed.has(key)) {
      this.observer.log('debug', 'otel span for already-flushed trace ignored', {
        trace_id: s.traceId, name: s.name,
      });
      return;
    }

    let acc = this.traces.get(key);
    if (!acc) {
      if (this.traces.size >= MAX_OPEN_TRACES) throw new Error('OTel trace capacity reached; retry export');
      acc = {
        traceId: s.traceId,
        firstStart: s.startTimeUnixMs,
        lastEnd: s.endTimeUnixMs,
        lastSeenAtMs: Date.now(),
        arrivedFirstMs: Date.now(),
        arrivedLastMs: Date.now(),
        toolNames: [],
        toolCount: 0,
        erroredToolCount: 0,
        toolCallIds: [],
        conventions: new Set(),
        otherSpanNames: [],
        orchestrationName: null,
        framework: resolveFramework(s),
        spans: [],
        spanTotal: 0,
        seenSpanIds: new Set(),
        sender,
      };
      this.traces.set(key, acc);
    }

    acc.lastSeenAtMs = Date.now();
    acc.arrivedLastMs = acc.lastSeenAtMs;

    acc.firstStart = Math.min(acc.firstStart, s.startTimeUnixMs);
    acc.lastEnd = Math.max(acc.lastEnd, s.endTimeUnixMs);
    if (!acc.framework) acc.framework = resolveFramework(s);

    // Exporters retry batches; one physical span contributes once, including after restart.
    if (acc.seenSpanIds.has(s.spanId)) return;
    acc.seenSpanIds.add(s.spanId);
    if (sender !== null) this.spanOwners[JSON.stringify([s.traceId,s.spanId])] = sender;
    const role = classifySpanRole(s);

    // Compact ancestry, completion and retry evidence must cover the entire turn.
    // Truncating it would strand a late root and price retried spans twice.
    acc.spanTotal += 1;
    acc.spans.push({
      spanId:s.spanId,parentSpanId:s.parentSpanId,role:role.role,spanStatus:s.status,
      startTimeUnixMs:s.startTimeUnixMs,endTimeUnixMs:s.endTimeUnixMs,
      responseId:typeof s.attributes['gen_ai.response.id']==='string'?s.attributes['gen_ai.response.id'] as string:null,
      toolCallId:role.toolCallId,toolName:role.toolName,
      responseCalls:modelResponseCalls(s),
      apiHost:role.role==='api' ? role.apiHost ?? null : null,
      apiMethod:role.role==='api' ? role.apiMethod ?? null : null,
      apiStatus:role.role==='api' ? role.apiStatus ?? null : null,
      apiConvention:role.role==='api' ? role.apiConvention ?? null : null,
    });
    (this.spanHistory[key]??={})[s.spanId]??=acc.spans.at(-1)!;

    switch (role.role) {
      case 'tool': {
        // Part B : an errored tool call COUNTS toward the
        // mintable tool_count and the MIN_ORCHESTRATION_TOOL_CALLS floor.
        // Observed execution earns; quality is priced by weights + novelty
        // decay, never gated by structural exclusion, and error-recovery arcs
        // are recognized higher-value work (April spec). `errored_tool_calls`
        // stays in metadata as the visible quality signal. The transcript lane
        // counts identically, so the SAME turn prices the SAME regardless of
        // which source claims it.
        acc.toolCount += 1;
        if (s.status === 'error') acc.erroredToolCount += 1;
        if (role.toolName) acc.toolNames.push(role.toolName);
        if (role.convention) acc.conventions.add(role.convention);
        // The observed tool-call correlation: a call id shared with the harness's own
        // transcript makes both lanes derive the same turn_id (turn-identity.ts).
        if (role.toolCallId) acc.toolCallIds.push(role.toolCallId);
        break;
      }
      case 'orchestration': {
        // Prefer an explicitly-signalled orchestration span name; a root span
        // (no parent) is the fallback unit that orchestrated the turn.
        if (!acc.orchestrationName || s.parentSpanId === '') acc.orchestrationName = s.name;
        break;
      }
      case 'api': {
        // External-API hops are counted at flush, where trace ancestry can
        // separate independent orchestration from a tool's own transport.
        break;
      }
      default: {
        // model calls and everything else: recorded so the flush report can
        // state, visibly, what was seen and NOT classified as tool work.
        acc.otherSpanNames.push(role.role === 'model' ? `${s.name} (model)` : s.name);
      }
    }
  }

  /**
   * Classify one completed trace into exactly one PE. A tool turn includes its
   * witnessed API origins; an API-only turn uses the API action type.
   */
  private flushTrace(acc: TraceAccumulator, reason: 'idle' | 'shutdown' | 'evicted'): boolean {
    const key=this.traceKey(acc.traceId,acc.sender);
    if(isDoctorProbeTrace(acc.orchestrationName,acc.toolNames)) {
      this.observer.log('info',DOCTOR_PROBE_LOG_LINE,{trace_id:acc.traceId,tool_calls:acc.toolCount,verdict:'doctor_probe'});this.rememberFlushed(key);return true;
    }
    if(!this.programs.allows(acc.sender??null,'otel'))return true;
    const retained=Object.values(this.spanHistory[key]??Object.fromEntries(acc.spans.map(span=>[span.spanId,span])));
    const byId=new Map(retained.map(s=>[s.spanId,s]));
    const callOwners=new Map<string,string>();
    const groups=new Map<string,Map<string,string>>();
    const declared=new Set<string>();
    const add=(response:string,call:string,name:string)=>{let calls=groups.get(response);if(!calls){calls=new Map();groups.set(response,calls);}calls.set(call,name);};
    for(const span of retained.filter(s=>s.role==='model')) {
      const response=span.responseId??span.spanId;
      if(span.responseCalls?.length)declared.add(response);
      for(const call of span.responseCalls??[]){callOwners.set(call.id,response);add(response,call.id,call.name);}
    }
    let unassociated=0;
    // A late exported parent can still carry additional calls. Only an observed
    // parent or an established other-program boundary closes this response.
    const missingParent=retained.some(span=>span.parentSpanId&&!byId.has(span.parentSpanId)&&!this.spanOwners[JSON.stringify([acc.traceId,span.parentSpanId])]);
    if(missingParent)return false;
    for(const span of retained.filter(s=>s.role==='tool')) {
      let response=span.responseId??(span.toolCallId?callOwners.get(span.toolCallId):undefined);
      let parent=span.parentSpanId;const seen=new Set<string>();
      while(!response&&parent&&!seen.has(parent)){seen.add(parent);const ancestor=byId.get(parent);if(!ancestor)break;if(ancestor.role==='model')response=ancestor.responseId??ancestor.spanId;parent=ancestor.parentSpanId;}
      if(!response){unassociated++;continue;}
      if(!declared.has(response))add(response,span.toolCallId??span.spanId,span.toolName??'tool');
    }
    if(unassociated){if(acc.sender)this.brokenPrograms.add(acc.sender);this.observer.log('warn','capture.otel_response_format_broken',{program:acc.sender,unassociated_tools:unassociated,instruction:'Export completed model-response spans with their response/tool-call IDs or associate each tool span with its model response. Keep the observer running; never submit work yourself.'});return false;}
    if(acc.sender)this.brokenPrograms.delete(acc.sender);
    for(const [response,calls] of groups) {
      const responseKey='or_'+hash(String(acc.sender)+':'+acc.traceId+':'+response);
      if(this.flushed.has(responseKey)&&!this.pending[responseKey])continue;
      const belongs=(span:RetainedSpan):boolean=>{const seen=new Set<string>();let current:RetainedSpan|undefined=span;while(current&&!seen.has(current.spanId)){seen.add(current.spanId);if(current.role==='model')return (current.responseId??current.spanId)===response;if(current.role==='tool'&&(current.responseId||current.toolCallId))return current.responseId===response||!!current.toolCallId&&calls.has(current.toolCallId);current=byId.get(current.parentSpanId);}return false;};
      const members=retained.filter(s=>s.role==='orchestration'||belongs(s));
      const scoped={...acc,firstStart:members.reduce((first,s)=>Math.min(first,s.startTimeUnixMs??acc.firstStart),Infinity),lastEnd:members.reduce((last,s)=>Math.max(last,s.endTimeUnixMs??acc.lastEnd),-Infinity),spans:members,toolNames:[...calls.values()],toolCallIds:[...calls.keys()],toolCount:calls.size,
        erroredToolCount:retained.filter(s=>s.role==='tool'&&s.spanStatus==='error'&&belongs(s)).length};
      this.flushToolDimension(scoped,reason,Math.max(scoped.lastEnd-scoped.firstStart,1),responseKey);
      this.rememberFlushed(responseKey);
      this.programs.captured?.(acc.sender!,'otel',Date.now());
    }
    return true;
  }

  /**
   * Tool lane: count GenAI/OpenInference/OpenLLMetry tool executions and, at
   * 1+, queue one `agent_tool_orchestration` PE. Behavior unchanged from the
   * single-lane implementation.
   */
  private flushToolDimension(
    acc: TraceAccumulator, reason: 'idle' | 'shutdown' | 'evicted', durationMs: number,
    turnId: string,
  ): void {
    const n = acc.toolCount;
    const base = {
      trace_id: acc.traceId,
      tool_calls: n,
      errored_tool_calls: acc.erroredToolCount,
      orchestration_span: acc.orchestrationName,
      unclassified_spans: acc.otherSpanNames.length,
      flush_reason: reason,
    };

    if (n < MIN_ORCHESTRATION_TOOL_CALLS) {
      // Real tool activity below the orchestration threshold, or none at all.
      // Reported visibly rather than dropped silently — and never mislabeled.
      this.observer.log('info', 'otel trace not minted as tool orchestration', {
        ...base,
        verdict: n === 0 ? 'no_tool_activity' : 'below_orchestration_threshold',
        threshold: MIN_ORCHESTRATION_TOOL_CALLS,
      });
      if (acc.otherSpanNames.length > 0) {
        this.observer.log('debug', 'otel spans not classified as tool work', {
          trace_id: acc.traceId, spans: acc.otherSpanNames.slice(0, 50),
        });
      }
      return;
    }

    const convention: string = acc.conventions.size === 1
      ? [...acc.conventions][0]
      : (acc.conventions.size > 1 ? 'mixed' : 'unknown');

    this.queueToolPE({
      actionType: 'agent_tool_orchestration',
      input_origins: this.toolTraceOrigins(acc),
      description: acc.orchestrationName
        ? `${acc.orchestrationName} — ${n} tool calls`
        : `agent turn — ${n} tool calls`,
      metadata: {
        tool: 'provian-observer-otel',
        trace_id: acc.traceId,
        // The cross-source turn identity the relay keys mint-once on (folded
        // into the device-witnessed canonical event → device_occurrence claim).
        // Same turn, both sources → this program trace has exactly one fixed witness.
        turn_id: turnId,
        capture_unit: 'model_response',
        // THE reconciled key. The relay's device lane requires metadata.tool_count
        // (>= 1) for agent_tool_orchestration; the daemon now emits exactly that,
        // so the PE clears intake and a reader recognizes the turn as N tool calls.
        tool_count: n,
        tool_names: uniquePreserveOrder(acc.toolNames).slice(0, 50),
        otel_convention: convention,
        errored_tool_calls: acc.erroredToolCount,
        service: process.env.OTEL_SERVICE_NAME || null,
      },
      compute: {
        duration_ms: durationMs,
        // Tokens are a MODEL-call signal and have no place on the tool path.
        tokens_processed: null,
        records_processed: null,
        output_cardinality: null,
        cpu_seconds: null,
        memory_peak_mb: null,
        energy_joules: null,
        gpu_seconds: null,
        model_parameters: null,
        framework: acc.framework,
        hardware_class: null,
      },
      windowStart: acc.firstStart,
      windowEnd: acc.lastEnd,
    }, acc.toolCallIds, { sender: acc.sender ?? null, firstMs: acc.arrivedFirstMs, lastMs: acc.arrivedLastMs });

    this.observer.log('info', 'PE queued from OTel trace', {
      ...base,
      action_type: 'agent_tool_orchestration',
      verdict: 'emitted',
      otel_convention: convention,
      tool_names: uniquePreserveOrder(acc.toolNames).slice(0, 10),
    });
  }

  /** All successful external hosts actually observed in this completed tool turn. */
  private toolTraceOrigins(acc: TraceAccumulator): InputOrigin[] {
    const witness=this.observer.observerDeviceWitness?.() ?? null;
    const byId=new Map(acc.spans.map(s=>[s.spanId,s]));
    const isModelTransport=(span:RetainedSpan):boolean=>{
      const seen=new Set<string>();let parent=span.parentSpanId;
      while(parent){if(seen.has(parent))return true;seen.add(parent);const p=byId.get(parent);if(!p)return true;if(p.role==='tool')return false;if(p.role==='model')return true;parent=p.parentSpanId;}return false;
    };
    const hosts=[...new Set(acc.spans.filter(s=>s.role==='api' && s.apiHost && s.spanStatus!=='error' && (s.apiStatus===null || s.apiStatus<400) && !isModelTransport(s)).map(s=>s.apiHost!.toLowerCase()))];
    return hosts.map(host=>resolvableOrigin(`domain:${host}`,witness));
  }

  private rememberFlushed(traceId: string): void {
    this.flushed.add(traceId);
    // A response's mint-once identity never expires because an exporter replays late.
  }

  private async startReceiver(): Promise<void> {
    this.binding?.cancel();
    const binding = listenWithRetry({
      create: () => {
        const server = http.createServer((req, res) => this.handle(req, res));
        server.on('clientError', (_err, socket) => {
          try { socket.destroy(); } catch { /* ok */ }
        });
        return server;
      },
      port: OTLP_DEFAULT_PORT,
      host: OTLP_BIND_HOST,
      onBound: (server) => {
        this.server = server;
        this.listeningPort = OTLP_DEFAULT_PORT;
        this.receiverUpSinceMs = Date.now();
        this.observer.log('info', `OTel receiver listening on http://localhost:${OTLP_DEFAULT_PORT}`);
        this.observer.log('info', 'Agent frameworks will export spans here automatically (OTLP/HTTP protobuf or JSON)');
      },
      onInUse: (first) => {
        if (first) this.observer.log('warn', 'otel receiver: port 4318 in use; skipping start', {
          hint: 'Another OTLP collector is running. Observer will still generate session PEs.',
        });
      },
      onError: (err) => this.observer.log('warn', 'otel receiver: listen failed', { error: err.message }),
    });
    this.binding = binding;
    await binding.first;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // a browser page can never feed this receiver. Browser-only headers
    // (Origin, Sec-Fetch-Site/Dest/User) and a non-loopback Host (DNS rebinding)
    // are refused 403 before routing. OTLP exporters (Node/Go/Rust/Python http
    // clients) send none of them.
    const refused = screenBrowserAndHost(req, req.socket.localPort);
    if (refused) {
      res.writeHead(refused.status);
      res.end();
      return;
    }
    if (req.method !== 'POST' || (req.url !== '/v1/traces' && req.url !== '/v1/traces/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    // OTLP/HTTP ships two encodings. protobuf is the exporter default (and the
    // only encoding some exporters, e.g. OpenClaw, produce); JSON is the other.
    // The essence is PARSED and matched exactly — the old substring test
    // admitted `text/plain; application/json`, a type a page can send no-cors.
    const essence = mimeEssence(req.headers['content-type']);
    if (essence === null || !OTLP_CONTENT_TYPES.includes(essence)) {
      res.writeHead(415);
      res.end();
      return;
    }
    const isProtobuf = essence !== 'application/json';
    // Who sent it, from the process table — looked up while the connection is open.
    const sender: Promise<string | null> = this.peers ? this.peers.attribute(req.socket) : Promise.resolve(null);
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 10 * 1024 * 1024; // 10 MB
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let spans: ParsedOtlpSpan[];
      try {
        if (isProtobuf) {
          spans = parseOtlpTracePayload(decodeOtlpTraceProtobuf(body));
        } else {
          spans = parseOtlpTracePayload(JSON.parse(body.toString('utf-8')));
        }
      } catch (err) {
        this.observer.log('warn', 'otel receiver: parse error', {
          encoding: isProtobuf ? 'protobuf' : 'json', error: (err as Error).message,
        });
        res.writeHead(400);
        res.end();
        return;
      }
      void sender.catch(() => null).then((from) => {
        try {
          this.ingestParsedSpans(spans, from);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"partialSuccess":{}}');
        } catch (err) {
          this.observer.log('warn', 'otel receiver: ingest error', { error: (err as Error).message });
          res.writeHead(503);
          res.end();
        }
      });
    });
    req.on('error', () => {
      try { res.writeHead(400); res.end(); } catch { /* ok */ }
    });
  }
}

// ============================================================================
// Tool-orchestration classification (pure - exported for unit testing)
//
// Framework-agnostic: keys ONLY on OTel semantic-convention attributes, never
// on a framework name. Covers the official GenAI conventions plus the two most
// common shipped variants (OpenInference, OpenLLMetry) because not all
// instrumentation uses the official attribute names.
// ============================================================================

/**
 * Classify a span's role from semantic-convention attributes.
 *
 * TOOL execution (what this lane counts):
 *   - GenAI:        gen_ai.operation.name == 'execute_tool'  (tool: gen_ai.tool.name)
 *   - OpenInference: openinference.span.kind == 'TOOL'        (tool: tool.name)
 *   - OpenLLMetry:  traceloop.span.kind == 'tool'            (tool: traceloop.entity.name)
 *   - Generic:      a tool-name attribute present on a non-model span
 *
 * ORCHESTRATION / turn (the unit that orchestrated the tools):
 *   - GenAI:        gen_ai.operation.name in {invoke_agent, create_agent}
 *   - OpenInference: openinference.span.kind in {AGENT, CHAIN}
 *   - OpenLLMetry:  traceloop.span.kind in {workflow, agent}
 *   - Root span (no parent) is the fallback orchestration unit.
 *
 * MODEL call (explicitly NOT tool work; tokens live here, never in the tool path):
 *   - GenAI:        gen_ai.operation.name in {chat, text_completion, generate_content, embeddings}
 *   - OpenInference: openinference.span.kind == 'LLM'
 *
 * EXTERNAL API call (the agent_api_orchestration lane; checked AFTER tool+model
 * so a tool/model span with HTTP attributes stays a tool/model):
 *   - HTTP stable:  SpanKind=CLIENT with `http.request.method` (host: `server.address`/`url.full`)
 *   - HTTP legacy:  `http.method` with `net.peer.name`/`http.url`
 *   - SERVER (inbound) spans are never external API calls.
 */
export function classifySpanRole(span: ParsedOtlpSpan): SpanRoleResult {
  const a = span.attributes;
  const op = lower(stringAttr(a['gen_ai.operation.name']));
  const oiKind = upper(stringAttr(a['openinference.span.kind']));
  const tlKind = lower(stringAttr(a['traceloop.span.kind']));

  // --- TOOL execution -------------------------------------------------------
  const callId = toolCallIdFor(a);
  if (op === 'execute_tool') {
    return { role: 'tool', convention: 'genai', toolName: toolNameFor(a, span.name, 'genai'), toolCallId: callId };
  }
  if (oiKind === 'TOOL') {
    return { role: 'tool', convention: 'openinference', toolName: toolNameFor(a, span.name, 'openinference'), toolCallId: callId };
  }
  if (tlKind === 'tool') {
    return { role: 'tool', convention: 'openllmetry', toolName: toolNameFor(a, span.name, 'openllmetry'), toolCallId: callId };
  }
  // Generic: an explicit tool-name attribute on a span that is NOT a model call.
  const genericToolName = stringAttr(a['gen_ai.tool.name']) || stringAttr(a['tool.name']);
  if (genericToolName && !MODEL_OPERATIONS.has(op ?? '') && oiKind !== 'LLM') {
    return { role: 'tool', convention: 'genai', toolName: genericToolName, toolCallId: callId };
  }

  // --- MODEL call (explicitly not tool work) --------------------------------
  if ((op && MODEL_OPERATIONS.has(op)) || oiKind === 'LLM') {
    return { role: 'model' };
  }

  // --- EXTERNAL API call (HTTP client) --------------------------------------
  // A span that is neither a tool nor a model call but carries HTTP CLIENT
  // semantics is an outbound external-API hop. Whether it counts as INDEPENDENT
  // API orchestration (vs a tool's own transport) is decided later by trace
  // ancestry — here we only recognize the shape.
  const http = httpClientDetail(span);
  if (http) {
    return {
      role: 'api',
      apiHost: http.host,
      apiMethod: http.method,
      apiStatus: http.status,
      apiConvention: http.convention,
    };
  }

  // --- ORCHESTRATION / turn -------------------------------------------------
  if (op === 'invoke_agent' || op === 'create_agent') return { role: 'orchestration' };
  if (oiKind === 'AGENT' || oiKind === 'CHAIN') return { role: 'orchestration' };
  if (tlKind === 'workflow' || tlKind === 'agent') return { role: 'orchestration' };
  if (span.parentSpanId === '') return { role: 'orchestration' };

  return { role: 'other' };
}

/**
 * The tool-call correlation id, if the span carries one. The GenAI convention
 * is `gen_ai.tool.call.id`; the common instrumentation variants
 * (`tool_call.id`, `tool.call.id`) are accepted too. Returns null when absent —
 * many emitters do not set it, in which case the turn falls back to its own
 * trace id for identity (turn-identity.ts). Convention-independent: the same
 * key set is checked for every tool span.
 */
function toolCallIdFor(a: Record<string, unknown>): string | null {
  return stringAttr(a['gen_ai.tool.call.id'])
    || stringAttr(a['tool_call.id'])
    || stringAttr(a['tool.call.id'])
    || null;
}

function toolNameFor(
  a: Record<string, unknown>, spanName: string, convention: ToolConvention,
): string {
  if (convention === 'openinference') {
    return stringAttr(a['tool.name'])
      || stringAttr(a['tool_call.function.name'])
      || stringAttr(a['gen_ai.tool.name'])
      || spanName;
  }
  if (convention === 'openllmetry') {
    return stringAttr(a['traceloop.entity.name'])
      || stringAttr(a['gen_ai.tool.name'])
      || spanName;
  }
  return stringAttr(a['gen_ai.tool.name']) || stringAttr(a['tool.name']) || spanName;
}

function resolveFramework(s: ParsedOtlpSpan): string | null {
  return stringAttr(s.resourceAttributes['telemetry.sdk.name'])
    || stringAttr(s.resourceAttributes['service.name'])
    || s.scopeName
    || null;
}

// ---- External-API (HTTP client) recognition --------------------------------

interface HttpClientDetail {
  host: string | null;
  method: string;
  status: number | null;
  convention: HttpConvention;
}

/**
 * Recognize an OTLP span as an outbound HTTP client call (an external API hop).
 * Keys only on OTel HTTP semantic-convention attributes — stable
 * (`http.request.method`, `server.address`, `url.full`, `http.response.status_code`)
 * and the still-common legacy names (`http.method`, `net.peer.name`, `http.url`,
 * `http.status_code`). Returns null for anything that is not a client call.
 *
 * A SERVER (inbound) span is never an outbound call. When SpanKind is
 * unspecified, a client call is inferred from the presence of a destination
 * attribute, so an inbound span carrying only method + route is not misread.
 * Only the HOST is captured (never the full URL) — no path or query ever
 * reaches a PE.
 */
function httpClientDetail(span: ParsedOtlpSpan): HttpClientDetail | null {
  // Inbound spans are the agent receiving a request, not orchestrating an API.
  if (span.spanKind === SPAN_KIND_SERVER) return null;

  const a = span.attributes;
  const stableMethod = stringAttr(a['http.request.method']);
  const legacyMethod = stringAttr(a['http.method']);
  const method = stableMethod || legacyMethod;
  if (!method) return null;
  const convention: HttpConvention = stableMethod ? 'http-stable' : 'http-legacy';

  const serverAddr = stringAttr(a['server.address']) || stringAttr(a['net.peer.name']);
  const urlFull = stringAttr(a['url.full']) || stringAttr(a['http.url']);
  const hasDestination = serverAddr != null || urlFull != null;

  // Definitive when SpanKind=CLIENT; otherwise require a destination attribute
  // so a method-only span is not assumed to be an outbound call.
  if (span.spanKind !== SPAN_KIND_CLIENT && !hasDestination) return null;

  const host = withoutUserinfo(serverAddr || hostFromUrl(urlFull));
  const status = numericAttr(a['http.response.status_code']) ?? numericAttr(a['http.status_code']);
  return { host, method, status, convention };
}

/**
 * drop any `user[:password]@` prefix from an authority, so a credential
 * embedded in a span's URL/server attribute can never ride out as a resolvable
 * `domain:` origin (the unparseable-URL fallback below would otherwise keep it).
 */
function withoutUserinfo(authority: string | null): string | null {
  if (!authority) return null;
  const at = authority.lastIndexOf('@');
  const bare = at >= 0 ? authority.slice(at + 1) : authority;
  return bare.length > 0 ? bare : null;
}

/**
 * Extract ONLY the host (host:port) from a URL — never the path or query, so a
 * PE cannot carry request contents. Best-effort for non-absolute inputs.
 */
function hostFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(url);
    if (withScheme) return withScheme[1];
    const authorityOnly = /^([^/?#]+)/.exec(url);
    return authorityOnly ? authorityOnly[1] : null;
  }
}

function uniquePreserveOrder(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}

function lower(v: string | null): string | null { return v == null ? null : v.toLowerCase(); }
function upper(v: string | null): string | null { return v == null ? null : v.toUpperCase(); }

// ============================================================================
// OTLP JSON parsing (pure functions - exported for unit testing)
// ============================================================================

export interface ParsedOtlpSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  startTimeUnixMs: number;
  endTimeUnixMs: number;
  status: 'ok' | 'error' | 'unknown';
  /** OTel SpanKind (2=SERVER, 3=CLIENT, …), or null when absent. */
  spanKind: number | null;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
  scopeName: string | null;
}

/**
 * Parses an OTLP/HTTP trace export payload (JSON encoding, or the equivalent
 * object produced by decodeOtlpTraceProtobuf) into a flat list of spans.
 * Tolerates missing fields, never throws on unexpected shapes - returns
 * whatever spans it can parse.
 */
export function parseOtlpTracePayload(payload: unknown): ParsedOtlpSpan[] {
  if (!isObject(payload)) return [];
  const resourceSpans = (payload as Record<string, unknown>).resourceSpans;
  if (!Array.isArray(resourceSpans)) return [];
  const out: ParsedOtlpSpan[] = [];
  for (const rs of resourceSpans) {
    if (!isObject(rs)) continue;
    const resourceAttrs = flattenAttributes((rs.resource as Record<string, unknown> | undefined)?.attributes);
    const scopeSpans = Array.isArray(rs.scopeSpans) ? rs.scopeSpans : [];
    for (const ss of scopeSpans) {
      if (!isObject(ss)) continue;
      const scopeName = stringAttr((ss.scope as Record<string, unknown> | undefined)?.name) || null;
      const spans = Array.isArray(ss.spans) ? ss.spans : [];
      for (const span of spans) {
        const parsed = parseSpan(span, resourceAttrs, scopeName);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out;
}

function parseSpan(
  span: unknown,
  resourceAttributes: Record<string, unknown>,
  scopeName: string | null,
): ParsedOtlpSpan | null {
  if (!isObject(span)) return null;
  const name = stringAttr(span.name) || 'unnamed';
  const traceId = stringAttr(span.traceId) || '';
  const spanId = stringAttr(span.spanId) || '';
  const parentSpanId = stringAttr(span.parentSpanId) || '';
  if (!traceId) return null;

  const startTimeUnixMs = nanosToMs(span.startTimeUnixNano);
  const endTimeUnixMs = nanosToMs(span.endTimeUnixNano);
  if (startTimeUnixMs == null || endTimeUnixMs == null) return null;

  // OTel status code convention: 0 = UNSET (default, treat as ok),
  // 1 = OK, 2 = ERROR. Only explicit ERROR should be filtered downstream.
  let status: 'ok' | 'error' | 'unknown' = 'ok';
  const s = span.status;
  if (isObject(s)) {
    const code = numericAttr(s.code);
    if (code === 2) status = 'error';
    else if (code === 1 || code === 0 || code == null) status = 'ok';
  }

  const attributes = flattenAttributes(span.attributes);
  const spanKind = parseSpanKind(span.kind);

  return {
    name,
    traceId,
    spanId,
    parentSpanId,
    startTimeUnixMs,
    endTimeUnixMs,
    status,
    spanKind,
    attributes,
    resourceAttributes,
    scopeName,
  };
}

/**
 * Normalize an OTLP SpanKind to its numeric enum. OTLP/JSON may send either the
 * number (3) or the enum name ("SPAN_KIND_CLIENT"); protobuf yields the number.
 * Returns null when absent so parity holds across both encodings.
 */
function parseSpanKind(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.trim().toUpperCase();
    switch (m) {
      case 'SPAN_KIND_UNSPECIFIED': case 'UNSPECIFIED': return 0;
      case 'SPAN_KIND_INTERNAL': case 'INTERNAL': return 1;
      case 'SPAN_KIND_SERVER': case 'SERVER': return 2;
      case 'SPAN_KIND_CLIENT': case 'CLIENT': return 3;
      case 'SPAN_KIND_PRODUCER': case 'PRODUCER': return 4;
      case 'SPAN_KIND_CONSUMER': case 'CONSUMER': return 5;
      default: {
        const n = parseInt(m, 10);
        return Number.isFinite(n) ? n : null;
      }
    }
  }
  return null;
}

export function flattenAttributes(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const key = stringAttr(entry.key);
    if (!key) continue;
    out[key] = unwrapAnyValue(entry.value);
  }
  return out;
}

function unwrapAnyValue(value: unknown): unknown {
  if (!isObject(value)) return undefined;
  if ('stringValue' in value) return String(value.stringValue);
  if ('boolValue' in value) return Boolean(value.boolValue);
  if ('intValue' in value) return numericAttr(value.intValue);
  if ('doubleValue' in value) return numericAttr(value.doubleValue);
  if ('bytesValue' in value) return String(value.bytesValue);
  if ('arrayValue' in value && isObject(value.arrayValue)) {
    const inner = (value.arrayValue as Record<string, unknown>).values;
    if (Array.isArray(inner)) return inner.map(unwrapAnyValue);
  }
  if ('kvlistValue' in value && isObject(value.kvlistValue)) {
    const inner = (value.kvlistValue as Record<string, unknown>).values;
    if (Array.isArray(inner)) {
      const map: Record<string, unknown> = {};
      for (const kv of inner) {
        if (!isObject(kv)) continue;
        const k = stringAttr(kv.key);
        if (k) map[k] = unwrapAnyValue(kv.value);
      }
      return map;
    }
  }
  return undefined;
}

function numericAttr(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    // OTLP encodes 64-bit ints as strings; use BigInt for safety
    const trimmed = v.trim();
    if (!trimmed) return null;
    if (/^-?\d+$/.test(trimmed)) {
      try {
        const big = BigInt(trimmed);
        // Safe for token counts and durations; cap at Number.MAX_SAFE_INTEGER
        return big > BigInt(Number.MAX_SAFE_INTEGER)
          ? Number.MAX_SAFE_INTEGER
          : Number(big);
      } catch { return null; }
    }
    const f = parseFloat(trimmed);
    return Number.isFinite(f) ? f : null;
  }
  if (typeof v === 'bigint') {
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
  }
  return null;
}

function stringAttr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function nanosToMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Math.floor(v / 1_000_000);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    try {
      const big = BigInt(v.trim());
      const ms = big / 1_000_000n;
      return ms > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(ms);
    } catch { return null; }
  }
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ============================================================================
// OTLP/HTTP protobuf decoding (pure - exported for unit testing)
//
// A minimal, dependency-free decoder for ExportTraceServiceRequest. It decodes
// ONLY the fields the classifier needs and emits the SAME object shape an
// OTLP/JSON body deserializes to, so parseOtlpTracePayload is the single
// normalization + classification path for both encodings. Local-only, no
// protobuf library, no collector.
//
// Field numbers follow opentelemetry-proto trace v1:
//   ExportTraceServiceRequest.resource_spans          = 1
//   ResourceSpans{ resource=1, scope_spans=2 }
//   Resource.attributes                                = 1
//   ScopeSpans{ scope=1, spans=2 }
//   InstrumentationScope.name                          = 1
//   Span{ trace_id=1, span_id=2, parent_span_id=4, name=5, kind=6 (varint),
//         start_time_unix_nano=7 (fixed64), end_time_unix_nano=8 (fixed64),
//         attributes=9, status=15 }
//   KeyValue{ key=1, value=2 }
//   AnyValue{ string=1,bool=2,int=3,double=4,array=5,kvlist=6,bytes=7 }
//   Status{ message=2, code=3 }
// ============================================================================

type ProtoField =
  | { field: number; wire: 0; varint: bigint }
  | { field: number; wire: 1; fixed64: Buffer }
  | { field: number; wire: 2; bytes: Buffer }
  | { field: number; wire: 5; fixed32: Buffer };

function readVarint(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  while (p < buf.length) {
    const byte = buf[p++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, p];
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
  throw new Error('truncated varint');
}

function eachField(buf: Buffer, cb: (f: ProtoField) => void): void {
  let p = 0;
  while (p < buf.length) {
    const [tagBig, p1] = readVarint(buf, p);
    const tag = Number(tagBig);
    const field = tag >>> 3;
    const wire = tag & 7;
    p = p1;
    if (wire === 0) {
      const [v, p2] = readVarint(buf, p); p = p2;
      cb({ field, wire, varint: v });
    } else if (wire === 1) {
      if (p + 8 > buf.length) throw new Error('truncated fixed64');
      cb({ field, wire, fixed64: buf.subarray(p, p + 8) }); p += 8;
    } else if (wire === 2) {
      const [lenBig, p2] = readVarint(buf, p);
      const len = Number(lenBig);
      if (p2 + len > buf.length) throw new Error('truncated length-delimited');
      cb({ field, wire, bytes: buf.subarray(p2, p2 + len) }); p = p2 + len;
    } else if (wire === 5) {
      if (p + 4 > buf.length) throw new Error('truncated fixed32');
      cb({ field, wire, fixed32: buf.subarray(p, p + 4) }); p += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

export function decodeOtlpTraceProtobuf(buf: Buffer): { resourceSpans: unknown[] } {
  const resourceSpans: unknown[] = [];
  eachField(buf, (f) => {
    if (f.field === 1 && f.wire === 2) resourceSpans.push(decodeResourceSpans(f.bytes));
  });
  return { resourceSpans };
}

function decodeResourceSpans(buf: Buffer): unknown {
  let resource: unknown = undefined;
  const scopeSpans: unknown[] = [];
  eachField(buf, (f) => {
    if (f.field === 1 && f.wire === 2) resource = decodeResource(f.bytes);
    else if (f.field === 2 && f.wire === 2) scopeSpans.push(decodeScopeSpans(f.bytes));
  });
  return { resource, scopeSpans };
}

function decodeResource(buf: Buffer): unknown {
  const attributes: unknown[] = [];
  eachField(buf, (f) => {
    if (f.field === 1 && f.wire === 2) attributes.push(decodeKeyValue(f.bytes));
  });
  return { attributes };
}

function decodeScopeSpans(buf: Buffer): unknown {
  let scope: unknown = undefined;
  const spans: unknown[] = [];
  eachField(buf, (f) => {
    if (f.field === 1 && f.wire === 2) scope = decodeScope(f.bytes);
    else if (f.field === 2 && f.wire === 2) spans.push(decodeSpan(f.bytes));
  });
  return { scope, spans };
}

function decodeScope(buf: Buffer): unknown {
  let name: string | undefined;
  eachField(buf, (f) => {
    if (f.field === 1 && f.wire === 2) name = f.bytes.toString('utf-8');
  });
  return { name };
}

function decodeSpan(buf: Buffer): unknown {
  const span: Record<string, unknown> = {};
  const attributes: unknown[] = [];
  eachField(buf, (f) => {
    if (f.field === 1 && f.wire === 2) span.traceId = f.bytes.toString('hex');
    else if (f.field === 2 && f.wire === 2) span.spanId = f.bytes.toString('hex');
    else if (f.field === 4 && f.wire === 2) span.parentSpanId = f.bytes.toString('hex');
    else if (f.field === 5 && f.wire === 2) span.name = f.bytes.toString('utf-8');
    else if (f.field === 6 && f.wire === 0) span.kind = Number(f.varint);
    else if (f.field === 7 && f.wire === 1) span.startTimeUnixNano = f.fixed64.readBigUInt64LE(0).toString();
    else if (f.field === 8 && f.wire === 1) span.endTimeUnixNano = f.fixed64.readBigUInt64LE(0).toString();
    else if (f.field === 9 && f.wire === 2) attributes.push(decodeKeyValue(f.bytes));
    else if (f.field === 15 && f.wire === 2) span.status = decodeStatus(f.bytes);
  });
  span.attributes = attributes;
  return span;
}

function decodeKeyValue(buf: Buffer): unknown {
  let key: string | undefined;
  let value: unknown = undefined;
  eachField(buf, (f) => {
    if (f.field === 1 && f.wire === 2) key = f.bytes.toString('utf-8');
    else if (f.field === 2 && f.wire === 2) value = decodeAnyValue(f.bytes);
  });
  return { key, value };
}

function decodeAnyValue(buf: Buffer): unknown {
  let out: unknown = undefined;
  eachField(buf, (f) => {
    if (f.field === 1 && f.wire === 2) out = { stringValue: f.bytes.toString('utf-8') };
    else if (f.field === 2 && f.wire === 0) out = { boolValue: f.varint !== 0n };
    else if (f.field === 3 && f.wire === 0) out = { intValue: signed64(f.varint).toString() };
    else if (f.field === 4 && f.wire === 1) out = { doubleValue: f.fixed64.readDoubleLE(0) };
    else if (f.field === 5 && f.wire === 2) {
      const values: unknown[] = [];
      eachField(f.bytes, (g) => { if (g.field === 1 && g.wire === 2) values.push(decodeAnyValue(g.bytes)); });
      out = { arrayValue: { values } };
    } else if (f.field === 6 && f.wire === 2) {
      const values: unknown[] = [];
      eachField(f.bytes, (g) => { if (g.field === 1 && g.wire === 2) values.push(decodeKeyValue(g.bytes)); });
      out = { kvlistValue: { values } };
    } else if (f.field === 7 && f.wire === 2) {
      out = { bytesValue: f.bytes.toString('hex') };
    }
  });
  return out;
}

function decodeStatus(buf: Buffer): unknown {
  let code = 0;
  eachField(buf, (f) => {
    if (f.field === 3 && f.wire === 0) code = Number(f.varint);
  });
  return { code };
}

/** Interpret a protobuf varint as a two's-complement signed 64-bit integer. */
function signed64(v: bigint): bigint {
  const MASK = (1n << 64n) - 1n;
  const u = v & MASK;
  return u >= (1n << 63n) ? u - (1n << 64n) : u;
}

/** Semantic OTLP output-message tool calls; text and tool arguments are never retained. */
function modelResponseCalls(s:ParsedOtlpSpan):Array<{id:string;name:string}> {
 if(classifySpanRole(s).role!=='model')return [];
 const raw=s.attributes['gen_ai.output.messages']??s.attributes['gen_ai.response.tool_calls'];
 let value:unknown=raw;if(typeof raw==='string'){try{value=JSON.parse(raw);}catch{return [];}}
 const out:Array<{id:string;name:string}>=[];
 const visit=(v:unknown):void=>{if(Array.isArray(v)){for(const x of v)visit(x);return;}if(!v||typeof v!=='object')return;const o=v as Record<string,unknown>;
  const fn=o.function&&typeof o.function==='object'?o.function as Record<string,unknown>:o;
  if(['tool_call','function_call','tool_use'].includes(String(o.type))&&typeof fn.name==='string')out.push({id:typeof o.id==='string'?o.id:typeof o.call_id==='string'?o.call_id:s.spanId+':'+out.length,name:fn.name});
  for(const k of ['parts','content','tool_calls'])if(o[k])visit(o[k]);
 };visit(value);return out;
}
