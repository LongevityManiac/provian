import { expect, it } from 'vitest';
import { Interface, keccak256 } from 'ethers';
import { readRecoursePoolChain } from './recourse-pool-chain';
import { RECOURSE_POOL_ABI } from './recourse-pool-abi';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import type { ProtocolDeployment } from './protocol-pointer';
const pool = `0x${'12'.repeat(20)}`, kernel = `0x${'13'.repeat(20)}`, identity = `0x${'34'.repeat(32)}`;
const blockHash = `0x${'56'.repeat(32)}`, code = '0x6000';
const token = new Interface(['function restorationAuthority() view returns(address)']);
function network(options: { disagree?: boolean; wrongToken?: boolean; reorg?: boolean; changed?: boolean } = {}): OwnerChainNetwork {
  let deployments = 0;
  const rpc = (index: number): OwnerChainNetwork['rpcs'][0] => ({ async request(method: string, args: readonly unknown[]) {
    if (method === 'eth_getBlockByHash') return { hash: blockHash, number: '0x64', timestamp: '0x697e8680' };
    if (method === 'eth_getBlockByNumber') return { hash: options.reorg ? identity : blockHash };
    expect(args[1]).toEqual({ blockHash, requireCanonical: true });
    if (method === 'eth_getCode') return code;
    const call = args[0] as { to: string; data: string };
    if (call.to === kernel) return token.encodeFunctionResult('restorationAuthority', [pool]);
    const parsed = RECOURSE_POOL_ABI.parseTransaction({ data: call.data });
    if (!parsed) throw new Error('unexpected_method');
    const values: Record<string, readonly unknown[]> = {
      token: [options.wrongToken ? pool : kernel], membershipState: [true, false, 1, 0], enrollment: [true, 24312, 24312, 24312, 0, 1],
      calendarMonth: [24312], primaryAddress: [pool], allocatedRestorations: [50], outcomeRevision: [2],
      monthlyRule: [[0, 100, 100, 100, identity]], reserveGeneration: [0], totalReserveShares: [100],
      accountedBacking: [80], availableReserve: [options.disagree && index === 1 ? 101 : 100], reserveShares: [25],
      obligations: [true, false, 100, 0, 100, 0, 100, 100, 0],
    };
    return RECOURSE_POOL_ABI.encodeFunctionResult(parsed.name, values[parsed.name]);
  } });
  const deployment: ProtocolDeployment = { pointer: pool, revision: 1n, blockHash,
    addresses: { kernel, recoursePool: pool, eligibilityVerifier: pool, beneficiaryVerifier: pool,
      escrow: pool, promises: pool, projectPool: pool, bonds: pool, court: pool, settlement: pool },
    runtimeHashes: Array<string>(10).fill(keccak256(code)), manifestHash: 'current' };
  return { deployment: async () => ({ ...deployment,
    manifestHash: options.changed && deployments++ > 0 ? 'changed' : 'current' }), rpcs: [rpc(0), rpc(1)] };
}
it('reads membership and redeemable reserve interest with no relay transport', async () => {
  expect(await readRecoursePoolChain(identity, network())).toMatchObject({ pool, kernel, enrolled: true,
    reserveAtomic: '100', outstandingAtomic: '50', grace: false, participationBurnAtomic: '100',
    noEarningsContributionAtomic: '100', earningsBps: 100, redeemableAtomic: '20', unpaidAtomic: '0', block: 100, blockHash });
});
it('disagreement, wrong token, reorganization and changed deployment refuse the financial view', async () => {
  await expect(readRecoursePoolChain(identity, network({ disagree: true }))).rejects.toThrow('disagreement');
  await expect(readRecoursePoolChain(identity, network({ wrongToken: true }))).rejects.toThrow('token_mismatch');
  await expect(readRecoursePoolChain(identity, network({ reorg: true }))).rejects.toThrow('reorg');
  await expect(readRecoursePoolChain(identity, network({ changed: true }))).rejects.toThrow('deployment_changed');
});
