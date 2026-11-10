import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { PROTOCOL_POINTER_PIN } from './pointer-pin.generated';
import { resolveProtocolDeployment, type ProtocolDeployment } from './pointer';
let minimumRevision = 0n;
export async function currentProtocolDeployment(): Promise<ProtocolDeployment> {
  const { address, runtimeHash } = PROTOCOL_POINTER_PIN;
  if (!address || !runtimeHash) throw new Error('protocol_pointer_not_deployed');
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('protocol_rpc_operators_not_independent');
  const deployment = await resolveProtocolDeployment([
    { request: (method, params) => legs[0].provider.send(method, [...params]) },
    { request: (method, params) => legs[1].provider.send(method, [...params]) },
  ], address, runtimeHash, minimumRevision);
  if (deployment.revision > minimumRevision) minimumRevision = deployment.revision;
  return deployment;
}
