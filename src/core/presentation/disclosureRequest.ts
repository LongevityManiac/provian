/**
 * REQUESTER-NAMED DISCLOSURE — the second part of a signed challenge.
 *
 * Beyond predicates, a signed challenge may NAME what it wants to see from the presenter's own
 * record: a specific PE by one of its output digests (`kind: 'pe'`), or PEs witnessed by a named
 * issuer or signer (`kind: 'witness'`); each request may name specific FIELDS of the record (dotted
 * paths into the act's pricing projection) and elect CONTENT (`description`, `intent`,
 * `artifacts`, `fact_tier`). The predicate grammar is frozen; disclosure requests are a distinct
 * part of the challenge, committed by their own `disclosures=` line in the signing string ONLY
 * when present, so every pre-existing challenge signs byte-identical bytes.
 *
 * The presenter ELECTS per request: `disclosed` (with the matching records it holds, proven to the
 * anchored root) or `declined` (signed as declined). Nothing is disclosed without an election; the
 * floor of every disclosed record is METADATA (pe id, hash, action type, time, the witness facts
 * the relay verified at issuance); fields and content appear only when requested AND elected.
 * Standing is always present (disclosures ride the reputation tier). Disclosures travel only inside
 * the requester-bound presentation; the relay retains nothing; nothing surfaces in the Commons.
 *
 * This module is the single source of the shapes, the canonical forms and the digests. Mirrored
 * byte-for-byte (modulo the hash primitive import) from the relay's
 * `provian-backend/src/core/presentation/disclosure-request.ts` (the SDK and MCP core carry it too); the fixed vectors in
 * `disclosure-request.test.ts` are pinned identically in each package.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const DISCLOSURE_REQUESTS_MAX = 16;
export const DISCLOSURE_FIELDS_MAX = 32;
export const DISCLOSURE_FIELD_PATH_MAX_DEPTH = 6;
export const DISCLOSURE_RECORDS_DEFAULT_LIMIT = 10;
export const DISCLOSURE_RECORDS_MAX_LIMIT = 50;
/** Every disclosed record of one presentation, across requests. */
export const DISCLOSURE_RECORDS_MAX_TOTAL = 50;
/** Canonical bytes of one disclosed record (fields + content), a hard cap against a data channel. */
export const DISCLOSURE_RECORD_MAX_BYTES = 64 * 1024;

export const DISCLOSURE_CONTENT_ELECTIONS = ['description', 'intent', 'artifacts', 'fact_tier'] as const;
export type DisclosureContent = (typeof DISCLOSURE_CONTENT_ELECTIONS)[number];

export const DISCLOSURE_ELECTIONS = ['disclosed', 'declined'] as const;
export type DisclosureElection = (typeof DISCLOSURE_ELECTIONS)[number];

const HEX64_RE = /^[0-9a-f]{64}$/;
const FIELD_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** An issuer or signer name: a root fingerprint (64 hex), `chain:<name>`, a hostname, a device id. */
const WITNESS_NAME_RE = /^[A-Za-z0-9:._-]{1,128}$/;

/** A specific PE named by one of its output digests (or its own pe_hash). */
export interface PeDisclosureRequest {
  readonly kind: 'pe';
  readonly output_digest: string;
  /** Optional: the witness issuer the record must carry (a credential by digest AND issuer). */
  readonly issuer?: string;
  readonly fields?: readonly string[];
  readonly content?: readonly DisclosureContent[];
}

/** PEs witnessed by a named issuer (a pinned root fingerprint, `chain:base`, a forge host) or signer. */
export interface WitnessDisclosureRequest {
  readonly kind: 'witness';
  readonly issuer?: string;
  readonly signer?: string;
  /** The most records the presenter may disclose for this request (1..50, default 10). */
  readonly limit?: number;
  readonly fields?: readonly string[];
  readonly content?: readonly DisclosureContent[];
}

export type DisclosureRequest = PeDisclosureRequest | WitnessDisclosureRequest;

/** Canonical (sorted, de-duplicated, lowercased) request — the form the signing string commits to. */
export type CanonicalDisclosureRequest =
  | { kind: 'pe'; output_digest: string; issuer?: string; fields?: string[]; content?: DisclosureContent[] }
  | { kind: 'witness'; issuer?: string; signer?: string; limit: number; fields?: string[]; content?: DisclosureContent[] };

