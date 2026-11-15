import { BUILT_IN_PROTOCOL_PROOF } from './protocol-proof.generated';
import { protocolRpc } from './protocol-rpc';
import { guardedFetch } from './guarded-fetch';
import { PROTOCOL_POINTER_PIN } from './protocol-pointer-pin.generated';
import type { PointerRpc, ProtocolDeployment } from './protocol-pointer';
import { createProtocolVerification } from './protocol-verification';
import { protocolVerificationStore } from './protocol-verification-store';

const urls = ['https://mainnet.base.org', 'https://base.drpc.org'] as const;
let verification: ReturnType<typeof createProtocolVerification> | undefined;
function transport(url: string): PointerRpc { return protocolRpc(url, guardedFetch); }
function verifier(): ReturnType<typeof createProtocolVerification> {
  const { address, runtimeHash } = PROTOCOL_POINTER_PIN;
  if (!address || !runtimeHash) throw new Error('protocol_pointer_not_deployed');
  return verification ??= createProtocolVerification({ pointer: address, runtimeHash, operators: urls, builtInProof: BUILT_IN_PROTOCOL_PROOF,
    rpcs: [transport(urls[0]), transport(urls[1])],
    store: protocolVerificationStore(JSON.stringify([address, runtimeHash, urls, 'v1'])) });
}
/** Display/encoding only. Every signing boundary freshly confirms on chain. */
export function verifiedProtocolSnapshot(): ProtocolDeployment { return verifier().snapshot(); }
/** Unconfirmed hint for speculative reads only. */
export async function protocolDeploymentCandidate(): Promise<ProtocolDeployment | undefined> { return verifier().candidate(); }
export async function currentProtocolDeployment(): Promise<ProtocolDeployment> { return verifier().current(); }
