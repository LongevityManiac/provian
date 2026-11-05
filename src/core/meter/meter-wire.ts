/**
 * PE METER WIRE FORMAT — the ONE definition of a v2 Provenance Envelope, its act record,
 * the daily batch, and the fingerprints over them (: the relay is a
 * meter, not an archive).
 *
 * THIS FILE IS BYTE-IDENTICAL IN THREE PACKAGES and a parity check refuses any drift:
 * provian-backend/src/core/meter/meter-wire.ts (the relay)
 * provian-agent-sdk/src/meter-wire.ts (daemon + SDK)
 * src/core/meter/meter-wire.ts (the app)
 * The only per-package file is `./meter-hash` (a sha256 over bytes), because the three
 * packages carry different hash libraries. Everything that decides a byte lives here.
 *
 * WHAT EACH THING IS
 * PE (v2) — the complete envelope. Built, hashed and kept by its OWNER's device. The
 * relay never stores it.
 * act record — what the relay prices: the PE's identity fields, its pe_hash (which covers
 * the complete PE), and `pricing` = the PE minus identity fields and free text.
 * batch — one signed, chained submission per device per day (and right before a
 * presentation or payout); `acts_root` is the
 * fingerprint over every act leaf.
 * batch leaf — what the daily on-chain anchor commits to (one per accepted batch).
 *
 * Proving one act later: act leaf → acts_root (Merkle path) → batch leaf → the day's on-chain
 * root (PEAnchor.verifyPE). Anyone holding the PE recomputes every step; nobody else needs it.
 *
 * Pure: no I/O, no clock, no randomness.
 */

import { sha256Bytes } from './meter-hash';

export const PE_V2_SCHEMA = 'provian.pe.v2';
export const PE_BATCH_SCHEMA = 'provian.pe-batch.v1';
export const METER_GENESIS_PREV_HASH = 'genesis';
export const MAX_ACTS_PER_BATCH = 500;
/** An act older than this when it reaches the relay is recorded into totals but does not mint. */
export const METER_MINT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const ACT_LEAF_DOMAIN = 'provian.meter.act.v1\n';
const BATCH_LEAF_DOMAIN = 'provian.meter.batch-leaf.v1\n';

/** Fields of a PE that are identity or free text, never pricing inputs. */
export const NON_PRICING_PE_FIELDS: readonly string[] = [
  'schema',
  'pe_id',
  'device_id',
  'prev_hash',
  'timestamp',
  'action_type',
  'pe_hash',
  'signature',
  'description',
  'intent_text',
  'private_commitment',
  'private_owner_view',
  'detail_commitment',
];

/** Fields excluded from a PE's own hash (the hash cannot cover itself; the signature signs it). */
const PE_HASH_EXCLUDED: readonly string[] = ['pe_hash', 'signature'];

export interface PeV2 {
  readonly schema: string;
  readonly pe_id: string;
  readonly device_id: string;
  readonly prev_hash: string;
  readonly timestamp: number;
  readonly action_type: string;
  readonly pe_hash?: string;
  readonly signature?: string;
  readonly description?: string;
  readonly [field: string]: unknown;
}

export interface ActRecord {
  readonly pe_id: string;
  readonly pe_hash: string;
  readonly prev_hash: string;
  readonly timestamp: number;
  readonly action_type: string;
  readonly pricing: Readonly<Record<string, unknown>>;
}

/** A PE sealed to a recipient (the linked human, or the owner for relay-authored acts). */
export interface SealedCopy {
  /** Recipient role, resolved by the relay: `linked_human` (an agent's linked human) or `owner` (a human device's own owner). */
  readonly to: string;
  readonly pe_id: string;
  /** base64url sealed box (x25519, see the agent-key-recovery sealed-box format). */
  readonly box: string;
}

export interface PeBatch {
  readonly schema: string;
  readonly device_id: string;
  readonly seq: number;
  readonly prev_batch_hash: string;
  readonly created_at_ms: number;
  readonly acts: readonly ActRecord[];
  readonly acts_root: string;
  readonly sealed?: readonly SealedCopy[];
}

// ─── canonical JSON ─────────────────────────────────────────────────────────────

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, `undefined` object
 * members dropped, `undefined` array members written as null, non-finite numbers refused.
 * Identical to the hardware-witness canonicalizer and to json-stable-stringify on plain JSON.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical_json_non_finite_number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  throw new Error(`canonical_json_unsupported_type:${typeof value}`);
}

// ─── bytes ──────────────────────────────────────────────────────────────────────

const HEX = '0123456789abcdef';

export function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  }
  return out;
}

