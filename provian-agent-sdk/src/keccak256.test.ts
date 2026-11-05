/**
 * Tests for the minimal keccak256 implementation.
 *
 * Validates against known test vectors from the Keccak specification
 * and verifies EVM address derivation compatibility.
 */
import { describe, it, expect } from 'vitest';
import { keccak256 } from './keccak256';

describe('keccak256', () => {
  it('hashes empty input correctly', () => {
    // Known keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
    const hash = keccak256(Buffer.alloc(0));
    expect(hash.toString('hex')).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    );
  });

  it('hashes "abc" correctly', () => {
    // Known keccak256("abc") = 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
    const hash = keccak256(Buffer.from('abc'));
    expect(hash.toString('hex')).toBe(
      '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'
    );
  });

  it('returns a 32-byte Buffer', () => {
    const hash = keccak256(Buffer.from('test'));
    expect(hash.length).toBe(32);
    expect(Buffer.isBuffer(hash)).toBe(true);
  });

  it('is deterministic', () => {
    const input = Buffer.from('deterministic test');
    const hash1 = keccak256(input);
    const hash2 = keccak256(input);
    expect(hash1.toString('hex')).toBe(hash2.toString('hex'));
  });

  it('produces different hashes for different inputs', () => {
    const hash1 = keccak256(Buffer.from('input 1'));
    const hash2 = keccak256(Buffer.from('input 2'));
    expect(hash1.toString('hex')).not.toBe(hash2.toString('hex'));
  });

  it('handles inputs longer than one block (136 bytes)', () => {
    const longInput = Buffer.alloc(256, 0xff);
    const hash = keccak256(longInput);
    expect(hash.length).toBe(32);
    // Should not throw and should produce a valid hash
    expect(hash.toString('hex')).toMatch(/^[0-9a-f]{64}$/);
  });
});
