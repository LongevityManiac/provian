/**
 * Page positioning + the has-more probe (M4).
 *
 * These cover the decision the three `server.ts` paged reads make. That module
 * cannot be route-tested (nothing imports it — constructing it needs a live
 * Firestore and Redis), which is exactly why the decision was extracted here
 * instead of inlined three times behind a source-scanning test.
 *
 * shape check: the interesting claim is "cursor SUPERSEDES offset", and a
 * suite that only tested cursor-alone and offset-alone would pass against an
 * implementation that applied BOTH. The both-supplied case is therefore asserted
 * directly, on the recorded call log rather than on a return value.
 */

import { applyKeysetPage, splitProbePage, type PageableQuery } from './apply-keyset-page';

type Call = { readonly method: 'startAfter' | 'offset'; readonly args: readonly unknown[] };

/** Records what was applied, and returns itself so the calls chain. */
class FakeQuery implements PageableQuery<FakeQuery> {
  readonly calls: Call[] = [];

  startAfter(...values: unknown[]): FakeQuery {
    this.calls.push({ method: 'startAfter', args: values });
    return this;
  }

  offset(n: number): FakeQuery {
    this.calls.push({ method: 'offset', args: [n] });
    return this;
  }
}

describe('applyKeysetPage', () => {
  it('seeks with BOTH cursor components when a cursor is supplied', () => {
    const q = new FakeQuery();
    const out = applyKeysetPage(q, { sortValue: 1700, documentId: 'pe_7' }, 0);

    expect(out.position).toBe('cursor');
    expect(q.calls).toEqual([{ method: 'startAfter', args: [1700, 'pe_7'] }]);
  });

  it('skips with offset when there is no cursor', () => {
    const q = new FakeQuery();
    const out = applyKeysetPage(q, null, 40);

    expect(out.position).toBe('offset');
    expect(q.calls).toEqual([{ method: 'offset', args: [40] }]);
  });

  it('CURSOR SUPERSEDES OFFSET — both supplied applies the seek and NOT the skip', () => {
    // The load-bearing case. Applying both would seek past the cursor and then
    // skip 40 more rows, silently dropping a page. Asserted on the call log, so
    // an implementation that applied both fails here even though it would return
    // a perfectly good query object.
    const q = new FakeQuery();
    const out = applyKeysetPage(q, { sortValue: 1700, documentId: 'pe_7' }, 40);

    expect(out.position).toBe('cursor');
    expect(q.calls).toEqual([{ method: 'startAfter', args: [1700, 'pe_7'] }]);
    expect(q.calls.some((c) => c.method === 'offset')).toBe(false);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional below one', 0.4],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('treats a %s offset as "start" and applies nothing', (_label, offset) => {
    // Query-string values; the legacy endpoints have always coerced them, so
    // refusing would break callers that send `offset=0`.
    const q = new FakeQuery();
    const out = applyKeysetPage(q, null, offset as number);

    expect(out.position).toBe('start');
    expect(q.calls).toEqual([]);
  });

  it('CONTROL — a positive offset on the same fixture DOES apply', () => {
    // Without this, the block above would pass against an implementation that
    // never applied an offset at all.
    const q = new FakeQuery();
    expect(applyKeysetPage(q, null, 1).position).toBe('offset');
    expect(q.calls).toEqual([{ method: 'offset', args: [1] }]);
  });

  it('floors a fractional offset rather than passing it through', () => {
    const q = new FakeQuery();
    applyKeysetPage(q, null, 12.9);
    expect(q.calls).toEqual([{ method: 'offset', args: [12] }]);
  });
});

describe('splitProbePage', () => {
  it('reports more and drops the probe row when the query over-returned', () => {
    const { pageDocs, hasMore } = splitProbePage(['a', 'b', 'c', 'd'], 3);
    expect(hasMore).toBe(true);
    expect(pageDocs).toEqual(['a', 'b', 'c']);
  });

  it('reports no more and keeps every row on a short page', () => {
    const { pageDocs, hasMore } = splitProbePage(['a', 'b'], 3);
    expect(hasMore).toBe(false);
    expect(pageDocs).toEqual(['a', 'b']);
  });

  it('reports no more on an EXACTLY full page — the off-by-one that fabricates a next page', () => {
    // `docs.length === limit` means the probe row was not returned, so there is
    // nothing after this page. A `>=` here would hand out a cursor to an empty
    // page forever.
    const { pageDocs, hasMore } = splitProbePage(['a', 'b', 'c'], 3);
    expect(hasMore).toBe(false);
    expect(pageDocs).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty result', () => {
    const { pageDocs, hasMore } = splitProbePage([], 10);
    expect(hasMore).toBe(false);
    expect(pageDocs).toEqual([]);
  });
});
