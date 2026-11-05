import { describe, expect, it } from 'vitest';

import {
  isValidConnectionTokenFormat,
  CONNECTION_TOKEN_LENGTH,
  CONNECTION_TOKEN_PATTERN,
} from './connection-token-format';

describe('connection-token-format (14-vs-16 regression)', () => {
  it('ACCEPTS a real 14-char PROV code — the exact shape the retired {16,256} guard REJECTED', () => {
    // RED control: /^[A-Za-z0-9_-]{16,256}$/ returned FALSE for these (14 < 16), which is
    // precisely the bug — a code minted seconds earlier failed the snapshot validator.
    expect(isValidConnectionTokenFormat('PROV-ABCD-2345')).toBe(true);
    expect(isValidConnectionTokenFormat('PROV-ABCD-EFGH')).toBe(true);
    expect('PROV-ABCD-2345'.length).toBe(CONNECTION_TOKEN_LENGTH);
    expect(CONNECTION_TOKEN_LENGTH).toBe(14);
  });

  it('REJECTS a >=16-char generic token that the retired {16,256} guard ACCEPTED', () => {
    // RED control the other direction: the old guard returned TRUE for any 16..256 char
    // [A-Za-z0-9_-] string; the canonical PROV shape must reject them, or the tightening
    // would be a no-op that still lets non-codes through.
    expect(isValidConnectionTokenFormat('ABCDEFGHIJKLMNOP')).toBe(false); // 16 chars, not PROV
    expect(isValidConnectionTokenFormat('prov_live_0123456789abcdef')).toBe(false); // 26 chars
  });

  it('REJECTS malformed shapes, out-of-alphabet chars, and non-strings', () => {
    expect(isValidConnectionTokenFormat('PROV-ABC-2345')).toBe(false); // 3-char group
    expect(isValidConnectionTokenFormat('PROV-ABCDE-2345')).toBe(false); // 5-char group
    expect(isValidConnectionTokenFormat('PROV-ABCD-234I')).toBe(false); // I is excluded from the alphabet
    expect(isValidConnectionTokenFormat('PROV-ABCD-2340')).toBe(false); // 0 is excluded
    expect(isValidConnectionTokenFormat('prov-abcd-2345')).toBe(false); // lowercase
    expect(isValidConnectionTokenFormat('PROV-ABCD-2345 ')).toBe(false); // trailing space
    expect(isValidConnectionTokenFormat('')).toBe(false);
    expect(isValidConnectionTokenFormat(undefined)).toBe(false);
    expect(isValidConnectionTokenFormat(42)).toBe(false);
    expect(isValidConnectionTokenFormat(null)).toBe(false);
  });

  it('the pattern is the exact PROV-XXXX-XXXX canonical shape', () => {
    expect(CONNECTION_TOKEN_PATTERN.source).toBe('^PROV-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$');
  });
});
