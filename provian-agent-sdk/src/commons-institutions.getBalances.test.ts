/**
 * CommonsInstitutions.getBalances — PVT is read on the current kernel the SDK
 * resolved through its own verified protocol-pointer code, named to the relay as
 * `?token=`. A response not bound to that kernel (for example a relay that
 * ignored the token and answered the predecessor `pvt9` shape) never supplies a
 * PVT balance. RED controls: the predecessor-shape case fails if the SDK reads
 * `pvt9`; the unverifiable-pointer case fails if the SDK falls back to an
 * unqualified request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { currentProtocolDeployment } from './protocol-runtime';
import { CommonsInstitutions, type CommonsInstitutionsConfig } from './commons-institutions';
import type { ProtocolDeployment } from './protocol-pointer';

vi.mock('./protocol-runtime', () => ({ currentProtocolDeployment: vi.fn() }));

const KERNEL = '0x2Af3A065dc3c0c51b054Cb8C6BAEE7Df76189e0e';
const TOKEN = KERNEL.toLowerCase();
const PREDECESSOR = '0x8811441914381143b9408c5C32247367F86F173A';
const deployment = { pointer: `0x${'99'.repeat(20)}`, revision: 1n, blockHash: `0x${'aa'.repeat(32)}`,
  manifestHash: `0x${'bb'.repeat(32)}`, runtimeHashes: [], addresses: { kernel: KERNEL } } as unknown as ProtocolDeployment;

const BASE: CommonsInstitutionsConfig = {
  relayUrl: 'https://relay.test',
  walletId: 'wallet_aw_test',
  apiKey: 'pvn_live_abc123',
  apiSecret: 'pvns_' + 'x'.repeat(64),
};

function bankReturning(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    calls.push(String(url));
    return { ok: status < 400, status, json: async () => body } as Response;
  };
  return { institutions: new CommonsInstitutions({ ...BASE, fetch: fetchImpl as unknown as typeof fetch }), calls };
}

beforeEach(() => { vi.mocked(currentProtocolDeployment).mockReset().mockResolvedValue(deployment); });

describe('CommonsInstitutions.getBalances', () => {
  it('sends the pointer-resolved kernel as ?token= and returns the live balance', async () => {
    const { institutions, calls } = bankReturning({
      eth: '0.001', usdc: '2.5', chain: 'base', token_address: TOKEN, chain_id: 8453,
      pvt: { status: 'live', address: TOKEN, balance: '123.4', available: true },
    });
    expect(await institutions.getBalances()).toEqual({
      eth: '0.001', usdc: '2.5', pvt: '123.4', pvtAvailable: true, pvtAddress: TOKEN, chain: 'base',
    });
    expect(calls).toEqual([`https://relay.test/v1/agent/wallet/wallet_aw_test/balances?token=${TOKEN}`]);
    expect(currentProtocolDeployment).toHaveBeenCalledTimes(1);
    expect(await institutions.getPvtBalance()).toBe('123.4');
  });

  it('a predecessor-shaped answer never supplies a PVT balance', async () => {
    const { institutions } = bankReturning({
      eth: '0.001', usdc: '0', chain: 'base', pvt9: { status: 'live', address: PREDECESSOR, balance: '99', available: true },
    });
    const b = await institutions.getBalances();
    expect(b).toMatchObject({ pvt: null, pvtAvailable: false, pvtAddress: TOKEN });
  });

  it('an answer bound to another kernel never supplies a PVT balance', async () => {
    const other = `0x${'33'.repeat(20)}`;
    const { institutions } = bankReturning({
      eth: '0', usdc: '0', chain: 'base', token_address: other, pvt: { status: 'live', address: other, balance: '5', available: true },
    });
    expect(await institutions.getBalances()).toMatchObject({ pvt: null, pvtAvailable: false });
  });

  it('an unverifiable pointer refuses, with no unqualified relay request', async () => {
    vi.mocked(currentProtocolDeployment).mockRejectedValueOnce(new Error('protocol_pointer_unavailable'));
    const { institutions, calls } = bankReturning({});
    await expect(institutions.getBalances()).rejects.toThrow('protocol_pointer_unavailable');
    expect(calls).toEqual([]);
  });

  it('a relay that disagrees on the kernel (409) surfaces as an error, not a balance', async () => {
    const { institutions } = bankReturning({ error: 'PVT token changed; refresh protocol discovery' }, 409);
    await expect(institutions.getBalances()).rejects.toMatchObject({ httpStatus: 409 });
  });
});

/**
 * A live read: right after a burn the relay's cached answer can still show the pre-burn PVT. With
 * `{ rpcUrl, address }` PVT is `balanceOf(address)` on the pointer-resolved kernel at the latest block,
 * through the caller's RPC, and the relay's PVT figure is never used — not even when the chain read fails.
 * RED control: on a getBalances that reads PVT only from the relay, the first test reports the stale
 * 1728.9512986704 instead of 1723.9512986704 and the second reports the relay figure.
 */
