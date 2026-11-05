/**
 * TPM 2.0 quote — §2.9.
 *
 * `quote`     = TPMS_ATTEST: magic 0xFF544347, type TPM_ST_ATTEST_QUOTE (0x8018), qualifiedSigner
 *               TPM2B_NAME, extraData TPM2B_DATA (= the binding nonce), clockInfo (clock u64,
 *               resetCount u32, restartCount u32, safe u8), firmwareVersion u64, attested.quote =
 *               { pcrSelect TPML_PCR_SELECTION, pcrDigest TPM2B_DIGEST }.
 * `signature` = TPMT_SIGNATURE: sigAlg (RSASSA 0x0014 | ECDSA 0x0018), hashAlg, then TPM2B sig
 *               (RSASSA) or TPM2B r, TPM2B s (ECDSA).
 * `ak_public` = TPMT_PUBLIC (optionally wrapped in TPM2B_PUBLIC): type, nameAlg, attributes,
 *               authPolicy, parameters, unique — the key that MUST equal the leaf AK certificate's
 *               public key (so the chain vouches for exactly the signer).
 * `ak_cert_chain` leaf-first; must terminate at the scheme's pinned root (Google Cloud EK/AK CA
 *               Root for Compute Engine vTPMs; other public AK CAs are added to the SAME set —
 *               never a per-manufacturer catalog).
 */
import crypto from 'crypto';
import { parseCertificate, spkiSha256, verifyChainToPinnedRoot, sha256Hex } from './x509';
import { rootsForScheme, shippedIntermediatesFor } from './roots';
import type { HardwareVerifyContext, HardwareWitnessInput, HardwareWitnessVerdict } from './types';

const TPM_GENERATED = 0xff544347;
const ST_ATTEST_QUOTE = 0x8018;
const ALG_RSA = 0x0001;
const ALG_ECC = 0x0023;
const ALG_SHA1 = 0x0004;
const ALG_SHA256 = 0x000b;
const ALG_SHA384 = 0x000c;
const ALG_SHA512 = 0x000d;
const ALG_RSASSA = 0x0014;
const ALG_ECDSA = 0x0018;
const ALG_NULL = 0x0010;
const ALG_AES = 0x0006;

const HASH_NAMES: Record<number, string> = { [ALG_SHA1]: 'sha1', [ALG_SHA256]: 'sha256', [ALG_SHA384]: 'sha384', [ALG_SHA512]: 'sha512' };

class Reader {
  offset = 0;
  constructor(private readonly buf: Buffer) {}
  u8(): number { if (this.offset + 1 > this.buf.length) throw new Error('tpm_truncated'); return this.buf[this.offset++]; }
  u16(): number { if (this.offset + 2 > this.buf.length) throw new Error('tpm_truncated'); const v = this.buf.readUInt16BE(this.offset); this.offset += 2; return v; }
  u32(): number { if (this.offset + 4 > this.buf.length) throw new Error('tpm_truncated'); const v = this.buf.readUInt32BE(this.offset); this.offset += 4; return v; }
  u64(): bigint { if (this.offset + 8 > this.buf.length) throw new Error('tpm_truncated'); const v = this.buf.readBigUInt64BE(this.offset); this.offset += 8; return v; }
  bytes(n: number): Buffer { if (this.offset + n > this.buf.length) throw new Error('tpm_truncated'); const b = Buffer.from(this.buf.subarray(this.offset, this.offset + n)); this.offset += n; return b; }
  tpm2b(): Buffer { return this.bytes(this.u16()); }
  get remaining(): number { return this.buf.length - this.offset; }
}

export interface ParsedQuote {
  readonly extraData: Buffer;
  readonly pcrSelection: string;
  readonly pcrDigest: Buffer;
  readonly firmwareVersion: bigint;
  readonly clock: bigint;
  readonly resetCount: number;
}

