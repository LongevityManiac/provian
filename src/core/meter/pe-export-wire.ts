/**
 * PE EXPORT FORMAT — the ONE definition of a complete PE export (`provian.pe-export.v1`) and of
 * how anyone verifies it without a Provian server (BUILD 2026-10-06: complete PE export).
 *
 * THIS FILE IS BYTE-IDENTICAL IN TWO PACKAGES and a parity check refuses any drift
 * (`scripts/check-pe-export-wire-parity.sh`):
 *   provian-agent-sdk/src/pe-export-wire.ts   (daemon, SDK, CLI: builds and verifies)
 *   src/core/meter/pe-export-wire.ts          (the app: builds)
 * The per-package files are `./meter-hash` (sha256) and `./export-hash` (keccak-256).
 * The human-readable specification is docs/PE_PROTOCOL_SPEC.md Section 14; this file is its executable form.
 *
 * THE FILE: newline-delimited JSON, UTF-8. Every line is `canonicalJson(record)`. Line 1 is the
 * header; the last line is the end record; between them, in this order: `pe` lines (every device
 * chain the owner holds, each in chain order), `batch` lines, `received` lines, `legacy` lines.
 * Each line before the end line is folded into a running hash (`chain`), so a truncated or edited
 * file is detected.
 *
 * VERIFYING ONE PE (two hops, both recomputable by anyone holding the line):
 *   1. pe_hash   = sha256(canonicalJson(pe minus pe_hash, signature))
 *   2. act leaf  = sha256("provian.meter.act.v1\n" ‖ canonicalJson(actRecordOf(pe)))
 *      → `acts_root` by `act_proof` (sha256, tagged sorted pairs)
 *      → batch leaf = sha256("provian.meter.batch-leaf.v1\n" ‖ canonicalJson(batch identity + acts_root))
 *   3. on-chain leaf = keccak256(0x00 ‖ batch_leaf) → `merkle_root` by `anchor.proof`
 *      (keccak256(0x01 ‖ min ‖ max) per level), and
 *      anchor_batch_id = keccak256(0xff ‖ utf8("provian:daily-pe-anchor:v1:meter:" + day))
 *   4. on Base (chain 8453), PEAnchor `0x889A59A8…a9fD`.getBatch(anchor_batch_id) returns
 *      exists = true and merkleRoot = merkle_root. Any Base RPC serves this read.
 *
 * Pure: no I/O, no clock. The one chain read is an injected `eth_call`.
 */

import { keccak256Bytes } from './export-hash';
import type { ArchivePayload, ArchiveBatchRef } from './pe-archive-wire';
import {
  actLeafOf,
  actRecordOf,
  batchLeafOf,
  bytesToHexLower,
  canonicalJson,
  hexToBytesStrict,
  merkleProofOf,
  merkleRootOf,
  METER_GENESIS_PREV_HASH,
  peHashOf,
  sha256HexOfText,
  utf8Bytes,
  verifyActInclusion,
  type ActInclusionProof,
  type PeV2,
} from './meter-wire';

export const PE_EXPORT_SCHEMA = 'provian.pe-export.v1';
/** Where the specification is published: the PE Protocol Specification, Section 14. */
export const PE_EXPORT_SPEC_URL = 'https://provian.ai/docs-md/pe-protocol-spec.md';
export const PE_EXPORT_BASE_CHAIN_ID = 8453;
/** The deployed PEAnchor on Base every meter day root is written to. A verifier reads only this contract. */
export const PE_EXPORT_PE_ANCHOR = '0x889A59A847e490c5Cc91f281468AbAacc100a9fD';
export const METER_ANCHOR_BATCH_ID_PREFIX = 'provian:daily-pe-anchor:v1:meter:';
const CHAIN_START = 'provian.pe-export.v1';

export const PE_EXPORT_ANCHOR_RULES = {
  chain_id: PE_EXPORT_BASE_CHAIN_ID,
  contract: PE_EXPORT_PE_ANCHOR,
  read: 'getBatch(bytes32 anchor_batch_id) returns (bytes32 merkleRoot, uint256 peCount, uint256 timestamp, uint256 epochNumber, bool exists)',
  batch_id_rule: 'keccak256(0xff || utf8("provian:daily-pe-anchor:v1:meter:" + day))',
  leaf_rule: 'keccak256(0x00 || bytes32(batch_leaf))',
  node_rule: 'keccak256(0x01 || min(a, b) || max(a, b))',
} as const;

// ─── records ────────────────────────────────────────────────────────────────────

export type PeV2WithHash = PeV2 & { readonly pe_hash: string };

/** Why a PE line carries no complete proof yet (only `anchored` verifies against Base). */
export type ExportPeStatus =
  | 'anchored'
  | 'not_batched_yet'
  | 'not_anchored_yet'
  | 'batch_composition_unknown'
  | 'acts_root_mismatch'
  | 'proof_unavailable';

export interface ExportArchiveDay {
  readonly wallet: string;
  readonly day: string;
  readonly pulled: boolean;
  /** null when pulled. */
  readonly reason: string | null;
}

