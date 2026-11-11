import { createDeterminationExecutionPort } from './determination-execution';
import { HISTORICAL_BINDING_ABI as abi } from './restoration-binding-log';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { readAgreedBaseBlockHash } from '../onchain/economic-discovery';
import { assessRestoration } from './determination';
import { packetFixture } from './__test-helpers__/determination-fixture';
import { address, hash } from './__test-helpers__/restoration-evidence-fixture';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../onchain/economic-discovery', () => ({ ...jest.requireActual<typeof import('../onchain/economic-discovery')>('../onchain/economic-discovery'), readAgreedBaseBlockHash: jest.fn() }));
test('production execution uses the original pinned registry instead of a reset current registry returning unbound', async () => {
  const f = await packetFixture(), value = assessRestoration(f.packet, f.judgment), original = address(80), current = address(81), pointer = address(82);
  const calls: Array<{ target: string; pin: unknown }> = [];
  (readAgreedBaseBlockHash as jest.Mock).mockResolvedValue(f.snapshot.blockHash);
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0, 1].map(index => ({ operatorId: `rpc-${index}`, provider: {
    send: async (method: string, params: readonly unknown[]) => {
      if (method !== 'eth_call') throw Error('unexpected RPC');
      const request = params[0] as { to: string; data: string }, call = abi.parseTransaction({ data: request.data })!;
      calls.push({ target: request.to, pin: params[1] });
      const values: Record<string, unknown> = { registryOperator: original, protocolPointer: pointer, pointer,
        boundBlock: request.to === current ? 0 : f.snapshot.block - 1, ownerOf: f.snapshot.identity };
      return abi.encodeFunctionResult(call.name, [values[call.name]]);
    },
  } })));
  await expect(createDeterminationExecutionPort().bindingLog(value, current)).resolves.toBe(0);
  expect(calls.some(call => call.target === original)).toBe(true);
  expect(calls.some(call => call.target === current)).toBe(false);
  expect(calls.every(call => JSON.stringify(call.pin) === JSON.stringify({ blockHash: f.snapshot.blockHash, requireCanonical: true }))).toBe(true);
  (readAgreedBaseBlockHash as jest.Mock).mockResolvedValue(hash(999));
  await expect(createDeterminationExecutionPort().bindingLog(value, current)).rejects.toThrow(/reorg/);
});