export function parseTpmsAttestQuote(raw: Buffer): ParsedQuote | null {
  try {
    const r = new Reader(raw);
    if (r.u32() !== TPM_GENERATED) return null;
    if (r.u16() !== ST_ATTEST_QUOTE) return null;
    r.tpm2b(); // qualifiedSigner
    const extraData = r.tpm2b();
    const clock = r.u64();
    const resetCount = r.u32();
    r.u32(); // restartCount
    r.u8(); // safe
    const firmwareVersion = r.u64();
    const count = r.u32();
    if (count > 16) return null;
    const sel: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const hashAlg = r.u16();
      const size = r.u8();
      const bits = r.bytes(size);
      const pcrs: number[] = [];
      for (let b = 0; b < bits.length; b += 1) for (let bit = 0; bit < 8; bit += 1) if (bits[b] & (1 << bit)) pcrs.push(b * 8 + bit);
      sel.push(`${HASH_NAMES[hashAlg] ?? `alg${hashAlg}`}:${pcrs.join(',')}`);
    }
    const pcrDigest = r.tpm2b();
    if (r.remaining !== 0) return null;
    return { extraData, pcrSelection: sel.join(';'), pcrDigest, firmwareVersion, clock, resetCount };
  } catch {
    return null;
  }
}

export interface ParsedSignature { readonly alg: 'rsassa' | 'ecdsa'; readonly hash: string; readonly der: Buffer; readonly raw: Buffer }

export function parseTpmtSignature(raw: Buffer): ParsedSignature | null {
  try {
    const r = new Reader(raw);
    const sigAlg = r.u16();
    const hashAlg = r.u16();
    const hash = HASH_NAMES[hashAlg];
    if (!hash) return null;
    if (sigAlg === ALG_RSASSA) {
      const sig = r.tpm2b();
      if (r.remaining !== 0) return null;
      return { alg: 'rsassa', hash, der: sig, raw: sig };
    }
    if (sigAlg === ALG_ECDSA) {
      const rr = r.tpm2b();
      const ss = r.tpm2b();
      if (r.remaining !== 0) return null;
      return { alg: 'ecdsa', hash, der: derEcdsa(rr, ss), raw: Buffer.concat([rr, ss]) };
    }
    return null;
  } catch {
    return null;
  }
}

