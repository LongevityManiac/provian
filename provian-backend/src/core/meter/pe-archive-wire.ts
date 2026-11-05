/**
 * PE ARCHIVE WIRE FORMAT — the ONE definition of an archived day (:
 * the paid PE Archive, opt-in per wallet).
 *
 * THIS FILE IS BYTE-IDENTICAL IN THREE PACKAGES and a parity check refuses any drift
 * (`scripts/check-pe-archive-wire-parity.sh`):
 * provian-backend/src/core/meter/pe-archive-wire.ts (the relay: validates headers, never opens)
 * provian-agent-sdk/src/pe-archive-wire.ts (daemon + SDK: builds, seals, opens)
 * src/core/meter/pe-archive-wire.ts (the app: builds, seals, opens)
 * The per-package files are `./meter-hash` (sha256) and `./pe-archive-crypto` (the sealed box the
 * mailbox and thread messages already use: x25519 + HKDF-SHA256 + XChaCha20-Poly1305, v0x01).
 *
 * WHAT AN ARCHIVED DAY IS
 * One object per wallet per UTC day in Archive-class Cloud Storage. A wallet's day is every PE
 * whose batch was anchored in that day's on-chain root (the batch's `day`, the UTC day it was
 * accepted). The object is one or more PARTS, one per line; normally one (a single device's day),
 * more when a wallet has several devices or a day is larger than one upload.
 *
 * part (one line) = canonicalJson(header) + "\n". The header is plaintext the relay can check
 * without reading any PE: whose day it is, which device, how many PEs, and
 * every batch it covers (identity + its anchor proof), plus the sealed payload.
 * payload (sealed) = every PE of the part, complete (with its pe_hash), each with its inclusion
 * proof: act leaf → acts_root → batch leaf → that day's anchored root.
 *
 * SEALING: a fresh content key (x25519) per part. The payload is sealed to the content key's public
 * half; the content key's secret is sealed to each RECIPIENT (the owner, and for an agent with a
 * linked human, that human), so either can open the part with their own message key and nobody
 * else can — the relay holds ciphertext only.
 *
 * OPENING re-checks everything: the payload names the same wallet/day/device/part as its header;
 * every PE's own hash; every PE's act leaf to its batch's acts_root, and that batch's leaf, against
 * the header's batch list. An opened part's entries present exactly like PEs held locally.
 *
 * Pure: no I/O, no clock. Randomness only through the injectable `randomBytes`.
 */

import { sha256Bytes } from './meter-hash';
import { archiveContentKeyPair, archiveOpenBox, archiveSealBox, type ArchiveRandomBytes } from './pe-archive-crypto';
import {
  actLeafOf,
  actRecordOf,
  batchLeafOf,
  bytesToHexLower,
  canonicalJson,
  merkleProofOf,
  merkleRootOf,
  peHashOf,
  PE_V2_SCHEMA,
  utf8Bytes,
  verifyActInclusion,
  type ActInclusionProof,
  type PeV2,
} from './meter-wire';

export const PE_ARCHIVE_PART_SCHEMA = 'provian.pe-archive-part.v1';
export const PE_ARCHIVE_PAYLOAD_SCHEMA = 'provian.pe-archive-payload.v1';
/** 1 GB = 10^9 bytes (decimal), the unit the Archive is bought in. */
export const ARCHIVE_BYTES_PER_GB = 1_000_000_000;
/** $5 USDC per GB, in USDC atomic units (6 decimals). */
export const ARCHIVE_GB_PRICE_USDC_ATOMIC = '5000000';
/** With the Archive on, a device keeps the most recent 30 days of PEs locally. */
export const ARCHIVE_LOCAL_KEEP_DAYS = 30;
/** One part's upper bound on the wire (a day larger than this is uploaded as several parts). */
export const ARCHIVE_MAX_PART_BYTES = 24_000_000;
/** Batches one part may cover. */
export const ARCHIVE_MAX_BATCHES_PER_PART = 500;
/** Recipients one part may be sealed to (owner + linked human, with room for a rotated key). */
export const ARCHIVE_MAX_RECIPIENTS = 4;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PROOF_ITEM = /^(0x)?[0-9a-fA-F]{64}$/;
const B64U = /^[A-Za-z0-9_-]*$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

