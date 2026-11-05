import { describe, expect, it } from '@jest/globals';
import { isMeterClaimKey } from './meter-claims';

describe('isMeterClaimKey — the settlement store routes a ledger row to the meter only on these shapes', () => {
  it('accepts batch, device-act, relay-act and top-up keys', () => {
    expect(isMeterClaimKey(`mb_${'a'.repeat(48)}`)).toBe(true);
    expect(isMeterClaimKey(`ma_pe_m_${'b'.repeat(48)}_sole`)).toBe(true);
    expect(isMeterClaimKey('ma_pe_3f2a9c1e-7d4b-4c1a-9e2f-0a1b2c3d4e5f_agent')).toBe(true);
    expect(isMeterClaimKey(`mt_pe_m_${'c'.repeat(48)}_beneficiary`)).toBe(true);
    // : a batch's window claim (and its slices).
    expect(isMeterClaimKey(`mw_${'d'.repeat(48)}`)).toBe(true);
  });
  it('RED: pre-meter pe ids and malformed keys are not meter claims', () => {
    for (const id of ['pe_3f2a9c1e', 'pe-1', 'pe-g-4', `mb_${'a'.repeat(47)}`, 'ma_pe_x_notaleg', 'mx_pe_x_sole', `mb_${'A'.repeat(48)}`, `mw_${'d'.repeat(47)}`, 'mw_pe_x_sole']) {
      expect(isMeterClaimKey(id)).toBe(false);
    }
  });
});
