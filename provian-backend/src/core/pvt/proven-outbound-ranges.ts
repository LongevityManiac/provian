/**
 * who finds a proven EOA's own transactions, block by block.
 *
 * From `B_F` (the block the first registry-driven chain-record run started at, stored once
 * in `proven_outbound_full_block_since`) the chain-record scan finds them in the full blocks it
 * already reads: every transaction whose sender is a watched proven EOA. Below `B_F`, and for any
 * range that scan could not have covered for an address (it entered the registry after the scan
 * passed its fence, or its row was held while malformed), the nonce scanner backfills a bounded
 * RANGE cursor: `[from_block, through_block]`, one document per (address, range start), so ranges
 * never overwrite each other. Every block of every proven EOA from its fence on is therefore
 * covered by exactly one of the two (overlap is harmless: the lane's queue is idempotent by
 * transaction and wallet).
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { ChainRecordOwnerType } from './chain-record-watcher';

export const CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION = 'chain_record_scan_checkpoints';
export const PROVEN_OUTBOUND_CURSOR_PREFIX = 'proven_outbound_';
export const PROVEN_OUTBOUND_FULL_BLOCK_DOC = 'proven_outbound_full_block_since';
export const PROVEN_OUTBOUND_RANGE_SCHEMA = 'chain-record-proven-outbound-range/v1';
const FULL_BLOCK_SCHEMA = 'chain-record-proven-outbound-full-block/v1';

/**
 * The earliest block a cursor ever starts at: Base block 52,040,000, about 2.3
 * hours (Base runs at exactly 2 s a block) before `PROVEN_ADDRESS_COMMERCE_CUT_
 * LINE_MS` (2026-10-01T18:00Z, estimated at block ~52,044,126 from the head read
 * on 2026-10-01). Nothing before the cut line can mint (the lane refuses it by
 * block time), so an older proof starts here instead of re-walking history that
 * can only be refused; the margin means no post-cut-line transaction is skipped.
 */
export const PROVEN_OUTBOUND_FLOOR_BLOCK = 52_040_000;

export interface ProvenOutboundRange {
  readonly id: string;
  readonly address: string;
  readonly owner_type: ChainRecordOwnerType;
  /** Next block to scan; every transaction with a lower nonce than `nonce` is queued. */
  readonly next_block: number;
  /** null until read at `next_block - 1`. */
  readonly nonce: number | null;
  /** Last block this range covers (inclusive). */
  readonly through_block: number;
  readonly done: boolean;
  readonly updated_at_ms: number;
}

export function provenOutboundRangeId(address: string, fromBlock: number): string {
  return `${PROVEN_OUTBOUND_CURSOR_PREFIX}${address}_${fromBlock}`;
}

/** B_F, or null before the first registry-driven chain-record run. A malformed doc throws. */
export async function readFullBlockSince(db: Firestore): Promise<number | null> {
  const snap = await db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(PROVEN_OUTBOUND_FULL_BLOCK_DOC).get();
  if (!snap.exists) return null;
  const raw = snap.data() as Record<string, unknown> | undefined;
  if (raw?.schema_version !== FULL_BLOCK_SCHEMA || !Number.isSafeInteger(raw.block) || (raw.block as number) < 0) {
    throw new Error('chain_record_proven_outbound_full_block_invalid');
  }
  return raw.block as number;
}

/** Record B_F once (the first registry-driven run's start block); returns the stored value. */
export async function fixFullBlockSince(db: Firestore, block: number, nowMs: number): Promise<number> {
  const ref = db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(PROVEN_OUTBOUND_FULL_BLOCK_DOC);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists) {
      const raw = snap.data() as Record<string, unknown> | undefined;
      if (raw?.schema_version !== FULL_BLOCK_SCHEMA || !Number.isSafeInteger(raw.block)) {
        throw new Error('chain_record_proven_outbound_full_block_invalid');
      }
      return raw.block as number;
    }
    txn.set(ref, { schema_version: FULL_BLOCK_SCHEMA, block, fixed_at_ms: nowMs });
    return block;
  });
}

/** Open a bounded nonce-scanner range for one proven EOA (idempotent per range start). */
export async function openProvenOutboundRange(
  db: Firestore,
  range: {
    readonly address: string;
    readonly ownerType: ChainRecordOwnerType;
    readonly fromBlock: number;
    readonly throughBlock: number;
  },
  nowMs: number,
): Promise<boolean> {
  const address = range.address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address) || !Number.isSafeInteger(range.fromBlock) || range.fromBlock < 0
    || !Number.isSafeInteger(range.throughBlock)) {
    throw new Error('chain_record_proven_outbound_range_invalid');
  }
  if (range.throughBlock < range.fromBlock) return false;
  const ref = db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(provenOutboundRangeId(address, range.fromBlock));
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists) {
      // The same start again: extend it, never shorten or rewind it.
      const prior = parseProvenOutboundRange(snap.id, snap.data() as Record<string, unknown>);
      if (range.throughBlock > prior.through_block) {
        txn.set(ref, { through_block: range.throughBlock, done: false, updated_at_ms: nowMs }, { merge: true });
      }
      return false;
    }
    txn.set(ref, {
      schema_version: PROVEN_OUTBOUND_RANGE_SCHEMA,
      address,
      owner_type: range.ownerType,
      next_block: range.fromBlock,
      nonce: null,
      through_block: range.throughBlock,
      done: false,
      updated_at_ms: nowMs,
    });
    return true;
  });
}

/** A producer can extend a range while the nonce scanner finishes its snapshot. */
export async function refreshProvenOutboundRangeCompletion(db: Firestore, id: string, nowMs: number): Promise<void> {
  const ref = db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION).doc(id);
  await db.runTransaction(async txn => {
    const snapshot = await txn.get(ref);
    const current = parseProvenOutboundRange(id, snapshot.data() as Record<string, unknown> | undefined);
    txn.set(ref, { done: current.next_block > current.through_block, updated_at_ms: nowMs }, { merge: true });
  });
}

export function parseProvenOutboundRange(id: string, raw: Record<string, unknown> | undefined): ProvenOutboundRange {
  if (!raw || raw.schema_version !== PROVEN_OUTBOUND_RANGE_SCHEMA
    || typeof raw.address !== 'string' || !/^0x[0-9a-f]{40}$/.test(raw.address)
    || (raw.owner_type !== 'agent' && raw.owner_type !== 'human')
    || !Number.isSafeInteger(raw.next_block) || (raw.next_block as number) < 0
    || !(raw.nonce === null || (Number.isSafeInteger(raw.nonce) && (raw.nonce as number) >= 0))
    || !Number.isSafeInteger(raw.through_block) || typeof raw.done !== 'boolean'
    || !Number.isSafeInteger(raw.updated_at_ms)) {
    // A malformed range is an integrity fault, never a guess at where to resume.
    throw new Error(`chain_record_proven_outbound_range_invalid:${id}`);
  }
  return {
    id,
    address: raw.address,
    owner_type: raw.owner_type,
    next_block: raw.next_block as number,
    nonce: raw.nonce as number | null,
    through_block: raw.through_block as number,
    done: raw.done,
    updated_at_ms: raw.updated_at_ms as number,
  };
}
