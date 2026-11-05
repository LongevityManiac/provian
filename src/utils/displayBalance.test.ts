import { describe, expect, it } from 'vitest';
import { displayBalance } from './displayBalance';

describe('displayBalance', () => {
    it('trims trailing zeros and a bare decimal point', () => {
        expect(displayBalance('0.000000')).toBe('0');
        expect(displayBalance('0.00')).toBe('0');
        expect(displayBalance('10.00')).toBe('10');
        expect(displayBalance('1.500000')).toBe('1.5');
        expect(displayBalance('100.0500')).toBe('100.05');
    });

    it('never touches significant digits (including zeros before the point)', () => {
        expect(displayBalance('100')).toBe('100');
        expect(displayBalance('100.0')).toBe('100');
        expect(displayBalance('0.000001')).toBe('0.000001');
    });

    it('leaves non-plain-decimal strings unchanged', () => {
        expect(displayBalance('1,234.50')).toBe('1,234.50');
        expect(displayBalance('')).toBe('');
        expect(displayBalance('abc')).toBe('abc');
    });
});
