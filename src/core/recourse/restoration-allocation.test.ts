import { describe, expect, it } from 'vitest';
import { keccak256 } from 'ethers';
import { readRestorationAllocation } from './restoration-allocation';
import { RECOURSE_POOL_ABI } from './pool-abi';
import type { OwnerChainNetwork } from './owner-chain';
const h = (s: string) => `0x${s.repeat(64)}`, a = (s: string) => `0x${s.repeat(40)}`;
function fixture(options: { amount?: bigint; withdrawn?: boolean; absent?: boolean; wrongIdentity?: boolean;
  disagree?: boolean; wrongRuntime?: boolean; wrongToken?: boolean; reorg?: boolean; retired?: boolean } = {}): OwnerChainNetwork {
  let reads = 0;
  return {
    deployment: async () => ({ pointer: a('1'), revision: 1n, manifestHash: options.retired && reads++ > 0 ? h('9') : h('1'), blockHash: h('2'),
      addresses: { recoursePool: a('3'), kernel: a('4'), eligibilityVerifier: a('7'), beneficiaryVerifier: a('7'),
        escrow: a('7'), promises: a('7'), projectPool: a('7'), bonds: a('7'), court: a('7'), settlement: a('7') },
      runtimeHashes: Array.from({ length: 10 }, () => keccak256('0x00')) }),
    rpcs: [0, 1].map(leg => ({ request: async (method: string, params: readonly unknown[]): Promise<unknown> => {
      if (method === 'eth_getCode') return options.wrongRuntime ? '0x01' : '0x00';
      if (method === 'eth_getBlockByHash') return { number: '0x10' };
      if (method === 'eth_getBlockByNumber') return { hash: options.reorg ? h('8') : h('2') };
      if (method !== 'eth_call') throw Error('unexpected_read');
      const call = RECOURSE_POOL_ABI.parseTransaction({ data: (params[0] as { data: string }).data })!;
      if (call.name === 'token') return RECOURSE_POOL_ABI.encodeFunctionResult('token', [options.wrongToken ? a('8') : a('4')]);
      return RECOURSE_POOL_ABI.encodeFunctionResult('restorationAllocations', [options.absent ? h('0') : options.wrongIdentity ? h('8') : h('5'),
        options.disagree && leg === 1 ? 7n : options.amount ?? 10n, options.withdrawn ?? false]);
    } })) as unknown as OwnerChainNetwork['rpcs'],
  };
}
describe('restoration display uses current chain evidence', () => {
  it('distinguishes absent, zero, allocated and delivered amounts', async () => {
    expect(await readRestorationAllocation(h('5'), h('6'), fixture({ absent: true }))).toBeNull();
    expect(await readRestorationAllocation(h('5'), h('6'), fixture({ amount: 0n }))).toEqual({ amountAtomic: '0', withdrawn: false });
    expect(await readRestorationAllocation(h('5'), h('6'), fixture())).toEqual({ amountAtomic: '10', withdrawn: false });
    expect(await readRestorationAllocation(h('5'), h('6'), fixture({ withdrawn: true }))).toEqual({ amountAtomic: '10', withdrawn: true });
  });
  it.each(['wrongIdentity', 'disagree', 'wrongRuntime', 'wrongToken', 'reorg', 'retired'] as const)('refuses %s rather than offering a withdrawal', async fault => {
    await expect(readRestorationAllocation(h('5'), h('6'), fixture({ [fault]: true }))).rejects.toThrow();
  });
});
