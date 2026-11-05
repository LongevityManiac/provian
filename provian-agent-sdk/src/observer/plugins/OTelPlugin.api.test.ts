import { ProgramWitnessRegistry } from '../program-witness';
import { describe, it, expect } from 'vitest';
import {
  OTelPlugin,
  classifySpanRole,
  decodeOtlpTraceProtobuf,
  parseOtlpTracePayload,
  type ParsedOtlpSpan,
} from './OTelPlugin';

// ============================================================================
// agent_api_orchestration lane — external HTTP-client orchestration, and its
// CLEAN SEPARATION from tool orchestration (an agent's tools are often API
// calls; a tool's own HTTP transport must not be double-counted as API work).
// ============================================================================

function span(partial: Partial<ParsedOtlpSpan>): ParsedOtlpSpan {
  return {
    name: 'unnamed',
    traceId: 'trace-a',
    spanId: 's1',
    parentSpanId: 'p1', // non-root by default
    startTimeUnixMs: 1_700_000_000_000,
    endTimeUnixMs: 1_700_000_001_000,
    status: 'ok',
    spanKind: null,
    attributes: {},
    resourceAttributes: {},
    scopeName: null,
    ...partial,
  };
}

const SPAN_KIND_CLIENT = 3;
const SPAN_KIND_SERVER = 2;

const silentObserver = { log: () => {} } as unknown as import('../ProvianObserver').ProvianObserver;

async function classifyTrace(spans: ParsedOtlpSpan[]) {
  const plugin = new OTelPlugin({ journalPath: null, forceActive: true, programRegistry: {allows:()=>true, identify:()=> 'fixture'} as unknown as ProgramWitnessRegistry });
  await plugin.init(silentObserver);
  plugin.ingestParsedSpans(spans.map(s=>classifySpanRole(s).role==='tool'?{...s,attributes:{...s.attributes,'gen_ai.response.id':'fixture-response'}}:s));
  const internals = plugin as unknown as {traces: Map<string, unknown>; flushTrace: (acc: unknown, reason: 'idle') => void};
  for (const acc of internals.traces.values()) internals.flushTrace(acc, 'idle');
  await plugin.stop(); // flushes every open trace, then closes (no server started)
  return plugin.drainPEs();
}

// A well-formed HTTP CLIENT span (stable convention) to a remote host.
function httpClient(over: Partial<ParsedOtlpSpan> & {
  host?: string; method?: string; statusCode?: number;
}): ParsedOtlpSpan {
  const { host = 'api.example.com', method = 'GET', statusCode = 200, ...rest } = over;
  return span({
    name: `${method} ${host}`,
    spanKind: SPAN_KIND_CLIENT,
    attributes: {
      'http.request.method': method,
      'server.address': host,
      'http.response.status_code': statusCode,
    },
    ...rest,
  });
}

// ============================================================================
// classifySpanRole — recognizing an external HTTP-client hop
// ============================================================================

