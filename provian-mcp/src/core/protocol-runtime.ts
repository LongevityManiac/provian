import { guardedFetch } from './guarded-fetch';
import { PROTOCOL_POINTER_PIN } from './protocol-pointer-pin.generated';
import { resolveProtocolDeployment, type PointerRpc, type ProtocolDeployment } from './protocol-pointer';
const endpoints = ['https://mainnet.base.org', 'https://base.drpc.org'] as const;
let minimumRevision = 0n;
function rpc(url: string): PointerRpc {
  return { async request(method, params) {
    const response = await guardedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('protocol_rpc_unavailable');
    const reply: unknown = await response.json();
    if (!reply || typeof reply !== 'object' || 'error' in reply || !('result' in reply)) throw new Error('protocol_rpc_invalid');
    return reply.result;
  } };
}
/** Plans are independently resolved on chain. Relay credentials are never sent to RPCs. */
export async function currentProtocolDeployment(): Promise<ProtocolDeployment> {
  const { address, runtimeHash } = PROTOCOL_POINTER_PIN;
  if (!address || !runtimeHash) throw new Error('protocol_pointer_not_deployed');
  const deployment = await resolveProtocolDeployment([rpc(endpoints[0]), rpc(endpoints[1])], address, runtimeHash, minimumRevision);
  if (deployment.revision > minimumRevision) minimumRevision = deployment.revision;
  return deployment;
}
