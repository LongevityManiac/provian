import { Interface } from 'ethers';
import { expect, test } from 'vitest';
import { isRecourseBindingConfirmed } from './recourse-binding-chain';
import type { RecourseBinding } from './recourse-binding';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import type { ProtocolDeployment, PointerRpc } from './protocol-pointer';
const address = (b: string) => `0x${b.repeat(20)}`, hash = (b: string) => `0x${b.repeat(32)}`;
const binding: RecourseBinding = { identity: hash('11'), address: address('22'), recoveryCommitment: hash('33'),
  signingRoot: hash('44'), kernel: address('55'), nonce: hash('66'), expiresAtMs: 10000 };
const abi = new Interface(['function registryOperator() view returns(address)', 'function ownerAuthorization() view returns(address)',
  'function ownerOf(address) view returns(bytes32)', 'function boundBlock(address) view returns(uint256)',
  'function consumedBinding(bytes32) view returns(bool)', 'function ownerRecoveryCommitment(bytes32) view returns(bytes32)',
  'function ownerSigningRoot(bytes32) view returns(bytes32)']);
function fixture(change = ''): OwnerChainNetwork {
  const deployment = { addresses: { kernel: change === 'retired' ? address('77') : binding.kernel }, manifestHash: hash('88'), blockHash: hash('99') } as ProtocolDeployment;
  const rpc = (second: boolean): PointerRpc => ({ async request(method, args) {
    if (method === 'eth_getBlockByNumber') return { number: change === 'pending' ? '0x63' : '0x64', hash: hash('ff') };
    const pin = args[1] as { blockHash: string; requireCanonical: boolean };
    expect([deployment.blockHash, hash('ff')]).toContain(pin.blockHash);
    expect(pin.requireCanonical).toBe(true);
    const call = args[0] as { data: string };
    const parsed = abi.parseTransaction(call)!;
    const values: Record<string, unknown> = { registryOperator: address('aa'), ownerAuthorization: address('bb'),
      ownerOf: change === 'missing' ? hash('00') : change === 'owner' ? hash('ee') : binding.identity,
      boundBlock: change === 'zero' ? 0n : change === 'rebind' ? 50n : 100n,
      consumedBinding: !['missing', 'unconsumed'].includes(change) && !(change === 'rebind' && pin.blockHash === hash('ff')),
      ownerRecoveryCommitment: change === 'commitment' || (change === 'disagreement' && second) ? hash('ee') : binding.recoveryCommitment,
      ownerSigningRoot: change === 'root' ? hash('ee') : binding.signingRoot };
    return abi.encodeFunctionResult(parsed.name, [values[parsed.name]]);
  } });
  return { deployment: async () => deployment, rpcs: [rpc(false), rpc(true)] };
}
test('independently confirmed binding requires owner, secret commitment, signing root and consumed consent', async () => {
  expect(await isRecourseBindingConfirmed(binding, fixture())).toBe(true);
});
test.each(['missing', 'pending', 'zero', 'unconsumed'])('unconfirmed binding remains pending: %s', async change => {
  expect(await isRecourseBindingConfirmed(binding, fixture(change))).toBe(false);
});
test.each(['retired', 'owner', 'commitment', 'root', 'disagreement'])('substituted binding is refused: %s', async change => {
  await expect(isRecourseBindingConfirmed(binding, fixture(change))).rejects.toThrow();
});
test('current-chain binding can finish an ordinary registration while fund recovery still requires finality', async () => {
  expect(await isRecourseBindingConfirmed(binding, fixture('pending'), false)).toBe(true);
  expect(await isRecourseBindingConfirmed(binding, fixture('pending'))).toBe(false);
});
test('an old finalized address binding cannot confer finality on fresh unfinalized consent', async () => {
  expect(await isRecourseBindingConfirmed(binding, fixture('rebind'), false)).toBe(true);
  expect(await isRecourseBindingConfirmed(binding, fixture('rebind'))).toBe(false);
});