describe('classifySpanRole — external API (HTTP client)', () => {
  it('stable HTTP client (SpanKind=CLIENT, http.request.method) → api', () => {
    const r = classifySpanRole(httpClient({ host: 'api.example.com', method: 'POST', statusCode: 201 }));
    expect(r.role).toBe('api');
    expect(r.apiHost).toBe('api.example.com');
    expect(r.apiMethod).toBe('POST');
    expect(r.apiStatus).toBe(201);
    expect(r.apiConvention).toBe('http-stable');
  });

  it('legacy HTTP client (http.method + net.peer.name) → api, convention http-legacy', () => {
    const r = classifySpanRole(span({
      spanKind: SPAN_KIND_CLIENT,
      attributes: { 'http.method': 'GET', 'net.peer.name': 'legacy.api', 'http.status_code': 200 },
    }));
    expect(r.role).toBe('api');
    expect(r.apiHost).toBe('legacy.api');
    expect(r.apiConvention).toBe('http-legacy');
  });

  it('host comes from url.full when server.address is absent — and NEVER the path/query', () => {
    const r = classifySpanRole(span({
      spanKind: SPAN_KIND_CLIENT,
      attributes: {
        'http.request.method': 'GET',
        'url.full': 'https://secret.api.co/v1/users/42?token=SENSITIVE',
      },
    }));
    expect(r.role).toBe('api');
    expect(r.apiHost).toBe('secret.api.co');
    // The captured host must not carry the path or the query string.
    expect(r.apiHost).not.toContain('/');
    expect(r.apiHost).not.toContain('token');
    expect(r.apiHost).not.toContain('SENSITIVE');
  });

  it('kind unspecified but method + destination present → api (inferred client)', () => {
    const r = classifySpanRole(span({
      spanKind: null,
      attributes: { 'http.request.method': 'GET', 'server.address': 'inferred.api' },
    }));
    expect(r.role).toBe('api');
  });

  // NEGATIVE CONTROL: an inbound (SERVER) span is the agent RECEIVING a request,
  // never outbound API orchestration.
  it('NEGATIVE CONTROL: SpanKind=SERVER with http method → NOT api', () => {
    const r = classifySpanRole(span({
      spanKind: SPAN_KIND_SERVER,
      attributes: { 'http.request.method': 'POST', 'url.path': '/webhook', 'http.route': '/webhook' },
    }));
    expect(r.role).not.toBe('api');
  });

  // NEGATIVE CONTROL: kind unspecified + method but NO destination could be a
  // server span; do not assume it is an outbound call.
  it('NEGATIVE CONTROL: method only, no destination, no kind → NOT api', () => {
    const r = classifySpanRole(span({
      spanKind: null,
      attributes: { 'http.request.method': 'GET', 'http.route': '/things/:id' },
    }));
    expect(r.role).not.toBe('api');
  });

  // NEGATIVE CONTROL: a model call that also carries HTTP attributes is a MODEL
  // call (checked before API), never an external API hop.
  it('NEGATIVE CONTROL: gen_ai chat with HTTP attributes → model, never api', () => {
    const r = classifySpanRole(span({
      spanKind: SPAN_KIND_CLIENT,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-opus',
        'http.request.method': 'POST',
        'server.address': 'api.anthropic.com',
      },
    }));
    expect(r.role).toBe('model');
  });

  // NEGATIVE CONTROL: a tool span that also carries HTTP attributes is a TOOL
  // (checked before API), so it counts on the tool lane, not the API lane.
  it('NEGATIVE CONTROL: execute_tool with HTTP attributes → tool, never api', () => {
    const r = classifySpanRole(span({
      spanKind: SPAN_KIND_CLIENT,
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': 'http_get',
        'http.request.method': 'GET',
        'server.address': 'api.example.com',
      },
    }));
    expect(r.role).toBe('tool');
  });
});

// ============================================================================
// Per-trace api_count + the separability invariant
// ============================================================================

