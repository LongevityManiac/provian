import { Interface, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash, readAgreedBaseHead } from '../onchain/economic-discovery';
import { RECOURSE_POOL_ABI } from './pool-state';
import { refreshRecoursePoolRatio, publicRecourseResources, RECOURSE_RATIO_COLLECTION } from './pool-ratio';
jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: async () => ({ addresses: { kernel: `0x${'11'.repeat(20)}`, recoursePool: `0x${'12'.repeat(20)}` }, runtimeHashes: Array(10).fill(require('ethers').keccak256('0x6000')) }) }));
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../onchain/economic-discovery', () => ({ getAgreedBaseLogs: jest.fn(), readAgreedBaseBlockHash: jest.fn(), readAgreedBaseHead: jest.fn() }));
const pool = `0x${'12'.repeat(20)}`, blockHash = `0x${'15'.repeat(32)}`, kernel = `0x${'11'.repeat(20)}`, txHash = `0x${'16'.repeat(32)}`;
const abi = new Interface(['event RestorationRatio(uint256 availableReserve,uint256 acceptedShortfall,uint256 distributable)']);
let wrongBirth = false, disagree = false;
const log = (available = 10, accepted = 100, distributable = 10) => ({ address: pool, removed: false, blockNumber: 11, blockHash, logIndex: 5, transactionHash: txHash,
  ...abi.encodeEventLog(abi.getEvent('RestorationRatio')!, [available, accepted, distributable]) });
beforeEach(() => {
  jest.resetAllMocks(); wrongBirth = false; disagree = false;
  (readAgreedBaseHead as jest.Mock).mockResolvedValue(100);
  (readAgreedBaseBlockHash as jest.Mock).mockResolvedValue(blockHash);
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([log()]);
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0, 1].map(index => ({ operatorId: `rpc-${index}`,
    provider: { send: jest.fn(async (method: string, params: readonly unknown[]) => {
      if (method === 'eth_getCode') return typeof params[1] === 'string' && BigInt(params[1]) < 10n && !wrongBirth ? '0x' : '0x6000';
      expect(params[1]).toEqual({ blockHash, requireCanonical: true });
      const call = params[0] as { to: string; data: string }; expect(call.to).toBe(pool);
      const parsed = RECOURSE_POOL_ABI.parseTransaction({ data: call.data })!;
      const values: Record<string, readonly unknown[]> = { token: [kernel], availableReserve: [disagree && index === 1 ? 4 : 3], allocatedRestorations: [10] };
      // No member address, balance or identity getter may be consulted.
      expect(Object.keys(values)).toContain(parsed.name);
      return RECOURSE_POOL_ABI.encodeFunctionResult(parsed.name, values[parsed.name]);
    }) } })));
});
test('publishes executed allocation ratio separately from current reserves without portfolio fields or queries', async () => {
  const fake = createFakeFirestore(); await refreshRecoursePoolRatio(fake as unknown as Firestore);
  const row = fake.store.get(`${RECOURSE_RATIO_COLLECTION}/${pool}`)!;
  expect(row).toMatchObject({ reserveAtomic: '3', allocatedAtomic: '10', block: 100,
    ratio: { numerator: '10', denominator: '100', availableAtAllocationAtomic: '10', block: 11, logIndex: 5, transactionHash: txHash } });
  expect(Object.keys(row).sort()).toEqual(['allocatedAtomic','block','blockHash','kernel','observedAtMs','pool','ratio','reserveAtomic','schema']);
  expect(publicRecourseResources({ ...row, privateOwner: 'secret', memberBalanceAtomic: '123', ratio: { ...row.ratio as object, members: ['secret'] } }, pool)).toEqual(row);
  expect(() => publicRecourseResources({ ...row, schema: undefined, memberBalanceAtomic: '123' }, pool)).toThrow('invalid');
});
test('before this pool executes a batch its ratio is absent, not a guessed portfolio ratio', async () => {
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([]);
  const fake = createFakeFirestore(); await refreshRecoursePoolRatio(fake as unknown as Firestore);
  expect(fake.store.get(`${RECOURSE_RATIO_COLLECTION}/${pool}`)).toMatchObject({ ratio: null, reserveAtomic: '3' });
});
test('runtime boundary or reserve disagreement cannot publish', async () => {
  const fake = createFakeFirestore(); wrongBirth = true;
  await expect(refreshRecoursePoolRatio(fake as unknown as Firestore)).rejects.toThrow('deployment_block_invalid');
  wrongBirth = false; disagree = true;
  await expect(refreshRecoursePoolRatio(fake as unknown as Firestore)).rejects.toThrow('rpc_disagreement');
  expect(fake.store.size).toBe(0);
});
test('zero denominator, altered ratio, wrong emitter, omitted position, removed and reordered events refuse', async () => {
  for (const events of [[log(10,0,0)], [log(10,100,11)], [{ ...log(), address: kernel }], [{ ...log(), logIndex: undefined }],
    [{ ...log(), removed: true }], [log(), log()], [{ ...log(), blockNumber: 101 }]]) {
    const fake = createFakeFirestore(); (getAgreedBaseLogs as jest.Mock).mockResolvedValue(events);
    await expect(refreshRecoursePoolRatio(fake as unknown as Firestore)).rejects.toThrow(); expect(fake.store.size).toBe(0);
  }
});
