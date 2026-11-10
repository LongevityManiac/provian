jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: async () => ({ addresses: { kernel: requireConfiguredPvt9Runtime().address, recoursePool: `0x${'12'.repeat(20)}` }, runtimeHashes: Array(10).fill(keccak256('0x6000')) }) }));
import { AbiCoder, Interface, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash, readAgreedBaseHead } from '../onchain/economic-discovery';
import { requireConfiguredPvt9Runtime } from '../pvt/pvt9-base-config.generated';
import { RECOURSE_POOL_ABI } from './pool-state';
import { refreshRecoursePoolRatio, RECOURSE_RATIO_COLLECTION } from './pool-ratio';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../onchain/economic-discovery', () => ({ getAgreedBaseLogs: jest.fn(), readAgreedBaseBlockHash: jest.fn(), readAgreedBaseHead: jest.fn() }));
const pool = `0x${'12'.repeat(20)}`, account = `0x${'13'.repeat(20)}`, identity = `0x${'14'.repeat(32)}`;
const blockHash = `0x${'15'.repeat(32)}`, kernel = requireConfiguredPvt9Runtime().address.toLowerCase();
const token = new Interface(['function balanceOf(address) view returns (uint256)']);
const old = { ...process.env };
let wrongBirth = false, disagree = false, enrolled = true;
beforeEach(() => {
  jest.resetAllMocks(); wrongBirth = false; disagree = false; enrolled = true;
  process.env.PVT_RECOURSE_POOL_ADDRESS = pool;
  process.env.PVT_RECOURSE_POOL_RUNTIME_HASH = keccak256('0x6000');
  process.env.PVT_RECOURSE_POOL_DEPLOYMENT_BLOCK = '10';
  (readAgreedBaseHead as jest.Mock).mockResolvedValue(100);
  (readAgreedBaseBlockHash as jest.Mock).mockResolvedValue(blockHash);
  const event = RECOURSE_POOL_ABI.encodeEventLog(RECOURSE_POOL_ABI.getEvent('AddressBound')!, [identity, account]);
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([{ ...event, address: pool, removed: false, blockNumber: 11, blockHash }]);
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0, 1].map(index => ({ operatorId: `rpc-${index}`,
    provider: { send: jest.fn(async (method: string, params: readonly unknown[]) => {
      if (method === 'eth_getCode') return typeof params[1] === 'string' && BigInt(params[1]) < 10n && !wrongBirth ? '0x' : '0x6000';
      expect(params[1]).toEqual({ blockHash, requireCanonical: true });
      const call = params[0] as { to: string; data: string };
      if (call.to === kernel) {
        const address = String(token.parseTransaction({ data: call.data })!.args[0]).toLowerCase();
        return token.encodeFunctionResult('balanceOf', [address === pool ? 10 : disagree && index === 1 ? 101 : 100]);
      }
      const parsed = RECOURSE_POOL_ABI.parseTransaction({ data: call.data })!;
      const values: Record<string, readonly unknown[]> = { token: [kernel], ownerOf: [identity],
        membershipState: [enrolled, false, 1, 0], availableReserve: [10] };
      return RECOURSE_POOL_ABI.encodeFunctionResult(parsed.name, values[parsed.name]);
    }) } })));
});
afterAll(() => {
  for (const name of ['PVT_RECOURSE_POOL_ADDRESS', 'PVT_RECOURSE_POOL_RUNTIME_HASH', 'PVT_RECOURSE_POOL_DEPLOYMENT_BLOCK']) {
    if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name];
  }
});
test('publishes a same-block aggregate without member identities or addresses', async () => {
  const fake = createFakeFirestore();
  await refreshRecoursePoolRatio(fake as unknown as Firestore);
  const row = fake.store.get(`${RECOURSE_RATIO_COLLECTION}/${pool}`);
  expect(row).toMatchObject({ memberCount: 1, addressCount: 1, reserveAtomic: '10', memberBalanceAtomic: '100',
    ratio: { numerator: '10', denominator: '100' }, block: 100, blockHash });
  expect(JSON.stringify(row)).not.toContain(identity);
  expect(JSON.stringify(row)).not.toContain(account);
});
test('a closed member contributes no denominator and an empty population has no ratio', async () => {
  enrolled = false;
  const fake = createFakeFirestore();
  await refreshRecoursePoolRatio(fake as unknown as Firestore);
  expect(fake.store.get(`${RECOURSE_RATIO_COLLECTION}/${pool}`)).toMatchObject({ memberCount: 0, memberBalanceAtomic: '0', ratio: null });
});
test('a late deployment boundary or balance disagreement cannot publish an understated denominator', async () => {
  const fake = createFakeFirestore(); wrongBirth = true;
  await expect(refreshRecoursePoolRatio(fake as unknown as Firestore)).rejects.toThrow('recourse_pool_deployment_block_invalid');
  wrongBirth = false; disagree = true;
  await expect(refreshRecoursePoolRatio(fake as unknown as Firestore)).rejects.toThrow('recourse_pool_rpc_disagreement');
  expect(fake.store.size).toBe(0);
});

test('successor imports count every carried member address without a rebuilt deployment block', async () => {
  delete process.env.PVT_RECOURSE_POOL_DEPLOYMENT_BLOCK;
  const abi = new Interface(['event PoolStateImported(uint8 indexed kind,bytes32 indexed slot,bytes32 leaf,bytes data)']);
  const data = AbiCoder.defaultAbiCoder().encode(['address','bytes32'],[account,identity]);
  const event = abi.encodeEventLog(abi.getEvent('PoolStateImported')!,[7,`0x${'aa'.repeat(32)}`,`0x${'bb'.repeat(32)}`,data]);
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([{ ...event, address: pool, removed: false, blockNumber: 11, blockHash }]);
  const fake = createFakeFirestore(); await refreshRecoursePoolRatio(fake as unknown as Firestore);
  expect(fake.store.get(`${RECOURSE_RATIO_COLLECTION}/${pool}`)).toMatchObject({ memberCount: 1, memberBalanceAtomic: '100', addressCount: 1 });
  disagree = true;
  await expect(refreshRecoursePoolRatio(fake as unknown as Firestore)).rejects.toThrow('rpc_disagreement');
});
