/**
 * Opaque keyset (seek) pagination cursor — the shared encode/decode the paged
 * read paths use instead of `offset()`.
 *
 * WHY KEYSET AND NOT `offset()`: Firestore bills `offset(N)` as N reads it then
 * throws away, so page 50 costs fifty pages' worth of reads to return one. A
 * keyset cursor seeks directly (`startAfter`) and bills one page per page,
 * regardless of depth. It is also stable under concurrent writes at the head of
 * the collection, which offset is not — a row inserted before the current page
 * shifts every later offset by one and silently duplicates or skips a row.
 *
 * THE TIEBREAKER IS NOT OPTIONAL. The sort value alone is not a total order:
 * two PEs recorded in the same millisecond collide, and `startAfter(ts)` would
 * skip every row sharing that timestamp. The cursor therefore carries
 * `(sortValue, documentId)` and callers must order by the sort field and then
 * `FieldPath.documentId()` in the SAME direction — which is the ordering
 * Firestore's composite indexes already carry implicitly (`__name__` is appended
 * to every index in the last explicit direction), so this needs no new index.
 *
 * The encoding is deliberately opaque (base64url JSON): a caller must not build
 * or arithmetic on a cursor, only echo back the one it was handed.
 *
 * NOT unified with the three pre-existing private copies (`commons/wants.ts`,
 * `policy/earning-type-proposals.ts`, `policy/pending-policy-queue.ts`) — those
 * serialize `{v,created_at,document_id}` and are already handed out to live
 * callers, so re-shaping their payload would invalidate every in-flight cursor
 * for zero behavioural gain. New paged surfaces use THIS one; if those three are
 * ever migrated it must be with a compatibility parse, not a rename.
 */

/** The cursor payload version. Bump only on a breaking payload shape change. */
const CURSOR_VERSION = 1;

export interface KeysetCursor {
  /** The value of the primary sort field on the last row of the previous page. */
  readonly sortValue: number;
  /** That row's document id — the tiebreaker that makes the order total. */
  readonly documentId: string;
}

/**
 * A cursor's document id must be a PLAIN document id, not a path.
 *
 * Found in review: validating only "non-empty string" let `{"id":"a/b"}` through,
 * and `startAfter(k, "a/b")` then throws SYNCHRONOUSLY inside the Firestore
 * client ("… contains a slash") — so a malformed cursor produced a 500 instead of
 * the documented 400, contradicting this module's own contract that it returns
 * null for ANY malformed input rather than seeking from a value it half
 * understood.
 *
 * Firestore's own document-id rules: not empty, no `/`, not `.` or `..`, and not
 * the `__.*__` reserved form. Length is bounded by the caller's cap above.
 */
function isPlainDocumentId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('/')) return false;
  if (value === '.' || value === '..') return false;
  if (/^__.*__$/.test(value)) return false;
  return true;
}

/**
 * Encode the last row of a page into the cursor that resumes after it.
 * Throws on an unrepresentable input rather than emitting a cursor that would
 * decode to something else — a silently wrong cursor skips or repeats rows.
 */
export function encodeKeysetCursor(sortValue: number, documentId: string): string {
  if (!Number.isSafeInteger(sortValue) || sortValue < 0) {
    throw new Error('keyset_cursor_sort_value_invalid');
  }
  // Refuses exactly what `decodeKeysetCursor` refuses — otherwise encode could
  // mint a cursor its own decoder rejects, stranding a walk mid-history.
  if (!isPlainDocumentId(documentId)) {
    throw new Error('keyset_cursor_document_id_invalid');
  }
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, k: sortValue, id: documentId }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decode a caller-supplied cursor.
 *
 * Returns `null` for ANY malformed input — wrong version, bad base64, non-JSON,
 * missing or wrong-typed fields — so the caller answers 400 rather than seeking
 * from a value it half-understood. Client-supplied and therefore untrusted:
 * every field is re-validated, never assumed from the shape.
 */
export function decodeKeysetCursor(value: unknown): KeysetCursor | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (row.v !== CURSOR_VERSION) return null;
  if (!Number.isSafeInteger(row.k) || (row.k as number) < 0) return null;
  if (!isPlainDocumentId(row.id)) return null;
  return { sortValue: row.k as number, documentId: row.id };
}
