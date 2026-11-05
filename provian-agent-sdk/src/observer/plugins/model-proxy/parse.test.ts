/**
 * parse — structure-only observation of one model turn, per protocol.
 *
 * The invariants under test: (a) tool-call ids + names + args, tokens, model, and
 * response id are pulled from each protocol's real shape; (b) a zero-tool turn is
 * recognized with its tokens (never discarded); (c) an unrecognized shape returns
 * recognized:false (→ fingerprint, never a fabricated witness); (d) streaming
 * accumulation reconstructs the same turn as the non-streaming body.
 */
import { describe, it, expect } from 'vitest';
import {
  parseResponseJson, parseAnthropicResponseJson, parseOpenAIChatResponseJson,
  parseOpenAIResponsesResponseJson, parseGeminiResponseJson,
  StreamingTurnParser,
} from './parse';

describe('Anthropic Messages (non-streaming)', () => {
  const body = {
    id: 'msg_01ABC', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
    content: [
      { type: 'text', text: 'let me look' },
      { type: 'tool_use', id: 'toolu_01X', name: 'Read', input: { file_path: '/secret/path.txt' } },
      { type: 'tool_use', id: 'toolu_02Y', name: 'WebFetch', input: { url: 'https://arxiv.org/abs/2401' } },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  it('extracts tool calls, model, id, tokens', () => {
    const o = parseAnthropicResponseJson(body);
    expect(o.recognized).toBe(true);
    expect(o.model).toBe('claude-opus-4-8');
    expect(o.responseId).toBe('msg_01ABC');
    expect(o.toolCalls.map((c) => c.id)).toEqual(['toolu_01X', 'toolu_02Y']);
    expect(o.toolCalls.map((c) => c.name)).toEqual(['Read', 'WebFetch']);
    expect(o.tokens).toEqual({ input: 100, output: 50, total: 150 });
  });
  it('zero-tool turn: recognized, tokens present, no tool calls (never discarded)', () => {
    const o = parseAnthropicResponseJson({ id: 'msg_z', type: 'message', model: 'claude', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 5, output_tokens: 2 } });
    expect(o.recognized).toBe(true);
    expect(o.toolCalls).toHaveLength(0);
    expect(o.tokens?.total).toBe(7);
  });
  it('RED: a non-message shape is NOT recognized (→ fingerprint, never fabricated)', () => {
    expect(parseAnthropicResponseJson({ error: { type: 'overloaded' } }).recognized).toBe(false);
    expect(parseAnthropicResponseJson({}).recognized).toBe(false);
    expect(parseAnthropicResponseJson(null).recognized).toBe(false);
    expect(parseAnthropicResponseJson('nope').recognized).toBe(false);
  });
});

describe('OpenAI Chat Completions (non-streaming)', () => {
  const body = {
    id: 'chatcmpl-9', object: 'chat.completion', model: 'gpt-4o',
    choices: [{ message: { role: 'assistant', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'WebFetch', arguments: '{"url":"https://arxiv.org/abs/1"}' } },
    ] } }],
    usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
  };
  it('extracts tool calls (arguments JSON-parsed), model, id, tokens', () => {
    const o = parseOpenAIChatResponseJson(body);
    expect(o.recognized).toBe(true);
    expect(o.toolCalls[0]).toMatchObject({ id: 'call_1', name: 'WebFetch' });
    expect(o.toolCalls[0].input).toEqual({ url: 'https://arxiv.org/abs/1' });
    expect(o.tokens).toEqual({ input: 30, output: 20, total: 50 });
  });
  it('zero-tool assistant message: recognized, tokens present', () => {
    const o = parseOpenAIChatResponseJson({ id: 'c', model: 'gpt-4o', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    expect(o.recognized).toBe(true);
    expect(o.toolCalls).toHaveLength(0);
    expect(o.tokens?.total).toBe(2);
  });
  it('RED: no choices array → not recognized', () => {
    expect(parseOpenAIChatResponseJson({ object: 'error' }).recognized).toBe(false);
  });
});

