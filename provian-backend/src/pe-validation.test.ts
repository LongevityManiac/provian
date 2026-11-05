import { describe, it, expect } from '@jest/globals';
import { isSafePETimestamp, validatePEDescription, validateEnvelopeId } from './pe-validation';

describe('validatePEDescription', () => {
  // --- Valid descriptions ---
  it('accepts a well-formed description', () => {
    const result = validatePEDescription('Refactored authentication module to use JWT tokens');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts minimum valid description (20 chars, 3 words)', () => {
    const result = validatePEDescription('Read database metrics now');
    expect(result.valid).toBe(true);
  });

  it('accepts a long detailed description', () => {
    const desc = 'Analyzed production logs from the past 7 days to identify recurring timeout patterns in the payment processing pipeline, generated a summary report with recommendations for connection pool tuning';
    const result = validatePEDescription(desc);
    expect(result.valid).toBe(true);
  });

  // --- Type errors ---
  // Article I: descriptions are optional, so null/undefined are valid (skip
  // validation entirely). Non-string non-null values still fail.
  it('treats null/undefined/empty as valid (description is optional)', () => {
    expect(validatePEDescription(null).valid).toBe(true);
    expect(validatePEDescription(undefined).valid).toBe(true);
    expect(validatePEDescription('').valid).toBe(true);
  });
  it('rejects non-string non-null input', () => {
    expect(validatePEDescription(123).valid).toBe(false);
    expect(validatePEDescription({}).valid).toBe(false);
  });

  // --- Empty / whitespace ---
  // Empty string after trim is treated as absent (valid).
  it('accepts whitespace-only string as absent', () => {
    const result = validatePEDescription('   \n\t  ');
    expect(result.valid).toBe(true);
  });

  // --- Too short ---
  it('rejects descriptions under 20 characters', () => {
    const result = validatePEDescription('Read file');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too short');
  });

  // --- Too few words ---
  it('rejects descriptions with fewer than 3 words', () => {
    const result = validatePEDescription('DeployedStagingService');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('at least 3 words');
  });

  // --- Too long ---
  it('rejects descriptions over 2000 characters', () => {
    const long = 'A'.repeat(2001);
    const result = validatePEDescription(long);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('2000 characters');
  });

  // --- No letters ---
  it('rejects descriptions with no alphabetic characters', () => {
    const result = validatePEDescription('12345 67890 11111 22222');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('letter');
  });

  // --- Blocklist ---
  it('rejects exact blocklist matches (case-insensitive)', () => {
    // Short blocklisted words are caught by the min-length check first (which is correct)
    const shortBlocklisted = ['test', 'Testing', 'ASDF', 'todo', 'n/a', 'foo', 'bar', 'wip', 'tbd'];
    for (const word of shortBlocklisted) {
      const result = validatePEDescription(word);
      expect(result.valid).toBe(false); // Rejected (by min-length or min-words)
    }

    // Longer blocklisted phrases that pass length/word checks are caught by blocklist
    const longBlocklisted = ['hello world placeholder', 'describe action here', 'test description here', 'changed something here'];
    for (const phrase of longBlocklisted) {
      // These are 20+ chars and 3+ words but still blocklisted? Let's verify individually
    }

    // These are exactly blocklist-caught (≥20 chars, ≥3 words):
    const result1 = validatePEDescription('describe action here');
    expect(result1.valid).toBe(false);
    expect(result1.error).toContain('not a valid PE description');
  });

  it('accepts blocklist words when part of a real description', () => {
    const result = validatePEDescription('Fixed test suite for authentication module - 3 tests were flaky');
    expect(result.valid).toBe(true);
  });

  // --- Custom field name ---
  it('uses custom field name in error messages', () => {
    const result = validatePEDescription('x', 'summary');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('summary');
  });

  // --- Hint always present on failure ---
  it('includes a hint on every validation failure', () => {
    const cases = ['x', 'test', '12345 67890 11111 22222', 'too short'];
    for (const input of cases) {
      const result = validatePEDescription(input);
      if (!result.valid) {
        expect(result.hint).toBeDefined();
        expect(result.hint!.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('validateEnvelopeId (#23 — Firestore doc-id safety)', () => {
  it('accepts a normal UUID and a pe_-prefixed id', () => {
    expect(validateEnvelopeId('550e8400-e29b-41d4-a716-446655440000').valid).toBe(true);
    expect(validateEnvelopeId('pe_12345678-abcd-ef01-2345-6789abcdef01').valid).toBe(true);
  });

  it('rejects a non-string / empty id', () => {
    expect(validateEnvelopeId(123).valid).toBe(false);
    expect(validateEnvelopeId(undefined).valid).toBe(false);
    expect(validateEnvelopeId('').valid).toBe(false);
  });

  it('rejects the reserved "." and ".." ids', () => {
    expect(validateEnvelopeId('.').valid).toBe(false);
    expect(validateEnvelopeId('..').valid).toBe(false);
  });

  it('rejects an id containing "/" (would mis-file into a nested subcollection)', () => {
    const r = validateEnvelopeId('a/b/c');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/\//);
  });

  it('rejects the reserved __*__ pattern', () => {
    expect(validateEnvelopeId('__proto__').valid).toBe(false);
    expect(validateEnvelopeId('__anything__').valid).toBe(false);
  });

  it('rejects an id over the 1500-byte Firestore limit', () => {
    expect(validateEnvelopeId('x'.repeat(1500)).valid).toBe(true);
    expect(validateEnvelopeId('x'.repeat(1501)).valid).toBe(false);
    // multibyte: counts BYTES, not code units
    expect(validateEnvelopeId('€'.repeat(501)).valid).toBe(false); // 501 × 3 bytes = 1503
  });
});

describe('isSafePETimestamp', () => {
  it('accepts integer Unix milliseconds and rejects unsafe wire values', () => {
    expect(isSafePETimestamp(Date.now())).toBe(true);
    for (const value of [
      Date.now() + 0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      -1,
      '1780000000000',
      null,
    ]) {
      expect(isSafePETimestamp(value)).toBe(false);
    }
  });
});
