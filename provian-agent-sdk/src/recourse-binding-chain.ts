import { Interface, hashMessage } from 'ethers';
import { recourseBindingMessage, type RecourseBinding } from './recourse-binding';
import type { OwnerChainNetwork } from './recourse-owner-chain';

const kernelAbi = new Interface(['function registryOperator() view returns(address)', 'function ownerAuthorization() view returns(address)']);
const registryAbi = new Interface(['function ownerOf(address) view returns(bytes32)', 'function boundBlock(address) view returns(uint256)',
  'function consumedBinding(bytes32) view returns(bool)']);
const executorAbi = new Interface(['function ownerRecoveryCommitment(bytes32) view returns(bytes32)', 'function ownerSigningRoot(bytes32) view returns(bytes32)']);
function height(value: unknown): bigint {
  if (!value || typeof value !== 'object' || !('number' in value) || typeof value.number !== 'string'
    || !/^0x[0-9a-f]+$/i.test(value.number)) throw new Error('recourse_binding_chain_invalid');
  return BigInt(value.number);
}
/** A relay's accepted response is only a queued request. This check requires
 * independent chain agreement on the bound owner and independent recovery root. */
export async function isRecourseBindingConfirmed(binding: RecourseBinding, network: OwnerChainNetwork, requireFinality = true): Promise<boolean> {
  const digest = hashMessage(recourseBindingMessage(binding));
  const deployment = await network.deployment();
  if (deployment.addresses.kernel.toLowerCase() !== binding.kernel) throw new Error('recourse_binding_kernel_retired');
  let pin = { blockHash: deployment.blockHash, requireCanonical: true };
  let finalizedTag: string | undefined;
  if (requireFinality) {
    const finalized = await Promise.all(network.rpcs.map(async rpc => height(await rpc.request('eth_getBlockByNumber', ['finalized', false]))));
    finalizedTag = `0x${(finalized[0] < finalized[1] ? finalized[0] : finalized[1]).toString(16)}`;
    const blocks = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getBlockByNumber', [finalizedTag!, false])));
    const hashes = blocks.map(block => block && typeof block === 'object' && 'hash' in block ? block.hash : undefined);
    if (typeof hashes[0] !== 'string' || !/^0x[0-9a-f]{64}$/.test(hashes[0]) || hashes[0] !== hashes[1]) {
      throw new Error('recourse_binding_chain_disagreement');
    }
    pin = { blockHash: hashes[0], requireCanonical: true };
  }
  const call = async (to: string, abi: Interface, name: string, args: readonly unknown[] = []) => {
    const values = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, pin])));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw new Error('recourse_binding_chain_disagreement');
    return abi.decodeFunctionResult(name, values[0]);
  };
  const [registry, executor] = await Promise.all([call(binding.kernel, kernelAbi, 'registryOperator'), call(binding.kernel, kernelAbi, 'ownerAuthorization')]);
  const [owner, block, consumed, commitment, signingRoot] = await Promise.all([
    call(String(registry[0]), registryAbi, 'ownerOf', [binding.address]),
    call(String(registry[0]), registryAbi, 'boundBlock', [binding.address]),
    call(String(registry[0]), registryAbi, 'consumedBinding', [digest]),
    call(String(executor[0]), executorAbi, 'ownerRecoveryCommitment', [binding.identity]),
    call(String(executor[0]), executorAbi, 'ownerSigningRoot', [binding.identity]),
  ]);
  if (owner[0] === `0x${'00'.repeat(32)}` && consumed[0] === false) return false;
  if (owner[0] !== binding.identity || commitment[0] !== binding.recoveryCommitment || signingRoot[0] !== binding.signingRoot) {
    throw new Error('recourse_binding_chain_mismatch');
  }
  if (!consumed[0] || block[0] === 0n) return false;
  if (requireFinality) {
    if (block[0] > BigInt(finalizedTag!)) return false;
    const canonical = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getBlockByNumber', [finalizedTag!, false])));
    if (canonical.some(value => !value || typeof value !== 'object' || !('hash' in value) || value.hash !== pin.blockHash)) {
      throw new Error('recourse_binding_chain_reorg');
    }
  }
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw new Error('recourse_binding_kernel_retired');
  return true;
}
/** Binding completes when the current canonical chain has accepted it, like an
 * ordinary wallet operation. Recovery of funds separately requires finality. */
export async function waitForRecourseBinding(binding: RecourseBinding, network: OwnerChainNetwork,
  signal?: AbortSignal): Promise<void> {
  while (true) {
    signal?.throwIfAborted();
    if (await isRecourseBindingConfirmed(binding, network, false)) return;
    if (Date.now() > binding.expiresAtMs) throw new Error('recourse_binding_not_registered');
    await new Promise<void>(resolve => setTimeout(resolve, 2000));
  }
}
