import { describe, it, expect } from 'vitest';
import { isValidTimestamp, safeFormatDate } from './safeDate';

// Pass-3 #14: date-fns `format(new Date(bad))` throws RangeError('Invalid time
// value'). A crafted promise QR/deep-link can carry a non-numeric dueDate/
// timestamp that persists and then crashes the whole Promises tab on every
// render. safeFormatDate must NEVER throw — it returns a fallback instead.

describe('isValidTimestamp', () => {
  it('accepts a finite epoch-ms number', () => {
    expect(isValidTimestamp(1893456000000)).toBe(true);
    expect(isValidTimestamp(0)).toBe(true);
  });

  it('rejects non-numbers, NaN, and Infinity', () => {
    expect(isValidTimestamp('abc')).toBe(false);
    expect(isValidTimestamp('1893456000000')).toBe(false); // numeric string
    expect(isValidTimestamp(NaN)).toBe(false);
    expect(isValidTimestamp(Infinity)).toBe(false);
    expect(isValidTimestamp(undefined)).toBe(false);
    expect(isValidTimestamp(null)).toBe(false);
    expect(isValidTimestamp({})).toBe(false);
    expect(isValidTimestamp([])).toBe(false);
  });
});

describe('safeFormatDate', () => {
  it('formats a valid timestamp (timezone-agnostic shape)', () => {
    const out = safeFormatDate(1893456000000, 'yyyy-MM-dd');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out).not.toBe('—');
  });

  it('returns the fallback (never throws) for the exact crash inputs from #14', () => {
    // These are the values date-fns would throw on: a bare `format(new Date(x))`
    // call would raise "Invalid time value" and take down the whole tab.
    expect(() => safeFormatDate('abc', 'MMM d')).not.toThrow();
    expect(safeFormatDate('abc', 'MMM d')).toBe('—');
    expect(safeFormatDate(NaN, 'MMM d')).toBe('—');
    expect(safeFormatDate(undefined, 'MMM d')).toBe('—');
    expect(safeFormatDate({ evil: true }, 'MMM d')).toBe('—');
  });

  it('honors a custom fallback', () => {
    expect(safeFormatDate('abc', 'MMM d', 'n/a')).toBe('n/a');
  });
});
