/**
 * Keyset cursor encode/decode.
 *
 * the decoder's whole job is to REFUSE, so a suite that only round-trips
 * a good cursor would pass identically against `decode = () => ({sortValue:0,
 * documentId:'x'})`. Every rejection case below is therefore constructed
 * explicitly, and `decodeKeysetCursor` takes `unknown` rather than `string` so
 * the non-string violations are constructible at all (the run contract's
 * "unreachable branch" shape — widen the guard's input, keep the call site
 * narrow).
 */

import { decodeKeysetCursor, encodeKeysetCursor, type KeysetCursor } from './keyset-cursor';

function encodeRaw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('keyset cursor', () => {
  describe('round trip', () => {
    it('decodes back to exactly what was encoded', () => {
      const cases: KeysetCursor[] = [
        { sortValue: 0, documentId: 'pe_a' },
        { sortValue: 1_785_715_200_000, documentId: 'pe_9f2c-4a' },
        { sortValue: Number.MAX_SAFE_INTEGER, documentId: 'x'.repeat(200) },
      ];
      for (const input of cases) {
        expect(decodeKeysetCursor(encodeKeysetCursor(input.sortValue, input.documentId)))
          .toEqual(input);
      }
      // Non-vacuous: assert the population was actually walked.
      expect(cases).toHaveLength(3);
    });

    it('is opaque — the encoding is not the document id', () => {
      const encoded = encodeKeysetCursor(5, 'pe_secret');
      expect(encoded).not.toContain('pe_secret');
    });
  });

  describe('encode refuses what it cannot represent', () => {
    it.each([
      ['negative', -1],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['above MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
    ])('throws on a %s sort value rather than emitting a lying cursor', (_label, value) => {
      expect(() => encodeKeysetCursor(value as number, 'pe_a'))
        .toThrow('keyset_cursor_sort_value_invalid');
    });

    it.each([
      ['empty', ''],
      ['path-shaped', 'a/b'],
      ['single dot', '.'],
      ['double dot', '..'],
      ['reserved __name__', '__name__'],
    ])('throws on a %s document id', (_label, id) => {
      // encode must refuse exactly what decode refuses, or it could mint a
      // cursor its own decoder rejects and strand a walk mid-history.
      expect(() => encodeKeysetCursor(1, id)).toThrow('keyset_cursor_document_id_invalid');
    });

    it('CONTROL — an ordinary document id encodes fine', () => {
      expect(() => encodeKeysetCursor(1, 'pe_abc-123')).not.toThrow();
    });
  });

  describe('decode returns null on every malformed input', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['an object', { v: 1, k: 1, id: 'a' }],
      ['an array', [1, 'a']],
      ['the empty string', ''],
      ['over the length cap', 'A'.repeat(513)],
      ['not base64url JSON', 'not-a-cursor!!'],
      ['valid base64url, not JSON', Buffer.from('hello', 'utf8').toString('base64url')],
      ['JSON that is not an object', encodeRaw([1, 2, 3])],
      ['JSON null', encodeRaw(null)],
      ['a wrong version', encodeRaw({ v: 2, k: 1, id: 'a' })],
      ['a missing version', encodeRaw({ k: 1, id: 'a' })],
      ['a fractional sort value', encodeRaw({ v: 1, k: 1.5, id: 'a' })],
      ['a negative sort value', encodeRaw({ v: 1, k: -1, id: 'a' })],
      ['a string sort value', encodeRaw({ v: 1, k: '1', id: 'a' })],
      ['a missing sort value', encodeRaw({ v: 1, id: 'a' })],
      ['a non-string document id', encodeRaw({ v: 1, k: 1, id: 7 })],
      ['an empty document id', encodeRaw({ v: 1, k: 1, id: '' })],
      ['a missing document id', encodeRaw({ v: 1, k: 1 })],
      // Found in review: these reached `startAfter`, which throws SYNCHRONOUSLY
      // in the Firestore client — turning a malformed cursor into a 500 instead
      // of the documented 400.
      ['a PATH-shaped document id', encodeRaw({ v: 1, k: 1, id: 'a/b' })],
      ['a leading-slash document id', encodeRaw({ v: 1, k: 1, id: '/a' })],
      ['the single-dot document id', encodeRaw({ v: 1, k: 1, id: '.' })],
      ['the double-dot document id', encodeRaw({ v: 1, k: 1, id: '..' })],
      ['a reserved __name__ document id', encodeRaw({ v: 1, k: 1, id: '__name__' })],
    ])('rejects %s', (_label, value) => {
      expect(decodeKeysetCursor(value)).toBeNull();
    });

    it('CONTROL — the same payload shape with every field valid DOES decode', () => {
      // Without this, the block above would pass against `decode = () => null`.
      expect(decodeKeysetCursor(encodeRaw({ v: 1, k: 1, id: 'a' })))
        .toEqual({ sortValue: 1, documentId: 'a' });
    });
  });
});
