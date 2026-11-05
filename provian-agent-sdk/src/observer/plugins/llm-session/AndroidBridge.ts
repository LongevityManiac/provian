/**
 * AndroidBridge: TCP-based alternative to HelperBridge for Android capture.
 *
 * Connects to the Provian companion app running on an Android device via
 * ADB port forwarding (default: tcp:19847) or direct TCP on a local
 * network. Reads line-delimited JSON over the TCP stream (same format as
 * the macOS foreground helper) and enqueues validated events for the
 * plugin to drain.
 *
 * The bridge implements the same drain() interface as HelperBridge so
 * LLMSessionPlugin can use either interchangeably.
 *
 * Reconnection uses exponential backoff (same schedule pattern as
 * HelperBridge). The backpressure / eviction policy is identical:
 * input_event is the only evictable event type when the queue is full.
 *
 * Spec of record: docs/CAPTURE_ARCHITECTURE.md §5, §9.
 */

import * as net from 'net';
import {
  LineDelimitedJsonReader,
  type HelperIPCEvent,
} from './ipc';

// --- connection interface ------------------------------------------------

/**
 * Minimal TCP socket surface the bridge depends on. Real net.Socket
 * satisfies this; tests pass in a fake.
 */
export interface AndroidConnectionLike {
  on(event: 'data', listener: (data: Buffer) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  destroy(): void;
}

export type CreateConnectionFn = (host: string, port: number) => AndroidConnectionLike;

// --- config --------------------------------------------------------------

export interface AndroidBridgeConfig {
  /** TCP host to connect to. Default: '127.0.0.1' (ADB forwarded). */
  host?: string;
  /** TCP port. Default: 19847. */
  port?: number;
  /** Maximum queued events before input_event eviction kicks in. */
  maxQueueDepth?: number;
  /** Backoff schedule for reconnection attempts, in ms. Repeats last value. */
  backoffScheduleMs?: number[];
  /** If connected for this long, the attempt counter resets. */
  healthyRuntimeMs?: number;
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /** Injected for tests; defaults to net.createConnection. */
  createConnectionFn?: CreateConnectionFn;
  /** Injected clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** Injected timer for tests. Defaults to setTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimeoutFn?: (handle: NodeJS.Timeout | number) => void;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 19847;
const DEFAULT_MAX_QUEUE = 10_000;
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
const DEFAULT_HEALTHY_RUNTIME_MS = 30_000;

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

// --- bridge --------------------------------------------------------------

export class AndroidBridge {
  private readonly config: {
    host: string;
    port: number;
    maxQueueDepth: number;
    backoffScheduleMs: number[];
    healthyRuntimeMs: number;
    logger: NonNullable<AndroidBridgeConfig['logger']>;
    createConnectionFn: CreateConnectionFn;
    now: () => number;
    setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout | number;
    clearTimeoutFn: (handle: NodeJS.Timeout | number) => void;
  };

  private connection: AndroidConnectionLike | null = null;
  private reader: LineDelimitedJsonReader | null = null;
  private started = false;
  private stopped = false;
  private queue: HelperIPCEvent[] = [];
  private droppedInputEventCount = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | number | null = null;
  private connectStartedAt = 0;
  /** Guard against duplicate onConnectionGone calls from error+close. */
  private connectionGoneHandled = false;

  constructor(cfg: AndroidBridgeConfig) {
    this.config = {
      host: cfg.host ?? DEFAULT_HOST,
      port: cfg.port ?? DEFAULT_PORT,
      maxQueueDepth: cfg.maxQueueDepth ?? DEFAULT_MAX_QUEUE,
      backoffScheduleMs: cfg.backoffScheduleMs ?? DEFAULT_BACKOFF_MS,
      healthyRuntimeMs: cfg.healthyRuntimeMs ?? DEFAULT_HEALTHY_RUNTIME_MS,
      logger: cfg.logger ?? (() => {}),
      createConnectionFn: cfg.createConnectionFn ?? defaultCreateConnection,
      now: cfg.now ?? (() => Date.now()),
      setTimeoutFn: cfg.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeoutFn: cfg.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout)),
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      this.config.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connection) {
      try { this.connection.destroy(); } catch { /* ignore */ }
    }
    this.connection = null;
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
  getReconnectAttempts(): number { return this.reconnectAttempts; }
  isRunning(): boolean { return this.connection !== null && !this.stopped; }

  private connect(): void {
    if (this.stopped) return;
    this.connectStartedAt = this.config.now();
    this.connectionGoneHandled = false;

    let conn: AndroidConnectionLike;
    try {
      conn = this.config.createConnectionFn(this.config.host, this.config.port);
    } catch (err) {
      this.config.logger('error', 'android bridge connection threw', { error: (err as Error).message });
      this.scheduleReconnect();
      return;
    }
    this.connection = conn;
    this.config.logger('info', 'android bridge connected', {
      host: this.config.host,
      port: this.config.port,
    });

    this.reader = new LineDelimitedJsonReader(
      (ev) => this.enqueue(ev),
      (line, reason) => this.config.logger('warn', 'android bridge parse error', { line, reason }),
    );

    conn.on('data', (chunk: Buffer) => {
      this.reader?.feed(chunk.toString('utf8'));
    });

    conn.on('close', () => {
      this.config.logger('info', 'android bridge connection closed');
      this.onConnectionGone();
    });

    conn.on('error', (err: Error) => {
      this.config.logger('error', 'android bridge connection error', { error: err.message });
      this.onConnectionGone();
    });
  }

  private onConnectionGone(): void {
    if (this.connectionGoneHandled) return;
    this.connectionGoneHandled = true;

    this.connection = null;
    this.reader?.flush();
    this.reader = null;
    if (this.stopped) return;

    const runtimeMs = this.config.now() - this.connectStartedAt;
    if (runtimeMs >= this.config.healthyRuntimeMs) {
      this.reconnectAttempts = 0;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const schedule = this.config.backoffScheduleMs;
    const idx = Math.min(this.reconnectAttempts, schedule.length - 1);
    const delay = schedule[idx];
    this.reconnectAttempts++;
    this.config.logger('info', 'android bridge reconnect scheduled', {
      attempt: this.reconnectAttempts,
      delay_ms: delay,
    });
    this.reconnectTimer = this.config.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.connect();
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

function defaultCreateConnection(host: string, port: number): AndroidConnectionLike {
  return net.createConnection({ host, port }) as unknown as AndroidConnectionLike;
}
