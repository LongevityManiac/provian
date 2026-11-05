/**
 * anchor-recovery: snapshot validation + retry-plan generation.
 *
 * Coverage:
 *   - missing snapshot refuses recovery
 *   - root mismatch refuses recovery
 *   - batchId mismatch refuses recovery
 *   - already anchored exits cleanly with status 'already_anchored'
 *   - valid unanchored batch produces ready_to_anchor + retry plan
 *   - never produces a mintFromPEs plan (only anchorBatch args)
 */

import { ethers } from 'ethers';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  validateAnchorRecovery,
  recomputeMerkleRoot,
  recomputeBatchId,
  type AnchorRecoveryDeps,
} from './anchor-recovery';
import { computeDeterministicBatchId } from './batch-id';
import { buildMerkleTree, type MerkleLeaf } from './merkle';
import type { PVTMintBatchSnapshotDocument } from '../agent-bank/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLeaves(): MerkleLeaf[] {
  return [
    {
      peId: 'pe_1',
      walletAddress: '0x1111111111111111111111111111111111111111',
      actionType: 'inference_session',
      timestamp: 1700000000000,
      basePoints: 1_000_000_000_000_000_000n,
    },
    {
      peId: 'pe_2',
      walletAddress: '0x2222222222222222222222222222222222222222',
      actionType: 'coding_session',
      timestamp: 1700000010000,
      basePoints: 2_000_000_000_000_000_000n,
    },
  ];
}

function makeSnapshot(overrides: Partial<PVTMintBatchSnapshotDocument> = {}): PVTMintBatchSnapshotDocument {
  const leaves = makeLeaves();
  const tree = buildMerkleTree(leaves);
  const peIds = leaves.map((l) => l.peId);
  const batchId = computeDeterministicBatchId(peIds, tree.root);
  return {
    batch_id: batchId,
    chain_id: 8453,
    pvt_contract_address: '0x000000000000000000000000000000000000aaaa',
    pe_anchor_contract_address: '0x000000000000000000000000000000000000bbbb',
    merkle_root: tree.root,
    sorted_pe_ids: [...peIds].sort(),
    leaves: leaves.map((l) => ({
      peId: l.peId,
      walletAddress: l.walletAddress,
      actionType: l.actionType,
      timestamp: l.timestamp,
      basePoints: l.basePoints.toString(),
    })),
    contributor_addresses: ['0x1111111111111111111111111111111111111111'],
    pe_points: ['3000000000000000000'],
    pe_action_types: [ethers.keccak256(ethers.toUtf8Bytes('inference_session'))],
    epoch: 7,
    anchor_args: {
      batchId,
      merkleRoot: tree.root,
      peCount: leaves.length,
      timestamp: 1700000020000,
      epochNumber: 7,
    },
    created_at: 1700000020000,
    status: 'minted',
    mint_tx_hash: '0xabc',
    ...overrides,
  };
}

interface AnchorMockOpts {
  exists: boolean;
  /** When true, simulate ethers tuple-style return value. */
  asTuple?: boolean;
}

function makeAnchorContract(opts: AnchorMockOpts): ethers.Contract {
  const batches = jest.fn(async () => {
    if (opts.asTuple) {
      return ['0x0', 0n, 0n, 0n, opts.exists];
    }
    return { merkleRoot: '0x0', peCount: 0n, timestamp: 0n, epochNumber: 0n, exists: opts.exists };
  });
  return { batches } as unknown as ethers.Contract;
}