/** The witness facts the relay verified at issuance for a disclosed record. */
export interface DisclosedWitness {
  /** `hardware` (an admitted non-actor attestation), `chain` (a chain-verified transfer), `device` (the recording device's key). */
  readonly kind: 'hardware' | 'chain' | 'device';
  readonly scheme?: string;
  /** hardware: the pinned root fingerprint reached. chain: `chain:<name>`. */
  readonly issuer?: string;
  /** hardware: sha256(SPKI) of the report signer. device: the device id of the anchored batch. */
  readonly signer?: string;
  /** hardware: the launch measurement / PCR digest. */
  readonly measurement?: string;
  readonly region?: string;
  /** chain: the transaction hash. */
  readonly ref?: string;
}

/** One disclosed record: the metadata floor, plus requested fields and elected content. */
export interface DisclosedRecord {
  readonly pe_id: string;
  readonly pe_hash: string;
  readonly action_type: string;
  readonly timestamp: number;
  readonly witness: DisclosedWitness;
  /** `kind: 'pe'` only: the output digest the request named, as carried by this record. */
  readonly output_digest?: string;
  /** The requested fields at their dotted paths (absent paths are reported as null). */
  readonly fields?: Record<string, unknown>;
  readonly content?: {
    readonly description?: string | null;
    readonly intent?: string | null;
    readonly artifacts?: unknown[];
    readonly fact_tier?: Record<string, unknown>;
  };
}

export interface DisclosureAnswer {
  readonly request: CanonicalDisclosureRequest;
  readonly election: DisclosureElection;
  /** Present only on `disclosed`. May be empty: the presenter elected but holds no matching record. */
  readonly records?: readonly DisclosedRecord[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sha256hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

/**
 * Canonical JSON (sorted keys, no whitespace, undefined members dropped) — the same rule the meter
 * wire uses, carried here so this module stays dependency-free in every package.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical_json_non_finite_number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  throw new Error(`canonical_json_unsupported_type:${typeof value}`);
}

const FORBIDDEN_FIELD_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A dotted field path into the pricing projection: 1..6 segments of `[A-Za-z0-9_-]{1,64}`. */
export function isDisclosureFieldPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 256) return false;
  const segments = path.split('.');
  // Prototype-chain names are refused in every path (Security Invariant #6), never read around.
  return segments.length <= DISCLOSURE_FIELD_PATH_MAX_DEPTH
    && segments.every((s) => FIELD_SEGMENT_RE.test(s) && !FORBIDDEN_FIELD_SEGMENTS.has(s));
}

function normalizeFields(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > DISCLOSURE_FIELDS_MAX) return null;
  const out = new Set<string>();
  for (const f of raw) {
    if (!isDisclosureFieldPath(f)) return null;
    out.add(f);
  }
  return [...out].sort();
}

function normalizeContent(raw: unknown): DisclosureContent[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > DISCLOSURE_CONTENT_ELECTIONS.length) return null;
  const out = new Set<DisclosureContent>();
  for (const c of raw) {
    if (typeof c !== 'string' || !(DISCLOSURE_CONTENT_ELECTIONS as readonly string[]).includes(c)) return null;
    out.add(c as DisclosureContent);
  }
  return [...out].sort();
}

function normalizeDigest(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const d = raw.trim().toLowerCase().replace(/^sha256:/, '').replace(/^0x/, '');
  return HEX64_RE.test(d) ? d : null;
}

function normalizeWitnessName(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  const n = raw.trim().toLowerCase();
  return WITNESS_NAME_RE.test(n) ? n : null;
}

/**
 * Parse ONE untrusted disclosure request into its canonical form, fail-closed (`null` on anything
 * malformed: an unknown kind, a digest that is not 64 hex, a witness request naming neither issuer
 * nor signer, a bad field path, an unknown content election, a limit outside 1..50).
 */
export function canonicalDisclosureRequest(raw: unknown): CanonicalDisclosureRequest | null {
  if (!isRecord(raw)) return null;
  const fields = normalizeFields(raw.fields);
  if (fields === null) return null;
  const content = normalizeContent(raw.content);
  if (content === null) return null;
  const tail = {
    ...(fields !== undefined && fields.length > 0 ? { fields } : {}),
    ...(content !== undefined && content.length > 0 ? { content } : {}),
  };
  if (raw.kind === 'pe') {
    const digest = normalizeDigest(raw.output_digest);
    if (digest === null) return null;
    const issuer = normalizeWitnessName(raw.issuer);
    if (issuer === null) return null;
    for (const k of Object.keys(raw)) if (!['kind', 'output_digest', 'issuer', 'fields', 'content'].includes(k)) return null;
    return { kind: 'pe', output_digest: digest, ...(issuer !== undefined ? { issuer } : {}), ...tail };
  }
  if (raw.kind === 'witness') {
    const issuer = normalizeWitnessName(raw.issuer);
    const signer = normalizeWitnessName(raw.signer);
    if (issuer === null || signer === null) return null;
    if (issuer === undefined && signer === undefined) return null;
    let limit = DISCLOSURE_RECORDS_DEFAULT_LIMIT;
    if (raw.limit !== undefined) {
      if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > DISCLOSURE_RECORDS_MAX_LIMIT) return null;
      limit = raw.limit;
    }
    for (const k of Object.keys(raw)) if (!['kind', 'issuer', 'signer', 'limit', 'fields', 'content'].includes(k)) return null;
    return { kind: 'witness', ...(issuer !== undefined ? { issuer } : {}), ...(signer !== undefined ? { signer } : {}), limit, ...tail };
  }
  return null;
}

