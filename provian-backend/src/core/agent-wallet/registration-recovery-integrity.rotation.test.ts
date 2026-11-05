import { describe, expect, test } from '@jest/globals';
import {
  AgentWalletRegistrationIntegrityError,
  validateRotationHistoryEvidence,
} from './registration-recovery-integrity';

const BIRTH = '0x1111111111111111111111111111111111111111';
const A = '0x2222222222222222222222222222222222222222';
const CURRENT = '0x3333333333333333333333333333333333333333';
const PE = (n: number) => `pe_agent_key_rotated_${'0'.repeat(63)}${n}`;
const HASH = (n: number) => `${'a'.repeat(63)}${n}`;
const NOW = 10_000_000_000_000;

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rotation_id: 'rot-1',
    old_address: BIRTH,
    new_address: CURRENT,
    rotated_at: 1_000,
    rotation_count: 1,
    pe_id: PE(1),
    pe_hash: HASH(1),
    ...overrides,
  };
}

function expectReason(fn: () => unknown, reason: RegExp): void {
  try {
    fn();
    throw new Error('expected a rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentWalletRegistrationIntegrityError);
    expect((error as AgentWalletRegistrationIntegrityError).message).toMatch(reason);
  }
}

describe('validateRotationHistoryEvidence ', () => {
  test('an un-rotated wallet: empty history, null last_rotated_at, birth === current', () => {
    expect(validateRotationHistoryEvidence([], {
      birthAddress: BIRTH,
      currentAddress: BIRTH,
      rotationCount: 0,
      lastRotatedAt: null,
      now: NOW,
    })).toEqual([]);
  });

  test('rotationCount 0 rejects any history entry', () => {
    expectReason(() => validateRotationHistoryEvidence([entry()], {
      birthAddress: BIRTH, currentAddress: BIRTH, rotationCount: 0, lastRotatedAt: null, now: NOW,
    }), /rotation_history_unexpected/);
  });

  test('rotationCount 0 rejects a stray last_rotated_at', () => {
    expectReason(() => validateRotationHistoryEvidence([], {
      birthAddress: BIRTH, currentAddress: BIRTH, rotationCount: 0, lastRotatedAt: 5, now: NOW,
    }), /rotation_history_unexpected/);
  });

  test('rotationCount 0 rejects a birth != current drift', () => {
    expectReason(() => validateRotationHistoryEvidence([], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 0, lastRotatedAt: null, now: NOW,
    }), /rotation_history_unrotated_address/);
  });

  test('a single valid rotation binds birth -> current', () => {
    const result = validateRotationHistoryEvidence([entry()], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 1, lastRotatedAt: 1_000, now: NOW,
    });
    expect(result).toHaveLength(1);
    expect(result[0].pe_id).toBe(PE(1));
  });

  test('two rotations chain birth -> A -> current in order (even when input is unsorted)', () => {
    const first = entry({ rotation_id: 'r1', old_address: BIRTH, new_address: A, rotated_at: 1_000, rotation_count: 1, pe_id: PE(1), pe_hash: HASH(1) });
    const second = entry({ rotation_id: 'r2', old_address: A, new_address: CURRENT, rotated_at: 2_000, rotation_count: 2, pe_id: PE(2), pe_hash: HASH(2) });
    const result = validateRotationHistoryEvidence([second, first], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 2, lastRotatedAt: 2_000, now: NOW,
    });
    expect(result.map((e) => e.rotation_count)).toEqual([1, 2]);
  });

  test('rejects a count mismatch', () => {
    expectReason(() => validateRotationHistoryEvidence([entry()], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 2, lastRotatedAt: 1_000, now: NOW,
    }), /rotation_history_count_mismatch/);
  });

  test('rejects a null pe_id (the un-sealed half-rotation)', () => {
    expectReason(() => validateRotationHistoryEvidence([entry({ pe_id: null })], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 1, lastRotatedAt: 1_000, now: NOW,
    }), /rotation_history_fields/);
  });

  test('rejects a broken address lineage', () => {
    const first = entry({ rotation_id: 'r1', old_address: BIRTH, new_address: A, rotated_at: 1_000, rotation_count: 1, pe_id: PE(1), pe_hash: HASH(1) });
    const second = entry({ rotation_id: 'r2', old_address: CURRENT, new_address: CURRENT, rotated_at: 2_000, rotation_count: 2, pe_id: PE(2), pe_hash: HASH(2) });
    expectReason(() => validateRotationHistoryEvidence([first, second], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 2, lastRotatedAt: 2_000, now: NOW,
    }), /rotation_history_fields|rotation_history_lineage/);
  });

  test('rejects a terminal address that is not the wallet address', () => {
    expectReason(() => validateRotationHistoryEvidence([entry({ new_address: A })], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 1, lastRotatedAt: 1_000, now: NOW,
    }), /rotation_history_terminal_address/);
  });

  test('rejects a terminal rotated_at that disagrees with last_rotated_at', () => {
    expectReason(() => validateRotationHistoryEvidence([entry()], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 1, lastRotatedAt: 999, now: NOW,
    }), /rotation_history_terminal_time/);
  });

  test('rejects a duplicated rotation index (no 1..N sequence)', () => {
    const a = entry({ rotation_id: 'r1', old_address: BIRTH, new_address: A, rotated_at: 1_000, rotation_count: 1, pe_id: PE(1), pe_hash: HASH(1) });
    const b = entry({ rotation_id: 'r2', old_address: A, new_address: CURRENT, rotated_at: 2_000, rotation_count: 1, pe_id: PE(2), pe_hash: HASH(2) });
    expectReason(() => validateRotationHistoryEvidence([a, b], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 2, lastRotatedAt: 2_000, now: NOW,
    }), /rotation_history_sequence/);
  });

  test('rejects a reused pe_id across entries', () => {
    const a = entry({ rotation_id: 'r1', old_address: BIRTH, new_address: A, rotated_at: 1_000, rotation_count: 1, pe_id: PE(1), pe_hash: HASH(1) });
    const b = entry({ rotation_id: 'r2', old_address: A, new_address: CURRENT, rotated_at: 2_000, rotation_count: 2, pe_id: PE(1), pe_hash: HASH(2) });
    expectReason(() => validateRotationHistoryEvidence([a, b], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 2, lastRotatedAt: 2_000, now: NOW,
    }), /rotation_history_pe_reuse/);
  });

  test('rejects non-increasing rotated_at', () => {
    const a = entry({ rotation_id: 'r1', old_address: BIRTH, new_address: A, rotated_at: 2_000, rotation_count: 1, pe_id: PE(1), pe_hash: HASH(1) });
    const b = entry({ rotation_id: 'r2', old_address: A, new_address: CURRENT, rotated_at: 2_000, rotation_count: 2, pe_id: PE(2), pe_hash: HASH(2) });
    expectReason(() => validateRotationHistoryEvidence([a, b], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 2, lastRotatedAt: 2_000, now: NOW,
    }), /rotation_history_time_order/);
  });

  test('rejects an extra key on an entry', () => {
    expectReason(() => validateRotationHistoryEvidence([entry({ extra: 1 })], {
      birthAddress: BIRTH, currentAddress: CURRENT, rotationCount: 1, lastRotatedAt: 1_000, now: NOW,
    }), /rotation_history_keys/);
  });
});
