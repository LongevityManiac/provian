import { ProvianClient } from '../ProvianClient';
import { SUBMIT_OBSERVED_PE } from '../observed-submit';
import { SessionManager } from './SessionManager';
import { autoHardwareWitnessProvider } from '../hardware-witness';
import { DeduplicationRegistry } from './DeduplicationRegistry';
import type { ObserverPlugin, PECommitOutcome } from './plugins/PluginInterface';
import type { ComputeTelemetry, DeviceActionReport, ExecutionEnv, OriginWitness } from '../types';
import { PEDescriptionError } from '../errors';
import { FINAL_SUBMIT_BUDGET_MS } from './commit-budget';
import type { ObserverConfig, PluginPE, SessionState } from './types';
import type { EconomicSessionLineageClaim } from './session-lineage';
import { observerDeviceWitness as buildObserverDeviceWitness } from './origin-capture';
import * as os from 'os';
import { detectEnvironmentFacts } from './environment-class';
import * as path from 'path';
import { createSessionOrdinalStore } from './session-ordinal-store';
import type { MeterBatcher } from '../meter/batcher';
import type { ArchiveKeeper } from '../meter/archive';
import { migrateLegacyOutbox } from '../meter/migrate-outbox';
import { PE_STORE_NOTICE } from '../meter/status';
import {
  BUILT_IN_LANE_ONLY_ACTION_TYPES,
  isDeviceObservationActionType,
  observerPluginNameCarriesMarker,
  pluginActionTypeRefusal,
  withObserverPluginWitness,
  withThirdPartyPluginWitness,
} from './observation-types';
import { isBuiltInLane } from './built-in-lanes';

/**
 * PE meter: how often the daemon asks its batcher whether anything is due. The batcher itself
 * keeps the schedule (daily batch, plus one before a presentation or payout; hourly mailbox,
 * daily proofs, and sooner retries); this is
 * only the granularity of that schedule.
 */
export const METER_TICK_INTERVAL_MS = 60_000;
/** One-time notice flag kept in the PE store. */
const PE_STORE_NOTICE_FLAG = 'pe_store_notice_v1';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One drained PE and the plugin that handed it over (its commit notice goes back there). */
interface DrainedPE {
  plugin: ObserverPlugin;
  pe: PluginPE;
}