/** The order-independent identity of a request (its canonical JSON). */
export function disclosureRequestKey(req: CanonicalDisclosureRequest): string {
  return canonicalJson(req);
}

/**
 * Parse an untrusted request list, fail-closed: `[]` for absent, `null` when it is not a list, is
 * over the cap, carries a malformed entry, or names the same request twice.
 */
export function normalizeDisclosureRequests(raw: unknown): CanonicalDisclosureRequest[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > DISCLOSURE_REQUESTS_MAX) return null;
  const out: CanonicalDisclosureRequest[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const c = canonicalDisclosureRequest(entry);
    if (c === null) return null;
    const key = disclosureRequestKey(c);
    if (seen.has(key)) return null;
    seen.add(key);
    out.push(c);
  }
  return out.sort((a, b) => disclosureRequestKey(a).localeCompare(disclosureRequestKey(b)));
}

/** Two requests are the same when their canonical forms are byte-identical. */
export function disclosureRequestMatches(a: CanonicalDisclosureRequest, b: CanonicalDisclosureRequest): boolean {
  return disclosureRequestKey(a) === disclosureRequestKey(b);
}

/** sha256 hex of the canonical, sorted request list — the `disclosures=` signing-string commitment. */
export function challengeDisclosuresDigest(requests: readonly CanonicalDisclosureRequest[] | undefined): string {
  const sorted = [...(requests ?? [])].sort((a, b) => disclosureRequestKey(a).localeCompare(disclosureRequestKey(b)));
  return sha256hex(canonicalJson(sorted));
}

/** The canonical, order-independent form of the answers — what the presenter's proof of possession
 *  and the Provian signature commit to (elections AND records). */
export function canonicalDisclosureAnswers(answers: readonly DisclosureAnswer[]): DisclosureAnswer[] {
  return [...answers]
    .map((a) => ({
      request: a.request,
      election: a.election,
      ...(a.election === 'disclosed' ? { records: [...(a.records ?? [])].sort((x, y) => x.pe_id.localeCompare(y.pe_id)) } : {}),
    }))
    .sort((a, b) => disclosureRequestKey(a.request).localeCompare(disclosureRequestKey(b.request)));
}

/** sha256 hex of the canonical answers — the `disclosures=` line of the claims digest. */
export function disclosureAnswersDigest(answers: readonly DisclosureAnswer[]): string {
  return sha256hex(canonicalJson(canonicalDisclosureAnswers(answers)));
}

/** Read a dotted path off a plain object; `null` when any segment is absent. */
export function readFieldPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const seg of path.split('.')) {
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return null;
      cur = cur[i];
    } else if (isRecord(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = cur[seg];
    } else {
      return null;
    }
  }
  return cur === undefined ? null : cur;
}

/** Parse an untrusted answer list structurally (elections and record floors); `null` when malformed. */
export function parseDisclosureAnswers(raw: unknown): DisclosureAnswer[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > DISCLOSURE_REQUESTS_MAX) return null;
  const out: DisclosureAnswer[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const request = canonicalDisclosureRequest(entry.request);
    if (request === null) return null;
    const key = disclosureRequestKey(request);
    if (seen.has(key)) return null;
    seen.add(key);
    if (entry.election !== 'disclosed' && entry.election !== 'declined') return null;
    if (entry.election === 'declined') {
      if (entry.records !== undefined) return null;
      out.push({ request, election: 'declined' });
      continue;
    }
    if (!Array.isArray(entry.records)) return null;
    const limit = request.kind === 'witness' ? request.limit : 1;
    if (entry.records.length > limit) return null;
    const records: DisclosedRecord[] = [];
    const ids = new Set<string>();
    for (const r of entry.records) {
      const rec = parseDisclosedRecord(r);
      if (rec === null || ids.has(rec.pe_id)) return null;
      ids.add(rec.pe_id);
      records.push(rec);
      total += 1;
      if (total > DISCLOSURE_RECORDS_MAX_TOTAL) return null;
    }
    out.push({ request, election: 'disclosed', records });
  }
  return out;
}

