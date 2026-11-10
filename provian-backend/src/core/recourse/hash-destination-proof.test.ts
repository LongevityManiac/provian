import { Interface, hashMessage, keccak256 } from 'ethers';
import { verifyHashDestinationProof } from './hash-destination-proof';
import type { ProtocolDeployment } from '../protocol/pointer';
import type { OwnerOperationChain } from './owner-operation-queue';
const a = (b: string) => `0x${b.repeat(20)}`, h = (b: string) => `0x${b.repeat(32)}`;
const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)',
  'function breakOrigin() view returns(address)', 'function hashAccountCodeHash() view returns(bytes32)',
  'function isValidSignature(bytes32,bytes) view returns(bytes4)']);
const signature = `0x${'11'.repeat(7888)}`, message = 'Bound credential request';
function fixture(mode = 'valid'): OwnerOperationChain {
  let reads = 0;
  return { async deployment() {
    ++reads;
    return { addresses: { kernel: a('01') }, blockHash: h('02'), manifestHash: mode === 'changed' && reads > 1 ? h('03') : h('04') } as ProtocolDeployment;
  }, async agree(method, params) {
    expect(params.at(-1)).toEqual({ blockHash: h('02'), requireCanonical: true });
    if (mode === 'disagreement') throw Error('rpc_disagreement');
    if (method === 'eth_getCode') return mode === 'curve' ? '0x' : mode === 'code' ? '0x6001' : '0x6000';
    const call = abi.parseTransaction({ data: (params[0] as { data: string }).data })!;
    if (call.name === 'isValidSignature') {
      expect(call.args[0]).toBe(hashMessage(message)); expect(call.args[1]).toBe(signature);
    }
    const values: Record<string, unknown> = { ownerAuthorization: a('05'), kernel: a('01'),
      breakOrigin: mode === 'ordinary' ? a('00') : a('06'), hashAccountCodeHash: keccak256('0x6000'),
      isValidSignature: mode === 'invalid' ? '0xffffffff' : '0x1626ba7e' };
    return abi.encodeFunctionResult(call.name, [values[call.name]]);
  } };
}
test('hash credential proof checks exact runtime, break context and message at a pinned independent block', async () => {
  await expect(verifyHashDestinationProof(a('07'), message, signature, fixture())).resolves.toBeUndefined();
});
test.each(['changed', 'disagreement', 'curve', 'code', 'ordinary', 'invalid'])('refuses %s credential evidence', async mode => {
  await expect(verifyHashDestinationProof(a('07'), message, signature, fixture(mode))).rejects.toThrow();
});
test('an old curve signature is never accepted as a hash-account proof', async () => {
  await expect(verifyHashDestinationProof(a('07'), message, `0x${'11'.repeat(65)}`, fixture())).rejects.toThrow('proof_invalid');
});
