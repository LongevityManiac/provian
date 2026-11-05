/**
 * verifyAndroidKeyAttestation - the pure orchestrator.
 *
 * Composes chain verification, KeyDescription parsing, challenge binding,
 * attested-key equality, security-level tiering, boot/origin checks, and
 * revocation into a single fail-closed decision. Every dependency (trust
 * anchors, revocation source, clock, expected challenge, registered key) is
 * injected so the function is deterministic and unit-testable.
 *
 * Returns a promoted tier ONLY when every check passes. Any failure returns
 * { ok: false, code, reason } and the caller keeps the self-reported tier.
 */
import { timingSafeEqual } from 'crypto';
import { verifyCertChain } from './chain';
import { parseKeyDescription } from './extension';
import { checkRevocation } from './revocation';
import { nodeCrypto } from './crypto-provider';
import type { TrustAnchorSet } from './roots';
import type {
  AndroidAttestationResult,
  AndroidSecurityLevel,
  AttestationPolicy,
  AttestedTier,
  RevocationStatusSource,
} from './types';
import { failure } from './types';
import type { X509Certificate } from '@peculiar/x509';

/** KM_ORIGIN_GENERATED - a key minted inside the secure world. */
const KM_ORIGIN_GENERATED = 0;

export interface VerifyAndroidKeyAttestationInput {
  /** Leaf-first DER certificate chain from Android KeyStore.getCertificateChain. */
  derChain: readonly Uint8Array[];
  /** The server nonce baked into the key. REQUIRED for promotion. */
  expectedChallenge: Uint8Array | undefined;
  /** The registered device key as 130-hex SEC1 uncompressed point (04||X||Y). */
  registeredSigningPublicKeyHex: string;
  anchors: TrustAnchorSet;
  revocation: RevocationStatusSource;
  /** Injected clock (epoch ms). */
  now: number;
  policy?: AttestationPolicy;
}

function tierForSecurityLevel(
  level: AndroidSecurityLevel,
  minLevel: 'TrustedEnvironment' | 'StrongBox',
): AttestedTier | null {
  if (level === 'StrongBox') return 'hardware_full';
  if (level === 'TrustedEnvironment') {
    return minLevel === 'StrongBox' ? null : 'hardware_tpm';
  }
  return null; // Software
}

async function leafUncompressedPointHex(leaf: X509Certificate): Promise<string | null> {
  try {
    const key = await nodeCrypto.subtle.importKey(
      'spki',
      leaf.publicKey.rawData,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      [],
    );
    const raw = await nodeCrypto.subtle.exportKey('raw', key);
    return Buffer.from(raw).toString('hex');
  } catch {
    return null;
  }
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function verifyAndroidKeyAttestation(
  input: VerifyAndroidKeyAttestationInput,
): Promise<AndroidAttestationResult> {
  const requireVerifiedBoot = input.policy?.requireVerifiedBoot ?? true;
  const minSecurityLevel = input.policy?.minSecurityLevel ?? 'TrustedEnvironment';

  try {
    // 1. Chain: path + per-link signatures + validity windows + root anchor.
    const chain = await verifyCertChain({
      derChain: input.derChain,
      anchors: input.anchors,
      now: input.now,
    });
    if (!chain.ok) return chain;

    // 2. Attestation extension.
    const parsed = parseKeyDescription(chain.leaf);
    if (!parsed.ok) return parsed;
    const desc = parsed.desc;

    // 3. Challenge binding (server-issued nonce). Required for promotion.
    if (!input.expectedChallenge || input.expectedChallenge.length === 0) {
      return failure('CHALLENGE_MISSING', 'no server challenge supplied; cannot bind attestation (fail closed)');
    }
    if (!constantTimeEqualBytes(desc.attestationChallenge, input.expectedChallenge)) {
      return failure('CHALLENGE_MISMATCH', 'attestation challenge does not match the issued server nonce');
    }

    // 4. Attested key must equal the registered signing key.
    const attestedHex = await leafUncompressedPointHex(chain.leaf);
    if (!attestedHex) {
      return failure('ATTESTED_KEY_MISMATCH', 'leaf public key is not an exportable P-256 point');
    }
    const registeredHex = (input.registeredSigningPublicKeyHex.startsWith('0x')
      ? input.registeredSigningPublicKeyHex.slice(2)
      : input.registeredSigningPublicKeyHex
    ).toLowerCase();
    if (attestedHex.toLowerCase() !== registeredHex) {
      return failure('ATTESTED_KEY_MISMATCH', 'attested public key does not match the registered signing key');
    }

    // 5. Security level (from attestationSecurityLevel, NOT keymaster).
    const tier = tierForSecurityLevel(desc.attestationSecurityLevel, minSecurityLevel);
    if (!tier) {
      return failure(
        'SECURITY_LEVEL_INSUFFICIENT',
        `attestationSecurityLevel=${desc.attestationSecurityLevel} below minimum ${minSecurityLevel}`,
      );
    }

    // 6. Boot state + origin - read ONLY from the hardware-enforced list.
    const hw = desc.hardwareEnforced;
    if (requireVerifiedBoot) {
      if (!hw.rootOfTrust) {
        return failure('BOOT_STATE_UNTRUSTED', 'no hardware-enforced rootOfTrust present');
      }
      if (hw.rootOfTrust.verifiedBootState !== 'Verified' || !hw.rootOfTrust.deviceLocked) {
        return failure(
          'BOOT_STATE_UNTRUSTED',
          `verifiedBootState=${hw.rootOfTrust.verifiedBootState} deviceLocked=${hw.rootOfTrust.deviceLocked}`,
        );
      }
    }
    if (hw.origin !== KM_ORIGIN_GENERATED) {
      return failure('ORIGIN_NOT_GENERATED', `hardware-enforced origin=${hw.origin ?? 'absent'} (expected GENERATED=0)`);
    }

    // 7. Revocation.
    const revoked = checkRevocation({ serials: chain.serials, source: input.revocation });
    if (!revoked.ok) return revoked;

    return {
      ok: true,
      attestedTier: tier,
      securityLevel: desc.attestationSecurityLevel,
      bootState: hw.rootOfTrust?.verifiedBootState ?? 'Verified',
      revokedSerialsChecked: revoked.checked,
    };
  } catch (err) {
    // Defensive: any unexpected throw fails closed, never promotes.
    return failure('INTERNAL_ERROR', `attestation verification threw: ${(err as Error).message}`);
  }
}
