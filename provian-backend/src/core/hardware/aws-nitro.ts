/**
 * AWS Nitro Enclaves attestation document — §2.9.
 *
 * COSE_Sign1 (CBOR tag 18 optional) = [protected {1: -35 (ES384)}, unprotected, payload, sig].
 * payload = CBOR map { module_id, timestamp, digest 'SHA384', pcrs {i: bytes}, certificate (DER),
 * cabundle [root, …intermediates], ?public_key, ?user_data, ?nonce }. The signature is ECDSA
 * P-384 / SHA-384 (r||s) over Sig_structure = ["Signature1", protected, h'', payload]. The
 * certificate must chain through `cabundle` to the pinned AWS Nitro Root-G1; `nonce` must equal
 * the binding nonce.
 */
import crypto from 'crypto';
import { decodeCbor, encodeCbor, mapGet, CborTag, type CborValue } from './cbor';
import { parseCertificate, spkiSha256, verifyChainToPinnedRoot, sha256Hex } from './x509';
import { rootsForScheme } from './roots';
import type { HardwareVerifyContext, HardwareWitnessInput, HardwareWitnessVerdict } from './types';

export function verifyAwsNitro(input: HardwareWitnessInput, ctx: HardwareVerifyContext): HardwareWitnessVerdict {
  const fail = (reason: string): HardwareWitnessVerdict => ({ admitted: false, scheme: 'aws_nitro', reason, fields: null });
  if (typeof input.document !== 'string' || input.document.length === 0) return fail('document_missing');
  let raw: Buffer;
  try { raw = Buffer.from(input.document, 'base64'); } catch { return fail('document_not_base64'); }
  let cose: CborValue;
  try { cose = decodeCbor(raw); } catch { return fail('cose_malformed'); }
  if (cose instanceof CborTag) { if (cose.tag !== 18) return fail('cose_wrong_tag'); cose = cose.value; }
  if (!Array.isArray(cose) || cose.length !== 4) return fail('cose_not_sign1');
  const [protectedBytes, , payloadBytes, signature] = cose;
  if (!Buffer.isBuffer(protectedBytes) || !Buffer.isBuffer(payloadBytes) || !Buffer.isBuffer(signature)) return fail('cose_fields');
  let protectedHeader: CborValue;
  try { protectedHeader = decodeCbor(protectedBytes); } catch { return fail('protected_malformed'); }
  if (mapGet(protectedHeader, 1) !== -35) return fail('alg_not_es384');
  let payload: CborValue;
  try { payload = decodeCbor(payloadBytes); } catch { return fail('payload_malformed'); }
  const certDer = mapGet(payload, 'certificate');
  const cabundle = mapGet(payload, 'cabundle');
  if (!Buffer.isBuffer(certDer) || !Array.isArray(cabundle)) return fail('certificate_missing');
  const leaf = parseCertificate(certDer);
  if (!leaf) return fail('certificate_unparseable');
  const intermediates = cabundle.map((c) => (Buffer.isBuffer(c) ? parseCertificate(c) : null)).filter((c): c is NonNullable<typeof c> => c !== null);
  const chainVerdict = verifyChainToPinnedRoot(leaf, intermediates, rootsForScheme('aws_nitro', ctx), ctx.nowMs);
  if (!chainVerdict.ok) return fail(`chain:${chainVerdict.reason}`);
  const sigStructure = encodeCbor(['Signature1', protectedBytes, Buffer.alloc(0), payloadBytes]);
  let sigOk = false;
  try { sigOk = crypto.verify('sha384', sigStructure, { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, signature); } catch { sigOk = false; }
  if (!sigOk) return fail('signature_invalid');
  const signerKey = spkiSha256(leaf);
  if (ctx.actorKeyFingerprints.has(signerKey)) return fail('signer_is_actor');
  const nonce = mapGet(payload, 'nonce');
  const nonceBound = Buffer.isBuffer(nonce) && nonce.equals(ctx.bindingNonce);
  const pcrs = mapGet(payload, 'pcrs');
  const pcr0 = pcrs instanceof Map ? pcrs.get(0) : undefined;
  const timestamp = mapGet(payload, 'timestamp');
  const moduleId = mapGet(payload, 'module_id');
  const fields = {
    tee_type: 'aws_nitro_enclave',
    manufacturer: 'Amazon',
    model: 'nitro',
    launch_measurement: Buffer.isBuffer(pcr0) ? `sha384:${pcr0.toString('hex')}` : undefined,
    report_digest: `sha256:${sha256Hex(raw)}`,
    issuer_root_fingerprint: chainVerdict.rootFingerprint ?? undefined,
    signer_key_sha256: signerKey,
    serial_sha256: typeof moduleId === 'string' ? sha256Hex(moduleId) : undefined,
    attested_time_ms: typeof timestamp === 'number' ? timestamp : undefined,
    time_source: typeof timestamp === 'number' ? 'report_timestamp' : undefined,
    nonce_bound: nonceBound,
  };
  if (!nonceBound) return { admitted: false, scheme: 'aws_nitro', reason: 'nonce_not_bound', fields };
  return { admitted: true, scheme: 'aws_nitro', reason: 'verified', fields };
}
