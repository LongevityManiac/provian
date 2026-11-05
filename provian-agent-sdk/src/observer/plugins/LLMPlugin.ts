import * as fs from 'fs';
import type { ObserverPlugin } from './PluginInterface';
import type { ProvianObserver } from '../ProvianObserver';
import type { InferenceContribution, PluginContribution, SessionState } from '../types';
import {
  NO_LOCAL_INFERENCE,
  RUNTIME_SOURCE,
  parserForRuntime,
  probeLocalInferenceRuntimes,
  describeLocalInferenceProbe,
  type LocalInferenceObservation,
  type LocalInferenceProbe,
  type LocalInferenceRuntime,
  type ProbeOptions,
} from './local-inference/runtimes';

/** One tailed request log. */
interface TailedSource {
  runtime: LocalInferenceRuntime;
  path: string;
  parse: (line: string) => LocalInferenceObservation;
  readOffset: number;
  buffer: string;
}

/** Per-runtime accumulation between ticks. */
interface PendingInference {
  requests: number;
  tokens: number;
  tokensObserved: boolean;
  models: string[];
}

export interface LLMPluginOptions {
  /** A probe result to start from (the daemon passes its startup probe). */
  initialProbe?: LocalInferenceProbe;
  /** Injectable prober (tests). Defaults to the real loopback probe. */
  probe?: (opts: ProbeOptions) => Promise<LocalInferenceProbe>;
  /** Re-probe cadence. 0 disables the periodic re-probe (tests). */
  reprobeIntervalMs?: number;
  /** Start tailing from the beginning of each log instead of its current end (tests). */
  tailFromStart?: boolean;
  /** Clock (tests). */
  now?: () => number;
}

const DEFAULT_REPROBE_MS = 60_000;

/**
 * ZERO-CONFIG local inference witness.
 *
 * Before this plugin only tailed a JSONL log named by `PROVIAN_LLM_LOG`, and
 * `resolveActivePlugins` dropped it entirely when that env was absent — which
 * it always was on an installed daemon service. So local model work on a
 * registered machine produced no `inference_session` at all, although the
 * type priced fine and the body-bound device submit sealed it verified.
 *
 * Now it detects the local runtimes people actually run — Ollama, LM Studio,
 * llama.cpp `llama-server` — on loopback, tails the request log each runtime
 * writes, and contributes what it honestly saw to the open session:
 *   - `requests`: COMPLETED inference requests (2xx on an inference route);
 *   - `models`: names the runtime reported loaded (`/api/ps`, `/api/v0/models`,
 *     `/props`) or named in its log;
 *   - `tokens_processed`: ONLY when the source exposes token counts (llama.cpp /
 *     LM Studio log lines, the JSONL source). Ollama's log has none, so an
 *     Ollama window ships `tokens_processed: null` and `tokens_observed: false`.
 * The observer types the session `inference_session` when requests > 0 OR
 * tokens > 0 (`ProvianObserver.finalizeSession`), and opens/extends the session
 * on each contribution so a human device — no ProcessPlugin, no CPU-opened
 * session — still witnesses the window under one minted lineage.
 *
 * Probing is off-tick (fire-and-forget, short timeouts, loopback only) and
 * re-runs every minute so a runtime started after the daemon is picked up.
 * Tailing starts at the CURRENT end of each log (no back-witnessing of work
 * that happened before the daemon was running).
 */
export class LLMPlugin implements ObserverPlugin {
  readonly name = 'llm';
  private observer!: ProvianObserver;
  private readonly probeFn: (opts: ProbeOptions) => Promise<LocalInferenceProbe>;
  private readonly reprobeIntervalMs: number;
  private readonly tailFromStart: boolean;
  private readonly now: () => number;
  private probe: LocalInferenceProbe;
  private sources: TailedSource[] = [];
  private reprobeTimer: NodeJS.Timeout | null = null;
  private probing = false;
  private pending = new Map<LocalInferenceRuntime, PendingInference>();
  private readonly loadedModels = new Map<LocalInferenceRuntime, string[]>();
  /** Lifetime counters for the daemon log / doctor. */
  private witnessedRequests = 0;

  constructor(options: LLMPluginOptions = {}) {
    this.probeFn = options.probe ?? ((opts) => probeLocalInferenceRuntimes(opts));
    this.reprobeIntervalMs = options.reprobeIntervalMs ?? DEFAULT_REPROBE_MS;
    this.tailFromStart = options.tailFromStart ?? false;
    this.now = options.now ?? (() => Date.now());
    this.probe = options.initialProbe ?? NO_LOCAL_INFERENCE;
  }

  async init(observer: ProvianObserver): Promise<void> {
    this.observer = observer;
    this.applyProbe(this.probe);
    // The daemon already probed at startup; a fresh probe here is cheap and
    // catches the JSONL env / a runtime that came up in between. Off-tick.
    void this.reprobe();
  }

  async start(): Promise<void> {
    this.observer.log('info', 'local inference runtimes', {
      detected: this.probe.detected,
      summary: describeLocalInferenceProbe(this.probe),
      tailing: this.sources.map((s) => `${s.runtime}:${s.path}`),
    });
    if (this.reprobeIntervalMs > 0) {
      this.reprobeTimer = setInterval(() => { void this.reprobe(); }, this.reprobeIntervalMs);
      this.reprobeTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.reprobeTimer) { clearInterval(this.reprobeTimer); this.reprobeTimer = null; }
  }

  /** The current detection state (doctor / tests). */
  currentProbe(): LocalInferenceProbe {
    return this.probe;
  }

