/**
 * turn-pe — classify one observed model turn into what the observer submits.
 *
 * The load-bearing properties: (a) a tool turn's turn_id is the SAME the
 * transcript/OTel lanes derive (cross-lane mint-once); (b) tokens ARE recorded on
 * the PE ; (c) origins come through the privacy allowlist — private
 * file args hashed, public URLs resolvable, and the raw path NEVER appears; (d) a
 * zero-tool turn routes to witnessed inference, not a tool PE; (e) an unrecognized
 * turn produces nothing.
 */
import { describe, it, expect } from 'vitest';
import { classifyModelTurn, MODEL_PROXY_TOOL } from './turn-pe';
import { computeTurnId } from '../turn-identity';
import type { ModelTurnObservation } from './parse';
import type { OriginWitness } from '../../../input-origins';

const WITNESS: OriginWitness = { type: 'observer_device', identity: 'dev_123', attestation_tier: 'software' };
const CTX = { witness: WITNESS, windowStart: 1000, windowEnd: 2000, durationMs: 1000 };

function obs(partial: Partial<ModelTurnObservation>): ModelTurnObservation {
  return {
    provider: 'anthropic', protocol: 'anthropic_messages', model: 'claude-opus-4-8',
    toolCalls: [], tokens: null, responseId: 'msg_1', streamed: false, recognized: true,
    ...partial,
  };
}

describe('§2.3 — the observed response digest is the turn PE\'s output', () => {
  const o = obs({ toolCalls: [{ id: 'toolu_1', name: 'Read', input: {} }] });
  it('ctx.responseDigest rides as output_digests[{ kind: response }]; absent → no key (never a placeholder)', () => {
    const digest = `sha256:${'ab'.repeat(32)}`;
    const c = classifyModelTurn(o, { ...CTX, responseDigest: digest });
    expect(c.kind).toBe('tool_pe');
    if (c.kind !== 'tool_pe') return;
    expect(c.pe.output_digests).toEqual([{ hash: digest, kind: 'response' }]);
    const none = classifyModelTurn(o, CTX);
    if (none.kind !== 'tool_pe') return;
    expect('output_digests' in none.pe).toBe(false);
  });
});

describe('classifyModelTurn — tool turn', () => {
  const o = obs({
    toolCalls: [
      { id: 'toolu_1', name: 'Read', input: { file_path: '/Users/me/secret.txt' } },
      { id: 'toolu_2', name: 'WebFetch', input: { url: 'https://arxiv.org/abs/2401.12345' } },
    ],
    tokens: { input: 100, output: 50, total: 150 },
  });

  it('emits an agent_tool_orchestration PE with tool_count, provider, model, tokens', () => {
    const c = classifyModelTurn(o, CTX);
    expect(c.kind).toBe('tool_pe');
    if (c.kind !== 'tool_pe') return;
    expect(c.pe.actionType).toBe('agent_tool_orchestration');
    expect(c.pe.metadata?.tool).toBe(MODEL_PROXY_TOOL);
    expect(c.pe.metadata?.source).toBe('model_proxy');
    expect(c.pe.metadata?.tool_count).toBe(2);
    expect(c.pe.metadata?.provider).toBe('anthropic');
    expect(c.pe.metadata?.model).toBe('claude-opus-4-8');
    // tokens are recorded on the model-turn PE (departure from OTel).
    expect(c.pe.compute?.tokens_processed).toBe(150);
  });

  it('CROSS-LANE : the turn_id equals what the transcript/OTel lanes derive from the same ids', () => {
    const c = classifyModelTurn(o, CTX);
    if (c.kind !== 'tool_pe') throw new Error('expected tool_pe');
    // The transcript/OTel lanes compute turn_id from the SAME tool-call ids with
    // a DIFFERENT fallback self key — the anchor makes them agree.
    const transcriptSide = computeTurnId(['toolu_1', 'toolu_2'], 'tf:fingerprint:7');
    expect(c.pe.metadata?.turn_id).toBe(transcriptSide);
    expect(c.turnId).toBe(transcriptSide);
  });

  it('PRIVACY: a private file path is HASHED (type tag only), never plaintext; a public URL domain is resolvable', () => {
    const c = classifyModelTurn(o, CTX);
    if (c.kind !== 'tool_pe') throw new Error('expected tool_pe');
    const origins = c.pe.input_origins ?? [];
    const serialized = JSON.stringify(origins);
    // The raw path must NEVER appear anywhere in the origins.
    expect(serialized).not.toContain('/Users/me/secret.txt');
    expect(serialized).not.toContain('secret.txt');
    // The private file is recorded by TYPE TAG + hash only.
    expect(origins.some((x) => x.origin_identifier === 'private_file' && x.hash.startsWith('sha256:'))).toBe(true);
    // The public domain is resolvable in the clear (a public fact).
    expect(origins.some((x) => x.origin_identifier === 'domain:arxiv.org')).toBe(true);
    // Origins the device captured are witnessed.
    expect(origins.every((x) => x.witnessed === true && x.witness?.type === 'observer_device')).toBe(true);
  });

  it('RED: two turns with DIFFERENT tool-call ids get DIFFERENT turn_ids (distinct work never merged)', () => {
    const a = classifyModelTurn(obs({ toolCalls: [{ id: 'toolu_A', name: 'Read', input: {} }] }), CTX);
    const b = classifyModelTurn(obs({ toolCalls: [{ id: 'toolu_B', name: 'Read', input: {} }] }), CTX);
    if (a.kind !== 'tool_pe' || b.kind !== 'tool_pe') throw new Error('expected tool_pe');
    expect(a.pe.metadata?.turn_id).not.toBe(b.pe.metadata?.turn_id);
  });

  it('a Gemini tool turn (no ids) falls back to a per-turn key and still emits a PE', () => {
    const g = classifyModelTurn(obs({ provider: 'gemini', protocol: 'gemini_generate', toolCalls: [{ id: null, name: 'search', input: {} }] }), CTX);
    expect(g.kind).toBe('tool_pe');
    if (g.kind !== 'tool_pe') return;
    expect(String(g.pe.metadata?.turn_id).startsWith('mp:')).toBe(true);
  });
});

describe('classifyModelTurn — pure model work does not mint', () => {
  it('zero tools never mint, regardless of tokens', () => {
    for (const tokens of [null, {input: 1000000, output: 1000000, total: 2000000}])
      expect(classifyModelTurn(obs({toolCalls: [], tokens}), CTX).kind).toBe('none');
  });
});

describe('classifyModelTurn — RED: unrecognized turn produces nothing', () => {
  it('an unrecognized observation yields kind:none (never a fabricated witness)', () => {
    const c = classifyModelTurn(obs({ recognized: false, toolCalls: [{ id: 'x', name: 'y', input: {} }] }), CTX);
    expect(c.kind).toBe('none');
  });
});
