/**
 * OUTPUT SIGNATURE — the ONE definition of a signature over an output an agent or a person's device
 * hands out, and of the citation that carries it :
 *
 * "every output an agent hands out carries its signature over the output's hash (SDK, MCP and
 * facilitator responses). A citation counts toward the producer's consumption when it carries
 * that signature."
 * "1. The producer's signature only establishes who made the output. The citing act must still
 * be witnessed, and the ring and self filters still apply …
 * 2. Outputs produced on devices that don't hold the wallet key (the MacBook daemon, phones) are
 * signed with that device's registered key and map to the owner through the same identity
 * index, so human-device work earns consumption too."
 *
 * THIS FILE IS BYTE-IDENTICAL IN THREE PACKAGES and `scripts/check-meter-wire-parity.sh` refuses any
 * drift:
 * provian-backend/src/core/meter/output-signature.ts (the relay: verifies at intake)
 * provian-agent-sdk/src/output-signature.ts (daemon + SDK: signs and cites)
 * src/core/meter/output-signature.ts (the app: signs and cites)
 * Pure: no I/O, no clock, no key material. Signing and verification are each package's own, over
 * the message defined here; `docs/audit/output-signature-vectors.json` binds every package to the
 * same bytes.
 *
 * WHAT IS SIGNED — one message for every key kind:
 * hash `sha256:<64 lowercase hex>` of the output's exact bytes (what the consumer received).
 * message `provian-output:v1:<64 lowercase hex>` (UTF-8). Domain-separated from every other
 * Provian-signed message (none begins `provian-output:`; it is not base64url, so it can
 * never be a device-signature preimage), and it carries the literal "provian", so the
 * app's WalletConnect guard never lets a dApp obtain one (`provianReserved.ts`).
 *
 * WHO SIGNS — the producer's REGISTERED key, three kinds:
 * wallet an agent's (or person's) wallet key, secp256k1. scheme `eip191_secp256k1` * `personal_sign` over the message; sig = 0x + 130 hex (r‖s‖v). id = the address
 * (0x + 40 lowercase hex), resolved through the native wallet address index or a proven
 * address registry.
 * device a registered observer device (`devices/{id}` e.g. a human's MacBook daemon), its
 * Secure-Enclave P-256 `signing_public_key`, or the P-256 output key a bearer device
 * registered. scheme `p256_sha256` ECDSA P-256 over SHA-256(message); sig = 128
 * lowercase hex (r‖s, low-s). id = the device id.
 * app a phone running the Provian app: its hardware PE-attestation key
 * (`provian_pe_attestation`, Secure Enclave / StrongBox — never the wallet key),
 * registered once under wallet auth. scheme `p256_sha256`. id = `aok_` + 32 hex.
 *
 * HOW IT TRAVELS
 * HTTP response header `Provian-Output-Signature: <base64url(canonical JSON of the object)>`.
 * MCP/JSON the object itself under `provian_output_signature`.
 * PE the consumer's next PE cites it as one `input_origins` entry:
 * `{ hash, origin_identifier: "out:<kind>:<id>", witnessed, witness?, signature }`.
 * The signature establishes WHO MADE the output (the owner of the citation edge); it
 * never makes the citing act witnessed — that is the citing lane's own witness.
 */

import { canonicalJson, bytesToHexLower, utf8Bytes } from './meter-wire';
import { sha256Bytes } from './meter-hash';

export const OUTPUT_SIGNATURE_MESSAGE_PREFIX = 'provian-output:v1:';
export const OUTPUT_SIGNATURE_HEADER = 'Provian-Output-Signature';
/** The JSON key a non-HTTP surface (an MCP tool result, a JSON body) carries the object under. */
export const OUTPUT_SIGNATURE_JSON_KEY = 'provian_output_signature';
/** The `input_origins` class of a signed citation: `out:<kind>:<id>`. */
export const OUTPUT_CITATION_SCHEME = 'out:';
/** Longest header value accepted (a wallet-signed object encodes to ~420 characters). */
export const OUTPUT_SIGNATURE_HEADER_MAX_LEN = 2048;
/** The message a P-256 output key signs to prove possession when it is registered. */
export const OUTPUT_KEY_REGISTRATION_PREFIX = 'provian-output-key:v1:';