// ─── base64url (no padding), pure ───────────────────────────────────────────────

const B64U_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function bytesToB64u(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64U_ALPHABET[(n >> 18) & 63] + B64U_ALPHABET[(n >> 12) & 63] + B64U_ALPHABET[(n >> 6) & 63] + B64U_ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64U_ALPHABET[(n >> 18) & 63] + B64U_ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64U_ALPHABET[(n >> 18) & 63] + B64U_ALPHABET[(n >> 12) & 63] + B64U_ALPHABET[(n >> 6) & 63];
  }
  return out;
}

export function b64uToBytes(text: string): Uint8Array {
  if (!B64U.test(text) || text.length % 4 === 1) throw new Error('archive_b64u_invalid');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    acc = (acc << 6) | B64U_ALPHABET.indexOf(text[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// ─── UTF-8 decode, pure (Hermes may lack TextDecoder) ───────────────────────────

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp: number;
    let n: number;
    if (b < 0x80) { cp = b; n = 1; }
    else if (b >= 0xc2 && b < 0xe0) { cp = b & 0x1f; n = 2; }
    else if (b >= 0xe0 && b < 0xf0) { cp = b & 0x0f; n = 3; }
    else if (b >= 0xf0 && b < 0xf5) { cp = b & 0x07; n = 4; }
    else throw new Error('archive_utf8_invalid');
    if (i + n > bytes.length) throw new Error('archive_utf8_invalid');
    for (let k = 1; k < n; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) throw new Error('archive_utf8_invalid');
      cp = (cp << 6) | (c & 0x3f);
    }
    if ((n === 3 && cp < 0x800) || (n === 4 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) {
      throw new Error('archive_utf8_invalid');
    }
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

export function sha256HexOfBytes(bytes: Uint8Array): string {
  return bytesToHexLower(sha256Bytes(bytes));
}

// ─── records ────────────────────────────────────────────────────────────────────

/** The anchor half of a batch's proof: its batch leaf's keccak path to that day's on-chain root. */
export interface ArchiveAnchorRef {
  readonly day: string;
  readonly anchor_batch_id: string;
  /** 2026-10-10: the intra-day anchor segment (`<day>:<n>`) the batch was anchored in; absent for the day's close anchor. */
  readonly segment?: number;
  readonly leaf_index: number;
  readonly proof: readonly string[];
  readonly merkle_root: string;
  readonly tx_hash: string | null;
}

/** One batch a part covers: its identity (what its batch leaf commits to) and its anchor proof. */
export interface ArchiveBatchRef {
  readonly device_id: string;
  readonly actor_id: string;
  readonly seq: number;
  readonly batch_hash: string;
  readonly acts_root: string;
  readonly batch_leaf: string;
  readonly first_index: number;
  readonly count: number;
  readonly anchor: ArchiveAnchorRef;
}

export interface ArchiveRecipientBox {
  readonly party_id: string;
  /** base64url sealed box of the part's content secret, to this party's message key. */
  readonly key_box: string;
}

/** A part's plaintext header (what the relay validates; it never opens `payload_box`). */
export interface ArchivePartHeader {
  readonly schema: string;
  readonly wallet: string;
  readonly day: string;
  readonly device_id: string;
  readonly part: number;
  readonly pe_count: number;
  readonly batches: readonly ArchiveBatchRef[];
  readonly recipients: readonly ArchiveRecipientBox[];
  /** base64url sealed box of the payload, to the part's content key. */
  readonly payload_box: string;
}

/** One archived PE: complete, with its chain position and its inclusion proof. */
export interface ArchiveEntry {
  readonly index: number;
  readonly pe: PeV2 & { readonly pe_hash: string };
  readonly inclusion: ActInclusionProof;
}

export interface ArchivePayload {
  readonly schema: string;
  readonly wallet: string;
  readonly day: string;
  readonly device_id: string;
  readonly part: number;
  readonly entries: readonly ArchiveEntry[];
}

export interface ArchiveRecipient {
  readonly party_id: string;
  /** The party's x25519 message key, base64url (32 bytes). */
  readonly pubkey_b64u: string;
}

// ─── days ───────────────────────────────────────────────────────────────────────

/** The UTC day key (YYYY-MM-DD) of a millisecond time: the day a batch accepted then is anchored in. */
export function archiveDayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Whole UTC days from `day` to the day of `nowMs` (0 = today). */
export function archiveDayAgeDays(day: string, nowMs: number): number {
  if (!DAY_RE.test(day)) throw new Error('archive_day_invalid');
  const start = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  return Math.floor((today - start) / 86_400_000);
}

/**
 * True when a confirmed day may be dropped locally: the device keeps the most recent
 * ARCHIVE_LOCAL_KEEP_DAYS days (today and the 29 before it), so only older days drop.
 */
export function archiveDayDroppable(day: string, nowMs: number): boolean {
  return archiveDayAgeDays(day, nowMs) >= ARCHIVE_LOCAL_KEEP_DAYS;
}

/** The object a wallet's day lives at in the Archive bucket. */
export function archiveObjectPath(wallet: string, day: string): string {
  if (!ID_RE.test(wallet) || !DAY_RE.test(day)) throw new Error('archive_object_path_invalid');
  return `v1/${wallet.replace(/:/g, '_')}/${day}.pea`;
}

/** The index id of a wallet's day (`archive_days_v1/{wallet}_{YYYY-MM-DD}`). */
export function archiveDayId(wallet: string, day: string): string {
  if (!ID_RE.test(wallet) || !DAY_RE.test(day)) throw new Error('archive_day_id_invalid');
  return `${wallet.replace(/:/g, '_')}_${day}`;
}

// ─── building (device side) ─────────────────────────────────────────────────────

/** One batch as a device holds it, with its PEs (in chain order) and its anchor proof. */
export interface ArchiveBatchInput {
  readonly device_id: string;
  readonly actor_id: string;
  readonly seq: number;
  readonly batch_hash: string;
  readonly acts_root: string;
  readonly batch_leaf: string;
  readonly first_index: number;
  readonly pes: readonly (PeV2 & { readonly pe_hash: string })[];
  readonly anchor: ArchiveAnchorRef;
}

/**
 * Build the entries and batch refs of one device's day from its batches. Every check a verifier
 * would run is run here first: each PE's own hash, the batch's acts_root rebuilt from its PEs, the
 * batch leaf recomputed from its identity, and the anchor's day equal to `day`. Throws on any miss
 * (a day that cannot be proven is never archived).
 */
export function buildArchiveEntries(
  day: string,
  batches: readonly ArchiveBatchInput[],
  anchorContract = '',
): { entries: ArchiveEntry[]; refs: ArchiveBatchRef[] } {
  if (!DAY_RE.test(day)) throw new Error('archive_day_invalid');
  const entries: ArchiveEntry[] = [];
  const refs: ArchiveBatchRef[] = [];
  for (const b of batches) {
    if (b.pes.length === 0) throw new Error(`archive_batch_empty:${b.seq}`);
    if (b.anchor.day !== day) throw new Error(`archive_batch_wrong_day:${b.seq}`);
    for (const pe of b.pes) {
      if (pe.schema !== PE_V2_SCHEMA || peHashOf(pe) !== pe.pe_hash) throw new Error(`archive_pe_hash_mismatch:${pe.pe_id}`);
      if (pe.device_id !== b.device_id) throw new Error(`archive_pe_device_mismatch:${pe.pe_id}`);
    }
    const leaves = b.pes.map((pe) => actLeafOf(actRecordOf(pe)));
    if (merkleRootOf(leaves) !== b.acts_root) throw new Error(`archive_acts_root_mismatch:${b.seq}`);
    const leaf = batchLeafOf({ device_id: b.device_id, actor_id: b.actor_id, seq: b.seq, batch_hash: b.batch_hash, acts_root: b.acts_root });
    if (leaf !== b.batch_leaf) throw new Error(`archive_batch_leaf_mismatch:${b.seq}`);
    refs.push({
      device_id: b.device_id,
      actor_id: b.actor_id,
      seq: b.seq,
      batch_hash: b.batch_hash,
      acts_root: b.acts_root,
      batch_leaf: b.batch_leaf,
      first_index: b.first_index,
      count: b.pes.length,
      anchor: {
        day: b.anchor.day,
        anchor_batch_id: b.anchor.anchor_batch_id,
        ...(b.anchor.segment !== undefined ? { segment: b.anchor.segment } : {}),
        leaf_index: b.anchor.leaf_index,
        proof: [...b.anchor.proof],
        merkle_root: b.anchor.merkle_root,
        tx_hash: b.anchor.tx_hash,
      },
    });
    b.pes.forEach((pe, i) => {
      entries.push({
        index: b.first_index + i,
        pe,
        inclusion: {
          act_index: i,
          act_proof: merkleProofOf(leaves, i),
          acts_root: b.acts_root,
          batch: { device_id: b.device_id, actor_id: b.actor_id, seq: b.seq, batch_hash: b.batch_hash },
          anchor: {
            chain_id: 8453,
            contract: anchorContract,
            anchor_batch_id: b.anchor.anchor_batch_id,
            day: b.anchor.day,
            ...(b.anchor.segment !== undefined ? { segment: b.anchor.segment } : {}),
            leaf_index: b.anchor.leaf_index,
            proof: [...b.anchor.proof],
            merkle_root: b.anchor.merkle_root,
            tx_hash: b.anchor.tx_hash,
          },
        },
      });
    });
  }
  return { entries, refs };
}

/**
 * Split a device's day into parts that each fit ARCHIVE_MAX_PART_BYTES, never splitting a batch.
 * `estimate` sizes a candidate list of batches' entries (bytes of the sealed line, roughly).
 */
export function planArchiveParts(batches: readonly ArchiveBatchInput[], maxEntryBytes: number = ARCHIVE_MAX_PART_BYTES): ArchiveBatchInput[][] {
  const parts: ArchiveBatchInput[][] = [];
  let current: ArchiveBatchInput[] = [];
  let bytes = 0;
  for (const b of batches) {
    // Sealed size ≈ (JSON of the PEs + proofs) × 4/3 (base64url) + a fixed header.
    let size = 2_000 + b.pes.length * 1_200;
    for (const pe of b.pes) size += canonicalJson(pe).length;
    size = Math.ceil(size * 1.4);
    if (current.length > 0 && (bytes + size > maxEntryBytes || current.length >= ARCHIVE_MAX_BATCHES_PER_PART)) {
      parts.push(current);
      current = [];
      bytes = 0;
    }
    current.push(b);
    bytes += size;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** Seal one part. Returns its line (what is uploaded), its bytes and their sha256. */
export function sealArchivePart(input: {
  readonly wallet: string;
  readonly day: string;
  readonly device_id: string;
  readonly part: number;
  readonly entries: readonly ArchiveEntry[];
  readonly refs: readonly ArchiveBatchRef[];
  readonly recipients: readonly ArchiveRecipient[];
  readonly randomBytes?: ArchiveRandomBytes;
}): { readonly line: string; readonly bytes: Uint8Array; readonly sha256: string; readonly header: ArchivePartHeader } {
  if (input.recipients.length === 0 || input.recipients.length > ARCHIVE_MAX_RECIPIENTS) throw new Error('archive_recipients_invalid');
  if (input.entries.length === 0) throw new Error('archive_part_empty');
  const payload: ArchivePayload = {
    schema: PE_ARCHIVE_PAYLOAD_SCHEMA,
    wallet: input.wallet,
    day: input.day,
    device_id: input.device_id,
    part: input.part,
    entries: input.entries,
  };
  const content = archiveContentKeyPair(input.randomBytes);
  const payloadBox = archiveSealBox(content.publicKey, utf8Bytes(canonicalJson(payload)), input.randomBytes);
  const recipients: ArchiveRecipientBox[] = input.recipients.map((r) => ({
    party_id: r.party_id,
    key_box: bytesToB64u(archiveSealBox(b64uToBytes(r.pubkey_b64u), content.secretKey, input.randomBytes)),
  }));
  content.secretKey.fill(0);
  const header: ArchivePartHeader = {
    schema: PE_ARCHIVE_PART_SCHEMA,
    wallet: input.wallet,
    day: input.day,
    device_id: input.device_id,
    part: input.part,
    pe_count: input.entries.length,
    batches: input.refs,
    recipients,
    payload_box: bytesToB64u(payloadBox),
  };
  const parsed = validateArchivePartHeader(header);
  if (!parsed.ok) throw new Error(`archive_part_invalid:${parsed.error}`);
  const line = `${canonicalJson(header)}\n`;
  const bytes = utf8Bytes(line);
  return { line, bytes, sha256: sha256HexOfBytes(bytes), header };
}

// ─── validation (relay side; no secret needed) ──────────────────────────────────

export type ArchiveHeaderError =
  | 'bad_schema'
  | 'bad_wallet'
  | 'bad_day'
  | 'bad_device_id'
  | 'bad_part'
  | 'bad_pe_count'
  | 'bad_batches'
  | 'bad_batch'
  | 'batch_leaf_mismatch'
  | 'batch_wrong_day'
  | 'batch_count_mismatch'
  | 'bad_recipients'
  | 'bad_payload_box'
  | 'not_canonical';

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isInt(x: unknown, min: number, max: number): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;
}

/**
 * Structural validation of a header. Recomputes every batch leaf from its identity (so a header
 * can only name batches as they were committed) and requires the batches to be one device's,
 * anchored on the header's day, whose counts add up to `pe_count`.
 */
export function validateArchivePartHeader(raw: unknown): { ok: true; header: ArchivePartHeader } | { ok: false; error: ArchiveHeaderError } {
  if (!isRecord(raw) || raw.schema !== PE_ARCHIVE_PART_SCHEMA) return { ok: false, error: 'bad_schema' };
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'batches,day,device_id,part,payload_box,pe_count,recipients,schema,wallet') return { ok: false, error: 'bad_schema' };
  if (typeof raw.wallet !== 'string' || !ID_RE.test(raw.wallet)) return { ok: false, error: 'bad_wallet' };
  if (typeof raw.day !== 'string' || !DAY_RE.test(raw.day)) return { ok: false, error: 'bad_day' };
  if (typeof raw.device_id !== 'string' || !ID_RE.test(raw.device_id)) return { ok: false, error: 'bad_device_id' };
  if (!isInt(raw.part, 0, 9_999)) return { ok: false, error: 'bad_part' };
  if (!isInt(raw.pe_count, 1, 10_000_000)) return { ok: false, error: 'bad_pe_count' };
  if (!Array.isArray(raw.batches) || raw.batches.length === 0 || raw.batches.length > ARCHIVE_MAX_BATCHES_PER_PART) {
    return { ok: false, error: 'bad_batches' };
  }
  let total = 0;
  const seqs = new Set<number>();
  for (const b of raw.batches as unknown[]) {
    if (!isRecord(b) || !isRecord(b.anchor)) return { ok: false, error: 'bad_batch' };
    const a = b.anchor;
    if (b.device_id !== raw.device_id || typeof b.actor_id !== 'string' || !ID_RE.test(b.actor_id)
      || !isInt(b.seq, 1, Number.MAX_SAFE_INTEGER) || seqs.has(b.seq)
      || typeof b.batch_hash !== 'string' || !HEX64.test(b.batch_hash)
      || typeof b.acts_root !== 'string' || !HEX64.test(b.acts_root)
      || typeof b.batch_leaf !== 'string' || !HEX64.test(b.batch_leaf)
      || !isInt(b.first_index, 0, Number.MAX_SAFE_INTEGER) || !isInt(b.count, 1, 500)
      || typeof a.day !== 'string' || !DAY_RE.test(a.day)
      || typeof a.anchor_batch_id !== 'string' || a.anchor_batch_id.length > 80
      || !(a.segment === undefined || isInt(a.segment, 1, Number.MAX_SAFE_INTEGER))
      || !isInt(a.leaf_index, 0, Number.MAX_SAFE_INTEGER)
      || !Array.isArray(a.proof) || a.proof.length > 64 || !(a.proof as unknown[]).every((p) => typeof p === 'string' && PROOF_ITEM.test(p))
      || typeof a.merkle_root !== 'string' || a.merkle_root.length > 80
      || !(a.tx_hash === null || (typeof a.tx_hash === 'string' && a.tx_hash.length <= 80))) {
      return { ok: false, error: 'bad_batch' };
    }
    if (a.day !== raw.day) return { ok: false, error: 'batch_wrong_day' };
    const leaf = batchLeafOf({ device_id: b.device_id, actor_id: b.actor_id, seq: b.seq, batch_hash: b.batch_hash, acts_root: b.acts_root });
    if (leaf !== b.batch_leaf) return { ok: false, error: 'batch_leaf_mismatch' };
    seqs.add(b.seq);
    total += b.count;
  }
  if (total !== raw.pe_count) return { ok: false, error: 'batch_count_mismatch' };
  if (!Array.isArray(raw.recipients) || raw.recipients.length === 0 || raw.recipients.length > ARCHIVE_MAX_RECIPIENTS) {
    return { ok: false, error: 'bad_recipients' };
  }
  for (const r of raw.recipients as unknown[]) {
    if (!isRecord(r) || typeof r.party_id !== 'string' || !ID_RE.test(r.party_id)
      || typeof r.key_box !== 'string' || !B64U.test(r.key_box) || r.key_box.length < 40 || r.key_box.length > 200) {
      return { ok: false, error: 'bad_recipients' };
    }
  }
  if (typeof raw.payload_box !== 'string' || raw.payload_box.length < 80 || !B64U.test(raw.payload_box)) {
    return { ok: false, error: 'bad_payload_box' };
  }
  return { ok: true, header: raw as unknown as ArchivePartHeader };
}

/**
 * Parse one uploaded part (its exact bytes). The bytes must be exactly the canonical JSON of the
 * header plus one newline — so the stored bytes and the validated header are the same thing.
 */
export function parseArchivePart(bytes: Uint8Array): { ok: true; header: ArchivePartHeader; sha256: string } | { ok: false; error: ArchiveHeaderError } {
  let text: string;
  try {
    text = utf8Decode(bytes);
  } catch {
    return { ok: false, error: 'not_canonical' };
  }
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return { ok: false, error: 'not_canonical' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(0, -1));
  } catch {
    return { ok: false, error: 'not_canonical' };
  }
  const v = validateArchivePartHeader(raw);
  if (!v.ok) return v;
  if (`${canonicalJson(raw)}\n` !== text) return { ok: false, error: 'not_canonical' };
  return { ok: true, header: v.header, sha256: sha256HexOfBytes(bytes) };
}

/** Split a stored day object into its part lines (bytes of each, newline included). */
export function splitArchiveObject(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      out.push(bytes.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start !== bytes.length) throw new Error('archive_object_torn');
  return out;
}

// ─── opening (owner / linked human) ─────────────────────────────────────────────

export type ArchiveOpenError =
  | 'not_a_recipient'
  | 'key_box_unopenable'
  | 'payload_unopenable'
  | 'payload_malformed'
  | 'payload_header_mismatch'
  | 'pe_hash_mismatch'
  | 'act_not_in_batch'
  | 'batch_not_in_header'
  | 'entry_count_mismatch';

/**
 * Open one part with a recipient's x25519 message secret and verify every PE in it. `partyId`
 * picks that recipient's key box; without it every box is tried. Never returns an unverified PE.
 */
export function openArchivePart(
  header: ArchivePartHeader,
  secretKey: Uint8Array,
  partyId?: string,
): { ok: true; payload: ArchivePayload } | { ok: false; error: ArchiveOpenError } {
  const boxes = partyId === undefined ? header.recipients : header.recipients.filter((r) => r.party_id === partyId);
  if (boxes.length === 0) return { ok: false, error: 'not_a_recipient' };
  let contentSecret: Uint8Array | null = null;
  for (const r of boxes) {
    try {
      contentSecret = archiveOpenBox(secretKey, b64uToBytes(r.key_box));
      break;
    } catch {
      contentSecret = null;
    }
  }
  if (contentSecret === null) return { ok: false, error: 'key_box_unopenable' };
  let text: string;
  try {
    text = utf8Decode(archiveOpenBox(contentSecret, b64uToBytes(header.payload_box)));
  } catch {
    return { ok: false, error: 'payload_unopenable' };
  } finally {
    contentSecret.fill(0);
  }
  let payload: ArchivePayload;
  try {
    payload = JSON.parse(text) as ArchivePayload;
  } catch {
    return { ok: false, error: 'payload_malformed' };
  }
  if (!isRecord(payload) || payload.schema !== PE_ARCHIVE_PAYLOAD_SCHEMA || !Array.isArray(payload.entries)) {
    return { ok: false, error: 'payload_malformed' };
  }
  if (payload.wallet !== header.wallet || payload.day !== header.day || payload.device_id !== header.device_id || payload.part !== header.part) {
    return { ok: false, error: 'payload_header_mismatch' };
  }
  if (payload.entries.length !== header.pe_count) return { ok: false, error: 'entry_count_mismatch' };
  const bySeq = new Map(header.batches.map((b) => [b.seq, b]));
  for (const e of payload.entries) {
    const problem = archiveEntryProblem(e, bySeq);
    if (problem !== null) return { ok: false, error: problem };
  }
  return { ok: true, payload };
}

function archiveEntryProblem(e: unknown, bySeq: ReadonlyMap<number, ArchiveBatchRef>): ArchiveOpenError | null {
  try {
    if (!isRecord(e) || !isRecord(e.pe) || !isRecord(e.inclusion) || !isRecord(e.inclusion.batch)) return 'payload_malformed';
    const entry = e as unknown as ArchiveEntry;
    const pe = entry.pe;
    if (pe.schema !== PE_V2_SCHEMA || typeof pe.pe_hash !== 'string' || peHashOf(pe) !== pe.pe_hash) return 'pe_hash_mismatch';
    const inc = entry.inclusion;
    const ref = bySeq.get(inc.batch.seq);
    if (ref === undefined || ref.batch_hash !== inc.batch.batch_hash || ref.acts_root !== inc.acts_root
      || ref.actor_id !== inc.batch.actor_id || ref.device_id !== inc.batch.device_id || pe.device_id !== ref.device_id) {
      return 'batch_not_in_header';
    }
    const hop = verifyActInclusion(pe, inc);
    if (!hop.ok || hop.batch_leaf !== ref.batch_leaf) return 'act_not_in_batch';
    return null;
  } catch {
    return 'payload_malformed';
  }
}

/** Find one PE in an opened day (its entry presents exactly like a locally held PE). */
export function findArchivedEntry(payloads: readonly ArchivePayload[], peId: string): ArchiveEntry | null {
  for (const p of payloads) {
    for (const e of p.entries) if (e.pe.pe_id === peId) return e;
  }
  return null;
}