export interface ExportHeader {
  readonly type: 'header';
  readonly schema: string;
  readonly spec: string;
  readonly exported_at_ms: number;
  readonly producer: { readonly kind: 'app' | 'sdk'; readonly version: string };
  readonly owner: { readonly kind: 'human' | 'agent'; readonly wallet_id: string | null; readonly address: string | null };
  readonly anchor: typeof PE_EXPORT_ANCHOR_RULES;
  /** Every device chain held where the export was made (this device first). */
  readonly devices: readonly string[];
  /** The PE Archive: `on`/`off`, or `unknown` when its state could not be read. Every day listed. */
  readonly archive: { readonly state: 'on' | 'off' | 'unknown'; readonly days: readonly ExportArchiveDay[] };
}

/** A PE of the owner's own device chains (held on the device, or pulled back from the Archive). */
export interface ExportPeLine {
  readonly type: 'pe';
  readonly source: 'device' | 'archive';
  readonly device_id: string;
  readonly index: number;
  readonly pe: PeV2WithHash;
  /** The phone's full on-phone record of the act, committed by `pe.detail_hash` (app exports). */
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly status: ExportPeStatus;
  readonly inclusion: ActInclusionProof | null;
}

/** The relay's anchor proof for one batch leaf, as kept by the device. */
export interface ExportBatchAnchor {
  readonly day: string;
  readonly anchor_batch_id: string;
  /** 2026-10-10: the intra-day anchor segment (`<day>:<n>`) the batch was anchored in; absent for the day's close anchor. */
  readonly segment?: number;
  readonly leaf_index: number;
  readonly leaf_count: number;
  readonly leaf_hash: string;
  readonly proof: readonly string[];
  readonly merkle_root: string;
  readonly tx_hash: string | null;
}

/** One batch the relay accepted from one of the owner's devices, with its receipt and anchor proof. */
export interface ExportBatchLine {
  readonly type: 'batch';
  readonly device_id: string;
  readonly seq: number;
  readonly batch_hash: string;
  readonly prev_batch_hash: string;
  readonly acts_root: string | null;
  readonly actor_id: string | null;
  readonly first_index: number;
  readonly count: number;
  readonly last_pe_hash: string;
  readonly created_at_ms: number | null;
  readonly accepted_at_ms: number | null;
  readonly adopted: boolean;
  readonly batch_leaf: string | null;
  /** The relay's receipt for this batch, verbatim (null for an adopted range). */
  readonly receipt: Readonly<Record<string, unknown>> | null;
  readonly anchor: ExportBatchAnchor | null;
}

/** A PE another party sealed to the owner (a linked agent, another of the owner's devices, the relay). */
export interface ExportReceivedLine {
  readonly type: 'received';
  readonly source: 'device' | 'archive';
  readonly mailbox_id: string | null;
  readonly from_actor: string;
  readonly from_device: string;
  readonly batch_hash: string;
  readonly received_at_ms: number | null;
  readonly pe: PeV2WithHash;
  readonly status: ExportPeStatus;
  readonly inclusion: ActInclusionProof | null;
}

/** A pre-meter record (a v1 envelope), verbatim. Pre-meter records carry no meter anchor. */
export interface ExportLegacyLine {
  readonly type: 'legacy';
  /** `device_history`: the app's own activity record; `handed_back`: the relay's copy handed back to its owner at the meter cutover. */
  readonly source: 'device_history' | 'handed_back';
  readonly id: string;
  /**
   * The record's own chain hash: sha256 of its canonical JSON minus `signature` (device history), or
   * its `hash` field (handed back), which its writer's recipe recomputes (`PRE_METER_HASH_RECIPES`).
   */
  readonly hash: string | null;
  readonly record: Readonly<Record<string, unknown>>;
  readonly status: 'pre_meter' | 'not_yet_metered';
}

export interface ExportEndLine {
  readonly type: 'end';
  /** Lines before this one, header included. */
  readonly lines: number;
  /** The running hash over those lines. */
  readonly chain: string;
  readonly counts: { readonly pe: number; readonly batch: number; readonly received: number; readonly legacy: number };
  /** What the producer could not include in full, and why. Empty for a complete export. */
  readonly incomplete: readonly { readonly what: string; readonly reason: string }[];
}

export type ExportBodyLine = ExportPeLine | ExportBatchLine | ExportReceivedLine | ExportLegacyLine;
export type ExportLine = ExportHeader | ExportBodyLine | ExportEndLine;

// ─── hashing helpers ────────────────────────────────────────────────────────────

