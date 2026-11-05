/**
 * END-TO-END (SDK side): local model work on a registered machine EMITS.
 *
 * A fixture Ollama server log + a fixture `/api/ps` answer drive the REAL
 * LLMPlugin → REAL ProvianObserver tick loop → REAL SessionManager (minting a
 * real session lineage for an attested device id) → REAL ProvianClient
 * the observed-PE submitter (device mode, body-HMAC bound). We intercept `fetch` and read
 * the exact body the relay would receive. The assertions pin the wire shape the
 * backend acceptance suite (`inference-session-producer.acceptance.test.ts`)
 * seals: `action_type: inference_session`, a `pesl2_` lineage, `metadata.inference`
 * with `tokens_observed:false`, and `compute.tokens_processed: null`.
 *
 * RED CONTROL — the PRE-FIX rules, transcribed (the `recoveryWalkModes` pattern):
 * fed the SAME fixture, the pre-fix plugin contributes nothing (no tokens) and
 * the pre-fix observer types the window `compute_session` + `no_observable_output`
 * — i.e. records, never mints. The live path on the same fixture yields
 * `inference_session`. A source pin below proves the transcription is of code
 * that no longer exists in the tree.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openPrivatePricing } from '../../../../provian-backend/src/core/meter/private-pricing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProvianObserver } from '../ProvianObserver';
import { LLMPlugin } from './LLMPlugin';
import { NO_LOCAL_INFERENCE, type LocalInferenceProbe } from './local-inference/runtimes';
import type { ProvianCredentials } from '../../scripts/credentials';
import { ProvianClient } from '../../ProvianClient';
import { MemoryPeStore, type AppendResult, type StoredPeV2 } from '../../meter/pe-store';
import { FakeMeterRelay } from '../../meter/capturing-store.test-support';

const TICK_MS = 1_000;
const IDLE_MS = 30_000;

/** A PE the observer recorded in the device's PE store (PE meter: no network at record time). */
interface CapturedSubmit {
  body: Record<string, unknown>;
}

class SubmitCapturingStore extends MemoryPeStore {
  constructor(deviceId: string, readonly submits: CapturedSubmit[]) { super(deviceId); }
  override async append(pe: StoredPeV2, options: { idempotencyKey?: string; recordedAtMs?: number } = {}): Promise<AppendResult> {
    const result = await super.append(pe, options);
    if (result.ok && !result.replay) this.submits.push({ body: result.stored.pe as unknown as Record<string, unknown> });
    return result;
  }
}

