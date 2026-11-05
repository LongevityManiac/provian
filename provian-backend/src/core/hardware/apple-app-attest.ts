/**
 * Apple App Attest (DCAppAttestService) attestation object — §2.9, the iPhone's Secure Enclave.
 *
 * CBOR { fmt: 'apple-appattest', attStmt: { x5c: [credCert, intermediate], receipt }, authData }.
 * Checks (Apple, "Validating apps that connect to your server"):
 *   1. x5c chains to the pinned Apple App Attestation Root CA.
 *   2. nonce = SHA256(authData || clientDataHash) equals the OCTET STRING inside credCert's
 *      extension 1.2.840.113635.100.8.2 (DER: SEQUENCE { [1] { OCTET STRING } }). Our
 *      clientDataHash IS the binding nonce — the app passes sha256(body) to attestKey.
 *   3. key id = SHA256(credCert public key, uncompressed point) equals authData.credentialId.
 *   4. authData.rpIdHash = SHA256(appId); counter = 0; aaguid = 'appattest' (production).
 */
import crypto from 'crypto';
import { decodeCbor, mapGet } from './cbor';
import { findExtensionValue, parseCertificate, readTlv, spkiSha256, verifyChainToPinnedRoot, sha256Hex } from './x509';
import { rootsForScheme } from './roots';
import type { HardwareVerifyContext, HardwareWitnessInput, HardwareWitnessVerdict } from './types';

export const APPLE_APP_ATTEST_NONCE_OID = '1.2.840.113635.100.8.2';
const AAGUID_PROD = Buffer.from('appattest\0\0\0\0\0\0\0', 'latin1');
const AAGUID_DEV = Buffer.from('appattestdevelop', 'latin1');

export interface ParsedAuthData { readonly rpIdHash: Buffer; readonly flags: number; readonly counter: number; readonly aaguid: Buffer; readonly credentialId: Buffer }

export function parseAuthData(authData: Buffer): ParsedAuthData | null {
  if (authData.length < 37 + 16 + 2) return null;
  const rpIdHash = Buffer.from(authData.subarray(0, 32));
  const flags = authData[32];
  const counter = authData.readUInt32BE(33);
  const aaguid = Buffer.from(authData.subarray(37, 53));
  const credLen = authData.readUInt16BE(53);
  if (55 + credLen > authData.length) return null;
  const credentialId = Buffer.from(authData.subarray(55, 55 + credLen));
  return { rpIdHash, flags, counter, aaguid, credentialId };
}

/** The nonce Apple embeds: SEQUENCE { [1] EXPLICIT { OCTET STRING nonce } } → the 32 nonce bytes. */
export function extractAppleNonce(extnValue: Buffer): Buffer | null {
  const seq = readTlv(extnValue, 0);
  if (!seq || seq.tag !== 0x30) return null;
  const ctx = readTlv(extnValue, seq.start);
  if (!ctx || (ctx.tag & 0xa0) !== 0xa0) return null;
  const oct = readTlv(extnValue, ctx.start);
  if (!oct || oct.tag !== 0x04) return null;
  return Buffer.from(extnValue.subarray(oct.start, oct.end));
}

export function verifyAppleAppAttest(input: HardwareWitnessInput, ctx: HardwareVerifyContext): HardwareWitnessVerdict {
  const fail = (reason: string): HardwareWitnessVerdict => ({ admitted: false, scheme: 'apple_app_attest', reason, fields: null });
  if (typeof input.attestation !== 'string' || input.attestation.length === 0) return fail('attestation_missing');
  if (!ctx.appleAppId) return fail('app_id_not_configured');
  let raw: Buffer;
  try { raw = Buffer.from(input.attestation, 'base64'); } catch { return fail('attestation_not_base64'); }
  let obj: ReturnType<typeof decodeCbor>;
  try { obj = decodeCbor(raw); } catch { return fail('attestation_malformed'); }
  if (mapGet(obj, 'fmt') !== 'apple-appattest') return fail('fmt_not_apple');
  const attStmt = mapGet(obj, 'attStmt');
  const x5c = mapGet(attStmt, 'x5c');
  const authData = mapGet(obj, 'authData');
  if (!Array.isArray(x5c) || x5c.length === 0 || !Buffer.isBuffer(authData)) return fail('fields_missing');
  const certs = x5c.map((c) => (Buffer.isBuffer(c) ? parseCertificate(c) : null));
  if (certs.some((c) => c === null)) return fail('x5c_unparseable');
  const credCert = certs[0]!;
  const chainVerdict = verifyChainToPinnedRoot(credCert, certs.slice(1).filter((c): c is NonNullable<typeof c> => c !== null), rootsForScheme('apple_app_attest', ctx), ctx.nowMs);
  if (!chainVerdict.ok) return fail(`chain:${chainVerdict.reason}`);
  const expectedNonce = crypto.createHash('sha256').update(Buffer.concat([authData, ctx.bindingNonce])).digest();
  const ext = findExtensionValue(credCert.raw, APPLE_APP_ATTEST_NONCE_OID);
  const embedded = ext ? extractAppleNonce(ext) : null;
  if (!embedded) return fail('nonce_extension_missing');
  const parsed = parseAuthData(authData);
  if (!parsed) return fail('auth_data_malformed');
  // key id = SHA256(uncompressed P-256 point)
  const jwk = credCert.publicKey.export({ format: 'jwk' }) as { x?: string; y?: string; crv?: string };
  if (!jwk.x || !jwk.y || jwk.crv !== 'P-256') return fail('cred_key_not_p256');
  const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const keyId = crypto.createHash('sha256').update(point).digest();
  if (!keyId.equals(parsed.credentialId)) return fail('key_id_mismatch');
  if (input.key_id && !Buffer.from(input.key_id, 'base64').equals(keyId)) return fail('key_id_mismatch');
  const rpIdHash = crypto.createHash('sha256').update(ctx.appleAppId).digest();
  if (!rpIdHash.equals(parsed.rpIdHash)) return fail('rp_id_mismatch');
  if (parsed.counter !== 0) return fail('counter_not_zero');
  const production = parsed.aaguid.equals(AAGUID_PROD);
  if (!production && !parsed.aaguid.equals(AAGUID_DEV)) return fail('aaguid_unknown');
  const signerKey = spkiSha256(credCert);
  if (ctx.actorKeyFingerprints.has(signerKey)) return fail('signer_is_actor');
  const nonceBound = embedded.equals(expectedNonce);
  const fields = {
    tee_type: 'apple_secure_enclave',
    manufacturer: 'Apple',
    model: production ? 'app_attest' : 'app_attest_development',
    report_digest: `sha256:${sha256Hex(raw)}`,
    issuer_root_fingerprint: chainVerdict.rootFingerprint ?? undefined,
    signer_key_sha256: signerKey,
    serial_sha256: sha256Hex(credCert.serialNumber),
    debug_enabled: !production,
    nonce_bound: nonceBound,
  };
  if (!nonceBound) return { admitted: false, scheme: 'apple_app_attest', reason: 'nonce_not_bound', fields };
  // A development-environment attestation records its fields but is not a production witness.
  if (!production) return { admitted: false, scheme: 'apple_app_attest', reason: 'development_aaguid', fields };
  return { admitted: true, scheme: 'apple_app_attest', reason: 'verified', fields };
}
