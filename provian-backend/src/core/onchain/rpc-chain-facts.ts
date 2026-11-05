/** Optional authenticated time annotations may be omitted by an RPC's history backend. */
const OPTIONAL_TIME_FIELDS = new Set(['timestampMs', 'blockTimestampMs']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Compare every chain fact, permitting only an absent optional time annotation.
 * When both operators supply an annotation they must agree on it too. Unknown
 * fields are never discarded, and array order remains significant.
 */
export function rpcChainFactsEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => rpcChainFactsEqual(value, right[index]));
  }
  if (!record(left) || !record(right)) return false;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const hasLeft = Object.prototype.hasOwnProperty.call(left, key);
    const hasRight = Object.prototype.hasOwnProperty.call(right, key);
    if (OPTIONAL_TIME_FIELDS.has(key)) {
      for (const value of [left[key], right[key]]) {
        if (value !== undefined && (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value))) return false;
      }
      if (!hasLeft || !hasRight) continue;
    }
    if (hasLeft !== hasRight || !rpcChainFactsEqual(left[key], right[key])) return false;
  }
  return true;
}
