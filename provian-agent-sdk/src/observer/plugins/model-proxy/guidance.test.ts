/**
 * guidance — the repoint instructions the agent/human executes ,
 * and the doctor log helper that reports the proxy lane's live state.
 */
import { describe, it, expect } from 'vitest';
import { repointGuidanceFor, allRepointGuidance, proxyBaseUrl, PROVIDER_BASE_URL_ENV, ENV_REPOINT_PROVIDERS } from './guidance';
import { modelProxyFromLog } from '../../../scripts/doctor';

describe('repoint guidance', () => {
  it('points each provider at the loopback shim with its prefix and canonical env var', () => {
    expect(proxyBaseUrl('anthropic')).toBe('http://127.0.0.1:4320/anthropic');
    expect(repointGuidanceFor('anthropic').exportLines).toEqual(['export ANTHROPIC_BASE_URL=http://127.0.0.1:4320/anthropic']);
    expect(repointGuidanceFor('openai').exportLines).toEqual(['export OPENAI_BASE_URL=http://127.0.0.1:4320/openai']);
    expect(repointGuidanceFor('xai').exportLines).toEqual(['export XAI_BASE_URL=http://127.0.0.1:4320/xai']);
    expect(repointGuidanceFor('gemini').exportLines).toEqual(['export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4320/gemini']);
  });
  it('covers all four providers', () => {
    expect(allRepointGuidance().map((g) => g.provider).sort()).toEqual(['anthropic', 'gemini', 'openai', 'xai']);
  });
  it('honors a custom port', () => {
    expect(proxyBaseUrl('openai', 4999)).toBe('http://127.0.0.1:4999/openai');
  });
  it('every env-repointed provider has at least one base-URL env var name', () => {
    // Grok Build on an API key (`grok_api`) is repointed only through
    // ~/.grok/config.toml `models_base_url` (the daemon writes it), so it has none.
    for (const p of [...ENV_REPOINT_PROVIDERS, 'grok' as const]) expect(PROVIDER_BASE_URL_ENV[p].length).toBeGreaterThan(0);
    expect(PROVIDER_BASE_URL_ENV.grok_api).toEqual([]);
  });
});

describe('modelProxyFromLog (doctor)', () => {
  it('reads listening + witnessed + unrecognized from the log', () => {
    const log = [
      '[observer info] model proxy listening on http://127.0.0.1:4320 {}',
      '[observer info] model proxy: tool turn witnessed {"provider":"anthropic","tool_count":2}',
    ].join('\n');
    expect(modelProxyFromLog(log)).toEqual({ listening: true, toolTurnsSeen: true, unrecognized: false });
  });
  it('RED: an empty log shows nothing live (never a false green)', () => {
    expect(modelProxyFromLog('')).toEqual({ listening: false, toolTurnsSeen: false, unrecognized: false });
  });
  it('listening but no turns yet (the repoint-me state, not an alarm)', () => {
    expect(modelProxyFromLog('[observer info] model proxy listening on http://127.0.0.1:4320 {}'))
      .toEqual({ listening: true, toolTurnsSeen: false, unrecognized: false });
  });
  it('flags unrecognized traffic (fingerprinted, still forwarded)', () => {
    const log = 'model proxy listening on http://127.0.0.1:4320\nmodel proxy: unrecognized response shape (forwarded, fingerprinted)';
    expect(modelProxyFromLog(log).unrecognized).toBe(true);
  });
});
