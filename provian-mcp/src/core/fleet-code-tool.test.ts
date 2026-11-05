/**
 * on the MCP surface — `issue_fleet_code`.
 *
 * "Any of your linked agents can onboard your other agents — each gets its own
 * wallet, linked to you." The tool calls the relay's fleet-code route with agent auth
 * and returns the one-hour code + install line; with no credentials it never
 * reaches the network. RED control: an unlinked agent's refusal surfaces as an
 * error result, never as a code.
 */

import { describe, expect, it } from 'vitest';
import { callProvianTool, findTool } from './tools';
import type { ToolContext } from './types';

const AUTH = { apiKey: 'pvn_live_' + 'a'.repeat(32), apiSecret: 'pvns_' + 'b'.repeat(64) };
const CODE = 'PROV-HJKM-2345';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function ctxWith(route: (url: string, init?: RequestInit) => Response, over: Partial<ToolContext> = {}) {
  const calls: Array<{ url: string; method: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization') });
    return route(url, init);
  }) as unknown as typeof fetch;
  const ctx = { baseUrl: 'https://relay.test', fetchImpl, auth: AUTH, mode: 'local', ...over } as ToolContext;
  return { ctx, calls };
}

describe('issue_fleet_code', () => {
  it('is registered with the exact wording and never says "sub-agents"', () => {
    const tool = findTool('issue_fleet_code');
    expect(tool).toBeDefined();
    expect(tool!.description.startsWith('Any of your linked agents can onboard your other agents — each gets its own wallet, linked to you.')).toBe(true);
    expect(tool!.description.toLowerCase()).not.toContain('sub-agent');
    expect(tool!.requiresAuth).toBe(true);
  });

  it('POSTs the relay fleet-code route with agent auth and returns the code + install line', async () => {
    const issued = { code: CODE, expires_at: 1_900_000_000_000, install_line: { sh: 'curl …', powershell: 'irm …' } };
    const { ctx, calls } = ctxWith((url) => url.endsWith('/v1/agent/wallet/wallet_aw_main/fleet-code') ? json(201, issued) : json(500, {}));
    const r = await callProvianTool('issue_fleet_code', { wallet_id: 'wallet_aw_main' }, ctx);
    expect(r.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].auth).toBe(`Bearer ${AUTH.apiKey}:${AUTH.apiSecret}`);
    expect(JSON.parse(r.content[0].text)).toEqual(issued);
  });

  it('RED control: an unlinked agent (403 not_linked) is an error result, not a code', async () => {
    const { ctx } = ctxWith(() => json(403, { error: 'not_linked' }));
    const r = await callProvianTool('issue_fleet_code', { wallet_id: 'wallet_aw_lone' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain('PROV-');
  });

  it('without credentials it never calls the relay', async () => {
    const { ctx, calls } = ctxWith(() => json(201, {}), { auth: undefined });
    const r = await callProvianTool('issue_fleet_code', { wallet_id: 'wallet_aw_main' }, ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
