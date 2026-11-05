/**
 * Keyset pagination for endpoints whose body is a bare ARRAY.
 *
 * `/v1/provenance-envelopes` and `/v1/provenance-envelopes/summaries` both answer
 * with a top-level JSON array that the shipped mobile app consumes directly, so
 * the page cursor cannot go in the body without breaking every deployed client.
 * It rides in response HEADERS instead — additive, ignored by older callers, and
 * exactly what headers are for.
 *
 *   X-Next-Cursor  the opaque cursor to pass back as `?cursor=` (absent when the
 *                  walk is finished, or when this page's last row is unencodable)
 *   X-Has-More     "true" / "false" — whether more rows exist at all
 *
 * Reported separately for the same reason the JSON surfaces report them
 * separately: `X-Has-More: true` with no `X-Next-Cursor` is the honest
 * "more rows exist but the walk cannot continue from here" state, never a silent
 * truncation.
 */

import { encodeKeysetCursor } from './keyset-cursor';

/** The minimum of a Firestore QueryDocumentSnapshot this helper needs. */
export interface KeysetPageDoc {
  readonly id: string;
  data(): Record<string, unknown>;
}

/** The minimum of an Express Response this helper needs. */
export interface KeysetHeaderSink {
  setHeader(name: string, value: string): unknown;
}

export const NEXT_CURSOR_HEADER = 'X-Next-Cursor';
export const HAS_MORE_HEADER = 'X-Has-More';

/**
 * Stamp the paging headers for a page that has already been trimmed to its
 * requested size (i.e. the +1 has-more probe row is NOT in `pageDocs`).
 *
 * `sortField` must be the field the query's primary `orderBy` used — a cursor
 * built from any other field seeks to the wrong place.
 */
export function setKeysetPageHeaders(
  res: KeysetHeaderSink,
  pageDocs: readonly KeysetPageDoc[],
  hasMore: boolean,
  sortField: string,
): void {
  res.setHeader(HAS_MORE_HEADER, hasMore ? 'true' : 'false');
  if (!hasMore || pageDocs.length === 0) return;
  const last = pageDocs[pageDocs.length - 1];
  try {
    res.setHeader(
      NEXT_CURSOR_HEADER,
      encodeKeysetCursor(last.data()[sortField] as number, last.id),
    );
  } catch {
    // A legacy row with an unrepresentable sort value must not 500 the request —
    // that would be worse than the offset paging this replaces. The page already
    // returned is correct; the walk simply stops here and says so loudly.
    console.error(
      `[pagination] cursor unencodable at ${last.id} `
      + `(${sortField}=${String(last.data()[sortField])}); walk truncated here`,
    );
  }
}