export type OutputSignerKind = 'wallet' | 'device' | 'app';
export type OutputSignatureScheme = 'eip191_secp256k1' | 'p256_sha256';

export interface OutputSigner {
  readonly kind: OutputSignerKind;
  readonly id: string;
}

export interface OutputSignature {
  /** `sha256:<64 lowercase hex>` of the output bytes. */
  readonly hash: string;
  readonly signer: OutputSigner;
  readonly scheme: OutputSignatureScheme;
  /** eip191: 0x + 130 hex. p256: 128 hex (r‖s). Lowercase. */
  readonly sig: string;
}

/** The `input_origins` entry of a signed citation. */
export interface OutputCitationOrigin {
  readonly hash: string;
  readonly origin_identifier: string;
  readonly witnessed: boolean;
  readonly witness?: { readonly type: string; readonly identity: string; readonly attestation_tier?: string };
  readonly signature: OutputSignature;
}

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const APP_KEY_ID_RE = /^aok_[0-9a-f]{32}$/;
const EIP191_SIG_RE = /^0x[0-9a-f]{130}$/;
const P256_SIG_RE = /^[0-9a-f]{128}$/;
const P256_PUBLIC_KEY_RE = /^04[0-9a-f]{128}$/;

/** The scheme each signer kind signs with (one scheme per kind). */
export const OUTPUT_SIGNER_SCHEMES: Readonly<Record<OutputSignerKind, OutputSignatureScheme>> = Object.freeze({
  wallet: 'eip191_secp256k1',
  device: 'p256_sha256',
  app: 'p256_sha256',
});

/** `sha256:<hex>` of an output's exact bytes. */
export function outputHashOfBytes(bytes: Uint8Array): string {
  return `sha256:${bytesToHexLower(sha256Bytes(bytes))}`;
}

/** `sha256:<hex>` of an output that is text (UTF-8). */
export function outputHashOfText(text: string): string {
  return outputHashOfBytes(utf8Bytes(text));
}

/** The canonical form of an output hash (`sha256:` + 64 lowercase hex), or null. */
export function canonicalOutputHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return HASH_RE.test(lower) ? lower : null;
}

/** The exact UTF-8 message every signer kind signs for an output hash. */
export function outputSignatureMessage(hash: string): string {
  const canonical = canonicalOutputHash(hash);
  if (canonical === null) throw new Error('output_signature_bad_hash');
  return OUTPUT_SIGNATURE_MESSAGE_PREFIX + canonical.slice('sha256:'.length);
}

/** SHA-256 (hex) of the message — the digest a P-256 signer (Secure Enclave, StrongBox) signs. */
export function outputSignatureDigestHex(hash: string): string {
  return bytesToHexLower(sha256Bytes(utf8Bytes(outputSignatureMessage(hash))));
}

/** The canonical form of a signer reference, or null. */
export function normalizeOutputSigner(value: unknown): OutputSigner | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return null;
  switch (v.kind) {
    case 'wallet': {
      const id = v.id.trim().toLowerCase();
      return ADDRESS_RE.test(id) ? { kind: 'wallet', id } : null;
    }
    case 'device':
      return DEVICE_ID_RE.test(v.id) ? { kind: 'device', id: v.id } : null;
    case 'app': {
      const id = v.id.trim().toLowerCase();
      return APP_KEY_ID_RE.test(id) ? { kind: 'app', id } : null;
    }
    default:
      return null;
  }
}

/**
 * The canonical form of a signature object, or null when it is not one. Shape only (the scheme must
 * be the signer kind's scheme and the sig must have that scheme's shape): whether the signature
 * verifies against the signer's registered key is the verifier's check (the relay's, at intake).
 */
export function normalizeOutputSignature(value: unknown): OutputSignature | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const hash = canonicalOutputHash(v.hash);
  const signer = normalizeOutputSigner(v.signer);
  if (hash === null || signer === null || typeof v.sig !== 'string') return null;
  const scheme = OUTPUT_SIGNER_SCHEMES[signer.kind];
  if (v.scheme !== scheme) return null;
  const sig = v.sig.trim().toLowerCase();
  if (scheme === 'eip191_secp256k1' ? !EIP191_SIG_RE.test(sig) : !P256_SIG_RE.test(sig)) return null;
  return { hash, signer, scheme, sig };
}

