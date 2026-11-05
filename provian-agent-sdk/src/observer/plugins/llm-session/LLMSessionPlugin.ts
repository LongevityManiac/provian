/**
 * LLMSessionPlugin: captures desktop AI assistant foreground sessions and
 * emits `ai_conversation` Provenance Envelopes.
 *
 * Composition:
 *   HelperBridge ──► validated IPC events ──► this plugin
 *                                               │
 *                                               ▼
 *                                    LLMSessionStateMachine
 *                                               │
 *                                               ▼ emit_heartbeat / emit_session_end
 *                                           PluginPE queue ──► observer.drainPEs()
 *
 * Spec of record:
 *   docs/CAPTURE_ARCHITECTURE.md §5, §9
 *   docs/PHASE_2B_DESIGN_NOTES.md §4–§9
 *
 * Design decisions already locked (do not revisit in this file):
 *   - Every emitted PE carries `skipDedupClaim: true`. ai_conversation is a
 *     complementary signal to compute_session / inference_session / coding_session
 *     and must not suppress them. See CAPTURE_ARCHITECTURE.md §9.
 *   - Fingerprint hash recipe: SHA-256 over length-prefixed UTF-8 fields
 *     (provider, session_start_ms, duration_ms, turn_count, plugin_name).
 *     Plugin name literal is `"llm_session_plugin"` and does NOT vary per
 *     surface; surface identity is carried in metadata.surface.
 *   - The existing `LLMPlugin.ts` (PROVIAN_LLM_LOG tailer) is untouched and
 *     complementary: different dimensions of the same economy.
 *   - Consent gate: capture.llm_session_enabled === false in
 *     ~/.provian/config.json disables the plugin. Absent key means undecided
 *     (register-device runs the consent flow); the plugin treats undecided as
 *     enabled so returning users upgrade without losing capture.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ObserverPlugin } from '../PluginInterface';
import type { ProvianObserver } from '../../ProvianObserver';
import type { PluginContribution, PluginPE, SessionState } from '../../types';
import type { InputOrigin } from '../../../input-origins';
import { resolvableOrigin, urlOrigins } from '../../origin-capture';
import {
  HelperBridge,
  type HelperBridgeConfig,
  type HelperIPCEvent,
} from './ipc';
import {
  LLMSessionStateMachine,
  type MachineInput,
  type MachineOutput,
  type ProviderContext,
} from './stateMachine';
import {
  parseCatalog,
  matchBundleIdToProvider,
  matchProcessNameToProvider,
  matchPackageNameToProvider,
  matchUrlToProvider,
  extractSessionId,
  type ProviderCatalog,
  type ProviderEntry,
} from './catalog';
import {
  AndroidBridge,
  type AndroidBridgeConfig,
} from './AndroidBridge';
import { PROVIAN_CONFIG_PATH, readProvianConfig } from '../../config/provian-config';
// The provider catalog is EMBEDDED at build time (a static import), never read
// from a runtime file path. The prior `fs.readFileSync(resolveCatalogPath())`
// broke in a single-file esbuild bundle (there is no catalog file on disk) and
// its manual `__dirname`-relative fallback resolved to `/src/...` at the FS
// root. A static import is compiled/inlined in every packaging: tsc dist
// (require resolves the copy-assets file), the esbuild bundle (JSON inlined),
// and npm. `resolveJsonModule` is enabled in tsconfig(.build). See catalog.ts.
import embeddedProviderCatalog from '../../config/ai-providers.json';

export const PLUGIN_NAME = 'llm_session_plugin';

/** ~/.provian/config.json — the shared value (was a private copy of the join). */
const DEFAULT_CONFIG_PATH = PROVIAN_CONFIG_PATH;

/**
 * Optional dependencies for tests. None are required at runtime: the plugin
 * falls back to real child_process.spawn and filesystem reads when omitted.
 */