describe('CommonsInstitutions.getBalances — live PVT read', () => {
  const ADDRESS = '0x5326130a700183a9d934a3aba495d7099ced9885';
  const RPC = 'https://rpc.test/base';
  const STALE = { eth: '0.01', usdc: '3', chain: 'base', token_address: TOKEN, pvt: { status: 'live', address: TOKEN, balance: '1728.9512986704', available: true } };
  const LIVE_ATOMIC = 1723951298670400000000n; // 1723.9512986704 PVT

  function liveBank(rpc: (body: { method: string; params: unknown[] }) => unknown) {
    const relayCalls: string[] = [];
    const rpcBodies: { method: string; params: unknown[] }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.startsWith(RPC)) {
        const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        rpcBodies.push(body);
        const answer = rpc(body);
        return { ok: true, status: 200, json: async () => answer } as Response;
      }
      relayCalls.push(u);
      const body = u.endsWith('/v1/agent/wallet/wallet_aw_test') ? { wallet_id: 'wallet_aw_test', address: ADDRESS } : STALE;
      return { ok: true, status: 200, json: async () => body } as Response;
    };
    return { institutions: new CommonsInstitutions({ ...BASE, fetch: fetchImpl as unknown as typeof fetch }), relayCalls, rpcBodies };
  }

  it('reads balanceOf on the pointer-resolved kernel, not the relay\'s cached pre-burn figure', async () => {
    const { institutions, rpcBodies } = liveBank(() => ({ jsonrpc: '2.0', id: 1, result: '0x' + LIVE_ATOMIC.toString(16).padStart(64, '0') }));
    const b = await institutions.getBalances({ rpcUrl: RPC, address: ADDRESS });
    expect(b).toMatchObject({ pvt: '1723.9512986704', pvtAvailable: true, pvtSource: 'chain', pvtAddress: TOKEN, eth: '0.01', usdc: '3' });
    expect(rpcBodies).toHaveLength(1);
    const call = rpcBodies[0].params[0] as { to: string; data: string };
    expect(call.to).toBe(TOKEN);
    expect(call.to).not.toBe(PREDECESSOR.toLowerCase());
    expect(call.data).toBe('0x70a08231' + ADDRESS.slice(2).padStart(64, '0'));
    expect(rpcBodies[0].params[1]).toBe('latest');
  });

  it('a failed chain read gives no PVT figure — never the relay\'s cached one', async () => {
    const { institutions } = liveBank(() => ({ jsonrpc: '2.0', id: 1, error: { message: 'upstream down' } }));
    const b = await institutions.getBalances({ rpcUrl: RPC, address: ADDRESS });
    expect(b).toMatchObject({ pvt: null, pvtAvailable: false, pvtSource: 'chain_unavailable' });
    expect(b.pvtError).toMatch(/upstream down/);
  });

  it('without an address, reads it from the wallet\'s own record', async () => {
    const { institutions, relayCalls, rpcBodies } = liveBank(() => ({ jsonrpc: '2.0', id: 1, result: '0x' + LIVE_ATOMIC.toString(16) }));
    const b = await institutions.getBalances({ rpcUrl: RPC });
    expect(b.pvt).toBe('1723.9512986704');
    expect(relayCalls).toContain('https://relay.test/v1/agent/wallet/wallet_aw_test');
    expect((rpcBodies[0].params[0] as { data: string }).data.endsWith(ADDRESS.slice(2))).toBe(true);
  });
});
