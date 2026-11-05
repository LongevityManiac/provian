/**
 * model-proxy/parse — turn a model-API request/response pair into a STRUCTURE-ONLY
 * observation of one model turn. PURE (no I/O, no sockets), so every protocol
 * shape is unit-tested against real payloads with their RED negative controls.
 *
 * THE PRIVACY INVARIANT (do not violate). This module reads ONLY
 * structural fields: model id, response id, tool-call ids + names, tool-call
 * ARGUMENTS (handed straight to the origin-capture allowlist which hashes every
 * private value on device — never stored raw here), and token counts. It NEVER
 * reads, returns, or retains prompt text, completion text, tool-result content,
 * system prompts, or the API key. A `ModelTurnObservation` cannot carry message
 * content: there is no field for it. The sentinel test
 * (`model-proxy-sentinel.test.ts`) feeds a known key + known prompt/completion
 * and asserts neither ever appears in the observation, the PE, a log, or the
 * capture-health payload.
 *
 * TRANSPARENCY. Parsing observes a TEE of the response stream; it never
 * gates, delays, or mutates forwarding. A shape this build does not recognize
 * returns `recognized: false` → the caller fingerprints it and still
 * forwards byte-exact — never a silent witness of nothing, never a broken stream.
 */

import type { ModelProtocol, ModelProvider } from './routing';

/** Token usage read from a model response. Any field null when the response (or
 * a streaming response with usage omitted) does not expose it — never estimated. */
export interface TokenUsage {
  input: number | null;
  output: number | null;
  total: number | null;
}

/** One tool call the model requested this turn. `input` is the parsed arguments
 * object, used ONLY by origin capture (which hashes private values); it is never
 * stored on the PE. `id` is the cross-lane mint-once anchor when present (Gemini
 * function calls carry none → null → the turn uses its per-turn fallback key). */
export interface ObservedToolCall {
  id: string | null;
  name: string;
  input: unknown;
}

/** The STRUCTURAL schema of ONE tool parameter, read from the request's tool
 * DEFINITIONS. Type + format only — NEVER the parameter description or any
 * message/prompt content. Drives generic, harness-free origin
 * classification. */
export interface ParamSchema {
  type?: string;
  format?: string;
}

/** toolName → (paramName → ParamSchema), extracted from a request's tool
 * definitions. Empty when the request carried no tools (or was not observed). */
export type RequestToolSchemas = Map<string, Map<string, ParamSchema>>;