export interface LLMSessionPluginOptions {
  /** Config file path override. Defaults to ~/.provian/config.json. */
  configPath?: string;
  /**
   * Explicit catalog path override. When omitted, resolves relative to
   * __dirname in the compiled package and falls back to the in-repo src path
   * for developer builds.
   */
  catalogPath?: string;
  /**
   * Explicit helper binary override. When omitted, resolves to the native
   * helper for the current platform inside ~/.provian/helpers/<platform>/
   * (post-install copy) or the in-repo dev build: the darwin helper on macOS,
   * the win32 ProvianForegroundHelper.exe on Windows.
   */
  helperBinaryPath?: string;
  /** Injected spawn for tests. Passed straight through to the bridge. */
  spawnFn?: HelperBridgeConfig['spawnFn'];
  /** Injected timer for tests. Passed straight through to the bridge. */
  setTimeoutFn?: HelperBridgeConfig['setTimeoutFn'];
  clearTimeoutFn?: HelperBridgeConfig['clearTimeoutFn'];
  /** Injected clock for tests. Used by the plugin AND the bridge. */
  now?: () => number;
  /** Force-enable or force-disable; bypasses the config file. */
  enabled?: boolean;
  /** Bridge construction hook for tests. Replaces the default HelperBridge. */
  bridgeFactory?: (cfg: HelperBridgeConfig) => HelperBridge;
  /**
   * Android companion config path override. Defaults to
   * ~/.provian/android-companion.json. When the file exists and contains
   * valid JSON, the plugin uses AndroidBridge instead of HelperBridge.
   */
  androidCompanionConfigPath?: string;
  /** AndroidBridge construction hook for tests. */
  androidBridgeFactory?: (cfg: AndroidBridgeConfig) => AndroidBridge;
  /** Injected createConnectionFn for tests. Passed through to AndroidBridge. */
  createConnectionFn?: AndroidBridgeConfig['createConnectionFn'];
}

interface ResolvedConfig {
  /** Null when the config file doesn't exist OR the key is unset. */
  enabled: boolean | null;
}

/**
 * Plugin shape mirrors GitPlugin / OTelPlugin: init → start → tick → drainPEs → stop.
 *
 * init() reads disk state (config file, catalog). Any fatal problem here
 * (unreadable catalog, invalid JSON) disables the plugin and logs; the rest
 * of the observer continues.
 *
 * start() constructs the HelperBridge and state machine, then spawns the
 * native foreground helper. Two native helpers ship: the macOS (darwin)
 * helper and the Windows (win32) helper, both speaking the same OS-agnostic
 * IPC contract over stdout. On platforms without a native helper binary
 * (e.g. Linux today) the plugin logs a warning and stays inert.
 */
export class LLMSessionPlugin implements ObserverPlugin {
  readonly name = PLUGIN_NAME;

  private observer!: ProvianObserver;
  private readonly options: LLMSessionPluginOptions;
  private readonly now: () => number;

  private disabled = true;
  private disabledReason: string | null = null;

  private catalog: ProviderCatalog | null = null;
  private bridge: HelperBridge | AndroidBridge | null = null;
  /** Tracks which bridge type is in use for provider resolution. */
  private bridgeSource: 'helper' | 'android' | null = null;
  private stateMachine: LLMSessionStateMachine | null = null;
  private queue: PluginPE[] = [];

  /**
   * Prompt 2: the last browser URL seen per provider, set where the URL is in
   * hand (`resolveProviderContext`) and read when the session PE is built
   * (`buildPE`) to record the browser domain (resolvable) + path (private hash)
   * as `input_origins`. The raw URL NEVER leaves — only its domain (public) and
   * a hash of the path. Native-app sessions (no browser URL) record the provider
   * alone. Kept tiny (one entry per provider).
   */
  private lastBrowserUrlByProvider: Map<string, string> = new Map();

  /**
   * Tracks the last input_monitoring value we received from the helper.
   * Drives input_fidelity on the state machine. Undefined until the first
   * permission_status event arrives; default is 'full' (optimistic).
   */
  private inputMonitoring: boolean | undefined = undefined;

  /**
   * Config `capture.llm_session_enabled` as an intent flag for status reporting:
   * true unless the user explicitly turned capture off. Distinguishes "off by
   * choice" from "on but not yet permitted" in the app's device view.
   */
  private configLlmSessionEnabled = true;

