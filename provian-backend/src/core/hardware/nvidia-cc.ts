/**
 * NVIDIA confidential-computing GPU attestation (Hopper) — §2.9.
 *
 * The report is the SPDM GET_MEASUREMENTS request || response exactly as nvtrust emits it
 * (`hopperAttestationReport.txt`): request = [ver, 0xE0, param1, param2, nonce(32), slot(1)];
 * response = [ver, 0x60, param1, param2, numBlocks, measurementRecordLength(3 LE),
 * measurementRecord, nonce(32), opaqueLength(2 LE), opaque, signature(96)]. The GPU's attestation
 * key (leaf of the supplied chain) signs SHA-384 over everything except the trailing signature,
 * ECDSA P-384, r||s. The chain must terminate at the NVIDIA Device Identity CA (pinned). The
 * RESPONSE nonce must equal the binding nonce.
 *
 * Proven against NVIDIA's published sample report + chain (the suite carries both); no live GPU.
 */
import crypto from 'crypto';
import { parsePemBundle, spkiSha256, verifyChainToPinnedRoot, sha256Hex } from './x509';
import { rootsForScheme } from './roots';
import type { HardwareVerifyContext, HardwareWitnessInput, HardwareWitnessVerdict } from './types';

const SIG_LEN = 96;

export interface ParsedNvidiaReport {
  readonly requestNonce: Buffer;
  readonly responseNonce: Buffer;
  readonly numBlocks: number;
  readonly measurementRecord: Buffer;
  readonly opaque: Buffer;
  readonly signed: Buffer;
  readonly signature: Buffer;
}

export function parseNvidiaReport(raw: Buffer): ParsedNvidiaReport | null {
  if (raw.length < 37 + 8 + 32 + 2 + SIG_LEN) return null;
  if (raw[1] !== 0xe0) return null;
  const requestNonce = Buffer.from(raw.subarray(4, 36));
  const r = raw.subarray(37);
  if (r[1] !== 0x60) return null;
  const numBlocks = r[4];
  const mrLen = r[5] | (r[6] << 8) | (r[7] << 16);
  let off = 8;
  if (off + mrLen + 32 + 2 > r.length) return null;
  const measurementRecord = Buffer.from(r.subarray(off, off + mrLen));
  off += mrLen;
  const responseNonce = Buffer.from(r.subarray(off, off + 32));
  off += 32;
  const opLen = r[off] | (r[off + 1] << 8);
  off += 2;
  if (off + opLen + SIG_LEN !== r.length) return null;
  const opaque = Buffer.from(r.subarray(off, off + opLen));
  off += opLen;
  const signature = Buffer.from(r.subarray(off, off + SIG_LEN));
  const signed = Buffer.from(raw.subarray(0, raw.length - SIG_LEN));
  return { requestNonce, responseNonce, numBlocks, measurementRecord, opaque, signed, signature };
}

export function verifyNvidiaCc(input: HardwareWitnessInput, ctx: HardwareVerifyContext): HardwareWitnessVerdict {
  const fail = (reason: string): HardwareWitnessVerdict => ({ admitted: false, scheme: 'nvidia_cc', reason, fields: null });
  if (typeof input.report !== 'string' || !/^[0-9a-f]+$/i.test(input.report) || input.report.length % 2 !== 0) return fail('report_not_hex');
  if (typeof input.cert_chain !== 'string') return fail('cert_chain_missing');
  const raw = Buffer.from(input.report, 'hex');
  const parsed = parseNvidiaReport(raw);
  if (!parsed) return fail('report_malformed');
  const chain = parsePemBundle(input.cert_chain);
  if (chain.length === 0) return fail('cert_chain_empty');
  const leaf = chain[0];
  const chainVerdict = verifyChainToPinnedRoot(leaf, chain.slice(1), rootsForScheme('nvidia_cc', ctx), ctx.nowMs);
  if (!chainVerdict.ok) return fail(`chain:${chainVerdict.reason}`);
  let sigOk = false;
  try {
    sigOk = crypto.verify('sha384', parsed.signed, { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, parsed.signature);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail('signature_invalid');
  const signerKey = spkiSha256(leaf);
  if (ctx.actorKeyFingerprints.has(signerKey)) return fail('signer_is_actor');
  const nonceBound = parsed.responseNonce.equals(ctx.bindingNonce);
  const model = (leaf.subject.match(/CN=([A-Z0-9]+)/)?.[1] ?? 'nvidia').toLowerCase();
  const serial = leaf.subject.match(/serialNumber=([0-9A-Fa-f]+)/)?.[1] ?? leaf.serialNumber;
  const fields = {
    tee_type: 'nvidia_cc_gpu',
    model,
    manufacturer: 'NVIDIA',
    measurement_digest: `sha384:${crypto.createHash('sha384').update(parsed.measurementRecord).digest('hex')}`,
    firmware_digest: parsed.opaque.length > 0 ? `sha256:${sha256Hex(parsed.opaque)}` : undefined,
    report_digest: `sha256:${sha256Hex(raw)}`,
    issuer_root_fingerprint: chainVerdict.rootFingerprint ?? undefined,
    signer_key_sha256: signerKey,
    serial_sha256: sha256Hex(serial),
    nonce_bound: nonceBound,
  };
  if (!nonceBound) return { admitted: false, scheme: 'nvidia_cc', reason: 'nonce_not_bound', fields };
  return { admitted: true, scheme: 'nvidia_cc', reason: 'verified', fields };
}
