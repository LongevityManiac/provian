import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { parseFeaturedBid, savedBidBurnPvt, formatPvt, FEATURED_BID_MIN_PVT } from './featuredBid';

const PVT = 10n ** 18n;

describe('parseFeaturedBid (the person picks the amount, floor 15, no ceiling)', () => {
  it('accepts the floor and any amount above it, with no ceiling', () => {
    expect(parseFeaturedBid('15')).toEqual({ ok: true, pvt: '15', atomic: 15n * PVT });
    expect(parseFeaturedBid('25.5')).toEqual({ ok: true, pvt: '25.5', atomic: 255n * PVT / 10n });
    expect(parseFeaturedBid(' 1000000 ')).toEqual({ ok: true, pvt: '1000000', atomic: 1_000_000n * PVT });
    expect(parseFeaturedBid('15.000000000000000001')).toMatchObject({ ok: true, atomic: 15n * PVT + 1n });
  });

  it('accepts a decimal comma', () => {
    expect(parseFeaturedBid('20,25')).toMatchObject({ ok: true, pvt: '20.25' });
  });

  it('the amount it returns is exactly what the burn broadcasts (parseUnits round-trip)', () => {
    const r = parseFeaturedBid('37.125');
    expect(r.ok && ethers.parseUnits(r.pvt, 18)).toBe(37125n * PVT / 1000n);
  });

  it('RED: below the floor is refused before anything is burned', () => {
    expect(parseFeaturedBid('14.999999999999999999')).toEqual({ ok: false, reason: 'below_floor' });
    expect(parseFeaturedBid('0')).toEqual({ ok: false, reason: 'below_floor' });
  });

  it('RED: malformed input is refused', () => {
    for (const bad of ['-20', '1e3', '20.', '.5', 'abc', '20 PVT', '15.0000000000000000001', '0x20']) {
      expect(parseFeaturedBid(bad)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(parseFeaturedBid('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('RED: "15,000" is refused, never burned as 15 PVT (a thousands separator is not a decimal comma)', () => {
    expect(parseFeaturedBid('15,000')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseFeaturedBid('1,000,000')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('RED: an absurdly long amount is refused, never thrown (the sheet parses on every render)', () => {
    expect(() => parseFeaturedBid('9'.repeat(200))).not.toThrow();
    expect(parseFeaturedBid('9'.repeat(200))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('the floor constant is 15 PVT', () => {
    expect(FEATURED_BID_MIN_PVT).toBe('15');
  });
});

describe('savedBidBurnPvt', () => {
  it('offers the largest saved burn at or above the floor', () => {
    expect(savedBidBurnPvt([{ amountAtomic: (5n * PVT).toString() }, { amountAtomic: (40n * PVT).toString() }, { amountAtomic: (15n * PVT).toString() }])).toBe('40');
  });
  it('RED: nothing saved, or only sub-floor / malformed saves → null', () => {
    expect(savedBidBurnPvt([])).toBeNull();
    expect(savedBidBurnPvt([{ amountAtomic: (5n * PVT).toString() }, { amountAtomic: 'x' }])).toBeNull();
  });
  it('formatPvt drops a trailing .0', () => {
    expect(formatPvt(15n * PVT)).toBe('15');
    expect(formatPvt(155n * PVT / 10n)).toBe('15.5');
  });
});