type CaptureSession = { startedAt: number; lineage: EconomicSessionLineageClaim | null } | null;
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class ProvianObserver {
  private readonly client: ProvianClient;
  private readonly sessions: SessionManager;
  private readonly dedup: DeduplicationRegistry;
  private readonly plugins: ObserverPlugin[] = [];
  private running = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private meterTimer: NodeJS.Timeout | null = null;
  /** PE meter: the daily batcher (daemon only — `config.meterBatching`). */
  private batcher: MeterBatcher | null = null;
  /** The paid PE Archive keeper : idle unless the owner turned the Archive on. */
  private archive: ArchiveKeeper | null = null;
  /** resync, shared by the client and the batcher. */
  private readonly onLineageRejected: (info: { code: string; expectedOrdinal: number | null }) => void;
  /** The tick in progress, if any — stop() waits for it, so nothing it drained is stranded. */
  private tickInFlight: Promise<void> | null = null;
  /** Epoch ms of the last plugin (work) PE the relay accepted; null until one. */
  private lastWorkPeAtMs: number | null = null;

  constructor(private readonly config: ObserverConfig) {
    // Forward signing config so SE-registered devices actually use SE for
    // PE submission. Dropping signingMethod/signingKeyAlias/deviceId here
    // silently demotes every PE to bearer DeviceKey, nullifying the
    // hardware_partial attestation evidence the human Mac registered for.
    // the attested device credential is forwarded so each session can
    // mint its witnessed capture context. Dropping it here would silently leave
    // every observed PE behind the lineage fence.
    // the ordinal must survive a restart or the relay refuses every
    // session after the first. It is reserved from a durable file next to the
    // credentials; no device id means no lineage at all, which is the honest
    // outcome rather than a guessed sequence.
    const deviceId = config.credentials.deviceId ?? null;
    const ordinalStore = deviceId === null
      ? null
      : createSessionOrdinalStore(
        config.sessionOrdinalPath
          ?? path.join(os.homedir(), '.provian', `session-ordinal-${deviceId}.json`),
        deviceId,
      );
    this.client = new ProvianClient({
      relayUrl: config.relayUrl,
      deviceKey: config.credentials.deviceKey,
      deviceSecret: config.credentials.deviceSecret,
      deviceId: config.credentials.deviceId,
      signingMethod: config.credentials.signingMethod,
      signingKeyAlias: config.credentials.signingKeyAlias,
      // §2.9: attach a hardware witness to every observer PE when this host has one (TPM 2.0 vTPM on
      // a Compute Engine VM, a Confidential Space launcher). Absent hardware → no slot, ordinary class.
      hardwareWitness: config.hardwareWitness === 'none' ? undefined : autoHardwareWitnessProvider(),
      // the resync. The relay refuses a drifted ordinal and returns the
      // one it expects; without adopting it, a single burned ordinal locked this
      // device out of lineage-bearing submission permanently. The current
      // session's own lineage is also cleared, so the rest of it records behind
      // the fence rather than being refused PE after PE.
      // PE meter : every observed PE is built, chained and kept on this
      // machine; the batcher sends the act records once a day.
      ...(config.peStore ? { peStore: config.peStore } : {}),
      ...(config.peStoreDir ? { peStoreRoot: config.peStoreDir } : {}),
      onSessionLineageRejected: (info) => this.onLineageRejected(info),
    });
    this.onLineageRejected = ({ expectedOrdinal }) => {
      if (expectedOrdinal !== null) ordinalStore?.adoptRelayOrdinal(expectedOrdinal);
      this.sessions.clearLineage();
    };
    this.sessions = new SessionManager(
      config.idleThresholdMs,
      config.maxSessionMs,
      undefined,
      deviceId,
      ordinalStore === null ? null : () => ordinalStore.reserveNext(),
    );
    this.dedup = new DeduplicationRegistry();
  }

  /**
   * Register a plugin (built-in or third-party) before `start()`. A third-party gateway plugin that
   * reports what it observed under its own action type is witnessed by THIS observer: EVERY PE it
   * drains — observation types included — is stamped with `metadata.source = 'observer_plugin'` +
   * `metadata.observer_plugin = plugin.name`, and any built-in lane marker it set is dropped (see
   * `reportFor`); the relay records a never-seen type for review — no mint until a row for it is
   * signed. A type only a built-in lane witnesses (`link_spend`, `agent_tool_orchestration`) is
   * refused locally. This public method never makes a plugin one of the daemon's own lanes — only the
   * daemon's registration does (`built-in-lanes.ts` `registerBuiltInLane`); those pass through untouched.
   */
  registerPlugin(plugin: ObserverPlugin): void {
    this.plugins.push(plugin);
  }

  get sessionManager(): SessionManager {
    return this.sessions;
  }

  get deduplicationRegistry(): DeduplicationRegistry {
    return this.dedup;
  }

  /** Epoch ms of the last work PE this daemon submitted (any lane); null if none. */
  getLastWorkPeAtMs(): number | null {
    return this.lastWorkPeAtMs;
  }

  /** This device's registered id (the process lane keys its own mint-once ledger on it); null if unregistered. */
  getDeviceId(): string | null {
    return this.config.credentials.deviceId ?? null;
  }

  /**
   * Prompt 2: the `observer_device` witness for origins a plugin captures on
   * this device — the body-HMAC key that vouches they crossed the boundary.
   * Derived from the registered device credentials; null when there is no device
   * id (an unwitnessed origin is the honest fallback). Plugins call this to stamp
   * the origins they build.
   */
  observerDeviceWitness(): OriginWitness | null {
    const c = this.config.credentials;
    return buildObserverDeviceWitness(c.deviceId ?? null, c.ownerType, c.signingMethod ?? null);
  }

  log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.config.logLevel]) return;
    const line = extra
      ? `[observer ${level}] ${msg} ${JSON.stringify(extra)}`
      : `[observer ${level}] ${msg}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  }

  /**
   * Best-effort: forward this device's LLM-session capture status to the relay
   * so the app can show whether AI-app capture is working on this machine or
   * needs the user to grant macOS permissions. Adds the host platform. Called
   * by LLMSessionPlugin on start and whenever the OS permission status changes.
   * Never throws (the underlying client swallows errors).
   */
  async reportCaptureStatus(status: {
    llm_session_enabled: boolean;
    active: boolean;
    permissions_checked: boolean;
    accessibility: boolean;
    input_monitoring: boolean;
  }): Promise<void> {
    // Surface SDK staleness in the device record (the phone's device view) so an
    // operator can spot a stale agent without reading logs. Advisory only.
    const sdk = this.client.getSdkStaleness();
    await this.client.reportCaptureStatus({
      ...status,
      platform: process.platform,
      sdk_version: sdk.current,
      sdk_stale: sdk.stale,
      sdk_below_min: sdk.belowMin,
    });
  }

  /**
   * Best-effort: forward the transcript watcher's capture health to the relay.
   *
   * Called on a slow cadence from the daemon loop. The value of this heartbeat
   * is almost entirely in its NEGATIVE case — a device reporting zero readable
   * sources for an installed harness — so it must keep being sent while a
   * device is blind, which is exactly when a naive "report on capture" would go
   * quiet. Never throws.
   */
  async reportCaptureHealth(report: Record<string, unknown>): Promise<{ deviceRegisteredAtMs: number | null; commonsMailWaiting: boolean } | null> {
    try {
      return await this.client.reportCaptureHealth(report);
    } catch {
      return null;
    }
  }

  /** fetch the signed release-manifest envelope (for self-update). */
  async fetchReleaseManifest(): Promise<{ body: unknown; bytes: number }> {
    return this.client.fetchReleaseManifest();
  }

  /** download the release bundle bytes from the fixed relay URL. */
  async fetchReleaseBundle(): Promise<Buffer> {
    return this.client.fetchReleaseBundle();
  }

  getTargetPid(): number {
    return this.config.targetPid ?? process.pid;
  }

  /** This device's PE store (null when it cannot be opened) — read-only use by plugins (witness seeding). */
  async peStoreForPlugins(): Promise<import('../meter/pe-store').PeStore | null> {
    try { return await this.client.getPeStore(); } catch { return null; }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log('info', 'starting observer', {
      pid: process.pid,
      targetPid: this.getTargetPid(),
      plugins: this.plugins.map(p => p.name),
    });

    for (const p of this.plugins) {
      try {
        await p.init(this);
      } catch (err) {
        this.log('error', `plugin init failed: ${p.name}`, { error: (err as Error).message });
      }
    }
    for (const p of this.plugins) {
      try {
        await p.start();
      } catch (err) {
        this.log('error', `plugin start failed: ${p.name}`, { error: (err as Error).message });
      }
    }

    this.tickTimer = setInterval(() => this.runTick(), this.config.tickIntervalMs);
    this.pruneTimer = setInterval(() => this.dedup.prune(), 10 * 60 * 1000);
    await this.startMeter();
  }

  /**
   * PE meter: move any legacy outbox entries into this device's PE store (once), say where PEs
   * now live (once), and start the daily batcher. Never throws: a store this daemon cannot open
   * is logged, and every lane's record attempt reports its own failure.
   */
  private async startMeter(): Promise<void> {
    if (this.config.peOutboxDir) {
      try {
        await migrateLegacyOutbox({
          outboxDir: this.config.peOutboxDir,
          record: async (content, idempotencyKey) => {
            const report: DeviceActionReport = {
              actionType: content.action_type,
              ...(content.description !== undefined ? { description: content.description } : {}),
              metadata: content.metadata,
              compute: (content.compute ?? null) as DeviceActionReport['compute'],
              geo: (content.geo ?? null) as DeviceActionReport['geo'],
              execution_env: (content.execution_env ?? null) as DeviceActionReport['execution_env'],
              parent_goal_pe_id: typeof content.parent_goal_pe_id === 'string' ? content.parent_goal_pe_id : null,
              ...(content.input_origins !== undefined ? { input_origins: content.input_origins as DeviceActionReport['input_origins'] } : {}),
              ...(content.output_digests !== undefined ? { output_digests: content.output_digests as DeviceActionReport['output_digests'] } : {}),
              ...(content.economic_session_lineage !== undefined
                ? { economic_session_lineage: content.economic_session_lineage as DeviceActionReport['economic_session_lineage'] }
                : {}),
              idempotencyKey,
            };
            const result = await this.client[SUBMIT_OBSERVED_PE](report);
            if (result && 'pe_id' in result) return 'idempotent_replay' in result && result.idempotent_replay === true ? 'replay' : 'recorded';
            return this.client.lastSubmitOutcome === 'rejected' ? 'refused' : 'failed';
          },
          log: (m) => this.log('info', m),
        });
      } catch (err) {
        this.log('warn', 'legacy PE outbox migration failed; it is retried on the next start', { error: (err as Error).message });
      }
    }
    if (!this.config.meterBatching) return;
    try {
      this.batcher = await this.client.createMeterBatcher({
        log: (level, msg, extra) => this.log(level, msg, extra),
        onSessionLineageRejected: (info) => this.onLineageRejected(info),
        ...(this.config.messageSecretKey ? { messageSecretKey: this.config.messageSecretKey } : {}),
      });
      const store = await this.client.getPeStore();
      if (!(await store.flag(PE_STORE_NOTICE_FLAG))) {
        console.log(`[observer] PEs are kept at ${store.location}. ${PE_STORE_NOTICE}`);
        await store.setFlag(PE_STORE_NOTICE_FLAG);
      }
    } catch (err) {
      this.log('error', 'PE meter could not start; PEs are not being recorded until it can', { error: (err as Error).message });
      return;
    }
    try {
      this.archive = await this.client.createArchiveKeeper({
        log: (level, msg, extra) => this.log(level, msg, extra),
        ...(this.config.messageSecretKey ? { messageSecretKey: this.config.messageSecretKey } : {}),
      });
    } catch (err) {
      // The Archive is optional: without it every PE simply stays on this machine.
      this.log('warn', 'PE Archive keeper could not start; every PE stays on this machine', { error: (err as Error).message });
      this.archive = null;
    }
    void this.meterTick();
    this.meterTimer = setInterval(() => void this.meterTick(), METER_TICK_INTERVAL_MS);
  }

  /** PE meter: run whatever the batcher has due. Never throws. */
  async meterTick(): Promise<void> {
    if (!this.batcher) return;
    await this.batcher.tick();
    // Daily, after the batcher (its proofs decide which days are ready). Never throws.
    if (this.archive) await this.archive.tick().catch(() => null);
  }

  /**
   * Stop the observer — the path every exit the daemon controls takes (SIGTERM /
   * SIGINT / SIGHUP, a service restart, a self-update re-exec). review 4:
   * nothing a lane DECIDED is lost here. After the tick in progress finishes and
   * the plugins stop (each hands over what it decided on the way out), the
   * observer drains every plugin once more and SUBMITS those PEs: with a PE
   * outbox, each is first journaled on disk (so the process may exit at any
   * point after), then the outbox is drained for at most FINAL_SUBMIT_BUDGET_MS —
   * whatever the relay has not taken by then is resent on the next start under
   * the same idempotency key. Without an outbox each is submitted within the same
   * bounded wait. Each plugin hears every PE's fate (`onCommitted`) and then
   * `finalize()`s — the moment it may persist read positions past those PEs.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    if (this.meterTimer) { clearInterval(this.meterTimer); this.meterTimer = null; }
    if (this.tickInFlight) { try { await this.tickInFlight; } catch { /* logged by the tick */ } }

    // Flush an in-progress session, if any
    const leftover = this.sessions.flush();
    if (leftover) {
      await this.finalizeSession(leftover, 'idle');
    }

    for (const p of this.plugins) {
      try { await p.stop(); } catch (err) {
        this.log('error', `plugin stop failed: ${p.name}`, { error: (err as Error).message });
      }
    }
    await this.submitFinal();
    for (const p of this.plugins) {
      try { await p.finalize?.(); } catch (err) {
        this.log('error', `plugin finalize failed: ${p.name}`, { error: (err as Error).message });
      }
    }
    this.log('info', 'observer stopped');
  }

  /**
   * The final drain at stop (see `stop`). Every decided PE is recorded in this machine's PE store
   * first (no network: durable as soon as it is appended), then — best-effort, bounded by
   * FINAL_SUBMIT_BUDGET_MS — the batcher sends what it can. Whatever the relay has not taken by
   * then goes in the next start's first batch.
   */
  private async submitFinal(): Promise<void> {
    const { toSubmit, suppressed } = this.partition(this.drainPlugins());
    for (const { plugin, pe } of suppressed) this.notifyCommitted(plugin, pe, 'suppressed');
    const deadline = Date.now() + FINAL_SUBMIT_BUDGET_MS;
    const within = <T>(p: Promise<T>, fallback: T): Promise<T> => {
      const left = deadline - Date.now();
      if (left <= 0) return Promise.resolve(fallback);
      return new Promise<T>((resolve) => {
        const t = setTimeout(() => resolve(fallback), left);
        p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
      });
    };
    for (const { plugin, pe } of toSubmit) {
      const outcome = await this.submitPluginPE(plugin, pe, null);
      this.notifyCommitted(plugin, pe, outcome);
    }
    if (this.batcher) {
      const r = await within(this.batcher.flush().then((x) => x, () => null), null);
      this.log('info', 'final drain: decided PEs recorded; batch sent best-effort', {
        recorded: toSubmit.length, outcome: r?.outcome ?? 'timed_out', acts_accepted: r?.actsAccepted ?? 0, budget_ms: FINAL_SUBMIT_BUDGET_MS,
      });
    }
  }

  private runTick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    const t = this.runTickOnce().finally(() => { this.tickInFlight = null; });
    this.tickInFlight = t;
    return t;
  }

  private async runTickOnce(): Promise<void> {
    try {
      // A session opened by witnessed inference (SessionManager.witnessActivity)
      // has no ProcessPlugin sample to close it on a human device, so the
      // observer's own tick expires idle / over-long sessions. On an agent
      // device ProcessPlugin's sample may close it first; whichever runs first
      // nulls the state and the other sees a noop — never two finalizations.
      const expired = this.sessions.expire(Date.now());
      if (expired.type === 'session_ended') {
        await this.finalizeSession(expired.state, expired.reason);
      }

      const session = this.sessions.current();
      // SNAPSHOT THE CAPTURE CONTEXT BEFORE THE PLUGIN LOOP RUNS.
      //
      // The drain used to read `this.sessions.current()` at SUBMIT time, which
      // is a different instant from CAPTURE time: `ProcessPlugin.tick` can open
      // a NEW session inside the plugin loop below, and GitPlugin queues PEs
      // from its own independent poll while no session is open at all. A PE
      // captured before (or between) sessions was then stamped with the lineage
      // of a session that started AFTERWARDS — a valid claim for the device, so
      // the relay accepts it, and the PE asserts a witnessed capture context
      // that did not exist when the evidence was captured. That is fabricated
      // provenance, not a loose end.
      const captureSession = session === null
        ? null
        : { startedAt: session.startedAt, lineage: session.lineage };
      for (const p of this.plugins) {
        let contribution;
        try {
          contribution = p.tick(session);
        } catch (err) {
          this.log('error', `plugin tick failed: ${p.name}`, { error: (err as Error).message });
          continue;
        }
        if (!contribution) continue;
        // Witnessed local inference IS activity: open the session it belongs
        // to (or extend the open one) BEFORE recording it, so the artifact,
        // the tokens and the inference counters all land on a session whose
        // lineage was minted for this window. Without this, a human device —
        // no ProcessPlugin, so no CPU-opened session — dropped every token
        // contribution on the floor (addTokens no-ops with no open session).
        const inf = contribution.inference;
        const tokens = contribution.telemetry?.tokens_processed;
        const witnessedInference = (inf !== undefined && inf.requests > 0)
          || (typeof tokens === 'number' && tokens > 0);
        if (witnessedInference) {
          const opened = this.sessions.witnessActivity(Date.now());
          if (opened.type === 'session_started') {
            this.log('debug', 'session opened on witnessed inference', {
              plugin: p.name, runtime: inf?.runtime ?? null,
            });
          }
        }
        if (contribution.sessionData) {
          this.sessions.setArtifact(p.name, contribution.sessionData);
        }
        if (typeof tokens === 'number' && tokens > 0) {
          this.sessions.addTokens(tokens);
        }
        if (inf !== undefined && (inf.requests > 0 || inf.tokensObserved)) {
          this.sessions.addInference(inf);
        }
      }

      // Collect every plugin's drained PEs this tick, preserving registration
      // (= submit) order, so same-turn origins can be unioned before submission.
      const drained = this.drainPlugins();
      const { toSubmit, suppressed } = this.partition(drained);
      for (const { plugin, pe } of suppressed) this.notifyCommitted(plugin, pe, 'suppressed');
      for (const { plugin, pe } of toSubmit) {
        const outcome = await this.submitPluginPE(plugin, pe, captureSession);
        this.notifyCommitted(plugin, pe, outcome);
      }
    } catch (err) {
      this.log('error', 'tick loop error', { error: (err as Error).message });
    }
  }

  /** Every plugin's drained PEs, in registration (= submit) order. */
  private drainPlugins(): DrainedPE[] {
    const drained: DrainedPE[] = [];
    for (const p of this.plugins) {
      if (!p.drainPEs) continue;
      let queued: PluginPE[] = [];
      try { queued = p.drainPEs() ?? []; } catch (err) {
        this.log('error', `plugin drain failed: ${p.name}`, { error: (err as Error).message });
        continue;
      }
      for (const pe of queued) drained.push({ plugin: p, pe });
    }
    return drained;
  }

  /**
   * Split one batch into the PEs to submit and the ones not submitted by design
   * (a same-turn duplicate lane folded into its winner, a non-minting
   * supplement). Merging happens BEFORE submission, so no sealed PE is mutated.
   */
  private partition(drained: DrainedPE[]): { toSubmit: DrainedPE[]; suppressed: DrainedPE[] } {
    // lane ownership is fixed at setup. There are no per-turn supplements or arbitration.
    return { toSubmit: drained, suppressed: [] };
  }

  /** Tell the plugin that handed `pe` over what became of it (review 4). Never throws. */
  private notifyCommitted(plugin: ObserverPlugin, pe: PluginPE, outcome: PECommitOutcome): void {
    try { plugin.onCommitted?.(pe, outcome); } catch (err) {
      this.log('warn', `plugin commit notice failed: ${plugin.name}`, { error: (err as Error).message });
    }
  }

  /**
   * Called by ProcessPlugin when a session boundary fires.
   */
  async onSessionEnded(state: SessionState, reason: 'idle' | 'max_duration'): Promise<void> {
    await this.finalizeSession(state, reason);
  }

  private async finalizeSession(state: SessionState, reason: 'idle' | 'max_duration'): Promise<void> {
    const start = state.startedAt;
    const end = Math.max(state.lastActivityAt, start + 1);

    if (this.dedup.isClaimed(start, end)) {
      this.log('debug', 'session window already claimed; skipping compute_session', { start, end });
      return;
    }

    const durationMs = end - start;
    const telemetry: ComputeTelemetry = {
      duration_ms: durationMs,
      cpu_seconds: state.accumulatedCpu > 0 ? state.accumulatedCpu : null,
      memory_peak_mb: state.peakMemoryMb > 0 ? state.peakMemoryMb : null,
      tokens_processed: state.tokensProcessed > 0 ? state.tokensProcessed : null,
      output_cardinality: null,
      records_processed: null,
      energy_joules: null,
      gpu_seconds: null,
      model_parameters: null,
      framework: null,
      hardware_class: os.arch(),
    };

    // THE TYPING RULE. A session is an `inference_session` when inference was
    // WITNESSED in its window: either a token count arrived from a source that
    // exposes one (the JSONL log, llama.cpp / LM Studio log lines) OR the LLM
    // plugin counted completed inference requests in a runtime's own request
    // log (Ollama exposes requests but no token counts). Before this rule the
    // type flipped on tokens ALONE, so a machine running Ollama — the common
    // case — could never produce an inference_session however much model work
    // it did. Requests are witnessed work; tokens are extra evidence when the
    // runtime provides them, and are never inferred when it does not.
    const inference = state.inference;
    const inferenceWitnessed = state.tokensProcessed > 0
      || (inference !== null && inference.requests > 0);
    const actionType = inferenceWitnessed ? 'inference_session' : 'compute_session';
    const metadata: Record<string, unknown> = {
      tool: 'provian-observer',
      session_reason: reason,
      network_calls: state.networkCalls,
    };
    if (inferenceWitnessed) {
      // Honest witness record: which runtime(s), how many completed requests,
      // which models were seen loaded/named, which source the counts came
      // from, and whether the token count above was OBSERVED (not estimated).
      metadata.inference = {
        runtime: inference === null
          ? 'jsonl'
          : (inference.runtimes.length === 1 ? inference.runtimes[0] : inference.runtimes.join('+')),
        requests: inference?.requests ?? 0,
        models: inference?.models ?? [],
        source: inference === null
          ? 'jsonl_inference_log'
          : (inference.sources.length === 1 ? inference.sources[0] : inference.sources.join('+')),
        tokens_observed: state.tokensProcessed > 0,
      };
    }
    if (state.pluginArtifacts.size > 0) {
      const artifacts: Record<string, unknown> = {};
      for (const [k, v] of state.pluginArtifacts) artifacts[k] = v;
      metadata.plugin_artifacts = artifacts;
    }

    // ---- compute_session output gate ------------------------------------
    //
    // Provian witnesses output, not compute. Minting requires a recognized
    // structured artifact from a plugin/witness - a git commit, an LLM
    // session, an OTel/agent span, or a forge webhook event. Raw or
    // sustained CPU is NOT a mint condition and NOT a mint weight; it
    // remains in the compute telemetry block as recorded ambient forensics
    // only. Generic file-write counts are no longer a signal either (the
    // opt-in FileSystemPlugin was removed in the narrow-tier teardown).
    //
    // A session that carries no structured artifact still generates a PE
    // for chain integrity - the observer is a mechanical witness, it can't
    // judge intent - but it carries the no-observable-output flag and the
    // relay leaves it `skipped_no_output` (records, never mints).
    //
    // The flag only attaches to `compute_session`; `inference_session`
    // already implies witnessed inference (observed tokens or completed
    // requests read from the runtime's own log) and therefore observable
    // output.
    //
    // The single qualifying signal is `pluginArtifacts.size > 0`: a plugin
    // captured a structured side-effect during this session window. In
    // practice git/OTel windows are claimed by their own plugin PEs (and
    // dedup-suppress the compute_session), and LLM windows flip to
    // inference_session via witnessed inference - so a bare compute_session
    // that reaches this gate is ambient CPU with no witnessed output and does
    // not mint.
    // The gate stays a general extension point: any future plugin that
    // contributes a structured artifact to the session mints through it.
    if (actionType === 'compute_session') {
      const hasObservableOutput = state.pluginArtifacts.size > 0;
      if (!hasObservableOutput) {
        metadata.null_state_flags = ['no_observable_output'];
      }
    }

    try {
      const result = await this.client[SUBMIT_OBSERVED_PE]({
        actionType,
        success: true,
        metadata,
        compute: telemetry,
        execution_env: this.executionEnv(),
        // Trust Layer §2.3: an inference session's outputs are the model responses the proxy tee
        // digested; a bare compute session observed nothing citable (key omitted, never a placeholder).
        output_digests: (inference?.responseDigests ?? []).length > 0
          ? (inference?.responseDigests ?? []).map((hash) => ({ hash, kind: 'response' as const }))
          : null,
        // the session that CAPTURED this evidence, not a fresh one.
        economic_session_lineage: state.lineage ?? undefined,
      });
      if (result && 'pe_id' in result) {
        this.log('info', 'session PE submitted', {
          action_type: actionType,
          pe_id: result.pe_id,
          duration_ms: durationMs,
        });
      }
    } catch (err) {
      this.log('warn', 'session PE submission failed', { error: (err as Error).message });
    }
  }

  /**
   * The device report one plugin PE is submitted as. New-type intake : a PE of a
   * type outside the observation lanes carries the observer's own witness marker naming the
   * registered plugin that handed it over — stamped HERE, by the observer, overriding anything the
   * plugin set, so the relay can admit it for review. A THIRD-PARTY plugin's PE carries that marker
   * whatever its type, with any built-in lane marker dropped (`withThirdPartyPluginWitness`); a
   * built-in lane's observation-type metadata is passed through untouched.
   */
  private reportFor(pe: PluginPE, captureSession: CaptureSession, pluginName: string, builtIn: boolean): DeviceActionReport {
    return {
      actionType: pe.actionType,
      description: pe.description,
      success: true,
      metadata: builtIn
        ? withObserverPluginWitness(pluginName, pe.actionType, pe.metadata)
        : withThirdPartyPluginWitness(pluginName, pe.metadata),
      compute: pe.compute ?? null,
      execution_env: pe.execution_env ?? this.executionEnv(),
      // Prompt 2: forward the external-artifact origins the plugin captured.
      // The device-submit route normalizes + stores + hashes them; omitted on
      // the wire when the plugin observed none (ProvianClient emits the key
      // only when normalize(...) !== null). PURE PROVENANCE, ZERO mint effect.
      input_origins: pe.input_origins ?? null,
      // Trust Layer §2.3: what the plugin observed this work PRODUCE (digests only).
      output_digests: pe.output_digests ?? null,
      // /the lineage of the session this PE was CAPTURED in, and
      // only when the PE's own window actually falls inside that session. A
      // PE whose window predates the snapshot session was captured outside it
      // and ships with NO lineage, so the fence holds — the honest answer,
      // and the one the relay cannot tell apart from a client that simply has
      // no attested session.
      economic_session_lineage: (captureSession !== null
        && captureSession.lineage !== null
        && pe.windowStart >= captureSession.startedAt)
        ? captureSession.lineage
        : undefined,
      // review 4: a lane that may resubmit this PE after a restart names
      // its key, so the relay answers a resubmission with the PE it made.
      ...(pe.idempotencyKey ? { idempotencyKey: pe.idempotencyKey } : {}),
      ...(typeof pe.occurredAtMs === 'number' ? { occurredAtMs: pe.occurredAtMs } : {}),
    };
  }

  /** Submit one plugin PE; its fate for the plugin's commit notice. */
  private async submitPluginPE(
    plugin: ObserverPlugin,
    pe: PluginPE,
    captureSession: CaptureSession,
  ): Promise<PECommitOutcome> {
    const pluginName = plugin.name;
    const builtIn = isBuiltInLane(plugin);
    // A third-party plugin is never one of the daemon's lanes: a type only a built-in lane witnesses
    // (a transcript-witnessed `link_spend`, a daemon lane's tool orchestration) is refused here,
    // loudly, and nothing is recorded. The relay refuses it under the plugin marker as well.
    if (!builtIn && BUILT_IN_LANE_ONLY_ACTION_TYPES.has(pe.actionType)) {
      this.log('error', 'plugin PE refused: only a built-in observer lane witnesses this action_type', {
        plugin: pluginName, action_type: pe.actionType,
      });
      return 'rejected';
    }
    if (this.config.credentials.ownerType !== 'agent' && ['agent_tool_orchestration', 'agent_api_orchestration', 'link_spend'].includes(pe.actionType)) return 'suppressed';
    // New-type intake: a non-observation PE — and every PE of a third-party plugin — rides the
    // observer's witness marker, which names the plugin. A name the relay's marker grammar refuses
    // would have every such act refused there while it reads `submitted` here — refuse it locally,
    // loudly, and record nothing.
    if ((!builtIn || !isDeviceObservationActionType(pe.actionType)) && !observerPluginNameCarriesMarker(pluginName)) {
      this.log('error', 'plugin PE refused: the plugin name cannot carry the observer witness marker', {
        plugin: pluginName, action_type: pe.actionType,
        rule: 'one printable token, at most 128 characters, starting with a letter or digit',
      });
      return 'rejected';
    }
    // The relay's own grammar and namespaces: a malformed type or a relay-owned name (`service:`,
    // `git_`) is refused there on every attempt — refuse it here, loudly, and record nothing. (A
    // NAMED type another lane witnesses still needs the relay's matrix; the receipt refuses it.)
    const typeRefusal = pluginActionTypeRefusal(pe.actionType);
    if (typeRefusal !== null) {
      this.log('error', 'plugin PE refused: the relay never accepts this action_type from a plugin', {
        plugin: pluginName, action_type: pe.actionType, reason: typeRefusal,
      });
      return 'rejected';
    }
    // Plugins that measure a different signal dimension than the generic
    // compute/inference/coding session family opt out of the registry to
    // preserve complementary signals. See PluginPE.skipDedupClaim.
    // An identity-decided PE (one response on its program’s lane) is never suppressed by a window: its lane
    // already decided it is the one mint of its turn.
    if (!pe.skipDedupClaim && pe.identityDecided !== true && this.dedup.isClaimed(pe.windowStart, pe.windowEnd)) {
      this.log('debug', 'plugin PE window already claimed; skipping', {
        plugin: pluginName, window: [pe.windowStart, pe.windowEnd],
      });
      return 'suppressed';
    }
    try {
      const result = await this.client[SUBMIT_OBSERVED_PE](this.reportFor(pe, captureSession, pluginName, builtIn));
      if (result && 'pe_id' in result) {
        if (!pe.skipDedupClaim) {
          this.dedup.claim(pe.windowStart, pe.windowEnd, result.pe_id, pluginName);
        }
        this.lastWorkPeAtMs = Date.now();
        this.log('info', 'plugin PE submitted', {
          plugin: pluginName,
          action_type: pe.actionType,
          pe_id: result.pe_id,
          // whether the relay recorded a NEW PE or answered a resubmission with the
          // one it made — `doctor` counts only new ones as real activity (a restart that lost
          // its lane state re-sends history, and the relay replays it).
          idempotent_replay: 'idempotent_replay' in result && result.idempotent_replay === true,
        });
        return 'submitted';
      }
      if (result === null) {
        // Never a silent drop: the PE was not recorded in this machine's PE store
        // (refused locally, or the store was unavailable — the client logged
        // which). Say so here too, so an intake that answered 202 never vanishes.
        this.log('warn', 'plugin PE not recorded on this attempt', {
          plugin: pluginName,
          action_type: pe.actionType,
        });
        const last = this.client.lastSubmitOutcome;
        return last === 'queued' ? 'journaled' : last === 'rejected' ? 'rejected' : 'failed';
      }
      return 'failed';
    } catch (err) {
      this.log('warn', 'plugin PE submission failed', {
        plugin: pluginName, error: (err as Error).message,
      });
      // A description the client refuses is refused every time: not retryable.
      return err instanceof PEDescriptionError ? 'rejected' : 'failed';
    }
  }

  private executionEnv(): ExecutionEnv {
    // Trust Layer §2.11: the container / environment class were one stat() away — read them.
    const facts = detectEnvironmentFacts();
    return {
      os: os.platform(),
      os_version: os.release(),
      runtime: 'node',
      runtime_version: process.versions.node,
      container: facts.container,
      environment_class: facts.environment_class,
      tee_type: null,
      tee_version: null,
    };
  }
}