function keccakHex(bytes: Uint8Array): string {
  return '0x' + bytesToHexLower(keccak256Bytes(bytes));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function norm32(hex: string): string {
  const h = hex.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('invalid_bytes32');
  return h;
}

/**
 * The meter anchor's batch id for a UTC day (`YYYY-MM-DD`), or for one of the day's intra-day
 * SEGMENTS (`<day>:<n>`, n ≥ 1 — an operator-run anchor of the open day's batches, 2026-10-10).
 */
export function meterAnchorBatchIdOf(day: string, segment?: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('invalid_day');
  if (segment !== undefined && (!Number.isSafeInteger(segment) || segment < 1)) throw new Error('invalid_anchor_segment');
  return keccakHex(concatBytes(new Uint8Array([0xff]), utf8Bytes(METER_ANCHOR_BATCH_ID_PREFIX + day + (segment !== undefined ? `:${segment}` : ''))));
}

/** Legacy ciphertext remains immutable. Its missing proof metadata is repaired only after opening. */
export function archivePayloadNeedsSegmentRepair(payload: ArchivePayload): boolean {
  return payload.entries.some(e => e.inclusion.anchor !== undefined && e.inclusion.anchor.segment === undefined
    && meterAnchorBatchIdOf(e.inclusion.anchor.day) !== e.inclusion.anchor.anchor_batch_id.toLowerCase());
}

export function repairArchivePayloadSegments(payload: ArchivePayload, repairs: readonly ArchiveBatchRef[]): ArchivePayload {
  const entries = payload.entries.map(e => {
    const a = e.inclusion.anchor;
    if (!a || meterAnchorBatchIdOf(a.day, a.segment) === a.anchor_batch_id.toLowerCase()) return e;
    if (a.segment !== undefined) throw new Error('archive_segment_conflict');
    const norm = (s: string) => s.toLowerCase().replace(/^0x/, '');
    const ref = repairs.find(r => r.device_id === e.inclusion.batch.device_id && r.actor_id === e.inclusion.batch.actor_id
      && r.seq === e.inclusion.batch.seq && r.batch_hash === e.inclusion.batch.batch_hash && r.acts_root === e.inclusion.acts_root
      && r.anchor.day === a.day && norm(r.anchor.anchor_batch_id) === norm(a.anchor_batch_id)
      && norm(r.anchor.merkle_root) === norm(a.merkle_root)
      && r.anchor.proof.length === a.proof.length && r.anchor.proof.every((s, i) => norm(s) === norm(a.proof[i])));
    if (!ref || ref.anchor.segment === undefined || meterAnchorBatchIdOf(a.day, ref.anchor.segment) !== a.anchor_batch_id.toLowerCase()) {
      throw new Error('archive_segment_repair_unavailable');
    }
    const inclusion = { ...e.inclusion, anchor: { ...a, segment: ref.anchor.segment } };
    const check = verifyExportOffline([{ type: 'received', source: 'archive', mailbox_id: null,
      from_actor: ref.actor_id, from_device: ref.device_id, batch_hash: ref.batch_hash, received_at_ms: null,
      pe: e.pe, status: 'anchored', inclusion }]);
    if (check.failures.length > 0 || check.counts.received.proven_to_root !== 1) throw new Error('archive_segment_repair_invalid');
    return { ...e, inclusion };
  });
  return { ...payload, entries };
}

/** The on-chain leaf of a batch leaf: keccak256(0x00 ‖ batch_leaf). */
export function anchoredLeafOf(batchLeafHex: string): string {
  return keccakHex(concatBytes(new Uint8Array([0x00]), hexToBytesStrict(norm32(batchLeafHex))));
}

/** Fold an on-chain leaf up its keccak proof (sorted pairs, 0x01 tag) — PEAnchor.verifyPE's rule. */
export function foldAnchorProof(leaf: string, proof: readonly string[]): string {
  let node = norm32(leaf);
  for (const sibling of proof) {
    const s = norm32(sibling);
    const [a, b] = node <= s ? [node, s] : [s, node];
    node = norm32(keccakHex(concatBytes(new Uint8Array([0x01]), hexToBytesStrict(a), hexToBytesStrict(b))));
  }
  return '0x' + node;
}

/** New commitments have a device-held opening; legacy ones remain byte-identical. */
export function detailMatchesPe(detail:Readonly<Record<string,unknown>>,pe:Readonly<Record<string,unknown>>):boolean {
 const digest=recordHashOf(detail);
 if(pe.detail_commitment==='provian.detail-commitment.v1') {
  if(typeof pe.private_commitment!=='string'||!/^[a-f0-9]{64}$/.test(pe.private_commitment))return false;
  return sha256HexOfText(pe.private_commitment+'\0'+digest)===pe.detail_hash;
 }
 return digest===pe.detail_hash;
}

/** sha256 hex of a record's canonical JSON minus `signature` (the app's v1 record hash, and `detail_hash`). */
export function recordHashOf(record: Readonly<Record<string, unknown>>): string {
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(record)) if (k !== 'signature' && record[k] !== undefined) rest[k] = record[k];
  return sha256HexOfText(canonicalJson(rest));
}

/**
 * The pre-meter relay's PE hash recipes. Each retired writer hashed sha256(json-stable-stringify(
 * content)) over a fixed set of the record's own fields — never the whole stored document, which
 * also carried storage fields (`user_id`, `policy_action_type`, `durability`, …). A field the writer
 * omitted is absent from the preimage (json-stable-stringify drops `undefined`); `canonicalJson`
 * produces the same bytes. Keyed by the record's `integration_source`.
 */
export const PRE_METER_HASH_RECIPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  device_pe_submit: ['id', 'wallet_id', 'action_type', 'actor_address', 'timestamp', 'prev_hash', 'attestation_type', 'description', 'intent_text', 'metadata', 'compute', 'geo', 'execution_env', 'cited_pe_ids', 'parent_goal_pe_id', 'input_origins', 'output_digests'],
  agent_bank_generate_pe: ['id', 'wallet_id', 'agent_id', 'action_type', 'actor_address', 'timestamp', 'prev_hash', 'attestation_type', 'metadata', 'compute', 'geo', 'execution_env', 'cited_pe_ids', 'parent_goal_pe_id', 'input_origins', 'output_digests'],
  mobile_pe_submit: ['id', 'wallet_id', 'user_id', 'action_type', 'actor_address', 'timestamp', 'prev_hash', 'attestation_type', 'description', 'metadata', 'compute', 'geo', 'execution_env', 'cited_pe_ids', 'parent_goal_pe_id', 'input_origins', 'output_digests'],
  human_wallet_registration: ['id', 'wallet_id', 'user_id', 'action_type', 'actor_address', 'timestamp', 'prev_hash', 'attestation_type', 'metadata'],
  device_registration: ['id', 'wallet_id', 'action_type', 'actor_address', 'timestamp', 'prev_hash', 'attestation_type', 'metadata'],
  device_revocation: ['id', 'wallet_id', 'action_type', 'actor_address', 'timestamp', 'prev_hash', 'attestation_type', 'metadata'],
  delegation_pe: ['id', 'user_id', 'action_type', 'actor_address', 'timestamp', 'prev_hash', 'attestation_type', 'intent_text', 'chain_id', 'asset_symbol', 'amount', 'counterparty_address', 'counterparty_type', 'device_attestation_id', 'policy_decision', 'risk_score', 'risk_category', 'null_state_flags', 'metadata'],
  relay_work_product: ['id', 'product_type', 'artifact_hash', 'created_at'],
});

