/**
 * governance boundary — membership and governance readiness, DORMANT-ONLY.
 *
 * the operator’s approved immutable-vs-governable table (plan §4) classifies
 * governance "absent", and no separate governance-activation or
 * authority-handoff decision exists. governance boundary therefore builds NO new governance
 * or membership structure; it removes the latent `badge_earned: 3` weight
 * entry bond lifecycle flagged and PINS the existing dormancy so a later change that
 * would activate governance or membership authority — or re-introduce a
 * badge-driven weight — fails a test instead of shipping silently.
 *
 * The pins, by layer:
 * 1. Badge weight : badges are record-only and mint zero PVT.
 * No explicit tier entry may exist for a badge action type, and the
 * delegation-PE qualifier must not treat a badge as directed work.
 * 2. Network boundary: every governance and PVT-admin path fails closed
 * through the runtime boundary runtime boundary — including the admin-key
 * governance-review weight applier and the operational-governance
 * vote path.
 * 4. Full-governance predicate: no approved agent-owned hardware
 * predicate exists, so deriveFullGovernance can never return true —
 * the +40 score band is unreachable regardless of stored flags.
 *
 * Related existing pins (not duplicated here):
 * - Foundation membership seam ignores stale env enablement/address vars
 * and never queues for agent owners: client.shortCircuit.test.ts,
 * pvt-accrual.foundationHook.test.ts (invariant #54).
 * - Badge mint-zero: wp-ev/eligibility.test.ts (ZERO_MINT_ACTION_TYPES),
 * estimate.test.ts (hard 0), proposed-policy-manifests.test.ts
 * (record_only), pvt-accrual.acceptance.test.ts (policy_record_only).
 */

import { describe, expect, it, jest } from '@jest/globals';

// delegation-pe.ts transitively imports firebase-admin, the PE batch writer,
// pvt-accrual, and the Redis cache at module level. isDelegationQualifying is
// pure; mock the heavy siblings exactly like delegation-pe.test.ts does.
jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: () => ({}) }) },
}));
jest.mock('../../pe-batch-writer', () => ({
  getPEBatchWriter: () => ({ enqueue: jest.fn() }),
}));
jest.mock('../../pvt-accrual', () => ({
  recordPEAccrual: jest.fn(async () => {}),
}));
jest.mock('../../cache', () => ({
  cache: { get: jest.fn(async () => null), set: jest.fn(async () => {}) },
}));

import {
  getActionTypeTier,
  getAllTierAssignments,
  PE_CATEGORIES,
} from './pe-weight-framework';
import { isDelegationQualifying } from './delegation-pe';
import { classifyPvt9RuntimeRequest } from './wp2-runtime-boundary';
// deriveFullGovernance and the governance-score module are deleted; the
// section-4 "full-governance stays dormant" block is removed (the mechanism no
// longer exists to test).

const BADGE_ACTION_TYPES = ['badge_earned', 'pvt_badge_projection_completed'] as const;

// =============================================================================
// 1. Badge weight removal
// =============================================================================

describe('governance boundary badge action types carry no latent weight', () => {
  it.each(BADGE_ACTION_TYPES)(
    'has no explicit tier entry for %s',
    (actionType) => {
      expect(getAllTierAssignments()).not.toHaveProperty(actionType);
    },
  );

  it.each(BADGE_ACTION_TYPES)(
    'resolves %s to the DEFAULT_TIER fallback (2), below every significant band',
    (actionType) => {
      expect(getActionTypeTier(actionType)).toBe(2);
    },
  );

  it.each(BADGE_ACTION_TYPES)(
    'never treats %s as delegation-qualifying directed work',
    (actionType) => {
      expect(isDelegationQualifying(actionType)).toBe(false);
    },
  );

  it('keeps badge_earned classified (infrastructure) — records, not weight', () => {
    expect(PE_CATEGORIES.infrastructure).toContain('badge_earned');
  });
});

// =============================================================================
// 2. Network boundary: governance + PVT-admin paths fail closed
// =============================================================================

describe('governance boundary: governance and PVT-admin surfaces stay behind the runtime boundary boundary', () => {
  const blockedRows: Array<[string, string, string]> = [
    // The admin-key governance-review weight applier (relay-bridge caller).
    ['POST', '/v1/admin/pvt/weights/governance/review/7', 'legacy_pvt_admin'],
    // Even the read-only admin weight surfaces fail closed.
    ['GET', '/v1/admin/pvt/weights/audit-log', 'legacy_pvt_admin'],
    // Economic governance (dormant human-wallet model).
    ['GET', '/v1/governance/voter/me', 'legacy_economic_governance'],
    ['POST', '/v1/governance/proposals/1/vote', 'legacy_economic_governance'],
    // Operational (agent) governance rides the same namespace block.
    ['POST', '/v1/governance/operational/vote', 'legacy_economic_governance'],
    ['GET', '/v1/governance/operational/proposals', 'legacy_economic_governance'],
    // Commons governance institution surface.
    ['GET', '/v1/commons/governance/proposals', 'governance'],
  ];

  it.each(blockedRows)(
    '%s %s is blocked (%s)',
    (method, path, dependency) => {
      const decision = classifyPvt9RuntimeRequest(method, path);
      expect(decision.blocked).toBe(true);
      expect(decision.dependency).toBe(dependency);
    },
  );
});

