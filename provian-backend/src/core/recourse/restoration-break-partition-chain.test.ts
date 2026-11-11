import { Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { breakPartitionChainPort } from './restoration-break-partition-chain';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash } from '../onchain/economic-discovery';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../onchain/economic-discovery', () => ({ getAgreedBaseLogs: jest.fn(), readAgreedBaseBlockHash: jest.fn() }));
jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: jest.fn() }));
jest.mock('./break-artifact-store', () => ({ readStoredBreakArtifact: jest.fn() }));
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const abi = new Interface(['function pointer() view returns(address)', 'function previousRegistry() view returns(address)',
  'function ownerOf(address) view returns(bytes32)', 'function boundBlock(address) view returns(uint256)',
  'event OwnershipBound(bytes32 indexed identity,address indexed account,address indexed kernel,bytes32 recoveryCommitment,bytes32 signingRoot,bytes32 digest)',
  'event RecoveredAddressBound(bytes32 indexed identity,address indexed account,address indexed kernel)']);
let mode = '';
beforeEach(() => {
  jest.resetAllMocks(); mode = '';
  (readAgreedBaseBlockHash as jest.Mock).mockImplementation(async height => h(height));
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0, 1].map(index => ({ operatorId: `operator-${index}`, provider: {
    async send(method: string, args: readonly unknown[]) {
      if (method === 'eth_getCode') {
        const target = String(args[0]), pin = args[1] as { blockHash: string; requireCanonical: boolean };
        expect(pin.requireCanonical).toBe(true);
        const block = Number(BigInt(pin.blockHash)), birth = target === a(40) ? 80 : 50;
        if (mode === 'genesis') return '0x6001';
        if (block < birth) return '0x';
        if (mode === 'changed-code' && block < 100) return '0x6009';
        return target === a(40) ? '0x6001' : '0x6002';
      }
      expect(method).toBe('eth_call');
      expect(args[1]).toEqual({ blockHash: h(100), requireCanonical: true });
      const tx = args[0] as { to: string; data: string }, decoded = abi.parseTransaction({ data: tx.data })!;
      let result: unknown;
      if (decoded.name === 'pointer') result = mode === 'pointer' || mode === 'disagreement' && index === 1 ? a(51) : a(50);
      else if (decoded.name === 'previousRegistry') result = tx.to === a(40) ? a(41) : mode === 'cycle' ? a(40) : a(0);
      else if (decoded.name === 'ownerOf') result = mode === 'owner' ? h(2) : h(1);
      else if (decoded.name === 'boundBlock') result = mode === 'birth' ? 61 : String(decoded.args[0]).toLowerCase() === a(1) ? 60 : 90;
      else throw Error(decoded.name);
      return abi.encodeFunctionResult(decoded.name, [result]);
    },
  } })));
  (getAgreedBaseLogs as jest.Mock).mockImplementation(async filter => {
    const current = filter.address === a(40), block = current ? 90 : 60;
    expect(filter.fromBlock).toBe(current ? 80 : 50); expect(filter.toBlock).toBe(100); expect(filter.topics[1]).toBe(h(1));
    const event = abi.getEvent(current ? 'OwnershipBound' : 'RecoveredAddressBound')!;
    const args = [mode === 'foreign-log' ? h(2) : h(1), current ? a(2) : a(1), a(10), ...(current ? [h(2), h(3), h(4)] : [])];
    const log = { ...abi.encodeEventLog(event, args), address: filter.address, blockNumber: block, blockHash: h(block),
      transactionHash: h(200 + block), logIndex: 0, removed: mode === 'removed' };
    return mode === 'duplicate-log' ? [log, log] : [log];
  });
});
const read = () => breakPartitionChainPort({} as Firestore).registryAccounts(a(40), h(1), 100, h(100), a(50));
test('enumerates complete canonical binding history from independently discovered registry births', async () => {
  expect(await read()).toEqual([a(1), a(2)]);
  expect(getAgreedBaseLogs).toHaveBeenCalledTimes(2);
  expect(readAgreedBaseBlockHash).toHaveBeenCalledWith(79);
  expect(readAgreedBaseBlockHash).toHaveBeenCalledWith(49);
});
test.each(['genesis', 'changed-code', 'pointer', 'disagreement', 'cycle', 'owner', 'birth', 'foreign-log', 'removed', 'duplicate-log'])(
  'refuses %s rather than substituting artifact-supplied account metadata', async invalid => {
    mode = invalid; await expect(read()).rejects.toThrow();
  });
test('a reorg of the final cutoff after earlier historical checks invalidates the entire enumeration', async () => {
  let cutoffReads = 0;
  (readAgreedBaseBlockHash as jest.Mock).mockImplementation(async height => {
    if (height === 100 && ++cutoffReads > 1) return h(999);
    return h(height);
  });
  await expect(read()).rejects.toThrow('reorg');
});