export function hexToBytesStrict(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error('invalid_hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function sha256HexOfText(text: string): string {
  return bytesToHexLower(sha256Bytes(utf8Bytes(text)));
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function omit(source: Readonly<Record<string, unknown>>, drop: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!drop.includes(key) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

// ─── the PE and its act record ──────────────────────────────────────────────────

/** sha256 hex over the complete PE minus its own hash and signature. */
export function peHashOf(pe: PeV2): string {
  return sha256HexOfText(canonicalJson(omit(pe, PE_HASH_EXCLUDED)));
}

/** The pricing projection: everything in the PE except identity fields and free text. */
export function pricingOf(pe: PeV2): Record<string, unknown> {
  if(pe.private_pricing!==undefined) return {
    private_pricing:pe.private_pricing,
    ...(pe.hardware_witness!==undefined?{hardware_witness:pe.hardware_witness}:{}),
    ...(pe.detail_hash!==undefined?{detail_hash:pe.detail_hash}:{}),
  };
  return omit(pe, NON_PRICING_PE_FIELDS);
}

/** The act record the relay prices. `pe_hash` covers the complete PE, free text included. */
export function actRecordOf(pe: PeV2): ActRecord {
  return {
    pe_id: pe.pe_id,
    pe_hash: peHashOf(pe),
    prev_hash: pe.prev_hash,
    timestamp: pe.timestamp,
    action_type: pe.action_type,
    pricing: pricingOf(pe),
  };
}

/**
 * True when `act` is exactly the act record of `pe` (same hash AND same pricing inputs).
 * This is the byte-for-byte check a verifier runs on a presented PE.
 */
export function actMatchesPe(act: ActRecord, pe: PeV2): boolean {
  return canonicalJson(act) === canonicalJson(actRecordOf(pe));
}

/** The act's leaf in its batch's `acts_root`. */
export function actLeafOf(act: ActRecord): string {
  return sha256HexOfText(ACT_LEAF_DOMAIN + canonicalJson(act));
}

/**
 * The hardware-witness binding nonce for a v2 act: sha256 over the act's identity (`pe_id`,
 * `prev_hash`, `timestamp`, `action_type`) and every pricing input except the witness slot itself.
 * `pe_hash` is left out because it covers the whole PE, witness included — a nonce over it would
 * ask the witness to sign its own signature. The witness therefore attests exactly what the relay
 * prices, bound to one position in one device's chain.
 */
export function hardwareNonceOfAct(act: ActRecord): string {
  return sha256HexOfText(canonicalJson({
    pe_id: act.pe_id,
    prev_hash: act.prev_hash,
    timestamp: act.timestamp,
    action_type: act.action_type,
    pricing: omit(act.pricing, ['hardware_witness']),
  }));
}

// ─── Merkle (sha256; the same tagged, sorted-pair, power-of-two shape as PEAnchor) ──

const EMPTY_NODE = (): Uint8Array => sha256Bytes(new Uint8Array(0));

function tagged(tag: number, ...parts: Uint8Array[]): Uint8Array {
  let length = 1;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  out[0] = tag;
  let offset = 1;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function nodeOf(a: Uint8Array, b: Uint8Array): Uint8Array {
  return compareBytes(a, b) <= 0 ? sha256Bytes(tagged(0x01, a, b)) : sha256Bytes(tagged(0x01, b, a));
}

function leafNodeOf(leafHex: string): Uint8Array {
  if (!isHex64(leafHex)) throw new Error('invalid_leaf');
  return sha256Bytes(tagged(0x00, hexToBytesStrict(leafHex)));
}

function layersOf(leafHexes: readonly string[]): Uint8Array[][] {
  if (leafHexes.length === 0) throw new Error('empty_tree');
  const base = leafHexes.map(leafNodeOf);
  let size = 1;
  while (size < base.length) size *= 2;
  while (base.length < size) base.push(EMPTY_NODE());
  const layers: Uint8Array[][] = [base];
  let current = base;
  while (current.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) next.push(nodeOf(current[i], current[i + 1]));
    layers.push(next);
    current = next;
  }
  return layers;
}

export function merkleRootOf(leafHexes: readonly string[]): string {
  const layers = layersOf(leafHexes);
  return bytesToHexLower(layers[layers.length - 1][0]);
}

function proofFromLayers(layers: readonly Uint8Array[][], leafCount: number, index: number): string[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= leafCount) {
    throw new Error('leaf_index_out_of_range');
  }
  const proof: string[] = [];
  let i = index;
  for (let level = 0; level < layers.length - 1; level++) {
    proof.push(bytesToHexLower(layers[level][i % 2 === 0 ? i + 1 : i - 1]));
    i = Math.floor(i / 2);
  }
  return proof;
}

export function merkleProofOf(leafHexes: readonly string[], index: number): string[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= leafHexes.length) {
    throw new Error('leaf_index_out_of_range');
  }
  return proofFromLayers(layersOf(leafHexes), leafHexes.length, index);
}

/**
 * One build of the tree, then its root and any leaf's proof — byte-identical to merkleRootOf /
 * merkleProofOf. Proving many leaves of one tree with merkleProofOf rebuilds it per leaf, which on
 * a phone (interpreted SHA-256) made proving a few thousand acts take minutes.
 */
export function merkleTreeOf(leafHexes: readonly string[]): { readonly root: string; proofOf(index: number): string[] } {
  const layers = layersOf(leafHexes);
  return {
    root: bytesToHexLower(layers[layers.length - 1][0]),
    proofOf: (index: number) => proofFromLayers(layers, leafHexes.length, index),
  };
}

export function verifyMerkleProofOf(leafHex: string, proof: readonly string[], rootHex: string): boolean {
  try {
    let node = leafNodeOf(leafHex);
    for (const sibling of proof) {
      if (!isHex64(sibling)) return false;
      node = nodeOf(node, hexToBytesStrict(sibling));
    }
    return bytesToHexLower(node) === rootHex;
  } catch {
    return false;
  }
}

/** The fingerprint over a batch's acts, in order. */
export function actsRootOf(acts: readonly ActRecord[]): string {
  return merkleRootOf(acts.map(actLeafOf));
}

// ─── the batch ──────────────────────────────────────────────────────────────────

/** sha256 over the batch minus its sealed copies (delivery payload, not part of the record). */
export function batchHashOf(batch: PeBatch): string {
  return sha256HexOfText(canonicalJson(omit(batch as unknown as Record<string, unknown>, ['sealed'])));
}

/** The 32-byte leaf the daily on-chain anchor commits to for one accepted batch. */
export function batchLeafOf(input: {
  readonly device_id: string;
  readonly actor_id: string;
  readonly seq: number;
  readonly batch_hash: string;
  readonly acts_root: string;
}): string {
  return sha256HexOfText(BATCH_LEAF_DOMAIN + canonicalJson({
    actor_id: input.actor_id,
    acts_root: input.acts_root,
    batch_hash: input.batch_hash,
    device_id: input.device_id,
    seq: input.seq,
  }));
}

/** Build a batch from complete PEs (client side). */
export function buildBatch(input: {
  readonly device_id: string;
  readonly seq: number;
  readonly prev_batch_hash: string;
  readonly created_at_ms: number;
  readonly pes: readonly PeV2[];
  readonly sealed?: readonly SealedCopy[];
}): PeBatch {
  const acts = input.pes.map(actRecordOf);
  const batch: PeBatch = {
    schema: PE_BATCH_SCHEMA,
    device_id: input.device_id,
    seq: input.seq,
    prev_batch_hash: input.prev_batch_hash,
    created_at_ms: input.created_at_ms,
    acts,
    acts_root: actsRootOf(acts),
    ...(input.sealed && input.sealed.length > 0 ? { sealed: input.sealed } : {}),
  };
  return batch;
}

export type BatchShapeError =
  | 'bad_schema'
  | 'bad_device_id'
  | 'bad_seq'
  | 'bad_prev_batch_hash'
  | 'bad_created_at'
  | 'no_acts'
  | 'too_many_acts'
  | 'bad_act'
  | 'duplicate_pe_id'
  | 'acts_root_mismatch'
  | 'bad_sealed';

/** Structural validation (relay side). Never trusts `acts_root`: recomputes it. */
export function validateBatchShape(batch: unknown): { ok: true; batch: PeBatch } | { ok: false; error: BatchShapeError; index?: number } {
  if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) return { ok: false, error: 'bad_schema' };
  const b = batch as Record<string, unknown>;
  if (b.schema !== PE_BATCH_SCHEMA) return { ok: false, error: 'bad_schema' };
  if (typeof b.device_id !== 'string' || b.device_id.length === 0 || b.device_id.length > 200) return { ok: false, error: 'bad_device_id' };
  if (typeof b.seq !== 'number' || !Number.isSafeInteger(b.seq) || b.seq < 1) return { ok: false, error: 'bad_seq' };
  if (typeof b.prev_batch_hash !== 'string' || (b.prev_batch_hash !== METER_GENESIS_PREV_HASH && !isHex64(b.prev_batch_hash))) {
    return { ok: false, error: 'bad_prev_batch_hash' };
  }
  if (typeof b.created_at_ms !== 'number' || !Number.isSafeInteger(b.created_at_ms) || b.created_at_ms <= 0) return { ok: false, error: 'bad_created_at' };
  if (!Array.isArray(b.acts) || b.acts.length === 0) return { ok: false, error: 'no_acts' };
  if (b.acts.length > MAX_ACTS_PER_BATCH) return { ok: false, error: 'too_many_acts' };
  const seen = new Set<string>();
  for (let i = 0; i < b.acts.length; i++) {
    const a = b.acts[i] as Record<string, unknown> | null;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return { ok: false, error: 'bad_act', index: i };
    const keys = Object.keys(a).sort().join(',');
    if (keys !== 'action_type,pe_hash,pe_id,prev_hash,pricing,timestamp') return { ok: false, error: 'bad_act', index: i };
    if (typeof a.pe_id !== 'string' || a.pe_id.length === 0 || a.pe_id.length > 200) return { ok: false, error: 'bad_act', index: i };
    if (!isHex64(a.pe_hash)) return { ok: false, error: 'bad_act', index: i };
    if (typeof a.prev_hash !== 'string' || (a.prev_hash !== METER_GENESIS_PREV_HASH && !isHex64(a.prev_hash))) return { ok: false, error: 'bad_act', index: i };
    if (typeof a.timestamp !== 'number' || !Number.isSafeInteger(a.timestamp) || a.timestamp <= 0) return { ok: false, error: 'bad_act', index: i };
    if (typeof a.action_type !== 'string' || a.action_type.length === 0 || a.action_type.length > 128) return { ok: false, error: 'bad_act', index: i };
    if (a.pricing === null || typeof a.pricing !== 'object' || Array.isArray(a.pricing)) return { ok: false, error: 'bad_act', index: i };
    for (const k of Object.keys(a.pricing as object)) {
      if (NON_PRICING_PE_FIELDS.includes(k)) return { ok: false, error: 'bad_act', index: i };
    }
    if (seen.has(a.pe_id)) return { ok: false, error: 'duplicate_pe_id', index: i };
    seen.add(a.pe_id);
  }
  const acts = b.acts as unknown as ActRecord[];
  if (b.acts_root !== actsRootOf(acts)) return { ok: false, error: 'acts_root_mismatch' };
  if (b.sealed !== undefined) {
    if (!Array.isArray(b.sealed) || b.sealed.length > MAX_ACTS_PER_BATCH * 2) return { ok: false, error: 'bad_sealed' };
    for (const s of b.sealed as unknown[]) {
      const c = s as Record<string, unknown> | null;
      if (c === null || typeof c !== 'object' || typeof c.to !== 'string' || typeof c.pe_id !== 'string'
        || typeof c.box !== 'string' || c.box.length === 0 || c.box.length > 262_144 || !seen.has(c.pe_id)) {
        return { ok: false, error: 'bad_sealed' };
      }
    }
  }
  return { ok: true, batch: batch as PeBatch };
}

