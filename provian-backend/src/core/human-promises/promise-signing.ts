/**
 * Human P2P promise — canonical signing surface.
 *
 * The human promise lifecycle moved from the Firestore `promise_sync`
 * side-channel (forgeable Firebase-anonymous uids) to the relay under human
 * wallet auth, and its device-local SHA-256 "tamper tags" were replaced by REAL
 * EIP-191 wallet signatures. This module is the SINGLE definition of the message
 * those signatures cover, imported by BOTH the relay rail (`human-promises.ts`,
 * which verifies + stores them) and the completion verifier
 * (`core/pvt/completion-verifier.ts`, which re-verifies the close-out record as
 * the earning witness). One source, per 's "self-referential control" rule —
 * the earning path must not redeclare the signing format the rail uses.
 *
 * The DIGEST binds terms + creator + id (`terms + parties + id`); the mobile
 * client computes it from the plaintext terms it holds. The relay never sees the
 * plaintext — it only stores the digest and verifies each signature is over the
 * agreed digest, so both parties provably signed the SAME terms. Each phase is
 * domain-separated so a `create` signature can never be replayed as a `closeout`.
 */

import { ethers } from 'ethers';

export type HumanPromiseSignaturePhase = 'create' | 'accept' | 'counter' | 'closeout';

/** Version prefix of the signed message; bump only on a breaking format change. */
export const HUMAN_PROMISE_SIGN_VERSION = 'provian.promise.v1';

/**
 * The exact string a party's wallet signs (EIP-191 `personal_sign`) for one
 * phase of one promise. Reconstructed identically on device (to sign) and on the
 * relay (to verify), so the two must never drift — hence this one definition.
 */
export function humanPromiseSignMessage(
  phase: HumanPromiseSignaturePhase,
  promiseId: string,
  digest: string,
): string {
  return `${HUMAN_PROMISE_SIGN_VERSION}|${phase}|${promiseId}|${digest}`;
}

/**
 * Verify an EIP-191 signature over the phase message recovers to
 * `expectedAddress`. Case-insensitive on the address (EVM addresses are stored
 * lowercased). Returns false on ANY recovery failure — Unknown = Block.
 */
export function verifyHumanPromiseSignature(params: {
  phase: HumanPromiseSignaturePhase;
  promiseId: string;
  digest: string;
  signature: string;
  expectedAddress: string;
}): boolean {
  const { phase, promiseId, digest, signature, expectedAddress } = params;
  if (typeof signature !== 'string' || signature.length === 0) return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(expectedAddress)) return false;
  const message = humanPromiseSignMessage(phase, promiseId, digest);
  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}