/**
 * The recipe whose preimage reproduces a pre-meter record's `hash`: its own writer's first (named by
 * `integration_source`), then every other. Null when none does — the record is then unverifiable,
 * never verified.
 */
export function preMeterRecipeOf(record: Readonly<Record<string, unknown>>): string | null {
  if (typeof record.hash !== 'string') return null;
  const named = typeof record.integration_source === 'string' ? record.integration_source : null;
  const order = Object.keys(PRE_METER_HASH_RECIPES).sort((a, b) => (a === named ? -1 : b === named ? 1 : 0));
  for (const name of order) {
    const content: Record<string, unknown> = {};
    for (const k of PRE_METER_HASH_RECIPES[name]) if (record[k] !== undefined) content[k] = record[k];
    if (sha256HexOfText(canonicalJson(content)) === record.hash) return name;
  }
  return null;
}

/** The next running-hash value after one line (the line without its newline). */
export function exportChainNext(prev: string, line: string): string {
  return sha256HexOfText(prev + '\n' + line);
}

export function exportChainStart(): string {
  return sha256HexOfText(CHAIN_START);
}

// ─── building ───────────────────────────────────────────────────────────────────

/** A pe/received line's inclusion with the anchor contract filled (a device may hold it as '' or null). */
export function withPinnedContract(inclusion: ActInclusionProof): ActInclusionProof {
  if (inclusion.anchor === undefined) return inclusion;
  return {
    ...inclusion,
    anchor: {
      ...inclusion.anchor,
      chain_id: inclusion.anchor.chain_id || PE_EXPORT_BASE_CHAIN_ID,
      contract: inclusion.anchor.contract || PE_EXPORT_PE_ANCHOR,
    },
  };
}

/** The inclusion proof of the PE at position `at` among a batch's PEs (all of them, in chain order). */
export function inclusionFromBatch(input: {
  readonly pes: readonly PeV2[];
  readonly at: number;
  readonly device_id: string;
  readonly actor_id: string;
  readonly seq: number;
  readonly batch_hash: string;
  readonly acts_root: string;
  readonly anchor: ExportBatchAnchor | null;
}): { ok: true; inclusion: ActInclusionProof } | { ok: false; reason: 'acts_root_mismatch' } {
  const leaves = input.pes.map((p) => actLeafOf(actRecordOf(p)));
  if (merkleRootOf(leaves) !== input.acts_root) return { ok: false, reason: 'acts_root_mismatch' };
  return {
    ok: true,
    inclusion: inclusionFromLeaves({ ...input, leaves }),
  };
}

/**
 * The inclusion proof of the act at `at` from the batch's act leaves (as the relay recorded them).
 * `act_proof`, when given, is that act's proof from one build of the same tree (merkleTreeOf) —
 * proving many acts of one batch then builds its tree once, not once per act.
 */
export function inclusionFromLeaves(input: {
  readonly leaves: readonly string[];
  readonly at: number;
  readonly device_id: string;
  readonly actor_id: string;
  readonly seq: number;
  readonly batch_hash: string;
  readonly acts_root: string;
  readonly anchor: ExportBatchAnchor | null;
  readonly act_proof?: readonly string[];
}): ActInclusionProof {
  return {
    act_index: input.at,
    act_proof: input.act_proof !== undefined ? [...input.act_proof] : merkleProofOf(input.leaves, input.at),
    acts_root: input.acts_root,
    batch: { device_id: input.device_id, actor_id: input.actor_id, seq: input.seq, batch_hash: input.batch_hash },
    ...(input.anchor !== null ? {
      anchor: {
        chain_id: PE_EXPORT_BASE_CHAIN_ID,
        contract: PE_EXPORT_PE_ANCHOR,
        anchor_batch_id: input.anchor.anchor_batch_id,
        day: input.anchor.day,
        ...(input.anchor.segment !== undefined ? { segment: input.anchor.segment } : {}),
        leaf_index: input.anchor.leaf_index,
        proof: [...input.anchor.proof],
        merkle_root: input.anchor.merkle_root,
        tx_hash: input.anchor.tx_hash,
      },
    } : {}),
  };
}

/**
 * Order the PEs of one batch that a recipient holds by their chain links (each PE's `prev_hash` is
 * its predecessor's `pe_hash`). Returns null unless they form ONE unbroken run.
 */