/** The canonical SEC1 uncompressed P-256 public key (`04` + 128 hex, lowercase, no 0x), or null. */
export function canonicalP256PublicKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  const hex = v.startsWith('0x') ? v.slice(2) : v;
  return P256_PUBLIC_KEY_RE.test(hex) ? hex : null;
}

/** The registered id of an app output key: `aok_` + the first 32 hex of sha256(public key bytes). */
export function appOutputKeyId(publicKeyHex: string): string {
  const key = canonicalP256PublicKey(publicKeyHex);
  if (key === null) throw new Error('output_key_bad_public_key');
  const bytes = new Uint8Array(key.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
  return `aok_${bytesToHexLower(sha256Bytes(bytes)).slice(0, 32)}`;
}

/**
 * The proof-of-possession message a P-256 output key signs (ECDSA P-256 over SHA-256 of it) when
 * it is registered: bound to the key kind, the identity registering it, and the key itself.
 */
export function outputKeyRegistrationMessage(kind: 'device' | 'app', ownerId: string, publicKeyHex: string): string {
  const key = canonicalP256PublicKey(publicKeyHex);
  if (key === null) throw new Error('output_key_bad_public_key');
  if (ownerId.length === 0 || ownerId.includes(':')) throw new Error('output_key_bad_owner');
  return `${OUTPUT_KEY_REGISTRATION_PREFIX}${kind}:${ownerId}:${key}`;
}

// ─── base64url over ASCII (pure; the object's canonical JSON is ASCII-only) ─────

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64UrlOfAscii(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i);
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) : -1;
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)];
    if (b >= 0) out += B64URL[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)];
    if (c >= 0) out += B64URL[c & 63];
  }
  return out;
}

function asciiOfBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  let bits = 0;
  let acc = 0;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    acc = ((acc << 6) | B64URL.indexOf(value[i])) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const code = (acc >> bits) & 255;
      if (code > 126 || code < 32) return null;
      out += String.fromCharCode(code);
    }
  }
  return out;
}

/** The `Provian-Output-Signature` header value for a signature object. */
export function encodeOutputSignatureHeader(signature: OutputSignature): string {
  const canonical = normalizeOutputSignature(signature);
  if (canonical === null) throw new Error('output_signature_bad_shape');
  return base64UrlOfAscii(canonicalJson(canonical));
}

/**
 * Read a `Provian-Output-Signature` header value (base64url of the JSON object, or the JSON object
 * itself), or null when it is not a well-formed signature object.
 */
export function decodeOutputSignatureHeader(value: unknown): OutputSignature | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > OUTPUT_SIGNATURE_HEADER_MAX_LEN) return null;
  const json = trimmed.startsWith('{') ? trimmed : asciiOfBase64Url(trimmed);
  if (json === null) return null;
  try {
    return normalizeOutputSignature(JSON.parse(json));
  } catch {
    return null;
  }
}

/** `out:<kind>:<id>` for a signer. */
export function outputCitationIdentifier(signer: OutputSigner): string {
  const s = normalizeOutputSigner(signer);
  if (s === null) throw new Error('output_signature_bad_signer');
  return `${OUTPUT_CITATION_SCHEME}${s.kind}:${s.id}`;
}

