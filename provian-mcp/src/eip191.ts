/**
 * EIP-191 `personal_sign` for the LOCAL stdio server only.
 *
 * Byte-identical port of `provian-agent-sdk/src/link-signing.ts`
 * (`signEip191Message`) over the same pinned @noble/curves 1.9.7 — the relay
 * recovers the signer with `ethers.verifyMessage(message, signature)`.
 *
 * Deliberately OUTSIDE src/core/: the shared core (mirrored into the relay)
 * must stay free of signing dependencies because the remote endpoint refuses
 * private-key material by design. The stdio entrypoint injects this via
 * ToolContext.signEip191.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256 } from './core/keccak256';

/** EIP-191 personal_sign digest (equivalent to ethers.hashMessage). */
function eip191Digest(message: string): Uint8Array {
  const bodyBytes = Buffer.from(message, 'utf-8');
  const prefix = `\x19Ethereum Signed Message:\n${bodyBytes.length}`;
  const prefixed = Buffer.concat([Buffer.from(prefix, 'utf-8'), bodyBytes]);
  return keccak256(prefixed);
}

/**
 * Produce a 0x-prefixed 65-byte hex EIP-191 (`personal_sign`) signature
 * (r || s || v, v = 27/28) over an arbitrary UTF-8 message.
 */
export function signEip191Message(privateKeyHex: string, message: string): string {
  const cleanKey = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
  if (cleanKey.length !== 64) {
    throw new Error('signEip191Message: privateKeyHex must be 32 bytes (64 hex chars)');
  }

  const digest = eip191Digest(message);
  const sig = secp256k1.sign(digest, cleanKey);
  const r = sig.r.toString(16).padStart(64, '0');
  const s = sig.s.toString(16).padStart(64, '0');
  const v = (27 + (sig.recovery ?? 0)).toString(16).padStart(2, '0');
  return `0x${r}${s}${v}`;
}