export function chainOrderOf<T extends { readonly pe: PeV2WithHash }>(items: readonly T[]): T[] | null {
  if (items.length === 0) return null;
  const byPrev = new Map<string, T>();
  const hashes = new Set<string>();
  for (const it of items) {
    if (byPrev.has(it.pe.prev_hash)) return null;
    byPrev.set(it.pe.prev_hash, it);
    hashes.add(it.pe.pe_hash);
  }
  const heads = items.filter((it) => !hashes.has(it.pe.prev_hash));
  if (heads.length !== 1) return null;
  const out: T[] = [heads[0]];
  while (out.length < items.length) {
    const next = byPrev.get(out[out.length - 1].pe.pe_hash);
    if (next === undefined) return null;
    out.push(next);
  }
  return out;
}

/** Serialize an export: every line canonical, the running hash folded, the end line appended. */
export function serializeExport(
  header: ExportHeader,
  body: readonly ExportBodyLine[],
  incomplete: ExportEndLine['incomplete'],
): string {
  const order: Record<ExportBodyLine['type'], number> = { pe: 0, batch: 1, received: 2, legacy: 3 };
  const sorted = [...body].map((l, i) => ({ l, i })).sort((a, b) => order[a.l.type] - order[b.l.type] || a.i - b.i).map((x) => x.l);
  const lines: string[] = [canonicalJson(header)];
  for (const l of sorted) lines.push(canonicalJson(l));
  let chain = exportChainStart();
  for (const line of lines) chain = exportChainNext(chain, line);
  const counts = { pe: 0, batch: 0, received: 0, legacy: 0 };
  for (const l of sorted) counts[l.type] += 1;
  const end: ExportEndLine = { type: 'end', lines: lines.length, chain, counts, incomplete: [...incomplete] };
  lines.push(canonicalJson(end));
  return lines.join('\n') + '\n';
}

// ─── parsing ────────────────────────────────────────────────────────────────────

export type ExportParseError =
  | 'empty'
  | 'line_not_json'
  | 'line_not_canonical'
  | 'no_header'
  | 'wrong_schema'
  | 'no_end'
  | 'end_count_mismatch'
  | 'chain_mismatch'
  | 'unknown_line_type'
  | 'line_after_end';

export function parseExport(text: string): { ok: true; header: ExportHeader; body: ExportBodyLine[]; end: ExportEndLine } | { ok: false; error: ExportParseError; line?: number } {
  const raw = text.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  if (raw.length === 0) return { ok: false, error: 'empty' };
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < raw.length; i++) {
    let rec: unknown;
    try {
      rec = JSON.parse(raw[i]);
    } catch {
      return { ok: false, error: 'line_not_json', line: i + 1 };
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return { ok: false, error: 'line_not_json', line: i + 1 };
    if (canonicalJson(rec) !== raw[i]) return { ok: false, error: 'line_not_canonical', line: i + 1 };
    records.push(rec as Record<string, unknown>);
  }
  const header = records[0];
  if (header.type !== 'header') return { ok: false, error: 'no_header', line: 1 };
  if (header.schema !== PE_EXPORT_SCHEMA) return { ok: false, error: 'wrong_schema', line: 1 };
  const last = records[records.length - 1];
  if (last.type !== 'end') return { ok: false, error: 'no_end', line: records.length };
  const end = last as unknown as ExportEndLine;
  if (end.lines !== records.length - 1) return { ok: false, error: 'end_count_mismatch', line: records.length };
  let chain = exportChainStart();
  for (let i = 0; i < records.length - 1; i++) chain = exportChainNext(chain, raw[i]);
  if (chain !== end.chain) return { ok: false, error: 'chain_mismatch', line: records.length };
  const body: ExportBodyLine[] = [];
  for (let i = 1; i < records.length - 1; i++) {
    const t = records[i].type;
    if (t === 'end') return { ok: false, error: 'line_after_end', line: i + 1 };
    if (t !== 'pe' && t !== 'batch' && t !== 'received' && t !== 'legacy') return { ok: false, error: 'unknown_line_type', line: i + 1 };
    body.push(records[i] as unknown as ExportBodyLine);
  }
  return { ok: true, header: header as unknown as ExportHeader, body, end };
}

// ─── verifying (offline: everything up to each day's root) ───────────────────────

export interface ExportFailure {
  /** 1-based line number in the file. */
  readonly line: number;
  readonly type: ExportBodyLine['type'];
  readonly id: string;
  readonly reason: string;
}

/** One day root the verifier must find on Base. */
export interface ExportAnchorClaim {
  readonly anchor_batch_id: string;
  readonly day: string;
  readonly merkle_root: string;
  /** Lines resting on this root. */
  readonly lines: number;
}

export interface ExportOfflineReport {
  readonly counts: {
    readonly pe: { total: number; proven_to_root: number; pending: number };
    readonly received: { total: number; proven_to_root: number; pending: number };
    readonly batch: { total: number; proven_to_root: number; pending: number };
    /**
     * `hash_checked`: the record's content reproduces its hash (device history: its canonical JSON;
     * handed back: its writer's recipe). `hash_unverifiable`: a handed-back record no known recipe
     * reproduces (reported, not a failure). Every legacy record is `unanchorable`.
     */
    readonly legacy: { total: number; hash_checked: number; hash_unverifiable: number; unanchorable: number };
  };
  /** Lines that are not yet anchored (or never were), by status. */
  readonly pending: readonly { readonly line: number; readonly type: string; readonly id: string; readonly status: string }[];
  readonly failures: readonly ExportFailure[];
  /**
   * Positions missing from a device chain the file carries (`before` = the first index present after
   * the gap). A gap in a chain the header lists under `devices` means the export left out PEs that
   * device holds; a gap in a chain known only from the Archive marks days that were never archived.
   */
  readonly gaps: readonly { readonly device_id: string; readonly from: number; readonly before: number }[];
  readonly anchors: readonly ExportAnchorClaim[];
}

