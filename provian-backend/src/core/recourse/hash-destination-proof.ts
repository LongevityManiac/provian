import { Interface, hashMessage, keccak256 } from 'ethers';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import type { OwnerOperationChain } from './owner-operation-queue';
const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)',
  'function breakOrigin() view returns(address)', 'function hashAccountCodeHash() view returns(bytes32)',
  'function isValidSignature(bytes32,bytes) view returns(bytes4)']);
function chain(): OwnerOperationChain {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  return { deployment: currentProtocolDeployment, async agree(method, params) {
    const values = await Promise.all(legs.map(leg => leg.provider.send(method, [...params])));
    if (!rpcChainFactsEqual(values[0], values[1])) throw Error('recourse_destination_rpc_disagreement');
    return values[0];
  } };
}
/** A break credential request must prove control of the current hash account,
 * not a curve key associated with its address before the break. */
export async function verifyHashDestinationProof(destination: string, message: string, signature: string,
  port: OwnerOperationChain = chain()): Promise<void> {
  return verifyHashDestinationDigest(destination, hashMessage(message), signature, port);
}
export async function verifyHashDestinationDigest(destination: string, digest: string, signature: string,
  port: OwnerOperationChain = chain()): Promise<void> {
  if (!/^0x[0-9a-f]{40}$/.test(destination) || /^0x0+$/.test(destination)
    || !/^0x[0-9a-f]{64}$/.test(digest)
    || !/^0x[0-9a-f]{15776}$/.test(signature)) throw Error('recourse_destination_proof_invalid');
  const deployment = await port.deployment(), kernel = deployment.addresses.kernel.toLowerCase();
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const call = async (to: string, name: string, args: readonly unknown[] = []) => {
    const result = await port.agree('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, tag]);
    if (typeof result !== 'string') throw Error('recourse_destination_proof_invalid');
    return abi.decodeFunctionResult(name, result)[0];
  };
  const executor = String(await call(kernel, 'ownerAuthorization')).toLowerCase();
  if (/^0x0+$/.test(executor) || String(await call(executor, 'kernel')).toLowerCase() !== kernel
    || /^0x0+$/.test(String(await call(executor, 'breakOrigin')))) throw Error('recourse_destination_proof_invalid');
  const code = await port.agree('eth_getCode', [destination, tag]);
  if (typeof code !== 'string' || code === '0x' || keccak256(code) !== await call(executor, 'hashAccountCodeHash')
    || await call(destination, 'isValidSignature', [digest, signature]) !== '0x1626ba7e') throw Error('recourse_destination_proof_invalid');
  if ((await port.deployment()).manifestHash !== deployment.manifestHash) throw Error('recourse_destination_protocol_changed');
}
