import { Interface } from 'ethers';
import { findMembershipSuccessionCheckpoint } from './membership-succession-checkpoint';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { resolveHistoricalProtocolDeployment } from '../protocol/pointer';
import { createRecourseChainPort } from './chain-ledger';
import { RECOURSE_POOL_ABI } from './pool-abi';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../protocol/pointer', () => ({ resolveHistoricalProtocolDeployment: jest.fn() }));
jest.mock('./chain-ledger', () => ({ createRecourseChainPort: jest.fn() }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: { address: '0x0000000000000000000000000000000000000009', runtimeHash: '0x' + '11'.repeat(32) } }));
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function predecessor() view returns(address)',
  'function lastGoodBlock() view returns(uint256)', 'function cryptographicBreak() view returns(bool)', 'function kernel() view returns(address)']);
function setup() {
  const state = { disagreement: false, mismatched: false, cycle: false };
  (createRecourseChainPort as jest.Mock).mockReturnValue({ finalizedBlock: async () => 300, blockHash: async (n: number) => h(n) });
  (resolveHistoricalProtocolDeployment as jest.Mock).mockImplementation(async (_r,_p,_h,n: number) => {
    const pool = n >= 300 ? 5 : n >= 200 ? 3 : 1; return { addresses: { recoursePool: a(pool), kernel: a(pool+1) } };
  });
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0,1].map(index => ({ operatorId: `operator-${index}`, provider: {
    send: async (_method: string, params: readonly unknown[]) => {
      const call = params[0] as { to: string; data: string }, n = Number(call.to), pool = n === 3 || n === 5;
      const contract = pool ? RECOURSE_POOL_ABI : abi, name = contract.parseTransaction({ data: call.data })!.name;
      const current = n >= 5 && n !== 13 ? 5 : 3;
      let values: readonly unknown[];
      if (name === 'poolSnapshot') values = [a(current-2), state.cycle ? 300 : current === 5 ? 200 : 100, h(7), 4, true];
      else if (name === 'poolHistoryReady') values = [true];
      else if (name === 'token') values = [a(current+1)];
      else if (name === 'ownerAuthorization') values = [a(current+10)];
      else if (name === 'kernel') values = [a(current+1)];
      else if (name === 'predecessor') values = [a(current-1 + (state.disagreement && index === 1 ? 1 : 0))];
      else if (name === 'lastGoodBlock') values = [(current === 5 ? 200 : 100) + (state.mismatched ? 1 : 0)];
      else if (name === 'cryptographicBreak') values = [true];
      else throw Error(name);
      return contract.encodeFunctionResult(name,values);
    },
  } })));
  return state;
}
beforeEach(() => jest.resetAllMocks());
test('an offline owner crosses each authenticated successor separately rather than skipping a branch', async () => {
  setup();
  expect(await findMembershipSuccessionCheckpoint({ pool: a(1), kernel: a(2) })).toEqual({
    cutoff: { pool: a(1), kernel: a(2), block: 100, blockHash: h(100) }, successor: { pool: a(3), kernel: a(4), block: 200, blockHash: h(200) },
  });
  expect(await findMembershipSuccessionCheckpoint({ pool: a(3), kernel: a(4) })).toEqual({
    cutoff: { pool: a(3), kernel: a(4), block: 200, blockHash: h(200) }, successor: { pool: a(5), kernel: a(6), block: 300, blockHash: h(300) },
  });
  expect(await findMembershipSuccessionCheckpoint({ pool: a(5), kernel: a(6) })).toBeNull();
});
test('disagreement, mismatched kernel cutoff, cycles and incomplete source domains refuse', async () => {
  const state = setup(); state.disagreement = true;
  await expect(findMembershipSuccessionCheckpoint({ pool: a(1), kernel: a(2) })).rejects.toThrow('disagreement');
  state.disagreement = false; state.mismatched = true;
  await expect(findMembershipSuccessionCheckpoint({ pool: a(1), kernel: a(2) })).rejects.toThrow('ancestry');
  state.mismatched = false; state.cycle = true;
  await expect(findMembershipSuccessionCheckpoint({ pool: a(1), kernel: a(2) })).rejects.toThrow('snapshot');
  state.cycle = false;
  await expect(findMembershipSuccessionCheckpoint({ pool: a(5), kernel: a(2) })).rejects.toThrow('ancestry');
});
