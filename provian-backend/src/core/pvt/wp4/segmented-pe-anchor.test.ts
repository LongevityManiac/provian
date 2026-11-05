/**
 * settlement runtime — segmented daily anchoring tests (plan §settlement runtime item 7 + acceptance 5:
 * "more than 5,000 same-day PEs with proof generation and verification").
 */

import { createHash } from 'crypto';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import { computeDailyAnchorBatchId } from '../daily-pe-anchor';
import {
  ANCHOR_DAYS_COLLECTION,
  ANCHOR_SEGMENTS_COLLECTION,
  SEGMENT_MAX_MEMBERS,
  anchorSegmentedDay,
  buildSegmentedProof,
  computeAggregateBatchId,
  computeSegmentBatchId,
  planSegmentedDay,
  reconcileSegmentedDay,
  verifySegmentedProof,
  type AnchorDayDoc,
  type AnchorSegmentDoc,
  type PEAnchorChainAdapter,
  type SegmentMember,
  type SegmentedAnchorDb,
} from './segmented-pe-anchor';

const DAY = '2026-07-20';

function member(n: number): SegmentMember {
  return {
    pe_id: `pe-${String(n).padStart(6, '0')}`,
    pe_hash: createHash('sha256').update(`envelope-${n}`).digest('hex'),
    timestamp: 1_700_000_000_000 + n,
  };
}

function members(count: number): SegmentMember[] {
  return Array.from({ length: count }, (_, i) => member(i));
}

class FakeAnchorChain implements PEAnchorChainAdapter {
  anchoredRoots = new Map<string, string>();
  anchorCalls = 0;
  failOnCall: number | null = null;

  async isAnchored(batchId: string): Promise<boolean> {
    return this.anchoredRoots.has(batchId);
  }

  async readRoot(batchId: string): Promise<string | null> {
    return this.anchoredRoots.get(batchId) ?? null;
  }

  async anchor(args: { batchId: string; merkleRoot: string }): Promise<{ txHash: string }> {
    this.anchorCalls += 1;
    if (this.failOnCall !== null && this.anchorCalls === this.failOnCall) {
      throw new Error('scripted anchor failure');
    }
    if (this.anchoredRoots.has(args.batchId)) throw new Error('BatchAlreadyAnchored');
    this.anchoredRoots.set(args.batchId, args.merkleRoot);
    return { txHash: `0xtx${this.anchorCalls}` };
  }
}

describe('deterministic partition planning', () => {
  it('splits >5,000 members into bounded segments under the default size', () => {
    const plan = planSegmentedDay(DAY, members(5_001));
    expect(plan.segment_count).toBe(3);
    expect(plan.segments.map((s) => s.members.length)).toEqual([2_500, 2_500, 1]);
    expect(plan.segments.map((s) => [s.start_index, s.end_index])).toEqual([
      [0, 2_500], [2_500, 5_000], [5_000, 5_001],
    ]);
    expect(plan.pe_count).toBe(5_001);
    // Deterministic: replanning the same set yields identical roots and ids.
    const replan = planSegmentedDay(DAY, [...members(5_001)].reverse());
    expect(replan.aggregate_root).toBe(plan.aggregate_root);
    expect(replan.segments.map((s) => s.merkle_root))
      .toEqual(plan.segments.map((s) => s.merkle_root));
  });

  it('orders members by the normative (timestamp, pe_id) rule globally', () => {
    const shuffled = [member(3), member(1), member(2), member(0)];
    const plan = planSegmentedDay(DAY, shuffled, 2);
    expect(plan.segments[0].members.map((m) => m.pe_id)).toEqual(['pe-000000', 'pe-000001']);
    expect(plan.segments[1].members.map((m) => m.pe_id)).toEqual(['pe-000002', 'pe-000003']);
  });

  it('rejects malformed envelope hashes and duplicate PE ids outright', () => {
    expect(() => planSegmentedDay(DAY, [{ ...member(1), pe_hash: 'nope' }]))
      .toThrow('malformed envelope hash');
    expect(() => planSegmentedDay(DAY, [member(1), member(1)])).toThrow('duplicate pe_id');
    expect(() => planSegmentedDay(DAY, [])).toThrow('empty membership');
  });

  it('binds the partition shape into every batch id, disjoint from the v1 namespace', () => {
    const twoSegments = computeSegmentBatchId(DAY, 0, 2);
    const threeSegments = computeSegmentBatchId(DAY, 0, 3);
    expect(twoSegments).not.toBe(threeSegments);
    expect(computeAggregateBatchId(DAY, 2)).not.toBe(computeAggregateBatchId(DAY, 3));
    // The legacy single-root id for the same day lives in a different space.
    expect(computeDailyAnchorBatchId('day', DAY)).not.toBe(computeAggregateBatchId(DAY, 1));
    expect(() => computeSegmentBatchId(DAY, 3, 3)).toThrow('Invalid segment coordinates');
  });
});

