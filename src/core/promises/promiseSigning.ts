import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * Human P2P promise — canonical signing surface (mobile side of).
 *
 * The human-promise lifecycle moved from the Firestore `promise_sync`
 * side-channel to the relay under human wallet auth, and its device-local
 * SHA-256 "tamper tags" were replaced by REAL EIP-191 wallet signatures. This
 * module is the mobile counterpart of the backend
 * `provian-backend/src/core/human-promises/promise-signing.ts` it MUST build the
 * exact same signed message and compute the exact same digest, or a mobile-signed
 * transition will not verify on the relay.
 *
 * message = "provian.promise.v1|" + phase + "|" + promiseId + "|" + digest
 * digest = sha256(canonical JSON of { promiseId, creatorAddress(lowercased),
 * theyGave, theyOwe, dueDate ?? null,
 * createdAt })
 *
 * The digest binds terms + creator + id. The relay never sees the plaintext terms
 * (they ride as opaque per-party ciphertext — see PromiseTermsVault); it stores
 * only the digest and verifies each signature is over it, so both parties provably
 * signed the SAME terms. Each phase is domain-separated, so a `create` signature
 * can never be replayed as a `closeout`.
 *
 * The signing/verifying core is PURE (`signHumanPromiseWithKey` /
 * `verifyHumanPromiseSignature`) so it can be exercised with a real ethers wallet
 * in tests without SeedManager or biometrics. `signHumanPromisePhase` is the
 * biometric-gated production entry point.
 */

import * as Crypto from 'expo-crypto';
import { ethers } from 'ethers';
import SeedManager from '../wallet/SeedManager';
import { translate } from '../../i18n/translate';

export type HumanPromiseSignaturePhase = 'create' | 'accept' | 'counter' | 'closeout';

/** Version prefix of the signed message; must match the backend constant. */
export const HUMAN_PROMISE_SIGN_VERSION = 'provian.promise.v1';

/**
 * The exact string a party's wallet signs (EIP-191 `personal_sign`) for one phase
 * of one promise. Reconstructed identically on device and on the relay.
 */
export function humanPromiseSignMessage(
  phase: HumanPromiseSignaturePhase,
  promiseId: string,
  digest: string,
): string {
  return `${HUMAN_PROMISE_SIGN_VERSION}|${phase}|${promiseId}|${digest}`;
}

/** The shared terms the digest binds. Both parties compute the digest from these. */
export interface PromiseDigestInput {
  promiseId: string;
  /** The CREATOR's wallet address (lowercased inside the digest). */
  creatorAddress: string;
  theyGave: string;
  theyOwe: string;
  dueDate?: number | null;
  createdAt: number;
}

/**
 * Compute the promise digest — a lowercase-hex sha256 over a canonical JSON of the
 * shared terms. Deterministic across the two parties (the acceptor recomputes it
 * from the QR / share-link payload), so both provably agree on the SAME terms.
 * The field order here is the canonical order and must not change.
 */
export async function computePromiseDigest(input: PromiseDigestInput): Promise<string> {
  const canonical = JSON.stringify({
    promiseId: input.promiseId,
    creatorAddress: input.creatorAddress.toLowerCase(),
    theyGave: input.theyGave,
    theyOwe: input.theyOwe,
    dueDate: input.dueDate ?? null,
    createdAt: input.createdAt,
  });
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical);
}

/**
 * PURE: sign the phase message with a provided private key. Kept free of
 * SeedManager/biometrics so tests drive it with a throwaway wallet.
 */
export async function signHumanPromiseWithKey(
  privateKey: string,
  phase: HumanPromiseSignaturePhase,
  promiseId: string,
  digest: string,
): Promise<string> {
  const wallet = new ethers.Wallet(privateKey);
  return wallet.signMessage(humanPromiseSignMessage(phase, promiseId, digest));
}

/**
 * Verify an EIP-191 signature over the phase message recovers to `expectedAddress`
 * (case-insensitive). Returns false on ANY failure — Unknown = Block. Mirrors the
 * backend `verifyHumanPromiseSignature`.
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
  try {
    const recovered = ethers.verifyMessage(humanPromiseSignMessage(phase, promiseId, digest), signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Biometric-gated production signing: establishes a biometric session, reads the
 * EVM private key, and signs the phase message. The relay verifies the signature
 * recovers to the caller's wallet address.
 */
export async function signHumanPromisePhase(
    phase: HumanPromiseSignaturePhase,
    promiseId: string,
    digest: string, biometricAction?: BiometricAction,
): Promise<string> {
    return await withBiometricAction(translate('biometricPrompts.signPromise', `Sign promise (${phase})`, { phase }), async (biometricAction) => {
        assertBiometricAction(biometricAction);
        const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);
        return signHumanPromiseWithKey(privateKey, phase, promiseId, digest);

    }, biometricAction);
}
