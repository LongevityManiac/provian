/**
 * X.509 helpers over Node's `crypto.X509Certificate` — chain verification to a PINNED scheme root,
 * SPKI fingerprints, and a small DER scanner for the one extension Apple's App Attest puts its
 * nonce in. No third-party ASN.1 dependency: the relay's Docker build installs only
 * `provian-backend/package.json`.
 */
import crypto, { X509Certificate } from 'crypto';

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Accept PEM text or base64 DER; return the parsed certificate or null (never throws). */
export function parseCertificate(input: unknown): X509Certificate | null {
  if (Buffer.isBuffer(input)) {
    try { return new X509Certificate(input); } catch { return null; }
  }
  if (typeof input !== 'string' || input.length === 0) return null;
  const trimmed = input.trim();
  try {
    if (trimmed.includes('-----BEGIN CERTIFICATE-----')) return new X509Certificate(trimmed);
    return new X509Certificate(Buffer.from(trimmed, 'base64'));
  } catch {
    return null;
  }
}

/** Every PEM block in a bundle, in order. */
export function parsePemBundle(bundle: string): X509Certificate[] {
  const out: X509Certificate[] = [];
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  for (const m of bundle.match(re) ?? []) {
    const c = parseCertificate(m);
    if (c) out.push(c);
  }
  return out;
}

export function certFingerprintSha256(cert: X509Certificate): string {
  return cert.fingerprint256.replace(/:/g, '').toLowerCase();
}

/** sha256 over the certificate's SubjectPublicKeyInfo DER — the "who signed" identity. */
export function spkiSha256(cert: X509Certificate): string {
  return sha256Hex(cert.publicKey.export({ type: 'spki', format: 'der' }));
}

export function spkiSha256OfKey(key: crypto.KeyObject): string {
  return sha256Hex(key.export({ type: 'spki', format: 'der' }));
}

function validAt(cert: X509Certificate, nowMs: number): boolean {
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return nowMs >= from && nowMs <= to;
}

export interface ChainVerdict {
  readonly ok: boolean;
  readonly reason: string;
  /** sha256 fingerprint of the pinned root the chain terminated at (when ok). */
  readonly rootFingerprint: string | null;
  readonly depth: number;
}

/**
 * Verify leaf → intermediates → one of the PINNED roots. Every link is checked by signature
 * (`verify(issuer.publicKey)`) and issuer/subject name (`checkIssued`), every certificate must be
 * inside its validity window at `nowMs`, and the path must END at a pinned root (a self-signed
 * certificate that is not pinned terminates nothing). Order of `intermediates` is not assumed.
 */
export function verifyChainToPinnedRoot(
  leaf: X509Certificate,
  intermediates: readonly X509Certificate[],
  roots: readonly X509Certificate[],
  nowMs: number,
  maxDepth: number = 8,
): ChainVerdict {
  if (roots.length === 0) return { ok: false, reason: 'no_pinned_root', rootFingerprint: null, depth: 0 };
  if (!validAt(leaf, nowMs)) return { ok: false, reason: 'leaf_not_valid_now', rootFingerprint: null, depth: 0 };
  const pool = [...intermediates];
  let current = leaf;
  let depth = 0;
  const seen = new Set<string>([certFingerprintSha256(leaf)]);
  for (;;) {
    // Does a pinned root issue `current`?
    for (const root of roots) {
      if (current.checkIssued(root) && current.verify(root.publicKey)) {
        if (!validAt(root, nowMs)) return { ok: false, reason: 'root_not_valid_now', rootFingerprint: null, depth };
        return { ok: true, reason: 'chain_to_pinned_root', rootFingerprint: certFingerprintSha256(root), depth: depth + 1 };
      }
    }
    if (depth >= maxDepth) return { ok: false, reason: 'chain_too_deep', rootFingerprint: null, depth };
    // Otherwise find an intermediate that issues it.
    let next: X509Certificate | null = null;
    for (const c of pool) {
      const fp = certFingerprintSha256(c);
      if (seen.has(fp)) continue;
      if (current.checkIssued(c) && current.verify(c.publicKey)) { next = c; seen.add(fp); break; }
    }
    if (next === null) return { ok: false, reason: 'chain_does_not_reach_pinned_root', rootFingerprint: null, depth };
    if (!validAt(next, nowMs)) return { ok: false, reason: 'intermediate_not_valid_now', rootFingerprint: null, depth };
    current = next;
    depth += 1;
  }
}

// ─── DER scanning ──────────────────────────────────────────────────────────────

/** Encode a dotted OID to its DER content bytes. */
export function oidToDer(oid: string): Buffer {
  const parts = oid.split('.').map((p) => Number(p));
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) throw new Error('bad_oid');
  const bytes: number[] = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [];
    let v = p;
    do { chunk.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return Buffer.from(bytes);
}

interface DerTlv { readonly tag: number; readonly start: number; readonly length: number; readonly end: number }

export function readTlv(buf: Buffer, offset: number): DerTlv | null {
  if (offset + 2 > buf.length) return null;
  const tag = buf[offset];
  let len = buf[offset + 1];
  let pos = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || pos + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i += 1) len = (len << 8) | buf[pos + i];
    pos += n;
  }
  if (pos + len > buf.length) return null;
  return { tag, start: pos, length: len, end: pos + len };
}

/**
 * Find an X.509 extension by OID in a certificate's raw DER and return its extnValue OCTET STRING
 * contents (the inner DER), or null. The scan looks for `06 <len> <oid bytes>` followed by an
 * optional BOOLEAN critical and then `04 <len> …` — the shape every conformant extension has.
 */
export function findExtensionValue(certDer: Buffer, oid: string): Buffer | null {
  const oidBytes = oidToDer(oid);
  const needle = Buffer.concat([Buffer.from([0x06, oidBytes.length]), oidBytes]);
  let idx = certDer.indexOf(needle);
  while (idx >= 0) {
    let pos = idx + needle.length;
    const maybeBool = readTlv(certDer, pos);
    if (maybeBool && maybeBool.tag === 0x01) pos = maybeBool.end;
    const octet = readTlv(certDer, pos);
    if (octet && octet.tag === 0x04) return Buffer.from(certDer.subarray(octet.start, octet.end));
    idx = certDer.indexOf(needle, idx + 1);
  }
  return null;
}
