/**
 * Local inference runtimes — the ZERO-CONFIG producer behind `inference_session`.
 *
 * `inference_session` has priced fine since the matrix was armed (eligible,
 * verified_compute_or_work) and is a device-witnessed family, so a body-bound
 * daemon submit carrying a session lineage seals VERIFIED and mints at the
 * device tier. The producer, however, never fired: tokens came only from a
 * JSONL log at `PROVIAN_LLM_LOG`, which no installed daemon service ever had
 * set. Local model work on a registered machine therefore emitted nothing.
 *
 * This module turns the LLM plugin into a witness of the local runtimes people
 * actually run — Ollama, LM Studio, llama.cpp's `llama-server` — with no
 * configuration:
 *
 *  - DETECTION probes loopback endpoints only (short timeout, never blocks a
 *    tick) and checks the on-disk install footprint, so a runtime that starts
 *    AFTER the daemon (the login-order race) is still picked up.
 *  - WITNESSING reads the request log the runtime itself writes and counts
 *    COMPLETED inference requests. Model names come from the runtime's own
 *    loaded-model endpoint or its log.
 *  - TOKENS are parsed ONLY where the runtime actually exposes them (llama.cpp
 *    and LM Studio log lines, the JSONL source). Ollama's server log carries no
 *    token counts, so an Ollama session ships `tokens_processed: null` and
 *    `tokens_observed: false`. A token count is never estimated or fabricated.
 *
 * Everything below the probe is pure so it carries in-suite RED controls
 * (`runtimes.test.ts`): a non-inference log line contributes nothing, a
 * non-loopback URL is refused, and an unobserved token count stays null.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type LocalInferenceRuntime = 'ollama' | 'lmstudio' | 'llamacpp' | 'jsonl';

/** Where a witnessed observation came from. Carried verbatim in PE metadata. */
export type LocalInferenceSource =
  | 'ollama_server_log'
  | 'lmstudio_server_log'
  | 'llamacpp_server_log'
  | 'jsonl_inference_log';

export const RUNTIME_SOURCE: Record<LocalInferenceRuntime, LocalInferenceSource> = {
  ollama: 'ollama_server_log',
  lmstudio: 'lmstudio_server_log',
  llamacpp: 'llamacpp_server_log',
  jsonl: 'jsonl_inference_log',
};

/** Default loopback endpoints. Overridable by env, loopback-only enforced. */
export const RUNTIME_DEFAULT_URL: Record<Exclude<LocalInferenceRuntime, 'jsonl'>, string> = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234',
  llamacpp: 'http://127.0.0.1:8080',
};

/** One parsed log line's contribution. Tokens are `null` unless the line carries them. */
export interface LocalInferenceObservation {
  /** Completed inference requests witnessed on this line (0 or 1). */
  requests: number;
  /** Token count carried by the line, or null when the runtime does not expose one. */
  tokens: number | null;
  /** Model name carried by the line, if any. */
  model: string | null;
}

export const NO_OBSERVATION: LocalInferenceObservation = Object.freeze({ requests: 0, tokens: null, model: null });

export interface RuntimeDetection {
  runtime: Exclude<LocalInferenceRuntime, 'jsonl'>;
  baseUrl: string;
  /** The runtime answered on its loopback endpoint during this probe. */
  reachable: boolean;
  /** An install footprint exists on disk (app bundle, binary, or data dir). */
  installed: boolean;
  /** Models the runtime reported loaded/available at probe time. */
  loadedModels: string[];
  /** The request log this daemon can tail, or null when none was found. */
  logPath: string | null;
  /** Whether this runtime's log exposes token counts at all. */
  tokensObservable: boolean;
}

export interface LocalInferenceProbe {
  /** True when at least one runtime is reachable OR installed, or a JSONL source is configured. */
  detected: boolean;
  runtimes: RuntimeDetection[];
  /** `PROVIAN_LLM_LOG`, resolved, when set. */
  jsonlLogPath: string | null;
}

// ---------------------------------------------------------------------------
// Pure log-line parsers (one per runtime)
// ---------------------------------------------------------------------------

/** Ollama routes that complete an inference. Everything else (`/api/tags`, `/api/ps`, pulls) is not work. */
export const OLLAMA_INFERENCE_PATHS: ReadonlySet<string> = new Set([
  '/api/chat', '/api/generate', '/v1/chat/completions', '/v1/completions',
  '/api/embed', '/api/embeddings', '/v1/embeddings',
]);