function ollamaProbe(logPath: string | null, models: string[] = ['llama3.1:8b']): LocalInferenceProbe {
  return {
    detected: true,
    jsonlLogPath: null,
    runtimes: [
      { runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434', reachable: true, installed: true, loadedModels: models, logPath, tokensObservable: false },
      { runtime: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', reachable: false, installed: false, loadedModels: [], logPath: null, tokensObservable: true },
      { runtime: 'llamacpp', baseUrl: 'http://127.0.0.1:8080', reachable: false, installed: false, loadedModels: [], logPath: null, tokensObservable: true },
    ],
  };
}

function llamaCppProbe(logPath: string): LocalInferenceProbe {
  return {
    detected: true,
    jsonlLogPath: null,
    runtimes: [
      { runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434', reachable: false, installed: false, loadedModels: [], logPath: null, tokensObservable: false },
      { runtime: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', reachable: false, installed: false, loadedModels: [], logPath: null, tokensObservable: true },
      { runtime: 'llamacpp', baseUrl: 'http://127.0.0.1:8080', reachable: true, installed: true, loadedModels: ['Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf'], logPath, tokensObservable: true },
    ],
  };
}

function jsonlProbe(jsonlLogPath: string): LocalInferenceProbe {
  return { detected: true, jsonlLogPath, runtimes: [] };
}

/** The Ollama fixture: three COMPLETED inference requests plus the chatter around them. */
const OLLAMA_FIXTURE_LINES = [
  'time=2026-09-03T10:15:31.000-07:00 level=INFO source=server.go:632 msg="llama runner started in 1.23 seconds"',
  '[GIN] 2026/09/03 - 10:15:30 | 200 |  1.2ms |       127.0.0.1 | GET      "/api/tags"',
  '[GIN] 2026/09/03 - 10:15:32 | 200 |  1.234567s |       127.0.0.1 | POST     "/api/chat"',
  '[GIN] 2026/09/03 - 10:15:40 | 200 |  812.4ms |       127.0.0.1 | POST     "/api/generate"',
  '[GIN] 2026/09/03 - 10:15:41 | 200 |  1.0ms |       127.0.0.1 | GET      "/api/ps"',
  '[GIN] 2026/09/03 - 10:15:55 | 200 |  2.001s |       127.0.0.1 | POST     "/v1/chat/completions"',
  '[GIN] 2026/09/03 - 10:15:58 | 404 |  0.5ms |       127.0.0.1 | POST     "/api/chat"',
];

interface Harness {
  observer: ProvianObserver;
  plugin: LLMPlugin;
  logPath: string;
  submits: CapturedSubmit[];
  store: MemoryPeStore;
  creds: ProvianCredentials;
  append(lines: string[]): void;
  tick(): Promise<void>;
  idleOut(): Promise<void>;
}

async function harness(makeProbe: (logPath: string) => LocalInferenceProbe, relative = path.join('.ollama', 'logs', 'server.log')): Promise<Harness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-inf-'));
  const logPath = path.join(home, relative);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '');
  const probe = makeProbe(logPath);

  const creds: ProvianCredentials = {
    deviceKey: 'pdk_test',
    deviceSecret: 'pds_test',
    relayUrl: 'https://relay.test',
    deviceId: 'dev_fixture_ollama',
  };
  const submits: CapturedSubmit[] = [];
  const store = new SubmitCapturingStore('dev_fixture_ollama', submits);
  const observer = new ProvianObserver({
    idleThresholdMs: IDLE_MS,
    maxSessionMs: 15 * 60 * 1000,
    tickIntervalMs: TICK_MS,
    plugins: ['llm'],
    relayUrl: creds.relayUrl,
    credentials: creds,
    logLevel: 'error',
    sessionOrdinalPath: path.join(home, 'ordinal.json'),
    peStore: store,
  });
  const plugin = new LLMPlugin({ initialProbe: probe, probe: async () => probe, reprobeIntervalMs: 0 });
  observer.registerPlugin(plugin);

  await observer.start();
  return {
    observer,
    plugin,
    logPath,
    submits,
    store,
    creds,
    append: (lines) => fs.appendFileSync(logPath, lines.join('\n') + '\n'),
    tick: async () => { await vi.advanceTimersByTimeAsync(TICK_MS); },
    idleOut: async () => { await vi.advanceTimersByTimeAsync(IDLE_MS + TICK_MS); },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('LLMPlugin — zero-config Ollama witness, end to end through the real observer', () => {
  it('three completed requests in the log → ONE body-bound inference_session PE with a minted lineage, tokens null', async () => {
    vi.useFakeTimers();
    const h = await harness((log) => ollamaProbe(log));
    expect(h.plugin.tailedPaths()).toEqual([h.logPath]);
    expect(h.observer.sessionManager.current()).toBeNull();

    h.append(OLLAMA_FIXTURE_LINES);
    await h.tick();

    // The witnessed requests OPENED a session (no ProcessPlugin is registered —
    // this is the human-device shape) and accumulated on it.
    const open = h.observer.sessionManager.current();
    expect(open).not.toBeNull();
    expect(open!.inference).toEqual({
      requests: 3, models: ['llama3.1:8b'], runtimes: ['ollama'], sources: ['ollama_server_log'], tokensObserved: false,
    });
    expect(open!.tokensProcessed).toBe(0);
    expect(open!.lineage).not.toBeNull();
    const lineageId = open!.lineage!.id;

    await h.idleOut();
    expect(h.submits).toHaveLength(1);
    const { body } = h.submits[0];

    // THE wire shape the backend acceptance suite seals.
    expect(body.action_type).toBe('inference_session');
    const meta = body.metadata as Record<string, unknown>;
    expect(meta.tool).toBe('provian-observer');
    expect(meta.inference).toEqual({
      runtime: 'ollama',
      requests: 3,
      models: ['llama3.1:8b'],
      source: 'ollama_server_log',
      tokens_observed: false,
    });
    expect(meta.null_state_flags).toBeUndefined();
    const compute = body.compute as Record<string, unknown>;
    expect(compute.tokens_processed).toBeNull();   // NEVER fabricated for Ollama
    expect(typeof compute.duration_ms).toBe('number');
    const lineage = body.economic_session_lineage as Record<string, unknown>;
    expect(lineage.id).toBe(lineageId);
    expect(String(lineage.id).startsWith('pesl2_')).toBe(true);
    expect(lineage.session_ordinal).toBe(1);
    // Body-bound: the relay's device-witnessed VERIFIED gate keys on this header — now carried
    // by the daily batch that takes this PE's act record to the relay (PE meter).
    vi.useRealTimers();
    const relay = new FakeMeterRelay('dev_fixture_ollama');
    vi.stubGlobal('fetch', relay.fetch);
    const client = new ProvianClient({
      relayUrl: h.creds.relayUrl, deviceKey: h.creds.deviceKey, deviceSecret: h.creds.deviceSecret,
      deviceId: h.creds.deviceId, peStore: h.store,
    });
    const sent = await (await client.createMeterBatcher()).flush();
    expect(sent.outcome).toBe('sent');
    const post = relay.batchPosts()[0];
    expect(post.headers['X-Provian-Body-HMAC']).toMatch(/^[0-9a-f]{64}$/);
    const wireAct = relay.accepted[0].acts[0];
    const act = {...wireAct, pricing:openPrivatePricing(wireAct, String(body.private_commitment))};
    expect(post.body!).not.toContain('inference_session');
    expect(act.pe_id).toBe(body.pe_id);
    expect(act.action_type).toBe('inference_session');
    expect((act.pricing.economic_session_lineage as { id: string }).id).toBe(lineageId);
  });

  it('RED CONTROL — the PRE-FIX rules on the SAME fixture yield compute_session + no_observable_output (records, never mints)', async () => {
    /**
     * Transcribed verbatim from the code this change replaced:
     *   LLMPlugin.tick (pre-fix):            `if (this.pendingTokens === 0) return null;`
     *   ProvianObserver.finalizeSession:     `const actionType = state.tokensProcessed > 0 ? 'inference_session' : 'compute_session';`
     *   output gate (unchanged):             `if (actionType === 'compute_session') { if (pluginArtifacts.size === 0) metadata.null_state_flags = ['no_observable_output']; }`
     * Tokens came ONLY from JSONL records; Ollama's server log carries none, so
     * the pre-fix plugin's pendingTokens for this fixture is 0.
     */
    function preFixOutcome(witnessed: { tokens: number; requests: number }): { actionType: string; nullStateFlags: string[] | undefined } {
      const pendingTokens = witnessed.tokens;
      const contributed = pendingTokens > 0;                 // pre-fix plugin gate: requests were invisible
      const state = { tokensProcessed: contributed ? pendingTokens : 0, pluginArtifactsSize: contributed ? 1 : 0 };
      const actionType = state.tokensProcessed > 0 ? 'inference_session' : 'compute_session';
      const nullStateFlags = actionType === 'compute_session' && state.pluginArtifactsSize === 0
        ? ['no_observable_output'] : undefined;
      return { actionType, nullStateFlags };
    }

    // The fixture's honest witness: 3 completed requests, 0 observed tokens.
    const preFix = preFixOutcome({ tokens: 0, requests: 3 });
    expect(preFix.actionType).toBe('compute_session');
    expect(preFix.nullStateFlags).toEqual(['no_observable_output']);

    // The live path on the identical fixture:
    vi.useFakeTimers();
    const h = await harness((log) => ollamaProbe(log));
    h.append(OLLAMA_FIXTURE_LINES);
    await h.tick();
    await h.idleOut();
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0].body.action_type).toBe('inference_session');
    expect((h.submits[0].body.metadata as Record<string, unknown>).null_state_flags).toBeUndefined();
    expect(h.submits[0].body.action_type).not.toBe(preFix.actionType);
  });

  it('SOURCE PIN — the transcribed pre-fix rules no longer exist in the tree; the new rule does', () => {
    const observerSrc = fs.readFileSync(path.join(__dirname, '..', 'ProvianObserver.ts'), 'utf8');
    const pluginSrc = fs.readFileSync(path.join(__dirname, 'LLMPlugin.ts'), 'utf8');
    expect(observerSrc).not.toContain("state.tokensProcessed > 0 ? 'inference_session' : 'compute_session'");
    expect(observerSrc).toContain('inference.requests > 0');
    expect(pluginSrc).not.toContain('if (this.pendingTokens === 0) return null;');
  });

  it('RED — non-inference lines only (tags/ps/pull, a failed request) open NO session and emit NOTHING', async () => {
    vi.useFakeTimers();
    const h = await harness((log) => ollamaProbe(log));
    h.append([
      '[GIN] 2026/09/03 - 10:15:30 | 200 |  1.2ms |       127.0.0.1 | GET      "/api/tags"',
      '[GIN] 2026/09/03 - 10:15:41 | 200 |  1.0ms |       127.0.0.1 | GET      "/api/ps"',
      '[GIN] 2026/09/03 - 10:15:50 | 200 |  9.9s  |       127.0.0.1 | POST     "/api/pull"',
      '[GIN] 2026/09/03 - 10:15:58 | 500 |  0.5ms |       127.0.0.1 | POST     "/api/chat"',
    ]);
    await h.tick();
    expect(h.observer.sessionManager.current()).toBeNull();
    await h.idleOut();
    expect(h.submits).toHaveLength(0);
  });

  it('one session window = one lineage = one PE; requests across several ticks accumulate on it', async () => {
    vi.useFakeTimers();
    const h = await harness((log) => ollamaProbe(log));
    h.append([OLLAMA_FIXTURE_LINES[2]]);
    await h.tick();
    const first = h.observer.sessionManager.current()!.lineage!.id;
    h.append([OLLAMA_FIXTURE_LINES[3]]);
    await h.tick();
    h.append([OLLAMA_FIXTURE_LINES[5]]);
    await h.tick();
    expect(h.observer.sessionManager.current()!.lineage!.id).toBe(first);
    await h.idleOut();
    expect(h.submits).toHaveLength(1);
    expect((h.submits[0].body.metadata as Record<string, unknown>).inference).toMatchObject({ requests: 3 });
    // A later window is a NEW session with a NEW lineage (mint-once is per session lineage on the relay).
    h.append([OLLAMA_FIXTURE_LINES[2]]);
    await h.tick();
    await h.idleOut();
    expect(h.submits).toHaveLength(2);
    const l1 = (h.submits[0].body.economic_session_lineage as Record<string, unknown>).id;
    const l2 = (h.submits[1].body.economic_session_lineage as Record<string, unknown>).id;
    expect(l1).not.toBe(l2);
  });
});

describe('LLMPlugin — token-bearing sources record observed tokens ONLY', () => {
  it('llama.cpp: request + timing lines → tokens_processed 46, tokens_observed true', async () => {
    vi.useFakeTimers();
    const h = await harness((log) => llamaCppProbe(log), 'llama-server.log');
    h.append([
      'srv  log_server_r: request: POST /v1/chat/completions 127.0.0.1 200',
      'prompt eval time =     123.45 ms /    12 tokens (   10.29 ms per token,    97.20 tokens per second)',
      '       eval time =    1234.56 ms /    34 tokens (   36.31 ms per token,    27.54 tokens per second)',
      '      total time =    1358.01 ms /    46 tokens',
    ]);
    await h.tick();
    await h.idleOut();
    expect(h.submits).toHaveLength(1);
    const body = h.submits[0].body;
    expect(body.action_type).toBe('inference_session');
    expect((body.compute as Record<string, unknown>).tokens_processed).toBe(46);
    expect((body.metadata as Record<string, unknown>).inference).toEqual({
      runtime: 'llamacpp',
      requests: 1,
      models: ['Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf'],
      source: 'llamacpp_server_log',
      tokens_observed: true,
    });
  });

  it('the original JSONL source (PROVIAN_LLM_LOG) still works: one record = one request with its tokens', async () => {
    vi.useFakeTimers();
    const h = await harness((log) => jsonlProbe(log), 'inference.jsonl');
    h.append(['{"model":"gpt-x","input_tokens":100,"output_tokens":50}']);
    await h.tick();
    await h.idleOut();
    expect(h.submits).toHaveLength(1);
    const body = h.submits[0].body;
    expect(body.action_type).toBe('inference_session');
    expect((body.compute as Record<string, unknown>).tokens_processed).toBe(150);
    expect((body.metadata as Record<string, unknown>).inference).toEqual({
      runtime: 'jsonl', requests: 1, models: ['gpt-x'], source: 'jsonl_inference_log', tokens_observed: true,
    });
  });
});

describe('LLMPlugin — detection lifecycle', () => {
  it('a runtime that appears AFTER start is picked up by the re-probe (tailing from the log\'s current end)', async () => {
    vi.useFakeTimers();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-inf-late-'));
    const logPath = path.join(home, 'server.log');
    // Pre-existing content must NOT be back-witnessed.
    fs.writeFileSync(logPath, OLLAMA_FIXTURE_LINES.join('\n') + '\n');
    let calls = 0;
    const late = ollamaProbe(logPath);
    const plugin = new LLMPlugin({
      initialProbe: NO_LOCAL_INFERENCE,
      probe: async () => (++calls >= 1 ? late : NO_LOCAL_INFERENCE),
      reprobeIntervalMs: 0,
    });
    const creds: ProvianCredentials = { deviceKey: 'k', deviceSecret: 's', relayUrl: 'https://relay.test', deviceId: 'dev_late' };
    const observer = new ProvianObserver({
      idleThresholdMs: IDLE_MS, maxSessionMs: 900_000, tickIntervalMs: TICK_MS, plugins: ['llm'],
      relayUrl: creds.relayUrl, credentials: creds, logLevel: 'error', sessionOrdinalPath: path.join(home, 'ord.json'),
    });
    observer.registerPlugin(plugin);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ pe_id: 'pe_x' }), { status: 201 })));
    expect(plugin.tailedPaths()).toEqual([]);
    await observer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.currentProbe().detected).toBe(true);
    expect(plugin.tailedPaths()).toEqual([logPath]);
    // Nothing from the pre-existing content:
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(observer.sessionManager.current()).toBeNull();
    // New work after detection IS witnessed:
    fs.appendFileSync(logPath, OLLAMA_FIXTURE_LINES[2] + '\n');
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(observer.sessionManager.current()!.inference!.requests).toBe(1);
    await observer.stop();
  });
});