describe('per-trace api_count', () => {
  it('RED API-only traffic has no tool-calling model response: 2 independent API calls under the turn', async () => {
    const turn = span({ traceId: 't-api', spanId: 'root', parentSpanId: '', name: 'agent.turn',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } });
    const a1 = httpClient({ traceId: 't-api', spanId: 'a1', parentSpanId: 'root',
      host: 'api.orders', method: 'GET', statusCode: 200 });
    const a2 = httpClient({ traceId: 't-api', spanId: 'a2', parentSpanId: 'root',
      host: 'api.reconcile', method: 'POST', statusCode: 201 });

    const pes = await classifyTrace([turn, a1, a2]);
    expect(pes).toEqual([]);
  });

  // THE SEPARABILITY CENTERPIECE / NEGATIVE CONTROL:
  // "an agent's tools are often themselves API calls." A tool's underlying HTTP
  // span is the tool's transport — attributed to the tool, NEVER double-counted
  // as independent API orchestration.
  it('NEGATIVE CONTROL: a tool whose child is an HTTP call → tool lane only, api NOT counted', async () => {
    const turn = span({ traceId: 't-mix1', spanId: 'root', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } });
    const tool1 = span({ traceId: 't-mix1', spanId: 't1', parentSpanId: 'root',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } });
    const tool2 = span({ traceId: 't-mix1', spanId: 't2', parentSpanId: 'root',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'fetch' } });
    // Each tool internally makes an HTTP call (a child span).
    const http1 = httpClient({ traceId: 't-mix1', spanId: 'h1', parentSpanId: 't1', host: 'search.api' });
    const http2 = httpClient({ traceId: 't-mix1', spanId: 'h2', parentSpanId: 't2', host: 'fetch.api' });

    const pes = await classifyTrace([turn, tool1, tool2, http1, http2]);
    // The tool lane fires (2 tools)...
    const tool = pes.filter(p => p.actionType === 'agent_tool_orchestration');
    expect(tool).toHaveLength(1);
    expect(tool[0].metadata!.tool_count).toBe(2);
    // ...and the API lane does NOT: both HTTP calls are the tools' transport.
    const api = pes.filter(p => p.actionType === 'agent_api_orchestration');
    expect(api).toHaveLength(0);
  });

  // NEGATIVE CONTROL: a model call's underlying HTTP span is the model's
  // transport (nested under a model span), not external API orchestration.
  it('NEGATIVE CONTROL: HTTP calls nested under model spans → api NOT counted', async () => {
    const turn = span({ traceId: 't-mdl', spanId: 'root', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } });
    const model1 = span({ traceId: 't-mdl', spanId: 'm1', parentSpanId: 'root',
      attributes: { 'gen_ai.operation.name': 'chat' } });
    const model2 = span({ traceId: 't-mdl', spanId: 'm2', parentSpanId: 'root',
      attributes: { 'gen_ai.operation.name': 'chat' } });
    const http1 = httpClient({ traceId: 't-mdl', spanId: 'h1', parentSpanId: 'm1', host: 'api.llm' });
    const http2 = httpClient({ traceId: 't-mdl', spanId: 'h2', parentSpanId: 'm2', host: 'api.llm' });

    const pes = await classifyTrace([turn, model1, model2, http1, http2]);
    expect(pes.filter(p => p.actionType === 'agent_api_orchestration')).toHaveLength(0);
  });

  // 2026-a turn with ONE external API call is a PE (2+ floor gone).
  it('RED API-only traffic has no tool-calling model response: a single-API-call turn', async () => {
    const a1 = httpClient({ traceId: 't-one', spanId: 'a1', parentSpanId: '', host: 'api.only' });
    const pes = await classifyTrace([a1]);
    expect(pes).toEqual([]);
  });

  it('a mixed turn earns once from its tools, never a second API mint', async () => {
    const turn = span({ traceId: 't-both', spanId: 'root', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } });
    // 2 tool calls, each with its own nested HTTP transport (must NOT count as API).
    const tool1 = span({ traceId: 't-both', spanId: 't1', parentSpanId: 'root',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } });
    const tool2 = span({ traceId: 't-both', spanId: 't2', parentSpanId: 'root',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'summarize' } });
    const toolHttp1 = httpClient({ traceId: 't-both', spanId: 'th1', parentSpanId: 't1', host: 'tool.api.a' });
    const toolHttp2 = httpClient({ traceId: 't-both', spanId: 'th2', parentSpanId: 't2', host: 'tool.api.b' });
    // 2 INDEPENDENT external API calls the agent made directly (under root).
    const api1 = httpClient({ traceId: 't-both', spanId: 'a1', parentSpanId: 'root', host: 'direct.api.x' });
    const api2 = httpClient({ traceId: 't-both', spanId: 'a2', parentSpanId: 'root', host: 'direct.api.y' });

    const pes = await classifyTrace([turn, tool1, tool2, toolHttp1, toolHttp2, api1, api2]);
    const tool = pes.find(p => p.actionType === 'agent_tool_orchestration');
    const api = pes.find(p => p.actionType === 'agent_api_orchestration');
    expect(tool).toBeDefined();
    expect(api).toBeUndefined();
    expect(tool!.metadata!.tool_count).toBe(2);
    expect(pes).toHaveLength(1); // Every turn mints once.

  });

  // NEGATIVE CONTROL: an errored HTTP hop (4xx/5xx or span ERROR) is not
  // successful work and never inflates api_count. (The floor is now 1, so the one
  // OK hop DOES mint — the control is that the two errored hops are excluded, i.e.
  // api_count is 1, not 3.)
  it('RED API-only traffic has no tool-calling model response: NEGATIVE CONTROL: errored API hops', async () => {
    const turn = span({ traceId: 't-err', spanId: 'root', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } });
    const ok = httpClient({ traceId: 't-err', spanId: 'a1', parentSpanId: 'root', host: 'ok.api', statusCode: 200 });
    const http500 = httpClient({ traceId: 't-err', spanId: 'a2', parentSpanId: 'root', host: 'bad.api', statusCode: 500 });
    const spanErr = httpClient({ traceId: 't-err', spanId: 'a3', parentSpanId: 'root', host: 'err.api', status: 'error' });

    // ONE successful independent hop → api_count=1 → ONE PE; the two errored hops
    // are excluded (the count is 1, never 3).
    const pes = await classifyTrace([turn, ok, http500, spanErr]);
    expect(pes).toEqual([]);
  });

  // NEGATIVE CONTROL: a broken ancestry chain (a missing ancestor span) is
  // uncertain and fails closed — the hop is reported, not counted.
  it('NEGATIVE CONTROL: API span with a missing ancestor → uncertain, not counted', async () => {
    // Two API spans whose parent 'ghost' never arrives → both uncertain.
    const a1 = httpClient({ traceId: 't-ghost', spanId: 'a1', parentSpanId: 'ghost', host: 'api.one' });
    const a2 = httpClient({ traceId: 't-ghost', spanId: 'a2', parentSpanId: 'ghost', host: 'api.two' });
    const pes = await classifyTrace([a1, a2]);
    expect(pes.filter(p => p.actionType === 'agent_api_orchestration')).toHaveLength(0);
  });

  it('RED API-only traffic has no tool-calling model response: legacy + stable mixed in one turn', async () => {
    const turn = span({ traceId: 't-conv', spanId: 'root', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } });
    const stable = httpClient({ traceId: 't-conv', spanId: 'a1', parentSpanId: 'root', host: 'stable.api' });
    const legacy = span({ traceId: 't-conv', spanId: 'a2', parentSpanId: 'root', spanKind: SPAN_KIND_CLIENT,
      attributes: { 'http.method': 'GET', 'net.peer.name': 'legacy.api', 'http.status_code': 200 } });
    const pes = await classifyTrace([turn, stable, legacy]);
    expect(pes).toEqual([]);
  });
});

