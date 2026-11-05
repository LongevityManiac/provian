/**
 * Tests for LLMSessionPlugin end-to-end wiring:
 *   HelperBridge IPC events → LLMSessionStateMachine → PluginPE queue.
 *
 * We drive the bridge via a FakeChild (same pattern as ipc.test.ts) and a
 * manual timer so restart scheduling is observable. The plugin's tick loop
 * is invoked explicitly.
 *
 * A minimal FakeObserver stands in for ProvianObserver: it captures log
 * lines. It holds no SessionManager surface because the plugin does not
 * read from observer.sessionManager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter, Readable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LLMSessionPlugin,
  computeSessionFingerprint,
  PLUGIN_NAME,
} from './LLMSessionPlugin';
import type { ChildProcessLike } from './ipc';

// ---- FakeChild (mirrors ipc.test.ts) ----------------------------------

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
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }
  emitLine(line: string): void {
    this.stdout.emit('data', line.endsWith('\n') ? line : line + '\n');
  }
  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

// ---- FakeObserver ------------------------------------------------------

interface LogEntry { level: string; msg: string; meta?: Record<string, unknown> }

class FakeObserver {
  logs: LogEntry[] = [];
  captureStatusReports: Record<string, unknown>[] = [];
  log(level: string, msg: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level, msg, meta });
  }
  async reportCaptureStatus(status: Record<string, unknown>): Promise<void> {
    this.captureStatusReports.push(status);
  }
}

function fakeObserver(): FakeObserver {
  return new FakeObserver();
}

// ---- Test helpers ------------------------------------------------------

function tmpConfig(contents: Record<string, unknown> | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-llm-plugin-test-'));
  const p = path.join(dir, 'config.json');
  if (contents !== null) {
    fs.writeFileSync(p, JSON.stringify(contents));
  }
  return p;
}

function tmpHelperBinary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-llm-plugin-test-bin-'));
  const p = path.join(dir, 'helper');
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
  return p;
}

function catalogPath(): string {
  return path.resolve(__dirname, '..', '..', 'config', 'ai-providers.json');
}

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
  return { setTimeoutFn, clearTimeoutFn };
}

async function buildPlugin(opts: {
  observer?: FakeObserver;
  configPath?: string;
  helperBinaryPath?: string;
  spawnFn?: (binary: string, args: string[], opts: { stdio: 'pipe' }) => ChildProcessLike;
  now?: () => number;
  enabled?: boolean;
  forceDarwin?: boolean;
  forcePlatform?: NodeJS.Platform;
}): Promise<{ plugin: LLMSessionPlugin; observer: FakeObserver }> {
  const observer = opts.observer ?? fakeObserver();
  const timer = makeManualTimer();

  // Spoof platform for cross-OS CI runners when we want to exercise a
  // specific native-helper code path. forcePlatform is the general form;
  // forceDarwin is the original darwin-only shorthand. Callers that set
  // either should restore process.platform themselves (see the win32/linux
  // tests for the try/finally pattern) when running on a different host.
  if (opts.forcePlatform && process.platform !== opts.forcePlatform) {
    Object.defineProperty(process, 'platform', { value: opts.forcePlatform, configurable: true });
  } else if (opts.forceDarwin && process.platform !== 'darwin') {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  }

  const plugin = new LLMSessionPlugin({
    configPath: opts.configPath,
    catalogPath: catalogPath(),
    helperBinaryPath: opts.helperBinaryPath,
    enabled: opts.enabled,
    spawnFn: opts.spawnFn,
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
    now: opts.now,
  });
  await plugin.init(observer as unknown as Parameters<LLMSessionPlugin['init']>[0]);
  return { plugin, observer };
}

// =======================================================================
// Embedded provider catalog — the catalog is compiled in, not read
// from a runtime file path, so a single-file bundle / relocated install is
// never disabled for a missing catalog file.
// =======================================================================

describe('embedded provider catalog', () => {
  it('RED: init WITHOUT a catalogPath never disables for a missing/unreadable catalog', async () => {
    const observer = fakeObserver();
    const timer = makeManualTimer();
    const restore = process.platform;
    if (process.platform !== 'darwin') {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    }
    try {
      const plugin = new LLMSessionPlugin({
        configPath: tmpConfig({ capture: { llm_session_enabled: true } }),
        // NO catalogPath: exercises the embedded default. Before this
        // hit resolveCatalogPath() → a broken "/src/..." path → the plugin
        // disabled with "cannot read catalog". No helper is provided, so the
        // plugin still disables for "no foreground helper" — but that proves
        // the CATALOG loaded first (the catalog error must be absent).
        setTimeoutFn: timer.setTimeoutFn,
        clearTimeoutFn: timer.clearTimeoutFn,
      });
      await plugin.init(observer as unknown as Parameters<LLMSessionPlugin['init']>[0]);
      const catalogError = observer.logs.find(l =>
        /cannot read catalog|invalid provider catalog/i.test((l.meta?.reason as string) ?? ''));
      expect(catalogError).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', { value: restore, configurable: true });
    }
  });
});

// =======================================================================
// Fingerprint
// =======================================================================

describe('computeSessionFingerprint', () => {
  it('is deterministic across identical inputs', () => {
    const input = {
      provider: 'claude',
      sessionStartMs: 1_700_000_000_000,
      durationMs: 60_000,
      turnCount: 3,
      pluginName: PLUGIN_NAME,
    };
    const a = computeSessionFingerprint(input);
    const b = computeSessionFingerprint(input);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is sensitive to every field', () => {
    const base = {
      provider: 'claude',
      sessionStartMs: 1_700_000_000_000,
      durationMs: 60_000,
      turnCount: 3,
      pluginName: PLUGIN_NAME,
    };
    const h = computeSessionFingerprint(base);
    expect(h).not.toBe(computeSessionFingerprint({ ...base, provider: 'chatgpt' }));
    expect(h).not.toBe(computeSessionFingerprint({ ...base, sessionStartMs: 1_700_000_000_001 }));
    expect(h).not.toBe(computeSessionFingerprint({ ...base, durationMs: 61_000 }));
    expect(h).not.toBe(computeSessionFingerprint({ ...base, turnCount: 4 }));
    expect(h).not.toBe(computeSessionFingerprint({ ...base, pluginName: 'mobile_webview' }));
  });

  it('resists concatenation collisions via length prefixes', () => {
    // Without length prefixes, "claud" + "e100" and "claude" + "100" collide.
    const a = computeSessionFingerprint({
      provider: 'claud', sessionStartMs: 100, durationMs: 0, turnCount: 0, pluginName: 'e' + PLUGIN_NAME,
    });
    const b = computeSessionFingerprint({
      provider: 'claude', sessionStartMs: 100, durationMs: 0, turnCount: 0, pluginName: PLUGIN_NAME,
    });
    expect(a).not.toBe(b);
  });
});

// =======================================================================
// Config + disable semantics
// =======================================================================

describe('LLMSessionPlugin: config gating', () => {
  it('disables cleanly when config sets capture.llm_session_enabled=false', async () => {
    const cfg = tmpConfig({ capture: { llm_session_enabled: false } });
    let spawnCalls = 0;
    const { plugin, observer } = await buildPlugin({
      configPath: cfg,
      helperBinaryPath: tmpHelperBinary(),
      spawnFn: () => { spawnCalls++; return new FakeChild(1); },
      forceDarwin: true,
    });
    await plugin.start();
    expect(spawnCalls).toBe(0);
    expect(observer.logs.some(l => /disabled/i.test(l.msg))).toBe(true);
    await plugin.stop();
  });

  it('stays enabled when config key is absent (upgrade path)', async () => {
    const cfg = tmpConfig({ capture: { other_key: true } });
    let spawnCalls = 0;
    const { plugin } = await buildPlugin({
      configPath: cfg,
      helperBinaryPath: tmpHelperBinary(),
      spawnFn: () => { spawnCalls++; return new FakeChild(1); },
      forceDarwin: true,
    });
    await plugin.start();
    expect(spawnCalls).toBe(1);
    await plugin.stop();
  });

  it('disables on unsupported platforms', async () => {
    // darwin, win32, and linux are all supported now (win32 and darwin ship a
    // native helper; linux reaches helper resolution). Use a platform with no
    // helper path at all (freebsd) to exercise the unsupported-platform guard.
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    try {
      let spawnCalls = 0;
      const { plugin, observer } = await buildPlugin({
        helperBinaryPath: tmpHelperBinary(),
        spawnFn: () => { spawnCalls++; return new FakeChild(1); },
      });
      await plugin.start();
      expect(spawnCalls).toBe(0);
      expect(observer.logs.some(l => /unsupported platform/i.test(l.meta?.reason as string ?? ''))).toBe(true);
      await plugin.stop();
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('disables on linux without android companion config', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      let spawnCalls = 0;
      const { plugin, observer } = await buildPlugin({
        helperBinaryPath: tmpHelperBinary(),
        spawnFn: () => { spawnCalls++; return new FakeChild(1); },
      });
      await plugin.start();
      expect(spawnCalls).toBe(0);
      expect(observer.logs.some(l => /disabled/i.test(l.msg))).toBe(true);
      await plugin.stop();
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('disables when helper binary is missing', async () => {
    const { plugin, observer } = await buildPlugin({
      // No helperBinaryPath supplied and __dirname-relative fallbacks
      // won't resolve on a scratch path, so the plugin must detect it.
      helperBinaryPath: '/nonexistent/binary/xyz',
      forceDarwin: true,
    });
    await plugin.start();
    expect(observer.logs.some(l => /not found|disabled/i.test(l.msg))).toBe(true);
    await plugin.stop();
  });
});

// =======================================================================
// Windows (win32) support
// =======================================================================

describe('LLMSessionPlugin: win32 support', () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('enables on win32 when a native helper binary resolves', async () => {
    let spawnCalls = 0;
    const { plugin, observer } = await buildPlugin({
      helperBinaryPath: tmpHelperBinary(),
      spawnFn: () => { spawnCalls++; return new FakeChild(7); },
      forcePlatform: 'win32',
    });
    await plugin.start();
    // win32 is a supported native-helper platform: the bridge spawns the
    // helper rather than disabling with "unsupported platform".
    expect(spawnCalls).toBe(1);
    expect(observer.logs.some(l => /unsupported platform/i.test(l.meta?.reason as string ?? ''))).toBe(false);
    await plugin.stop();
  });

  it('resolves a provider by process_name when bundle_id is null (Windows native app)', async () => {
    let now = 2_000_000;
    let child!: FakeChild;
    const { plugin } = await buildPlugin({
      helperBinaryPath: tmpHelperBinary(),
      spawnFn: () => { child = new FakeChild(8); return child; },
      now: () => now,
      forcePlatform: 'win32',
    });
    await plugin.start();

    child.emitLine(JSON.stringify({
      t: 'permission_status', ts: now, accessibility: true, input_monitoring: true,
    }));

    // Windows native Claude app: no bundle_id, process_name carries identity.
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: null, process_name: 'Claude' },
      browser_url: null,
    }));

    now += 5_000;
    child.emitLine(JSON.stringify({ t: 'input_event', ts: now }));
    now += 30_000;
    plugin.tick(null);
    child.emitLine(JSON.stringify({ t: 'input_event', ts: now + 100 }));

    // Foreground switches to a non-provider Windows process → ends session.
    now += 10_000;
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: null, process_name: 'explorer' },
      browser_url: null,
    }));
    plugin.tick(null);
    now += 61_000;
    plugin.tick(null);

    const aiPEs = plugin.drainPEs().filter(p => p.actionType === 'ai_conversation');
    expect(aiPEs.length).toBe(1);
    expect(aiPEs[0].metadata?.provider).toBe('claude');
    expect(aiPEs[0].metadata?.surface).toBe('desktop_foreground');
    await plugin.stop();
  });

  it('matches a browser tab by browser_url on win32 (process_name is the browser)', async () => {
    let now = 3_000_000;
    let child!: FakeChild;
    const { plugin } = await buildPlugin({
      helperBinaryPath: tmpHelperBinary(),
      spawnFn: () => { child = new FakeChild(9); return child; },
      now: () => now,
      forcePlatform: 'win32',
    });
    await plugin.start();

    child.emitLine(JSON.stringify({
      t: 'permission_status', ts: now, accessibility: true, input_monitoring: true,
    }));
    // claude.ai in Chrome: process_name is the browser (no catalog match),
    // browser_url carries the provider + session id.
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: null, process_name: 'chrome' },
      browser_url: 'https://claude.ai/chat/00000000-0000-4000-8000-000000000000',
    }));

    now += 5_000;
    child.emitLine(JSON.stringify({ t: 'input_event', ts: now }));
    now += 30_000;
    plugin.tick(null);

    now += 10_000;
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: null, process_name: 'explorer' },
      browser_url: null,
    }));
    plugin.tick(null);
    now += 61_000;
    plugin.tick(null);

    const aiPEs = plugin.drainPEs().filter(p => p.actionType === 'ai_conversation');
    expect(aiPEs.length).toBe(1);
    expect(aiPEs[0].metadata?.provider).toBe('claude');
    expect(aiPEs[0].metadata?.surface).toBe('desktop_foreground');
    await plugin.stop();
  });
});

// =======================================================================
// End-to-end event flow
// =======================================================================

describe('LLMSessionPlugin: event flow', () => {
  // Helper to construct a plugin with a controllable FakeChild.
  async function build(nowFn: () => number): Promise<{
    plugin: LLMSessionPlugin;
    observer: FakeObserver;
    child: FakeChild;
  }> {
    let child!: FakeChild;
    const { plugin, observer } = await buildPlugin({
      helperBinaryPath: tmpHelperBinary(),
      spawnFn: () => { child = new FakeChild(42); return child; },
      now: nowFn,
      forceDarwin: true,
    });
    await plugin.start();
    return { plugin, observer, child };
  }

  it('translates a claude session: fg→inputs→heartbeat elapsed→fg away→session_end', async () => {
    // Use a tiny heartbeat interval via the state machine's default… the
    // state machine config is not injectable from LLMSessionPlugin, so drive
    // the session to completion via a foreground_changed to a non-provider
    // and the 60s closing window.
    let now = 1_000_000;
    const { plugin, child } = await build(() => now);

    // Permission: input monitoring allowed.
    child.emitLine(JSON.stringify({
      t: 'permission_status', ts: now, accessibility: true, input_monitoring: true,
    }));

    // Foreground → Claude
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: 'ai.anthropic.claude', process_name: 'Claude' },
      browser_url: null,
    }));

    // Input within the 30s candidate window
    now += 5_000;
    child.emitLine(JSON.stringify({ t: 'input_event', ts: now }));

    // Advance past candidate window → first tick promotes to active
    now += 30_000;
    plugin.tick(null);

    // More input while active
    child.emitLine(JSON.stringify({ t: 'input_event', ts: now + 100 }));
    child.emitLine(JSON.stringify({ t: 'input_event', ts: now + 200 }));

    // Foreground switches away
    now += 10_000;
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: 'com.apple.Safari', process_name: 'Safari' },
      browser_url: null,
    }));
    plugin.tick(null);

    // 61 seconds later, closing window expires
    now += 61_000;
    plugin.tick(null);

    const pes = plugin.drainPEs();
    // Expect exactly one session_end emission.
    expect(pes.length).toBeGreaterThanOrEqual(1);
    const aiPEs = pes.filter(p => p.actionType === 'ai_conversation');
    expect(aiPEs.length).toBe(1);
    const pe = aiPEs[0];
    expect(pe.skipDedupClaim).toBe(true);
    expect(pe.metadata?.provider).toBe('claude');
    expect(pe.metadata?.surface).toBe('desktop_foreground');
    expect(pe.metadata?.input_fidelity).toBe('full');
    expect(typeof pe.metadata?.session_fingerprint_hash).toBe('string');
    expect((pe.metadata?.session_fingerprint_hash as string).length).toBe(64);
    expect(pe.metadata?.char_count).toBe(0);
    expect(pe.metadata?.image_count).toBe(0);
    expect(pe.metadata?.video_seconds).toBe(0);
    // turn_count should be >= 1 given input events during window
    expect((pe.metadata?.turn_count as number)).toBeGreaterThanOrEqual(1);

    await plugin.stop();
  });

  it('emits nothing when foreground is an unsupported app', async () => {
    let now = 2_000_000;
    const { plugin, child } = await build(() => now);
    child.emitLine(JSON.stringify({
      t: 'permission_status', ts: now, accessibility: true, input_monitoring: true,
    }));
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: 'com.unrelated.app', process_name: 'Unrelated' },
      browser_url: null,
    }));
    now += 30_000;
    plugin.tick(null);
    expect(plugin.drainPEs()).toHaveLength(0);
    await plugin.stop();
  });

  it('flips input_fidelity to presence_only when input_monitoring is denied', async () => {
    let now = 3_000_000;
    const { plugin, child } = await build(() => now);

    // Initial permission: denied
    child.emitLine(JSON.stringify({
      t: 'permission_status', ts: now, accessibility: true, input_monitoring: false,
    }));
    // Foreground → Claude
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: 'ai.anthropic.claude', process_name: 'Claude' },
      browser_url: null,
    }));
    // No input events. Elapsed candidate window.
    now += 31_000;
    plugin.tick(null);
    // Foreground away
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: 'com.apple.Safari', process_name: 'Safari' },
      browser_url: null,
    }));
    plugin.tick(null);
    // Closing expires
    now += 61_000;
    plugin.tick(null);

    const pes = plugin.drainPEs().filter(p => p.actionType === 'ai_conversation');
    expect(pes.length).toBe(1);
    expect(pes[0].metadata?.input_fidelity).toBe('presence_only');
    expect(pes[0].metadata?.turn_count).toBe(0);

    await plugin.stop();
  });

  it('reports capture status: initial on start, then REAL perms on permission_status', async () => {
    let now = 5_500_000;
    const { plugin, observer, child } = await build(() => now);

    // start() fires an initial report — active, but OS perms not yet checked.
    expect(observer.captureStatusReports.length).toBeGreaterThanOrEqual(1);
    expect(observer.captureStatusReports[0]).toMatchObject({
      llm_session_enabled: true,
      active: true,
      permissions_checked: false,
    });

    // A permission_status event surfaces the REAL OS permission state — here
    // Accessibility is NOT granted, which is the "action needed" case. IPC
    // events are buffered until tick() drains them (see LLMSessionPlugin.tick).
    child.emitLine(JSON.stringify({
      t: 'permission_status', ts: now, accessibility: false, input_monitoring: true,
    }));
    plugin.tick(null);

    const last = observer.captureStatusReports[observer.captureStatusReports.length - 1];
    expect(last).toMatchObject({
      llm_session_enabled: true,
      active: true,
      permissions_checked: true,
      accessibility: false,
      input_monitoring: true,
    });
  });

  it('reports capture OFF (active:false, llm_session_enabled:false) when disabled in config', async () => {
    const configPath = tmpConfig({ capture: { llm_session_enabled: false } });
    const { plugin, observer } = await buildPlugin({ configPath });
    await plugin.start();
    expect(observer.captureStatusReports.length).toBeGreaterThanOrEqual(1);
    expect(observer.captureStatusReports[observer.captureStatusReports.length - 1]).toMatchObject({
      llm_session_enabled: false,
      active: false,
    });
  });

  it('flips input_fidelity back to full when permission is regranted', async () => {
    let now = 4_000_000;
    const { plugin, child } = await build(() => now);

    child.emitLine(JSON.stringify({
      t: 'permission_status', ts: now, accessibility: true, input_monitoring: false,
    }));
    plugin.tick(null);
    child.emitLine(JSON.stringify({
      t: 'permission_status', ts: now, accessibility: true, input_monitoring: true,
    }));
    plugin.tick(null);

    // Regrant the permission, then open a session with input events.
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: 'ai.anthropic.claude', process_name: 'Claude' },
      browser_url: null,
    }));
    child.emitLine(JSON.stringify({ t: 'input_event', ts: now + 1000 }));
    now += 31_000;
    plugin.tick(null);
    child.emitLine(JSON.stringify({ t: 'input_event', ts: now }));
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: 'com.apple.Safari', process_name: 'Safari' },
      browser_url: null,
    }));
    plugin.tick(null);
    now += 61_000;
    plugin.tick(null);

    const pes = plugin.drainPEs().filter(p => p.actionType === 'ai_conversation');
    expect(pes.length).toBe(1);
    expect(pes[0].metadata?.input_fidelity).toBe('full');
    await plugin.stop();
  });

  it('extracts session id from a supported browser URL', async () => {
    let now = 5_000_000;
    const { plugin, child } = await build(() => now);
    child.emitLine(JSON.stringify({
      t: 'permission_status', ts: now, accessibility: true, input_monitoring: true,
    }));
    // ChatGPT tab in Safari (bundle id is Safari, URL is the signal).
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: 'com.apple.Safari', process_name: 'Safari' },
      browser_url: 'https://chatgpt.com/c/abcdef01-2345-6789-abcd-ef0123456789',
    }));
    child.emitLine(JSON.stringify({ t: 'input_event', ts: now + 1000 }));
    now += 31_000;
    plugin.tick(null);
    // Switch to non-provider
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: 'com.apple.Safari', process_name: 'Safari' },
      browser_url: 'https://example.com',
    }));
    plugin.tick(null);
    now += 61_000;
    plugin.tick(null);

    const pes = plugin.drainPEs().filter(p => p.actionType === 'ai_conversation');
    expect(pes).toHaveLength(1);
    expect(pes[0].metadata?.provider).toBe('chatgpt');
    await plugin.stop();
  });

  it('treats x.com/home (no /i/grok) as non-provider', async () => {
    let now = 6_000_000;
    const { plugin, child } = await build(() => now);
    child.emitLine(JSON.stringify({
      t: 'permission_status', ts: now, accessibility: true, input_monitoring: true,
    }));
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: 'com.apple.Safari', process_name: 'Safari' },
      browser_url: 'https://x.com/home',
    }));
    now += 31_000;
    plugin.tick(null);
    expect(plugin.drainPEs()).toHaveLength(0);
    await plugin.stop();
  });

  it('handles system sleep during an active session by emitting session_end', async () => {
    let now = 7_000_000;
    const { plugin, child } = await build(() => now);
    child.emitLine(JSON.stringify({
      t: 'permission_status', ts: now, accessibility: true, input_monitoring: true,
    }));
    child.emitLine(JSON.stringify({
      t: 'foreground_changed', ts: now,
      app: { bundle_id: 'ai.anthropic.claude', process_name: 'Claude' },
      browser_url: null,
    }));
    child.emitLine(JSON.stringify({ t: 'input_event', ts: now + 1000 }));
    now += 31_000;
    plugin.tick(null);
    // Machine sleeps.
    now += 5_000;
    child.emitLine(JSON.stringify({ t: 'system_state', ts: now, state: 'sleep' }));
    plugin.tick(null);

    const pes = plugin.drainPEs().filter(p => p.actionType === 'ai_conversation');
    expect(pes).toHaveLength(1);
    expect(pes[0].metadata?.provider).toBe('claude');
    await plugin.stop();
  });
});