describe('per-segment and aggregate reconciliation', () => {
  function docsFromPlan(size = 100, count = 250): { dayDoc: AnchorDayDoc; segmentDocs: AnchorSegmentDoc[] } {
    const plan = planSegmentedDay(DAY, members(count), size);
    const dayDoc: AnchorDayDoc = {
      schema_version: 'pe-daily-anchor-day/v1',
      namespace: 'provian:daily-pe-anchor:v2',
      day: DAY,
      pe_count: plan.pe_count,
      segment_count: plan.segment_count,
      segment_size: plan.segment_size,
      segment_roots: plan.segments.map((s) => s.merkle_root),
      segment_batch_ids: plan.segments.map((s) => s.batch_id),
      aggregate_root: plan.aggregate_root,
      aggregate_batch_id: plan.aggregate_batch_id,
      aggregate_leaf_rule: 'x',
      status: 'anchored',
      aggregate_anchor_tx_hash: '0xtx',
      created_at: 1,
      anchored_at: 2,
    };
    const segmentDocs: AnchorSegmentDoc[] = plan.segments.map((s) => ({
      schema_version: 'pe-daily-anchor-segment/v1',
      namespace: 'provian:daily-pe-anchor:v2',
      day: DAY,
      segment_index: s.segment_index,
      segment_count: plan.segment_count,
      batch_id: s.batch_id,
      batch_id_preimage: 'x',
      start_index: s.start_index,
      end_index: s.end_index,
      pe_count: s.members.length,
      merkle_root: s.merkle_root,
      leaf_rule: 'x',
      leaf_ordering: 'x',
      members: s.members,
      status: 'anchored',
      anchor_tx_hash: '0xtx',
      created_at: 1,
      anchored_at: 2,
    }));
    return { dayDoc, segmentDocs };
  }

  it('passes for an exact partition', () => {
    const { dayDoc, segmentDocs } = docsFromPlan();
    const verdict = reconcileSegmentedDay(dayDoc, segmentDocs);
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('names a gap, an overlap, and a missing segment', () => {
    const base = docsFromPlan();
    const gap = reconcileSegmentedDay(base.dayDoc, base.segmentDocs.map((s, i) => (i === 1
      ? { ...s, start_index: s.start_index + 1 } : s)));
    expect(gap.ok).toBe(false);
    expect(gap.violations.join(';')).toContain('gap or overlap');

    const missing = reconcileSegmentedDay(base.dayDoc, base.segmentDocs.slice(0, -1));
    expect(missing.ok).toBe(false);
    expect(missing.violations.join(';')).toContain('!= day segment_count');
  });

  it('catches a tampered member (segment root) and a tampered aggregate', () => {
    const base = docsFromPlan();
    const tamperedMember = reconcileSegmentedDay(base.dayDoc, base.segmentDocs.map((s, i) => (i === 0
      ? {
          ...s,
          members: s.members.map((m, j) => (j === 0
            ? { ...m, pe_hash: createHash('sha256').update('evil').digest('hex') } : m)),
        }
      : s)));
    expect(tamperedMember.ok).toBe(false);
    expect(tamperedMember.violations.join(';')).toContain('rebuilt root');

    const tamperedAggregate = reconcileSegmentedDay(
      { ...base.dayDoc, aggregate_root: `0x${'ab'.repeat(32)}` },
      base.segmentDocs,
    );
    expect(tamperedAggregate.ok).toBe(false);
    expect(tamperedAggregate.violations.join(';')).toContain('rebuilt aggregate root');
  });

  it('proves and verifies inclusion across segments (>5,000-PE day)', () => {
    const plan = planSegmentedDay(DAY, members(5_001));
    const { dayDoc, segmentDocs } = (() => {
      const dayDoc: AnchorDayDoc = {
        schema_version: 'pe-daily-anchor-day/v1',
        namespace: 'provian:daily-pe-anchor:v2',
        day: DAY,
        pe_count: plan.pe_count,
        segment_count: plan.segment_count,
        segment_size: plan.segment_size,
        segment_roots: plan.segments.map((s) => s.merkle_root),
        segment_batch_ids: plan.segments.map((s) => s.batch_id),
        aggregate_root: plan.aggregate_root,
        aggregate_batch_id: plan.aggregate_batch_id,
        aggregate_leaf_rule: 'x',
        status: 'anchored',
        aggregate_anchor_tx_hash: null,
        created_at: 1,
        anchored_at: null,
      };
      const segmentDocs = plan.segments.map((s) => ({
        schema_version: 'pe-daily-anchor-segment/v1',
        namespace: 'provian:daily-pe-anchor:v2',
        day: DAY,
        segment_index: s.segment_index,
        segment_count: plan.segment_count,
        batch_id: s.batch_id,
        batch_id_preimage: 'x',
        start_index: s.start_index,
        end_index: s.end_index,
        pe_count: s.members.length,
        merkle_root: s.merkle_root,
        leaf_rule: 'x',
        leaf_ordering: 'x',
        members: s.members,
        status: 'anchored',
        anchor_tx_hash: null,
        created_at: 1,
        anchored_at: null,
      })) as AnchorSegmentDoc[];
      return { dayDoc, segmentDocs };
    })();

    // A member deep in the SECOND segment (global index 2,500 + 1,234).
    const target = segmentDocs[1].members[1_234];
    const proof = buildSegmentedProof(dayDoc, segmentDocs[1], target.pe_id);
    expect(proof).not.toBeNull();
    expect(proof!.global_index).toBe(SEGMENT_MAX_MEMBERS + 1_234);
    expect(proof!.segment_index).toBe(1);
    expect(verifySegmentedProof(proof!)).toBe(true);

    // Tampering with any level fails verification.
    expect(verifySegmentedProof({ ...proof!, leaf_value: `0x${'11'.repeat(32)}` })).toBe(false);
    expect(verifySegmentedProof({ ...proof!, segment_root: `0x${'22'.repeat(32)}` })).toBe(false);

    // A PE that is not in the segment yields null, never a fabricated proof.
    expect(buildSegmentedProof(dayDoc, segmentDocs[1], 'pe-does-not-exist')).toBeNull();
  });
});

describe('anchoring (docs before transactions, idempotent, crash-resumable)', () => {
  it('persists every doc before anchoring and finishes a crashed run without re-anchoring', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as SegmentedAnchorDb;
    const chain = new FakeAnchorChain();
    const plan = planSegmentedDay(DAY, members(250), 100); // 3 segments + aggregate
    let t = 1_000;
    const deps = { db, chain, now: () => (t += 1) };

    // Crash on the SECOND segment anchor transaction.
    chain.failOnCall = 2;
    await expect(anchorSegmentedDay(deps, plan, 20_600, 1_800_000_000_000))
      .rejects.toThrow('scripted anchor failure');

    // Every segment doc + the day doc were persisted BEFORE any transaction.
    const segmentKeys = [...fake.store.keys()].filter((k) => k.startsWith(`${ANCHOR_SEGMENTS_COLLECTION}/`));
    expect(segmentKeys).toHaveLength(3);
    expect([...fake.store.keys()].filter((k) => k.startsWith(`${ANCHOR_DAYS_COLLECTION}/`))).toHaveLength(1);
    expect(chain.anchoredRoots.size).toBe(1); // only segment 0 landed

    // Resume: finishes the remaining anchors, re-sends nothing for segment 0.
    chain.failOnCall = null;
    const result = await anchorSegmentedDay(deps, plan, 20_600, 1_800_000_000_000);
    expect(result.segments_already_anchored).toBe(1);
    expect(result.segments_anchored).toBe(2);
    expect(result.aggregate_anchored).toBe(true);
    expect(chain.anchoredRoots.size).toBe(4); // 3 segments + aggregate

    // Fully idempotent second pass: zero new transactions.
    const callsBefore = chain.anchorCalls;
    const repeat = await anchorSegmentedDay(deps, plan, 20_600, 1_800_000_000_000);
    expect(repeat.segments_anchored).toBe(0);
    expect(repeat.aggregate_anchored).toBe(false);
    expect(repeat.segments_already_anchored).toBe(3);
    expect(repeat.aggregate_already_anchored).toBe(true);
    expect(chain.anchorCalls).toBe(callsBefore);
  });

  it('refuses to overwrite a stored doc or accept a divergent on-chain root', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as SegmentedAnchorDb;
    const chain = new FakeAnchorChain();
    const plan = planSegmentedDay(DAY, members(50), 25);
    let t = 1_000;
    const deps = { db, chain, now: () => (t += 1) };
    await anchorSegmentedDay(deps, plan, 20_600, 1_800_000_000_000);

    // A DIFFERENT membership for the same day/segment-shape must refuse.
    const divergent = planSegmentedDay(DAY, members(50).map((m, i) => (i === 0
      ? { ...m, pe_hash: createHash('sha256').update('other').digest('hex') } : m)), 25);
    await expect(anchorSegmentedDay(deps, divergent, 20_600, 1_800_000_000_000))
      .rejects.toThrow('refusing to overwrite');

    // A divergent on-chain root (same id, different root) is a hard error.
    chain.anchoredRoots.set(plan.segments[0].batch_id, `0x${'99'.repeat(32)}`);
    fake.store.clear();
    await expect(anchorSegmentedDay(deps, plan, 20_600, 1_800_000_000_000))
      .rejects.toThrow('!= planned');
  });

  it(' takeoverUnanchored: replaces UNANCHORED crash debris, never an anchored partition', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as SegmentedAnchorDb;
    const chain = new FakeAnchorChain();
    let t = 1_000;
    const deps = { db, chain, now: () => (t += 1) };

    // A crashed persist pass left docs for a stale membership; NOTHING anchored.
    const stale = planSegmentedDay(DAY, members(50), 25);
    chain.failOnCall = 1;
    await expect(anchorSegmentedDay(deps, stale, 20_600, 1_800_000_000_000))
      .rejects.toThrow('scripted anchor failure');
    chain.failOnCall = null;
    expect(chain.anchoredRoots.size).toBe(0);

    // Membership drifted before the retry (one member's hash differs), same
    // segment shape — so the fresh plan collides with the stale docs' ids.
    // Without takeover the stale day doc still refuses (default is unchanged).
    const freshSameShape = planSegmentedDay(DAY, members(50).map((m, i) => (i === 0
      ? { ...m, pe_hash: createHash('sha256').update('drifted').digest('hex') } : m)), 25);
    await expect(anchorSegmentedDay(deps, freshSameShape, 20_600, 1_800_000_000_000))
      .rejects.toThrow('refusing to overwrite');

    // With takeover, the unanchored debris is replaced and the day completes.
    const result = await anchorSegmentedDay(
      deps, freshSameShape, 20_600, 1_800_000_000_000, { takeoverUnanchored: true },
    );
    expect(result.segments_anchored).toBe(2);
    expect(result.aggregate_anchored).toBe(true);
    const dayKey = [...fake.store.keys()].find((k) => k.startsWith(`${ANCHOR_DAYS_COLLECTION}/`))!;
    expect((fake.store.get(dayKey) as unknown as AnchorDayDoc).aggregate_root)
      .toBe(freshSameShape.aggregate_root);
  });

  it(' NEGATIVE CONTROL: takeoverUnanchored still refuses when the stored partition is anchored', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as SegmentedAnchorDb;
    const chain = new FakeAnchorChain();
    let t = 1_000;
    const deps = { db, chain, now: () => (t += 1) };

    const anchored = planSegmentedDay(DAY, members(50), 25);
    await anchorSegmentedDay(deps, anchored, 20_600, 1_800_000_000_000);

    const divergent = planSegmentedDay(DAY, members(50).map((m, i) => (i === 0
      ? { ...m, pe_hash: createHash('sha256').update('attacker').digest('hex') } : m)), 25);
    await expect(anchorSegmentedDay(
      deps, divergent, 20_600, 1_800_000_000_000, { takeoverUnanchored: true },
    )).rejects.toThrow('refusing to overwrite');
    // The anchored partition's docs are untouched.
    const dayKey = [...fake.store.keys()].find((k) => k.startsWith(`${ANCHOR_DAYS_COLLECTION}/`))!;
    expect((fake.store.get(dayKey) as unknown as AnchorDayDoc).aggregate_root)
      .toBe(anchored.aggregate_root);
  });
});