describe('OpenAI Responses API (non-streaming)', () => {
  it('extracts function_call items by call_id', () => {
    const o = parseOpenAIResponsesResponseJson({
      id: 'resp_1', object: 'response', model: 'gpt-5',
      output: [{ type: 'function_call', call_id: 'call_9', name: 'Bash', arguments: '{"command":"ls"}' }],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
    expect(o.recognized).toBe(true);
    expect(o.toolCalls[0]).toMatchObject({ id: 'call_9', name: 'Bash' });
    expect(o.tokens?.total).toBe(8);
  });
});

describe('Gemini generateContent (non-streaming)', () => {
  it('extracts functionCall (no id) + usageMetadata', () => {
    const o = parseGeminiResponseJson({
      candidates: [{ content: { parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      modelVersion: 'gemini-2.5-pro', responseId: 'resp_g',
    });
    expect(o.recognized).toBe(true);
    expect(o.toolCalls[0]).toMatchObject({ id: null, name: 'search' });
    expect(o.model).toBe('gemini-2.5-pro');
    expect(o.tokens?.total).toBe(15);
  });
  it('RED: no candidates → not recognized', () => {
    expect(parseGeminiResponseJson({ promptFeedback: {} }).recognized).toBe(false);
  });
});

describe('parseResponseJson dispatch + embeddings', () => {
  it('embeddings: recognized, tokens, never a tool call', () => {
    const o = parseResponseJson('openai_embeddings', { object: 'list', model: 'text-embedding-3', data: [{}], usage: { prompt_tokens: 8, total_tokens: 8 } });
    expect(o.recognized).toBe(true);
    expect(o.toolCalls).toHaveLength(0);
    expect(o.tokens?.total).toBe(8);
  });
  it('unknown protocol → unrecognized', () => {
    expect(parseResponseJson('unknown', { anything: true }).recognized).toBe(false);
  });
});

describe('Gemini buffered (non-SSE) — single object AND streamGenerateContent JSON array', () => {
  // A `:streamGenerateContent` request WITHOUT `alt=sse` returns a JSON ARRAY of
  // response objects at content-type application/json (not SSE), so the buffered
  // parser must merge it. (The single-object `:generateContent` case is covered
  // above; the plugin routes BOTH to this parser via the response content-type.)
  it('merges a JSON array of response chunks: tool calls concatenated, last usage wins', () => {
    const arr = [
      { candidates: [{ content: { parts: [{ functionCall: { name: 'search', args: { q: 'a' } } }] } }], modelVersion: 'gemini-2.5-pro', responseId: 'g1' },
      { candidates: [{ content: { parts: [{ functionCall: { name: 'Read', args: { file_path: '/x' } } }] } }] },
      { candidates: [{ content: { parts: [{ text: 'done' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } },
    ];
    const o = parseGeminiResponseJson(arr);
    expect(o.recognized).toBe(true);
    expect(o.toolCalls.map((c) => c.name)).toEqual(['search', 'Read']);
    expect(o.model).toBe('gemini-2.5-pro');
    expect(o.responseId).toBe('g1');
    expect(o.tokens?.total).toBe(15);
  });
  it('parseResponseJson dispatches a Gemini array to the merged parse', () => {
    const o = parseResponseJson('gemini_generate', [
      { candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} } }] } }], usageMetadata: { totalTokenCount: 3 } },
    ]);
    expect(o.recognized).toBe(true);
    expect(o.toolCalls).toHaveLength(1);
    expect(o.tokens?.total).toBe(3);
  });
  it('RED: an array of non-Gemini objects is NOT recognized (no vacuous true)', () => {
    // Guards the array branch against blindly returning recognized:true — a chunk
    // with no `candidates` is skipped, and an all-junk array stays unrecognized.
    expect(parseGeminiResponseJson([{ foo: 1 }, { bar: 2 }]).recognized).toBe(false);
    expect(parseGeminiResponseJson([]).recognized).toBe(false);
  });
});

describe('StreamingTurnParser — Anthropic SSE reconstructs the turn', () => {
  it('accumulates a tool_use block across input_json_delta events + final usage', () => {
    const p = new StreamingTurnParser('anthropic_messages');
    p.push('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-8","usage":{"input_tokens":100}}}\n\n');
    p.push('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read"}}\n\n');
    p.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":"}}\n\n');
    p.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"/a/b.txt\\"}"}}\n\n');
    p.push('event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":42}}\n\n');
    const o = p.finish();
    expect(o.recognized).toBe(true);
    expect(o.streamed).toBe(true);
    expect(o.model).toBe('claude-opus-4-8');
    expect(o.toolCalls[0]).toMatchObject({ id: 'toolu_1', name: 'Read' });
    expect(o.toolCalls[0].input).toEqual({ file_path: '/a/b.txt' });
    expect(o.tokens).toEqual({ input: 100, output: 42, total: 142 });
  });
  it('handles chunk boundaries that split an SSE event mid-line', () => {
    const p = new StreamingTurnParser('anthropic_messages');
    p.push('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_bl');
    p.push('ock":{"type":"tool_use","id":"toolu_9","name":"Bash"}}\n\n');
    const o = p.finish();
    expect(o.toolCalls[0]).toMatchObject({ id: 'toolu_9', name: 'Bash' });
  });
});

