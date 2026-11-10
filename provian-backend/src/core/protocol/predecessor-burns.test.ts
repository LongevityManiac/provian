import { Interface } from 'ethers';
import { predecessorBurnAcceptances } from './predecessor-burns';
import { currentProtocolDeployment } from './runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import type { ProtocolDeployment } from './pointer';
jest.mock('./runtime', () => ({ currentProtocolDeployment: jest.fn() }));
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const current = address(10), prior = address(9), legacy = address(8), executor = address(20), priorExecutor = address(19);
const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)',
  'function predecessor() view returns(address)', 'function lastGoodBlock() view returns(uint256)', 'function previousAuthorization() view returns(address)']);
let disagree = false, cycles = false, reverseCutoff = false;
const deployment = { addresses: { kernel: current }, manifestHash: 'current', blockHash: `0x${'bb'.repeat(32)}` } as ProtocolDeployment;
beforeEach(() => {
  jest.resetAllMocks(); disagree = false; cycles = false; reverseCutoff = false;
  jest.mocked(currentProtocolDeployment).mockResolvedValue(deployment);
  jest.mocked(getOperatorBoundRpcLegs).mockReturnValue([0, 1].map(index => ({ operatorId: String(index),
    provider: { send: async (_method: string, params: readonly unknown[]) => {
      expect(params[1]).toEqual({ blockHash: deployment.blockHash, requireCanonical: true });
      const call = params[0] as { to: string; data: string }, parsed = abi.parseTransaction({ data: call.data })!;
      const value = parsed.name === 'ownerAuthorization' ? executor : parsed.name === 'kernel' ? call.to === executor ? current : prior
        : parsed.name === 'predecessor' ? call.to === executor ? prior : legacy
        : parsed.name === 'previousAuthorization' ? call.to === executor ? priorExecutor : cycles ? executor : address(0)
        : call.to === executor ? 200 : reverseCutoff ? 300 : disagree && index === 1 ? 101 : 100;
      return abi.encodeFunctionResult(parsed.name, [value]);
    } },
  })) as unknown as ReturnType<typeof getOperatorBoundRpcLegs>);
});
test('all ordinary predecessor kernels inherit their exact immutable snapshot cutoff', async () => {
  expect(await predecessorBurnAcceptances(current)).toEqual([{ address: prior, maxBlock: 200 }, { address: legacy, maxBlock: 100 }]);
});
test('provider disagreement, cyclic history and reversed snapshot chronology refuse acceptance', async () => {
  disagree = true; await expect(predecessorBurnAcceptances(current)).rejects.toThrow('disagreement'); disagree = false;
  cycles = true; await expect(predecessorBurnAcceptances(current)).rejects.toThrow('invalid'); cycles = false;
  reverseCutoff = true; await expect(predecessorBurnAcceptances(current)).rejects.toThrow('invalid');
});
test('deployment changes cannot admit a burn using an obsolete current token', async () => {
  await expect(predecessorBurnAcceptances(prior)).rejects.toThrow('changed');
  jest.mocked(currentProtocolDeployment).mockResolvedValueOnce(deployment).mockResolvedValue({ ...deployment, manifestHash: 'new' });
  await expect(predecessorBurnAcceptances(current)).rejects.toThrow('changed');
});
