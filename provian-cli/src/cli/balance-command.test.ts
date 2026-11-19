/**
 * `provian balance` reads PVT live: it hands the SDK a Base RPC (--rpc-url, else PROVIAN_BASE_RPC_URL,
 * else Base's public endpoint) so PVT is `balanceOf` on the pointer-resolved kernel, not the relay's
 * cached figure that can still show the pre-burn balance. RED control (before this change):
 * getBalances was called with no live read and the output had no pvt_source.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommonsInstitutions } from '@provian/agent-sdk';
import { cmdBalance } from './commons-institutions-commands';

const saved = { ...process.env };
beforeEach(() => {
  process.env.PROVIAN_API_KEY = 'pvn_live_test';
  process.env.PROVIAN_API_SECRET = 'pvns_' + 'x'.repeat(64);
  process.env.PROVIAN_AGENT_WALLET_ID = 'wallet_aw_test';
  delete process.env.PROVIAN_BASE_RPC_URL;
});
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

describe('provian balance', () => {
  it('asks for a live PVT read through the Base RPC and prints where PVT came from', async () => {
    const spy = vi.spyOn(CommonsInstitutions.prototype, 'getBalances').mockResolvedValue({
      eth: '0.01', usdc: '3', pvt: '1723.9512986704', pvtAvailable: true, pvtAddress: '0x2af3a065dc3c0c51b054cb8c6baee7df76189e0e', pvtSource: 'chain', chain: 'base',
    });
    const r = await cmdBalance({});
    expect(spy).toHaveBeenCalledWith({ rpcUrl: 'https://mainnet.base.org' });
    expect(r).toMatchObject({ pvt: '1723.9512986704', pvt_source: 'chain', pvt_address: '0x2af3a065dc3c0c51b054cb8c6baee7df76189e0e' });
    process.env.PROVIAN_BASE_RPC_URL = 'https://rpc.example';
    await cmdBalance({});
    expect(spy).toHaveBeenLastCalledWith({ rpcUrl: 'https://rpc.example' });
    await cmdBalance({ 'rpc-url': 'https://flag.example', address: '0x5326130a700183a9d934a3aba495d7099ced9885' });
    expect(spy).toHaveBeenLastCalledWith({ rpcUrl: 'https://flag.example', address: '0x5326130a700183a9d934a3aba495d7099ced9885' });
  });

  it('a failed live read prints no PVT figure and the fix', async () => {
    vi.spyOn(CommonsInstitutions.prototype, 'getBalances').mockResolvedValue({
      eth: '0.01', usdc: '3', pvt: null, pvtAvailable: false, pvtAddress: '0x2af3a065dc3c0c51b054cb8c6baee7df76189e0e', pvtSource: 'chain_unavailable', pvtError: 'rate limited', chain: 'base',
    });
    const r = await cmdBalance({});
    expect(r).toMatchObject({ pvt: null, pvt_source: 'chain_unavailable' });
    expect(String((r as { pvt_error: string }).pvt_error)).toMatch(/rate limited.*--rpc-url/);
  });
});
