import type { OwnerChainNetwork } from './recourse-owner-chain';
import { guardedFetch } from './guarded-fetch';
import { PROTOCOL_POINTER_PIN } from './protocol-pointer-pin.generated';
import { resolveProtocolDeployment, type PointerRpc, type ProtocolDeployment } from './protocol-pointer';

const urls = ['https://mainnet.base.org', 'https://base.drpc.org'] as const;
let minimumRevision = 0n;
let lastVerifiedDeployment: ProtocolDeployment | undefined;
/** Synchronous display/encoding compatibility. Transaction entry points must
 * resolve afresh, and the signing boundary checks retirement independently. */
export function verifiedProtocolSnapshot(): ProtocolDeployment {
  if (!lastVerifiedDeployment) throw new Error('protocol_pointer_resolution_required');
  return lastVerifiedDeployment;
}
function transport(url: string): PointerRpc {
  return { async request(method, params) {
    const response = await guardedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('protocol_rpc_unavailable');
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || 'error' in result || !('result' in result)) throw new Error('protocol_rpc_invalid');
    return result.result;
  } };
}
/** Every signing operation obtains a fresh independent chain resolution. */
export async function currentProtocolDeployment(): Promise<ProtocolDeployment> {
  const { address, runtimeHash } = PROTOCOL_POINTER_PIN;
  if (!address || !runtimeHash) throw new Error('protocol_pointer_not_deployed');
  const deployment = await resolveProtocolDeployment([transport(urls[0]), transport(urls[1])], address, runtimeHash, minimumRevision);
  if (deployment.revision > minimumRevision) minimumRevision = deployment.revision;
  lastVerifiedDeployment = Object.freeze({ ...deployment, addresses: Object.freeze({ ...deployment.addresses }),
    runtimeHashes: Object.freeze([...deployment.runtimeHashes]) });
  return deployment;
}

export function ownerChainNetwork(): OwnerChainNetwork {
  return { rpcs: [transport(urls[0]), transport(urls[1])], deployment: currentProtocolDeployment };
}
