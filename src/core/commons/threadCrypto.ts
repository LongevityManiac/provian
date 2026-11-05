import { registerSeedDerivedCache } from '../security/seedDerivedCache';
import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * threadCrypto — the phone's half of thread end-to-end encryption.
 *
 * A thread message's content is ciphertext the relay stores and cannot read. The human's MESSAGE
 * KEY is an x25519 pair derived deterministically from the wallet seed (HKDF over the mnemonic,
 * fixed salt + info — the PromiseTermsVault pattern), so a restored seed re-derives it and every
 * past message stays readable; the public half is published at PUT /v1/threads/keys. Messages are
 * sealed to EVERY party's published key (including our own) with the sealed-box format the
 * agent-recovery escrow already ships (`sealToAnchor` / `openWithAnchor` x25519 + HKDF-SHA256 +
 * XChaCha20-Poly1305, version 0x01), cross-platform pinned against the SDK.
 *
 * SECURITY: the secret half never leaves this module's memory; never log plaintext or keys.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';
import { x25519 } from '@noble/curves/ed25519';
import SeedManager from '../wallet/SeedManager';
import { sealToAnchor, openWithAnchor, toB64u, fromB64u } from '../security/agentKeyRecovery';
import { translate } from '../../i18n/translate';

const KDF_SALT = utf8ToBytes('provian-thread-msgkey-v1');
const KDF_INFO = utf8ToBytes('provian.thread.msgkey.v1.human');

registerSeedDerivedCache(clearMessageKeyCache);

let cached: { secretKey: Uint8Array; publicKey: Uint8Array; pubkeyB64u: string } | null = null;

/** Derive (and cache) the seed-derived message key pair. Biometric-gated via SeedManager.getMnemonic. */
export async function getMessageKeyPair(
  reason: string = translate('biometricPrompts.unlockCommonsMessages', 'Unlock your encrypted Commons messages'), biometricAction?: BiometricAction,
): Promise<{ secretKey: Uint8Array; publicKey: Uint8Array; pubkeyB64u: string }> {
  if (cached) return cached;
  // Reading seed material needs a live SeedManager biometric session (a bare Face ID prompt does not
  // open one — found live 2026-09-22: "Biometric session required"). No-op inside a live session.
  return await withBiometricAction(reason, async (biometricAction) => {
    assertBiometricAction(biometricAction);
    const mnemonic = await SeedManager.getMnemonic(biometricAction);
    if (!mnemonic) throw new Error('[threadCrypto] no wallet seed available');
    const secretKey = hkdf(sha256, utf8ToBytes(mnemonic), KDF_SALT, KDF_INFO, 32);
    const publicKey = x25519.getPublicKey(secretKey);
    cached = { secretKey, publicKey, pubkeyB64u: toB64u(publicKey) };
    return cached;

  }, biometricAction);
}

/** The key pair if it is already derived in this process (never prompts), else null. */
export function cachedMessageKeyPair(): { secretKey: Uint8Array; publicKey: Uint8Array; pubkeyB64u: string } | null {
    return cached;
}

/** Forget the cached key (lock / wallet wipe). */
export function clearMessageKeyCache(): void {
    cached?.secretKey.fill(0);
    cached = null;
}

/** Seal `plaintext` to every party's published key: one sealed box per party + the plaintext hash. */
export function sealThreadMessage(plaintext: string, partyKeys: Record<string, string>): { ciphertexts: Record<string, string>; content_sha256: string } {
    const bytes = utf8ToBytes(plaintext);
    const ciphertexts: Record<string, string> = {};
    for (const [partyId, pubkeyB64u] of Object.entries(partyKeys)) {
        ciphertexts[partyId] = toB64u(sealToAnchor(fromB64u(pubkeyB64u), bytes));
    }
    return { ciphertexts, content_sha256: bytesToHex(sha256(bytes)) };
}

/** Open the box addressed to us. Returns null (never throws) on a wrong key / tamper. */
export function openThreadMessage(secretKey: Uint8Array, ciphertextB64u: string): string | null {
    try {
        return new TextDecoder().decode(openWithAnchor(secretKey, fromB64u(ciphertextB64u)));
    } catch {
        return null;
    }
}

export function threadContentSha256(plaintext: string): string {
    return bytesToHex(sha256(utf8ToBytes(plaintext)));
}
