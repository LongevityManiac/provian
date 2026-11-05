import type { InferenceContribution, SessionState } from './types';
import { mintSessionLineageClaim } from './session-lineage';

export interface SessionTickInput {
  /** CPU utilization in fraction of one core (0.0 = idle, 1.0 = one core fully loaded) */
  cpuLoad: number;
  /** Current RSS in MB, if available */
  rssMb?: number;
  /** Wall-clock now() in ms */
  now: number;
}

export type SessionEvent =
  | { type: 'session_started'; state: SessionState }
  | { type: 'session_ended'; state: SessionState; reason: 'idle' | 'max_duration' }
  | { type: 'noop' };

/**
 * Detects compute-activity session boundaries from per-tick process stats.
 *
 * - Session starts when cpuLoad rises above activeThreshold.
 * - Session ends when cpuLoad stays below activeThreshold for idleThresholdMs,
 *   OR session duration exceeds maxSessionMs (forced end, immediately re-opens).
 */
export class SessionManager {
  private state: SessionState | null = null;
  private lastActiveTick: number = 0;

  constructor(
    private readonly idleThresholdMs: number,
    private readonly maxSessionMs: number,
    private readonly activeThreshold: number = 0.05,
    /**
     * the attested device credential this observer authenticates with.
     * It is the material the lineage id binds to, and the SAME identity the
     * relay independently resolves from device auth. Absent (or empty) means no
     * attested capture context: sessions open with `lineage: null` and their PEs
     * stay behind the lineage fence, which is the pre- behaviour.
     */
    private readonly attestedDeviceId: string | null = null,
    /**
     * reserves the DURABLE, strictly monotonic per-device session
     * ordinal the relay's registry requires. Absent means no ordinal can be
     * reserved, so sessions open with `lineage: null` and their PEs stay behind
     * the fence — the honest outcome, not a guessed sequence.
     */
    private readonly reserveSessionOrdinal: (() => number) | null = null,
  ) {}

  current(): SessionState | null {
    return this.state;
  }

  /**
   * drop the current session's lineage after the relay refused it.
   *
   * Its ordinal is not one the relay will admit, so every remaining PE in this
   * session would be refused too. Clearing it means those PEs RECORD behind the
   * fence — the honest, pre-lineage outcome — instead of not being recorded at
   * all. It does NOT re-mint: minting per PE is the exact construction the
   * causal-session rule forbids, and the next session opens with a resynchronised
   * ordinal.
   */
  clearLineage(): void {
    if (this.state !== null) this.state.lineage = null;
  }

  /**
   * Feed one tick of process stats. Returns an event if a session boundary fired.
   */
  tick(input: SessionTickInput): SessionEvent {
    const { cpuLoad, rssMb, now } = input;
    const isActive = cpuLoad >= this.activeThreshold;

    if (!this.state) {
      if (isActive) return this.open(now, rssMb ?? 0);
      return { type: 'noop' };
    }

    if (isActive) {
      this.state.lastActivityAt = now;
      this.lastActiveTick = now;
    }

    if (typeof rssMb === 'number' && rssMb > this.state.peakMemoryMb) {
      this.state.peakMemoryMb = rssMb;
    }

    return this.expire(now);
  }

  /**
   * Witnessed activity from a NON-CPU signal — a completed local inference
   * request read from the runtime's own log. Opens a session if none is open
   * (minting its lineage exactly as a CPU-opened session does) and otherwise
   * extends the current one. This is the ONLY way a session opens on a human
   * device, where ProcessPlugin is gated off and no CPU sample ever arrives.
   * The same one-session-one-lineage rule holds: activity never re-mints.
   */
  witnessActivity(now: number): SessionEvent {
    if (!this.state) return this.open(now, 0);
    this.state.lastActivityAt = now;
    this.lastActiveTick = now;
    return { type: 'noop' };
  }

  /**
   * Close the current session if it has idled past the threshold or outlived
   * its maximum duration. Pure bookkeeping: it never opens a session and never
   * touches lineage. Called by the observer's own tick so a session opened by
   * `witnessActivity` still closes when no ProcessPlugin sample drives `tick`.
   */
  expire(now: number): SessionEvent {
    if (!this.state) return { type: 'noop' };

    const duration = now - this.state.startedAt;
    if (duration >= this.maxSessionMs) {
      const ended = this.state;
      this.state = null;
      return { type: 'session_ended', state: ended, reason: 'max_duration' };
    }

    const idleFor = now - this.lastActiveTick;
    if (idleFor >= this.idleThresholdMs) {
      const ended = this.state;
      this.state = null;
      return { type: 'session_ended', state: ended, reason: 'idle' };
    }

    return { type: 'noop' };
  }

  private open(now: number, rssMb: number): SessionEvent {
    this.state = {
      active: true,
      startedAt: now,
      lastActivityAt: now,
      accumulatedCpu: 0,
      peakMemoryMb: rssMb,
      networkCalls: 0,
      tokensProcessed: 0,
      pluginArtifacts: new Map(),
      inference: null,
      // Minted HERE and only here: one attested runtime session, one lineage
      // id, fixed for the session's whole life.
      lineage: mintSessionLineageClaim({
        attestedDeviceId: this.attestedDeviceId,
        sessionStartedAtMs: now,
        sessionOrdinal: this.reserveSessionOrdinal === null
          ? null
          : this.reserveSessionOrdinal(),
      }),
    };
    this.lastActiveTick = now;
    return { type: 'session_started', state: this.state };
  }

  /**
   * Force the current session to end (e.g. on shutdown) and return it.
   */
  flush(now = Date.now(), reason: 'idle' | 'max_duration' = 'idle'): SessionState | null {
    if (!this.state) return null;
    const ended = this.state;
    ended.lastActivityAt = now;
    this.state = null;
    return ended;
  }

  /**
   * Called by ProcessPlugin to accumulate CPU time into the active session.
   */
  addCpuSeconds(seconds: number): void {
    if (this.state) this.state.accumulatedCpu += seconds;
  }

  /**
   * Called by plugins to contribute arbitrary session metadata.
   */
  setArtifact(plugin: string, data: Record<string, unknown>): void {
    if (this.state) this.state.pluginArtifacts.set(plugin, data);
  }

  addTokens(n: number): void {
    if (this.state) this.state.tokensProcessed += n;
  }

  /**
   * Accumulate one tick of witnessed local inference into the open session.
   * Requests add; model/runtime/source names union (order of first sight);
   * `tokensObserved` latches true once any token-bearing source contributes.
   */
  addInference(c: InferenceContribution): void {
    if (!this.state) return;
    const cur = this.state.inference ?? {
      requests: 0, models: [], runtimes: [], sources: [], tokensObserved: false,
    };
    cur.requests += c.requests;
    for (const m of c.models) if (!cur.models.includes(m)) cur.models.push(m);
    if (!cur.runtimes.includes(c.runtime)) cur.runtimes.push(c.runtime);
    if (!cur.sources.includes(c.source)) cur.sources.push(c.source);
    cur.tokensObserved = cur.tokensObserved || c.tokensObserved;
    if (c.responseDigests && c.responseDigests.length > 0) {
      const acc = cur.responseDigests ?? [];
      for (const d of c.responseDigests) { if (acc.length >= 64) break; if (!acc.includes(d)) acc.push(d); }
      cur.responseDigests = acc;
    }
    this.state.inference = cur;
  }

  incrementNetworkCalls(n = 1): void {
    if (this.state) this.state.networkCalls += n;
  }
}
