/**
 * the kernel-exact emission shape for an institution linked-evidence PE.
 *
 * Stage 1b's emitter has to produce a PE that seals `eligible` AT RECORD TIME.
 * derived the conditions from the matrix; this suite PROVES them against
 * the REAL kernel, because a derivation is not a demonstration.
 *
 * It drives the REAL `recordPEAccrual` the same function the live emitters
 * call — for the three institution funding types, and asserts the sealed
 * `mint_disposition` on `pe_history`. Nothing here restates the policy table;
 * every expectation is read back out of the kernel's own output.
 *
 * THE SHAPE, proven by case A and by each negative case being NECESSARY:
 * durable inlet + evidenceState 'verified' + a canonical event id -> eligible
 *
 * Each of the three is load-bearing, and each has its own failing case, so none
 * of them can be dropped from the emitter without turning one of these red:
 * - best-effort inlet -> record_only (the cutover reconciliation durability fence)
 * - no canonical event id -> pending_evidence (awaiting_evidence)
 * - no `verified` verdict -> pending_evidence (this is TODAY's behaviour)
 *
 * Session lineage is deliberately covered too: these three types are NOT
 * lineage-gated, and asserting that stops a future emitter from carrying
 * lineage plumbing it does not need — or from assuming lineage would rescue a
 * row that is missing one of the three conditions above.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from '../beneficiary';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('../__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

jest.mock('../../../cache', () => ({
  cache: {
    getUserDailyPECountStrict: jest.fn(async () => 0),
    getUserActionTypeCountStrict: jest.fn(async () => 0),
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: jest.fn(async () => 1),
    incrementHourlyPECount: jest.fn(async () => {}),
    commitPEAccountingCountersOnce: jest.fn(async () => ({ idempotent: false })),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));

const mockResolveBeneficiary = jest.fn<
  (...args: unknown[]) => Promise<BeneficiaryCacheEntry>
>(async () => ({
  linked: false, humanWalletId: null, humanUserId: null,
  humanAddress: null, agentShareBps: null,
}));
jest.mock('../beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
jest.mock('../../jurisdiction/jurisdiction-policy', () => ({
  getJurisdictionPolicy: async () => 'immediate',
}));
jest.mock('../delegation-pe', () => ({
  isDelegationQualifying: () => false,
  createDelegationPE: async () => {},
}));
jest.mock('../../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'financial',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));

import { recordPEAccrual } from '../../../pvt-accrual';
import { PROPOSED_ACTION_POLICY_ENTRIES } from './proposed-action-policy';

const TIMESTAMP = Date.UTC(2026, 7, 3, 12, 0);
const CANONICAL_EVENT_ID = `8453:0x${'ab'.repeat(32)}:7`;
let seq = 0;

/**
 * The population is DERIVED from the policy table, never copied here: the
 * institution funding types are exactly the `verified_institution_lifecycle`
 * rows whose disposition is `eligible`. If a fourth is ever added, or one of
 * these is demoted, this suite covers the new set automatically instead of
 * silently continuing to assert a stale trio.
 */
const FUNDING_TYPES: readonly string[] = Object.freeze(
  PROPOSED_ACTION_POLICY_ENTRIES
    .filter((r) => r.evidence_requirement === 'verified_institution_lifecycle'
      && r.mint_disposition === 'eligible')
    .map((r) => r.action_type)
    .sort(),
);

interface Sealed {
  disposition: string;
  reasonCode: string;
  canonicalEventId: unknown;
}

async function seal(actionType: string, over: Record<string, unknown>): Promise<Sealed> {
  const peId = `pe_inst_shape_${seq++}`;
  await recordPEAccrual({
    peId,
    userId: 'agent1',
    actionType,
    integrationSource: 'institution_evidence_shape_test',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    deviceAttestationId: `device_${peId}`,
    ...over,
  } as Parameters<typeof recordPEAccrual>[0]);
  const row = mockDb.store.get(`pe_history/${peId}`) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`no pe_history row sealed for ${actionType}`);
  const snapshot = row.economic_snapshot as Record<string, unknown> | null;
  return {
    disposition: String(row.mint_disposition),
    reasonCode: String(
      row.mint_reason_code ?? (snapshot?.mintReasonCode as string | undefined) ?? '-',
    ),
    canonicalEventId: (
      snapshot?.recordTimeFactors as Record<string, unknown> | undefined
    )?.canonicalEventId,
  };
}

