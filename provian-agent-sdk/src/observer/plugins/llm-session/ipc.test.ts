import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter, Readable } from 'stream';
import {
  validateHelperIPCEvent,
  LineDelimitedJsonReader,
  HelperBridge,
  type HelperIPCEvent,
  type ChildProcessLike,
} from './ipc';

// ---- validateHelperIPCEvent -------------------------------------------

describe('validateHelperIPCEvent', () => {
  it('accepts a valid foreground_changed event', () => {
    const r = validateHelperIPCEvent({
      t: 'foreground_changed', ts: 1, app: { bundle_id: 'x', process_name: 'y' }, browser_url: null,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts null values in foreground_changed app fields', () => {
    const r = validateHelperIPCEvent({
      t: 'foreground_changed', ts: 1, app: { bundle_id: null, process_name: null }, browser_url: 'https://claude.ai',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects foreground_changed with missing app', () => {
    const r = validateHelperIPCEvent({ t: 'foreground_changed', ts: 1, browser_url: null });
    expect(r.ok).toBe(false);
  });

  it('accepts input_event with only t and ts', () => {
    const r = validateHelperIPCEvent({ t: 'input_event', ts: 1 });
    expect(r.ok).toBe(true);
  });

  it('accepts all four system_state variants', () => {
    for (const state of ['sleep', 'wake', 'lock', 'unlock']) {
      const r = validateHelperIPCEvent({ t: 'system_state', ts: 1, state });
      expect(r.ok).toBe(true);
    }
  });

  it('rejects unknown system_state values', () => {
    const r = validateHelperIPCEvent({ t: 'system_state', ts: 1, state: 'hibernate' });
    expect(r.ok).toBe(false);
  });

  it('accepts permission_status with booleans', () => {
    const r = validateHelperIPCEvent({
      t: 'permission_status', ts: 1, accessibility: true, input_monitoring: false,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects permission_status with non-boolean fields', () => {
    const r = validateHelperIPCEvent({
      t: 'permission_status', ts: 1, accessibility: 'yes', input_monitoring: false,
    });
    expect(r.ok).toBe(false);
  });

  it('accepts error and fatal with message strings', () => {
    expect(validateHelperIPCEvent({ t: 'error', ts: 1, message: 'x' }).ok).toBe(true);
    expect(validateHelperIPCEvent({ t: 'fatal', ts: 1, message: 'y' }).ok).toBe(true);
  });

  it('rejects non-finite ts', () => {
    expect(validateHelperIPCEvent({ t: 'input_event', ts: Number.NaN }).ok).toBe(false);
    expect(validateHelperIPCEvent({ t: 'input_event', ts: Infinity }).ok).toBe(false);
  });

  it('rejects non-numeric ts', () => {
    expect(validateHelperIPCEvent({ t: 'input_event', ts: '123' }).ok).toBe(false);
  });

  it('rejects unknown event type', () => {
    expect(validateHelperIPCEvent({ t: 'mystery', ts: 1 }).ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateHelperIPCEvent(null).ok).toBe(false);
    expect(validateHelperIPCEvent([]).ok).toBe(false);
    expect(validateHelperIPCEvent('{"t":"input_event"}').ok).toBe(false);
  });
});

// ---- LineDelimitedJsonReader ------------------------------------------

describe('LineDelimitedJsonReader', () => {
  let events: HelperIPCEvent[];
  let errors: Array<{ line: string; reason: string }>;
  let reader: LineDelimitedJsonReader;

  beforeEach(() => {
    events = [];
    errors = [];
    reader = new LineDelimitedJsonReader(
      (ev) => events.push(ev),
      (line, reason) => errors.push({ line, reason }),
    );
  });

  it('reads a single line', () => {
    reader.feed('{"t":"input_event","ts":1}\n');
    expect(events).toHaveLength(1);
    expect(events[0].t).toBe('input_event');
  });

  it('reads multiple lines in one chunk', () => {
    reader.feed('{"t":"input_event","ts":1}\n{"t":"input_event","ts":2}\n');
    expect(events).toHaveLength(2);
  });

  it('handles a line split across chunks', () => {
    reader.feed('{"t":"input_');
    reader.feed('event","ts":1}\n');
    expect(events).toHaveLength(1);
  });

  it('handles CRLF line endings', () => {
    reader.feed('{"t":"input_event","ts":1}\r\n{"t":"input_event","ts":2}\r\n');
    expect(events).toHaveLength(2);
  });

  it('skips empty lines', () => {
    reader.feed('\n\n{"t":"input_event","ts":1}\n\n');
    expect(events).toHaveLength(1);
  });

  it('logs a parse error for invalid JSON and continues', () => {
    reader.feed('not json\n{"t":"input_event","ts":1}\n');
    expect(errors).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('logs a validation error for malformed events and continues', () => {
    reader.feed('{"t":"input_event","ts":"nope"}\n{"t":"input_event","ts":1}\n');
    expect(errors).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('flush reports leftover partial line', () => {
    reader.feed('{"t":"input_event","ts":1}\n{"incomplete');
    reader.flush();
    expect(events).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe('stream ended mid-line');
  });
});

// ---- FakeChild and spawn injection ------------------------------------

class FakeChild extends EventEmitter implements ChildProcessLike {
  stdout: Readable;
  stderr: Readable;
  pid: number;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdout = new Readable({ read() { /* noop */ } });
    this.stderr = new Readable({ read() { /* noop */ } });
    // node streams require encoding for string chunks
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }
  emitData(s: string): void {
    this.stdout.emit('data', s);
  }
  emitExit(code: number | null = 0, signal: string | null = null): void {
    this.emit('exit', code, signal);
  }
  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

// Manual timer: scheduled callbacks run only when .runAll() or .advance() is called.
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

// ---- HelperBridge -----------------------------------------------------

describe('HelperBridge: lifecycle', () => {
  it('spawns on start and kills on stop', () => {
    let spawnedChild: FakeChild | null = null;
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      spawnFn: () => {
        spawnedChild = new FakeChild(1234);
        return spawnedChild!;
      },
    });
    bridge.start();
    expect(spawnedChild).not.toBeNull();
    expect(bridge.isRunning()).toBe(true);
    bridge.stop();
    expect(spawnedChild!.killed).toBe(true);
    expect(bridge.isRunning()).toBe(false);
  });

  it('ignores double start', () => {
    let count = 0;
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      spawnFn: () => { count++; return new FakeChild(count); },
    });
    bridge.start();
    bridge.start();
    expect(count).toBe(1);
    bridge.stop();
  });
});

describe('HelperBridge: event flow', () => {
  it('enqueues validated events from stdout in order', () => {
    let child: FakeChild;
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      spawnFn: () => { child = new FakeChild(1); return child; },
    });
    bridge.start();
    child!.emitData('{"t":"foreground_changed","ts":1,"app":{"bundle_id":"a","process_name":"A"},"browser_url":null}\n');
    child!.emitData('{"t":"input_event","ts":2}\n');
    const drained = bridge.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0].t).toBe('foreground_changed');
    expect(drained[1].t).toBe('input_event');
    expect(bridge.drain()).toHaveLength(0);
    bridge.stop();
  });

  it('silently ignores invalid lines (logged, not thrown)', () => {
    let child: FakeChild;
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      spawnFn: () => { child = new FakeChild(1); return child; },
    });
    bridge.start();
    child!.emitData('garbage\n');
    child!.emitData('{"t":"input_event","ts":1}\n');
    expect(bridge.drain()).toHaveLength(1);
    bridge.stop();
  });
});

