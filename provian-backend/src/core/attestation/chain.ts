/**
 * Certificate-chain path building, signature verification, validity windows,
 * and root anchoring for Android Key Attestation.
 *
 * The chain Android emits is leaf-first (leaf, intermediate(s), [root]). We:
 *   1. parse every DER cert (fail closed on garbage),
 *   2. check each cert's validity window against an INJECTED clock,
 *   3. verify each cert is signed by the next (algorithm dispatch is handled by
 *      @peculiar/x509 based on each cert's real signatureAlgorithm OID, so the
 *      mixed 2026 RSA-legacy + ECDSA roots both verify correctly),
 *   4. anchor the top cert to an embedded Google root by the root's PUBLIC KEY
 *      (SPKI fingerprint or signature), never by subject name.
 *
 * Handles both chain shapes: root included as the last element (self-signed,
 * matched by SPKI fingerprint) and root omitted (top cert verified against an
 * embedded anchor's public key). RKP short chains and factory chains both work
 * because anchoring is purely cryptographic, not length-based.
 */
import { X509Certificate, BasicConstraintsExtension } from '@peculiar/x509';
import type { TrustAnchorSet } from './roots';
import { spkiFingerprint } from './roots';
import type { AndroidAttestationFailure } from './types';
import { failure } from './types';
import './crypto-provider';

export type ChainVerifyResult =
  | { ok: true; leaf: X509Certificate; serials: string[] }
  | AndroidAttestationFailure;

export async function verifyCertChain(input: {
  derChain: readonly Uint8Array[];
  anchors: TrustAnchorSet;
  now: number;
}): Promise<ChainVerifyResult> {
  const { derChain, anchors, now } = input;

  if (derChain.length === 0) {
    return failure('CHAIN_EMPTY', 'certificate chain is empty');
  }

  // 1. Parse.
  const certs: X509Certificate[] = [];
  for (let i = 0; i < derChain.length; i += 1) {
    try {
      certs.push(new X509Certificate(Buffer.from(derChain[i])));
    } catch (err) {
      return failure('CHAIN_PARSE', `certificate at index ${i} is not valid DER: ${(err as Error).message}`);
    }
  }

  // 2. Validity windows (injected clock - deterministic in tests).
  const nowDate = new Date(now);
  for (let i = 0; i < certs.length; i += 1) {
    if (nowDate < certs[i].notBefore) {
      return failure('CERT_NOT_YET_VALID', `certificate at index ${i} is not yet valid (notBefore ${certs[i].notBefore.toISOString()})`);
    }
    if (nowDate > certs[i].notAfter) {
      return failure('CERT_EXPIRED', `certificate at index ${i} expired (notAfter ${certs[i].notAfter.toISOString()})`);
    }
  }

  // 2b. Every non-leaf (issuer) cert must be a CA (basicConstraints cA=true).
  // The leaf (index 0) is an end-entity. This enforces X.509 path semantics so
  // a non-CA certificate (e.g. another device's attestation leaf) cannot be
  // smuggled in as an issuer. Defense-in-depth on top of the per-link signature
  // checks below, which already require the issuer's private key.
  for (let i = 1; i < certs.length; i += 1) {
    const bc = certs[i].getExtension(BasicConstraintsExtension);
    if (!bc || bc.ca !== true) {
      return failure(
        'CHAIN_PATH_BROKEN',
        `certificate at index ${i} is not a CA (basicConstraints cA=true required for issuers)`,
      );
    }
  }

  // 3. Each cert signed by the next.
  for (let i = 0; i < certs.length - 1; i += 1) {
    let linkOk = false;
    try {
      linkOk = await certs[i].verify({ publicKey: certs[i + 1].publicKey, signatureOnly: true });
    } catch (err) {
      return failure('CHAIN_SIG_INVALID', `signature check failed between cert ${i} and ${i + 1}: ${(err as Error).message}`);
    }
    if (!linkOk) {
      return failure('CHAIN_SIG_INVALID', `certificate at index ${i} is not signed by certificate at index ${i + 1}`);
    }
  }

  // 4. Anchor the top cert to an embedded root by public key.
  const top = certs[certs.length - 1];
  const anchored = await anchorTop(top, anchors);
  if (!anchored.ok) {
    return anchored;
  }

  const serials = certs.map((c) => c.serialNumber);
  return { ok: true, leaf: certs[0], serials };
}

async function anchorTop(
  top: X509Certificate,
  anchors: TrustAnchorSet,
): Promise<{ ok: true } | AndroidAttestationFailure> {
  // Case A: the chain includes the root itself (top IS an embedded root).
  // Require its self-signature to verify so a chain can't smuggle in a forged
  // cert that merely reuses a trusted root's public key bytes in its SPKI.
  if (anchors.spkiFingerprints.has(spkiFingerprint(top))) {
    let selfOk = false;
    try {
      selfOk = await top.verify({ publicKey: top.publicKey, signatureOnly: true });
    } catch {
      selfOk = false;
    }
    if (selfOk) {
      return { ok: true };
    }
    return failure('ROOT_NOT_TRUSTED', 'top certificate matches an embedded root key but its self-signature is invalid');
  }

  // Case B: the root was omitted from the chain. The top cert must be signed by
  // one of the embedded anchors' public keys.
  for (const anchor of anchors.anchors) {
    try {
      if (await top.verify({ publicKey: anchor.publicKey, signatureOnly: true })) {
        return { ok: true };
      }
    } catch {
      // Algorithm mismatch between this anchor and the top cert -> try next.
    }
  }

  return failure('ROOT_NOT_TRUSTED', 'certificate chain does not terminate at an embedded Google attestation root');
}
