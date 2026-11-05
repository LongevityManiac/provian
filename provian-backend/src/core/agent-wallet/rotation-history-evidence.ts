/**
 * Shared, fail-closed validator for an agent wallet's durable key-rotation
 * lineage. Callers supply their own failure function so each boundary keeps
 * its established typed error while sharing one byte-identical proof rule.
 */

const ADDRESS = /^0x[0-9a-f]{40}$/;
const PE_ID = /^pe_[A-Za-z0-9_-]{1,240}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const ROTATION_HISTORY_SUBCOLLECTION = 'rotation_history' as const;

export interface RotationHistoryEvidenceEntry {
  rotation_id: string;
  old_address: string;
  new_address: string;
  rotated_at: number;
  rotation_count: number;
  pe_id: string;
  pe_hash: string;
}

export interface RotationHistoryEvidenceBound {
  birthAddress: string;
  currentAddress: string;
  rotationCount: number;
  lastRotatedAt: number | null;
  now: number;
}

export type RotationHistoryFailure = (reason: string) => never;

function plainRecord(
  value: unknown,
  reason: string,
  fail: RotationHistoryFailure,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(reason);
  return value as Record<string, unknown>;
}

function exactKeys(
  raw: Record<string, unknown>,
  expected: readonly string[],
  reason: string,
  fail: RotationHistoryFailure,
): void {
  const actual = Object.keys(raw).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) fail(reason);
}

function safeTimestamp(
  value: unknown,
  now: number,
  reason: string,
  fail: RotationHistoryFailure,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > now) fail(reason);
  return value as number;
}

function safeNonNegativeInteger(
  value: unknown,
  reason: string,
  fail: RotationHistoryFailure,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(reason);
  return value as number;
}

/**
 * Bind exactly N sealed rotation-history entries to birth -> current:
 * contiguous 1..N counters, strict address/time continuity, unique sealed PEs,
 * and a terminal address/time equal to the live wallet document.
 */
export function validateRotationHistoryEvidenceCore(
  rawEntries: readonly (Record<string, unknown> | undefined)[],
  bound: RotationHistoryEvidenceBound,
  fail: RotationHistoryFailure,
): RotationHistoryEvidenceEntry[] {
  const birth = bound.birthAddress.toLowerCase();
  const current = bound.currentAddress.toLowerCase();
  if (!ADDRESS.test(birth) || !ADDRESS.test(current)) fail('rotation_history_bound_address');
  if (!Number.isSafeInteger(bound.rotationCount) || bound.rotationCount < 0) {
    fail('rotation_history_bound_count');
  }
  if (bound.rotationCount === 0) {
    if (rawEntries.length !== 0 || bound.lastRotatedAt !== null) fail('rotation_history_unexpected');
    if (birth !== current) fail('rotation_history_unrotated_address');
    return [];
  }
  if (bound.lastRotatedAt === null
    || !Number.isSafeInteger(bound.lastRotatedAt)
    || bound.lastRotatedAt < 0) fail('rotation_history_bound_last_rotated');
  if (rawEntries.length !== bound.rotationCount) fail('rotation_history_count_mismatch');

  const parsed = rawEntries.map((raw) => {
    const record = plainRecord(raw, 'rotation_history_shape', fail);
    exactKeys(record, [
      'rotation_id', 'old_address', 'new_address', 'rotated_at', 'rotation_count',
      'pe_id', 'pe_hash',
    ], 'rotation_history_keys', fail);
    const oldAddress = String(record.old_address).toLowerCase();
    const newAddress = String(record.new_address).toLowerCase();
    if (typeof record.rotation_id !== 'string' || record.rotation_id.length === 0
      || !ADDRESS.test(oldAddress) || !ADDRESS.test(newAddress)
      || oldAddress === newAddress
      || typeof record.pe_id !== 'string' || !PE_ID.test(record.pe_id)
      || typeof record.pe_hash !== 'string' || !SHA256.test(record.pe_hash)) {
      fail('rotation_history_fields');
    }
    const rotatedAt = safeTimestamp(record.rotated_at, bound.now, 'rotation_history_rotated_at', fail);
    const count = safeNonNegativeInteger(record.rotation_count, 'rotation_history_index', fail);
    if (count < 1 || count > bound.rotationCount) fail('rotation_history_index_range');
    return {
      rotation_id: record.rotation_id,
      old_address: oldAddress,
      new_address: newAddress,
      rotated_at: rotatedAt,
      rotation_count: count,
      pe_id: record.pe_id,
      pe_hash: record.pe_hash,
    } as RotationHistoryEvidenceEntry;
  });

  parsed.sort((a, b) => a.rotation_count - b.rotation_count);
  let expectedOld = birth;
  let previousRotatedAt = -1;
  const seenPeIds = new Set<string>();
  parsed.forEach((entry, index) => {
    if (entry.rotation_count !== index + 1) fail('rotation_history_sequence');
    if (entry.old_address !== expectedOld) fail('rotation_history_lineage');
    if (entry.rotated_at <= previousRotatedAt) fail('rotation_history_time_order');
    if (seenPeIds.has(entry.pe_id)) fail('rotation_history_pe_reuse');
    seenPeIds.add(entry.pe_id);
    expectedOld = entry.new_address;
    previousRotatedAt = entry.rotated_at;
  });
  const last = parsed[parsed.length - 1];
  if (last.new_address !== current) fail('rotation_history_terminal_address');
  if (last.rotated_at !== bound.lastRotatedAt) fail('rotation_history_terminal_time');
  return parsed;
}
