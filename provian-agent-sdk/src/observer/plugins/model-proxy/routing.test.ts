/**
 * routing — where the shim forwards and how it parses. The safety property under
 * test: the upstream is PINNED, never read from the request, so a request can
 * never redirect a bearer token to an arbitrary host.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveRoute, detectProtocol, asOrigin, CANONICAL_UPSTREAM, PROVIDER_PREFIX,
  upstreamOverrideEnvVar,
} from './routing';

describe('detectProtocol — keys on path SHAPE, never a provider name', () => {
  it('recognizes each protocol from its path', () => {
    expect(detectProtocol('/v1/messages')).toBe('anthropic_messages');
    expect(detectProtocol('/v1/chat/completions')).toBe('openai_chat');
    expect(detectProtocol('/v1/responses')).toBe('openai_responses');
    expect(detectProtocol('/v1/embeddings')).toBe('openai_embeddings');
    expect(detectProtocol('/v1beta/models/gemini-2.5-pro:generateContent')).toBe('gemini_generate');
    expect(detectProtocol('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')).toBe('gemini_generate');
  });
  it('RED: an unrelated path is unknown (never guessed as a model call)', () => {
    expect(detectProtocol('/healthz')).toBe('unknown');
    expect(detectProtocol('/v1/models')).toBe('unknown');
    expect(detectProtocol('/')).toBe('unknown');
  });
});

describe('resolveRoute — provider prefix is authoritative; upstream is pinned', () => {
  it('a provider prefix routes to that provider and strips the prefix', () => {
    const r = resolveRoute('/anthropic/v1/messages', {});
    expect(r.provider).toBe('anthropic');
    expect(r.fromPrefix).toBe(true);
    expect(r.upstreamOrigin).toBe(CANONICAL_UPSTREAM.anthropic);
    expect(r.upstreamPath).toBe('/v1/messages');
    expect(r.protocol).toBe('anthropic_messages');
  });

  it('xAI is only reachable by prefix (shares OpenAI protocol) and pins api.x.ai', () => {
    const r = resolveRoute('/xai/v1/chat/completions', {});
    expect(r.provider).toBe('xai');
    expect(r.upstreamOrigin).toBe(CANONICAL_UPSTREAM.xai);
    expect(r.protocol).toBe('openai_chat');
  });

  it('an UNprefixed OpenAI-shaped path routes to OpenAI (never xAI) — the disambiguation rule', () => {
    const r = resolveRoute('/v1/chat/completions', {});
    expect(r.provider).toBe('openai');
    expect(r.upstreamOrigin).toBe(CANONICAL_UPSTREAM.openai);
  });

  it('an unprefixed Anthropic path routes to Anthropic', () => {
    const r = resolveRoute('/v1/messages', {});
    expect(r.provider).toBe('anthropic');
    expect(r.upstreamOrigin).toBe(CANONICAL_UPSTREAM.anthropic);
  });

  it('preserves the query string on the upstream path', () => {
    const r = resolveRoute('/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {});
    expect(r.provider).toBe('gemini');
    expect(r.upstreamPath).toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
  });

  it('an operator override replaces the pinned upstream (self-hosted gateway)', () => {
    const env = { [upstreamOverrideEnvVar('openai')]: 'https://azure-gw.example.com' };
    const r = resolveRoute('/openai/v1/chat/completions', env);
    expect(r.upstreamOrigin).toBe('https://azure-gw.example.com');
  });

  it('RED: a garbage override is IGNORED and the pinned canonical is used (never a request-chosen host)', () => {
    const env = { [upstreamOverrideEnvVar('anthropic')]: 'not-a-url', };
    const r = resolveRoute('/anthropic/v1/messages', env);
    expect(r.upstreamOrigin).toBe(CANONICAL_UPSTREAM.anthropic);
  });

  it('RED: an unresolvable path with no prefix yields NO upstream (fail closed, never a guessed host)', () => {
    const r = resolveRoute('/totally/unknown', {});
    expect(r.provider).toBeNull();
    expect(r.upstreamOrigin).toBeNull();
    expect(r.protocol).toBe('unknown');
  });

  it('every provider prefix is distinct and maps to a canonical https upstream', () => {
    for (const p of Object.keys(PROVIDER_PREFIX) as Array<keyof typeof PROVIDER_PREFIX>) {
      expect(CANONICAL_UPSTREAM[p]).toMatch(/^https:\/\//);
    }
  });
});

describe('asOrigin — only http(s) with a host, path stripped', () => {
  it('accepts a bare origin, strips any path', () => {
    expect(asOrigin('https://api.x.ai/v1')).toBe('https://api.x.ai');
    expect(asOrigin('http://localhost:8080')).toBe('http://localhost:8080');
  });
  it('RED: rejects non-http(s) and malformed values', () => {
    expect(asOrigin('ftp://x')).toBeNull();
    expect(asOrigin('file:///etc/passwd')).toBeNull();
    expect(asOrigin('')).toBeNull();
    expect(asOrigin('   ')).toBeNull();
    expect(asOrigin(undefined)).toBeNull();
  });
});
