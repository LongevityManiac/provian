/**
 * get_pvt_balance reads the live PVT balance on the current kernel, which this
 * server resolves through its own verified protocol-pointer code and names to
 * the relay as `?token=`. RED controls: the unverifiable-pointer case fails if
 * the tool falls back to an unqualified (predecessor) request, and the
 * predecessor-shape case fails if the tool passes an unbound answer through.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { currentProtocolDeployment } from './protocol-runtime';
import { callProvianTool, PROVIAN_TOOLS } from './tools';
import type { ToolContext } from './types';
import type { ProtocolDeployment } from './protocol-pointer';

vi.mock('./protocol-runtime', () => ({ currentProtocolDeployment: vi.fn() }));
const KERNEL = '0x2Af3A065dc3c0c51b054Cb8C6BAEE7Df76189e0e';
const TOKEN = KERNEL.toLowerCase();
const PREDECESSOR = '0x8811441914381143b9408c5C32247367F86F173A';
const deployment = { pointer: `0x${'99'.repeat(20)}`, revision: 1n, manifestHash: `0x${'aa'.repeat(32)}`,
  blockHash: `0x${'bb'.repeat(32)}`, runtimeHashes: [], addresses: { kernel: KERNEL } } as unknown as ProtocolDeployment;
beforeEach(() => { vi.mocked(currentProtocolDeployment).mockReset().mockResolvedValue(deployment); });

function ctxFor(body: unknown, status = 200) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const ctx: ToolContext = { baseUrl: 'https://relay.test', fetchImpl, auth: { apiKey: 'pvn_live_k', apiSecret: 'pvns_s' }, mode: 'remote' };
  return { ctx, urls };
}

const LIVE = { eth: '0.001', usdc: '2.5', chain: 'base', token_address: TOKEN, chain_id: 8453,
  pvt: { status: 'live', address: TOKEN, balance: '123.4', available: true }, cached: false, cached_at: 1 };

describe('get_pvt_balance', () => {
  it('describes the live balance on the current kernel, never PVT9', () => {
    const tool = PROVIAN_TOOLS.find((t) => t.name === 'get_pvt_balance');
    expect(tool?.description).toContain('current kernel');
    expect(tool?.description).toContain('protocol pointer');
    expect(tool?.description).not.toMatch(/PVT9/);
  });

  it('names the pointer-resolved kernel as ?token= and returns the live balance', async () => {
    const { ctx, urls } = ctxFor(LIVE);
    const result = await callProvianTool('get_pvt_balance', { wallet_id: 'wallet_aw_x' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ pvt: { balance: '123.4', address: TOKEN }, token_address: TOKEN });
    expect(urls).toEqual([`https://relay.test/v1/agent/wallet/wallet_aw_x/balances?token=${TOKEN}`]);
  });

  it('an unverifiable pointer reads nothing', async () => {
    vi.mocked(currentProtocolDeployment).mockRejectedValueOnce(new Error('protocol_pointer_unavailable'));
    const { ctx, urls } = ctxFor(LIVE);
    const result = await callProvianTool('get_pvt_balance', { wallet_id: 'wallet_aw_x' }, ctx);
    expect(result.isError).toBe(true);
    expect(urls).toEqual([]);
  });

  it('a predecessor-shaped answer is refused, not passed through as the balance', async () => {
    const { ctx } = ctxFor({ eth: '0', usdc: '0', chain: 'base', pvt9: { status: 'live', address: PREDECESSOR, balance: '99', available: true } });
    const result = await callProvianTool('get_pvt_balance', { wallet_id: 'wallet_aw_x' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('99');
  });

  it('a relay 409 (kernel changed) surfaces as an error', async () => {
    const { ctx } = ctxFor({ error: 'PVT token changed; refresh protocol discovery' }, 409);
    const result = await callProvianTool('get_pvt_balance', { wallet_id: 'wallet_aw_x' }, ctx);
    expect(result.isError).toBe(true);
  });
});
