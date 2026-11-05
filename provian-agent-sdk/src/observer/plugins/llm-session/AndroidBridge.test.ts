/**
 * Tests for AndroidBridge: TCP connection lifecycle, line-delimited JSON
 * parsing, reconnection with backoff, drain interface, and backpressure.
 *
 * All tests use injected dependencies (createConnectionFn, now, setTimeout)
 * following the same pattern as ipc.test.ts for HelperBridge.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  AndroidBridge,
  type AndroidConnectionLike,
} from './AndroidBridge';

// ---- FakeConnection (TCP socket fake) -----------------------------------

class FakeConnection extends EventEmitter implements AndroidConnectionLike {
  destroyed = false;

  emitData(s: string): void {
    this.emit('data', Buffer.from(s, 'utf8'));
  }

  emitClose(): void {
    this.emit('close');
  }

  emitError(msg: string): void {
    this.emit('error', new Error(msg));
  }

  destroy(): void {
    this.destroyed = true;
  }
}

// ---- Manual timer (same pattern as ipc.test.ts) -------------------------

function makeManualTimer() {
  interface Scheduled { id: number; fn: () => void; }
  let nextId = 1;
  const queue: Scheduled[] = [];
  const setTimeoutFn = (fn: () => void, _ms: number) => {
    const id = nextId++;
    queue.push({ id, fn });
    return id;
  };
  const clearTimeoutFn = (handle: NodeJS.Timeout | number) => {
    const idx = queue.findIndex(s => s.id === handle);
    if (idx !== -1) queue.splice(idx, 1);
  };
  const runAll = () => {
    while (queue.length > 0) {
      const { fn } = queue.shift()!;
      fn();
    }
  };
  const pendingCount = () => queue.length;
  const runNext = () => {
    const next = queue.shift();
    if (next) next.fn();
  };
  return { setTimeoutFn, clearTimeoutFn, runAll, pendingCount, runNext };
}

// =========================================================================
// AndroidBridge: lifecycle
// =========================================================================

describe('AndroidBridge: lifecycle', () => {
  it('connects on start and destroys on stop', () => {
    let conn: FakeConnection | null = null;
    const bridge = new AndroidBridge({
      createConnectionFn: () => {
        conn = new FakeConnection();
        return conn;
      },
    });
    bridge.start();
    expect(conn).not.toBeNull();
    expect(bridge.isRunning()).toBe(true);
    bridge.stop();
    expect(conn!.destroyed).toBe(true);
    expect(bridge.isRunning()).toBe(false);
  });

  it('ignores double start', () => {
    let count = 0;
    const bridge = new AndroidBridge({
      createConnectionFn: () => { count++; return new FakeConnection(); },
    });
    bridge.start();
    bridge.start();
    expect(count).toBe(1);
    bridge.stop();
  });

  it('passes host and port to createConnectionFn', () => {
    let capturedHost = '';
    let capturedPort = 0;
    const bridge = new AndroidBridge({
      host: '192.168.1.50',
      port: 12345,
      createConnectionFn: (host, port) => {
        capturedHost = host;
        capturedPort = port;
        return new FakeConnection();
      },
    });
    bridge.start();
    expect(capturedHost).toBe('192.168.1.50');
    expect(capturedPort).toBe(12345);
    bridge.stop();
  });

  it('uses default host and port when not specified', () => {
    let capturedHost = '';
    let capturedPort = 0;
    const bridge = new AndroidBridge({
      createConnectionFn: (host, port) => {
        capturedHost = host;
        capturedPort = port;
        return new FakeConnection();
      },
    });
    bridge.start();
    expect(capturedHost).toBe('127.0.0.1');
    expect(capturedPort).toBe(19847);
    bridge.stop();
  });
});

// =========================================================================
// AndroidBridge: event flow
// =========================================================================

describe('AndroidBridge: event flow', () => {
  it('enqueues validated events from data in order', () => {
    let conn!: FakeConnection;
    const bridge = new AndroidBridge({
      createConnectionFn: () => { conn = new FakeConnection(); return conn; },
    });
    bridge.start();
    conn.emitData('{"t":"foreground_changed","ts":1,"app":{"bundle_id":"com.anthropic.claude","process_name":"Claude"},"browser_url":null}\n');
    conn.emitData('{"t":"input_event","ts":2}\n');
    const drained = bridge.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0].t).toBe('foreground_changed');
    expect(drained[1].t).toBe('input_event');
    expect(bridge.drain()).toHaveLength(0);
    bridge.stop();
  });

  it('silently ignores invalid lines', () => {
    let conn!: FakeConnection;
    const bridge = new AndroidBridge({
      createConnectionFn: () => { conn = new FakeConnection(); return conn; },
    });
    bridge.start();
    conn.emitData('garbage\n');
    conn.emitData('{"t":"input_event","ts":1}\n');
    expect(bridge.drain()).toHaveLength(1);
    bridge.stop();
  });

  it('handles line split across multiple data chunks', () => {
    let conn!: FakeConnection;
    const bridge = new AndroidBridge({
      createConnectionFn: () => { conn = new FakeConnection(); return conn; },
    });
    bridge.start();
    conn.emitData('{"t":"input_');
    conn.emitData('event","ts":1}\n');
    const drained = bridge.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0].t).toBe('input_event');
    bridge.stop();
  });

  it('handles multiple lines in a single data chunk', () => {
    let conn!: FakeConnection;
    const bridge = new AndroidBridge({
      createConnectionFn: () => { conn = new FakeConnection(); return conn; },
    });
    bridge.start();
    conn.emitData('{"t":"input_event","ts":1}\n{"t":"input_event","ts":2}\n{"t":"input_event","ts":3}\n');
    expect(bridge.drain()).toHaveLength(3);
    bridge.stop();
  });

  it('handles all IPC event types', () => {
    let conn!: FakeConnection;
    const bridge = new AndroidBridge({
      createConnectionFn: () => { conn = new FakeConnection(); return conn; },
    });
    bridge.start();
    conn.emitData('{"t":"foreground_changed","ts":1,"app":{"bundle_id":"x","process_name":"X"},"browser_url":null}\n');
    conn.emitData('{"t":"input_event","ts":2}\n');
    conn.emitData('{"t":"system_state","ts":3,"state":"sleep"}\n');
    conn.emitData('{"t":"permission_status","ts":4,"accessibility":true,"input_monitoring":true}\n');
    conn.emitData('{"t":"error","ts":5,"message":"oops"}\n');
    conn.emitData('{"t":"fatal","ts":6,"message":"dead"}\n');
    const drained = bridge.drain();
    expect(drained).toHaveLength(6);
    expect(drained.map(e => e.t)).toEqual([
      'foreground_changed', 'input_event', 'system_state',
      'permission_status', 'error', 'fatal',
    ]);
    bridge.stop();
  });
});

// =========================================================================
// AndroidBridge: backpressure
// =========================================================================

describe('AndroidBridge: backpressure', () => {
  it('drops incoming input_event when queue is full of input_events', () => {
    let conn!: FakeConnection;
    const bridge = new AndroidBridge({
      maxQueueDepth: 3,
      createConnectionFn: () => { conn = new FakeConnection(); return conn; },
    });
    bridge.start();
    for (let i = 1; i <= 4; i++) {
      conn.emitData(`{"t":"input_event","ts":${i}}\n`);
    }
    expect(bridge.getDroppedInputEventCount()).toBe(1);
    const drained = bridge.drain();
    expect(drained).toHaveLength(3);
    bridge.stop();
  });

  it('evicts oldest input_event to make room for a foreground_changed event', () => {
    let conn!: FakeConnection;
    const bridge = new AndroidBridge({
      maxQueueDepth: 3,
      createConnectionFn: () => { conn = new FakeConnection(); return conn; },
    });
    bridge.start();
    conn.emitData('{"t":"input_event","ts":1}\n');
    conn.emitData('{"t":"input_event","ts":2}\n');
    conn.emitData('{"t":"input_event","ts":3}\n');
    conn.emitData('{"t":"foreground_changed","ts":4,"app":{"bundle_id":null,"process_name":null},"browser_url":null}\n');
    expect(bridge.getDroppedInputEventCount()).toBe(1);
    const drained = bridge.drain();
    const types = drained.map(e => e.t);
    expect(types).toContain('foreground_changed');
    expect(types.filter(t => t === 'input_event')).toHaveLength(2);
    bridge.stop();
  });

  it('never drops critical events even when queue is full of critical events', () => {
    let conn!: FakeConnection;
    const bridge = new AndroidBridge({
      maxQueueDepth: 2,
      createConnectionFn: () => { conn = new FakeConnection(); return conn; },
    });
    bridge.start();
    conn.emitData('{"t":"foreground_changed","ts":1,"app":{"bundle_id":null,"process_name":null},"browser_url":null}\n');
    conn.emitData('{"t":"system_state","ts":2,"state":"sleep"}\n');
    conn.emitData('{"t":"foreground_changed","ts":3,"app":{"bundle_id":null,"process_name":null},"browser_url":null}\n');
    expect(bridge.getDroppedInputEventCount()).toBe(0);
    const drained = bridge.drain();
    expect(drained).toHaveLength(3);
    bridge.stop();
  });

  it('drops incoming input_event when queue is full of critical events', () => {
    let conn!: FakeConnection;
    const bridge = new AndroidBridge({
      maxQueueDepth: 2,
      createConnectionFn: () => { conn = new FakeConnection(); return conn; },
    });
    bridge.start();
    conn.emitData('{"t":"foreground_changed","ts":1,"app":{"bundle_id":null,"process_name":null},"browser_url":null}\n');
    conn.emitData('{"t":"foreground_changed","ts":2,"app":{"bundle_id":null,"process_name":null},"browser_url":null}\n');
    conn.emitData('{"t":"input_event","ts":3}\n');
    expect(bridge.getDroppedInputEventCount()).toBe(1);
    const drained = bridge.drain();
    expect(drained).toHaveLength(2);
    expect(drained.every(e => e.t === 'foreground_changed')).toBe(true);
    bridge.stop();
  });
});

// =========================================================================
// AndroidBridge: reconnection and backoff
// =========================================================================

describe('AndroidBridge: reconnect and backoff', () => {
  it('schedules a reconnect on connection close', () => {
    const connections: FakeConnection[] = [];
    const timer = makeManualTimer();
    const bridge = new AndroidBridge({
      backoffScheduleMs: [100, 200, 500],
      healthyRuntimeMs: 10_000,
      createConnectionFn: () => { const c = new FakeConnection(); connections.push(c); return c; },
      now: () => 0,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    expect(connections).toHaveLength(1);
    connections[0].emitClose();
    expect(timer.pendingCount()).toBe(1);
    timer.runAll();
    expect(connections).toHaveLength(2);
    bridge.stop();
  });

  it('schedules a reconnect on connection error', () => {
    const connections: FakeConnection[] = [];
    const timer = makeManualTimer();
    const bridge = new AndroidBridge({
      backoffScheduleMs: [100],
      healthyRuntimeMs: 10_000,
      createConnectionFn: () => { const c = new FakeConnection(); connections.push(c); return c; },
      now: () => 0,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    connections[0].emitError('ECONNREFUSED');
    expect(timer.pendingCount()).toBe(1);
    timer.runAll();
    expect(connections).toHaveLength(2);
    bridge.stop();
  });

  it('does not double-reconnect on error followed by close', () => {
    const connections: FakeConnection[] = [];
    const timer = makeManualTimer();
    const bridge = new AndroidBridge({
      backoffScheduleMs: [100],
      healthyRuntimeMs: 10_000,
      createConnectionFn: () => { const c = new FakeConnection(); connections.push(c); return c; },
      now: () => 0,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    // Emit both error and close (as real TCP sockets do).
    connections[0].emitError('ECONNRESET');
    connections[0].emitClose();
    expect(timer.pendingCount()).toBe(1); // Only one reconnect scheduled.
    timer.runAll();
    expect(connections).toHaveLength(2);
    bridge.stop();
  });

  it('walks the backoff schedule on repeated failures', () => {
    const connections: FakeConnection[] = [];
    const timer = makeManualTimer();
    let nowMs = 0;
    const bridge = new AndroidBridge({
      backoffScheduleMs: [100, 200, 500, 1000],
      healthyRuntimeMs: 10_000,
      createConnectionFn: () => { const c = new FakeConnection(); connections.push(c); return c; },
      now: () => nowMs,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    for (let i = 0; i < 6; i++) {
      connections[connections.length - 1].emitClose();
      timer.runAll();
      nowMs += 1;
    }
    expect(bridge.getReconnectAttempts()).toBeGreaterThanOrEqual(6);
    bridge.stop();
  });

  it('resets attempt counter after a healthy runtime', () => {
    const connections: FakeConnection[] = [];
    const timer = makeManualTimer();
    let nowMs = 0;
    const bridge = new AndroidBridge({
      backoffScheduleMs: [100, 200, 500, 1000],
      healthyRuntimeMs: 5_000,
      createConnectionFn: () => { const c = new FakeConnection(); connections.push(c); return c; },
      now: () => nowMs,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    connections[0].emitClose();
    timer.runAll();
    connections[1].emitClose();
    timer.runAll();
    expect(bridge.getReconnectAttempts()).toBeGreaterThanOrEqual(2);
    // Simulate a long healthy connection before the next close.
    nowMs += 20_000;
    connections[2].emitClose();
    expect(bridge.getReconnectAttempts()).toBe(1);
    bridge.stop();
  });

  it('stop() prevents scheduled reconnect from firing', () => {
    let conn!: FakeConnection;
    const timer = makeManualTimer();
    const bridge = new AndroidBridge({
      backoffScheduleMs: [100],
      createConnectionFn: () => { conn = new FakeConnection(); return conn; },
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    conn.emitClose();
    expect(timer.pendingCount()).toBe(1);
    bridge.stop();
    expect(timer.pendingCount()).toBe(0);
  });
});

// =========================================================================
// AndroidBridge: connection failure
// =========================================================================

describe('AndroidBridge: connection failure', () => {
  it('schedules a reconnect when createConnectionFn throws', () => {
    let attempts = 0;
    const timer = makeManualTimer();
    const bridge = new AndroidBridge({
      backoffScheduleMs: [50],
      createConnectionFn: () => {
        attempts++;
        if (attempts === 1) throw new Error('ECONNREFUSED');
        return new FakeConnection();
      },
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    expect(attempts).toBe(1);
    expect(bridge.isRunning()).toBe(false);
    expect(timer.pendingCount()).toBe(1);
    timer.runAll();
    expect(attempts).toBe(2);
    expect(bridge.isRunning()).toBe(true);
    bridge.stop();
  });
});

// =========================================================================
// AndroidBridge: drain interface
// =========================================================================

describe('AndroidBridge: drain interface', () => {
  it('drain() returns queued events and clears the queue', () => {
    let conn!: FakeConnection;
    const bridge = new AndroidBridge({
      createConnectionFn: () => { conn = new FakeConnection(); return conn; },
    });
    bridge.start();
    conn.emitData('{"t":"input_event","ts":1}\n');
    conn.emitData('{"t":"input_event","ts":2}\n');
    const first = bridge.drain();
    expect(first).toHaveLength(2);
    expect(bridge.drain()).toHaveLength(0);
    expect(bridge.getQueueDepth()).toBe(0);
    bridge.stop();
  });

  it('drain() returns empty array when no events received', () => {
    const bridge = new AndroidBridge({
      createConnectionFn: () => new FakeConnection(),
    });
    bridge.start();
    expect(bridge.drain()).toHaveLength(0);
    bridge.stop();
  });
});
