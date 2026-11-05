/**
 * Cross-OS helper bridge for the LLM session plugin.
 *
 * Spawns the native foreground helper as a child process, reads
 * line-delimited JSON on stdout, validates each event, and enqueues it
 * for the plugin to drain. Restarts the helper with exponential backoff
 * on exit or fatal.
 *
 * Spec of record: docs/PHASE_2B_DESIGN_NOTES.md §2.
 *
 * No OS-specific code lives here. The helper binary per OS is selected by
 * the plugin layer and passed in via HelperBridgeConfig.binaryPath.
 *
 * Zero-dependency: hand-rolled validators (the SDK does not take a Zod
 * runtime dependency). The validator surface mirrors what Zod would
 * produce: either { ok: true; value } or { ok: false; error }.
 */

import { spawn, type ChildProcess } from 'child_process';
import { Readable } from 'stream';

// --- IPC event types ---------------------------------------------------

export interface ForegroundChangedEvent {
  t: 'foreground_changed';
  ts: number;
  app: { bundle_id: string | null; process_name: string | null };
  browser_url: string | null;
}

export interface InputIpcEvent {
  t: 'input_event';
  ts: number;
}

export interface SystemStateEvent {
  t: 'system_state';
  ts: number;
  state: 'sleep' | 'wake' | 'lock' | 'unlock';
}

export interface PermissionStatusEvent {
  t: 'permission_status';
  ts: number;
  accessibility: boolean;
  input_monitoring: boolean;
}

export interface ErrorIpcEvent {
  t: 'error';
  ts: number;
  message: string;
}

export interface FatalIpcEvent {
  t: 'fatal';
  ts: number;
  message: string;
}

/**
 * Events emitted by the native foreground helper over stdout.
 * Validated at the IPC boundary before enqueueing.
 */
export type HelperIPCEvent =
  | ForegroundChangedEvent
  | InputIpcEvent
  | SystemStateEvent
  | PermissionStatusEvent
  | ErrorIpcEvent
  | FatalIpcEvent;

/**
 * Events that are never evicted under backpressure. input_event is the
 * only event type that may be dropped when the queue is full.
 */
const CRITICAL_EVENT_TYPES = new Set<HelperIPCEvent['t']>([
  'foreground_changed',
  'system_state',
  'permission_status',
  'error',
  'fatal',
]);

// --- validation --------------------------------------------------------

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateHelperIPCEvent(raw: unknown): ValidationResult<HelperIPCEvent> {
  if (!isObject(raw)) return fail('not an object');
  const ts = raw.ts;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return fail('ts must be a finite number');

  switch (raw.t) {
    case 'foreground_changed': {
      if (!isObject(raw.app)) return fail('foreground_changed.app must be an object');
      const bundleId = raw.app.bundle_id;
      const processName = raw.app.process_name;
      if (bundleId !== null && typeof bundleId !== 'string') return fail('app.bundle_id must be string or null');
      if (processName !== null && typeof processName !== 'string') return fail('app.process_name must be string or null');
      const browserUrl = raw.browser_url;
      if (browserUrl !== null && typeof browserUrl !== 'string') return fail('browser_url must be string or null');
      return ok({
        t: 'foreground_changed', ts,
        app: { bundle_id: bundleId, process_name: processName },
        browser_url: browserUrl,
      });
    }
    case 'input_event':
      return ok({ t: 'input_event', ts });
    case 'system_state': {
      if (raw.state !== 'sleep' && raw.state !== 'wake' && raw.state !== 'lock' && raw.state !== 'unlock') {
        return fail('system_state.state must be sleep|wake|lock|unlock');
      }
      return ok({ t: 'system_state', ts, state: raw.state });
    }
    case 'permission_status': {
      if (typeof raw.accessibility !== 'boolean') return fail('permission_status.accessibility must be boolean');
      if (typeof raw.input_monitoring !== 'boolean') return fail('permission_status.input_monitoring must be boolean');
      return ok({
        t: 'permission_status', ts,
        accessibility: raw.accessibility,
        input_monitoring: raw.input_monitoring,
      });
    }
    case 'error':
    case 'fatal': {
      if (typeof raw.message !== 'string') return fail(`${raw.t}.message must be a string`);
      return ok({ t: raw.t, ts, message: raw.message });
    }
    default:
      return fail(`unknown event type: ${JSON.stringify(raw.t)}`);
  }
}

function ok<T>(value: T): ValidationResult<T> { return { ok: true, value }; }
function fail<T>(error: string): ValidationResult<T> { return { ok: false, error }; }
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --- line-delimited JSON reader ---------------------------------------

/**
 * Reads a utf-8 byte stream and yields events per complete newline-
 * terminated line. Callers receive validated events (or validation
 * errors logged and skipped).
 */
export class LineDelimitedJsonReader {
  private buf = '';

  constructor(private readonly onEvent: (ev: HelperIPCEvent) => void,
              private readonly onParseError: (line: string, reason: string) => void) {}

  feed(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        this.onParseError(line, `invalid JSON: ${(e as Error).message}`);
        continue;
      }
      const result = validateHelperIPCEvent(parsed);
      if (!result.ok) {
        this.onParseError(line, result.error);
        continue;
      }
      this.onEvent(result.value);
    }
  }

  flush(): void {
    if (this.buf.trim().length > 0) {
      this.onParseError(this.buf, 'stream ended mid-line');
    }
    this.buf = '';
  }
}

// --- bridge -----------------------------------------------------------