/** A structure-only observation of one completed model turn. */
export interface ModelTurnObservation {
  provider: ModelProvider | null;
  protocol: ModelProtocol;
  model: string | null;
  toolCalls: ObservedToolCall[];
  tokens: TokenUsage | null;
  /** The model response id (Anthropic `msg_…`, OpenAI `chatcmpl-…`/`resp_…`,
   * Gemini `responseId`), used in the per-turn fallback key. Content-free. */
  responseId: string | null;
  streamed: boolean;
  /** false when the response shape was not recognized → fingerprint, still forward. */
  recognized: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/** Parse a JSON string of tool arguments; never throws (returns null on failure).
 * OpenAI streams arguments as a partial JSON string that may be incomplete on a
 * truncated turn — an unparseable value simply yields no origins, never an error. */
function parseArgs(raw: unknown): unknown {
  if (isObj(raw)) return raw; // Anthropic / Gemini already give an object
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function sumUsage(input: number | null, output: number | null, total: number | null): TokenUsage | null {
  if (input == null && output == null && total == null) return null;
  const t = total ?? ((input ?? 0) + (output ?? 0));
  return { input, output, total: Number.isFinite(t) ? t : null };
}

// ============================================================================
// Non-streaming response parsers (one per protocol). Pure over the full JSON.
// ============================================================================

export function parseAnthropicResponseJson(json: unknown): ModelTurnObservation {
  const base = obs('anthropic', 'anthropic_messages', false);
  if (!isObj(json) || json.type !== 'message') return base;
  base.recognized = true;
  base.model = str(json.model);
  base.responseId = str(json.id);
  const content = Array.isArray(json.content) ? json.content : [];
  for (const block of content) {
    if (!isObj(block) || block.type !== 'tool_use') continue;
    base.toolCalls.push({ id: str(block.id), name: str(block.name) ?? 'tool', input: block.input ?? null });
  }
  if (isObj(json.usage)) {
    base.tokens = sumUsage(num(json.usage.input_tokens), num(json.usage.output_tokens), null);
  }
  return base;
}

export function parseOpenAIChatResponseJson(json: unknown): ModelTurnObservation {
  const base = obs('openai', 'openai_chat', false);
  if (!isObj(json) || !Array.isArray(json.choices)) return base;
  base.recognized = true;
  base.model = str(json.model);
  base.responseId = str(json.id);
  for (const choice of json.choices) {
    if (!isObj(choice) || !isObj(choice.message)) continue;
    const calls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
    for (const c of calls) {
      if (!isObj(c)) continue;
      const fn = isObj(c.function) ? c.function : {};
      base.toolCalls.push({ id: str(c.id), name: str(fn.name) ?? 'tool', input: parseArgs(fn.arguments) });
    }
  }
  if (isObj(json.usage)) {
    base.tokens = sumUsage(num(json.usage.prompt_tokens), num(json.usage.completion_tokens), num(json.usage.total_tokens));
  }
  return base;
}

/** OpenAI Responses API (`/v1/responses`): output is a flat array of items;
 * function calls are items with type `function_call` carrying `call_id`+`name`. */
export function parseOpenAIResponsesResponseJson(json: unknown): ModelTurnObservation {
  const base = obs('openai', 'openai_responses', false);
  if (!isObj(json) || (json.object !== 'response' && !Array.isArray(json.output))) return base;
  base.recognized = true;
  base.model = str(json.model);
  base.responseId = str(json.id);
  const output = Array.isArray(json.output) ? json.output : [];
  for (const item of output) {
    if (!isObj(item) || item.type !== 'function_call') continue;
    base.toolCalls.push({
      id: str(item.call_id) ?? str(item.id),
      name: str(item.name) ?? 'tool',
      input: parseArgs(item.arguments),
    });
  }
  if (isObj(json.usage)) {
    base.tokens = sumUsage(num(json.usage.input_tokens), num(json.usage.output_tokens), num(json.usage.total_tokens));
  }
  return base;
}

export function parseGeminiResponseJson(json: unknown): ModelTurnObservation {
  const base = obs('gemini', 'gemini_generate', false);
  // Gemini `:streamGenerateContent` WITHOUT `alt=sse` returns a JSON ARRAY of
  // response objects (content-type application/json, not SSE), whereas
  // `:generateContent` returns a single object. Merge an array here so the
  // buffered (non-SSE) path witnesses BOTH shapes — the SSE shape is handled by
  // StreamingTurnParser.finishGemini. (Deciding streaming from the request body
  // previously forced ALL Gemini to the SSE parser, so a bare `:generateContent`
  // object was never recognized — the defect this branch closes.)
  if (Array.isArray(json)) {
    for (const chunk of json) {
      const parsed = parseGeminiResponseJson(chunk);
      if (!parsed.recognized) continue;
      base.recognized = true;
      base.model ??= parsed.model;
      base.responseId ??= parsed.responseId;
      base.toolCalls.push(...parsed.toolCalls);
      if (parsed.tokens) base.tokens = parsed.tokens; // last chunk carries cumulative usage
    }
    return base;
  }
  if (!isObj(json) || !Array.isArray(json.candidates)) return base;
  base.recognized = true;
  base.model = str(json.modelVersion);
  base.responseId = str(json.responseId);
  for (const cand of json.candidates) {
    if (!isObj(cand) || !isObj(cand.content)) continue;
    const parts = Array.isArray(cand.content.parts) ? cand.content.parts : [];
    for (const p of parts) {
      if (!isObj(p) || !isObj(p.functionCall)) continue;
      // Gemini function calls carry NO id — the turn falls back to its per-turn key.
      base.toolCalls.push({ id: str(p.functionCall.id), name: str(p.functionCall.name) ?? 'tool', input: p.functionCall.args ?? null });
    }
  }
  if (isObj(json.usageMetadata)) {
    base.tokens = sumUsage(
      num(json.usageMetadata.promptTokenCount),
      num(json.usageMetadata.candidatesTokenCount),
      num(json.usageMetadata.totalTokenCount),
    );
  }
  return base;
}

function obs(provider: ModelProvider, protocol: ModelProtocol, streamed: boolean): ModelTurnObservation {
  return { provider, protocol, model: null, toolCalls: [], tokens: null, responseId: null, streamed, recognized: false };
}

/** Dispatch a NON-streaming JSON body to the right parser. `unknown` protocol →
 * an unrecognized observation (fingerprint, still forward). */
export function parseResponseJson(protocol: ModelProtocol, json: unknown): ModelTurnObservation {
  switch (protocol) {
    case 'anthropic_messages': return parseAnthropicResponseJson(json);
    case 'openai_chat': return parseOpenAIChatResponseJson(json);
    case 'openai_responses': return parseOpenAIResponsesResponseJson(json);
    case 'openai_embeddings': return parseOpenAIEmbeddingsJson(json);
    case 'openai_completions': return parseOpenAIChatResponseJson(json); // legacy shares usage/id shape
    case 'gemini_generate': return parseGeminiResponseJson(json);
    default: return obs('anthropic' as ModelProvider, 'unknown', false);
  }
}

/**
 * Extract the tool DEFINITIONS from a model-API REQUEST body, as a
 * `RequestToolSchemas` (toolName → paramName → {type, format}). Reads ONLY the
 * request's `tools` array — never `messages`, `system`, `contents`, or a
 * parameter's free-text `description` (structure only, no content).
 * Shape-driven so it covers every provider without a protocol switch:
 * - OpenAI chat: tools[].function.{name, parameters}
 * - Anthropic: tools[].{name, input_schema}
 * - OpenAI responses: tools[].{name, parameters}
 * - Gemini: tools[].functionDeclarations[].{name, parameters}
 * A JSON Schema's `properties` give per-parameter `type`/`format`; a parameter
 * with no schema is still recorded (empty ParamSchema) so name-based
 * classification can run. Never throws.
 */
export function parseRequestToolSchemas(json: unknown): RequestToolSchemas {
  const out: RequestToolSchemas = new Map();
  if (!isObj(json) || !Array.isArray(json.tools)) return out;
  const add = (name: unknown, schema: unknown): void => {
    const n = str(name);
    if (!n) return;
    out.set(n, paramSchemasOf(schema));
  };
  for (const t of json.tools) {
    if (!isObj(t)) continue;
    if (isObj(t.function)) { add(t.function.name, t.function.parameters); continue; } // OpenAI chat
    if (Array.isArray(t.functionDeclarations)) { // Gemini
      for (const fd of t.functionDeclarations) if (isObj(fd)) add(fd.name, fd.parameters);
      continue;
    }
    if (str(t.name)) add(t.name, t.input_schema ?? t.parameters); // Anthropic / OpenAI responses
  }
  return out;
}

/** Pull `{type, format}` for each declared property of a JSON Schema object.
 * Ignores `description` and every other keyword (structure only). */
function paramSchemasOf(schema: unknown): Map<string, ParamSchema> {
  const out = new Map<string, ParamSchema>();
  if (!isObj(schema) || !isObj(schema.properties)) return out;
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!isObj(prop)) { out.set(key, {}); continue; }
    out.set(key, {
      type: typeof prop.type === 'string' ? prop.type : undefined,
      format: typeof prop.format === 'string' ? prop.format : undefined,
    });
  }
  return out;
}

