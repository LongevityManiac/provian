/**
 * Daily PE Anchoring — what survives the PE meter (2026-10-03).
 *
 * The per-PE runner over `pe_history` is RETIRED (the relay stores no PE history; the meter
 * anchors accepted batches in `meter-anchor.ts`). What stays, and is pinned here:
 *  - namespace collision: a daily (and therefore a meter) anchor batch id can never equal a mint
 *    batch id (`computeDeterministicBatchId`), including the adversarial preimage-equality
 *    construction;
 *  - proofs from a STORED historical batch round-trip under the exact on-chain verifyPE rule, and
 *    a tampered batch doc refuses;
 *  - the retirement itself: the module reads no Firestore collection at all (RED control below).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import {
  DAILY_PE_ANCHOR_NAMESPACE,
  LEGACY_DAILY_PE_ANCHOR_RETIRED,
  buildProofFromBatchDoc,
  computeDailyAnchorBatchId,
  dailyAnchorBatchIdPreimage,
  utcDayBounds,
  utcDayNumber,
  type AnchorBatchMember,
  type DailyAnchorBatchDocument,
} from './daily-pe-anchor';
import * as dailyPeAnchor from './daily-pe-anchor';
import {
  buildMerkleTree,
  buildMerkleTreeFromLeafHashes,
  hashEnvelopeHashLeaf,
  verifyMerkleProof,
  type MerkleLeaf,
} from './merkle';
import { computeDeterministicBatchId } from './batch-id';

const YESTERDAY = '2026-07-06';

function sha256Hex(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex');
}

/** Independent re-implementation of the on-chain verifyPE walk (sorted pairs, 0x01 tag). */
function onChainVerifyPE(leaf: string, proof: string[], root: string): boolean {
  let computed = leaf;
  for (const el of proof) {
    computed = computed <= el
      ? ethers.keccak256(ethers.solidityPacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', computed, el]))
      : ethers.keccak256(ethers.solidityPacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', el, computed]));
  }
  return computed === root;
}

/** A stored historical batch doc over the given members, as the retired runner wrote it. */
function storedBatch(peIds: string[]): Pick<DailyAnchorBatchDocument, 'members' | 'merkle_root' | 'pe_count'> {
  const start = utcDayBounds(YESTERDAY).startMs;
  const members: AnchorBatchMember[] = peIds.map((pe_id, i) => ({ pe_id, pe_hash: sha256Hex(pe_id), timestamp: start + i }));
  const root = buildMerkleTreeFromLeafHashes(members.map((m) => hashEnvelopeHashLeaf(m.pe_hash))).root;
  return { members, merkle_root: root, pe_count: members.length };
}

// =============================================================================
// BATCH-ID NAMESPACE
// =============================================================================

describe('computeDailyAnchorBatchId — namespace separation from mint batches', () => {
  it('uses the 0xFF-tagged keccak construction over the documented preimage', () => {
    const day = '2026-07-06';
    const expected = ethers.keccak256(
      ethers.concat(['0xff', ethers.toUtf8Bytes(`${DAILY_PE_ANCHOR_NAMESPACE}:day:${day}`)]),
    );
    expect(computeDailyAnchorBatchId('day', day)).toBe(expected);
    expect(dailyAnchorBatchIdPreimage('day', day)).toBe('provian:daily-pe-anchor:v1:day:2026-07-06');
  });

  it('never equals a mint batch id — even for the adversarial preimage-equality construction', () => {
    // computeDeterministicBatchId(['provian'], 'daily-pe-anchor:v1:day:D') has
    // the UTF-8 preimage "provian:daily-pe-anchor:v1:day:D" — byte-identical
    // to the daily preimage STRING. The 0xFF tag (never a valid UTF-8 byte)
    // keeps the actual hashed bytes disjoint.
    const day = '2026-07-07';
    const adversarialMintId = computeDeterministicBatchId(['provian'], `daily-pe-anchor:v1:day:${day}`);
    expect(computeDailyAnchorBatchId('day', day)).not.toBe(adversarialMintId);

    const adversarialBackfillId = computeDeterministicBatchId(['provian'], `daily-pe-anchor:v1:backfill:${day}`);
    expect(computeDailyAnchorBatchId('backfill', day)).not.toBe(adversarialBackfillId);
  });

  it('never equals a mint batch id for realistic mint inputs', () => {
    const leaves: MerkleLeaf[] = [
      { peId: 'pe_1', walletAddress: '0x' + '11'.repeat(20), actionType: 'x402_payment', timestamp: 1, basePoints: 10n ** 18n },
      { peId: 'pe_2', walletAddress: '0x' + '22'.repeat(20), actionType: 'agent_task_completed', timestamp: 2, basePoints: 2n * 10n ** 18n },
    ];
    const realRoot = buildMerkleTree(leaves).root;
    const mintId = computeDeterministicBatchId(['pe_1', 'pe_2'], realRoot);
    for (const day of ['2026-07-05', '2026-07-06', '2026-07-07']) {
      expect(computeDailyAnchorBatchId('day', day)).not.toBe(mintId);
      expect(computeDailyAnchorBatchId('backfill', day)).not.toBe(mintId);
    }
  });

  it('separates day and backfill kinds, and distinct days', () => {
    expect(computeDailyAnchorBatchId('day', '2026-07-06')).not.toBe(computeDailyAnchorBatchId('backfill', '2026-07-06'));
    expect(computeDailyAnchorBatchId('day', '2026-07-05')).not.toBe(computeDailyAnchorBatchId('day', '2026-07-06'));
  });

  it('rejects malformed day keys', () => {
    expect(() => computeDailyAnchorBatchId('day', '2026-7-6')).toThrow();
    expect(() => computeDailyAnchorBatchId('day', '2026-13-01')).toThrow();
    expect(() => computeDailyAnchorBatchId('day', 'nonsense')).toThrow();
    expect(utcDayNumber('1970-01-02')).toBe(1);
  });
});

// =============================================================================
// PROOFS FROM A STORED HISTORICAL BATCH
// =============================================================================

describe('proofs', () => {
  it('round-trips: a stored batch proof verifies under the exact on-chain verifyPE rule', () => {
    // 3 members → padded tree (4 leaves) exercises the zero-hash sibling path.
    const batch = storedBatch(['pe_a', 'pe_b', 'pe_c']);
    for (const peId of ['pe_a', 'pe_b', 'pe_c']) {
      const inclusion = buildProofFromBatchDoc(batch, peId);
      expect(inclusion).not.toBeNull();
      expect(inclusion!.leaf_value).toBe(hashEnvelopeHashLeaf(sha256Hex(peId)));
      expect(verifyMerkleProof(inclusion!.leaf_value, inclusion!.proof, batch.merkle_root)).toBe(true);
      expect(onChainVerifyPE(inclusion!.leaf_value, inclusion!.proof, batch.merkle_root)).toBe(true);
    }
    // A wrong leaf does NOT verify.
    const bogus = hashEnvelopeHashLeaf(sha256Hex('pe_forged'));
    const real = buildProofFromBatchDoc(batch, 'pe_a')!;
    expect(verifyMerkleProof(bogus, real.proof, batch.merkle_root)).toBe(false);
  });

  it('returns null for a non-member and throws on batch-doc tampering', () => {
    const batch = storedBatch(['pe_a', 'pe_b']);
    expect(buildProofFromBatchDoc(batch, 'pe_missing')).toBeNull();
    const tampered = {
      ...batch,
      members: batch.members.map((m, i) => (i === 0 ? { ...m, pe_hash: sha256Hex('evil') } : m)),
    };
    expect(() => buildProofFromBatchDoc(tampered, 'pe_a')).toThrow(/integrity/i);
  });
});

// =============================================================================
// RETIREMENT (PE meter)
// =============================================================================

describe('the legacy per-PE anchor is retired', () => {
  const source = fs.readFileSync(path.join(__dirname, 'daily-pe-anchor.ts'), 'utf8');

  it('exports no runner and reads no Firestore collection', () => {
    const exported = dailyPeAnchor as Record<string, unknown>;
    for (const gone of ['runDailyPEAnchor', 'runPEAnchorBackfill', 'anchorPEDay']) {
      expect(exported[gone]).toBeUndefined();
    }
    expect(source).not.toMatch(/\.collection\(/);
    expect(LEGACY_DAILY_PE_ANCHOR_RETIRED.code).toBe('legacy_daily_pe_anchor_retired');
  });

  it('RED control: the source check sees a collection read when one is present', () => {
    const withRead = `${source}\nconst x = db.collection('pe_history').where('timestamp', '>=', 0);`;
    expect(withRead).toMatch(/\.collection\(/);
  });
});