function isHex64(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

function checkAnchor(
  anchor: ActInclusionProof['anchor'] | ExportBatchAnchor | undefined | null,
  batchLeaf: string,
  claims: Map<string, ExportAnchorClaim>,
): string | null {
  if (anchor === undefined || anchor === null) return 'anchor_missing';
  if ('contract' in anchor && anchor.contract.toLowerCase() !== PE_EXPORT_PE_ANCHOR.toLowerCase()) return 'anchor_contract_untrusted';
  if ('chain_id' in anchor && anchor.chain_id !== PE_EXPORT_BASE_CHAIN_ID) return 'anchor_chain_untrusted';
  let id: string;
  let root: string;
  try {
    id = meterAnchorBatchIdOf(anchor.day, anchor.segment);
    root = foldAnchorProof(anchoredLeafOf(batchLeaf), anchor.proof);
  } catch {
    return 'anchor_malformed';
  }
  if (id !== anchor.anchor_batch_id.toLowerCase()) return 'anchor_batch_id_mismatch';
  if (root !== anchor.merkle_root.toLowerCase()) return 'anchor_proof_mismatch';
  const prior = claims.get(id);
  if (prior !== undefined && prior.merkle_root !== root) return 'anchor_root_conflict';
  claims.set(id, { anchor_batch_id: id, day: anchor.day, merkle_root: root, lines: (prior?.lines ?? 0) + 1 });
  return null;
}

/** Check one PE line's own hash, detail commitment and both proof hops. Returns a failure reason or null. */
function checkPeLine(
  pe: PeV2WithHash,
  detail: Readonly<Record<string, unknown>> | undefined,
  inclusion: ActInclusionProof | null,
  status: ExportPeStatus,
  deviceId: string,
  claims: Map<string, ExportAnchorClaim>,
): string | null {
  let hash: string;
  try {
    hash = peHashOf(pe);
  } catch {
    return 'pe_not_canonical';
  }
  if (pe.pe_hash !== hash) return 'pe_hash_mismatch';
  if (pe.device_id !== deviceId) return 'pe_device_mismatch';
  if (detail !== undefined) {
    if (typeof pe.detail_hash !== 'string') return 'detail_without_commitment';
    if (!detailMatchesPe(detail,pe)) return 'detail_hash_mismatch';
  }
  if (inclusion === null) return status === 'anchored' ? 'inclusion_missing' : null;
  if (inclusion.batch.device_id !== deviceId) return 'inclusion_device_mismatch';
  const hop = verifyActInclusion(pe, inclusion);
  if (!hop.ok) return hop.reason;
  if (status !== 'anchored') return inclusion.anchor === undefined ? null : 'status_inconsistent';
  return checkAnchor(inclusion.anchor, hop.batch_leaf, claims);
}

/**
 * Verify every line offline: hashes, chain links, each act's path to its batch's acts_root, each
 * batch leaf's path to its day root, and the batch records against the PEs they carried. What it
 * cannot do offline — confirm each day root is the one written on Base — it returns as `anchors`
 * for `verifyAnchorsOnChain`.
 */
export function verifyExportOffline(body: readonly ExportBodyLine[]): ExportOfflineReport {
  const claims = new Map<string, ExportAnchorClaim>();
  const failures: ExportFailure[] = [];
  const gaps: { device_id: string; from: number; before: number }[] = [];
  const pending: { line: number; type: string; id: string; status: string }[] = [];
  const counts = {
    pe: { total: 0, proven_to_root: 0, pending: 0 },
    received: { total: 0, proven_to_root: 0, pending: 0 },
    batch: { total: 0, proven_to_root: 0, pending: 0 },
    legacy: { total: 0, hash_checked: 0, hash_unverifiable: 0, unanchorable: 0 },
  };
  const chains = new Map<string, Map<number, { line: number; pe: PeV2WithHash }>>();
  const peIds = new Set<string>();
  body.forEach((l, i) => {
    const line = i + 2;
    const fail = (id: string, reason: string): void => {
      failures.push({ line, type: l.type, id, reason });
    };
    if (l.type === 'pe' || l.type === 'received') {
      const bucket = l.type === 'pe' ? counts.pe : counts.received;
      bucket.total += 1;
      const id = l.pe?.pe_id ?? '?';
      if (l.pe === null || typeof l.pe !== 'object' || !isHex64(l.pe.pe_hash)) {
        fail(id, 'pe_malformed');
        return;
      }
      const deviceId = l.type === 'pe' ? l.device_id : l.from_device;
      if (l.type === 'received' && l.inclusion !== null && l.inclusion.batch.batch_hash !== l.batch_hash) {
        fail(id, 'inclusion_batch_mismatch');
        return;
      }
      const reason = checkPeLine(l.pe, l.type === 'pe' ? l.detail : undefined, l.inclusion, l.status, deviceId, claims);
      if (reason !== null) {
        fail(id, reason);
        return;
      }
      if (l.status === 'anchored') bucket.proven_to_root += 1;
      else {
        bucket.pending += 1;
        pending.push({ line, type: l.type, id, status: l.status });
      }
      if (l.type === 'pe') {
        const key = `${l.device_id}\u0000${l.pe.pe_id}`;
        if (peIds.has(key)) {
          fail(id, 'duplicate_pe');
          return;
        }
        peIds.add(key);
        const chain = chains.get(l.device_id) ?? new Map();
        chains.set(l.device_id, chain);
        if (chain.has(l.index)) {
          fail(id, 'duplicate_index');
          return;
        }
        chain.set(l.index, { line, pe: l.pe });
      }
      return;
    }
    if (l.type === 'legacy') {
      counts.legacy.total += 1;
      if (l.record === null || typeof l.record !== 'object') {
        fail(l.id, 'record_malformed');
        return;
      }
      if (l.source === 'device_history') {
        if (l.hash !== recordHashOf(l.record)) {
          fail(l.id, 'record_hash_mismatch');
          return;
        }
        counts.legacy.hash_checked += 1;
      } else {
        if (l.hash !== null && l.record.hash !== l.hash) {
          fail(l.id, 'record_hash_mismatch');
          return;
        }
        if (preMeterRecipeOf(l.record) !== null) counts.legacy.hash_checked += 1;
        else counts.legacy.hash_unverifiable += 1;
      }
      counts.legacy.unanchorable += 1;
      return;
    }
    // batch
    counts.batch.total += 1;
    const id = `${l.device_id}#${l.seq}`;
    if (l.adopted || l.acts_root === null || l.actor_id === null || l.batch_leaf === null) {
      counts.batch.pending += 1;
      pending.push({ line, type: 'batch', id, status: l.adopted ? 'adopted_range' : 'not_anchored_yet' });
      return;
    }
    let leaf: string;
    try {
      leaf = batchLeafOf({ device_id: l.device_id, actor_id: l.actor_id, seq: l.seq, batch_hash: l.batch_hash, acts_root: l.acts_root });
    } catch {
      fail(id, 'batch_malformed');
      return;
    }
    if (leaf !== l.batch_leaf) {
      fail(id, 'batch_leaf_mismatch');
      return;
    }
    if (l.anchor === null) {
      counts.batch.pending += 1;
      pending.push({ line, type: 'batch', id, status: 'not_anchored_yet' });
      return;
    }
    const reason = checkAnchor(l.anchor, leaf, claims);
    if (reason !== null) {
      fail(id, reason);
      return;
    }
    counts.batch.proven_to_root += 1;
  });
  // Chain links across each device's PE lines, and each batch against the PEs it carried.
  for (const [deviceId, chain] of chains) {
    const indexes = [...chain.keys()].sort((a, b) => a - b);
    for (let k = 0; k < indexes.length; k++) {
      const at = indexes[k];
      const cur = chain.get(at);
      if (cur === undefined) continue;
      if (at === 0 && cur.pe.prev_hash !== METER_GENESIS_PREV_HASH) {
        failures.push({ line: cur.line, type: 'pe', id: cur.pe.pe_id, reason: 'chain_start_mismatch' });
      }
      const prevAt = k === 0 ? -1 : indexes[k - 1];
      if (prevAt !== at - 1) gaps.push({ device_id: deviceId, from: prevAt + 1, before: at });
      else if (k > 0) {
        const prev = chain.get(prevAt);
        if (prev !== undefined && cur.pe.prev_hash !== prev.pe.pe_hash) {
          failures.push({ line: cur.line, type: 'pe', id: cur.pe.pe_id, reason: 'chain_link_mismatch' });
        }
      }
    }
  }
  body.forEach((l, i) => {
    if (l.type !== 'batch' || l.acts_root === null || l.adopted) return;
    const chain = chains.get(l.device_id);
    if (chain === undefined) return;
    const pes: PeV2WithHash[] = [];
    for (let at = l.first_index; at < l.first_index + l.count; at++) {
      const held = chain.get(at);
      if (held === undefined) return; // reported as a chain gap above when the PE is missing
      pes.push(held.pe);
    }
    if (merkleRootOf(pes.map((p) => actLeafOf(actRecordOf(p)))) !== l.acts_root) {
      failures.push({ line: i + 2, type: 'batch', id: `${l.device_id}#${l.seq}`, reason: 'acts_root_does_not_match_pes' });
      return;
    }
    const acts = l.receipt !== null && Array.isArray((l.receipt as { acts?: unknown }).acts) ? (l.receipt as { acts: { pe_hash?: unknown }[] }).acts : null;
    if (acts !== null && (acts.length !== pes.length || acts.some((a, k) => a.pe_hash !== pes[k].pe_hash))) {
      failures.push({ line: i + 2, type: 'batch', id: `${l.device_id}#${l.seq}`, reason: 'receipt_does_not_match_pes' });
    }
  });
  return { counts, pending, failures, gaps, anchors: [...claims.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)) };
}

