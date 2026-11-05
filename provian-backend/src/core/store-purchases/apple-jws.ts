/**
 * Verify a JWS that Apple signed for the App Store (a signed transaction, as the App Store Server
 * API returns it and as StoreKit 2 hands it to the app).
 *
 * Apple signs with ES256 and carries the certificate chain in the header's `x5c`: the signing leaf,
 * Apple's WWDR intermediate, and Apple Root CA - G3. A JWS is accepted only when:
 * - the header is ES256 with exactly three certificates;
 * - the third certificate is byte-identical to the trusted root (Apple Root CA - G3 in production);
 * - every certificate is inside its validity window, every issuer is a CA, and each certificate
 *   is signed by the next;
 * - the leaf carries Apple's App Store receipt-signing marker OID and the intermediate Apple's
 *   WWDR intermediate marker OID;
 * - the JWS signature verifies with the leaf's key.
 * Anything else is refused. A StoreKit configuration file's local transactions are signed by
 * Xcode's own certificate and never chain to Apple's root, so they are refused here.
 */
import { createHash, verify as verifySignature, X509Certificate as NodeX509 } from 'crypto';
import { BasicConstraintsExtension, X509Certificate } from '@peculiar/x509';
import '../attestation/crypto-provider';

/** Apple Root CA - G3 (DER, base64), from https://www.apple.com/certificateauthority/. */
const APPLE_ROOT_CA_G3_B64 =
  'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQL'
  + 'DB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMw'
  + 'MTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRp'
  + 'ZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IA'
  + 'BJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqX'
  + 'l5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8w'
  + 'DgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWT'
  + 'xnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==';

/** SHA-256 of Apple Root CA - G3's DER, as Apple publishes it. Checked at load. */
const APPLE_ROOT_CA_G3_SHA256 = '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179';

export const APPLE_ROOT_CA_G3_DER: Buffer = (() => {
  const der = Buffer.from(APPLE_ROOT_CA_G3_B64, 'base64');
  if (createHash('sha256').update(der).digest('hex') !== APPLE_ROOT_CA_G3_SHA256) {
    throw new Error('apple_root_ca_g3_corrupt');
  }
  return der;
})();

/** Apple's marker on the App Store receipt-signing leaf. */
export const APPLE_RECEIPT_SIGNER_OID = '1.2.840.113635.100.6.11.1';
/** Apple's marker on the WWDR intermediate. */
export const APPLE_WWDR_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

export class AppleJwsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function b64urlJson(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppleJwsError('jws_malformed');
  return parsed as Record<string, unknown>;
}

/**
 * The verified payload of an Apple-signed JWS, or an `AppleJwsError`. `trustedRootDer` is Apple Root
 * CA - G3 unless a test passes its own root to prove the checks bite.
 */
export async function verifyAppleSignedJws(
  jws: string,
  opts: { readonly nowMs: number; readonly trustedRootDer?: Buffer },
): Promise<Record<string, unknown>> {
  if (typeof jws !== 'string' || jws.length > 64_000) throw new AppleJwsError('jws_malformed');
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new AppleJwsError('jws_malformed');
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    throw new AppleJwsError('jws_malformed');
  }
  if (header.alg !== 'ES256') throw new AppleJwsError('jws_algorithm_refused');
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((c) => typeof c === 'string' && c.length > 0)) {
    throw new AppleJwsError('jws_chain_missing');
  }
  const ders = (x5c as string[]).map((c) => Buffer.from(c, 'base64'));
  const root = opts.trustedRootDer ?? APPLE_ROOT_CA_G3_DER;
  if (!ders[2].equals(root)) throw new AppleJwsError('jws_root_untrusted');

  let node: NodeX509[];
  let peculiar: X509Certificate[];
  try {
    node = ders.map((d) => new NodeX509(d));
    peculiar = ders.map((d) => new X509Certificate(d));
  } catch {
    throw new AppleJwsError('jws_chain_unparseable');
  }
  const now = new Date(opts.nowMs);
  for (const cert of peculiar) {
    if (now < cert.notBefore || now > cert.notAfter) throw new AppleJwsError('jws_chain_expired');
  }
  for (let i = 1; i < peculiar.length; i += 1) {
    const bc = peculiar[i].getExtension(BasicConstraintsExtension);
    if (!bc || bc.ca !== true) throw new AppleJwsError('jws_chain_broken');
  }
  for (let i = 0; i < node.length; i += 1) {
    const issuer = node[Math.min(i + 1, node.length - 1)];
    if (!node[i].checkIssued(issuer) || !node[i].verify(issuer.publicKey)) throw new AppleJwsError('jws_chain_broken');
  }
  if (peculiar[0].getExtension(APPLE_RECEIPT_SIGNER_OID) === null) throw new AppleJwsError('jws_leaf_not_app_store');
  if (peculiar[1].getExtension(APPLE_WWDR_INTERMEDIATE_OID) === null) throw new AppleJwsError('jws_intermediate_not_apple');

  const signature = Buffer.from(parts[2], 'base64url');
  const ok = signature.length === 64 && verifySignature(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
    { key: node[0].publicKey, dsaEncoding: 'ieee-p1363' },
    signature,
  );
  if (!ok) throw new AppleJwsError('jws_signature_invalid');
  return payload;
}

/** The transaction id a client-supplied JWS names, read WITHOUT trusting it (a lookup key only). */
export function unverifiedTransactionIdOf(jws: string): string | null {
  const parts = typeof jws === 'string' ? jws.split('.') : [];
  if (parts.length !== 3) return null;
  try {
    const id = b64urlJson(parts[1]).transactionId;
    return typeof id === 'string' && /^[0-9]{1,32}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