describe('HelperBridge: backpressure', () => {
  it('drops the oldest input_event when queue is full and new event is input_event', () => {
    let child: FakeChild;
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      maxQueueDepth: 3,
      spawnFn: () => { child = new FakeChild(1); return child; },
    });
    bridge.start();
    for (let i = 1; i <= 4; i++) {
      child!.emitData(`{"t":"input_event","ts":${i}}\n`);
    }
    expect(bridge.getDroppedInputEventCount()).toBe(1);
    const drained = bridge.drain();
    expect(drained).toHaveLength(3);
    bridge.stop();
  });

  it('evicts oldest input_event to make room for a foreground_changed event', () => {
    let child: FakeChild;
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      maxQueueDepth: 3,
      spawnFn: () => { child = new FakeChild(1); return child; },
    });
    bridge.start();
    child!.emitData('{"t":"input_event","ts":1}\n');
    child!.emitData('{"t":"input_event","ts":2}\n');
    child!.emitData('{"t":"input_event","ts":3}\n');
    child!.emitData('{"t":"foreground_changed","ts":4,"app":{"bundle_id":null,"process_name":null},"browser_url":null}\n');
    expect(bridge.getDroppedInputEventCount()).toBe(1);
    const drained = bridge.drain();
    const types = drained.map(e => e.t);
    expect(types).toContain('foreground_changed');
    expect(types.filter(t => t === 'input_event')).toHaveLength(2);
    bridge.stop();
  });

  it('never drops foreground or system_state even when queue is full of critical events', () => {
    let child: FakeChild;
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      maxQueueDepth: 2,
      spawnFn: () => { child = new FakeChild(1); return child; },
    });
    bridge.start();
    child!.emitData('{"t":"foreground_changed","ts":1,"app":{"bundle_id":null,"process_name":null},"browser_url":null}\n');
    child!.emitData('{"t":"system_state","ts":2,"state":"sleep"}\n');
    child!.emitData('{"t":"foreground_changed","ts":3,"app":{"bundle_id":null,"process_name":null},"browser_url":null}\n');
    expect(bridge.getDroppedInputEventCount()).toBe(0);
    const drained = bridge.drain();
    expect(drained).toHaveLength(3);
    bridge.stop();
  });

  it('drops the incoming input_event when queue is full of critical events', () => {
    let child: FakeChild;
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      maxQueueDepth: 2,
      spawnFn: () => { child = new FakeChild(1); return child; },
    });
    bridge.start();
    child!.emitData('{"t":"foreground_changed","ts":1,"app":{"bundle_id":null,"process_name":null},"browser_url":null}\n');
    child!.emitData('{"t":"foreground_changed","ts":2,"app":{"bundle_id":null,"process_name":null},"browser_url":null}\n');
    child!.emitData('{"t":"input_event","ts":3}\n');
    expect(bridge.getDroppedInputEventCount()).toBe(1);
    const drained = bridge.drain();
    expect(drained).toHaveLength(2);
    expect(drained.every(e => e.t === 'foreground_changed')).toBe(true);
    bridge.stop();
  });
});