export type SpawnFn = (
  binary: string,
  args: string[],
  opts: { stdio: 'pipe' },
) => ChildProcessLike;

/**
 * Minimal ChildProcess surface the bridge depends on. Real child_process
 * satisfies this; tests pass in a fake.
 */
export interface ChildProcessLike {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly pid: number | undefined;
  kill(signal?: string): boolean;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export interface HelperBridgeConfig {
  binaryPath: string;
  args?: string[];
  /** Maximum queued events before input_event eviction kicks in. */
  maxQueueDepth?: number;
  /** Backoff schedule for restart attempts, in ms. Repeats last value. */
  backoffScheduleMs?: number[];
  /** If the helper stays alive for this long, the attempt counter resets. */
  healthyRuntimeMs?: number;
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /** Injected for tests; defaults to child_process.spawn wrapped to our ChildProcessLike. */
  spawnFn?: SpawnFn;
  /** Injected clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** Injected timer for tests. Defaults to setTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimeoutFn?: (handle: NodeJS.Timeout | number) => void;
}

const DEFAULT_MAX_QUEUE = 10_000;
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
const DEFAULT_HEALTHY_RUNTIME_MS = 30_000;

export class HelperBridge {
  private readonly config: Required<Omit<HelperBridgeConfig, 'args' | 'logger'>> & {
    args: string[];
    logger: NonNullable<HelperBridgeConfig['logger']>;
  };
  private child: ChildProcessLike | null = null;
  private reader: LineDelimitedJsonReader | null = null;
  private started = false;
  private stopped = false;
  private queue: HelperIPCEvent[] = [];
  private droppedInputEventCount = 0;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | number | null = null;
  private spawnStartedAt = 0;

  constructor(cfg: HelperBridgeConfig) {
    this.config = {
      binaryPath: cfg.binaryPath,
      args: cfg.args ?? [],
      maxQueueDepth: cfg.maxQueueDepth ?? DEFAULT_MAX_QUEUE,
      backoffScheduleMs: cfg.backoffScheduleMs ?? DEFAULT_BACKOFF_MS,
      healthyRuntimeMs: cfg.healthyRuntimeMs ?? DEFAULT_HEALTHY_RUNTIME_MS,
      logger: cfg.logger ?? (() => {}),
      spawnFn: cfg.spawnFn ?? defaultSpawn,
      now: cfg.now ?? (() => Date.now()),
      setTimeoutFn: cfg.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeoutFn: cfg.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout)),
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer !== null) {
      this.config.clearTimeoutFn(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child && typeof this.child.kill === 'function') {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.child = null;
    this.reader?.flush();
    this.reader = null;
  }

  /**
   * Drain the queue of pending events. Callers (the plugin) call this on
   * each tick. Clears the internal queue.
   */
  drain(): HelperIPCEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  getQueueDepth(): number { return this.queue.length; }
  getDroppedInputEventCount(): number { return this.droppedInputEventCount; }
  getRestartAttempts(): number { return this.restartAttempts; }
  isRunning(): boolean { return this.child !== null && !this.stopped; }

  private spawnChild(): void {
    if (this.stopped) return;
    this.spawnStartedAt = this.config.now();
    let child: ChildProcessLike;
    try {
      child = this.config.spawnFn(this.config.binaryPath, this.config.args, { stdio: 'pipe' });
    } catch (err) {
      this.config.logger('error', 'helper spawn threw', { error: (err as Error).message });
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.config.logger('info', 'helper spawned', { pid: child.pid });

    this.reader = new LineDelimitedJsonReader(
      (ev) => this.enqueue(ev),
      (line, reason) => this.config.logger('warn', 'helper parse error', { line, reason }),
    );

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.reader?.feed(chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.config.logger('warn', 'helper stderr', { chunk: chunk.trim() });
      });
    }

    child.on('exit', (code, signal) => {
      this.config.logger('info', 'helper exited', { code, signal });
      this.onChildGone();
    });
    child.on('error', (err) => {
      this.config.logger('error', 'helper errored', { error: err.message });
      this.onChildGone();
    });
  }

  private onChildGone(): void {
    this.child = null;
    this.reader?.flush();
    this.reader = null;
    if (this.stopped) return;

    const runtimeMs = this.config.now() - this.spawnStartedAt;
    if (runtimeMs >= this.config.healthyRuntimeMs) {
      this.restartAttempts = 0;
    }
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    const schedule = this.config.backoffScheduleMs;
    const idx = Math.min(this.restartAttempts, schedule.length - 1);
    const delay = schedule[idx];
    this.restartAttempts++;
    this.config.logger('info', 'helper restart scheduled', {
      attempt: this.restartAttempts,
      delay_ms: delay,
    });
    this.restartTimer = this.config.setTimeoutFn(() => {
      this.restartTimer = null;
      this.spawnChild();
    }, delay);
  }

  private enqueue(ev: HelperIPCEvent): void {
    if (this.queue.length >= this.config.maxQueueDepth) {
      if (ev.t === 'input_event') {
        this.droppedInputEventCount++;
        return;
      }
      const evictIdx = this.queue.findIndex(e => e.t === 'input_event');
      if (evictIdx !== -1) {
        this.queue.splice(evictIdx, 1);
        this.droppedInputEventCount++;
      }
    }
    this.queue.push(ev);
  }
}

function defaultSpawn(
  binary: string,
  args: string[],
  opts: { stdio: 'pipe' },
): ChildProcessLike {
  const cp = spawn(binary, args, opts) as ChildProcess;
  return cp as unknown as ChildProcessLike;
}
