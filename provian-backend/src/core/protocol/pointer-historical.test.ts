import { AbiCoder, Interface, keccak256 } from 'ethers';
import { resolveHistoricalProtocolDeployment, resetHistoricalProtocolVerification, type PointerRpc } from './pointer';

const pointer = `0x${'01'.repeat(20)}`;
const runtime = '0x60006000f3';
const runtimeHash = keccak256(runtime);
const addresses = Array.from({ length: 10 }, (_, i) => `0x${(i + 100).toString(16).padStart(40, '0')}`);
const hashes = addresses.map(() => runtimeHash);
const abi = new Interface(['function current() view returns (uint256,bytes32,address[10],bytes32[10])']);
const hashOf = (height: number) => `0x${height.toString(16).padStart(64, '0')}`;

function manifest(revision: bigint): string {
  const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'address[10]', 'bytes32[10]'],
    [8453, pointer, revision, addresses, hashes]));
  return abi.encodeFunctionResult('current', [revision, digest, addresses, hashes]);
}

/** A chain where block N has hash hashOf(N) and the pointer serves `revisionAt(N)`. */
function rpc(options: { revisionAt?: (height: number) => bigint; count?: (method: string) => void } = {}): PointerRpc {
  const revisionAt = options.revisionAt ?? (() => 1n);
  const heightOf = (tag: unknown): number => {
    const hash = (tag as { blockHash?: string }).blockHash;
    if (typeof hash !== 'string') throw new Error('unexpected_tag');
    return Number(BigInt(hash));
  };
  return { async request(method, params) {
    options.count?.(method);
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber') { const n = Number(BigInt(params[0] as string)); return { number: params[0], hash: hashOf(n) }; }
    if (method === 'eth_getCode') return runtime;
    if (method === 'eth_call') {
      const call = params[0] as { data: string };
      if (call.data === abi.encodeFunctionData('current')) return manifest(revisionAt(heightOf(params[1])));
      const getters = ['KERNEL', 'pvt', 'epochClock', 'token', 'kernel', 'settlement', 'pool', 'protocolPointer', 'pointer'];
      for (const getter of getters) {
        const binding = new Interface([`function ${getter}() view returns(address)`]);
        if (call.data === binding.encodeFunctionData(getter)) {
          const target = getter === 'settlement' ? addresses[9] : getter === 'pool' ? addresses[8]
            : getter === 'protocolPointer' || getter === 'pointer' ? pointer : addresses[0];
          return binding.encodeFunctionResult(getter, [target]);
        }
      }
      return '0x';
    }
    throw new Error('unexpected_rpc');
  } };
}

function counted(revisionAt?: (height: number) => bigint) {
  const counts = [0, 0];
  const legs = [rpc({ revisionAt, count: () => ++counts[0] }), rpc({ revisionAt, count: () => ++counts[1] })] as const;
  return { counts, legs };
}

beforeEach(() => resetHistoricalProtocolVerification());

test('a later block with the same manifest reuses the full verification and costs 5 calls per provider', async () => {
  const { counts, legs } = counted();
  const first = await resolveHistoricalProtocolDeployment(legs, pointer, runtimeHash, 100, hashOf(100));
  expect(counts[0]).toBeGreaterThan(30);
  counts.fill(0);
  const later = await resolveHistoricalProtocolDeployment(legs, pointer, runtimeHash, 250, hashOf(250));
  expect(counts).toEqual([5, 5]);
  // Identical to what a full resolve at that block returns.
  resetHistoricalProtocolVerification();
  const full = await resolveHistoricalProtocolDeployment(legs, pointer, runtimeHash, 250, hashOf(250));
  expect(later).toEqual(full);
  expect(later).toEqual({ ...first, blockHash: hashOf(250) });
});

test('RED: a block before the verified one is verified in full again', async () => {
  const { counts, legs } = counted();
  await resolveHistoricalProtocolDeployment(legs, pointer, runtimeHash, 200, hashOf(200));
  counts.fill(0);
  await resolveHistoricalProtocolDeployment(legs, pointer, runtimeHash, 150, hashOf(150));
  expect(counts[0]).toBeGreaterThan(30);
  // ...and the earlier verification now covers both later blocks cheaply.
  counts.fill(0);
  await resolveHistoricalProtocolDeployment(legs, pointer, runtimeHash, 180, hashOf(180));
  expect(counts).toEqual([5, 5]);
});

test('RED: a different manifest at the later block falls back to full verification and returns that manifest', async () => {
  const { counts, legs } = counted(height => (height >= 300 ? 2n : 1n));
  const before = await resolveHistoricalProtocolDeployment(legs, pointer, runtimeHash, 100, hashOf(100));
  counts.fill(0);
  const after = await resolveHistoricalProtocolDeployment(legs, pointer, runtimeHash, 300, hashOf(300));
  expect(counts[0]).toBeGreaterThan(30);
  expect(after.revision).toBe(2n);
  expect(after.manifestHash).not.toBe(before.manifestHash);
});

test('RED: a block hash that is not the canonical hash at that height is refused on the reuse path', async () => {
  const { legs } = counted();
  await resolveHistoricalProtocolDeployment(legs, pointer, runtimeHash, 100, hashOf(100));
  await expect(resolveHistoricalProtocolDeployment(legs, pointer, runtimeHash, 250, hashOf(251)))
    .rejects.toThrow('protocol_pointer_invalid_block');
});

test('RED: a pointer whose runtime no longer matches the pin is refused on the reuse path', async () => {
  const { legs } = counted();
  await resolveHistoricalProtocolDeployment(legs, pointer, runtimeHash, 100, hashOf(100));
  const swapped = legs.map(leg => ({ request: async (method: string, params: readonly unknown[]) =>
    method === 'eth_getCode' && params[0] === pointer ? '0x6001' : leg.request(method, params) })) as unknown as [PointerRpc, PointerRpc];
  await expect(resolveHistoricalProtocolDeployment(swapped, pointer, runtimeHash, 250, hashOf(250)))
    .rejects.toThrow('protocol_pointer_runtime_mismatch');
});
