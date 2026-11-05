/**
 * Parse the Android KeyStore attestation extension (OID 1.3.6.1.4.1.11129.2.1.17)
 * out of the leaf certificate using @peculiar/asn1-android's schema-driven
 * decoder. We deliberately use a maintained decoder rather than hand-rolled
 * ASN.1 because this is the single highest-risk parse in a tier-gating verifier.
 *
 * Fail-closed:
 *   - extension absent (RKP-provisioned / non-attested keys) -> EXTENSION_MISSING
 *   - extension present but not legacy/KeyMint ASN.1 KeyDescription (e.g. a
 *     KeyMint EAT/CBOR payload) -> the schema parse throws -> EXTENSION_PARSE.
 *     We never let a non-matching structure silently mis-decode.
 */
import { AsnConvert } from '@peculiar/asn1-schema';
import {
  KeyDescription,
  AuthorizationList,
  SecurityLevel,
  VerifiedBootState as AsnVerifiedBootState,
  id_ce_keyDescription,
} from '@peculiar/asn1-android';
import type { X509Certificate } from '@peculiar/x509';
import type {
  AndroidSecurityLevel,
  VerifiedBootState,
  ParsedAuthorizationList,
  ParsedKeyDescription,
  AndroidAttestationFailure,
} from './types';
import { failure } from './types';

function mapSecurityLevel(level: number): AndroidSecurityLevel | null {
  switch (level) {
    case SecurityLevel.software:
      return 'Software';
    case SecurityLevel.trustedEnvironment:
      return 'TrustedEnvironment';
    case SecurityLevel.strongBox:
      return 'StrongBox';
    default:
      return null;
  }
}

function mapBootState(state: number): VerifiedBootState | null {
  switch (state) {
    case AsnVerifiedBootState.verified:
      return 'Verified';
    case AsnVerifiedBootState.selfSigned:
      return 'SelfSigned';
    case AsnVerifiedBootState.unverified:
      return 'Unverified';
    case AsnVerifiedBootState.failed:
      return 'Failed';
    default:
      return null;
  }
}

function mapAuthorizationList(list: AuthorizationList): ParsedAuthorizationList {
  const origin = typeof list.origin === 'number' ? list.origin : null;
  let rootOfTrust: ParsedAuthorizationList['rootOfTrust'] = null;
  if (list.rootOfTrust) {
    const bootState = mapBootState(list.rootOfTrust.verifiedBootState);
    rootOfTrust = {
      deviceLocked: list.rootOfTrust.deviceLocked === true,
      // Unknown enum value -> 'Failed' (most restrictive), never silently trusted.
      verifiedBootState: bootState ?? 'Failed',
    };
  }
  return { origin, rootOfTrust };
}

export type ParseKeyDescriptionResult =
  | { ok: true; desc: ParsedKeyDescription }
  | AndroidAttestationFailure;

export function parseKeyDescription(leaf: X509Certificate): ParseKeyDescriptionResult {
  const ext = leaf.getExtension(id_ce_keyDescription);
  if (!ext) {
    return failure(
      'EXTENSION_MISSING',
      'leaf certificate has no key attestation extension (1.3.6.1.4.1.11129.2.1.17)',
    );
  }

  let kd: KeyDescription;
  try {
    kd = AsnConvert.parse(Buffer.from(ext.value), KeyDescription);
  } catch (err) {
    return failure(
      'EXTENSION_PARSE',
      `key attestation extension is not a decodable ASN.1 KeyDescription: ${(err as Error).message}`,
    );
  }

  const attestationSecurityLevel = mapSecurityLevel(kd.attestationSecurityLevel);
  const keymasterSecurityLevel = mapSecurityLevel(kd.keymasterSecurityLevel);
  if (!attestationSecurityLevel || !keymasterSecurityLevel) {
    return failure(
      'EXTENSION_PARSE',
      'KeyDescription carries an unrecognized SecurityLevel enum value',
    );
  }

  return {
    ok: true,
    desc: {
      attestationVersion:
        typeof kd.attestationVersion === 'number' ? kd.attestationVersion : Number(kd.attestationVersion),
      attestationSecurityLevel,
      keymasterSecurityLevel,
      attestationChallenge: new Uint8Array(kd.attestationChallenge.buffer),
      softwareEnforced: mapAuthorizationList(kd.softwareEnforced),
      hardwareEnforced: mapAuthorizationList(kd.teeEnforced),
    },
  };
}