// [GIN] 2026/09/03 - 10:15:32 | 200 |  1.234567s |       127.0.0.1 | POST     "/api/chat"
const OLLAMA_GIN_RE = /\[GIN\]\s.*?\|\s*(\d{3})\s*\|.*?\|\s*(POST|GET|PUT|DELETE)\s+"([^"?]+)/;

/**
 * Ollama's server log: a completed inference is a `[GIN]` access line with a
 * 2xx status on an inference route. Ollama logs no token counts → tokens null.
 * Model names are NOT reliably in this log (only blob digests), so the caller
 * folds in `/api/ps`.
 */
export function parseOllamaServerLogLine(line: string): LocalInferenceObservation {
  const m = OLLAMA_GIN_RE.exec(line);
  if (!m) return NO_OBSERVATION;
  const status = Number(m[1]);
  const method = m[2];
  const route = m[3];
  if (method !== 'POST' || status < 200 || status >= 300) return NO_OBSERVATION;
  if (!OLLAMA_INFERENCE_PATHS.has(route)) return NO_OBSERVATION;
  return { requests: 1, tokens: null, model: null };
}

/** LM Studio's OpenAI-compatible inference routes (its own `/api/v0` mirror included). */
export const LMSTUDIO_INFERENCE_PATHS: ReadonlySet<string> = new Set([
  '/v1/chat/completions', '/v1/completions', '/v1/embeddings', '/v1/responses',
  '/api/v0/chat/completions', '/api/v0/completions', '/api/v0/embeddings',
]);

const LMSTUDIO_REQUEST_RE = /Received POST request to (\/[^\s]+)/;
const USAGE_RE = /"usage"\s*:\s*\{([^}]*)\}/;
const PROMPT_TOKENS_RE = /"prompt_tokens"\s*:\s*(\d+)/;
const COMPLETION_TOKENS_RE = /"completion_tokens"\s*:\s*(\d+)/;
const MODEL_FIELD_RE = /"model"\s*:\s*"([^"]+)"/;

/**
 * LM Studio's server log. A request line (`Received POST request to /v1/…`)
 * counts one request; a `Generated prediction: {…"usage":{…}}` line carries the
 * real usage block, which is the ONLY place tokens are read from. A request
 * with no usage line in the window stays token-less.
 */
export function parseLmStudioServerLogLine(line: string): LocalInferenceObservation {
  const req = LMSTUDIO_REQUEST_RE.exec(line);
  if (req) {
    const route = req[1].split('?')[0];
    return LMSTUDIO_INFERENCE_PATHS.has(route)
      ? { requests: 1, tokens: null, model: null }
      : NO_OBSERVATION;
  }
  const usage = USAGE_RE.exec(line);
  if (!usage) return NO_OBSERVATION;
  const prompt = PROMPT_TOKENS_RE.exec(usage[1]);
  const completion = COMPLETION_TOKENS_RE.exec(usage[1]);
  const total = (prompt ? Number(prompt[1]) : 0) + (completion ? Number(completion[1]) : 0);
  const model = MODEL_FIELD_RE.exec(line);
  return {
    requests: 0,
    tokens: total > 0 ? total : null,
    model: model ? model[1] : null,
  };
}

/** llama-server inference routes. */
export const LLAMACPP_INFERENCE_PATHS: ReadonlySet<string> = new Set([
  '/completion', '/completions', '/v1/completions', '/chat/completions',
  '/v1/chat/completions', '/infill', '/embedding', '/embeddings', '/v1/embeddings',
]);

// srv  log_server_r: request: POST /v1/chat/completions 127.0.0.1 200
const LLAMACPP_REQUEST_RE = /request:\s+(POST|GET)\s+(\/[^\s?]+)\S*\s+\S+\s+(\d{3})/;
// prompt eval time =     123.45 ms /    12 tokens (...)
//        eval time =    1234.56 ms /    34 tokens (...)
//       total time =    1358.01 ms /    46 tokens        ← NOT counted (it is the sum)
const LLAMACPP_TIMING_RE = /^\s*(prompt eval time|eval time)\s*=\s*[\d.]+\s*ms\s*\/\s*(\d+)\s*tokens/;

/**
 * llama.cpp `llama-server` stderr. A `request: POST <route> … 200` line counts
 * one request; the per-request timing lines carry REAL token counts (prompt
 * eval + eval; `total time` is their sum and is skipped so nothing is counted
 * twice).
 */
