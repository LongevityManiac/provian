import { hexlify, sha256 } from 'ethers';
import { privateRecourseIntent, copyPrivateRecourseRequest, type RecoursePrivateAuthorization } from './private-access-data';
import { recoverySigningPublicKey, recoveryCommitment, signRecoveryIntent } from './hash-authorization';

export interface PrivateRecourseEnvelope { readonly authorization: RecoursePrivateAuthorization; readonly request: unknown; }
/** Only a private HTTPS body carries this authorization. The independent seed
 * never leaves the client, and this domain cannot authorize a chain operation. */
export async function privateRecourseEnvelope(identity: string, recoverySecret: Uint8Array,
  signingSeed: Uint8Array, path: string, request: unknown = null, issuedAtMs = Date.now()): Promise<PrivateRecourseEnvelope> {
  const body = copyPrivateRecourseRequest(request);
  const secret = new Uint8Array(recoverySecret), seed = new Uint8Array(signingSeed);
  try {
    const publicKey = await recoverySigningPublicKey(seed), root = sha256(publicKey);
    const input = { version: 1 as const, identity, commitment: recoveryCommitment(secret, root),
      recoverySecret: hexlify(secret), publicKey, issuedAtMs };
    const intent = privateRecourseIntent(input, path, body);
    // Private reads are replayable within the short authorization window. SLH-DSA
    // is stateless; no spending nonce or owner-operation reservation is consumed.
    const signed = await signRecoveryIntent(seed, intent, { async reserve() {} });
    if (signed.publicKey !== publicKey || signed.signingRoot !== root) throw Error('recourse_private_access_refused');
    return { authorization: { ...input, signature: signed.signature }, request: body };
  } finally { secret.fill(0); seed.fill(0); }
}