  constructor(options: LLMSessionPluginOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  async init(observer: ProvianObserver): Promise<void> {
    this.observer = observer;

    const cfg = this.resolveConfig();
    // Intent flag for status reporting: true unless explicitly turned off.
    this.configLlmSessionEnabled = cfg.enabled !== false;
    if (cfg.enabled === false) {
      this.disabled = true;
      this.disabledReason = 'disabled in config (capture.llm_session_enabled=false)';
      return;
    }

    if (!this.isSupportedPlatform()) {
      this.disabled = true;
      this.disabledReason = `unsupported platform: ${process.platform}`;
      return;
    }

    // Default: the catalog is embedded at build time (works from dist, the
    // single-file bundle, and npm alike). An explicit `catalogPath` option is
    // still honored for tests / custom deployments and reads from disk.
    let catalogJson: string;
    if (this.options.catalogPath) {
      try {
        catalogJson = fs.readFileSync(this.options.catalogPath, 'utf-8');
      } catch (err) {
        this.disabled = true;
        this.disabledReason = `cannot read catalog at ${this.options.catalogPath}: ${(err as Error).message}`;
        return;
      }
    } else {
      catalogJson = JSON.stringify(embeddedProviderCatalog);
    }
    const parsed = parseCatalog(catalogJson);
    if (!parsed.ok) {
      this.disabled = true;
      this.disabledReason = `invalid provider catalog: ${parsed.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`;
      return;
    }
    this.catalog = parsed.catalog;

    // Bridge selection: native foreground helper binary first (macOS or
    // Windows), then Android companion. The HelperBridge and IPC layer are
    // OS-agnostic - they spawn whatever binary resolveHelperBinaryPath()
    // returns for the current platform and read the same line-delimited JSON
    // contract from its stdout.
    const helperPath = this.resolveHelperBinaryPath();
    const androidConfig = this.resolveAndroidCompanionConfig();
    const hasNativeHelperPlatform =
      process.platform === 'darwin' || process.platform === 'win32';

    if (helperPath && hasNativeHelperPlatform) {
      // macOS or Windows with a native helper binary - use HelperBridge.
      this.disabled = false;
      this.disabledReason = null;
      this.stateMachine = new LLMSessionStateMachine();
      this.bridge = this.constructHelperBridge(helperPath);
      this.bridgeSource = 'helper';
    } else if (androidConfig) {
      // Android companion detected - use AndroidBridge.
      this.disabled = false;
      this.disabledReason = null;
      this.stateMachine = new LLMSessionStateMachine();
      this.bridge = this.constructAndroidBridge(androidConfig);
      this.bridgeSource = 'android';
    } else {
      this.disabled = true;
      this.disabledReason = 'no foreground helper binary or android companion found';
      return;
    }
  }

  async start(): Promise<void> {
    // Report this machine's initial capture status right away so the app's
    // device view has a state to show immediately — even when capture is off
    // or unsupported (no helper will ever run) or before the helper reports OS
    // permissions (a permission_status report updates the perms a moment later).
    void this.observer.reportCaptureStatus({
      llm_session_enabled: this.configLlmSessionEnabled,
      active: !this.disabled,
      permissions_checked: false,
      accessibility: false,
      input_monitoring: false,
    });
    if (this.disabled) {
      this.observer.log('info', 'LLMSessionPlugin disabled', { reason: this.disabledReason ?? 'unknown' });
      return;
    }
    this.bridge?.start();
  }

  async stop(): Promise<void> {
    if (this.bridge) {
      try { this.bridge.stop(); } catch { /* ignore */ }
    }
    this.bridge = null;
    this.stateMachine = null;
    this.catalog = null;
    this.queue = [];
  }

  tick(_session: SessionState | null): PluginContribution | null {
    if (this.disabled || !this.bridge || !this.stateMachine) return null;

    const outputs: MachineOutput[] = [];

    // Drain IPC first so state transitions reflect anything that happened
    // since the last tick, then synthesize a clock tick at 'now' to drive
    // timeout-based transitions (candidate expiry, heartbeat, closing).
    const events = this.bridge.drain();
    for (const ev of events) {
      const next = this.handleIpcEvent(ev);
      for (const o of next) outputs.push(o);
    }

    const now = this.now();
    const tickOutputs = this.stateMachine.step({ t: 'tick', ts: now });
    for (const o of tickOutputs) outputs.push(o);

    for (const o of outputs) {
      // No duration floor (2026-): a session under 2 s emits and mints
      // like any other. A non-positive/non-finite active duration is not a real
      // session, so it is still dropped (this is the restored pre- guard, not
      // a new threshold).
      if (!Number.isFinite(o.activeDurationMs) || o.activeDurationMs <= 0) continue;
      this.queue.push(this.buildPE(o));
    }

    return null;
  }

  drainPEs(): PluginPE[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  // --- IPC translation --------------------------------------------------

  private handleIpcEvent(ev: HelperIPCEvent): MachineOutput[] {
    if (!this.stateMachine) return [];

    switch (ev.t) {
      case 'foreground_changed': {
        const ctx = this.resolveProviderContext(ev.app.bundle_id, ev.app.process_name, ev.browser_url);
        const input: MachineInput = { t: 'foreground_changed', ts: ev.ts, providerContext: ctx };
        return this.stateMachine.step(input);
      }
      case 'input_event': {
        return this.stateMachine.step({ t: 'input_event', ts: ev.ts });
      }
      case 'system_state': {
        return this.stateMachine.step({ t: 'system_state', ts: ev.ts, state: ev.state });
      }
      case 'permission_status': {
        this.inputMonitoring = ev.input_monitoring;
        this.stateMachine.setInputFidelity(ev.input_monitoring ? 'full' : 'presence_only');
        this.observer.log('info', 'helper permission status', {
          accessibility: ev.accessibility,
          input_monitoring: ev.input_monitoring,
        });
        // Surface the real OS permission state to the app's device view so a
        // user who never granted Accessibility / Input Monitoring sees
        // "action needed" instead of silent no-capture.
        void this.observer.reportCaptureStatus({
          llm_session_enabled: this.configLlmSessionEnabled,
          active: true,
          permissions_checked: true,
          accessibility: ev.accessibility,
          input_monitoring: ev.input_monitoring,
        });
        return [];
      }
      case 'error': {
        this.observer.log('warn', 'helper error event', { message: ev.message });
        return [];
      }
      case 'fatal': {
        this.observer.log('warn', 'helper fatal event', { message: ev.message });
        // Bridge restarts the helper; nothing else to do here.
        return [];
      }
    }
  }

  /**
   * Resolve a foreground-changed IPC into a ProviderContext.
   *
   * For HelperBridge (macOS / Windows) priority:
   *   1. bundle_id matches a catalog entry (macOS native desktop app).
   *   2. process_name matches a catalog entry (Windows native desktop app;
   *      also a macOS fallback when bundle_id is absent).
   *   3. browser_url matches a catalog entry (browser tab, either OS).
   *
   * macOS helpers emit a bundle_id, so step 1 wins there as before. Windows
   * apps have no bundle identifier - the helper emits bundle_id=null and a
   * process_name (the executable basename, e.g. "Claude"), so step 2 carries
   * native-app matching on Windows. Browser usage is matched by browser_url
   * on both platforms.
   *
   * For AndroidBridge: bundle_id is actually the Android package name,
   * resolved via matchPackageNameToProvider().
   *
   * Otherwise: null (state machine treats as foreground-unknown).
   */
  private resolveProviderContext(
    bundleId: string | null,
    processName: string | null,
    browserUrl: string | null,
  ): ProviderContext | null {
    if (!this.catalog) return null;

    let entry: ProviderEntry | null = null;
    let sessionId: string | null = null;

    if (bundleId) {
      if (this.bridgeSource === 'android') {
        // On Android, bundle_id carries the Android package name.
        entry = matchPackageNameToProvider(bundleId, this.catalog);
      } else {
        entry = matchBundleIdToProvider(bundleId, this.catalog);
      }
      if (entry && browserUrl && entry.session_boundary === 'url_session_id') {
        // Native apps rarely expose a URL, but some (Perplexity, Claude desktop)
        // can. If we happen to have one, try to extract a session id; null is fine.
        sessionId = extractSessionId(browserUrl, entry);
      }
    }

    // Windows native-app match (and macOS fallback): match by process name.
    // Never used for the Android bridge, whose process identity arrives in
    // bundle_id and is handled above.
    if (!entry && processName && this.bridgeSource !== 'android') {
      entry = matchProcessNameToProvider(processName, this.catalog);
      if (entry && browserUrl && entry.session_boundary === 'url_session_id') {
        sessionId = extractSessionId(browserUrl, entry);
      }
    }

    if (!entry && browserUrl) {
      entry = matchUrlToProvider(browserUrl, this.catalog);
      if (entry && entry.session_boundary === 'url_session_id') {
        sessionId = extractSessionId(browserUrl, entry);
      }
    }

    if (!entry) return null;

    // Prompt 2: remember the browser URL for this provider so buildPE can record
    // the domain (resolvable) + path (private). Only a real browser tab carries
    // one; a native-app match leaves it unset.
    if (browserUrl) this.lastBrowserUrlByProvider.set(entry.provider, browserUrl);

    return {
      provider: entry.provider,
      sessionId,
      boundaryMode: entry.session_boundary,
      timestampGapMs:
        entry.session_boundary === 'timestamp_gap' && entry.timestamp_gap_seconds !== null
          ? entry.timestamp_gap_seconds * 1000
          : null,
    };
  }

  // --- PE construction --------------------------------------------------

  /**
   * Build a PluginPE from a state-machine emission.
   *
   * Every PE carries `skipDedupClaim: true`. This is intentional: the
   * generic DeduplicationRegistry's scope is "don't emit two PEs describing
   * the same work", but ai_conversation measures human AI engagement and is
   * complementary to (not substitutable for) compute_session,
   * inference_session, or coding_session. A developer on claude.ai with a
   * logging agent runtime active should generate both an ai_conversation PE
   * (foreground-based) and an inference_session PE (log-based) for the
   * overlapping window. Dedup within this plugin is enforced by
   * session_fingerprint_hash at the relay. See CAPTURE_ARCHITECTURE.md §9
   * and PHASE_2B_DESIGN_NOTES.md §8.
   */
  private buildPE(out: MachineOutput): PluginPE {
    const durationMs = Math.max(0, out.windowEnd - out.windowStart);
    const fingerprint = computeSessionFingerprint({
      provider: out.provider,
      sessionStartMs: out.windowStart,
      durationMs,
      turnCount: out.turnCount,
      pluginName: PLUGIN_NAME,
    });

    // Preserve observed browser URL provenance. The removed provider-as-origin
    // token-volume rule supplies no origin and has no pricing effect.
    const witness = this.observer.observerDeviceWitness?.() ?? null;
    const origins: InputOrigin[] = [];
    const lastUrl = this.lastBrowserUrlByProvider.get(out.provider);
    if (lastUrl) origins.push(...urlOrigins(lastUrl, witness));

    return {
      actionType: 'ai_conversation',
      windowStart: out.windowStart,
      windowEnd: out.windowEnd,
      input_origins: origins,
      metadata: {
        provider: out.provider,
        surface: 'desktop_foreground',
        duration_ms: durationMs,
        active_duration_ms: out.activeDurationMs,
        turn_count: out.turnCount,
        char_count: 0,
        image_count: 0,
        video_seconds: 0,
        session_fingerprint_hash: fingerprint,
        input_fidelity: out.inputFidelity,
      },
      skipDedupClaim: true,
    };
  }

  // --- configuration and path resolution --------------------------------

  private resolveConfig(): ResolvedConfig {
    if (this.options.enabled !== undefined) {
      return { enabled: this.options.enabled };
    }
    const p = this.options.configPath ?? DEFAULT_CONFIG_PATH;
    // Shared reader: missing OR malformed config reads as {} — same semantics as
    // the private copy this replaced (both then fall to { enabled: null }).
    const parsed = readProvianConfig(p);
    const capture = parsed.capture;
    if (!isRecord(capture)) return { enabled: null };
    const v = capture.llm_session_enabled;
    if (typeof v === 'boolean') return { enabled: v };
    return { enabled: null };
  }

  private isSupportedPlatform(): boolean {
    // darwin and win32 both ship a native foreground helper. linux is kept
    // in the supported set so the plugin reaches helper resolution (and logs
    // a precise "no helper binary" reason) rather than a blunt
    // "unsupported platform" - there is no Linux helper binary yet.
    return (
      process.platform === 'darwin' ||
      process.platform === 'win32' ||
      process.platform === 'linux'
    );
  }

  private resolveHelperBinaryPath(): string | null {
    if (this.options.helperBinaryPath) {
      return fs.existsSync(this.options.helperBinaryPath) ? this.options.helperBinaryPath : null;
    }
    if (process.env.PROVIAN_FOREGROUND_HELPER_BINARY) {
      const ovr = process.env.PROVIAN_FOREGROUND_HELPER_BINARY;
      return fs.existsSync(ovr) ? ovr : null;
    }
    const candidates =
      process.platform === 'win32'
        ? this.win32HelperCandidates()
        : process.platform === 'darwin'
          ? this.darwinHelperCandidates()
          : [];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  private darwinHelperCandidates(): string[] {
    return [
      // Installed location (post-install copy target)
      path.join(os.homedir(), '.provian', 'helpers', 'darwin', 'ProvianForegroundHelper.app', 'Contents', 'MacOS', 'ProvianForegroundHelper'),
      // In-repo dev build. Resolved from this file's location up to the
      // package root. __dirname is either src/observer/plugins/llm-session
      // (dev) or dist/observer/plugins/llm-session (prod).
      path.resolve(__dirname, '..', '..', '..', '..', 'native', 'darwin', 'foreground-helper', 'ProvianForegroundHelper.app', 'Contents', 'MacOS', 'ProvianForegroundHelper'),
      path.resolve(__dirname, '..', '..', '..', 'native', 'darwin', 'foreground-helper', 'ProvianForegroundHelper.app', 'Contents', 'MacOS', 'ProvianForegroundHelper'),
    ];
  }

  private win32HelperCandidates(): string[] {
    const exe = 'ProvianForegroundHelper.exe';
    return [
      // Installed location (post-install copy target)
      path.join(os.homedir(), '.provian', 'helpers', 'win32', exe),
      // In-repo dev build (dotnet publish output). __dirname is either
      // src/observer/plugins/llm-session (dev) or
      // dist/observer/plugins/llm-session (prod).
      path.resolve(__dirname, '..', '..', '..', '..', 'native', 'win32', 'foreground-helper', 'publish', exe),
      path.resolve(__dirname, '..', '..', '..', 'native', 'win32', 'foreground-helper', 'publish', exe),
    ];
  }

  private constructHelperBridge(binaryPath: string): HelperBridge {
    const cfg: HelperBridgeConfig = {
      binaryPath,
      logger: (level, msg, meta) => this.observer.log(level, `helper bridge: ${msg}`, meta),
      spawnFn: this.options.spawnFn,
      setTimeoutFn: this.options.setTimeoutFn,
      clearTimeoutFn: this.options.clearTimeoutFn,
      now: this.options.now,
    };
    if (this.options.bridgeFactory) return this.options.bridgeFactory(cfg);
    return new HelperBridge(cfg);
  }

  /**
   * Resolve android-companion.json config. Returns an object with host/port
   * if the companion config exists and is valid, or null otherwise.
   */
  private resolveAndroidCompanionConfig(): { host?: string; port?: number } | null {
    const configPath = this.options.androidCompanionConfigPath
      ?? path.join(os.homedir(), '.provian', 'android-companion.json');
    if (!fs.existsSync(configPath)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      this.observer.log('warn', 'android companion config unreadable', { path: configPath });
      return null;
    }
    if (!isRecord(parsed)) return null;

    const result: { host?: string; port?: number } = {};
    if (typeof parsed.host === 'string' && parsed.host.length > 0) {
      result.host = parsed.host;
    }
    if (typeof parsed.port === 'number' && Number.isFinite(parsed.port)) {
      result.port = parsed.port;
    }
    return result;
  }

  private constructAndroidBridge(companionConfig: { host?: string; port?: number }): AndroidBridge {
    const cfg: AndroidBridgeConfig = {
      host: companionConfig.host,
      port: companionConfig.port,
      logger: (level, msg, meta) => this.observer.log(level, `android bridge: ${msg}`, meta),
      createConnectionFn: this.options.createConnectionFn,
      setTimeoutFn: this.options.setTimeoutFn,
      clearTimeoutFn: this.options.clearTimeoutFn,
      now: this.options.now,
    };
    if (this.options.androidBridgeFactory) return this.options.androidBridgeFactory(cfg);
    return new AndroidBridge(cfg);
  }
}

// --- fingerprint hash (exported for direct testing) ---------------------

export interface FingerprintInput {
  provider: string;
  sessionStartMs: number;
  durationMs: number;
  turnCount: number;
  pluginName: string;
}

/**
 * SHA-256 over length-prefixed UTF-8 fields. Each field is encoded as its
 * decimal string form (for numbers) and prefixed with a 4-byte big-endian
 * length. Deterministic; identical inputs always hash the same.
 *
 * Spec: PHASE_2B_DESIGN_NOTES.md §5.
 */
export function computeSessionFingerprint(input: FingerprintInput): string {
  const parts: string[] = [
    input.provider,
    String(Math.trunc(input.sessionStartMs)),
    String(Math.trunc(input.durationMs)),
    String(Math.trunc(input.turnCount)),
    input.pluginName,
  ];
  const hash = createHash('sha256');
  for (const p of parts) {
    const buf = Buffer.from(p, 'utf8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(buf.length, 0);
    hash.update(prefix);
    hash.update(buf);
  }
  return hash.digest('hex');
}

// --- local utilities --------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
