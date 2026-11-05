/**
 * Provenance Envelope chain constants.
 *
 * Phase 2.14 - Theme 7 fix. The string literal `'genesis'` was scattered
 * across writers and validators (server.ts, agent-wallet.ts, conformance,
 * pe-utils, etc.). Using a string literal is fragile: a typo in one
 * writer ("genesys", "GENESIS") would break the chain anchor and the
 * validator wouldn't catch it because the value would simply not match
 * the literal it checks for. Centralising the constant here means a
 * single source of truth and grep-able usage across the codebase.
 *
 * IMPORTANT: changing this value will invalidate every existing PE chain
 * anchored to the current sentinel. Do not change post-launch without
 * a migration plan.
 */

/**
 * Sentinel value used as `prev_hash` / `prev_envelope_hash` on the first
 * Provenance Envelope in a wallet's chain. Validators accept this value
 * OR a 64-char hex SHA-256 hash; everything else is rejected.
 */
export const GENESIS_PREV_HASH = 'genesis';

/**
 * Test-only sentinel. Used by the conformance test fixtures to assert
 * the validator accepts a non-prod genesis marker. Production writers
 * should never emit this value.
 */
export const TEST_GENESIS_PREV_HASH = 'test_genesis';
