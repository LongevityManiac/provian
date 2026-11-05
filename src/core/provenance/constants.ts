/**
 * Provenance Envelope chain constants - mobile side.
 *
 * Phase 2.14 - Theme 7 fix. Mirrors provian-backend/src/core/pe/constants.ts.
 * Centralising the genesis sentinel keeps writers and validators in sync
 * across the device, the backend, and the conformance suite.
 *
 * Changing this value invalidates every existing PE chain anchored to the
 * current sentinel - do not change post-launch without a migration plan.
 */

/**
 * Sentinel value used as `prev_envelope_hash` on the first Provenance
 * Envelope in a wallet's chain. The relay validator accepts this value
 * OR a 64-char hex SHA-256 hash; everything else is rejected.
 */
export const GENESIS_PREV_HASH = 'genesis';