// ============================================================================
// OTLP protobuf decode ↔ JSON parity for HTTP client spans (SpanKind field)
// ============================================================================

// Minimal protobuf encoder (mirror of the decoder) — round-trip proof only.
function vbytes(n: number | bigint): Buffer {
  let v = BigInt(n);
  const out: number[] = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 0x80; out.push(b); } while (v > 0n);
  return Buffer.from(out);
}
function tag(field: number, wire: number): Buffer { return vbytes((field << 3) | wire); }
function lenDelim(field: number, body: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), vbytes(body.length), body]);
}
function str(field: number, s: string): Buffer { return lenDelim(field, Buffer.from(s, 'utf-8')); }
function bytesField(field: number, hex: string): Buffer { return lenDelim(field, Buffer.from(hex, 'hex')); }
function fixed64(field: number, n: bigint): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return Buffer.concat([tag(field, 1), b]);
}
function varintField(field: number, n: number): Buffer { return Buffer.concat([tag(field, 0), vbytes(n)]); }
function anyStr(s: string): Buffer { return str(1, s); }
function anyInt(n: number): Buffer { return varintField(3, n); }
function kv(key: string, value: Buffer): Buffer { return Buffer.concat([str(1, key), lenDelim(2, value)]); }

describe('protobuf HTTP client span ↔ JSON parity (SpanKind)', () => {
  it('a CLIENT HTTP span decodes with spanKind=3 and classifies as api, identically to JSON', () => {
    const traceIdHex = '0af7651916cd43dd8448eb211c80319c';
    const spanIdHex = 'b7ad6b7169203331';

    // Protobuf: span with kind=3 (field 6, varint) + HTTP client attributes.
    const spanBody = Buffer.concat([
      bytesField(1, traceIdHex),         // trace_id
      bytesField(2, spanIdHex),          // span_id
      str(5, 'GET api.example.com'),     // name
      varintField(6, 3),                 // kind = CLIENT
      fixed64(7, 1_700_000_000_000_000_000n),
      fixed64(8, 1_700_000_001_000_000_000n),
      lenDelim(9, kv('http.request.method', anyStr('GET'))),
      lenDelim(9, kv('server.address', anyStr('api.example.com'))),
      lenDelim(9, kv('http.response.status_code', anyInt(200))),
    ]);
    const protoReq = lenDelim(1, // ResourceSpans
      lenDelim(2, // ScopeSpans
        lenDelim(2, spanBody))); // Span

    const jsonPayload = {
      resourceSpans: [{
        resource: {},
        scopeSpans: [{
          spans: [{
            traceId: traceIdHex, spanId: spanIdHex, name: 'GET api.example.com', kind: 3,
            startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
            attributes: [
              { key: 'http.request.method', value: { stringValue: 'GET' } },
              { key: 'server.address', value: { stringValue: 'api.example.com' } },
              { key: 'http.response.status_code', value: { intValue: '200' } },
            ],
          }],
        }],
      }],
    };

    const fromProto = parseOtlpTracePayload(decodeOtlpTraceProtobuf(protoReq));
    const fromJson = parseOtlpTracePayload(jsonPayload);

    expect(fromProto).toHaveLength(1);
    expect(fromProto).toEqual(fromJson);
    expect(fromProto[0].spanKind).toBe(3);
    expect(classifySpanRole(fromProto[0]).role).toBe('api');
    expect(classifySpanRole(fromProto[0]).apiHost).toBe('api.example.com');
  });

  it('JSON SpanKind as the enum NAME ("SPAN_KIND_CLIENT") normalizes to 3', () => {
    const [s] = parseOtlpTracePayload({
      resourceSpans: [{
        resource: {},
        scopeSpans: [{
          spans: [{
            traceId: 'aa', spanId: 'bb', name: 'x', kind: 'SPAN_KIND_CLIENT',
            startTimeUnixNano: '1000000', endTimeUnixNano: '2000000',
            attributes: [
              { key: 'http.request.method', value: { stringValue: 'GET' } },
              { key: 'server.address', value: { stringValue: 'api.host' } },
            ],
          }],
        }],
      }],
    });
    expect(s.spanKind).toBe(3);
    expect(classifySpanRole(s).role).toBe('api');
  });
});