// ─── verifying on Base ──────────────────────────────────────────────────────────

/** `eth_call` against Base mainnet: returns the call's hex result. */
export type EthCall = (to: string, data: string) => Promise<string>;

/** Facts are checked before a presentation can broadcast its burn, including elected disclosures. */
export interface PresentationProofInput {
  readonly peId: string;
  readonly envelopeHash: string;
  readonly pe?: object;
  readonly inclusion?: object;
}

export async function preflightPresentationProofs(facts: readonly PresentationProofInput[], ethCall: EthCall): Promise<void> {
  if (facts.length === 0) return;
  const lines: ExportReceivedLine[] = facts.map(f => {
    const pe = f.pe as unknown as PeV2WithHash | undefined;
    const inclusion = f.inclusion as unknown as ActInclusionProof | undefined;
    if (!pe || !inclusion || pe.pe_id !== f.peId || pe.pe_hash !== f.envelopeHash.toLowerCase().replace(/^0x/, '')) {
      throw new Error('presentation_proof_invalid:pe_identity_or_proof_missing');
    }
    return { type: 'received', source: 'archive', mailbox_id: null,
      from_actor: inclusion.batch?.actor_id, from_device: pe.device_id,
      batch_hash: inclusion.batch?.batch_hash, received_at_ms: null, pe, status: 'anchored', inclusion };
  });
  let report: ExportOfflineReport;
  try { report = verifyExportOffline(lines); }
  catch { throw new Error('presentation_proof_invalid:malformed'); }
  if (report.failures.length > 0) throw new Error(`presentation_proof_invalid:${report.failures[0].reason}`);
  if (report.counts.received.proven_to_root !== facts.length || report.anchors.length === 0) throw new Error('presentation_proof_invalid:not_anchored');
  const checks = await verifyAnchorsOnChain(report.anchors, ethCall);
  const bad = checks.find(c => !c.ok);
  if (bad) throw new Error(`presentation_proof_invalid:${bad.reason}`);
}

