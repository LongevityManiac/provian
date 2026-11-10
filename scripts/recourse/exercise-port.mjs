import { JsonRpcProvider } from 'ethers';

export const EXERCISE_RPC = 'http://127.0.0.1:18545';
export const EXERCISE_CHAIN_ID = 31337;

/** This port cannot address a public RPC. Every mutation rechecks both the
 * isolated chain domain and Anvil identity, including after a local restart.
 * Impersonation changes only the local fork; no production key is accessed. */
export function isolatedExercisePort(provider = new JsonRpcProvider(EXERCISE_RPC)) {
  let instanceId;
  async function verify() {
    const [chain, client, metadata] = await Promise.all([
      provider.send('eth_chainId', []), provider.send('web3_clientVersion', []),
      provider.send('anvil_metadata', []),
    ]);
    if (BigInt(chain) !== BigInt(EXERCISE_CHAIN_ID) || !/^anvil\//i.test(client)) throw Error('exercise_isolation_required');
    if (typeof metadata?.instanceId !== 'string' || metadata.instanceId.length === 0) throw Error('exercise_instance_required');
    if (instanceId !== undefined && metadata.instanceId !== instanceId) throw Error('exercise_instance_changed');
    instanceId = metadata.instanceId;
  }
  return {
    provider, verify,
    async mutate(method, params) {
      if (!['anvil_impersonateAccount', 'anvil_setBalance', 'eth_sendTransaction', 'evm_mine', 'evm_increaseTime'].includes(method)) {
        throw Error('exercise_method_refused');
      }
      await verify();
      return provider.send(method, params);
    },
  };
}