  /** Paths currently tailed (tests / logs). */
  tailedPaths(): string[] {
    return this.sources.map((s) => s.path);
  }

  tick(_session: SessionState | null): PluginContribution | null {
    for (const src of this.sources) this.drainSource(src);
    if (this.pending.size === 0) return null;

    // Fold every runtime's pending work into ONE contribution per tick. The
    // runtime/source names are joined when more than one runtime was active in
    // the same tick (rare; the session accumulator unions them anyway).
    let requests = 0;
    let tokens = 0;
    let tokensObserved = false;
    const models: string[] = [];
    const runtimes: string[] = [];
    for (const [runtime, p] of this.pending) {
      requests += p.requests;
      tokens += p.tokens;
      tokensObserved = tokensObserved || p.tokensObserved;
      for (const m of p.models) if (!models.includes(m)) models.push(m);
      runtimes.push(runtime);
    }
    this.pending.clear();
    if (requests === 0 && tokens === 0) return null;

    this.witnessedRequests += requests;
    const inference: InferenceContribution = {
      runtime: runtimes.join('+'),
      source: runtimes.map((r) => RUNTIME_SOURCE[r as LocalInferenceRuntime]).join('+'),
      requests,
      models,
      tokensObserved,
    };
    const sessionData: Record<string, unknown> = {
      runtime: inference.runtime,
      requests_this_tick: requests,
      models,
      tokens_observed: tokensObserved,
    };
    if (tokensObserved && tokens > 0) sessionData.tokens_this_tick = tokens;
    return {
      // tokens_processed is set ONLY when a source that exposes token counts
      // contributed them. An Ollama-only tick carries no telemetry at all.
      telemetry: tokensObserved && tokens > 0 ? { tokens_processed: tokens } : undefined,
      sessionData,
      inference,
    };
  }

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  private async reprobe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const next = await this.probeFn({});
      const before = describeLocalInferenceProbe(this.probe);
      const after = describeLocalInferenceProbe(next);
      this.applyProbe(next);
      if (before !== after) {
        this.observer.log('info', 'local inference runtimes changed', {
          detected: next.detected, summary: after,
          tailing: this.sources.map((s) => `${s.runtime}:${s.path}`),
        });
      }
    } catch (err) {
      this.observer.log('debug', 'local inference probe failed', { error: (err as Error).message });
    } finally {
      this.probing = false;
    }
  }

  /** Reconcile tailed sources with a probe: add new logs (from EOF), keep existing offsets. */
  private applyProbe(probe: LocalInferenceProbe): void {
    this.probe = probe;
    const wanted: Array<{ runtime: LocalInferenceRuntime; path: string }> = [];
    for (const r of probe.runtimes) {
      this.loadedModels.set(r.runtime, r.loadedModels);
      if (r.logPath !== null) wanted.push({ runtime: r.runtime, path: r.logPath });
    }
    if (probe.jsonlLogPath !== null) wanted.push({ runtime: 'jsonl', path: probe.jsonlLogPath });

    const keep: TailedSource[] = [];
    for (const w of wanted) {
      const existing = this.sources.find((s) => s.runtime === w.runtime && s.path === w.path);
      if (existing) { keep.push(existing); continue; }
      let readOffset = 0;
      if (!this.tailFromStart) {
        try { readOffset = fs.statSync(w.path).size; } catch { readOffset = 0; }
      }
      keep.push({ runtime: w.runtime, path: w.path, parse: parserForRuntime(w.runtime), readOffset, buffer: '' });
    }
    this.sources = keep;
  }

  // -------------------------------------------------------------------------
  // Tailing (offset, rotation reset, partial-line buffer)
  // -------------------------------------------------------------------------

  private drainSource(src: TailedSource): void {
    let stat: fs.Stats;
    try { stat = fs.statSync(src.path); } catch { return; }

    if (stat.size < src.readOffset) {
      // rotated / truncated; start over
      src.readOffset = 0;
      src.buffer = '';
    }
    if (stat.size === src.readOffset) return;

    try {
      const fd = fs.openSync(src.path, 'r');
      try {
        const remaining = stat.size - src.readOffset;
        const chunk = Buffer.alloc(remaining);
        const read = fs.readSync(fd, chunk, 0, remaining, src.readOffset);
        src.readOffset += read;
        src.buffer += chunk.subarray(0, read).toString('utf-8');
      } finally { fs.closeSync(fd); }
    } catch {
      return;
    }

    const lines = src.buffer.split('\n');
    src.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const obs = src.parse(trimmed);
      if (obs.requests === 0 && obs.tokens === null && obs.model === null) continue;
      this.record(src.runtime, obs);
    }
  }

  private record(runtime: LocalInferenceRuntime, obs: LocalInferenceObservation): void {
    const p = this.pending.get(runtime) ?? { requests: 0, tokens: 0, tokensObserved: false, models: [] };
    p.requests += obs.requests;
    if (obs.tokens !== null && obs.tokens > 0) { p.tokens += obs.tokens; p.tokensObserved = true; }
    if (obs.model !== null && !p.models.includes(obs.model)) p.models.push(obs.model);
    // A request witnessed with no model name on its line is attributed to the
    // models the runtime itself reported loaded at the last probe.
    if (obs.requests > 0 && obs.model === null) {
      for (const m of this.loadedModels.get(runtime) ?? []) if (!p.models.includes(m)) p.models.push(m);
    }
    this.pending.set(runtime, p);
  }
}
