/**
 * anchor-recovery-worker: log scanning + retry orchestration.
 *
 * Coverage:
 *   - dry-run never calls peAnchorContract.anchorBatch
 *   - dry-run never calls pvtContract.mintFromPEs (it's not even on the mock)
 *   - missing snapshot is recorded as refused_snapshot_missing
 *   - retry metadata is incremented per attempt
 *   - already-anchored events are reported but never re-anchored
 *   - retired execute mode fails closed and never invokes anchorBatch
 *   - checkpoint advances to scanned `toBlock` after a run
 */

import { ethers } from 'ethers';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { runAnchorRecoveryWorker } from './anchor-recovery-worker';
import { computeDeterministicBatchId } from './batch-id';
import { buildMerkleTree, type MerkleLeaf } from './merkle';
import type { PVTMintBatchSnapshotDocument } from '../agent-bank/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshotForLeaves(leaves: MerkleLeaf[]): PVTMintBatchSnapshotDocument {
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
    contributor_addresses: [leaves[0].walletAddress],
    pe_points: [leaves[0].basePoints.toString()],
    pe_action_types: [ethers.keccak256(ethers.toUtf8Bytes(leaves[0].actionType))],
    epoch: 1,
    anchor_args: {
      batchId,
      merkleRoot: tree.root,
      peCount: leaves.length,
      timestamp: 1700000000000,
      epochNumber: 1,
    },
    created_at: 1700000000000,
    status: 'minted',
    mint_tx_hash: '0xmint',
  };
}

interface MockEvent {
  batchId: string;
  merkleRoot: string;
  txHash: string;
  blockNumber: number;
}

interface MockChain {
  events: MockEvent[];
  /** Map batchId → exists flag returned by peAnchor.batches(). */
  anchored: Set<string>;
}

function setupDeps(chain: MockChain, snapshots: PVTMintBatchSnapshotDocument[]): {
  db: FakeFirestore;
  pvtContract: ethers.Contract;
  peAnchorContract: ethers.Contract;
  anchorBatchMock: jest.Mock;
} {
  const db = createFakeFirestore();
  for (const s of snapshots) {
    db.store.set(`pvt_mint_batch_snapshots/${s.batch_id}`, s as unknown as Record<string, unknown>);
  }

  const provider = {
    getBlockNumber: jest.fn(async () => 1000),
    getNetwork: jest.fn(async () => ({ chainId: 8453n })),
  };

  const pvtContract = {
    runner: { provider },
    getAddress: jest.fn(async () => '0x000000000000000000000000000000000000aaaa'),
    filters: { BatchMinted: jest.fn(() => ({ topics: ['0xBatchMintedTopic'] })) },
    queryFilter: jest.fn(async (_filter: unknown, _from: number, _to: number) => {
      return chain.events.map((e) => ({
        args: { batchId: e.batchId, merkleRoot: e.merkleRoot },
        transactionHash: e.txHash,
        blockNumber: e.blockNumber,
      }));
    }),
  } as unknown as ethers.Contract;

  const anchorBatchMock = jest.fn(async (batchId: string) => {
    chain.anchored.add(batchId);
    return {
      wait: async () => ({ hash: `0xanchor_${batchId.slice(0, 8)}` }),
    };
  });

  const peAnchorContract = {
    batches: jest.fn(async (id: string) => ({
      merkleRoot: '0x0',
      peCount: 0n,
      timestamp: 0n,
      epochNumber: 0n,
      exists: chain.anchored.has(id),
    })),
    anchorBatch: anchorBatchMock,
  } as unknown as ethers.Contract;

  return { db, pvtContract, peAnchorContract, anchorBatchMock };
}

