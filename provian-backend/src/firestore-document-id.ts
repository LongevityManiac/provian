/** Firestore's exact UTF-8 path-segment ordering for document IDs. */

/**
 * True when `id` is a value Firestore's `.doc(id)` accepts as a SINGLE document
 * path segment. This is the guard that turns a caller-supplied identifier into
 * something safe to pass to `collection(...).doc(id)`.
 *
 * WHY IT EXISTS (F62). `@google-cloud/firestore`'s `.doc(id)` throws
 * SYNCHRONOUSLY when `id` contains a '/' (the path then has an even number of
 * components and points to a collection, not a document), and for a handful of
 * other reserved shapes. Inside an `async` auth middleware that synchronous
 * throw becomes a REJECTED PROMISE; Express 4 does not catch it and Node's
 * default `--unhandled-rejections=throw` then EXITS the process. An
 * unauthenticated caller who puts a '/' in a Bearer prefix / `sub` / device id
 * can therefore crash the instance on demand. Every auth middleware that builds
 * a `.doc()` path from caller-supplied bytes MUST gate on this first and answer
 * a 4xx, never let the id reach `.doc()`.
 *
 * The rules mirror Firestore's own document-id constraints: non-empty, no '/',
 * not exactly '.' or '..', not the reserved `__.*__` shape, and at most 1500
 * UTF-8 bytes. '/' is the crash trigger; the rest are rejected for the same
 * fail-closed reason (an id the store will reject is never a valid caller
 * identity).
 */
export function isValidFirestoreDocumentId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length === 0) return false;
  if (id.includes('/')) return false;
  if (id === '.' || id === '..') return false;
  if (/^__.*__$/.test(id)) return false;
  if (Buffer.byteLength(id, 'utf8') > 1500) return false;
  return true;
}

function primitiveComparison(left: string | number | bigint, right: string | number | bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareFirestoreUtf8Strings(left: string, right: string): number {
  const isSurrogate = (char: string): boolean => {
    const code = char.charCodeAt(0);
    return code >= 0xd800 && code <= 0xdfff;
  };
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftChar = left.charAt(index);
    const rightChar = right.charAt(index);
    if (leftChar === rightChar) continue;
    const leftSurrogate = isSurrogate(leftChar);
    const rightSurrogate = isSurrogate(rightChar);
    if (leftSurrogate !== rightSurrogate) return leftSurrogate ? 1 : -1;
    return primitiveComparison(leftChar, rightChar);
  }
  return primitiveComparison(left.length, right.length);
}

/** Mirrors ResourcePath.compareSegments(), including legacy numeric IDs. */
export function compareFirestoreDocumentIds(left: string, right: string): number {
  const numericId = (value: string): bigint | null => {
    if (!value.startsWith('__id') || !value.endsWith('__')) return null;
    const digits = value.slice(4, -2);
    if (!/^\d+$/.test(digits)) return null;
    return BigInt(digits);
  };
  const leftNumeric = numericId(left);
  const rightNumeric = numericId(right);
  if (leftNumeric !== null && rightNumeric === null) return -1;
  if (leftNumeric === null && rightNumeric !== null) return 1;
  if (leftNumeric !== null && rightNumeric !== null) {
    return primitiveComparison(leftNumeric, rightNumeric);
  }
  return compareFirestoreUtf8Strings(left, right);
}
