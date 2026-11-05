/**
 * Local inference runtimes — parsers + probe, each with its RED control.
 *
 * The parsers are the honesty boundary of the producer: a request is counted
 * only from a completed inference route, tokens only where the runtime writes
 * them, and nothing is ever counted from a line that is not work.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  NO_OBSERVATION,
  RUNTIME_DEFAULT_URL,
  describeLocalInferenceProbe,
  lmStudioFootprint,
  ollamaFootprint,
  parseJsonlInferenceLine,
  parseLlamaCppServerLogLine,
  parseLmStudioServerLogLine,
  parseOllamaServerLogLine,
  parserForRuntime,
  probeHasWitnessableSource,
  probeLocalInferenceRuntimes,
  resolveLoopbackBaseUrl,
  type LocalInferenceProbe,
} from './runtimes';

const HOST_RUNTIME_FOOTPRINTS = vi.hoisted(() => new Set<string>());

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (typeof args[0] === 'string' && HOST_RUNTIME_FOOTPRINTS.has(args[0])) {
        throw new Error(`isolated test filesystem: ${args[0]}`);
      }
      return actual.statSync(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Ollama server log
// ---------------------------------------------------------------------------
describe('parseOllamaServerLogLine', () => {
  const chat = '[GIN] 2026/09/03 - 10:15:32 | 200 |  1.234567s |       127.0.0.1 | POST     "/api/chat"';
  const generate = '[GIN] 2026/09/03 - 10:16:02 | 200 | 812.4ms |       127.0.0.1 | POST     "/api/generate"';
  const openai = '[GIN] 2026/09/03 - 10:17:00 | 200 |  2.001s |       127.0.0.1 | POST     "/v1/chat/completions"';

  it('counts ONE completed request per 2xx POST on an inference route, tokens NULL (Ollama logs none)', () => {
    for (const line of [chat, generate, openai]) {
      expect(parseOllamaServerLogLine(line)).toEqual({ requests: 1, tokens: null, model: null });
    }
  });

  // RED CONTROLS — lines that are NOT work must contribute nothing.
  it('RED: GET /api/tags, /api/ps, /api/version are not inference', () => {
    expect(parseOllamaServerLogLine('[GIN] 2026/09/03 - 10:15:00 | 200 |  1.2ms | 127.0.0.1 | GET      "/api/tags"')).toBe(NO_OBSERVATION);
    expect(parseOllamaServerLogLine('[GIN] 2026/09/03 - 10:15:00 | 200 |  1.2ms | 127.0.0.1 | GET      "/api/ps"')).toBe(NO_OBSERVATION);
    expect(parseOllamaServerLogLine('[GIN] 2026/09/03 - 10:15:00 | 200 |  1.2ms | 127.0.0.1 | GET      "/api/version"')).toBe(NO_OBSERVATION);
  });
  it('RED: a FAILED inference (4xx/5xx) is not a completed request', () => {
    expect(parseOllamaServerLogLine('[GIN] 2026/09/03 - 10:15:00 | 404 |  1.2ms | 127.0.0.1 | POST     "/api/chat"')).toBe(NO_OBSERVATION);
    expect(parseOllamaServerLogLine('[GIN] 2026/09/03 - 10:15:00 | 500 |  1.2ms | 127.0.0.1 | POST     "/api/generate"')).toBe(NO_OBSERVATION);
  });
  it('RED: a pull / model management POST is not inference', () => {
    expect(parseOllamaServerLogLine('[GIN] 2026/09/03 - 10:15:00 | 200 |  9.9s | 127.0.0.1 | POST     "/api/pull"')).toBe(NO_OBSERVATION);
    expect(parseOllamaServerLogLine('[GIN] 2026/09/03 - 10:15:00 | 200 |  9.9s | 127.0.0.1 | POST     "/api/show"')).toBe(NO_OBSERVATION);
  });
  it('RED: structured slog lines (runner started, loaded model) are not requests', () => {
    expect(parseOllamaServerLogLine('time=2026-09-03T10:15:31.000-07:00 level=INFO source=server.go:632 msg="llama runner started in 1.23 seconds"')).toBe(NO_OBSERVATION);
    expect(parseOllamaServerLogLine('')).toBe(NO_OBSERVATION);
  });
});

// ---------------------------------------------------------------------------
// LM Studio server log
// ---------------------------------------------------------------------------
describe('parseLmStudioServerLogLine', () => {
  it('a request line counts ONE request, tokens null (tokens arrive on the prediction line)', () => {
    const line = '2026-09-03 10:15:32  [INFO] Received POST request to /v1/chat/completions with body: {"model":"qwen2.5-7b-instruct","messages":[...]}';
    expect(parseLmStudioServerLogLine(line)).toEqual({ requests: 1, tokens: null, model: null });
  });
  it('the prediction line carries the REAL usage block → tokens + model, requests 0 (never double-counted)', () => {
    const line = '2026-09-03 10:15:35  [INFO] [LM STUDIO SERVER] Generated prediction: { "id": "chatcmpl-1", "object": "chat.completion", "model": "qwen2.5-7b-instruct", "usage": { "prompt_tokens": 12, "completion_tokens": 34, "total_tokens": 46 } }';
    expect(parseLmStudioServerLogLine(line)).toEqual({ requests: 0, tokens: 46, model: 'qwen2.5-7b-instruct' });
  });
  it('RED: a GET /v1/models request is not inference', () => {
    expect(parseLmStudioServerLogLine('2026-09-03 10:15:00  [INFO] Received GET request to /v1/models')).toBe(NO_OBSERVATION);
    expect(parseLmStudioServerLogLine('2026-09-03 10:15:00  [INFO] Received POST request to /api/v0/models/load')).toBe(NO_OBSERVATION);
  });
  it('RED: a usage block with zero tokens yields tokens null, never 0-as-observed', () => {
    const line = '[INFO] Generated prediction: { "usage": { "prompt_tokens": 0, "completion_tokens": 0 } }';
    expect(parseLmStudioServerLogLine(line)).toEqual({ requests: 0, tokens: null, model: null });
  });
  it('RED: chatter lines contribute nothing', () => {
    expect(parseLmStudioServerLogLine('2026-09-03 10:15:00  [INFO] [LM STUDIO SERVER] Success! HTTP server listening on port 1234')).toBe(NO_OBSERVATION);
  });
});

// ---------------------------------------------------------------------------
// llama.cpp llama-server
// ---------------------------------------------------------------------------
describe('parseLlamaCppServerLogLine', () => {
  it('a 200 POST on an inference route counts ONE request', () => {
    expect(parseLlamaCppServerLogLine('srv  log_server_r: request: POST /v1/chat/completions 127.0.0.1 200'))
      .toEqual({ requests: 1, tokens: null, model: null });
    expect(parseLlamaCppServerLogLine('srv  log_server_r: request: POST /completion 127.0.0.1 200'))
      .toEqual({ requests: 1, tokens: null, model: null });
  });
  it('prompt eval + eval timing lines carry REAL token counts; total time is SKIPPED (it is their sum)', () => {
    expect(parseLlamaCppServerLogLine('prompt eval time =     123.45 ms /    12 tokens (   10.29 ms per token,    97.20 tokens per second)'))
      .toEqual({ requests: 0, tokens: 12, model: null });
    expect(parseLlamaCppServerLogLine('       eval time =    1234.56 ms /    34 tokens (   36.31 ms per token,    27.54 tokens per second)'))
      .toEqual({ requests: 0, tokens: 34, model: null });
    // RED: counting `total time` too would double every token.
    expect(parseLlamaCppServerLogLine('      total time =    1358.01 ms /    46 tokens')).toBe(NO_OBSERVATION);
  });
  it('RED: GET /health, /props, /metrics and failed requests are not inference', () => {
    expect(parseLlamaCppServerLogLine('srv  log_server_r: request: GET /health 127.0.0.1 200')).toBe(NO_OBSERVATION);
    expect(parseLlamaCppServerLogLine('srv  log_server_r: request: GET /props 127.0.0.1 200')).toBe(NO_OBSERVATION);
    expect(parseLlamaCppServerLogLine('srv  log_server_r: request: POST /completion 127.0.0.1 500')).toBe(NO_OBSERVATION);
    expect(parseLlamaCppServerLogLine('load_tensors: offloaded 33/33 layers to GPU')).toBe(NO_OBSERVATION);
  });
});

// ---------------------------------------------------------------------------
// JSONL (the original opt-in source)
// ---------------------------------------------------------------------------
describe('parseJsonlInferenceLine', () => {
  it('one record = one request with its tokens and model', () => {
    expect(parseJsonlInferenceLine('{"model":"gpt-x","input_tokens":100,"output_tokens":50}'))
      .toEqual({ requests: 1, tokens: 150, model: 'gpt-x' });
  });
  it('a record with no token fields is still a request, tokens null', () => {
    expect(parseJsonlInferenceLine('{"model":"m"}')).toEqual({ requests: 1, tokens: null, model: 'm' });
  });
  it('RED: malformed / non-object lines contribute nothing', () => {
    expect(parseJsonlInferenceLine('not json')).toBe(NO_OBSERVATION);
    expect(parseJsonlInferenceLine('[1,2]')).toBe(NO_OBSERVATION); // an array is not an inference record
    expect(parseJsonlInferenceLine('42')).toBe(NO_OBSERVATION);
  });
  it('parserForRuntime binds each runtime to its parser', () => {
    expect(parserForRuntime('ollama')).toBe(parseOllamaServerLogLine);
    expect(parserForRuntime('lmstudio')).toBe(parseLmStudioServerLogLine);
    expect(parserForRuntime('llamacpp')).toBe(parseLlamaCppServerLogLine);
    expect(parserForRuntime('jsonl')).toBe(parseJsonlInferenceLine);
  });
});

// ---------------------------------------------------------------------------
// Loopback-only endpoint resolution
// ---------------------------------------------------------------------------
describe('resolveLoopbackBaseUrl', () => {
  it('unset → default; loopback overrides are honoured (Ollama\'s OLLAMA_HOST convention)', () => {
    expect(resolveLoopbackBaseUrl(undefined, RUNTIME_DEFAULT_URL.ollama)).toBe('http://127.0.0.1:11434');
    expect(resolveLoopbackBaseUrl('127.0.0.1:11435', RUNTIME_DEFAULT_URL.ollama)).toBe('http://127.0.0.1:11435');
    expect(resolveLoopbackBaseUrl('http://localhost:11436', RUNTIME_DEFAULT_URL.ollama)).toBe('http://localhost:11436');
    expect(resolveLoopbackBaseUrl('0.0.0.0:11434', RUNTIME_DEFAULT_URL.ollama)).toBe('http://127.0.0.1:11434');
  });
  // RED: the probe witnesses THIS machine. A remote host is never probed.
  it('RED: a non-loopback override is REFUSED and the loopback default is used instead', () => {
    expect(resolveLoopbackBaseUrl('http://10.0.0.5:11434', RUNTIME_DEFAULT_URL.ollama)).toBe('http://127.0.0.1:11434');
    expect(resolveLoopbackBaseUrl('ollama.internal:11434', RUNTIME_DEFAULT_URL.ollama)).toBe('http://127.0.0.1:11434');
    expect(resolveLoopbackBaseUrl('ftp://127.0.0.1:1', RUNTIME_DEFAULT_URL.ollama)).toBe('http://127.0.0.1:11434');
  });
});

// ---------------------------------------------------------------------------
// Probe (fake fetch + temp homedir)
// ---------------------------------------------------------------------------
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const [suffix, body] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    throw new Error(`ECONNREFUSED ${url}`);
  }) as unknown as typeof fetch;
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'provian-li-'));
}

const HOST_RUNTIME_PATHS = [
  '/Applications/Ollama.app',
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  '/usr/bin/ollama',
  '/opt/homebrew/var/log/ollama.log',
  '/usr/local/var/log/ollama.log',
  '/var/log/ollama.log',
];

async function withoutHostRuntimeFootprints<T>(run: () => Promise<T> | T): Promise<T> {
  for (const footprint of HOST_RUNTIME_PATHS) HOST_RUNTIME_FOOTPRINTS.add(footprint);
  try {
    return await run();
  } finally {
    HOST_RUNTIME_FOOTPRINTS.clear();
  }
}

describe('probeLocalInferenceRuntimes', () => {
  it('Ollama running: reachable, loaded models from /api/ps, server.log found under ~/.ollama/logs', async () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.ollama', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ollama', 'logs', 'server.log'), '');
    const probe = await probeLocalInferenceRuntimes({
      fetchImpl: fakeFetch({
        '/api/tags': { models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }] },
        '/api/ps': { models: [{ name: 'llama3.1:8b', model: 'llama3.1:8b' }] },
      }),
      timeoutMs: 200,
      context: { homedir: home, platform: 'darwin', env: {} },
    });
    expect(probe.detected).toBe(true);
    const ollama = probe.runtimes.find((r) => r.runtime === 'ollama')!;
    expect(ollama.reachable).toBe(true);
    expect(ollama.installed).toBe(true);
    expect(ollama.loadedModels).toEqual(['llama3.1:8b']);
    expect(ollama.logPath).toBe(path.join(home, '.ollama', 'logs', 'server.log'));
    expect(ollama.tokensObservable).toBe(false);
    expect(probeHasWitnessableSource(probe)).toBe(true);
    expect(describeLocalInferenceProbe(probe)).toContain('ollama (running on http://127.0.0.1:11434, models: llama3.1:8b, log:');
  });

  it('LM Studio running: /api/v0/models loaded state, newest server-log file found', async () => {
    const home = tempHome();
    const logs = path.join(home, '.lmstudio', 'server-logs', '2026-09');
    fs.mkdirSync(logs, { recursive: true });
    const older = path.join(logs, '2026-09-01.1.log');
    const newer = path.join(logs, '2026-09-03.1.log');
    fs.writeFileSync(older, '');
    fs.writeFileSync(newer, '');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);
    const probe = await probeLocalInferenceRuntimes({
      fetchImpl: fakeFetch({
        '/api/v0/models': { data: [{ id: 'qwen2.5-7b-instruct', state: 'loaded' }, { id: 'gemma-2', state: 'not-loaded' }] },
      }),
      timeoutMs: 200,
      context: { homedir: home, platform: 'darwin', env: {} },
    });
    const lm = probe.runtimes.find((r) => r.runtime === 'lmstudio')!;
    expect(lm.reachable).toBe(true);
    expect(lm.loadedModels).toEqual(['qwen2.5-7b-instruct']);
    expect(lm.logPath).toBe(newer);
    expect(lm.tokensObservable).toBe(true);
  });

  it('llama.cpp running: /health ok, model from /props, log only via PROVIAN_LLAMA_SERVER_LOG', async () => {
    const home = tempHome();
    const log = path.join(home, 'llama.log');
    fs.writeFileSync(log, '');
    const probe = await probeLocalInferenceRuntimes({
      fetchImpl: fakeFetch({
        '/health': { status: 'ok' },
        '/props': { model_path: '/models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', total_slots: 1 },
      }),
      timeoutMs: 200,
      context: { homedir: home, platform: 'linux', env: { PROVIAN_LLAMA_SERVER_LOG: log } },
    });
    const lc = probe.runtimes.find((r) => r.runtime === 'llamacpp')!;
    expect(lc.reachable).toBe(true);
    expect(lc.loadedModels).toEqual(['Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf']);
    expect(lc.logPath).toBe(log);
  });

  // RED CONTROL: nothing running, nothing installed, no env → detected false,
  // no witnessable source, and the description says so. This is the exact
  // state of a machine with no local model work — the gate must drop `llm`.
  it('RED: nothing running, nothing installed → detected=false, no source', async () => {
    const home = tempHome();
    const probe = await withoutHostRuntimeFootprints(() => probeLocalInferenceRuntimes({
      fetchImpl: fakeFetch({}),
      timeoutMs: 100,
      context: { homedir: home, platform: 'linux', env: {} },
    }));
    expect(probe.detected).toBe(false);
    expect(probe.runtimes.every((r) => !r.reachable && !r.installed && r.logPath === null)).toBe(true);
    expect(probeHasWitnessableSource(probe)).toBe(false);
    expect(describeLocalInferenceProbe(probe)).toMatch(/^none detected/);
  });

  it('installed-but-not-running still DETECTS (login-order race: the daemon may start before the runtime)', async () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.ollama'), { recursive: true });
    const probe = await probeLocalInferenceRuntimes({
      fetchImpl: fakeFetch({}),
      timeoutMs: 100,
      context: { homedir: home, platform: 'darwin', env: {} },
    });
    expect(probe.detected).toBe(true);
    const ollama = probe.runtimes.find((r) => r.runtime === 'ollama')!;
    expect(ollama.reachable).toBe(false);
    expect(ollama.installed).toBe(true);
    expect(describeLocalInferenceProbe(probe)).toContain('ollama (installed, not running');
  });

  it('PROVIAN_LLM_LOG alone detects (the original JSONL source is preserved)', async () => {
    const probe = await probeLocalInferenceRuntimes({
      fetchImpl: fakeFetch({}),
      timeoutMs: 100,
      context: { homedir: tempHome(), platform: 'linux', env: { PROVIAN_LLM_LOG: '/tmp/inference.jsonl' } },
    });
    expect(probe.detected).toBe(true);
    expect(probe.jsonlLogPath).toBe(path.resolve('/tmp/inference.jsonl'));
    expect(probeHasWitnessableSource(probe)).toBe(true);
  });

  it('a slow / hanging endpoint is bounded by the timeout and reads as unreachable (never blocks)', async () => {
    const hanging = (async (_input: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    const probe = await probeLocalInferenceRuntimes({
      fetchImpl: hanging, timeoutMs: 50, context: { homedir: tempHome(), platform: 'linux', env: {} },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(probe.runtimes.every((r) => !r.reachable)).toBe(true);
  });

  it('footprints honour explicit log overrides only when the file exists, never a host fallback', async () => {
    const home = tempHome();
    const ctx = { homedir: home, platform: 'linux' as const, env: { PROVIAN_OLLAMA_LOG: path.join(home, 'missing.log') } };
    await withoutHostRuntimeFootprints(async () => {
      expect(ollamaFootprint(ctx).logPath).toBeNull();
      fs.writeFileSync(path.join(home, 'missing.log'), '');
      expect(ollamaFootprint(ctx).logPath).toBe(path.join(home, 'missing.log'));
    });
    expect(lmStudioFootprint({ homedir: home, platform: 'linux', env: {} }).logPath).toBeNull();
  });

  it('describeLocalInferenceProbe is one line per detected runtime, joined', () => {
    const probe: LocalInferenceProbe = {
      detected: true,
      jsonlLogPath: null,
      runtimes: [
        { runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434', reachable: true, installed: true, loadedModels: [], logPath: null, tokensObservable: false },
        { runtime: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', reachable: false, installed: false, loadedModels: [], logPath: null, tokensObservable: true },
      ],
    };
    expect(describeLocalInferenceProbe(probe)).toBe('ollama (running on http://127.0.0.1:11434, log: not found)');
  });
});