/** Embeddings: a model turn with tokens but never a tool call. */
export function parseOpenAIEmbeddingsJson(json: unknown): ModelTurnObservation {
  const base = obs('openai', 'openai_embeddings', false);
  if (!isObj(json) || json.object !== 'list') return base;
  base.recognized = true;
  base.model = str(json.model);
  if (isObj(json.usage)) base.tokens = sumUsage(num(json.usage.prompt_tokens), null, num(json.usage.total_tokens));
  return base;
}

// ============================================================================
// Streaming (SSE) accumulator. Feeds raw response chunks; observes structure
// only; produces the same ModelTurnObservation at finish(). Never buffers the
// stream for the client — the caller forwards each chunk immediately and hands a
// COPY here.
// ============================================================================

interface ToolAccum { id: string | null; name: string; argsJson: string; argsObj: unknown }

/**
 * Incremental SSE parser for one streamed model turn. `push(chunk)` feeds raw
 * response bytes (a copy of what is being forwarded); `finish()` returns the
 * observation. Content-free throughout: only ids, names, argument JSON (for
 * origin capture), model, and usage are pulled from events.
 */
export class StreamingTurnParser {
  private buf = '';
  private readonly byIndex = new Map<number, ToolAccum>();
  private order: number[] = [];
  private model: string | null = null;
  private responseId: string | null = null;
  private inTok: number | null = null;
  private outTok: number | null = null;
  private totalTok: number | null = null;
  private sawAny = false;
  // Gemini streams a JSON array or SSE of full response objects, not deltas.
  private geminiText = '';

