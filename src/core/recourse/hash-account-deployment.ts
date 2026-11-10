import { Interface, ZeroAddress, ZeroHash, keccak256 } from 'ethers';
import type { OwnerChainNetwork } from './owner-chain';
import { BREAK_RECOVERY_ABI } from './break-recovery';
import { HASH_ACCOUNT_ABI } from './hash-account';

export const HASH_ACCOUNT_FACTORY_ABI = new Interface([
  'function hashAccountFactory() view returns(address)',
  'function accountAddress(bytes32) view returns(address)',
  'function deploy(bytes32) returns(address)',
]);
export interface HashAccountDeployment {
  readonly breakOrigin: string;
  readonly factory: string;
  readonly account: string;
  readonly initialRoot: string;
  readonly runtimeHash: string;
  readonly manifestHash: string;
  readonly deployed: boolean;
  readonly data: string;
}
export interface HashAccountDiscovery extends HashAccountDeployment {
  readonly currentRoot: string | null;
  readonly nonce: string | null;
}
/** Anyone may sponsor this exact CREATE2 deployment. A front-run deploys the
 * identical account with the owner's root and cannot redirect its authority.
 * No curve signature or existing relay credential is needed. */
export async function prepareHashAccountDeployment(initialRoot: string, network: OwnerChainNetwork,
  expectedBreakOrigin?: string): Promise<HashAccountDeployment> {
  const result = await discoverHashAccount(initialRoot, network, expectedBreakOrigin);
  if (result.deployed && (result.currentRoot !== initialRoot || result.nonce !== '0')) throw Error('hash_deployment_account_changed');
  return result;
}
/** Fresh backups may find an account that has already spent and rotated its
 * root. Discovery authenticates its origin, exact runtime and current state;
 * the caller must match that root to its independently derived nonce key before
 * installing a signer. This function cannot prepare a fresh recovery destination. */
export async function discoverHashAccount(initialRoot: string, network: OwnerChainNetwork,
  expectedBreakOrigin?: string): Promise<HashAccountDiscovery> {
  if (!/^0x[0-9a-f]{64}$/.test(initialRoot) || initialRoot === ZeroHash) throw Error('hash_deployment_root_invalid');
  const deployment = await network.deployment();
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const agreed = async (method: string, params: readonly unknown[]): Promise<string> => {
    const values = await Promise.all(network.rpcs.map(rpc => rpc.request(method, params)));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('hash_deployment_rpc_disagreement');
    return values[0];
  };
  const call = async (to: string, abi: Interface, method: string, args: readonly unknown[] = []) =>
    abi.decodeFunctionResult(method, await agreed('eth_call', [{ to, data: abi.encodeFunctionData(method, args) }, tag]))[0];
  const kernel = deployment.addresses.kernel.toLowerCase();
  const executor = String(await call(kernel, BREAK_RECOVERY_ABI, 'ownerAuthorization')).toLowerCase();
  if (executor === ZeroAddress || String(await call(executor, BREAK_RECOVERY_ABI, 'kernel')).toLowerCase() !== kernel) {
    throw Error('hash_deployment_executor_invalid');
  }
  const origin = String(await call(executor, BREAK_RECOVERY_ABI, 'breakOrigin')).toLowerCase();
  if (origin === ZeroAddress || (expectedBreakOrigin !== undefined && origin !== expectedBreakOrigin)) throw Error('hash_deployment_origin_changed');
  const factory = String(await call(origin, HASH_ACCOUNT_FACTORY_ABI, 'hashAccountFactory')).toLowerCase();
  if (factory === ZeroAddress || await agreed('eth_getCode', [factory, tag]) === '0x') throw Error('hash_deployment_factory_invalid');
  const account = String(await call(factory, HASH_ACCOUNT_FACTORY_ABI, 'accountAddress', [initialRoot])).toLowerCase();
  if (account === ZeroAddress) throw Error('hash_deployment_account_invalid');
  const runtimeHash = String(await call(executor, BREAK_RECOVERY_ABI, 'hashAccountCodeHash'));
  const code = await agreed('eth_getCode', [account, tag]);
  if (code !== '0x' && keccak256(code) !== runtimeHash) throw Error('hash_deployment_account_changed');
  const currentRoot = code === '0x' ? null : String(await call(account, HASH_ACCOUNT_ABI, 'keyCommitment'));
  const nonce = code === '0x' ? null : String(await call(account, HASH_ACCOUNT_ABI, 'nonce'));
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw Error('hash_deployment_protocol_changed');
  return { breakOrigin: origin, factory, account, initialRoot, runtimeHash, manifestHash: deployment.manifestHash,
    deployed: code !== '0x', data: HASH_ACCOUNT_FACTORY_ABI.encodeFunctionData('deploy', [initialRoot]), currentRoot, nonce };
}
