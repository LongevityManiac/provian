import {
  PE_COUNT_THRESHOLD_ENV,
  SINGLE_PE_PUSH_THRESHOLD_ENV,
  pvtDecimalToAtomic,
  readOpsPolicyThresholds,
} from './diagnostic-thresholds';

describe('operational policy telemetry thresholds', () => {
  it('parses exact 18-decimal PVT values without floating point', () => {
    expect(pvtDecimalToAtomic('1.000000000000000001')).toBe(1_000_000_000_000_000_001n);
  });

  it('defaults to 25 PVT for the digest count and 250 PVT for push', () => {
    const thresholds = readOpsPolicyThresholds({});
    expect(thresholds.pe_count.atomic).toBe(25n * 10n ** 18n);
    expect(thresholds.single_pe_push.atomic).toBe(250n * 10n ** 18n);
  });

  it('reads ops config independently and fails invalid values back to defaults', () => {
    const thresholds = readOpsPolicyThresholds({
      [PE_COUNT_THRESHOLD_ENV]: '12.5',
      [SINGLE_PE_PUSH_THRESHOLD_ENV]: 'not-a-number',
    });
    expect(thresholds.pe_count).toMatchObject({ pvt: '12.5', used_default: false });
    expect(thresholds.pe_count.atomic).toBe(12_500_000_000_000_000_000n);
    expect(thresholds.single_pe_push).toMatchObject({ pvt: '250', used_default: true });
  });
});
