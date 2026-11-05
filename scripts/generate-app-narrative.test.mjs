import { describe, expect, it } from 'vitest';
import { numericFactsMatch, validateNarrative } from './generate-app-narrative.mjs';

// The narrative validator's numeric-fact guard: amounts must survive translation in order;
// only the parts of a calendar date may move (and a CJK/Vietnamese month numeral is allowed).
const EN = 'Through December 31, 2026, creating your wallet brings you 75 PVT. Connect it for 25 PVT more. Its own 75 PVT.';

describe('narrative numeric facts', () => {
  it('accepts a translation that reorders only the date parts', () => {
    expect(numericFactsMatch('2026年12月31日まで、75 PVT。25 PVT。75 PVT。', EN)).toBe(true);
    expect(numericFactsMatch('Hasta el 31 de diciembre de 2026, 75 PVT. 25 PVT más. 75 PVT.', EN)).toBe(true);
    expect(numericFactsMatch('Đến ngày 31 tháng 12 năm 2026, 75 PVT. 25 PVT. 75 PVT.', EN)).toBe(true);
  });

  // RED controls: each must be refused.
  it('RED - refuses two swapped amounts', () => {
    expect(numericFactsMatch('Hasta el 31 de diciembre de 2026, 25 PVT. 75 PVT más. 75 PVT.', EN)).toBe(false);
  });
  it('RED - refuses a changed amount, a dropped date, and an extra number', () => {
    expect(numericFactsMatch('31 de diciembre de 2026, 75 PVT. 25 PVT. 57 PVT.', EN)).toBe(false);
    expect(numericFactsMatch('75 PVT. 25 PVT. 75 PVT.', EN)).toBe(false);
    expect(numericFactsMatch('31 de diciembre de 2026, 75 PVT. 25 PVT. 75 PVT. 99', EN)).toBe(false);
  });
  it('RED - validateNarrative throws on a swapped amount', () => {
    const english = { 'k.v': EN };
    expect(() => validateNarrative({ 'k.v': 'Hasta el 31 de diciembre de 2026, 25 PVT. 75 PVT más. 75 PVT.' }, english, 'es')).toThrow(/numeric facts differ/);
  });
});
