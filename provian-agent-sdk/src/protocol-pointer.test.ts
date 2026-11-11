import { describe, it, expect } from 'vitest';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import { resolveProtocolDeployment, resolveHistoricalProtocolDeployment, type PointerRpc } from './protocol-pointer';
const pointer = `0x${'01'.repeat(20)}`;
const runtime = '0x60006000f3';
const runtimeHash = keccak256(runtime);
const blockHash = `0x${'ab'.repeat(32)}`;
const addresses = Array.from({ length: 10 }, (_, i) => `0x${(i + 100).toString(16).padStart(40, '0')}`);
const hashes = addresses.map(() => runtimeHash);
const abi = new Interface(['function current() view returns (uint256,bytes32,address[10],bytes32[10])']);
function manifest(revision: bigint, corrupt = false): string {
  const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'address[10]', 'bytes32[10]'],
    [8453, pointer, revision, addresses, hashes]));
  return abi.encodeFunctionResult('current', [revision, corrupt ? blockHash : digest, addresses, hashes]);
}
function rpc(options: { chain?: string; code?: string; corrupt?: boolean; newer?: boolean; reorg?: boolean; wrongBinding?: boolean } = {}): PointerRpc {
  let blocks = 0;
  return { async request(method, params) {
    if (method === 'eth_chainId') return options.chain ?? '0x2105';
    if (method === 'eth_blockNumber') return '0x64';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: options.reorg && blocks++ > 0 ? `0x${'cd'.repeat(32)}` : blockHash };
    if (method === 'eth_getCode') return params[0] === pointer ? runtime : (options.code ?? runtime);
    if (method === 'eth_call') {
      const call = params[0] as { data: string };
      if (call.data === abi.encodeFunctionData('current')) return manifest(params[1] === 'latest' && options.newer ? 2n : 1n, options.corrupt);
      const getters = ['KERNEL', 'pvt', 'epochClock', 'token', 'kernel', 'settlement', 'pool', 'protocolPointer', 'pointer'];
      for (const getter of getters) {
        const binding = new Interface([`function ${getter}() view returns(address)`]);
        if (call.data === binding.encodeFunctionData(getter)) {
          const target = options.wrongBinding ? addresses[4] : getter === 'settlement' ? addresses[9]
            : getter === 'pool' ? addresses[8] : getter === 'protocolPointer' || getter === 'pointer' ? pointer : addresses[0];
          return binding.encodeFunctionResult(getter, [target]);
        }
      }
      return '0x';
    }
    throw new Error('unexpected_rpc');
  } };
}
describe('chain-verified permanent pointer', () => {
  it('authenticates the old manifest for receipts without substituting current contracts', async () => {
    const result = await resolveHistoricalProtocolDeployment([rpc({ newer: true }), rpc({ newer: true })], pointer, runtimeHash, 100, blockHash);
    expect(result.revision).toBe(1n);
    await expect(resolveHistoricalProtocolDeployment([rpc(), rpc()], pointer, runtimeHash, 100, `0x${'cd'.repeat(32)}`)).rejects.toThrow('invalid_block');
    await expect(resolveHistoricalProtocolDeployment([rpc(), rpc()], pointer, runtimeHash, 99, blockHash)).rejects.toThrow('invalid_block');
    await expect(resolveHistoricalProtocolDeployment([rpc({ reorg: true }), rpc({ reorg: true })], pointer, runtimeHash, 100, blockHash)).rejects.toThrow('reorg');
    await expect(resolveHistoricalProtocolDeployment([rpc({ wrongBinding: true }), rpc({ wrongBinding: true })], pointer, runtimeHash, 100, blockHash)).rejects.toThrow('binding_mismatch');
    await expect(resolveHistoricalProtocolDeployment([rpc({ code: '0x00' }), rpc({ code: '0x00' })], pointer, runtimeHash, 100, blockHash)).rejects.toThrow('runtime_mismatch');
  });
  it('resolves all ten runtime-verified components without relay data', async () => {
    const result = await resolveProtocolDeployment([rpc(), rpc()], pointer, runtimeHash);
    expect(result.revision).toBe(1n);
    expect(Object.keys(result.addresses)).toHaveLength(10);
    expect(result.addresses.kernel.toLowerCase()).toBe(addresses[0]);
    expect(result.blockHash).toBe(blockHash);
  });
  it('refuses disagreement, wrong chain, wrong code, manifest alteration and rollback', async () => {
    await expect(resolveProtocolDeployment([rpc(), rpc({ chain: '0x1' })], pointer, runtimeHash)).rejects.toThrow('disagreement');
    await expect(resolveProtocolDeployment([rpc({ chain: '0x1' }), rpc({ chain: '0x1' })], pointer, runtimeHash)).rejects.toThrow('wrong_chain');
    await expect(resolveProtocolDeployment([rpc(), rpc()], pointer, blockHash)).rejects.toThrow('runtime_mismatch');
    await expect(resolveProtocolDeployment([rpc({ code: '0x00' }), rpc({ code: '0x00' })], pointer, runtimeHash)).rejects.toThrow('component_runtime_mismatch');
    await expect(resolveProtocolDeployment([rpc({ corrupt: true }), rpc({ corrupt: true })], pointer, runtimeHash)).rejects.toThrow('manifest_mismatch');
    await expect(resolveProtocolDeployment([rpc(), rpc()], pointer, runtimeHash, 2n)).rejects.toThrow('rollback');
    await expect(resolveProtocolDeployment([rpc({ wrongBinding: true }), rpc({ wrongBinding: true })], pointer, runtimeHash)).rejects.toThrow('binding_mismatch');
  });
  it('rejects a deployment change or reorganization during verification', async () => {
    await expect(resolveProtocolDeployment([rpc({ newer: true }), rpc({ newer: true })], pointer, runtimeHash)).rejects.toThrow('changed');
    await expect(resolveProtocolDeployment([rpc({ reorg: true }), rpc({ reorg: true })], pointer, runtimeHash)).rejects.toThrow('reorg');
  });
});
