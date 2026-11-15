import { protocolRpc } from './rpc';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PROTOCOL_POINTER_PIN } from './pointer-pin.generated';
import { resolveProtocolDeployment, type PointerRpc, type ProtocolDeployment } from './pointer';
import type { OwnerChainNetwork } from '../recourse/owner-chain';

// Fixed HTTPS origins, no caller-controlled URL, credentials, redirect or relay.
const urls = ['https://mainnet.base.org', 'https://base.drpc.org'] as const;
const revisionKey = 'provian.protocol.pointer.revision';
let observedRevision = 0n;
let lastVerifiedDeployment: ProtocolDeployment | undefined;
export function verifiedProtocolSnapshot(): ProtocolDeployment {
  if (!lastVerifiedDeployment) throw new Error('protocol_pointer_resolution_required');
  return lastVerifiedDeployment;
}
let persistRevision: Promise<void> = Promise.resolve();
function transport(url: typeof urls[number]): PointerRpc {
  return protocolRpc(url, fetch);
}
export function ownerChainNetwork(): OwnerChainNetwork {
  return { rpcs: [transport(urls[0]), transport(urls[1])], deployment: currentProtocolDeployment };
}
/** Discovery is read directly from two independent chain operators; relay data
 * never selects the target of an approval, token operation or institution call. */
export async function currentProtocolDeployment(): Promise<ProtocolDeployment> {
  const { address, runtimeHash } = PROTOCOL_POINTER_PIN;
  if (!address || !runtimeHash) throw new Error('protocol_pointer_not_deployed');
  const stored = await AsyncStorage.getItem(revisionKey);
  if (stored !== null && !/^[0-9]+$/.test(stored)) throw new Error('protocol_pointer_revision_invalid');
  const minimum = stored === null ? observedRevision : BigInt(stored) > observedRevision ? BigInt(stored) : observedRevision;
  const deployment = await resolveProtocolDeployment([transport(urls[0]), transport(urls[1])], address, runtimeHash, minimum);
  if (deployment.revision > observedRevision) observedRevision = deployment.revision;
  const persist = persistRevision.then(() => AsyncStorage.setItem(revisionKey, observedRevision.toString()));
  persistRevision = persist.catch(() => {});
  await persist;
  lastVerifiedDeployment = Object.freeze({ ...deployment, addresses: Object.freeze({ ...deployment.addresses }),
    runtimeHashes: Object.freeze([...deployment.runtimeHashes]) });
  return deployment;
}
