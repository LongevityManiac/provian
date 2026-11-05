/**
 * schema-origin — generic, HARNESS-FREE origin classification from a request's
 * tool DEFINITIONS. The load-bearing properties:
 * (a) a fetch tool of ANY name, with a url-typed OR url-named parameter, yields
 * a COUNTED `domain:` origin with no catalog entry;
 * (b) it reads ONLY the request `tools[]` (param names/types/formats), never
 * messages/prompt content;
 * (c) private classes (file/host) are hashed on device — the raw value never
 * appears;
 * (d) RED control: a parameter that is url-TYPED only (name gives no signal)
 * is counted WITH its schema and NOT counted without it — so the schema
 * drive is proven load-bearing, not incidental to the param name.
 */
import { describe, it, expect } from 'vitest';
import { parseRequestToolSchemas } from './parse';
import { classifyParamOriginClass, schemaOriginDrafts } from '../../origin-capture';
import { classifyModelTurn } from './turn-pe';
import type { ModelTurnObservation } from './parse';
import type { OriginWitness } from '../../../input-origins';

// ---------------------------------------------------------------------------
// parseRequestToolSchemas — every provider shape, tools ONLY (never messages)
// ---------------------------------------------------------------------------
describe('parseRequestToolSchemas', () => {
  it('OpenAI chat: tools[].function.{name,parameters}', () => {
    const s = parseRequestToolSchemas({
      messages: [{ role: 'user', content: 'ignore me http://secret.example/path' }],
      tools: [{ type: 'function', function: { name: 'grab', parameters: { properties: { link: { type: 'string', format: 'uri' } } } } }],
    });
    expect(s.get('grab')?.get('link')).toEqual({ type: 'string', format: 'uri' });
    // RED (privacy): the message URL never becomes a tool/param — messages are not read.
    expect(s.has('secret.example')).toBe(false);
    expect([...s.keys()]).toEqual(['grab']);
  });

  it('Anthropic: tools[].{name,input_schema}', () => {
    const s = parseRequestToolSchemas({ tools: [{ name: 'grab', input_schema: { properties: { u: { type: 'string' } } } }] });
    expect(s.get('grab')?.get('u')).toEqual({ type: 'string', format: undefined });
  });

  it('OpenAI responses: tools[].{name,parameters}', () => {
    const s = parseRequestToolSchemas({ tools: [{ type: 'function', name: 'grab', parameters: { properties: { resource: { format: 'url' } } } }] });
    expect(s.get('grab')?.get('resource')).toEqual({ type: undefined, format: 'url' });
  });

  it('Gemini: tools[].functionDeclarations[].{name,parameters}', () => {
    const s = parseRequestToolSchemas({ tools: [{ functionDeclarations: [{ name: 'grab', parameters: { properties: { src: { type: 'string' } } } }] }] });
    expect(s.get('grab')?.has('src')).toBe(true);
  });

  it('RED: a request with no tools yields an empty map (nothing to classify)', () => {
    expect(parseRequestToolSchemas({ messages: [{ role: 'user', content: 'http://x.example' }] }).size).toBe(0);
    expect(parseRequestToolSchemas(null).size).toBe(0);
    expect(parseRequestToolSchemas({ tools: 'not-an-array' }).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyParamOriginClass — type/format OR name; non-origin params → null
// ---------------------------------------------------------------------------
describe('classifyParamOriginClass', () => {
  it('url by format', () => {
    expect(classifyParamOriginClass('q', { format: 'uri' })).toBe('url');
    expect(classifyParamOriginClass('q', { format: 'url' })).toBe('url');
  });
  it('url by name', () => {
    for (const n of ['url', 'uri', 'link', 'href', 'endpoint', 'source_url', 'urls']) {
      expect(classifyParamOriginClass(n, null)).toBe('url');
    }
  });
  it('file / repo / package / host by name', () => {
    expect(classifyParamOriginClass('file_path', null)).toBe('file');
    expect(classifyParamOriginClass('path', null)).toBe('file');
    expect(classifyParamOriginClass('repository', null)).toBe('repo');
    expect(classifyParamOriginClass('pkg', null)).toBe('package');
    expect(classifyParamOriginClass('hostname', null)).toBe('host');
  });
  it('RED: a non-origin parameter classifies to null (evaluated, not assumed)', () => {
    for (const n of ['q', 'query', 'prompt', 'text', 'count', 'temperature', 'foo']) {
      expect(classifyParamOriginClass(n, null)).toBeNull();
      expect(classifyParamOriginClass(n, { type: 'string' })).toBeNull();
    }
    expect(classifyParamOriginClass('', null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// schemaOriginDrafts — url-class → counted domain; private classes hashed
// ---------------------------------------------------------------------------
describe('schemaOriginDrafts', () => {
  it('url-named parameter → counted domain draft + hashed path (no schema needed)', () => {
    const drafts = schemaOriginDrafts({ url: 'https://arxiv.org/abs/2401.12345' }, undefined);
    const ids = drafts.map((d) => d.origin_identifier);
    expect(ids).toContain('domain:arxiv.org');
    // the path rides ONLY as a hash, never as plaintext
    expect(drafts.some((d) => d.origin_identifier === 'private_url_path')).toBe(true);
    expect(JSON.stringify(drafts)).not.toContain('2401.12345');
  });
  it('file-named parameter → private_file (hash only, raw path never present)', () => {
    const drafts = schemaOriginDrafts({ path: '/Users/me/secret.txt' }, undefined);
    expect(drafts.map((d) => d.origin_identifier)).toEqual(['private_file']);
    expect(JSON.stringify(drafts)).not.toContain('secret.txt');
  });
  it('harness-free: an arbitrary param, url-TYPED by schema, is counted', () => {
    const drafts = schemaOriginDrafts({ q: 'https://example.com/x' }, new Map([['q', { format: 'uri' }]]));
    expect(drafts.map((d) => d.origin_identifier)).toContain('domain:example.com');
  });
  it('RED: schema removed → the same url-TYPED-only param counts NOTHING', () => {
    // param name 'q' gives no signal; without the schema, no origin at all.
    expect(schemaOriginDrafts({ q: 'https://example.com/x' }, undefined)).toEqual([]);
  });
  it('RED: a non-url string in a url-named param yields no domain (urlDrafts no-ops)', () => {
    expect(schemaOriginDrafts({ url: 'not a url' }, undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// classifyModelTurn integration — a fetch tool of an ARBITRARY name, no catalog,
// yields a counted witnessed origin purely from the request schema.
// ---------------------------------------------------------------------------
const WITNESS: OriginWitness = { type: 'observer_device', identity: 'dev_mini', attestation_tier: 'software' };
function obs(toolCalls: ModelTurnObservation['toolCalls']): ModelTurnObservation {
  return {
    provider: 'xai', protocol: 'openai_chat', model: 'grok-4.6',
    toolCalls, tokens: { input: 900, output: 300, total: 1200 }, responseId: 'chatcmpl_x', streamed: false, recognized: true,
  };
}

describe('classifyModelTurn — schema-driven counted origin (harness-free)', () => {
  const toolCalls = [{ id: 'call_1', name: 'mystery_grab', input: { q: 'https://arxiv.org/abs/2401.1' } }];

  it('counts the origin from the tool SCHEMA, with no catalog entry and an unknown tool name', () => {
    const schemas = new Map([['mystery_grab', new Map([['q', { format: 'uri' }]])]]);
    const c = classifyModelTurn(obs(toolCalls), {
      witness: WITNESS, toolSchemas: schemas, windowStart: 1000, windowEnd: 2000, durationMs: 1000,
    });
    expect(c.kind).toBe('tool_pe');
    if (c.kind !== 'tool_pe') return;
    const origins = c.pe.input_origins ?? [];
    const domain = origins.find((o) => o.origin_identifier === 'domain:arxiv.org');
    expect(domain).toBeTruthy();
    // Counted-capable on the relay: witnessed by the observer device.
    expect(domain?.witnessed).toBe(true);
    expect(domain?.witness?.identity).toBe('dev_mini');
    // observed tokens ride on the PE (volume input).
    expect(c.pe.compute?.tokens_processed).toBe(1200);
  });

  it('RED: WITHOUT the schema, the unknown-named tool yields NO counted origin', () => {
    const c = classifyModelTurn(obs(toolCalls), {
      witness: WITNESS, toolSchemas: undefined, windowStart: 1000, windowEnd: 2000, durationMs: 1000,
    });
    if (c.kind !== 'tool_pe') throw new Error('expected tool_pe');
    const origins = c.pe.input_origins ?? [];
    expect(origins.find((o) => o.origin_identifier === 'domain:arxiv.org')).toBeUndefined();
  });
});
