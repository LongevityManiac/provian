/**
 * PVT - Daily PE Anchoring ("anchor-everything", launch linked-job settlement) — the LEGACY per-PE anchor, RETIRED.
 *
 * PE METER : the relay no longer stores PEs, so there is no `pe_history` day to
 * build a per-PE Merkle tree over. The meter anchors what it accepts instead — one leaf per
 * accepted batch, per UTC day, under its own `meter` batch id (`core/meter/meter-anchor.ts`) —
 * and the scheduler's daily run anchors those. The per-PE runner, its straggler sweep, its
 * backfill and its segmented routing (all of which read `pe_history`) are removed; their
 * scheduler handlers answer `legacy_daily_pe_anchor_retired`.
 *
 * What stays here, because live code and verifiers depend on it:
 * - the batch-id NAMESPACE and its derivation (`computeDailyAnchorBatchId`): the meter's own
 * batch id is derived in the same 0xFF-tagged namespace, which is what keeps every anchor id
 * disjoint from every mint batch id (`batch-id.ts::computeDeterministicBatchId` hashes pure
 * UTF-8; 0xFF is never a valid UTF-8 byte, so no mint preimage can equal an anchor preimage);
 * - the UTC day helpers the meter anchor uses;
 * - the stored-batch shape and `buildProofFromBatchDoc`, so a PE anchored BEFORE the meter
 * (its batch doc in `pe_daily_anchor_batches`, its root on Base) keeps serving its inclusion
 * proof (`GET /v1/pe/:pe_id/proof`, pe_fact presentations).
 *
 * Leaf rule of those historical batches (served with every proof):
 * leaf = keccak256(0x00 || bytes32(envelope_sha256)), ordered (timestamp asc, envelope_id asc).
 */

import { ethers } from 'ethers';
import {
  buildMerkleTreeFromLeafHashes,
  generateProof,
  hashEnvelopeHashLeaf,
  verifyMerkleProof,
} from './merkle';

// =============================================================================
// CONSTANTS
// =============================================================================

export const DAILY_PE_ANCHOR_NAMESPACE = 'provian:daily-pe-anchor:v1';

/** Firestore collections the historical per-PE anchor wrote (read-only now). */
export const DAILY_ANCHOR_BATCHES_COLLECTION = 'pe_daily_anchor_batches';
export const DAILY_ANCHOR_STATE_COLLECTION = 'pe_anchor_state';
export const DAILY_ANCHOR_STATE_DOC = 'daily';

/** Served with every proof so verifiers can cite the exact rules. */
export const PE_ANCHOR_LEAF_RULE =
  'keccak256(0x00 || bytes32(envelope_sha256)) — envelope_sha256 is the PE\'s existing canonical envelope hash (pe_history.peHash); see docs/PE_PROTOCOL_SPEC.md "Daily On-Chain Anchoring"';
export const PE_ANCHOR_LEAF_ORDERING = 'timestamp asc, then envelope_id asc';

/** What the retired scheduler handlers answer (a still-enabled cron reads it as a clean no-op). */
export const LEGACY_DAILY_PE_ANCHOR_RETIRED = Object.freeze({
  code: 'legacy_daily_pe_anchor_retired',
  reason: 'PE meter: the relay stores no PE history to anchor per PE; accepted batches are anchored by the meter daily anchor.',
});

const DAY_MS = 86_400_000;

// =============================================================================
// TYPES (the stored shape of a historical anchor batch)
// =============================================================================

export type AnchorBatchKind = 'day' | 'backfill';

export interface AnchorBatchMember {
  pe_id: string;
  /** The PE's existing canonical envelope hash (sha256 hex, no 0x). */
  pe_hash: string;
  /** The PE's timestamp (Unix ms) — first ordering key. */
  timestamp: number;
}