export function parseLlamaCppServerLogLine(line: string): LocalInferenceObservation {
  const req = LLAMACPP_REQUEST_RE.exec(line);
  if (req) {
    const status = Number(req[3]);
    return req[1] === 'POST' && status >= 200 && status < 300 && LLAMACPP_INFERENCE_PATHS.has(req[2])
      ? { requests: 1, tokens: null, model: null }
      : NO_OBSERVATION;
  }
  const timing = LLAMACPP_TIMING_RE.exec(line);
  if (!timing) return NO_OBSERVATION;
  const n = Number(timing[2]);
  return { requests: 0, tokens: n > 0 ? n : null, model: null };
}

interface JsonlInferenceRecord {
  model?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
}

/**
 * The original opt-in JSONL source (`PROVIAN_LLM_LOG`): one record per
 * inference with `input_tokens` / `output_tokens` / `model`. A record is one
 * request; its tokens are read verbatim.
 */
export function parseJsonlInferenceLine(line: string): LocalInferenceObservation {
  let rec: JsonlInferenceRecord;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NO_OBSERVATION;
    rec = parsed as JsonlInferenceRecord;
  } catch {
    return NO_OBSERVATION;
  }
  const inTok = typeof rec.input_tokens === 'number' && Number.isFinite(rec.input_tokens) ? rec.input_tokens : 0;
  const outTok = typeof rec.output_tokens === 'number' && Number.isFinite(rec.output_tokens) ? rec.output_tokens : 0;
  const tokens = inTok + outTok;
  return {
    requests: 1,
    tokens: tokens > 0 ? tokens : null,
    model: typeof rec.model === 'string' && rec.model.length > 0 ? rec.model : null,
  };
}

export function parserForRuntime(runtime: LocalInferenceRuntime): (line: string) => LocalInferenceObservation {
  switch (runtime) {
    case 'ollama': return parseOllamaServerLogLine;
    case 'lmstudio': return parseLmStudioServerLogLine;
    case 'llamacpp': return parseLlamaCppServerLogLine;
    case 'jsonl': return parseJsonlInferenceLine;
  }
}

// ---------------------------------------------------------------------------
// Loopback-only endpoint resolution
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/**
 * Resolve a runtime's base URL from its env override, REFUSING anything that
 * is not loopback. The probe exists to witness THIS machine; a non-loopback
 * host (a remote Ollama, say) is not local work and is never probed.
 * Returns null for a refused override so the caller falls back to the default.
 */
