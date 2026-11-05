/**
 * The accrual projection streams what it reads in pages (H1, carried onto the PE meter).
 *
 * WHAT BROKE BEFORE. The full fold did an unbounded `.get()` over the user's ENTIRE `pe_history`
 * and held it resident. On the PE meter there is no history to read: the projection's only
 * per-act read is the live act-key tail (≤31 days), and it is paged the same way.
 *
 * "it pages" is trivially satisfiable by a broken implementation that
 * pages and drops rows, so the assertions here are on the RESULT over a
 * multi-page fixture — every row must be counted exactly once, across a page
 * boundary — and paired with a control at a size below one page proving the
 * fixture size is what exercises the boundary.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import { computeRecordSnapshot, disclosedRationalFactor, hashRecordEconomicSnapshot } from './monetary-accounting';
import { materializeProposedMonetaryPolicy } from './runtime-monetary-policy';
import { streamQuery } from './economic-projection';
import { emptyAggregateReadTrace, readEconomicAccrualProjection } from './economic-aggregate-read';
import { seedMeteredRows } from '../../meter/__test-helpers__/seed-act-keys';

const USER = 'user_paging';
const RECORDED_AT = 1_700_000_000_000;

/**
 * A REAL sealed snapshot, built the same way `economic-projection.test.ts` builds
 * its fixture. A row without one is an integrity failure that never reaches the
 * counters — so a paging test seeded with bare rows would report zero and prove
 * nothing about paging.
 */
function historyDoc(peId: string, opts: {
  userId: string;
  beneficiary?: string;
  category: string;
}): PEHistoryDocument {
  const economicSnapshot = computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId,
    economicActorId: opts.userId,
    actionType: 'coding_session',
    recordedAtMs: RECORDED_AT,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: null,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: null,
    genesisReservation: null,
  });
  return {
    peId,
    userId: opts.userId,
    actionType: 'coding_session',
    timestamp: RECORDED_AT,
    category: opts.category,
    mint_status: economicSnapshot.mintDisposition === 'eligible' ? 'eligible' : 'record_only',
    mint_disposition: economicSnapshot.mintDisposition,
    attestationDepth: 'software',
    corroboration_status: 'none',
    economic_snapshot: economicSnapshot,
    economic_snapshot_hash: hashRecordEconomicSnapshot(economicSnapshot),
    beneficiary_wallet_id: opts.beneficiary ?? null,
  } as unknown as PEHistoryDocument;
}

async function seed(db: FakeFirestore, count: number, opts: { beneficiary?: number } = {}): Promise<void> {
  const rows: PEHistoryDocument[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `pe_${String(i).padStart(6, '0')}`;
    rows.push(historyDoc(id, { userId: USER, category: 'compute' }));
  }
  for (let i = 0; i < (opts.beneficiary ?? 0); i += 1) {
    const id = `pe_ben_${String(i).padStart(6, '0')}`;
    rows.push(historyDoc(id, { userId: 'someone_else', beneficiary: USER, category: 'promise' }));
  }
  await seedMeteredRows(db, rows, NOW);
}

const NOW = 1_700_000_500_000;

async function read(db: FakeFirestore) {
  const trace = emptyAggregateReadTrace();
  const result = await readEconomicAccrualProjection(db as unknown as Firestore, USER, {
    nowMs: NOW,
    settlementProjection: { projectedAtMs: NOW, globalMintRate: disclosedRationalFactor(1n, 1n, 'test', 'block:1') },
  }, trace);
  return { ...result, tailActKeys: trace.tailActKeys };
}

/**
 * PE METER: the projection's live tail streams the identity's act keys in pages (all of them
 * share ONE timestamp here, so the `(timestamp, id)` cursor's tiebreak is what keeps a page
 * boundary from skipping or repeating a key).
 */
describe('live act-key tail paging', () => {
  it('folds every live act key when the tail spans MULTIPLE pages', async () => {
    const db = createFakeFirestore();
    await seed(db, 1_200);

    const result = await read(db);

    expect(result.totalPEs).toBe(1_200);
    expect(result.tailActKeys).toBe(1_200);
    expect(result.pesByCategory.compute).toBe(1_200);
    expect(result.integrityFailures).toBe(0);
  });

  it('folds a key EXACTLY once across the page boundary', async () => {
    const db1 = createFakeFirestore();
    await seed(db1, 500);
    expect((await read(db1)).tailActKeys).toBe(500);

    const db2 = createFakeFirestore();
    await seed(db2, 501);
    expect((await read(db2)).tailActKeys).toBe(501);
  });

  it('CONTROL — a tail smaller than one page still reads correctly', async () => {
    const db = createFakeFirestore();
    await seed(db, 3);
    expect((await read(db)).tailActKeys).toBe(3);
  });

  it('pages the beneficiary tail too, not only the contributor one', async () => {
    const db = createFakeFirestore();
    await seed(db, 600, { beneficiary: 550 });

    const result = await read(db);

    expect(result.totalPEs).toBe(1_150);
    expect(result.tailActKeys).toBe(1_150);
    expect(result.pesByCategory.compute).toBe(600);
    expect(result.pesByCategory.promise).toBe(550);
  });

  it('reports an empty identity as zero rather than throwing', async () => {
    const db = createFakeFirestore();
    const result = await read(db);
    expect(result.totalPEs).toBe(0);
    expect(result.tailActKeys).toBe(0);
  });
});

describe('streamQuery progress guard', () => {
  /**
   * A query that ALWAYS returns the same full page — the shape a dropped or
   * misapplied cursor produces. Without the guard this loops forever, and a hang
   * is the worst failure mode available: the request never returns and CI times
   * out with no signal.
   *
   * Reachable only because `streamQuery` is exported: while its sole caller was
   * this module's own correct call site, the branch was unreachable and the
   * "test" for it could only have been a comment.
   */
  function stuckQuery(pageSize: number) {
    const docs = Array.from({ length: pageSize }, (_, i) => ({
      id: `pe_${i}`, data: () => ({}),
    }));
    const q: Record<string, unknown> = {};
    q.orderBy = () => q;
    q.limit = () => q;
    q.startAfter = () => q;           // the defect: the cursor changes nothing
    q.get = async () => ({ empty: false, size: docs.length, docs });
    return q;
  }

  it('THROWS on a non-advancing cursor instead of looping forever', async () => {
    let seen = 0;
    await expect(
      streamQuery(stuckQuery(4) as never, () => { seen += 1; }, 4),
    ).rejects.toThrow('stream_query_cursor_not_advancing');
    // It reached the second page before refusing — it does not give up on page
    // one, which would break every legitimate multi-page walk.
    expect(seen).toBe(8);
  });

  it('CONTROL — an ADVANCING query of the same shape completes normally', () => {
    // Without this, the case above would pass against an implementation that
    // threw on every paged walk.
    const pages = [
      [{ id: 'a', data: () => ({}) }, { id: 'b', data: () => ({}) }],
      [{ id: 'c', data: () => ({}) }],
    ];
    let call = 0;
    const q: Record<string, unknown> = {};
    q.orderBy = () => q;
    q.limit = () => q;
    q.startAfter = () => q;
    q.get = async () => {
      const docs = pages[call] ?? [];
      call += 1;
      return { empty: docs.length === 0, size: docs.length, docs };
    };

    const ids: string[] = [];
    return streamQuery(q as never, (d) => { ids.push(d.id); }, 2)
      .then(() => expect(ids).toEqual(['a', 'b', 'c']));
  });
});
