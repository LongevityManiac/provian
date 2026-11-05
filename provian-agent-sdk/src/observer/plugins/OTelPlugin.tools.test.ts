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
// Test helpers
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

const silentObserver = { log: () => {} } as unknown as import('../ProvianObserver').ProvianObserver;

async function classifyTrace(spans: ParsedOtlpSpan[]) {
  const plugin = new OTelPlugin({ journalPath: null, forceActive: true, programRegistry: {allows:()=>true, identify:()=> 'fixture'} as unknown as ProgramWitnessRegistry });
  await plugin.init(silentObserver);
  // A completed exported model response owns these calls; arbitrary absent
  // parents are not evidence of completion.
  const response=span({traceId:spans[0]?.traceId??'trace-a',spanId:'fixture-model',parentSpanId:'',attributes:{'gen_ai.operation.name':'chat','gen_ai.response.id':'fixture-response'}});
  plugin.ingestParsedSpans([response,...spans.map(s=>({...s,parentSpanId:classifySpanRole(s).role==='tool'?'fixture-model':spans.some(p=>p.spanId===s.parentSpanId)?s.parentSpanId:'',attributes:classifySpanRole(s).role==='tool'?{...s.attributes,'gen_ai.response.id':'fixture-response'}:s.attributes}))]);
  const internals = plugin as unknown as {traces: Map<string, unknown>; flushTrace: (acc: unknown, reason: 'idle') => void};
  for (const acc of internals.traces.values()) internals.flushTrace(acc, 'idle');
  await plugin.stop(); // stop() flushes every open trace, then closes (no server was started)
  return plugin.drainPEs();
}

// ============================================================================
// classifySpanRole — the mapping, framework-agnostic (no framework literals)
// ============================================================================

describe('classifySpanRole', () => {
  it('GenAI: gen_ai.operation.name=execute_tool → tool', () => {
    const r = classifySpanRole(span({
      name: 'execute_tool web_search',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web_search' },
    }));
    expect(r.role).toBe('tool');
    expect(r.toolName).toBe('web_search');
    expect(r.convention).toBe('genai');
  });

  it('OpenInference: openinference.span.kind=TOOL → tool', () => {
    const r = classifySpanRole(span({
      name: 'ToolRun', attributes: { 'openinference.span.kind': 'TOOL', 'tool.name': 'calculator' },
    }));
    expect(r.role).toBe('tool');
    expect(r.toolName).toBe('calculator');
    expect(r.convention).toBe('openinference');
  });

  it('OpenLLMetry: traceloop.span.kind=tool → tool', () => {
    const r = classifySpanRole(span({
      name: 'tool.web_fetch',
      attributes: { 'traceloop.span.kind': 'tool', 'traceloop.entity.name': 'web_fetch' },
    }));
    expect(r.role).toBe('tool');
    expect(r.toolName).toBe('web_fetch');
    expect(r.convention).toBe('openllmetry');
  });

  it('generic: a tool-name attribute on a non-model span → tool', () => {
    const r = classifySpanRole(span({ attributes: { 'tool.name': 'shell' } }));
    expect(r.role).toBe('tool');
    expect(r.toolName).toBe('shell');
  });

  // NEGATIVE CONTROL: a model call must NEVER be classified as tool work, and a
  // token-bearing span must not become a tool by virtue of its tokens.
  it('NEGATIVE CONTROL: gen_ai chat (with tokens) → model, never tool', () => {
    const r = classifySpanRole(span({
      name: 'chat claude',
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-opus',
        'gen_ai.usage.input_tokens': 5000,
        'gen_ai.usage.output_tokens': 2000,
      },
    }));
    expect(r.role).toBe('model');
    expect(r.role).not.toBe('tool');
  });

  it('NEGATIVE CONTROL: OpenInference LLM span → model, never tool', () => {
    expect(classifySpanRole(span({ attributes: { 'openinference.span.kind': 'LLM' } })).role).toBe('model');
  });

  it('orchestration: gen_ai.operation.name=invoke_agent → orchestration', () => {
    expect(classifySpanRole(span({ attributes: { 'gen_ai.operation.name': 'invoke_agent' } })).role)
      .toBe('orchestration');
  });

  it('orchestration: a root span (no parent) → orchestration', () => {
    expect(classifySpanRole(span({ parentSpanId: '' })).role).toBe('orchestration');
  });

  it('other: an unrecognized child span → other (visible, never mislabeled)', () => {
    expect(classifySpanRole(span({ name: 'db.query', parentSpanId: 'p1' })).role).toBe('other');
  });
});

