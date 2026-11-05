/**
 * The one place that decides HOW a page is positioned — cursor seek, legacy
 * offset skip, or neither.
 *
 * Extracted rather than inlined at each call site for a specific reason: the
 * three paged reads in `server.ts` cannot be route-tested (nothing imports that
 * module — it needs a live Firestore and Redis to construct), so inlining the
 * decision three times would leave it covered only by a source-scanning test.
 * 's own control failed exactly that way — a whole-file scan matched a
 * different occurrence and stayed green with the wiring removed. A real function
 * with a real fake is testable, and it also makes drift between the three sites
 * impossible.
 *
 * WHY CURSOR SUPERSEDES OFFSET: applying both would seek past the cursor and
 * THEN skip `offset` more rows, silently dropping a page. They are alternative
 * ways to say "start here", never composable.
 */

import { type KeysetCursor } from './keyset-cursor';

/**
 * The minimum of a Firestore Query this needs. Structural on purpose so the real
 * `admin.firestore.Query` and the in-memory fake both satisfy it without a cast
 * at the call site.
 */
export interface PageableQuery<Q> {
  startAfter(...values: unknown[]): Q;
  offset(n: number): Q;
}

export type KeysetPagePosition = 'cursor' | 'offset' | 'start';

export interface KeysetPageResult<Q> {
  readonly query: Q;
  /** Which positioning was applied — asserted by tests, useful in logs. */
  readonly position: KeysetPagePosition;
}

/**
 * Position `query` for the requested page.
 *
 * The caller is responsible for the ordering (primary sort field THEN
 * `FieldPath.documentId()`, same direction) — a cursor seek against a different
 * ordering lands somewhere else entirely.
 */
export function applyKeysetPage<Q extends PageableQuery<Q>>(
  query: Q,
  cursor: KeysetCursor | null,
  offset: number,
): KeysetPageResult<Q> {
  if (cursor !== null) {
    return { query: query.startAfter(cursor.sortValue, cursor.documentId), position: 'cursor' };
  }
  // A non-positive, fractional or non-finite offset is "start", not an error:
  // these are query-string values and the legacy endpoints have always coerced
  // them. Refusing here would break callers that send `offset=0`.
  //
  // The floor is taken BEFORE the positive test, not after: `offset=0.4` floors
  // to 0, so it is "start" and applies nothing — testing `offset > 0` first would
  // classify it as an offset page and then apply a no-op `offset(0)`, which is
  // harmless in Firestore but makes `position` lie about what happened.
  const skip = Number.isFinite(offset) ? Math.floor(offset) : 0;
  if (skip > 0) {
    return { query: query.offset(skip), position: 'offset' };
  }
  return { query, position: 'start' };
}

/**
 * Split a `limit + 1` probe result into the page and the has-more verdict.
 *
 * The probe row is how a paged read knows there is a next page without a second
 * query — and, on the cursor path, it is the ONLY way: `offset + limit < total`
 * is meaningless once you are seeking rather than skipping.
 */
export function splitProbePage<D>(
  docs: readonly D[],
  limit: number,
): { readonly pageDocs: readonly D[]; readonly hasMore: boolean } {
  const hasMore = docs.length > limit;
  return { pageDocs: hasMore ? docs.slice(0, limit) : docs, hasMore };
}
