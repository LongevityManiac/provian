/**
 * C8 (Pass-2 Human-Jobs seams): fixed-PVT jobs must render their escrow amount,
 * not "Negotiable". Tests the pure compensation/budget formatter.
 */
import { describe, it, expect } from 'vitest';
import { formatPvtAtomic, formatHumanJobCompensation } from './humanJobFormat';

describe('formatPvtAtomic', () => {
  it('renders whole PVT without decimals', () => {
    expect(formatPvtAtomic('1000000000000000000')).toBe('1');
    expect(formatPvtAtomic('5000000000000000000')).toBe('5');
    expect(formatPvtAtomic('250000000000000000000')).toBe('250');
  });

  it('renders fractional PVT to two decimals', () => {
    expect(formatPvtAtomic('1500000000000000000')).toBe('1.50');
    expect(formatPvtAtomic('1230000000000000000')).toBe('1.23');
    expect(formatPvtAtomic('990000000000000000')).toBe('0.99'); // < 1 PVT
  });

  it('returns null for empty / zero / malformed input', () => {
    expect(formatPvtAtomic(undefined)).toBeNull();
    expect(formatPvtAtomic(null)).toBeNull();
    expect(formatPvtAtomic('')).toBeNull();
    expect(formatPvtAtomic('0')).toBeNull();
    expect(formatPvtAtomic('not-a-number')).toBeNull();
    expect(formatPvtAtomic('-1000000000000000000')).toBeNull();
  });
});

describe('formatHumanJobCompensation', () => {
  it('renders a fixed PVT budget (C8 regression — was "Negotiable")', () => {
    expect(formatHumanJobCompensation({ budget_pvt: '5000000000000000000' })).toBe('5 PVT');
    expect(formatHumanJobCompensation({ budget_pvt: '1500000000000000000' })).toBe('1.50 PVT');
  });

  it('prefers budget_pvt over the deprecated USDC field', () => {
    expect(
      formatHumanJobCompensation({ budget_pvt: '2000000000000000000', compensation_amount: 99 }),
    ).toBe('2 PVT');
  });

  it('falls through to legacy USDC when budget_pvt is absent or zero', () => {
    expect(formatHumanJobCompensation({ compensation_amount: 10 })).toBe('10 USDC');
    expect(
      formatHumanJobCompensation({ compensation_amount: 10, compensation_currency: 'usd' }),
    ).toBe('10 USD');
    expect(
      formatHumanJobCompensation({ budget_pvt: '0', compensation_amount: 7 }),
    ).toBe('7 USDC');
  });

  it('falls through to the legacy pvt_amount number field', () => {
    expect(formatHumanJobCompensation({ pvt_amount: 3 })).toBe('3 PVT');
  });

  it('returns "Negotiable" only when nothing is set', () => {
    expect(formatHumanJobCompensation({})).toBe('Negotiable');
  });

  it('renders a USDC budget in dollars', () => {
    expect(formatHumanJobCompensation({ currency: 'usdc', budget_usdc: 12.5 })).toBe('12.50 USDC');
    expect(formatHumanJobCompensation({ currency: 'usdc', budget_usdc: 25 })).toBe('25 USDC');
    expect(formatHumanJobCompensation({ currency: 'usdc', budget_usdc: 0.000001 })).toBe('0.000001 USDC');
  });
});