function derInt(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i += 1;
  let v = b.subarray(i);
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return Buffer.concat([Buffer.from([0x02, v.length]), v]);
}
function derEcdsa(r: Buffer, s: Buffer): Buffer {
  const body = Buffer.concat([derInt(r), derInt(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

export interface ParsedAkPublic { readonly key: crypto.KeyObject; readonly type: 'rsa' | 'ecc'; readonly nameAlg: string }

/** Parse TPMT_PUBLIC (or TPM2B_PUBLIC) into a Node KeyObject. */
export function parseTpmtPublic(raw: Buffer): ParsedAkPublic | null {
  const attempt = (buf: Buffer): ParsedAkPublic | null => {
    try {
      const r = new Reader(buf);
      const type = r.u16();
      const nameAlg = r.u16();
      r.u32(); // objectAttributes
      r.tpm2b(); // authPolicy
      if (type === ALG_RSA) {
        const symAlg = r.u16();
        if (symAlg !== ALG_NULL) { r.u16(); r.u16(); } // keyBits + mode (AES)
        const scheme = r.u16();
        if (scheme !== ALG_NULL) r.u16(); // scheme hash
        const keyBits = r.u16();
        const exponentRaw = r.u32();
        const exponent = exponentRaw === 0 ? 65537 : exponentRaw;
        const modulus = r.tpm2b();
        if (r.remaining !== 0 || modulus.length * 8 !== keyBits) return null;
        const key = crypto.createPublicKey({ key: { kty: 'RSA', n: modulus.toString('base64url'), e: Buffer.from(exponent.toString(16).padStart(6, '0'), 'hex').toString('base64url') }, format: 'jwk' });
        return { key, type: 'rsa', nameAlg: HASH_NAMES[nameAlg] ?? 'sha256' };
      }
      if (type === ALG_ECC) {
        const symAlg = r.u16();
        if (symAlg !== ALG_NULL && symAlg === ALG_AES) { r.u16(); r.u16(); }
        const scheme = r.u16();
        if (scheme !== ALG_NULL) r.u16();
        const curve = r.u16();
        const kdf = r.u16();
        if (kdf !== ALG_NULL) r.u16();
        const x = r.tpm2b();
        const y = r.tpm2b();
        if (r.remaining !== 0) return null;
        const crv = curve === 0x0003 ? 'P-256' : curve === 0x0004 ? 'P-384' : null;
        if (!crv) return null;
        const key = crypto.createPublicKey({ key: { kty: 'EC', crv, x: x.toString('base64url'), y: y.toString('base64url') }, format: 'jwk' });
        return { key, type: 'ecc', nameAlg: HASH_NAMES[nameAlg] ?? 'sha256' };
      }
      return null;
    } catch {
      return null;
    }
  };
  // TPM2B_PUBLIC wraps TPMT_PUBLIC in a u16 size.
  if (raw.length >= 2 && raw.readUInt16BE(0) === raw.length - 2) {
    const inner = attempt(raw.subarray(2));
    if (inner) return inner;
  }
  return attempt(raw);
}

function b64(input: unknown): Buffer | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  try { return Buffer.from(input, 'base64'); } catch { return null; }
}

export function verifyTpm2Quote(input: HardwareWitnessInput, ctx: HardwareVerifyContext): HardwareWitnessVerdict {
  const fail = (reason: string): HardwareWitnessVerdict => ({ admitted: false, scheme: 'tpm2_quote', reason, fields: null });
  const quoteRaw = b64(input.quote);
  const sigRaw = b64(input.signature);
  const akRaw = b64(input.ak_public);
  if (!quoteRaw || !sigRaw || !akRaw) return fail('fields_missing');
  if (!Array.isArray(input.ak_cert_chain) || input.ak_cert_chain.length === 0) return fail('ak_cert_chain_missing');
  const quote = parseTpmsAttestQuote(quoteRaw);
  if (!quote) return fail('quote_malformed');
  const sig = parseTpmtSignature(sigRaw);
  if (!sig) return fail('signature_malformed');
  const ak = parseTpmtPublic(akRaw);
  if (!ak) return fail('ak_public_malformed');
  const certs = input.ak_cert_chain.map((c) => parseCertificate(c));
  if (certs.some((c) => c === null)) return fail('ak_cert_unparseable');
  const leaf = certs[0]!;
  const intermediates = [...certs.slice(1).filter((c): c is NonNullable<typeof c> => c !== null), ...shippedIntermediatesFor('tpm2_quote')];
  // The certified key IS the quoting key.
  if (spkiSha256OfKey(ak.key) !== spkiSha256(leaf)) return fail('ak_public_not_certified');
  const chainVerdict = verifyChainToPinnedRoot(leaf, intermediates, rootsForScheme('tpm2_quote', ctx), ctx.nowMs);
  if (!chainVerdict.ok) return fail(`chain:${chainVerdict.reason}`);
  let sigOk = false;
  try {
    sigOk = sig.alg === 'rsassa'
      ? crypto.verify(sig.hash, quoteRaw, { key: ak.key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig.raw)
      : crypto.verify(sig.hash, quoteRaw, { key: ak.key, dsaEncoding: 'der' }, sig.der);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail('signature_invalid');
  const signerKey = spkiSha256(leaf);
  if (ctx.actorKeyFingerprints.has(signerKey)) return fail('signer_is_actor');
  const nonceBound = quote.extraData.equals(ctx.bindingNonce);
  const manufacturer = leaf.issuer.match(/O=([^\n]+)/)?.[1]?.trim();
  const fields = {
    tee_type: 'tpm2',
    tee_version: quote.firmwareVersion.toString(16),
    model: ak.type === 'rsa' ? 'tpm2_rsa_ak' : 'tpm2_ecc_ak',
    manufacturer,
    pcr_digest: `${sig.hash}:${quote.pcrDigest.toString('hex')}`,
    pcr_selection: quote.pcrSelection,
    report_digest: `sha256:${sha256Hex(quoteRaw)}`,
    issuer_root_fingerprint: chainVerdict.rootFingerprint ?? undefined,
    signer_key_sha256: signerKey,
    serial_sha256: sha256Hex(leaf.serialNumber),
    nonce_bound: nonceBound,
  };
  if (!nonceBound) return { admitted: false, scheme: 'tpm2_quote', reason: 'nonce_not_bound', fields };
  return { admitted: true, scheme: 'tpm2_quote', reason: 'verified', fields };
}

function spkiSha256OfKey(key: crypto.KeyObject): string {
  return sha256Hex(key.export({ type: 'spki', format: 'der' }));
}