describe('HelperBridge: restart and backoff', () => {
  it('schedules a restart on child exit with the first backoff step', () => {
    const children: FakeChild[] = [];
    let nextPid = 1;
    const timer = makeManualTimer();
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      backoffScheduleMs: [100, 200, 500, 1000],
      healthyRuntimeMs: 10_000,
      spawnFn: () => { const c = new FakeChild(nextPid++); children.push(c); return c; },
      now: () => 0,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    expect(children).toHaveLength(1);
    children[0].emitExit(0, null);
    expect(timer.pendingCount()).toBe(1);
    timer.runAll();
    expect(children).toHaveLength(2);
    bridge.stop();
  });

  it('walks the backoff schedule and caps at the final value for repeated failures', () => {
    const children: FakeChild[] = [];
    let nextPid = 1;
    const timer = makeManualTimer();
    let nowMs = 0;
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      backoffScheduleMs: [100, 200, 500, 1000],
      healthyRuntimeMs: 10_000,
      spawnFn: () => { const c = new FakeChild(nextPid++); children.push(c); return c; },
      now: () => nowMs,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    for (let i = 0; i < 6; i++) {
      children[children.length - 1].emitExit(1, null);
      timer.runAll();
      nowMs += 1;
    }
    expect(bridge.getRestartAttempts()).toBeGreaterThanOrEqual(6);
    bridge.stop();
  });

  it('resets attempt counter after a healthy runtime', () => {
    const children: FakeChild[] = [];
    let nextPid = 1;
    const timer = makeManualTimer();
    let nowMs = 0;
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      backoffScheduleMs: [100, 200, 500, 1000],
      healthyRuntimeMs: 5_000,
      spawnFn: () => { const c = new FakeChild(nextPid++); children.push(c); return c; },
      now: () => nowMs,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    children[0].emitExit(1, null);
    timer.runAll();
    children[1].emitExit(1, null);
    timer.runAll();
    expect(bridge.getRestartAttempts()).toBeGreaterThanOrEqual(2);
    // Simulate a long healthy run before the next exit.
    nowMs += 20_000;
    children[2].emitExit(1, null);
    expect(bridge.getRestartAttempts()).toBe(1);
    bridge.stop();
  });

  it('stop() prevents scheduled restart from firing', () => {
    let child: FakeChild;
    const timer = makeManualTimer();
    const bridge = new HelperBridge({
      binaryPath: '/fake/helper',
      backoffScheduleMs: [100],
      spawnFn: () => { child = new FakeChild(1); return child; },
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    child!.emitExit(1, null);
    expect(timer.pendingCount()).toBe(1);
    bridge.stop();
    expect(timer.pendingCount()).toBe(0);
  });
});

describe('HelperBridge: spawn failure', () => {
  it('schedules a restart when spawnFn throws', () => {
    let attempts = 0;
    const timer = makeManualTimer();
    const bridge = new HelperBridge({
      binaryPath: '/nonexistent',
      backoffScheduleMs: [50],
      spawnFn: () => {
        attempts++;
        if (attempts === 1) throw new Error('ENOENT');
        return new FakeChild(attempts);
      },
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    bridge.start();
    expect(attempts).toBe(1);
    expect(timer.pendingCount()).toBe(1);
    timer.runAll();
    expect(attempts).toBe(2);
    expect(bridge.isRunning()).toBe(true);
    bridge.stop();
  });
});
