/**
 * follow-up — Solana identifiers, decoded exactly.
 *
 * A Solana address is the base58 encoding of a 32-byte ed25519 public key; a transaction signature
 * is the base58 encoding of a 64-byte ed25519 signature. Base58 is CASE-SENSITIVE, which matters
 * everywhere the relay was built around EVM hex: the mint-once claim store lowercases every subject
 * and event id (`mint-once-claim.ts::canonicalInput`), which is harmless for hex and destroys base58.
 * So a Solana identifier never enters a lowercasing key as base58: it enters as its exact bytes in
 * lowercase hex behind a `solana:` prefix (`solanaClaimSubject` / `solanaClaimSignature`), which is
 * injective, idempotent under lowercasing, and can never equal an EVM form (`0x…`, `chainId:0x…`).
 *
 * Pure, no I/O, no dependency: the relay carries no web3.js and `@noble/curves` v2 is ESM-only
 * (the backend is CommonJS), so decoding is a few lines of BigInt here and ed25519 verification
 * uses Node's own `crypto` (see `solana-proof.ts`).
 */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** base58 charset (no 0 O I l). A 32-byte key is 32–44 chars; a 64-byte signature 64–88. */
const SOLANA_ADDRESS_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** The claim-store forms (lowercase hex of the exact bytes). */
export const SOLANA_CLAIM_SUBJECT = /^solana:[0-9a-f]{64}$/;
export const SOLANA_CLAIM_SIGNATURE = /^solana:[0-9a-f]{128}$/;
/** A settlement event inside one transaction: the signature plus the instruction index. */
export const SOLANA_CLAIM_INSTRUCTION_EVENT = /^solana:[0-9a-f]{128}:\d{1,4}$/;
/** The readable canonical event id the lane seals: `solana:<base58 signature>:<instruction index>`. */
const SOLANA_READABLE_INSTRUCTION_EVENT = /^solana:([1-9A-HJ-NP-Za-km-z]{64,88}):(\d{1,4})$/;

/** Decode base58 to bytes, or null when it is not base58. Leading `1`s are leading zero bytes. */
export function base58Decode(value: string): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  let n = 0n;
  for (const c of value) {
    const v = B58_ALPHABET.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  for (const c of value) {
    if (c !== '1') break;
    zeros += 1;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

/** Encode bytes as base58 (the inverse of `base58Decode`). */
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function decodeExact(value: unknown, shape: RegExp, length: number): Uint8Array | null {
  if (typeof value !== 'string' || !shape.test(value)) return null;
  const bytes = base58Decode(value);
  if (bytes === null || bytes.length !== length) return null;
  // Canonical form only: a non-canonical spelling of the same bytes is refused, so one key has
  // exactly one string (the registry doc id and every comparison rely on it).
  return base58Encode(bytes) === value ? bytes : null;
}

/** The 32 public-key bytes of a canonical base58 Solana address, or null. */
export function solanaAddressBytes(value: unknown): Uint8Array | null {
  return decodeExact(value, SOLANA_ADDRESS_SHAPE, 32);
}

/** The 64 bytes of a canonical base58 Solana signature, or null. */
export function solanaSignatureBytes(value: unknown): Uint8Array | null {
  return decodeExact(value, SOLANA_SIGNATURE_SHAPE, 64);
}

export function isSolanaAddress(value: unknown): value is string {
  return solanaAddressBytes(value) !== null;
}

export function isSolanaSignature(value: unknown): value is string {
  return solanaSignatureBytes(value) !== null;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** The claim-store subject of a Solana address (`solana:<64 hex>`), or null. */
export function solanaClaimSubject(address: unknown): string | null {
  const bytes = solanaAddressBytes(address);
  return bytes === null ? null : `solana:${hex(bytes)}`;
}

/** The claim-store event of a Solana transaction signature (`solana:<128 hex>`), or null. */
export function solanaClaimSignature(signature: unknown): string | null {
  const bytes = solanaSignatureBytes(signature);
  return bytes === null ? null : `solana:${hex(bytes)}`;
}

/** The readable canonical event id of one instruction of a transaction. */
export function solanaInstructionEventId(signature: string, instructionIndex: number): string {
  if (!isSolanaSignature(signature)) throw new Error('solana_signature_invalid');
  if (!Number.isSafeInteger(instructionIndex) || instructionIndex < 0 || instructionIndex > 9999) {
    throw new Error('solana_instruction_index_invalid');
  }
  return `solana:${signature}:${instructionIndex}`;
}

/**
 * The claim-store event of a readable `solana:<base58 signature>:<ix>` id
 * (`solana:<128 hex>:<ix>`), or null when the input is not exactly that form.
 */
export function solanaClaimInstructionEvent(eventId: unknown): string | null {
  if (typeof eventId !== 'string') return null;
  const m = SOLANA_READABLE_INSTRUCTION_EVENT.exec(eventId);
  if (!m) return null;
  const sig = solanaClaimSignature(m[1]);
  if (sig === null) return null;
  const ix = Number(m[2]);
  if (String(ix) !== m[2]) return null; // no leading zeros: one event, one string
  return `${sig}:${ix}`;
}