export interface DailyAnchorBatchDocument {
  batch_id: string;
  batch_id_preimage: string;
  /** The 0xFF domain tag is part of the id derivation, not the preimage string. */
  batch_id_rule: string;
  namespace: string;
  kind: AnchorBatchKind;
  /** UTC day key (YYYY-MM-DD). For 'backfill': the through-day (inclusive). */
  day: string;
  merkle_root: string;
  pe_count: number;
  leaf_rule: string;
  leaf_ordering: string;
  /** Ordered by (timestamp, pe_id); array index IS the leaf_index. */
  members: AnchorBatchMember[];
  /** Members swept in from earlier days (subset of members; telemetry). */
  swept_pe_ids: string[];
  anchor_args: {
    batchId: string;
    merkleRoot: string;
    peCount: number;
    /** End-of-day boundary, Unix ms (mint-path convention is JS ms). */
    timestamp: number;
    /** UTC day number (floor(dayStartMs / 86_400_000)) — self-describing. */
    epochNumber: number;
  };
  chain_id: number;
  pe_anchor_contract_address: string;
  status: 'pending' | 'anchored' | 'empty' | 'superseded';
  anchor_tx_hash: string | null;
  writebacks_complete: boolean;
  created_at: number;
  anchored_at: number | null;
}

export interface PEInclusionProof {
  leaf_index: number;
  leaf_value: string;
  proof: string[];
  merkle_root: string;
  pe_count: number;
}

// =============================================================================
// DAY / BATCH-ID HELPERS
// =============================================================================

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function utcDayKeyFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcDayBounds(dayKey: string): { startMs: number; endMs: number } {
  if (!DAY_KEY_RE.test(dayKey)) {
    throw new Error(`Invalid UTC day key (need YYYY-MM-DD): ${dayKey}`);
  }
  const startMs = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(startMs) || utcDayKeyFromMs(startMs) !== dayKey) {
    throw new Error(`Invalid UTC day key (not a real date): ${dayKey}`);
  }
  return { startMs, endMs: startMs + DAY_MS };
}

export function utcDayNumber(dayKey: string): number {
  return Math.floor(utcDayBounds(dayKey).startMs / DAY_MS);
}

/**
 * Daily-anchor batch id — a namespace provably disjoint from mint batch ids.
 *
 * Mint ids are keccak256 over pure UTF-8 (computeDeterministicBatchId). This
 * id prefixes the preimage with the single byte 0xFF, which is never a valid
 * UTF-8 byte, so no (peIds, merkleRoot) input — however adversarial — can
 * reproduce a daily-anchor preimage. Collision would additionally require the
 * shared on-chain `batches` mapping to see equal keccak outputs, and even
 * then the contract's BatchAlreadyAnchored revert bounds the damage to a
 * denial of one batch, never an overwrite.
 */
export function computeDailyAnchorBatchId(kind: AnchorBatchKind, dayKey: string): string {
  utcDayBounds(dayKey); // validates dayKey shape + calendar reality
  const preimage = dailyAnchorBatchIdPreimage(kind, dayKey);
  return ethers.keccak256(ethers.concat(['0xff', ethers.toUtf8Bytes(preimage)]));
}

export function dailyAnchorBatchIdPreimage(kind: AnchorBatchKind, dayKey: string): string {
  return `${DAILY_PE_ANCHOR_NAMESPACE}:${kind}:${dayKey}`;
}

// =============================================================================
// PROOFS (historical batches)
// =============================================================================

/**
 * Rebuild the batch tree from its STORED ordered membership and produce the
 * inclusion proof for one PE. Throws if the rebuilt root diverges from the
 * stored root (integrity failure — the batch doc was tampered with or
 * corrupted; serving a proof would be lying).
 */
export function buildProofFromBatchDoc(
  batchDoc: Pick<DailyAnchorBatchDocument, 'members' | 'merkle_root' | 'pe_count'>,
  peId: string,
): PEInclusionProof | null {
  const members = batchDoc.members ?? [];
  const leafIndex = members.findIndex((m) => m.pe_id === peId);
  if (leafIndex === -1) return null;

  const leaves = members.map((m) => hashEnvelopeHashLeaf(m.pe_hash));
  const tree = buildMerkleTreeFromLeafHashes(leaves);
  if (batchDoc.merkle_root && tree.root !== batchDoc.merkle_root) {
    throw new Error(
      `Batch integrity failure: rebuilt root ${tree.root} != stored ${batchDoc.merkle_root}`,
    );
  }

  const proof = generateProof(tree, leafIndex);
  if (!verifyMerkleProof(proof.leaf, proof.proof, tree.root)) {
    throw new Error('Generated proof failed local verification'); // defense in depth
  }

  return {
    leaf_index: leafIndex,
    leaf_value: proof.leaf,
    proof: proof.proof,
    merkle_root: tree.root,
    pe_count: members.length,
  };
}