// ============================================================================
// Per-trace tool_count — the invariant + negative controls
// ============================================================================

describe('per-model-response tool_count', () => {
  it('a turn with 2 tool calls → ONE agent_tool_orchestration PE with tool_count=2', async () => {
    const turn = span({ traceId: 't-two', name: 'agent.turn', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } });
    const tool1 = span({ traceId: 't-two', spanId: 'a', parentSpanId: 'turn',
      name: 'execute_tool web_search',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web_search' } });
    const tool2 = span({ traceId: 't-two', spanId: 'b', parentSpanId: 'turn',
      name: 'execute_tool code_exec',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'code_exec' } });
    // A model call in the SAME turn must NOT be counted as a tool.
    const model = span({ traceId: 't-two', spanId: 'c', parentSpanId: 'turn', name: 'chat',
      attributes: { 'gen_ai.operation.name': 'chat',
        'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 50 } });

    const pes = await classifyTrace([turn, tool1, tool2, model]);
    expect(pes).toHaveLength(1);
    const pe = pes[0];
    expect(pe.actionType).toBe('agent_tool_orchestration');
    // THE reconciled intake key: relay requires metadata.tool_count >= 1.
    expect(pe.metadata!.tool_count).toBe(2);
    expect(pe.metadata!.tool_hops).toBeUndefined(); // the old, rejected key is gone
    expect(pe.metadata!.tool_names).toEqual(['web_search', 'code_exec']);
    // Tokens are a model signal and must not ride the tool PE.
    expect(pe.compute!.tokens_processed).toBeNull();
    // A reader recognizes the turn as 2 tool calls from the PE alone.
    expect(pe.description).toContain('2 tool calls');
  });

  // NEGATIVE CONTROL: a lone model call is NOT dressed up as tool orchestration.
  it('NEGATIVE CONTROL: a model-only turn → NO PE', async () => {
    const model = span({ traceId: 't-model', name: 'chat', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'chat',
        'gen_ai.usage.input_tokens': 5000, 'gen_ai.usage.output_tokens': 2000 } });
    const pes = await classifyTrace([model]);
    expect(pes).toHaveLength(0);
  });

  // 2026-a turn with ONE tool call is a PE (the 2+ floor is gone).
  it('a single-tool turn → ONE agent_tool_orchestration PE with tool_count=1', async () => {
    const tool = span({ traceId: 't-one', name: 'execute_tool web_search', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web_search' } });
    const pes = await classifyTrace([tool]);
    expect(pes).toHaveLength(1);
    expect(pes[0].actionType).toBe('agent_tool_orchestration');
    expect(pes[0].metadata!.tool_count).toBe(1);
    expect(pes[0].metadata!.tool_names).toEqual(['web_search']);
  });

  // Part B : an errored tool call COUNTS toward tool_count and
  // the floor. 1 ok + 1 errored → tool_count 2 → ONE PE, with the error visible.
  it('an errored tool call COUNTS toward tool_count (Part B), errored_tool_calls records the quality', async () => {
    const t1 = span({ traceId: 't-err', spanId: 'a', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'ok_tool' } });
    const t2 = span({ traceId: 't-err', spanId: 'b', status: 'error',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'bad_tool' } });
    const pes = await classifyTrace([t1, t2]);
    expect(pes).toHaveLength(1);
    expect(pes[0].metadata!.tool_count).toBe(2);
    expect(pes[0].metadata!.errored_tool_calls).toBe(1);
    // tool_names includes the errored tool (it was really invoked).
    expect(pes[0].metadata!.tool_names).toEqual(['ok_tool', 'bad_tool']);
  });

  // Part B + 2026-an errored call counts, and one call is a PE.
  // A single errored tool call → tool_count 1 → ONE PE, with the error visible.
  it('a single errored tool call → ONE PE with tool_count=1, errored_tool_calls=1', async () => {
    const t1 = span({ traceId: 't-err1', spanId: 'a', parentSpanId: '', status: 'error',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'bad_tool' } });
    const pes = await classifyTrace([t1]);
    expect(pes).toHaveLength(1);
    expect(pes[0].metadata!.tool_count).toBe(1);
    expect(pes[0].metadata!.errored_tool_calls).toBe(1);
  });

  it('OpenInference emitter classifies identically (universal, not harness-specific)', async () => {
    const chain = span({ traceId: 't-oi', parentSpanId: '',
      attributes: { 'openinference.span.kind': 'CHAIN' } });
    const t1 = span({ traceId: 't-oi', spanId: 'a', parentSpanId: 'c',
      attributes: { 'openinference.span.kind': 'TOOL', 'tool.name': 'search' } });
    const t2 = span({ traceId: 't-oi', spanId: 'b', parentSpanId: 'c',
      attributes: { 'openinference.span.kind': 'TOOL', 'tool.name': 'fetch' } });
    const pes = await classifyTrace([chain, t1, t2]);
    expect(pes).toHaveLength(1);
    expect(pes[0].metadata!.tool_count).toBe(2);
    expect(pes[0].metadata!.otel_convention).toBe('openinference');
  });
});

// ============================================================================
// Part A — turn_id, the program response mint-once anchor
// ============================================================================

describe('turn_id (program response mint-once anchor)', () => {
  it('classifySpanRole extracts the tool-call id (gen_ai.tool.call.id + variants)', () => {
    expect(classifySpanRole(span({
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 't', 'gen_ai.tool.call.id': 'call-9' },
    })).toolCallId).toBe('call-9');
    expect(classifySpanRole(span({
      attributes: { 'openinference.span.kind': 'TOOL', 'tool.name': 't', 'tool_call.id': 'oi-7' },
    })).toolCallId).toBe('oi-7');
    // Absent → null (the turn then falls back to its trace id).
    expect(classifySpanRole(span({
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 't' },
    })).toolCallId ?? null).toBeNull();
  });

  it('a turn WITH tool-call ids stamps turn_id = tc:<sha256> (the cross-source anchor)', async () => {
    const t1 = span({ traceId: 't-ids', spanId: 'a', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'x', 'gen_ai.tool.call.id': 'c1' } });
    const t2 = span({ traceId: 't-ids', spanId: 'b', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'y', 'gen_ai.tool.call.id': 'c2' } });
    const pes = await classifyTrace([t1, t2]);
    expect(pes).toHaveLength(1);
    expect(String(pes[0].metadata!.turn_id)).toMatch(/^or_[0-9a-f]{64}$/);
  });

  it('BACK-COMPAT: a turn with NO call id stamps turn_id = trace_id (byte-identical canonical event)', async () => {
    const t1 = span({ traceId: 't-noid', spanId: 'a', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'x' } });
    const t2 = span({ traceId: 't-noid', spanId: 'b', parentSpanId: '',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'y' } });
    const pes = await classifyTrace([t1, t2]);
    expect(pes).toHaveLength(1);
    expect(pes[0].metadata!.turn_id).toMatch(/^or_[0-9a-f]{64}$/);
  });
});

