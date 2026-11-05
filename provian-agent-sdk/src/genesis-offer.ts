/**
 * The Genesis offer line — printed FIRST by the install/onboard output while the
 * Genesis window is open, and not at all after it closes. A runtime date check:
 * the line retires itself at the window's end with no release or deploy.
 */

/**
 * 2027-01-01T00:00:00Z in ms — the Genesis window's END (exclusive). This is the
 * relay's checked-in Genesis campaign manifest `window.end_ms` (open through
 * December 31, 2026) and the live PVT9 kernel's on-chain `genesisEndsAt`
 * (1798761600 s). If the relay manifest or the kernel ever moves the close, move
 * this with it.
 */
export const GENESIS_WINDOW_END_MS = 1_798_761_600_000;

export const GENESIS_OFFER_LINE =
  'Genesis is open through December 31, 2026: a new agent wallet receives 74.25 PVT net from a 75 PVT gross grant.';

/** True while the Genesis window is open (strictly before its end instant). */
export function isGenesisWindowOpen(nowMs: number = Date.now()): boolean {
  return Number.isFinite(nowMs) && nowMs < GENESIS_WINDOW_END_MS;
}

/** The lines to lead the output with: the offer while open, nothing after. */
export function genesisOfferLines(nowMs: number = Date.now()): string[] {
  return isGenesisWindowOpen(nowMs) ? [GENESIS_OFFER_LINE] : [];
}