describe('StreamingTurnParser — OpenAI Chat SSE reconstructs the turn', () => {
  it('accumulates tool_calls by index across delta chunks + usage', () => {
    const p = new StreamingTurnParser('openai_chat');
    p.push('data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"WebFetch","arguments":""}}]}}]}\n\n');
    p.push('data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"url\\":\\"https://x.com/a\\"}"}}]}}]}\n\n');
    p.push('data: {"id":"chatcmpl-1","choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n');
    p.push('data: [DONE]\n\n');
    const o = p.finish();
    expect(o.toolCalls[0]).toMatchObject({ id: 'call_1', name: 'WebFetch' });
    expect(o.toolCalls[0].input).toEqual({ url: 'https://x.com/a' });
    expect(o.tokens).toEqual({ input: 10, output: 5, total: 15 });
  });
  it('streaming with usage omitted → tokens null (never estimated)', () => {
    const p = new StreamingTurnParser('openai_chat');
    p.push('data: {"id":"c","model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\n');
    p.push('data: [DONE]\n\n');
    const o = p.finish();
    expect(o.tokens).toBeNull();
    expect(o.toolCalls).toHaveLength(0);
  });
});

describe('StreamingTurnParser — Gemini SSE + array', () => {
  it('parses SSE data lines with functionCall + usage', () => {
    const p = new StreamingTurnParser('gemini_generate');
    p.push('data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"q":"y"}}}]}}]}\n\n');
    p.push('data: {"candidates":[{"content":{"parts":[]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5},"modelVersion":"gemini-2.5-pro"}\n\n');
    const o = p.finish();
    expect(o.toolCalls[0]).toMatchObject({ name: 'search' });
    expect(o.tokens?.total).toBe(5);
  });
  it('parses a JSON-array stream body', () => {
    const p = new StreamingTurnParser('gemini_generate');
    p.push('[{"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{}}}]}}]},');
    p.push('{"candidates":[{"content":{"parts":[]}}],"usageMetadata":{"totalTokenCount":9}}]');
    const o = p.finish();
    expect(o.toolCalls[0]).toMatchObject({ name: 'f' });
    expect(o.tokens?.total).toBe(9);
  });
  it('RED: empty gemini stream → not recognized', () => {
    const p = new StreamingTurnParser('gemini_generate');
    p.push('');
    expect(p.finish().recognized).toBe(false);
  });
});
