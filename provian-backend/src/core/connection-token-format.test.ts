import { describe, it, expect } from '@jest/globals';
import {
  generateConnectionToken,
  isValidConnectionTokenFormat,
  CONNECTION_TOKEN_PATTERN,
  CONNECTION_TOKEN_ALPHABET,
  CONNECTION_TOKEN_LENGTH,
} from './connection-token-format';

describe('connection-token-format (the single source both resolvers guard against)', () => {
  it('every minted code is accepted by the validator — over many samples', () => {
    // Binds the generator to the validator directly (no redeclared fixture). If
    // the format drifts on either side, this fails immediately.
    let checked = 0;
    for (let i = 0; i < 2000; i++) {
      const token = generateConnectionToken();
      expect(isValidConnectionTokenFormat(token)).toBe(true);
      expect(token.length).toBe(CONNECTION_TOKEN_LENGTH);
      checked++;
    }
    expect(checked).toBe(2000); // non-vacuous: the loop actually ran
  });

  it('a minted code is 14 chars in the PROV-XXXX-XXXX shape', () => {
    const token = generateConnectionToken();
    expect(token).toMatch(/^PROV-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(CONNECTION_TOKEN_LENGTH).toBe(14);
  });

  it('RED CONTROL: the OLD resolver pattern rejects real minted codes (the shipped bug)', () => {
    const OLD_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
    const realCode = generateConnectionToken();
    expect(OLD_PATTERN.test(realCode)).toBe(false); // old guard WAS broken
    expect(isValidConnectionTokenFormat(realCode)).toBe(true); // new guard is correct
  });

  it('the alphabet excludes ambiguous characters 0/O/1/I', () => {
    for (const ch of ['0', 'O', '1', 'I']) {
      expect(CONNECTION_TOKEN_ALPHABET.includes(ch)).toBe(false);
    }
  });

  it('rejects malformed tokens (fail-closed on anything not exactly canonical)', () => {
    const bad = [
      '',
      'conn_' + 'a'.repeat(40), // the old vacuous fixture — must now be rejected
      'PROV-ABC-2345', // group too short
      'PROV-ABCDE-2345', // group too long
      'prov-ABCD-2345', // wrong-case prefix
      'PROV-ABCD2345', // missing separator
      'PROV-AB0D-2345', // ambiguous char 0 not in alphabet
      'PROV-AB1D-2345', // ambiguous char 1 not in alphabet
      'XXXX-ABCD-2345', // wrong prefix
      'PROV-ABCD-2345 ', // trailing space
      ' PROV-ABCD-2345', // leading space
    ];
    for (const t of bad) {
      expect(isValidConnectionTokenFormat(t)).toBe(false);
      expect(CONNECTION_TOKEN_PATTERN.test(t)).toBe(false);
    }
  });

  it('rejects non-string input without throwing', () => {
    for (const v of [null, undefined, 42, {}, [], Symbol('x')]) {
      expect(isValidConnectionTokenFormat(v as unknown)).toBe(false);
    }
  });
});
