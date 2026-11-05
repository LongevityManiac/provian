/**
 * on the MCP surface — `pe_archive`. The tool reads and manages the agent's paid PE
 * Archive account and relays a payment the agent signed; it never holds a key. RED controls: a
 * quote with no payment charges nothing and carries no PAYMENT-SIGNATURE; turning on with no paid
 * space is reported, never claimed as on.
 */

import { describe, expect, it } from 'vitest';
import { callProvianTool, findTool } from './tools';
import type { ToolContext } from './types';

const AUTH = { apiKey: 'pvn_live_' + 'a'.repeat(32), apiSecret: 'pvns_' + 'b'.repeat(64) };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function ctxWith(route: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string; payment: string | null }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', payment: headers.get('payment-signature') });
    return route(url, init);
  }) as unknown as typeof fetch;
  const ctx = { baseUrl: 'https://relay.test', fetchImpl, auth: AUTH, mode: 'local' } as ToolContext;
  return { ctx, calls };
}

describe('pe_archive', () => {
  it('is registered, states the price and that nothing is deleted, and needs credentials', () => {
    const tool = findTool('pe_archive');
    expect(tool).toBeDefined();
    expect(tool!.requiresAuth).toBe(true);
    expect(tool!.description).toContain('Your PEs stay yours');
    expect(tool!.description).toContain('$5 USDC per GB');
    expect(tool!.description).toContain('most recent 30 days');
    expect(tool!.description).toContain('nothing is deleted');
  });

  it('pay with no payment QUOTES (nothing charged, no PAYMENT-SIGNATURE sent); with one it relays it', async () => {
    const terms = { x402Version: 2, accepts: [{ scheme: 'exact', amount: '5000000' }] };
    const { ctx, calls } = ctxWith((url, init) => {
      const paid = new Headers(init?.headers).get('payment-signature');
      return url.endsWith('/v1/archive/pay') ? (paid ? json(200, { request_id: 'ap_' + '1'.repeat(40), credited: true }) : json(402, terms)) : json(500, {});
    });
    const quote = await callProvianTool('pe_archive', { action: 'pay' }, ctx);
    expect(JSON.parse(quote.content[0].text)).toMatchObject({ quote: terms });
    expect(calls[0]).toMatchObject({ method: 'POST', payment: null });
    const paid = await callProvianTool('pe_archive', { action: 'pay', payment: 'eyJ4NDAy' }, ctx);
    expect(JSON.parse(paid.content[0].text)).toMatchObject({ credited: true });
    expect(calls[1].payment).toBe('eyJ4NDAy');
  });

  it('status, days and payment read the agent-auth routes', async () => {
    const { ctx, calls } = ctxWith(() => json(200, { ok: true }));
    await callProvianTool('pe_archive', {}, ctx);
    await callProvianTool('pe_archive', { action: 'days', after: '2026-10-01' }, ctx);
    await callProvianTool('pe_archive', { action: 'payment', request_id: 'ap_' + '2'.repeat(40) }, ctx);
    expect(calls.map((c) => c.url)).toEqual([
      'https://relay.test/v1/archive',
      'https://relay.test/v1/archive/days?after=2026-10-01',
      `https://relay.test/v1/archive/payments/ap_${'2'.repeat(40)}`,
    ]);
  });

  it('RED: turning on with no paid space is reported as not on', async () => {
    const { ctx } = ctxWith(() => json(402, { error: 'archive_not_on' }));
    const r = await callProvianTool('pe_archive', { action: 'on' }, ctx);
    expect(JSON.parse(r.content[0].text)).toMatchObject({ archive_on: false, reason: 'no_paid_space' });
  });
});
