import { Interface, keccak256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { readAgreedBaseBlockHash, readAgreedBaseHead } from '../onchain/economic-discovery';
import { currentProtocolDeployment } from '../protocol/runtime';
import { PROTOCOL_COMPONENTS } from '../protocol/pointer';

export interface RecourseForwarderConfig {
  readonly address: string;
  readonly pool: string;
  readonly runtimeHash: string;
}
const abi = new Interface(['function kernel() view returns (address)', 'function submitter() view returns (address)',
  'function pool() view returns (address)']);
export async function recourseForwarderConfig(): Promise<RecourseForwarderConfig> {
  const deployment = await currentProtocolDeployment();
  return { address: deployment.addresses.settlement.toLowerCase(), pool: deployment.addresses.recoursePool.toLowerCase(),
    runtimeHash: deployment.runtimeHashes[PROTOCOL_COMPONENTS.indexOf('settlement')] };
}

/** No caller-supplied verified flag: compare runtime and immutable getters on both guarded RPC legs. */
export async function verifyRecourseForwarder(config: RecourseForwarderConfig, kernel: string, signer: string): Promise<void> {
  const deployment = await currentProtocolDeployment();
  if (deployment.addresses.settlement.toLowerCase() !== config.address || deployment.addresses.recoursePool.toLowerCase() !== config.pool
    || deployment.addresses.kernel.toLowerCase() !== kernel.toLowerCase()) throw new Error('recourse_forwarder_retired');
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  const height = await readAgreedBaseHead();
  const hash = await readAgreedBaseBlockHash(height);
  if (!hash) throw new Error('recourse_forwarder_block_unavailable');
  const tag = { blockHash: hash, requireCanonical: true };
  const results = await Promise.all(legs.map(async leg => {
    const code: unknown = await leg.provider.send('eth_getCode', [config.address, tag]);
    if (typeof code !== 'string' || keccak256(code) !== config.runtimeHash) throw new Error('recourse_forwarder_runtime_mismatch');
    const values: string[] = [];
    for (const method of ['kernel', 'submitter', 'pool']) {
      const raw: unknown = await leg.provider.send('eth_call', [{ to: config.address, data: abi.encodeFunctionData(method) }, tag]);
      if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('recourse_forwarder_getter_invalid');
      values.push(String(abi.decodeFunctionResult(method, raw)[0]).toLowerCase());
    }
    return values;
  }));
  const expected = [kernel.toLowerCase(), signer.toLowerCase(), config.pool];
  if (results.some(values => values.some((value, index) => value !== expected[index]))) throw new Error('recourse_forwarder_binding_mismatch');
  if (await readAgreedBaseBlockHash(height) !== hash) throw new Error('recourse_forwarder_reorg');
  if ((await currentProtocolDeployment()).manifestHash !== deployment.manifestHash) throw new Error('recourse_forwarder_retired');
}
