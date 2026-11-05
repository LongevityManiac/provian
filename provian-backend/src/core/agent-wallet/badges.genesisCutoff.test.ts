/**
 * activation P3 — the `genesis_agent` badge cutoff tracks the approved
 * Genesis admission close, not a stale hard-coded date.
 *
 * The defect: `GENESIS_CUTOFF` hard-coded `2026-06-30T23:59:59Z`, which is
 * BEFORE the approved Genesis window even opens (2026-08-03T00:00:00Z,). Under
 * the live window a genuine Genesis-era wallet (created 2026-08-03.. the close
 * 2027-01-01T00:00:00Z, i.e. through December 31, 2026) has `created_at > 2026-06-30`,
 * so it could NEVER earn the badge.
 *
 * These tests bind to the SINGLE approved-window source
 * (`PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms`) rather than re-declaring the
 * date — a stale second copy is the exact defect being fixed, so the test must
 * read what the code reads (self-referential-control avoidance).
 *
 * RED NEGATIVE CONTROL (recorded, and re-runnable):
 * Reverting badges.ts to the stale `new Date('2026-06-30T23:59:59Z').getTime()`
 * turns `earns the badge for a wallet created inside the approved window` RED
 * (an in-window wallet created 2026-08-15 then has created_at > cutoff and is
 * refused). Verified failing by hand before this file was accepted; the
 * in-window assertion below IS that control's live form.
 */
import { describe, expect, test } from '@jest/globals';
import { evaluateBadges } from './badges';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../pvt/policy/proposed-genesis-policy';
import type { AgentWalletDocument } from './types';

// The single source the code derives the cutoff from. If this is null the badge
// is fail-closed; these tests assert the approved-window behaviour, so they
// require it to be set (which it is, per).
const WINDOW = PROPOSED_GENESIS_CAMPAIGN_POLICY.window;
const CUTOFF = WINDOW.end_ms;

/** A wallet that qualifies for NOTHING except (possibly) genesis_agent. */
function walletCreatedAt(created_at: number): AgentWalletDocument {
  return {
    id: 'wallet_genesis_cutoff_test',
    agent_id: 'agent-genesis-cutoff',
    address: `0x${'a'.repeat(40)}`,
    status: 'active',
    governance_score: 0,
    pe_count: 0,
    economic_activity_usd: 0,
    badges: [],
    streak_days: 0,
    x402_payment_count: 0,
    linked_human_wallet_id: null,
    created_at,
    updated_at: created_at,
  } as unknown as AgentWalletDocument;
}

const earns = (created_at: number): boolean =>
  evaluateBadges({ wallet: walletCreatedAt(created_at) }).includes('genesis_agent');

describe('activation P3 · genesis_agent cutoff tracks the approved Genesis admission close', () => {
  test('the approved window is set (precondition for the behavioural assertions)', () => {
    // If this ever fails, the fail-closed branch is active and the assertions
    // below would be vacuous — so it is asserted, not assumed.
    expect(typeof CUTOFF).toBe('number');
    expect(CUTOFF).toBe(Date.UTC(2027, 0, 1, 0, 0, 0)); // 2027-01-01T00:00:00Z (open through 2026-12-31)
  });

  test('earns the badge for a wallet created inside the approved window (the fixed defect / RED control)', () => {
    // A genuine Genesis-era wallet. Under the STALE 2026-06-30 cutoff this was
    // false — that is the negative control this assertion embodies.
    const inWindow = Date.UTC(2026, 7, 15, 12, 0, 0); // 2026-08-15T12:00:00Z
    expect(inWindow).toBeGreaterThan(WINDOW.start_ms as number);
    expect(inWindow).toBeLessThan(CUTOFF as number);
    expect(earns(inWindow)).toBe(true);
  });

  test('the boundary is the admission close, inclusive, and bound to the single source', () => {
    // Exactly at the close earns (<= is inclusive); one ms after does not.
    expect(earns(CUTOFF as number)).toBe(true);
    expect(earns((CUTOFF as number) + 1)).toBe(false);
  });

  test('a wallet created after admission closes does not earn it', () => {
    const afterClose = (CUTOFF as number) + 30 * 24 * 60 * 60 * 1000; // +30 days
    expect(earns(afterClose)).toBe(false);
  });

  test('the stale 2026-06-30 cutoff would have excluded every Genesis-era wallet (why this was a defect)', () => {
    const staleCutoff = Date.UTC(2026, 5, 30, 23, 59, 59); // the old hard-coded value
    // Every instant in the approved window is AFTER the stale cutoff, so the old
    // check `created_at <= staleCutoff` refused all of them. This asserts the
    // window and the stale value actually conflict — the correction is real.
    expect(WINDOW.start_ms as number).toBeGreaterThan(staleCutoff);
    expect(CUTOFF as number).toBeGreaterThan(staleCutoff);
  });
});