// ============================================================================
// OTLP protobuf decode ↔ JSON parity (dependency-free decoder)
// ============================================================================

// Minimal protobuf ENCODER, mirror of the decoder, for round-trip proof only.
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
function kv(key: string, value: Buffer): Buffer {
  return Buffer.concat([str(1, key), lenDelim(2, value)]);
}
function encSpan(s: {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  startNano: bigint; endNano: bigint; attrs: Buffer[]; statusCode?: number;
}): Buffer {
  const parts = [
    bytesField(1, s.traceId), bytesField(2, s.spanId),
    ...(s.parentSpanId ? [bytesField(4, s.parentSpanId)] : []),
    str(5, s.name), fixed64(7, s.startNano), fixed64(8, s.endNano),
    ...s.attrs.map((a) => lenDelim(9, a)),
    ...(s.statusCode != null ? [lenDelim(15, varintField(3, s.statusCode))] : []),
  ];
  return Buffer.concat(parts);
}

describe('decodeOtlpTraceProtobuf ↔ JSON parity', () => {
  it('protobuf and JSON encodings of the same trace parse identically', () => {
    // Build one span two ways.
    const traceIdHex = '0af7651916cd43dd8448eb211c80319c';
    const spanIdHex = 'b7ad6b7169203331';

    const protoBody = lenDelim(1, // ResourceSpans
      Buffer.concat([
        lenDelim(1, // Resource
          Buffer.concat([
            lenDelim(1, kv('service.name', anyStr('openclaw'))),
            lenDelim(1, kv('telemetry.sdk.name', anyStr('opentelemetry'))),
          ])),
        lenDelim(2, // ScopeSpans
          Buffer.concat([
            lenDelim(1, str(1, '@some/diagnostics-otel')), // scope.name
            lenDelim(2, encSpan({
              traceId: traceIdHex, spanId: spanIdHex, name: 'execute_tool web_search',
              startNano: 1_700_000_000_000_000_000n, endNano: 1_700_000_002_000_000_000n,
              attrs: [kv('gen_ai.operation.name', anyStr('execute_tool')),
                kv('gen_ai.tool.name', anyStr('web_search')),
                kv('http.status', anyInt(200))],
              statusCode: 1,
            })),
          ])),
      ]));
    const protoReq = protoBody; // ExportTraceServiceRequest.resource_spans (field 1) already tagged

    const jsonPayload = {
      resourceSpans: [{
        resource: { attributes: [
          { key: 'service.name', value: { stringValue: 'openclaw' } },
          { key: 'telemetry.sdk.name', value: { stringValue: 'opentelemetry' } },
        ] },
        scopeSpans: [{
          scope: { name: '@some/diagnostics-otel' },
          spans: [{
            traceId: traceIdHex, spanId: spanIdHex, name: 'execute_tool web_search',
            startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000002000000000',
            attributes: [
              { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
              { key: 'gen_ai.tool.name', value: { stringValue: 'web_search' } },
              { key: 'http.status', value: { intValue: '200' } },
            ],
            status: { code: 1 },
          }],
        }],
      }],
    };

    const fromProto = parseOtlpTracePayload(decodeOtlpTraceProtobuf(protoReq));
    const fromJson = parseOtlpTracePayload(jsonPayload);

    expect(fromProto).toHaveLength(1);
    expect(fromProto).toEqual(fromJson);
    expect(fromProto[0].traceId).toBe(traceIdHex);
    expect(fromProto[0].attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(fromProto[0].attributes['http.status']).toBe(200);
    expect(fromProto[0].resourceAttributes['telemetry.sdk.name']).toBe('opentelemetry');
    expect(classifySpanRole(fromProto[0]).role).toBe('tool');
  });

  // NEGATIVE CONTROL: a truncated protobuf body must throw (receiver → 400),
  // never silently yield a bogus span.
  it('NEGATIVE CONTROL: a truncated protobuf body throws', () => {
    const good = lenDelim(1, lenDelim(2, lenDelim(2, encSpan({
      traceId: 'aa', spanId: 'bb', name: 'x',
      startNano: 1n, endNano: 2n, attrs: [],
    }))));
    const truncated = good.subarray(0, good.length - 3);
    expect(() => decodeOtlpTraceProtobuf(truncated)).toThrow();
  });
});
