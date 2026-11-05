/**
 * Trust-anchor handling for Android Key Attestation.
 *
 * Trust anchors are DATA, not a runtime fetch: production builds the set once
 * from Google's hardware-attestation root certificates embedded in the repo
 * (see google-roots.ts), and tests build a set from a synthetic self-signed
 * root so the verifier's reject/accept logic is exercised without the real
 * Google PKI. The set is indexed by SubjectPublicKeyInfo SHA-256 so a chain is
 * anchored on the root's public KEY, never on a spoofable subject name.
 */
import { createHash } from 'crypto';
import { X509Certificate } from '@peculiar/x509';
import './crypto-provider';

export interface TrustAnchorSet {
  anchors: X509Certificate[];
  /** SHA-256 (hex) of each anchor's SubjectPublicKeyInfo DER. */
  spkiFingerprints: Set<string>;
}

/** SHA-256 hex of a certificate's SubjectPublicKeyInfo (the public-key DER). */
export function spkiFingerprint(cert: X509Certificate): string {
  return createHash('sha256')
    .update(Buffer.from(cert.publicKey.rawData))
    .digest('hex');
}

/**
 * Build a trust-anchor set from PEM-encoded root certificates. Throws if any
 * PEM is unparseable so a misconfigured embedded-root list fails loudly at
 * startup rather than silently trusting nothing (which would block all
 * promotions) or, worse, mis-parsing.
 */
export function buildTrustAnchorSet(pemRoots: readonly string[]): TrustAnchorSet {
  const anchors: X509Certificate[] = [];
  const spkiFingerprints = new Set<string>();
  for (const pem of pemRoots) {
    const cert = new X509Certificate(pem);
    anchors.push(cert);
    spkiFingerprints.add(spkiFingerprint(cert));
  }
  return { anchors, spkiFingerprints };
}
