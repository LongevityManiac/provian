import { expect, it } from 'vitest';
import { keccak256 } from 'ethers';
import { prepareRestorationExit } from './recourse-restoration-exit';
import { RECOURSE_POOL_ABI } from './recourse-pool-abi';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import type { ProtocolDeployment } from './protocol-pointer';
const pool = `0x${'12'.repeat(20)}`, kernel = `0x${'13'.repeat(20)}`, identity = `0x${'34'.repeat(32)}`;
const request = `0x${'44'.repeat(32)}`, blockHash = `0x${'56'.repeat(32)}`, code = '0x6000';
function network(options: { foreign?: boolean; zero?: boolean; withdrawn?: boolean; disagree?: boolean; runtime?: boolean; token?: boolean; changed?: boolean } = {}): OwnerChainNetwork {
  let reads = 0;
  const deployment: ProtocolDeployment = { pointer: pool, revision: 1n, blockHash,
    addresses: { kernel, recoursePool: pool, eligibilityVerifier: pool, beneficiaryVerifier: pool,
      escrow: pool, promises: pool, projectPool: pool, bonds: pool, court: pool, settlement: pool },
    runtimeHashes: Array<string>(10).fill(keccak256(code)), manifestHash: 'current' };
  const rpc = (index: number): OwnerChainNetwork['rpcs'][0] => ({ async request(method, args) {
    expect(args[1]).toEqual({ blockHash, requireCanonical: true });
    if (method === 'eth_getCode') return options.runtime ? '0x6001' : code;
    expect(method).toBe('eth_call');
    const call = args[0] as { to: string; data: string };
    expect(call.to).toBe(pool);
    const parsed = RECOURSE_POOL_ABI.parseTransaction({ data: call.data });
    if (parsed?.name === 'token') return RECOURSE_POOL_ABI.encodeFunctionResult('token', [options.token ? pool : kernel]);
    expect(parsed?.name).toBe('restorationAllocations');
    expect(parsed?.args[0]).toBe(request);
    return RECOURSE_POOL_ABI.encodeFunctionResult('restorationAllocations', [options.foreign ? request : identity,
      options.zero ? 0 : options.disagree && index === 1 ? 11 : 10, options.withdrawn === true]);
  } });
  return { deployment: async () => ({ ...deployment, manifestHash: options.changed && reads++ > 0 ? 'changed' : 'current' }), rpcs: [rpc(0), rpc(1)] };
}
it('prepares delivery with only chain RPCs and cannot choose a recipient', async () => {
  const result = await prepareRestorationExit(identity, request, network());
  expect(result).toMatchObject({ pool, identity, request, amountAtomic: '10' });
  const call = RECOURSE_POOL_ABI.parseTransaction({ data: result.data });
  expect(call?.name).toBe('deliverRestoration');
  expect([...call!.args]).toEqual([request, identity]);
});
it('refuses foreign, consumed, empty, changed or unverifiable allocations', async () => {
  for (const option of ['foreign', 'zero', 'withdrawn', 'disagree', 'runtime', 'token', 'changed'] as const) {
    await expect(prepareRestorationExit(identity, request, network({ [option]: true }))).rejects.toThrow(/recourse_/);
  }
  await expect(prepareRestorationExit('0x' + '0'.repeat(64), request, network())).rejects.toThrow('identifier_invalid');
});
it('the client surface has no contribution refund entry point', () => {
  expect(RECOURSE_POOL_ABI.getFunction('redeem')).toBeNull();
  expect(RECOURSE_POOL_ABI.getFunction('reserveShares')).toBeNull();
});
