/**
 * Android Key Attestation - shared types.
 *
 * The verifier promotes an Android KeyStore registration from a self-reported
 * security level to a Google-attested PE attestation tier (`hardware_full` /
 * `hardware_tpm`) ONLY when the KeyStore-emitted X.509 attestation chain
 * verifies end to end. Because the tier can supply a 2.5x attestation factor
 * for an otherwise eligible human-device PE, every
 * step is fail-closed: any parse error, broken path, expired/revoked cert,
 * challenge mismatch, key mismatch, or unverifiable input yields `ok: false`
 * and the caller keeps the policy-allowed lower tier (agent-owned devices stay
 * software; an unverified human-device claim cannot become hardware_full). See
 * docs/ATTESTATION_ROADMAP.md and Security Invariant #7 ("Unknown = Block").
 *
 * The core is PURE: trust anchors, the revocation-status source, and the clock
 * are injected so the verifier is deterministic and unit-testable without a
 * physical StrongBox device or network access.
 */

/** Android KeyStore attestation security levels (asn1 enum SecurityLevel). */
export type AndroidSecurityLevel = 'Software' | 'TrustedEnvironment' | 'StrongBox';

/** Android verified-boot state (asn1 enum VerifiedBootState). */
export type VerifiedBootState = 'Verified' | 'SelfSigned' | 'Unverified' | 'Failed';

/** Promoted PE attestation tier. Both values already exist in TIER_RANK. */
export type AttestedTier = 'hardware_full' | 'hardware_tpm';

/**
 * The subset of an Android `AuthorizationList` the verifier reads. Security
 * properties (origin, rootOfTrust) are only ever read from the
 * hardware-enforced list (`teeEnforced`), never the attacker-influenceable
 * `softwareEnforced` list.
 */
export interface ParsedAuthorizationList {
  /** KM_ORIGIN; only GENERATED (0) is acceptable for a hardware-attested key. */
  origin: number | null;
  rootOfTrust: {
    deviceLocked: boolean;
    verifiedBootState: VerifiedBootState;
  } | null;
}

/** The decoded KeyDescription extension (OID 1.3.6.1.4.1.11129.2.1.17). */
export interface ParsedKeyDescription {
  attestationVersion: number;
  /** Drives the tier. NOT keymasterSecurityLevel. */
  attestationSecurityLevel: AndroidSecurityLevel;
  keymasterSecurityLevel: AndroidSecurityLevel;
  /** The challenge bytes baked into the key at generateKey() time. */
  attestationChallenge: Uint8Array;
  /** Software-enforced authorizations - never trusted for security props. */
  softwareEnforced: ParsedAuthorizationList;
  /** TEE/StrongBox-enforced authorizations - the trusted list. */
  hardwareEnforced: ParsedAuthorizationList;
}

/** Closed set of failure reasons. Each maps to a precise reject branch. */
export type AndroidAttestationFailureCode =
  | 'CHAIN_EMPTY'
  | 'CHAIN_PARSE'
  | 'CHAIN_PATH_BROKEN'
  | 'CHAIN_SIG_INVALID'
  | 'CERT_EXPIRED'
  | 'CERT_NOT_YET_VALID'
  | 'ROOT_NOT_TRUSTED'
  | 'EXTENSION_MISSING'
  | 'EXTENSION_PARSE'
  | 'CHALLENGE_MISSING'
  | 'CHALLENGE_MISMATCH'
  | 'ATTESTED_KEY_MISMATCH'
  | 'SECURITY_LEVEL_INSUFFICIENT'
  | 'BOOT_STATE_UNTRUSTED'
  | 'ORIGIN_NOT_GENERATED'
  | 'REVOKED'
  | 'REVOCATION_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface AndroidAttestationSuccess {
  ok: true;
  attestedTier: AttestedTier;
  securityLevel: AndroidSecurityLevel;
  bootState: VerifiedBootState;
  /** Number of chain serials checked against the revocation source. */
  revokedSerialsChecked: number;
}

export interface AndroidAttestationFailure {
  ok: false;
  code: AndroidAttestationFailureCode;
  reason: string;
}

export type AndroidAttestationResult =
  | AndroidAttestationSuccess
  | AndroidAttestationFailure;

/**
 * Revocation-status source. Production wraps a cached fetch of Google's status
 * list (https://android.googleapis.com/attestation/status); tests pass a
 * synthetic set. When `available` is false the verifier fails closed
 * (`REVOCATION_UNAVAILABLE`), never silently passing an unchecked chain.
 */
export interface RevocationStatusSource {
  available: boolean;
  /** `serialHex` is normalized lowercase hex, no leading zeros, no 0x prefix. */
  isRevoked(serialHex: string): { revoked: boolean; reason?: string };
}

/** Tier floor for promotion. Defaults to TrustedEnvironment. */
export interface AttestationPolicy {
  /** Require verifiedBootState === 'Verified' && deviceLocked. Default true. */
  requireVerifiedBoot?: boolean;
  /** Minimum attestationSecurityLevel that earns a tier. Default TrustedEnvironment. */
  minSecurityLevel?: 'TrustedEnvironment' | 'StrongBox';
}

export function failure(
  code: AndroidAttestationFailureCode,
  reason: string,
): AndroidAttestationFailure {
  return { ok: false, code, reason };
}