/**
 * The device's PE chain must continue across batches: the first act links to the last act the
 * relay accepted from this device, and every later act links to its predecessor. A PE can
 * therefore appear in exactly one accepted batch.
 */
export function verifyActChain(lastAcceptedPeHash: string, acts: readonly ActRecord[]): { ok: true } | { ok: false; index: number } {
  let prev = lastAcceptedPeHash;
  for (let i = 0; i < acts.length; i++) {
    if (acts[i].prev_hash !== prev) return { ok: false, index: i };
    prev = acts[i].pe_hash;
  }
  return { ok: true };
}

/** Everything a holder needs to prove one act against the chain, without the relay. */
export interface ActInclusionProof {
  readonly act_index: number;
  readonly act_proof: readonly string[];
  readonly acts_root: string;
  readonly batch: {
    readonly device_id: string;
    readonly actor_id: string;
    readonly seq: number;
    readonly batch_hash: string;
  };
  /** Filled once the day is anchored. */
  readonly anchor?: {
    readonly chain_id: number;
    readonly contract: string;
    readonly anchor_batch_id: string;
    readonly day: string;
    /** 2026-10-10: the intra-day anchor segment (`<day>:<n>`) the batch was anchored in; absent for the day's close anchor. */
    readonly segment?: number;
    readonly leaf_index: number;
    /** keccak sibling path of the batch leaf to the anchored root. */
    readonly proof: readonly string[];
    readonly merkle_root: string;
    readonly tx_hash: string | null;
  };
}

/** Check an act (from a presented PE) against its inclusion proof, up to the batch leaf. */
export function verifyActInclusion(pe: PeV2, proof: ActInclusionProof): { ok: true; batch_leaf: string } | { ok: false; reason: string } {
  const act = actRecordOf(pe);
  if (!verifyMerkleProofOf(actLeafOf(act), proof.act_proof, proof.acts_root)) return { ok: false, reason: 'act_not_in_batch' };
  const leaf = batchLeafOf({
    device_id: proof.batch.device_id,
    actor_id: proof.batch.actor_id,
    seq: proof.batch.seq,
    batch_hash: proof.batch.batch_hash,
    acts_root: proof.acts_root,
  });
  return { ok: true, batch_leaf: leaf };
}
