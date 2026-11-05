/**
 * The three readers of the sharded pe_history indexes, driven in BOTH modes
 * (H5 close-out): deferred release, the pending-cache drain, and the
 * pending-evidence resolver's cursor sweep.
 *
 * Each reader is shown reaching rows on EVERY shard in sharded mode, and the
 * RED control shows WHY the cutover is gated on a zero-missing backfill: in
 * sharded mode a row that lacks the field is invisible to the reader, while
 * legacy mode still processes it. Constants come from the module under test.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  PE_HISTORY_INDEX_SHARD_COUNT,
  PE_HISTORY_INDEX_SHARD_FIELD,
  PE_HISTORY_INDEX_SHARD_IDS,
  enableShardedReaders,
  peHistoryIndexShard,
} from './pe-history-index-shard';

let fake: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: make } = require('./__test-helpers__/fake-firestore');
  fake = make();
  return { __esModule: true, default: { firestore: () => fake }, firestore: () => fake };
});

import { processDeferredReleaseBatch } from './deferred-release';
import { backfillPendingCachePEs } from './pending-cache-backfill';
import {
  PENDING_EVIDENCE_RESOLVER_CURSOR_COLLECTION,
  PENDING_EVIDENCE_RESOLVER_CURSOR_DOC,
  sweepPendingEvidence,
  type PendingEvidenceResolverDeps,
} from './pending-evidence-resolver';

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

function idsCoveringEveryShard(prefix: string): string[] {
  const ids: string[] = [];
  const seen = new Set<number>();
  for (let i = 0; seen.size < PE_HISTORY_INDEX_SHARD_COUNT || ids.length < 40; i += 1) {
    const id = `${prefix}-${i}`;
    ids.push(id);
    seen.add(peHistoryIndexShard(id));
    if (i > 5000) throw new Error('shard function never covered every shard');
  }
  return ids;
}

function seedRows(ids: readonly string[], status: string, options: { withShard: boolean; ageMs?: number }): void {
  ids.forEach((peId, i) => {
    fake.store.set(`pe_history/${peId}`, {
      peId,
      userId: 'user-1',
      actionType: 'send',
      peHash: 'h',
      mint_status: status,
      jurisdiction_context: 'US',
      timestamp: NOW - (options.ageMs ?? 1_000_000) + i,
      economic_snapshot: null,
      economic_snapshot_hash: null,
      ...(options.withShard ? { [PE_HISTORY_INDEX_SHARD_FIELD]: peHistoryIndexShard(peId) } : {}),
    });
  });
}

function statuses(ids: readonly string[]): Map<string, string> {
  return new Map(ids.map((id) => [id, fake.store.get(`pe_history/${id}`)?.mint_status as string]));
}

const healthyCache = { isEnabled: () => true } as unknown as RedisCache;

describe('readers in SHARDED mode reach every shard', () => {
  beforeEach(() => {
    fake.store.clear();
    fake.ops.length = 0;
  });

  it('deferred release: releases (to record-only, no snapshot) rows on every shard', async () => {
    await enableShardedReaders(fake as unknown as Firestore, { nowMs: NOW, evidence: 'test' });
    const ids = idsCoveringEveryShard('dr');
    seedRows(ids, 'deferred', { withShard: true });
    await processDeferredReleaseBatch({
      jurisdiction: 'US', daily_ceiling_percent: 100, re_attestation_required: false, activated_at: 1, active: true,
    }, ids.length);
    const after = statuses(ids);
    expect([...after.values()].every((s) => s === 'record_only')).toBe(true);
    expect(new Set(ids.map(peHistoryIndexShard)).size).toBe(PE_HISTORY_INDEX_SHARD_COUNT);
  });

  it('deferred release respects the ceiling ACROSS shards, oldest first', async () => {
    await enableShardedReaders(fake as unknown as Firestore, { nowMs: NOW, evidence: 'test' });
    const ids = idsCoveringEveryShard('dc');
    seedRows(ids, 'deferred', { withShard: true });
    await processDeferredReleaseBatch({
      jurisdiction: 'US', daily_ceiling_percent: 100, re_attestation_required: false, activated_at: 1, active: true,
    }, 5);
    const released = ids.filter((id) => fake.store.get(`pe_history/${id}`)?.mint_status === 'record_only');
    expect(released).toHaveLength(5);
    // The five oldest by timestamp, regardless of which shard they live on.
    expect(new Set(released)).toEqual(new Set(ids.slice(0, 5)));
  });

  it('RED: in sharded mode a row WITHOUT the field is invisible — the reason the cutover is gated', async () => {
    await enableShardedReaders(fake as unknown as Firestore, { nowMs: NOW, evidence: 'test' });
    seedRows(['orphan'], 'deferred', { withShard: false });
    await processDeferredReleaseBatch({
      jurisdiction: 'US', daily_ceiling_percent: 100, re_attestation_required: false, activated_at: 1, active: true,
    }, 10);
    expect(fake.store.get('pe_history/orphan')?.mint_status).toBe('deferred');

    // CONTROL: legacy mode (no marker) processes the very same row.
    fake.store.clear();
    seedRows(['orphan'], 'deferred', { withShard: false });
    await processDeferredReleaseBatch({
      jurisdiction: 'US', daily_ceiling_percent: 100, re_attestation_required: false, activated_at: 1, active: true,
    }, 10);
    expect(fake.store.get('pe_history/orphan')?.mint_status).toBe('record_only');
  });

  it('pending-cache drain: reclassifies rows on every shard, one paged drain per shard', async () => {
    await enableShardedReaders(fake as unknown as Firestore, { nowMs: NOW, evidence: 'test' });
    const ids = idsCoveringEveryShard('pc');
    seedRows(ids, 'pending_cache', { withShard: true });
    const result = await backfillPendingCachePEs(healthyCache, fake as unknown as Firestore, { now: () => NOW });
    expect(result.scanned).toBe(ids.length);
    expect(result.reclassified_record_only).toBe(ids.length);
    expect(result.pages).toBeGreaterThanOrEqual(new Set(ids.map(peHistoryIndexShard)).size);
    expect([...statuses(ids).values()].every((s) => s === 'record_only')).toBe(true);
  });

  it('pending-evidence resolver: a cursor sweep visits every shard and completes a cycle after the last', async () => {
    await enableShardedReaders(fake as unknown as Firestore, { nowMs: NOW, evidence: 'test' });
    const ids = idsCoveringEveryShard('pe');
    seedRows(ids, 'pending_evidence', { withShard: true });
    const deps: PendingEvidenceResolverDeps = {
      db: fake as unknown as PendingEvidenceResolverDeps['db'],
      verifyChainReceipt: jest.fn(async () => ({ ok: false as const, reason: 'n/a' })) as PendingEvidenceResolverDeps['verifyChainReceipt'],
      resolveActorAddress: jest.fn(async () => null) as PendingEvidenceResolverDeps['resolveActorAddress'],
    };
    // Sweep with a small page until the FIRST cycle completes. A cycle is one
    // lap over every shard, so the rows scanned by then must be exactly the
    // population — each row once — which is only true if no shard was skipped
    // and none was visited twice. A cursor that pinned to one shard, or that
    // forgot one, would scan fewer.
    let scanned = 0;
    let passes = 0;
    let cursorShards = new Set<number>();
    for (;;) {
      const result = await sweepPendingEvidence(deps, { nowMs: NOW + passes, limit: 3 });
      passes += 1;
      scanned += result.scanned;
      expect(result.cursor_advanced || result.scanned === 0).toBe(true);
      const cursor = fake.store.get(`${PENDING_EVIDENCE_RESOLVER_CURSOR_COLLECTION}/${PENDING_EVIDENCE_RESOLVER_CURSOR_DOC}`);
      if (typeof cursor?.shard === 'number') cursorShards = new Set([...cursorShards, cursor.shard]);
      if (result.cycles_completed >= 1) break;
      if (passes > ids.length + PE_HISTORY_INDEX_SHARD_COUNT + 2) throw new Error('sweep never completed a cycle');
    }
    expect(scanned).toBe(ids.length);
    expect(passes).toBeGreaterThan(PE_HISTORY_INDEX_SHARD_COUNT - 1);
    // After the lap the cursor rests on the first shard, ready for cycle two.
    const rested = fake.store.get(`${PENDING_EVIDENCE_RESOLVER_CURSOR_COLLECTION}/${PENDING_EVIDENCE_RESOLVER_CURSOR_DOC}`);
    expect(rested).toMatchObject({ shard: PE_HISTORY_INDEX_SHARD_IDS[0], last_timestamp_ms: null, last_pe_id: null, cycles_completed: 1 });
    // The cursor recorded a mid-shard position on at least one multi-page shard.
    expect(cursorShards.size).toBeGreaterThan(0);
    // Cycle two scans the same population again (nothing was resolved).
    let second = 0;
    for (;;) {
      const result = await sweepPendingEvidence(deps, { nowMs: NOW + passes, limit: 3 });
      passes += 1;
      second += result.scanned;
      if (result.cycles_completed >= 2) break;
    }
    expect(second).toBe(ids.length);
  });
});
