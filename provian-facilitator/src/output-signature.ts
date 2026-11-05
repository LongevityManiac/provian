/**
 * The facilitator's own output, signed (: every output an agent hands out carries
 * its signature over the output's hash — SDK, MCP and facilitator responses).
 *
 * What the facilitator hands out is its settlement receipt (the `/settle` response). It never sees a
 * seller's response bytes (x402 settles before the seller serves), so a SELLER signs its own output
 * with the SDK (`signResponse` / `outputSignatureHeaders`); this module signs only the receipt, with
 * the Base gas EOA that broadcast the settlement, as a `wallet` signer.
 *
 * The message and object are the relay's ONE definition (`provian-backend/src/core/meter/
 * output-signature.ts`). This service builds from its own directory alone (Dockerfile), so it
 * restates the three literals it needs; `output-signature.test.ts` holds them to the pinned vectors
 * (`docs/audit/output-signature-vectors.json`) generated from that definition.
 *
 * Attribution: the receipt's signer is the gas EOA. A citation of it counts toward a Provian
 * identity only if that address is one (a native agent wallet or a proven address); today it is
 * neither, so a citation of a receipt resolves to no owner and counts zero. Stated, not hidden.
 */
import { createHash } from 'node:crypto';

export const OUTPUT_SIGNATURE_MESSAGE_PREFIX = 'provian-output:v1:';
export const OUTPUT_SIGNATURE_HEADER = 'Provian-Output-Signature';

export interface WalletOutputSignature {
  readonly hash: string;
  readonly scheme: 'eip191_secp256k1';
  readonly sig: string;
  readonly signer: { readonly id: string; readonly kind: 'wallet' };
}

/** An EIP-191 signer over a UTF-8 message (a viem `PrivateKeyAccount`). */
export interface EvmMessageSigner {
  readonly address: `0x${string}`;
  signMessage(args: { message: string }): Promise<`0x${string}`>;
}

export function outputHashOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function outputSignatureMessage(hash: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error('output_signature_bad_hash');
  return OUTPUT_SIGNATURE_MESSAGE_PREFIX + hash.slice('sha256:'.length);
}

/** Sign the exact bytes handed out. */
export async function signOutputBytes(signer: EvmMessageSigner, bytes: Uint8Array): Promise<WalletOutputSignature> {
  const hash = outputHashOfBytes(bytes);
  const sig = (await signer.signMessage({ message: outputSignatureMessage(hash) })).toLowerCase();
  if (!/^0x[0-9a-f]{130}$/.test(sig)) throw new Error('output_signature_bad_sig');
  return { hash, scheme: 'eip191_secp256k1', sig, signer: { id: signer.address.toLowerCase(), kind: 'wallet' } };
}

/** The header value: base64url of the canonical (sorted-key) JSON object. */
export function encodeOutputSignatureHeader(s: WalletOutputSignature): string {
  const canonical = { hash: s.hash, scheme: s.scheme, sig: s.sig, signer: { id: s.signer.id, kind: s.signer.kind } };
  return Buffer.from(JSON.stringify(canonical), 'utf8').toString('base64url');
}
