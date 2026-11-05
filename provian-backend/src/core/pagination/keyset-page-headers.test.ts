/**
 * Paging headers for the bare-ARRAY endpoints (M4).
 *
 * `/v1/provenance-envelopes` and `/v1/provenance-envelopes/summaries` answer with
 * a top-level array that the shipped app consumes, so the cursor cannot go in the
 * body. These assert the header contract and — the case that matters — that an
 * unencodable last row degrades to "no cursor, but has_more is still true"
 * rather than throwing, which would 500 a request that previously succeeded.
 */

import {
  HAS_MORE_HEADER,
  NEXT_CURSOR_HEADER,
  setKeysetPageHeaders,
  type KeysetPageDoc,
} from './keyset-page-headers';
import { decodeKeysetCursor } from './keyset-cursor';

class FakeRes {
  readonly headers = new Map<string, string>();

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

function doc(id: string, data: Record<string, unknown>): KeysetPageDoc {
  return { id, data: () => data };
}

describe('setKeysetPageHeaders', () => {
  it('stamps a cursor naming the LAST row of the page when more rows exist', () => {
    const res = new FakeRes();
    const page = [doc('pe_1', { timestamp: 10 }), doc('pe_2', { timestamp: 20 })];

    setKeysetPageHeaders(res, page, true, 'timestamp');

    expect(res.headers.get(HAS_MORE_HEADER)).toBe('true');
    const decoded = decodeKeysetCursor(res.headers.get(NEXT_CURSOR_HEADER));
    expect(decoded).toEqual({ sortValue: 20, documentId: 'pe_2' });
  });

  it('reads the sort field it is TOLD to, not a hardcoded one', () => {
    // The two endpoints sort on different fields (`created_at` vs `timestamp`);
    // a cursor built from the wrong field seeks somewhere else entirely.
    const res = new FakeRes();
    setKeysetPageHeaders(res, [doc('pe_1', { created_at: 99, timestamp: 5 })], true, 'created_at');
    expect(decodeKeysetCursor(res.headers.get(NEXT_CURSOR_HEADER))?.sortValue).toBe(99);
  });

  it('stamps no cursor when the walk is complete', () => {
    const res = new FakeRes();
    setKeysetPageHeaders(res, [doc('pe_1', { timestamp: 10 })], false, 'timestamp');

    expect(res.headers.get(HAS_MORE_HEADER)).toBe('false');
    expect(res.headers.has(NEXT_CURSOR_HEADER)).toBe(false);
  });

  it('stamps no cursor on an empty page', () => {
    const res = new FakeRes();
    setKeysetPageHeaders(res, [], true, 'timestamp');

    expect(res.headers.get(HAS_MORE_HEADER)).toBe('true');
    expect(res.headers.has(NEXT_CURSOR_HEADER)).toBe(false);
  });

  it('does NOT throw on an unencodable last row — it degrades to no cursor', () => {
    // A legacy row with a missing/garbage sort value must not 500 a request that
    // worked before this change. `has_more` still reports the truth, so the pair
    // is an honest "more exists, walk cannot continue" — never a silent
    // truncation dressed up as a complete result.
    const errors: unknown[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
    try {
      for (const bad of [undefined, null, 'not-a-number', Number.NaN, -1, 1.5]) {
        const res = new FakeRes();
        expect(() => setKeysetPageHeaders(res, [doc('pe_bad', { timestamp: bad })], true, 'timestamp'))
          .not.toThrow();
        expect(res.headers.get(HAS_MORE_HEADER)).toBe('true');
        expect(res.headers.has(NEXT_CURSOR_HEADER)).toBe(false);
      }
    } finally {
      spy.mockRestore();
    }
    // Non-vacuous: every one of the six really did take the failure path.
    expect(errors).toHaveLength(6);
  });

  it('CONTROL — a well-formed row on the same path DOES produce a cursor', () => {
    // Without this, the case above would pass against an implementation that
    // never stamped a cursor at all.
    const res = new FakeRes();
    setKeysetPageHeaders(res, [doc('pe_ok', { timestamp: 7 })], true, 'timestamp');
    expect(res.headers.has(NEXT_CURSOR_HEADER)).toBe(true);
  });
});