function makeDeps(snapshot: PVTMintBatchSnapshotDocument | null, anchorOpts: AnchorMockOpts): AnchorRecoveryDeps {
  const db = createFakeFirestore();
  if (snapshot) {
    db.store.set(`pvt_mint_batch_snapshots/${snapshot.batch_id}`, snapshot as unknown as Record<string, unknown>);
  }
  return {
    db: db as unknown as AnchorRecoveryDeps['db'],
    peAnchorContract: makeAnchorContract(anchorOpts),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('anchor-recovery: pure helpers', () => {
  it('recomputeMerkleRoot reproduces the merkle root from snapshot leaves', () => {
    const snap = makeSnapshot();
    expect(recomputeMerkleRoot(snap)).toBe(snap.merkle_root);
  });

  it('recomputeBatchId reproduces the deterministic batchId', () => {
    const snap = makeSnapshot();
    expect(recomputeBatchId(snap)).toBe(snap.batch_id);
  });
});

describe('anchor-recovery: validateAnchorRecovery', () => {
  it('refuses when snapshot is missing', async () => {
    const snap = makeSnapshot();
    const deps = makeDeps(null, { exists: false });
    const res = await validateAnchorRecovery(deps, {
      batchId: snap.batch_id,
      merkleRoot: snap.merkle_root,
    });
    expect(res.status).toBe('snapshot_missing');
    expect(res.retryPlan).toBeUndefined();
    expect(res.detail).toMatch(/no snapshot/);
  });

  it('refuses when event merkleRoot disagrees with recomputed root', async () => {
    const snap = makeSnapshot();
    const deps = makeDeps(snap, { exists: false });
    const res = await validateAnchorRecovery(deps, {
      batchId: snap.batch_id,
      merkleRoot: '0xdeadbeef' + '0'.repeat(56),
    });
    expect(res.status).toBe('merkle_root_mismatch');
    expect(res.retryPlan).toBeUndefined();
  });

  it('refuses when event batchId disagrees with deterministic recomputation', async () => {
    const snap = makeSnapshot();
    // Tamper with sorted_pe_ids in the stored snapshot so recomputeBatchId
    // diverges from the snapshot.batch_id we hand back to the validator.
    const tampered = { ...snap, sorted_pe_ids: ['pe_1', 'pe_2', 'pe_3'] };
    const deps = makeDeps(tampered, { exists: false });
    const res = await validateAnchorRecovery(deps, {
      batchId: snap.batch_id,
      merkleRoot: snap.merkle_root,
    });
    expect(res.status).toBe('batch_id_mismatch');
    expect(res.retryPlan).toBeUndefined();
  });

  it('returns already_anchored when PEAnchor reports exists=true (struct)', async () => {
    const snap = makeSnapshot();
    const deps = makeDeps(snap, { exists: true });
    const res = await validateAnchorRecovery(deps, {
      batchId: snap.batch_id,
      merkleRoot: snap.merkle_root,
    });
    expect(res.status).toBe('already_anchored');
    expect(res.retryPlan).toBeUndefined();
  });

  it('returns already_anchored when PEAnchor reports exists=true (tuple)', async () => {
    const snap = makeSnapshot();
    const deps = makeDeps(snap, { exists: true, asTuple: true });
    const res = await validateAnchorRecovery(deps, {
      batchId: snap.batch_id,
      merkleRoot: snap.merkle_root,
    });
    expect(res.status).toBe('already_anchored');
  });

  it('returns ready_to_anchor + retry plan for valid unanchored batch', async () => {
    const snap = makeSnapshot();
    const deps = makeDeps(snap, { exists: false });
    const res = await validateAnchorRecovery(deps, {
      batchId: snap.batch_id,
      merkleRoot: snap.merkle_root,
    });
    expect(res.status).toBe('ready_to_anchor');
    expect(res.retryPlan).toEqual(snap.anchor_args);
  });

  it('retry plan never includes mintFromPEs inputs (recovery is anchor-only)', async () => {
    const snap = makeSnapshot();
    const deps = makeDeps(snap, { exists: false });
    const res = await validateAnchorRecovery(deps, {
      batchId: snap.batch_id,
      merkleRoot: snap.merkle_root,
    });
    expect(res.retryPlan).toBeDefined();
    const planKeys = Object.keys(res.retryPlan!);
    // Mint inputs that must NOT be present in the plan.
    expect(planKeys).not.toContain('contributors');
    expect(planKeys).not.toContain('contributor_addresses');
    expect(planKeys).not.toContain('pePoints');
    expect(planKeys).not.toContain('pe_action_types');
    // Anchor inputs that MUST be present.
    expect(planKeys.sort()).toEqual(['batchId', 'epochNumber', 'merkleRoot', 'peCount', 'timestamp']);
  });
});
