import { describe, it, expect } from 'vitest';
import { canonicalizeAmount, sendDecimalsOf } from './amountInput';

describe('canonicalizeAmount — what a keypad produces, as the chain services need it (2026-10-17)', () => {
    it('accepts the dot-decimal forms the chain services already took', () => {
        expect(canonicalizeAmount('1', 18)).toEqual({ ok: true, value: '1' });
        expect(canonicalizeAmount('1.5', 18)).toEqual({ ok: true, value: '1.5' });
        expect(canonicalizeAmount('.01', 6)).toEqual({ ok: true, value: '0.01' });
        expect(canonicalizeAmount('1.', 6)).toEqual({ ok: true, value: '1' });
        expect(canonicalizeAmount('0.500', 6)).toEqual({ ok: true, value: '0.5' });
        expect(canonicalizeAmount('007', 6)).toEqual({ ok: true, value: '7' });
    });

    it('RED (locale comma): "1,5" is one and a half, never one', () => {
        // parseFloat('1,5') === 1 — the figure the review step used to show.
        expect(canonicalizeAmount('1,5', 6)).toEqual({ ok: true, value: '1.5' });
        expect(canonicalizeAmount(' 0,25 ', 9)).toEqual({ ok: true, value: '0.25' });
    });

    it('resolves thousands separators by the last separator', () => {
        expect(canonicalizeAmount('1,000.5', 6)).toEqual({ ok: true, value: '1000.5' });
        expect(canonicalizeAmount('1.000,5', 6)).toEqual({ ok: true, value: '1000.5' });
        expect(canonicalizeAmount('1,000,000', 6)).toEqual({ ok: true, value: '1000000' });
        expect(canonicalizeAmount('1.000.000', 6)).toEqual({ ok: true, value: '1000000' });
    });

    it('refuses what the chain services would have refused after Face ID', () => {
        expect(canonicalizeAmount('', 6)).toEqual({ ok: false, reason: 'empty' });
        expect(canonicalizeAmount('abc', 6)).toEqual({ ok: false, reason: 'format' });
        expect(canonicalizeAmount('1,2,3.4.5', 6)).toEqual({ ok: false, reason: 'format' });
        expect(canonicalizeAmount('1.2.3,4', 6)).toEqual({ ok: false, reason: 'format' }); // not thousands groups
        expect(canonicalizeAmount('-1', 6)).toEqual({ ok: false, reason: 'format' });
        expect(canonicalizeAmount('1e5', 6)).toEqual({ ok: false, reason: 'format' });
        expect(canonicalizeAmount('0', 6)).toEqual({ ok: false, reason: 'zero' });
        expect(canonicalizeAmount('0.000', 6)).toEqual({ ok: false, reason: 'zero' });
        expect(canonicalizeAmount('1.1234567', 6)).toEqual({ ok: false, reason: 'too_many_decimals' });
        expect(canonicalizeAmount('0.0000000001', 9)).toEqual({ ok: false, reason: 'too_many_decimals' });
    });

    it("RED : a separator typo is refused, never read as a larger amount", () => {
        // The first cut treated repeated / trailing separators as thousands grouping without checking
        // the group sizes: "1.5." sent 15, "0.1.5" sent 15, "1,2,5" sent 125.
        for (const typo of ['1.5.', '1.5,', '0.1.5', '1,2,5', '1,5.5', '12,345,6', '1..5', '1,,5', '.5.', ',5,',
            // Round 2: a trailing mark of the other glyph after three digits, and a leading-zero "group",
            // turned the decimal mark into a thousands separator ("0.500," → 500; "0.000.001" → 1).
            '0.500,', '0.050,', '2.500,', '1.000,', '0,250.', '1,000.', '0.000.001', '0,001,000', '0,000.5', '0.000,5',
            // A grouping glyph is accepted only in the grouped shape ("1 5" was fifteen).
            '1 5', '0 5', "1'5", '1_5', '1 00', '12 3456']) {
            expect(canonicalizeAmount(typo, 6), typo).toEqual({ ok: false, reason: 'format' });
        }
        // Glyph grouping in its well-formed shape still reads.
        expect(canonicalizeAmount('1 000,50', 6)).toEqual({ ok: true, value: '1000.5' });
        expect(canonicalizeAmount("1'000.50", 6)).toEqual({ ok: true, value: '1000.5' });
        expect(canonicalizeAmount('1 000 000', 6)).toEqual({ ok: true, value: '1000000' });
        // A single separator is the decimal mark whatever the glyph; trailing zeros carry nothing.
        expect(canonicalizeAmount('1,000', 6)).toEqual({ ok: true, value: '1' });
        expect(canonicalizeAmount('0,001', 6)).toEqual({ ok: true, value: '0.001' });
        expect(canonicalizeAmount('1.000000000', 6)).toEqual({ ok: true, value: '1' });
    });

    it('derives decimals the way the chain services do', () => {
        expect(sendDecimalsOf({ decimals: 8 })).toBe(8);
        expect(sendDecimalsOf({ chain: 'Solana', symbol: 'SOL' })).toBe(9);
        expect(sendDecimalsOf({ chain: 'Solana', symbol: 'USDC' })).toBe(6);
        expect(sendDecimalsOf({ chain: 'Base', symbol: 'USDC', isStablecoin: true })).toBe(6);
        expect(sendDecimalsOf({ chain: 'Base', symbol: 'ETH' })).toBe(18);
    });
});