/** Calldata for PEAnchor.getBatch(bytes32). */
export function getBatchCalldata(anchorBatchId: string): string {
  const selector = bytesToHexLower(keccak256Bytes(utf8Bytes('getBatch(bytes32)'))).slice(0, 8);
  return '0x' + selector + norm32(anchorBatchId);
}

/** Decode getBatch's return: (merkleRoot, peCount, timestamp, epochNumber, exists). */
export function decodeGetBatch(result: string): { merkle_root: string; pe_count: string; timestamp: number; exists: boolean } | null {
  const h = result.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]*$/.test(h) || h.length < 64 * 5) return null;
  const word = (i: number): string => h.slice(i * 64, (i + 1) * 64);
  const big = (w: string): bigint => BigInt('0x' + w);
  return {
    merkle_root: '0x' + word(0),
    pe_count: big(word(1)).toString(),
    timestamp: Number(big(word(2))),
    exists: big(word(4)) !== BigInt(0),
  };
}

export interface ExportAnchorCheck extends ExportAnchorClaim {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly onchain_timestamp: number | null;
}

/** Read every claimed day root from PEAnchor on Base and compare. */
export async function verifyAnchorsOnChain(anchors: readonly ExportAnchorClaim[], ethCall: EthCall): Promise<ExportAnchorCheck[]> {
  const out: ExportAnchorCheck[] = [];
  for (const a of anchors) {
    let decoded: ReturnType<typeof decodeGetBatch>;
    try {
      decoded = decodeGetBatch(await ethCall(PE_EXPORT_PE_ANCHOR, getBatchCalldata(a.anchor_batch_id)));
    } catch (err) {
      out.push({ ...a, ok: false, reason: `rpc_error:${(err as Error).message}`, onchain_timestamp: null });
      continue;
    }
    if (decoded === null) out.push({ ...a, ok: false, reason: 'rpc_result_malformed', onchain_timestamp: null });
    else if (!decoded.exists) out.push({ ...a, ok: false, reason: 'day_not_anchored_on_chain', onchain_timestamp: null });
    else if (decoded.merkle_root !== a.merkle_root.toLowerCase()) out.push({ ...a, ok: false, reason: 'onchain_root_differs', onchain_timestamp: decoded.timestamp });
    else out.push({ ...a, ok: true, reason: null, onchain_timestamp: decoded.timestamp });
  }
  return out;
}

// ─── the verdict ────────────────────────────────────────────────────────────────

/**
 * The one verdict over an export, the same on every verifier (`provian verify-export`, the CLI's
 * `pes verify`, the phone's own check of the file it just wrote):
 *   ok                  every line verifies, no chain the header lists has a gap, every day root is
 *                       confirmed on Base, AND the end line's `incomplete` is empty;
 *   incomplete          everything in the file verifies (day roots confirmed on Base), but the
 *                       producer named something it holds that it could not include (`incomplete`):
 *                       the file proves what it carries and is NOT everything the owner holds;
 *   offline_ok          `ok` without the chain read (the day roots to check are listed);
 *   offline_incomplete  `incomplete` without the chain read;
 *   failed              a parse error, a failing line, a gap in a listed chain, or a day root Base
 *                       does not confirm.
 * Pending lines (in the file, not yet in an anchored day root) never fail and never make an export
 * incomplete: they carry no anchor until the file is re-exported after the next daily anchor.
 */
export type ExportVerdict = 'ok' | 'incomplete' | 'offline_ok' | 'offline_incomplete' | 'failed';

export function exportVerdictOf(input: {
  readonly parsed: boolean;
  readonly failures: number;
  readonly gapsInListedDevices: number;
  /** Entries in the end line's `incomplete`. */
  readonly incomplete: number;
  /** null: not checked (offline); true: every day root confirmed on Base; false: one or more not. */
  readonly anchorsConfirmed: boolean | null;
}): ExportVerdict {
  if (!input.parsed || input.failures > 0 || input.gapsInListedDevices > 0 || input.anchorsConfirmed === false) return 'failed';
  const missing = input.incomplete > 0;
  if (input.anchorsConfirmed === null) return missing ? 'offline_incomplete' : 'offline_ok';
  return missing ? 'incomplete' : 'ok';
}
