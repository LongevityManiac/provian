import { describe, it, expect } from 'vitest';
import { parseAtomicAmount, formatAtomicAmount } from './amounts';

describe('parseAtomicAmount', () => {
    it('parses SOL (9 decimals) exactly', () => {
        expect(parseAtomicAmount('1', 9)).toBe(1_000_000_000n);
        expect(parseAtomicAmount('0.000000001', 9)).toBe(1n);
        expect(parseAtomicAmount('1.5', 9)).toBe(1_500_000_000n);
        expect(parseAtomicAmount('0', 9)).toBe(0n);
    });

    it('parses USDC (6 decimals) exactly', () => {
        expect(parseAtomicAmount('1', 6)).toBe(1_000_000n);
        expect(parseAtomicAmount('0.01', 6)).toBe(10_000n);
        expect(parseAtomicAmount('123.456789', 6)).toBe(123_456_789n);
    });

    it('handles large amounts without float error', () => {
        // 9_000_000 SOL — well beyond Number.MAX_SAFE_INTEGER in lamports.
        expect(parseAtomicAmount('9000000.123456789', 9)).toBe(9_000_000_123_456_789n);
    });

    it('FAIL CLOSED: rejects too many decimal places', () => {
        expect(() => parseAtomicAmount('1.0000001', 6)).toThrow(/decimal/i);
    });

    it('FAIL CLOSED: rejects malformed input', () => {
        expect(() => parseAtomicAmount('', 6)).toThrow(/Invalid/);
        expect(() => parseAtomicAmount('1.2.3', 6)).toThrow(/Invalid/);
        expect(() => parseAtomicAmount('abc', 6)).toThrow(/Invalid/);
        expect(() => parseAtomicAmount('-1', 6)).toThrow(/Invalid/);
        expect(() => parseAtomicAmount('.', 6)).toThrow(/Invalid/);
        expect(() => parseAtomicAmount('0,01', 6)).toThrow(/Invalid/);
        expect(() => parseAtomicAmount('1e-2', 6)).toThrow(/Invalid/);
    });

    it('round-trips through formatAtomicAmount', () => {
        for (const [s, d] of [['1.25', 6], ['0.000000001', 9], ['1000', 6], ['0.1', 9]] as const) {
            expect(formatAtomicAmount(parseAtomicAmount(s, d), d)).toBe(s);
        }
    });
});

// typing ".01" on the Send screen failed on Solana with "Invalid amount" while
// the same entry works on EVM (ethers.parseUnits accepts it). Both forms a keypad yields now parse.
describe('parseAtomicAmount accepts leading-dot and trailing-dot entries (EVM parity)', () => {
    it('RED case: ".01" USDC is 10,000 base units; ".5" SOL is 0.5 SOL', () => {
        expect(parseAtomicAmount('.01', 6)).toBe(10_000n);
        expect(parseAtomicAmount('.5', 9)).toBe(500_000_000n);
        expect(parseAtomicAmount(' .01 ', 6)).toBe(10_000n);
    });

    it('"1." is one whole unit', () => {
        expect(parseAtomicAmount('1.', 6)).toBe(1_000_000n);
    });

    it('still refuses too many decimals in the leading-dot form', () => {
        expect(() => parseAtomicAmount('.0000001', 6)).toThrow(/decimal/i);
    });
});