const SAMPLE_LEAVES = (peId: string, addr: string): MerkleLeaf[] => [
  {
    peId,
    walletAddress: addr,
    actionType: 'inference_session',
    timestamp: 1700000000000,
    basePoints: 1_000_000_000_000_000_000n,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('anchor-recovery-worker', () => {
  it('dry-run plans but never calls anchorBatch', async () => {
    const snap = makeSnapshotForLeaves(SAMPLE_LEAVES('pe_a', '0x1111111111111111111111111111111111111111'));
    const chain: MockChain = {
      events: [{ batchId: snap.batch_id, merkleRoot: snap.merkle_root, txHash: '0xmint', blockNumber: 950 }],
      anchored: new Set(),
    };
    const deps = setupDeps(chain, [snap]);
    const report = await runAnchorRecoveryWorker(deps as any, { fromBlock: 900, toBlock: 950 });
    expect(report.dry_run).toBe(true);
    expect(report.outcomes['planned']).toBe(1);
    expect(deps.anchorBatchMock).not.toHaveBeenCalled();
  });

  it('records refused_snapshot_missing when no snapshot exists for an event', async () => {
    const fakeBatchId = '0x' + 'aa'.repeat(32);
    const fakeRoot = '0x' + 'bb'.repeat(32);
    const chain: MockChain = {
      events: [{ batchId: fakeBatchId, merkleRoot: fakeRoot, txHash: '0xmint', blockNumber: 950 }],
      anchored: new Set(),
    };
    const deps = setupDeps(chain, []); // no snapshots
    const report = await runAnchorRecoveryWorker(deps as any, { fromBlock: 900, toBlock: 950 });
    expect(report.outcomes['refused_snapshot_missing']).toBe(1);
    expect(deps.anchorBatchMock).not.toHaveBeenCalled();
  });

  it('reports already_anchored without invoking anchorBatch', async () => {
    const snap = makeSnapshotForLeaves(SAMPLE_LEAVES('pe_b', '0x2222222222222222222222222222222222222222'));
    const chain: MockChain = {
      events: [{ batchId: snap.batch_id, merkleRoot: snap.merkle_root, txHash: '0xmint', blockNumber: 950 }],
      anchored: new Set([snap.batch_id]),
    };
    const deps = setupDeps(chain, [snap]);
    const report = await runAnchorRecoveryWorker(deps as any, { fromBlock: 900, toBlock: 950 });
    expect(report.outcomes['skipped_already_anchored']).toBe(1);
    expect(deps.anchorBatchMock).not.toHaveBeenCalled();
  });

  it('retired execute mode fails before any scan or anchor attempt', async () => {
    const snap = makeSnapshotForLeaves(SAMPLE_LEAVES('pe_c', '0x3333333333333333333333333333333333333333'));
    const chain: MockChain = {
      events: [{ batchId: snap.batch_id, merkleRoot: snap.merkle_root, txHash: '0xmint', blockNumber: 950 }],
      anchored: new Set(),
    };
    const deps = setupDeps(chain, [snap]);
    await expect(runAnchorRecoveryWorker(deps as any, {
      fromBlock: 900,
      toBlock: 950,
      execute: true,
    })).rejects.toThrow('anchor_recovery_execute_retired_use_mint_claim_recovery');
    expect(deps.anchorBatchMock).not.toHaveBeenCalled();
  });

  it('worker module never invokes mintFromPEs', async () => {
    // Static guarantee: recovery is anchor-only. The worker source must not
    // contain a mintFromPEs invocation. (Doc comments naming it are fine.)
    const fs = await import('fs');
    const path = require.resolve('./anchor-recovery-worker');
    const src = fs.readFileSync(path, 'utf8');
    // Strip block + line comments before grepping for the call.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(stripped).not.toMatch(/\.mintFromPEs\s*\(/);
    expect(stripped).not.toMatch(/mintFromPEs\s*:/); // not destructured/imported either
  });

  it('retry metadata increments on each attempt', async () => {
    const snap = makeSnapshotForLeaves(SAMPLE_LEAVES('pe_d', '0x4444444444444444444444444444444444444444'));
    const chain: MockChain = {
      events: [{ batchId: snap.batch_id, merkleRoot: snap.merkle_root, txHash: '0xmint', blockNumber: 950 }],
      anchored: new Set(),
    };
    const deps = setupDeps(chain, [snap]);

    // minRetryIntervalMs:0 disables the cooldown guardrail so the back-to-back
    // calls in this test exercise the attempts counter (not the cooldown).
    await runAnchorRecoveryWorker(deps as any, { fromBlock: 900, toBlock: 950, minRetryIntervalMs: 0 });
    await runAnchorRecoveryWorker(deps as any, { fromBlock: 900, toBlock: 950, minRetryIntervalMs: 0 });

    const retry = deps.db.store.get(`pvt_anchor_recovery_retries/${snap.batch_id}`);
    expect(retry).toBeDefined();
    expect((retry as { attempts: number }).attempts).toBe(2);
    expect((retry as { last_dry_run: boolean }).last_dry_run).toBe(true);
  });

  it('checkpoint advances to scanned toBlock', async () => {
    const snap = makeSnapshotForLeaves(SAMPLE_LEAVES('pe_e', '0x5555555555555555555555555555555555555555'));
    const chain: MockChain = {
      events: [{ batchId: snap.batch_id, merkleRoot: snap.merkle_root, txHash: '0xmint', blockNumber: 950 }],
      anchored: new Set(),
    };
    const deps = setupDeps(chain, [snap]);
    await runAnchorRecoveryWorker(deps as any, { fromBlock: 900, toBlock: 950 });

    const cp = deps.db.store.get('pvt_anchor_recovery_checkpoints/8453:0x000000000000000000000000000000000000aaaa');
    expect(cp).toBeDefined();
    expect((cp as { last_processed_block: number }).last_processed_block).toBe(950);
  });

  it('chunks queryFilter into blockChunk-sized ranges (public-RPC log-range cap)', async () => {
    // Public RPCs (mainnet.base.org, mainnet.optimism.io) reject
    // eth_getLogs ranges > 10_000 blocks with -32614. Verify the worker
    // splits the requested range into chunks no larger than blockChunk.
    const snap = makeSnapshotForLeaves(SAMPLE_LEAVES('pe_chunk', '0x9999999999999999999999999999999999999999'));
    const chain: MockChain = { events: [], anchored: new Set() };
    const deps = setupDeps(chain, [snap]);

    const calls: Array<{ from: number; to: number }> = [];
    (deps.pvtContract.queryFilter as unknown as jest.Mock).mockImplementation(
      async (_filter: unknown, from: number, to: number) => {
        calls.push({ from, to });
        return [];
      },
    );

    // Range 1000..15999 (15_000 blocks) with chunk size 5_000 → 3 calls of
    // [1000..5999], [6000..10999], [11000..15999].
    await runAnchorRecoveryWorker(deps as any, {
      fromBlock: 1000,
      toBlock: 15999,
      blockChunk: 5000,
    });

    expect(calls).toEqual([
      { from: 1000, to: 5999 },
      { from: 6000, to: 10999 },
      { from: 11000, to: 15999 },
    ]);
    // No chunk wider than blockChunk.
    for (const c of calls) {
      expect(c.to - c.from + 1).toBeLessThanOrEqual(5000);
    }
  });

  it('uses Firestore FieldValue.increment when provided', async () => {
    const snap = makeSnapshotForLeaves(SAMPLE_LEAVES('pe_f', '0x6666666666666666666666666666666666666666'));
    const chain: MockChain = {
      events: [{ batchId: snap.batch_id, merkleRoot: snap.merkle_root, txHash: '0xmint', blockNumber: 950 }],
      anchored: new Set(),
    };
    const deps = setupDeps(chain, [snap]);
    const fieldValueMock = { increment: jest.fn((n: number) => ({ __sentinel: 'increment', n })) };
    await runAnchorRecoveryWorker(
      { ...(deps as any), fieldValue: fieldValueMock as any },
      { fromBlock: 900, toBlock: 950 },
    );
    expect(fieldValueMock.increment).toHaveBeenCalledWith(1);
    const retry = deps.db.store.get(`pvt_anchor_recovery_retries/${snap.batch_id}`);
    // Sentinel survives into the merged doc - production replaces it server-side.
    expect((retry as { attempts: { __sentinel: string } }).attempts).toEqual({ __sentinel: 'increment', n: 1 });
  });
});
