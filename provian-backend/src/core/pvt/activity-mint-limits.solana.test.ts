/**
 * follow-up — the counterparty-identity requirement reads a Solana address.
 *
 * `activity-mint-limits.ts` is import-isolated (the runtime boundary external-value isolation audit pins its
 * import edges), so it carries its own base58 check. This binds that copy to the one decoder the
 * rest of the relay reads (`external-address/solana-keys.ts`) over a population that includes
 * every shape that must be refused, so the two cannot drift apart unnoticed.
 */
import { describe, it, expect } from '@jest/globals';
import crypto from 'crypto';
import { isCanonicalSolanaCounterparty } from './activity-mint-limits';
import { base58Encode, isSolanaAddress } from '../external-address/solana-keys';

describe('isCanonicalSolanaCounterparty ≡ solana-keys isSolanaAddress', () => {
  it('agrees on a mixed population (valid keys, wrong lengths, non-canonical spellings, EVM, junk)', () => {
    const population: unknown[] = [
      '11111111111111111111111111111111', // the all-zero key (the System Program)
      'DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2',
      'z'.repeat(44), 'B'.repeat(44), '1'.repeat(31), '1'.repeat(33),
      `0x${'ab'.repeat(20)}`, 'not base58 0OIl', '', null, 42,
    ];
    for (let i = 0; i < 200; i += 1) {
      const len = [31, 32, 33, 64][i % 4];
      const bytes = crypto.randomBytes(len);
      if (i % 5 === 0) bytes[0] = 0; // leading zero bytes
      const enc = base58Encode(bytes);
      population.push(enc, `1${enc}`, enc.slice(1));
    }
    let trues = 0;
    for (const value of population) {
      const expected = isSolanaAddress(value);
      expect([value, isCanonicalSolanaCounterparty(value)]).toEqual([value, expected]);
      if (expected) trues += 1;
    }
    // Neither side of the comparison is vacuous.
    expect(trues).toBeGreaterThan(20);
    expect(population.length - trues).toBeGreaterThan(20);
  });
});