function parseDisclosedRecord(raw: unknown): DisclosedRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.pe_id !== 'string' || raw.pe_id.length === 0 || raw.pe_id.length > 256) return null;
  const hash = normalizeDigest(raw.pe_hash);
  if (hash === null) return null;
  if (typeof raw.action_type !== 'string' || raw.action_type.length === 0 || raw.action_type.length > 128) return null;
  if (typeof raw.timestamp !== 'number' || !Number.isSafeInteger(raw.timestamp) || raw.timestamp < 0) return null;
  const w = raw.witness;
  if (!isRecord(w) || (w.kind !== 'hardware' && w.kind !== 'chain' && w.kind !== 'device')) return null;
  const witness: Record<string, unknown> = { kind: w.kind };
  for (const k of ['scheme', 'issuer', 'signer', 'measurement', 'region', 'ref']) {
    if (w[k] === undefined) continue;
    if (typeof w[k] !== 'string' || (w[k] as string).length > 256) return null;
    witness[k] = w[k];
  }
  const rec: Record<string, unknown> = { pe_id: raw.pe_id, pe_hash: hash, action_type: raw.action_type, timestamp: raw.timestamp, witness };
  if (raw.output_digest !== undefined) {
    const d = normalizeDigest(raw.output_digest);
    if (d === null) return null;
    rec.output_digest = d;
  }
  if (raw.fields !== undefined) {
    if (!isRecord(raw.fields)) return null;
    for (const k of Object.keys(raw.fields)) if (!isDisclosureFieldPath(k)) return null;
    rec.fields = raw.fields;
  }
  if (raw.content !== undefined) {
    if (!isRecord(raw.content)) return null;
    for (const k of Object.keys(raw.content)) if (!(DISCLOSURE_CONTENT_ELECTIONS as readonly string[]).includes(k)) return null;
    rec.content = raw.content;
  }
  try {
    if (canonicalJson(rec).length > DISCLOSURE_RECORD_MAX_BYTES) return null;
  } catch {
    return null;
  }
  return rec as unknown as DisclosedRecord;
}

/**
 * Does a record satisfy the request it answers? `pe`: the record carries the named digest (and the
 * issuer when named). `witness`: the record's witness carries the named issuer / signer.
 */
export function recordMatchesRequest(record: DisclosedRecord, request: CanonicalDisclosureRequest): boolean {
  if (request.kind === 'pe') {
    if (record.output_digest !== request.output_digest) return false;
    if (request.issuer !== undefined && record.witness.issuer !== request.issuer) return false;
    return true;
  }
  if (request.issuer !== undefined && record.witness.issuer !== request.issuer) return false;
  if (request.signer !== undefined && record.witness.signer !== request.signer) return false;
  return true;
}

/** The floor-only view of a record: no fields, no content — what a declined-content request yields. */
export function recordFloor(record: DisclosedRecord): DisclosedRecord {
  const { fields: _f, content: _c, ...floor } = record;
  return floor;
}

/** The identity-only view of the answers: elections plus `{pe_id, pe_hash}` per disclosed record. */
export type DisclosureCommitment = {
  request: CanonicalDisclosureRequest;
  election: DisclosureElection;
  records?: { pe_id: string; pe_hash: string }[];
};

/**
 * The PRESENTER'S commitment: what it elected and WHICH records (by id + hash) it put forward —
 * everything the presenter can know before the relay derives the witness facts. Its sha256 is the
 * `disclosures=` line of the claims digest the proof of possession signs; the relay-derived facts,
 * fields and content are covered by the Provian signature over the payload, and a verifier checks
 * every field against the anchored act record itself.
 */
export function disclosureCommitment(answers: readonly DisclosureAnswer[]): DisclosureCommitment[] {
  return canonicalDisclosureAnswers(answers).map((a) => ({
    request: a.request,
    election: a.election,
    ...(a.election === 'disclosed' ? { records: (a.records ?? []).map((r) => ({ pe_id: r.pe_id, pe_hash: r.pe_hash })) } : {}),
  }));
}

export function disclosureCommitmentDigest(answers: readonly DisclosureAnswer[]): string {
  return sha256hex(canonicalJson(disclosureCommitment(answers)));
}
