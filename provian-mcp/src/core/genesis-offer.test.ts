import { describe, expect, it } from 'vitest';
import { GENESIS_OFFER_LINE, GENESIS_WINDOW_END_MS, genesisOfferLines, isGenesisWindowOpen } from './genesis-offer';
import { serverInstructions } from './server';

describe('Genesis offer line — runtime date gate (MCP)', () => {
  it('the end instant is 2027-01-01T00:00:00Z and the line is the approved sentence', () => {
    expect(GENESIS_WINDOW_END_MS).toBe(Date.UTC(2027, 0, 1));
    expect(GENESIS_OFFER_LINE).toBe('Genesis is open through December 31, 2026: a new agent wallet receives 74.25 PVT net from a 75 PVT gross grant.');
  });

  it('OPEN before the end: the line; the initialize instructions LEAD with it', () => {
    expect(isGenesisWindowOpen(GENESIS_WINDOW_END_MS - 1)).toBe(true);
    expect(genesisOfferLines(GENESIS_WINDOW_END_MS - 1)).toEqual([GENESIS_OFFER_LINE]);
    expect(serverInstructions(GENESIS_WINDOW_END_MS - 1).startsWith(`${GENESIS_OFFER_LINE} Provian is the trust layer`)).toBe(true);
  });

  it('RED CONTROL: CLOSED at exactly 1798761600000 — absent from the lines and the instructions', () => {
    expect(isGenesisWindowOpen(1_798_761_600_000)).toBe(false);
    expect(genesisOfferLines(1_798_761_600_000)).toEqual([]);
    const closed = serverInstructions(1_798_761_600_000);
    expect(closed).not.toContain('Genesis is open');
    expect(closed.startsWith('Provian is the trust layer')).toBe(true);
  });

  it('after the end, and with an unreadable clock, nothing is added', () => {
    expect(genesisOfferLines(GENESIS_WINDOW_END_MS + 86_400_000)).toEqual([]);
    expect(genesisOfferLines(Number.NaN)).toEqual([]);
  });
});
