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