export function resolveLoopbackBaseUrl(raw: string | undefined, fallback: string): string {
  if (!raw || raw.trim().length === 0) return fallback;
  let candidate = raw.trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = `http://${candidate}`;
  let url: URL;
  try { url = new URL(candidate); } catch { return fallback; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return fallback;
  const host = url.hostname === '0.0.0.0' ? '127.0.0.1' : url.hostname;
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${host}${port}`;
}

// ---------------------------------------------------------------------------
// Install footprint + log path resolution (sync, cheap)
// ---------------------------------------------------------------------------

function exists(p: string): boolean {
  try { fs.statSync(p); return true; } catch { return false; }
}

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) if (c && exists(c)) return c;
  return null;
}

/** Newest regular file under `dir` (one level of month subdirectories allowed). */
function newestFileUnder(dir: string): string | null {
  if (!exists(dir)) return null;
  let best: { p: string; mtime: number } | null = null;
  const visit = (d: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 1) visit(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch { continue; }
      if (best === null || mtime > best.mtime) best = { p, mtime };
    }
  };
  visit(dir, 0);
  return best === null ? null : (best as { p: string; mtime: number }).p;
}

export interface FootprintContext {
  homedir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

function defaultFootprintContext(): FootprintContext {
  return { homedir: os.homedir(), platform: process.platform, env: process.env };
}

export function ollamaFootprint(ctx: FootprintContext): { installed: boolean; logPath: string | null } {
  const home = ctx.homedir;
  const installed = firstExisting([
    path.join(home, '.ollama'),
    '/Applications/Ollama.app',
    '/opt/homebrew/bin/ollama',
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
    path.join(home, 'AppData', 'Local', 'Programs', 'Ollama'),
  ]) !== null;
  const logPath = firstExisting([
    ctx.env.PROVIAN_OLLAMA_LOG ? path.resolve(ctx.env.PROVIAN_OLLAMA_LOG) : '',
    path.join(home, '.ollama', 'logs', 'server.log'),
    '/opt/homebrew/var/log/ollama.log',
    '/usr/local/var/log/ollama.log',
    '/var/log/ollama.log',
    path.join(home, 'AppData', 'Local', 'Ollama', 'server.log'),
  ]);
  return { installed, logPath };
}

export function lmStudioFootprint(ctx: FootprintContext): { installed: boolean; logPath: string | null } {
  const home = ctx.homedir;
  const roots = [
    path.join(home, '.lmstudio'),
    path.join(home, '.cache', 'lm-studio'),
  ];
  const installed = firstExisting([
    ...roots,
    '/Applications/LM Studio.app',
    path.join(home, 'AppData', 'Local', 'Programs', 'LM Studio'),
  ]) !== null;
  let logPath: string | null = null;
  if (ctx.env.PROVIAN_LMSTUDIO_LOG) {
    const p = path.resolve(ctx.env.PROVIAN_LMSTUDIO_LOG);
    logPath = exists(p) ? p : null;
  }
  if (logPath === null) {
    for (const root of roots) {
      logPath = newestFileUnder(path.join(root, 'server-logs'));
      if (logPath !== null) break;
    }
  }
  return { installed, logPath };
}

export function llamaCppFootprint(ctx: FootprintContext): { installed: boolean; logPath: string | null } {
  const installed = firstExisting([
    '/opt/homebrew/bin/llama-server',
    '/usr/local/bin/llama-server',
    '/usr/bin/llama-server',
    path.join(ctx.homedir, '.local', 'bin', 'llama-server'),
  ]) !== null;
  // llama-server logs to stderr; there is no default file. Only an explicit
  // redirect the user names is tailed.
  let logPath: string | null = null;
  if (ctx.env.PROVIAN_LLAMA_SERVER_LOG) {
    const p = path.resolve(ctx.env.PROVIAN_LLAMA_SERVER_LOG);
    logPath = exists(p) ? p : null;
  }
  return { installed, logPath };
}

// ---------------------------------------------------------------------------
// The probe (async, loopback-only, bounded)
// ---------------------------------------------------------------------------

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  /** Per-request timeout. The probe never blocks a tick; it runs off-tick. */
  timeoutMs?: number;
  context?: FootprintContext;
}

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) return null;
    return await res.json() as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stringsAt(obj: unknown, listKey: string, nameKeys: string[]): string[] {
  if (typeof obj !== 'object' || obj === null) return [];
  const list = (obj as Record<string, unknown>)[listKey];
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    for (const k of nameKeys) {
      const v = rec[k];
      if (typeof v === 'string' && v.length > 0) { out.push(v); break; }
    }
  }
  return out;
}

async function probeOllama(fetchImpl: typeof fetch, timeoutMs: number, ctx: FootprintContext): Promise<RuntimeDetection> {
  const baseUrl = resolveLoopbackBaseUrl(ctx.env.OLLAMA_HOST, RUNTIME_DEFAULT_URL.ollama);
  const tags = await getJson(fetchImpl, `${baseUrl}/api/tags`, timeoutMs);
  const reachable = typeof tags === 'object' && tags !== null && Array.isArray((tags as Record<string, unknown>).models);
  let loadedModels: string[] = [];
  if (reachable) {
    const ps = await getJson(fetchImpl, `${baseUrl}/api/ps`, timeoutMs);
    loadedModels = stringsAt(ps, 'models', ['name', 'model']);
  }
  const fp = ollamaFootprint(ctx);
  return { runtime: 'ollama', baseUrl, reachable, installed: fp.installed, loadedModels, logPath: fp.logPath, tokensObservable: false };
}

async function probeLmStudio(fetchImpl: typeof fetch, timeoutMs: number, ctx: FootprintContext): Promise<RuntimeDetection> {
  const baseUrl = resolveLoopbackBaseUrl(ctx.env.PROVIAN_LMSTUDIO_URL, RUNTIME_DEFAULT_URL.lmstudio);
  let reachable = false;
  let loadedModels: string[] = [];
  const v0 = await getJson(fetchImpl, `${baseUrl}/api/v0/models`, timeoutMs);
  if (typeof v0 === 'object' && v0 !== null && Array.isArray((v0 as Record<string, unknown>).data)) {
    reachable = true;
    const data = (v0 as Record<string, unknown>).data as unknown[];
    for (const item of data) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (rec.state === 'loaded' && typeof rec.id === 'string') loadedModels.push(rec.id);
    }
  } else {
    const v1 = await getJson(fetchImpl, `${baseUrl}/v1/models`, timeoutMs);
    if (typeof v1 === 'object' && v1 !== null && Array.isArray((v1 as Record<string, unknown>).data)) {
      reachable = true;
      loadedModels = stringsAt(v1, 'data', ['id']);
    }
  }
  const fp = lmStudioFootprint(ctx);
  return { runtime: 'lmstudio', baseUrl, reachable, installed: fp.installed, loadedModels, logPath: fp.logPath, tokensObservable: true };
}

async function probeLlamaCpp(fetchImpl: typeof fetch, timeoutMs: number, ctx: FootprintContext): Promise<RuntimeDetection> {
  const baseUrl = resolveLoopbackBaseUrl(ctx.env.PROVIAN_LLAMA_SERVER_URL, RUNTIME_DEFAULT_URL.llamacpp);
  const health = await getJson(fetchImpl, `${baseUrl}/health`, timeoutMs);
  const reachable = typeof health === 'object' && health !== null
    && (health as Record<string, unknown>).status === 'ok';
  const loadedModels: string[] = [];
  if (reachable) {
    const props = await getJson(fetchImpl, `${baseUrl}/props`, timeoutMs);
    if (typeof props === 'object' && props !== null) {
      const rec = props as Record<string, unknown>;
      const modelPath = rec.model_path;
      if (typeof modelPath === 'string' && modelPath.length > 0) loadedModels.push(path.basename(modelPath));
      else {
        const dgs = rec.default_generation_settings;
        if (typeof dgs === 'object' && dgs !== null && typeof (dgs as Record<string, unknown>).model === 'string') {
          loadedModels.push(path.basename((dgs as Record<string, unknown>).model as string));
        }
      }
    }
  }
  const fp = llamaCppFootprint(ctx);
  return { runtime: 'llamacpp', baseUrl, reachable, installed: fp.installed, loadedModels, logPath: fp.logPath, tokensObservable: true };
}

/**
 * Detect local inference runtimes. Loopback only, bounded by `timeoutMs` per
 * request (default 750 ms), never throws. Cheap enough to re-run every minute.
 */
export async function probeLocalInferenceRuntimes(options: ProbeOptions = {}): Promise<LocalInferenceProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 750;
  const ctx = options.context ?? defaultFootprintContext();
  const runtimes = await Promise.all([
    probeOllama(fetchImpl, timeoutMs, ctx),
    probeLmStudio(fetchImpl, timeoutMs, ctx),
    probeLlamaCpp(fetchImpl, timeoutMs, ctx),
  ]);
  const jsonl = ctx.env.PROVIAN_LLM_LOG;
  const jsonlLogPath = jsonl && jsonl.trim().length > 0 ? path.resolve(jsonl) : null;
  const detected = jsonlLogPath !== null || runtimes.some((r) => r.reachable || r.installed);
  return { detected, runtimes, jsonlLogPath };
}

/** The empty probe — nothing detected. */
export const NO_LOCAL_INFERENCE: LocalInferenceProbe = Object.freeze({ detected: false, runtimes: [], jsonlLogPath: null });

/** True when a probe found something a daemon can actually WITNESS (a log or a JSONL source). */
export function probeHasWitnessableSource(probe: LocalInferenceProbe): boolean {
  return probe.jsonlLogPath !== null || probe.runtimes.some((r) => r.logPath !== null);
}

/**
 * One human-readable line shared by the daemon startup log, `register-device`,
 * `npx @provian/agent-sdk start`, and `npx @provian/agent-sdk doctor` (single copy source).
 */
export function describeLocalInferenceProbe(probe: LocalInferenceProbe): string {
  const parts: string[] = [];
  for (const r of probe.runtimes) {
    if (!r.reachable && !r.installed) continue;
    const state = r.reachable ? 'running' : 'installed, not running';
    const models = r.loadedModels.length > 0 ? `, models: ${r.loadedModels.slice(0, 4).join(', ')}` : '';
    const log = r.logPath ? `, log: ${r.logPath}` : ', log: not found';
    parts.push(`${r.runtime} (${state} on ${r.baseUrl}${models}${log})`);
  }
  if (probe.jsonlLogPath) parts.push(`jsonl (PROVIAN_LLM_LOG=${probe.jsonlLogPath})`);
  if (parts.length === 0) {
    return 'none detected — Ollama, LM Studio, and llama.cpp llama-server are witnessed automatically when present';
  }
  return parts.join('; ');
}
