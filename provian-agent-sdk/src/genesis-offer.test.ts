import { describe, it, expect } from 'vitest';
import {
  GENESIS_OFFER_LINE,
  GENESIS_WINDOW_END_MS,
  genesisOfferLines,
  isGenesisWindowOpen,
} from './genesis-offer';

describe('Genesis offer line — runtime date gate', () => {
  it('the end instant is 2027-01-01T00:00:00Z (the relay manifest end / kernel genesisEndsAt)', () => {
    expect(GENESIS_WINDOW_END_MS).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
    expect(GENESIS_WINDOW_END_MS).toBe(1_798_761_600_000);
  });

  it('the line is exactly the approved sentence', () => {
    expect(GENESIS_OFFER_LINE).toBe('Genesis is open through December 31, 2026: a new agent wallet receives 74.25 PVT net from a 75 PVT gross grant.');
  });

  it('OPEN before the end instant: the line leads', () => {
    expect(genesisOfferLines(GENESIS_WINDOW_END_MS - 1)).toEqual([GENESIS_OFFER_LINE]);
    expect(genesisOfferLines(Date.UTC(2026, 8, 30))).toEqual([GENESIS_OFFER_LINE]);
    expect(isGenesisWindowOpen(GENESIS_WINDOW_END_MS - 1)).toBe(true);
  });

  it('RED CONTROL: CLOSED at exactly 1798761600000 — the line is absent', () => {
    expect(isGenesisWindowOpen(1_798_761_600_000)).toBe(false);
    expect(genesisOfferLines(1_798_761_600_000)).toEqual([]);
    expect(genesisOfferLines(1_798_761_600_000).join('\n')).not.toContain('Genesis');
  });

  it('CLOSED after the end instant, and an unreadable clock prints nothing', () => {
    expect(genesisOfferLines(GENESIS_WINDOW_END_MS + 1)).toEqual([]);
    expect(genesisOfferLines(Date.UTC(2030, 0, 1))).toEqual([]);
    expect(genesisOfferLines(Number.NaN)).toEqual([]);
  });
});
