import { protocolRpc } from './protocol-rpc';
import { guardedFetch } from './guarded-fetch';
import { PROTOCOL_POINTER_PIN } from './protocol-pointer-pin.generated';
import { resolveProtocolDeployment, type PointerRpc, type ProtocolDeployment } from './protocol-pointer';
const endpoints = ['https://mainnet.base.org', 'https://base.drpc.org'] as const;
let minimumRevision = 0n;
function rpc(url: string): PointerRpc {
  return protocolRpc(url, guardedFetch);
}
/** Plans are independently resolved on chain. Relay credentials are never sent to RPCs. */
export async function currentProtocolDeployment(): Promise<ProtocolDeployment> {
  const { address, runtimeHash } = PROTOCOL_POINTER_PIN;
  if (!address || !runtimeHash) throw new Error('protocol_pointer_not_deployed');
  const deployment = await resolveProtocolDeployment([rpc(endpoints[0]), rpc(endpoints[1])], address, runtimeHash, minimumRevision);
  if (deployment.revision > minimumRevision) minimumRevision = deployment.revision;
  return deployment;
}
