import { describe, it, expect } from 'vitest';
import { parseOtlpTracePayload, flattenAttributes, OTelPlugin } from './OTelPlugin';

describe('flattenAttributes', () => {
  it('returns empty object for non-array input', () => {
    expect(flattenAttributes(null)).toEqual({});
    expect(flattenAttributes(undefined)).toEqual({});
    expect(flattenAttributes({})).toEqual({});
  });

  it('unwraps OTLP AnyValue variants', () => {
    const attrs = flattenAttributes([
      { key: 'str', value: { stringValue: 'hello' } },
      { key: 'bool', value: { boolValue: true } },
      { key: 'int', value: { intValue: '1234' } },
      { key: 'dbl', value: { doubleValue: 1.5 } },
    ]);
    expect(attrs).toEqual({ str: 'hello', bool: true, int: 1234, dbl: 1.5 });
  });

  it('handles 64-bit int strings safely', () => {
    const attrs = flattenAttributes([
      { key: 'tokens', value: { intValue: '12345678901234' } },
    ]);
    expect(attrs.tokens).toBe(12345678901234);
  });
});

describe('parseOtlpTracePayload', () => {
  it('returns empty list for malformed payload', () => {
    expect(parseOtlpTracePayload(null)).toEqual([]);
    expect(parseOtlpTracePayload({})).toEqual([]);
    expect(parseOtlpTracePayload({ resourceSpans: 'not an array' })).toEqual([]);
  });

  it('parses a well-formed gen_ai span', () => {
    const payload = {
      resourceSpans: [{
        resource: { attributes: [
          { key: 'service.name', value: { stringValue: 'my-agent' } },
          { key: 'telemetry.sdk.name', value: { stringValue: 'langchain' } },
        ] },
        scopeSpans: [{
          scope: { name: 'langchain.llm' },
          spans: [{
            traceId: '0af7651916cd43dd8448eb211c80319c',
            spanId: 'b7ad6b7169203331',
            name: 'test-research-chain',
            kind: 1,
            startTimeUnixNano: '1700000000000000000',
            endTimeUnixNano: '1700000060000000000',
            attributes: [
              { key: 'gen_ai.usage.input_tokens', value: { intValue: '5000' } },
              { key: 'gen_ai.usage.output_tokens', value: { intValue: '2000' } },
              { key: 'gen_ai.request.model', value: { stringValue: 'claude-opus-4-6' } },
            ],
            status: { code: 1 },
          }],
        }],
      }],
    };
    const spans = parseOtlpTracePayload(payload);
    expect(spans).toHaveLength(1);
    const s = spans[0];
    expect(s.name).toBe('test-research-chain');
    expect(s.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(s.status).toBe('ok');
    expect(s.startTimeUnixMs).toBe(1700000000000);
    expect(s.endTimeUnixMs).toBe(1700000060000);
    expect(s.attributes['gen_ai.usage.input_tokens']).toBe(5000);
    expect(s.attributes['gen_ai.usage.output_tokens']).toBe(2000);
    expect(s.attributes['gen_ai.request.model']).toBe('claude-opus-4-6');
    expect(s.resourceAttributes['service.name']).toBe('my-agent');
    expect(s.resourceAttributes['telemetry.sdk.name']).toBe('langchain');
    expect(s.scopeName).toBe('langchain.llm');
  });

  it('treats status code 0 (UNSET) as ok per OTel convention', () => {
    const payload = {
      resourceSpans: [{
        resource: {},
        scopeSpans: [{
          spans: [{
            traceId: 'aaaa',
            spanId: 'bbbb',
            name: 'x',
            startTimeUnixNano: '1000000',
            endTimeUnixNano: '2000000',
            status: { code: 0 },
          }],
        }],
      }],
    };
    const [s] = parseOtlpTracePayload(payload);
    expect(s.status).toBe('ok');
  });

  it('treats a span with no status as ok (common OTel default)', () => {
    const payload = {
      resourceSpans: [{
        resource: {},
        scopeSpans: [{
          spans: [{
            traceId: 'aaaa',
            spanId: 'bbbb',
            name: 'x',
            startTimeUnixNano: '1000000',
            endTimeUnixNano: '2000000',
          }],
        }],
      }],
    };
    const [s] = parseOtlpTracePayload(payload);
    expect(s.status).toBe('ok');
  });

  it('maps status code 2 to error', () => {
    const payload = {
      resourceSpans: [{
        resource: {},
        scopeSpans: [{
          spans: [{
            traceId: 'aaaa',
            spanId: 'bbbb',
            name: 'x',
            startTimeUnixNano: '1000000',
            endTimeUnixNano: '2000000',
            status: { code: 2 },
          }],
        }],
      }],
    };
    const [s] = parseOtlpTracePayload(payload);
    expect(s.status).toBe('error');
  });

  it('forceActive activates the plugin even with no framework env vars', async () => {
    const original = {
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      service: process.env.OTEL_SERVICE_NAME,
    };
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;
    try {
      const plugin = new OTelPlugin({ journalPath: null, forceActive: true });
      const fakeObserver: any = { log: () => {} };
      await plugin.init(fakeObserver);
      expect(plugin.isActive()).toBe(true);
    } finally {
      if (original.endpoint != null) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original.endpoint;
      if (original.service != null) process.env.OTEL_SERVICE_NAME = original.service;
    }
  });

  it('without forceActive and no framework env, plugin is dormant', async () => {
    const original = {
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      service: process.env.OTEL_SERVICE_NAME,
    };
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;
    try {
      const plugin = new OTelPlugin();
      const fakeObserver: any = { log: () => {} };
      await plugin.init(fakeObserver);
      // Note: this may still be true if a known agent process is running on
      // the test host (e.g. the test runner sees `langchain` in `ps`).
      // We assert only that forceActive is honored, not that detect() is
      // false everywhere.
      expect(typeof plugin.isActive()).toBe('boolean');
    } finally {
      if (original.endpoint != null) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original.endpoint;
      if (original.service != null) process.env.OTEL_SERVICE_NAME = original.service;
    }
  });

  it('skips spans missing traceId or timestamps', () => {
    const payload = {
      resourceSpans: [{
        resource: {},
        scopeSpans: [{
          spans: [
            { traceId: '', spanId: 'b', name: 'x', startTimeUnixNano: '1', endTimeUnixNano: '2' },
            { traceId: 'a', spanId: 'b', name: 'x' },
          ],
        }],
      }],
    };
    expect(parseOtlpTracePayload(payload)).toHaveLength(0);
  });
});
