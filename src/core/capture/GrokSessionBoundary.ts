/**
 * Grok timestamp-gap session boundary detector.
 *
 * Grok does not expose session IDs in its URL structure, so session
 * boundaries are driven by interaction-gap timestamps rather than URL
 * changes. See CAPTURE_ARCHITECTURE.md §6 and PHASE_2B_DESIGN_NOTES.md §6
 * for the cross-surface rationale.
 *
 * Scope of this module (M2): pure-function detector plus a catalog-driven
 * gap-seconds helper. The detector is consumed by the full mobile session
 * state machine in M3; no caller wires it in M2.
 *
 * The detector is pure. Time is passed in as arguments; callers supply
 * `Date.now()`. This keeps the function deterministic and trivially
 * testable without mocking clocks.
 */

import { getProvider } from './ProviderCatalog';
import type { ProviderCatalog, ProviderEntry } from './ProviderCatalog';

export const GROK_PROVIDER_ID = 'grok';

/**
 * Default gap used only when the catalog entry is missing or malformed.
 * The canonical value lives in `ai-providers.json` and matches the desktop
 * catalog. This fallback exists so a caller cannot trigger an uncaught
 * exception on a misconfigured catalog at the session-boundary layer;
 * catalog validation at module load already rejects malformed catalogs
 * in production.
 */
export const GROK_DEFAULT_GAP_SECONDS = 300;

/**
 * Return true when the interval `[lastInteractionMs, nowMs]` exceeds the
 * configured gap and a new Grok session should be considered started.
 *
 * Semantics:
 *   - Inside gap (elapsed <= gap * 1000):   returns false.
 *   - At gap   (elapsed == gap * 1000):     returns false (strict >).
 *   - Past gap (elapsed >  gap * 1000):     returns true.
 *   - Zero elapsed:                          returns false.
 *   - Negative elapsed (clock skew):         returns false and emits a
 *     one-line warning. The caller should not re-evaluate on skew; M3 will
 *     re-base `lastInteractionMs` to `nowMs` when this path triggers.
 */
export function detectGrokBoundary(
    lastInteractionMs: number,
    nowMs: number,
    gapSeconds: number,
): boolean {
    const elapsed = nowMs - lastInteractionMs;
    if (elapsed < 0) {
        console.warn(
            `[GrokSessionBoundary] negative elapsed (${elapsed} ms) between ` +
                `lastInteractionMs=${lastInteractionMs} and nowMs=${nowMs}; ` +
                'likely a clock adjustment. Treating as no boundary.',
        );
        return false;
    }
    return elapsed > gapSeconds * 1000;
}

/**
 * Read Grok's timestamp-gap value from the catalog in seconds. Returns
 * `GROK_DEFAULT_GAP_SECONDS` if the catalog is missing the entry or the
 * entry has a non-timestamp-gap boundary mode, which should never happen
 * in a validated catalog but is guarded here because this function runs
 * on the hot path during session evaluation.
 */
export function getGrokGapSeconds(catalog: ProviderCatalog): number {
    const entry: ProviderEntry | null = getProvider(GROK_PROVIDER_ID, catalog);
    if (!entry) return GROK_DEFAULT_GAP_SECONDS;
    if (entry.session_boundary !== 'timestamp_gap') return GROK_DEFAULT_GAP_SECONDS;
    const gap = entry.timestamp_gap_seconds;
    if (typeof gap !== 'number' || !Number.isFinite(gap) || gap <= 0) {
        return GROK_DEFAULT_GAP_SECONDS;
    }
    return gap;
}
