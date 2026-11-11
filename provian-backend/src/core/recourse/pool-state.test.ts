import { currentProtocolDeployment } from '../protocol/runtime';
jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: jest.fn() }));
import { Interface, keccak256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { readAgreedBaseBlockHash, readAgreedBaseHead } from '../onchain/economic-discovery';
import { requireConfiguredPvt9Runtime } from '../pvt/pvt9-base-config.generated';
import { readRecoursePoolState, RECOURSE_POOL_ABI, recoursePoolConfig } from './pool-state';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../onchain/economic-discovery', () => ({ readAgreedBaseBlockHash: jest.fn(), readAgreedBaseHead: jest.fn() }));
const pool = `0x${'12'.repeat(20)}`;
const identity = `0x${'34'.repeat(32)}`;
const blockHash = `0x${'56'.repeat(32)}`;
const kernel = requireConfiguredPvt9Runtime().address.toLowerCase();
const token = new Interface(['function restorationAuthority() view returns (address)']);
let reorg = false;
let disagreement = false;
let wrongToken = false;
let code = '0x6000';
const saved = { address: process.env.PVT_RECOURSE_POOL_ADDRESS, hash: process.env.PVT_RECOURSE_POOL_RUNTIME_HASH };
beforeEach(() => {
  jest.resetAllMocks();
  (currentProtocolDeployment as jest.Mock).mockResolvedValue({ blockHash, manifestHash: identity, addresses: { kernel, recoursePool: pool }, runtimeHashes: Array(10).fill(keccak256('0x6000')) });
  reorg = false; disagreement = false; wrongToken = false; code = '0x6000';
  process.env.PVT_RECOURSE_POOL_ADDRESS = pool;
  process.env.PVT_RECOURSE_POOL_RUNTIME_HASH = keccak256(code);
  (readAgreedBaseHead as jest.Mock).mockResolvedValue(100);
  (readAgreedBaseBlockHash as jest.Mock).mockResolvedValue(blockHash);
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0, 1].map(index => ({ operatorId: `operator-${index}`,
    provider: { send: jest.fn(async (method: string, args: readonly unknown[]) => {
      if (method === 'eth_getBlockByHash') return { hash: blockHash, number: '0x64', timestamp: '0x697e8680' };
      if (method === 'eth_getBlockByNumber') return { hash: reorg ? identity : blockHash };
      expect(args[1]).toEqual({ blockHash, requireCanonical: true });
      if (method === 'eth_getCode') return code;
      const call = args[0] as { to: string; data: string };
      if (call.to === kernel) return token.encodeFunctionResult('restorationAuthority', [pool]);
      const parsed = RECOURSE_POOL_ABI.parseTransaction({ data: call.data });
      if (!parsed) throw new Error('unexpected method');
      const values: Record<string, readonly unknown[]> = {
        token: [wrongToken ? pool : kernel], addressConsent: [1, 1, true], debitNonce: [7], poolHistoryReady: [true],
        calendarMonth: [24312], consentAccount: [pool], allocatedRestorations: [50], outcomeRevision: [2],
        monthlyRule: [[0, 100, 100, 100, identity]],
        availableReserve: [disagreement && index === 1 ? 101 : 100],
        };
      return RECOURSE_POOL_ABI.encodeFunctionResult(parsed.name, values[parsed.name]);
    }) },
  })));
});
afterAll(() => {
  if (saved.address === undefined) delete process.env.PVT_RECOURSE_POOL_ADDRESS;
  else process.env.PVT_RECOURSE_POOL_ADDRESS = saved.address;
  if (saved.hash === undefined) delete process.env.PVT_RECOURSE_POOL_RUNTIME_HASH;
  else process.env.PVT_RECOURSE_POOL_RUNTIME_HASH = saved.hash;
});
test('same-block member state and reserve agree across independent operators', async () => {
  expect(await readRecoursePoolState(identity)).toMatchObject({ pool, kernel, addressConsent: true, consentGeneration: '1', consentNonce: '1', debitNonce: '7',
    reserveAtomic: '100', outstandingAtomic: '50', participationBurnAtomic: '100',
    noEarningsContributionAtomic: '100', earningsBps: 100, block: 100, blockHash });
});
test('disagreement, altered runtime and wrong token each refuse the pool', async () => {
  disagreement = true;
  await expect(readRecoursePoolState(identity)).rejects.toThrow('recourse_pool_rpc_disagreement');
  disagreement = false; code = '0x6001';
  await expect(readRecoursePoolState(identity)).rejects.toThrow('recourse_pool_runtime_mismatch');
  code = '0x6000'; wrongToken = true;
  await expect(readRecoursePoolState(identity)).rejects.toThrow('recourse_pool_token_mismatch');
});
test('reorg and incomplete configuration fail closed', async () => {
  reorg = true;
  await expect(readRecoursePoolState(identity)).rejects.toThrow('recourse_pool_reorg');
  (currentProtocolDeployment as jest.Mock).mockRejectedValue(new Error('protocol_pointer_not_deployed'));
  await expect(recoursePoolConfig()).rejects.toThrow('protocol_pointer_not_deployed');
});