  constructor(private readonly protocol: ModelProtocol) {}

  push(chunk: Buffer | string): void {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (this.protocol === 'gemini_generate') { this.geminiText += s; this.sawAny = true; return; }
    this.buf += s;
    // SSE events are separated by a blank line; process complete events only.
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const rawEvent = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.handleEvent(rawEvent);
    }
  }

  private handleEvent(rawEvent: string): void {
    // Collect the data payload (one or more `data:` lines per SSE event).
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('data:')) dataLines.push(t.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') return;
    let json: unknown;
    try { json = JSON.parse(payload); } catch { return; }
    this.sawAny = true;
    if (this.protocol === 'anthropic_messages') this.reduceAnthropic(json);
    else this.reduceOpenAI(json); // chat, responses, completions
  }

  private reduceAnthropic(json: unknown): void {
    if (!isObj(json)) return;
    switch (json.type) {
      case 'message_start': {
        const m = isObj(json.message) ? json.message : {};
        this.model ??= str(m.model);
        this.responseId ??= str(m.id);
        if (isObj(m.usage)) this.inTok = num(m.usage.input_tokens) ?? this.inTok;
        break;
      }
      case 'content_block_start': {
        const idx = num(json.index) ?? this.order.length;
        const block = isObj(json.content_block) ? json.content_block : {};
        if (block.type === 'tool_use') {
          this.ensure(idx, { id: str(block.id), name: str(block.name) ?? 'tool', argsJson: '', argsObj: null });
        }
        break;
      }
      case 'content_block_delta': {
        const idx = num(json.index);
        const delta = isObj(json.delta) ? json.delta : {};
        if (idx != null && delta.type === 'input_json_delta') {
          const acc = this.byIndex.get(idx);
          if (acc) acc.argsJson += str(delta.partial_json) ?? '';
        }
        break;
      }
      case 'message_delta': {
        if (isObj(json.usage)) this.outTok = num(json.usage.output_tokens) ?? this.outTok;
        break;
      }
      default: break;
    }
  }

  private reduceOpenAI(json: unknown): void {
    if (!isObj(json)) return;
    // Responses API events carry a `type` string; Chat chunks carry `choices`.
    if (typeof json.type === 'string') { this.reduceOpenAIResponses(json); return; }
    this.model ??= str(json.model);
    this.responseId ??= str(json.id);
    if (isObj(json.usage)) {
      this.inTok = num(json.usage.prompt_tokens) ?? this.inTok;
      this.outTok = num(json.usage.completion_tokens) ?? this.outTok;
      this.totalTok = num(json.usage.total_tokens) ?? this.totalTok;
    }
    const choices = Array.isArray(json.choices) ? json.choices : [];
    for (const ch of choices) {
      if (!isObj(ch) || !isObj(ch.delta)) continue;
      const calls = Array.isArray(ch.delta.tool_calls) ? ch.delta.tool_calls : [];
      for (const c of calls) {
        if (!isObj(c)) continue;
        const idx = num(c.index) ?? this.order.length;
        const fn = isObj(c.function) ? c.function : {};
        const acc = this.ensure(idx, { id: null, name: 'tool', argsJson: '', argsObj: null });
        if (str(c.id)) acc.id = str(c.id);
        if (str(fn.name)) acc.name = str(fn.name)!;
        if (typeof fn.arguments === 'string') acc.argsJson += fn.arguments;
      }
    }
  }

  private reduceOpenAIResponses(json: Record<string, unknown>): void {
    const type = json.type as string;
    if (type === 'response.created' || type === 'response.completed' || type === 'response.in_progress') {
      const r = isObj(json.response) ? json.response : {};
      this.model ??= str(r.model);
      this.responseId ??= str(r.id);
      if (isObj(r.usage)) {
        this.inTok = num(r.usage.input_tokens) ?? this.inTok;
        this.outTok = num(r.usage.output_tokens) ?? this.outTok;
        this.totalTok = num(r.usage.total_tokens) ?? this.totalTok;
      }
      return;
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = isObj(json.item) ? json.item : {};
      if (item.type === 'function_call') {
        const idx = num(json.output_index) ?? this.order.length;
        this.ensure(idx, {
          id: str(item.call_id) ?? str(item.id),
          name: str(item.name) ?? 'tool',
          argsJson: typeof item.arguments === 'string' ? item.arguments : '',
          argsObj: null,
        });
      }
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const idx = num(json.output_index);
      if (idx != null) {
        const acc = this.byIndex.get(idx);
        if (acc) acc.argsJson += str(json.delta) ?? '';
      }
    }
  }

  private ensure(idx: number, init: ToolAccum): ToolAccum {
    let acc = this.byIndex.get(idx);
    if (!acc) { acc = { ...init }; this.byIndex.set(idx, acc); this.order.push(idx); }
    return acc;
  }

  /** Finalize. For Gemini, parse the accumulated JSON (array or SSE). */
  finish(): ModelTurnObservation {
    if (this.protocol === 'gemini_generate') return this.finishGemini();
    const base = obs(providerFor(this.protocol), this.protocol, true);
    base.recognized = this.sawAny;
    base.model = this.model;
    base.responseId = this.responseId;
    for (const idx of this.order) {
      const acc = this.byIndex.get(idx)!;
      base.toolCalls.push({ id: acc.id, name: acc.name, input: parseArgs(acc.argsJson || acc.argsObj) });
    }
    base.tokens = sumUsage(this.inTok, this.outTok, this.totalTok);
    return base;
  }

  private finishGemini(): ModelTurnObservation {
    const base = obs('gemini', 'gemini_generate', true);
    // Gemini stream is either SSE (`data: {…}` per chunk) or a JSON array of
    // response objects. Merge tool calls + last usage across chunks.
    const chunks: unknown[] = [];
    const text = this.geminiText.trim();
    if (text.startsWith('[')) {
      try { const arr = JSON.parse(text); if (Array.isArray(arr)) chunks.push(...arr); } catch { /* fall through */ }
    }
    if (chunks.length === 0) {
      for (const line of text.split('\n')) {
        const t = line.trimStart();
        if (!t.startsWith('data:')) continue;
        try { chunks.push(JSON.parse(t.slice(5).trim())); } catch { /* skip */ }
      }
    }
    for (const c of chunks) {
      const parsed = parseGeminiResponseJson(c);
      if (!parsed.recognized) continue;
      base.recognized = true;
      base.model ??= parsed.model;
      base.responseId ??= parsed.responseId;
      base.toolCalls.push(...parsed.toolCalls);
      if (parsed.tokens) base.tokens = parsed.tokens; // last chunk carries the cumulative usage
    }
    return base;
  }
}

function providerFor(protocol: ModelProtocol): ModelProvider {
  if (protocol === 'anthropic_messages') return 'anthropic';
  if (protocol === 'gemini_generate') return 'gemini';
  return 'openai';
}