/** The signer an `out:<kind>:<id>` identifier names, or null. */
export function outputCitationSignerOf(originIdentifier: unknown): OutputSigner | null {
  if (typeof originIdentifier !== 'string' || !originIdentifier.startsWith(OUTPUT_CITATION_SCHEME)) return null;
  const rest = originIdentifier.slice(OUTPUT_CITATION_SCHEME.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const signer = normalizeOutputSigner({ kind: rest.slice(0, colon), id: rest.slice(colon + 1) });
  // The identifier must already be canonical (it is hashed into the citer's PE).
  return signer !== null && `${signer.kind}:${signer.id}` === rest ? signer : null;
}

/**
 * The `input_origins` entry a consumer's next PE carries for an output it received signed. The
 * `witness` is the CITING lane's own witness (e.g. the observer daemon's device) — never the
 * producer: the producer's signature names the owner, not the act's witness. Without one the entry
 * is `witnessed: false`, and whether a non-actor key vouched the citing act is the relay's call.
 */
export function outputCitationOrigin(
  signature: OutputSignature,
  citingWitness?: { readonly type: string; readonly identity: string; readonly attestation_tier?: string } | null,
): OutputCitationOrigin {
  const s = normalizeOutputSignature(signature);
  if (s === null) throw new Error('output_signature_bad_shape');
  const base = { hash: s.hash, origin_identifier: outputCitationIdentifier(s.signer) };
  return citingWitness
    ? { ...base, witnessed: true, witness: { ...citingWitness }, signature: s }
    : { ...base, witnessed: false, signature: s };
}

/**
 * The signature carried on an `input_origins` entry when the entry is a well-formed signed citation
 * (an `out:` identifier, a well-formed signature naming the same signer and the same hash), else
 * null. Shape only — verification against the registered key is the verifier's.
 */
export function signedCitationOf(origin: unknown): OutputSignature | null {
  if (origin === null || typeof origin !== 'object' || Array.isArray(origin)) return null;
  const o = origin as Record<string, unknown>;
  const signer = outputCitationSignerOf(o.origin_identifier);
  const signature = normalizeOutputSignature(o.signature);
  if (signer === null || signature === null) return null;
  if (signature.signer.kind !== signer.kind || signature.signer.id !== signer.id) return null;
  if (signature.hash !== canonicalOutputHash(o.hash)) return null;
  return signature;
}

// ─── Commons outputs : what each Commons write's signature covers ─────────────
//
// A person (or agent) signs the content a Commons write publishes, over EXACTLY the text whose
// sha256 the write's PE seals in `output_digests`; the relay recomputes the same text from what it
// stores, refuses a signature over anything else, keeps the signature beside the record
// (`provian_output_signature`) and serves it with it, so a reader's witnessed act can cite it.

function dedupLower(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const c = v.trim().toLowerCase();
    if (c.length > 0 && !out.includes(c)) out.push(c);
  }
  return out;
}

/** A forum post or reply: its trimmed content. */
export function forumPostOutputText(content: string): string {
  return content.trim();
}

/** A want: its outcome, capabilities and preferred chains, normalized as the relay stores them. */
export function wantOutputText(outcome: string, capabilities: readonly string[], preferredChains: readonly string[] = []): string {
  return JSON.stringify({ outcome: outcome.trim(), capabilities: dedupLower(capabilities), preferredChains: dedupLower(preferredChains) });
}

/** A hiring-board job post: its trimmed title and description. */
export function jobPostOutputText(title: string, description: string): string {
  return JSON.stringify({ title: title.trim(), description: description.trim() });
}

/** A job deliverable: its body when it has one, else its trimmed URI. */
export function deliverableOutputText(uri: string | null | undefined, body: string | null | undefined): string {
  const b = typeof body === 'string' ? body : '';
  return b.length > 0 ? b : (typeof uri === 'string' ? uri.trim() : '');
}

/**
 * A thread message is E2E ciphertext the relay cannot read, so its signature rides INSIDE the
 * sealed plaintext as a trailing header line; the signature covers the message text before it.
 */
export const THREAD_OUTPUT_SIGNATURE_TRAILER = `\n\n${OUTPUT_SIGNATURE_HEADER}: `;

export function withThreadOutputSignature(text: string, signature: OutputSignature): string {
  return `${text}${THREAD_OUTPUT_SIGNATURE_TRAILER}${encodeOutputSignatureHeader(signature)}`;
}

/** Split a thread plaintext into its text and the signature over exactly that text (else null). */
export function splitThreadOutputSignature(plaintext: string): { text: string; signature: OutputSignature | null } {
  const at = plaintext.lastIndexOf(THREAD_OUTPUT_SIGNATURE_TRAILER);
  if (at < 0) return { text: plaintext, signature: null };
  const value = plaintext.slice(at + THREAD_OUTPUT_SIGNATURE_TRAILER.length);
  const signature = /^[A-Za-z0-9_-]+$/.test(value) ? decodeOutputSignatureHeader(value) : null;
  const text = plaintext.slice(0, at);
  if (signature === null || signature.hash !== outputHashOfText(text)) return { text: plaintext, signature: null };
  return { text, signature };
}