/** The emitter target: every condition satisfied. */
const EMITTER_SHAPE = Object.freeze({
  throwOnError: true,
  economicEvidenceState: 'verified',
  economicCanonicalEventId: CANONICAL_EVENT_ID,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveBeneficiary.mockResolvedValue({
    linked: false, humanWalletId: null, humanUserId: null,
    humanAddress: null, agentShareBps: null,
  });
  mockDb.store.clear();
  mockDb.ops.length = 0;
});

describe('institution linked-evidence PE — the population is real', () => {
  it('is a non-empty set derived from the policy table, not a copied list', () => {
    // A universally-quantified claim over zero rows proves nothing. If the
    // filter ever matches nothing, THIS fails rather than every case below
    // passing vacuously over an empty loop.
    expect(FUNDING_TYPES.length).toBeGreaterThan(0);
    // 3b grew this from the 3 funding types to 7 by reclassifying the 4
    // institution-completion types to `verified_institution_lifecycle`.
    // adds `escrow_disputed` (chain-witnessed dispute, parity with escrow_resolved)
    // → 8, in sorted position.
    expect(FUNDING_TYPES).toEqual([
      'escrow_completed', 'escrow_disputed', 'escrow_funded', 'escrow_resolved',
      'pool_contributed', 'pool_executed',
      'promise_funded', 'promise_settled',
    ]);
  });
});

describe('institution linked-evidence PE — the kernel-exact shape ', () => {
  it.each(FUNDING_TYPES)(
    '%s — durable + verified + canonical event id SEALS ELIGIBLE',
    async (actionType) => {
      const sealed = await seal(actionType, EMITTER_SHAPE);

      expect(sealed.disposition).toBe('eligible');
      expect(sealed.reasonCode).toBe('policy_eligible');
      // The id the emitter supplied is the id the kernel sealed — the
      // reorder is what makes a log-granular identity survive to here.
      expect(sealed.canonicalEventId).toBe(CANONICAL_EVENT_ID);
    },
  );

  it.each(FUNDING_TYPES)(
    '%s — NECESSARY #1: a best-effort inlet seals record_only',
    async (actionType) => {
      const sealed = await seal(actionType, { ...EMITTER_SHAPE, throwOnError: false });

      // The cutover reconciliation durability fence. An emitter that verifies the chain perfectly
      // and submits best-effort still pays nothing.
      expect(sealed.disposition).toBe('record_only');
    },
  );

  it.each(FUNDING_TYPES)(
    '%s — NECESSARY #2: no canonical event id seals pending_evidence',
    async (actionType) => {
      const sealed = await seal(actionType, {
        throwOnError: true,
        economicEvidenceState: 'verified',
      });

      expect(sealed.disposition).toBe('pending_evidence');
      expect(sealed.reasonCode).toBe('awaiting_evidence');
      expect(sealed.canonicalEventId).toBeNull();
    },
  );

  it.each(FUNDING_TYPES)(
    '%s — NECESSARY #3: no verified verdict seals pending_evidence (today)',
    async (actionType) => {
      const sealed = await seal(actionType, {
        throwOnError: true,
        economicCanonicalEventId: CANONICAL_EVENT_ID,
      });

      // This is what the three live emitters produce right now: the chain work
      // is done, the verdict is missing. It is the gap Stage 1b closes.
      expect(sealed.disposition).toBe('pending_evidence');
      expect(sealed.reasonCode).toBe('awaiting_evidence');
    },
  );

  it.each(FUNDING_TYPES)(
    '%s — session lineage is NOT a gate for these types',
    async (actionType) => {
      const withLineage = await seal(actionType, {
        ...EMITTER_SHAPE,
        economicSessionLineageId: 'pesl2_institution',
      });

      // Identical to case A. Recorded so the emitter is not built carrying
      // lineage plumbing it does not need, and so nobody assumes lineage could
      // rescue a row missing one of the three necessary conditions.
      expect(withLineage.disposition).toBe('eligible');
    },
  );
});
