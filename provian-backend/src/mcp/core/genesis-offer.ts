/**
 * The Genesis offer line — LEADS the MCP server's startup output (stdio banner on
 * stderr) and its initialize `instructions` while the Genesis window is open, and
 * is absent after it closes. A runtime date check: the line retires itself at the
 * window's end with no republish or redeploy.
 *
 * SHARED CORE — canonical in `provian-mcp/src/core/`, mirrored into
 * `provian-backend/src/mcp/core/` (scripts/sync-mcp-core.sh). Edit only the
 * canonical copy. The relay's hosted bootstrap script builder also reads this
 * constant from the mirror, so the backend defines it exactly once.
 */

/**
 * 2027-01-01T00:00:00Z in ms — the Genesis window's END (exclusive). This is the
 * relay's checked-in Genesis campaign manifest `window.end_ms`
 * (PROPOSED_GENESIS_CAMPAIGN_POLICY, open through December 31, 2026) and the
 * live PVT9 kernel's on-chain `genesisEndsAt` (1798761600 s). If the manifest
 * or the kernel ever moves the close, move this with it.
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
