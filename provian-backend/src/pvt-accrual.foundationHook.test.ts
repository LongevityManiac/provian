/**
 * Pass-2 #6 regression: the mobile first-PE accrual path must queue an
 * initial Foundation-membership grant.
 *
 * The 0→1 Foundation-membership hook queues the grant ONLY when the caller
 * supplies `ownerType: 'human'` AND a `walletAddress`. The mobile relay sites
 * (/v1/wallet/human/register, /v1/pe/submit/mobile, /v1/relay/action) used to
 * omit both, so mobile users never queued a grant even with the flag on. These
 * tests drive the real recordPEAccrual and assert the hook fires iff those
 * fields are present - and NEVER for an agent owner (invariant #54).
 *
 * activation P4 / the hook is now applied through the same idempotent
 * derived-effect outbox the durable lane uses (`applyFirestoreEffects` computes
 * `foundation_membership_required` on the 0→1 transition; `resumeDurableAccrual-
 * Effects` queues it), so this test drives the REAL writePEHistory + resume
 * against a fake Firestore rather than a permissive stub. The decision under
 * test and every assertion are unchanged; only the mock fidelity is raised so
 * the co-committed outbox actually exists for the applicator to consume.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';

// --- firebase-admin: realistic fake Firestore singleton shared by
// recordPEAccrual + writePEHistory + resumeDurableAccrualEffects (all call
// admin.firestore()), so the co-committed pvt_accrual_effects outbox is real. ---
let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./core/pvt/__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

const mockQueueInitialMembershipGrants = jest.fn();
const mockLoadFoundationMembershipConfig = jest.fn();
jest.mock('./core/foundation-membership/client', () => ({
  __esModule: true,
  loadFoundationMembershipConfig: (...a: unknown[]) => mockLoadFoundationMembershipConfig(...a),
  queueInitialMembershipGrants: (...a: unknown[]) => mockQueueInitialMembershipGrants(...a),
}));

jest.mock('./cache', () => ({
  __esModule: true,
  cache: {
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    incrementUserActionTypeCount: async () => undefined,
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => undefined,
    incrementHourlyPECount: async () => undefined,
    commitPEAccountingCountersOnce: async () => ({ idempotent: false }),
    isEnabled: () => true,
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));

jest.mock('./core/jurisdiction/jurisdiction-policy', () => ({
  __esModule: true,
  getJurisdictionPolicy: async () => 'immediate',
}));

jest.mock('./core/pvt/pe-weight-framework', () => ({
  __esModule: true,
  calculatePEWeight: () => ({ estimatedPVT: 1, breakdown: {} }),
  resolveOverride: async () => null,
  getEffectiveAttestationMultiplier: async () => 1,
  normalizeAttestationTier: (value: string) => value === 'hardware' ? 'hardware_full' : value,
}));

jest.mock('./core/pvt/beneficiary', () => ({
  __esModule: true,
  resolveBeneficiary: async () => ({
    linked: false,
    humanWalletId: null,
    humanUserId: null,
    humanAddress: null,
    agentShareBps: null,
  }),
}));

jest.mock('./device-pe-rate-limiter', () => ({
  __esModule: true,
  isDeviceRateLimited: () => false,
  checkDevicePERateLimit: async () => ({ allowed: true, anchor: 'device_id' }),
}));

jest.mock('./core/pvt/commit-mint-claim', () => ({
  __esModule: true,
  claimCommitMint: async () => true,
}));

jest.mock('./core/pvt/delegation-pe', () => ({
  __esModule: true,
  createDelegationPE: async () => undefined,
  isDelegationQualifying: () => false,
}));

jest.mock('./core/provenance/pe-type-catalog', () => ({
  __esModule: true,
  recordActionTypeObservation: async () => undefined,
  getCategoryForActionType: async () => 'uncategorized',
}));

import { recordPEAccrual } from './pvt-accrual';

const WALLET = '0x1234567890abcdef1234567890abcdef12345678';

/** Flush the microtask + macrotask queue so the fire-and-forget hook runs. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function baseParams(overrides: Partial<Parameters<typeof recordPEAccrual>[0]> = {}) {
  return {
    peId: 'pe_first',
    userId: 'user_first',
    actionType: 'wallet_created',
    integrationSource: 'pvt_accrual_foundation_hook_test',
    attestationDepth: 'hardware',
    peHash: 'hash_first',
    timestamp: Date.UTC(2026, 6, 4, 12, 0),
    ...overrides,
  };
}

describe('recordPEAccrual Foundation hook (Pass-2 #6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.store.clear();
    mockDb.ops.length = 0;
    mockLoadFoundationMembershipConfig.mockReturnValue({
      enabled: true,
      chains: [{ chainId: 8453, networkName: 'base', contractAddress: '0xFM' }],
    });
  });

  it('queues a grant on the first PE when ownerType=human + walletAddress (the fix)', async () => {
    await recordPEAccrual(baseParams({ ownerType: 'human', walletAddress: WALLET }));
    await flush();
    expect(mockQueueInitialMembershipGrants).toHaveBeenCalledTimes(1);
    const args = mockQueueInitialMembershipGrants.mock.calls[0];
    expect(args[2]).toBe('user_first'); // userId
    expect(args[3]).toBe(WALLET);       // walletAddress
  });

  it('does NOT queue when ownerType + walletAddress are omitted (the prior mobile bug)', async () => {
    await recordPEAccrual(baseParams());
    await flush();
    expect(mockQueueInitialMembershipGrants).not.toHaveBeenCalled();
  });

  it('does NOT queue for an agent owner even with a walletAddress (invariant #54)', async () => {
    // Seed the agent's own wallet so the applicator RESOLVES its refs and the
    // Foundation gate is actually evaluated. Without this, resolveRefs throws
    // `durable_accrual_agent_wallet_unresolved` before the gate, and the "never
    // queue" assertion would pass for the wrong reason (the throw, not the gate).
    mockDb.store.set('agent_wallets/user_first', { agent_id: 'user_first', platform: 'live' });
    await recordPEAccrual(baseParams({ ownerType: 'agent', walletAddress: WALLET }));
    await flush();
    // Proof the applicator ran THROUGH the Foundation gate (outbox completed),
    // so the assertion below exercises the gate rather than a resolve throw.
    expect((mockDb.store.get('pvt_accrual_effects/pe_first') as { state?: string } | undefined)?.state)
      .toBe('complete');
    // The gate refused to queue Foundation membership for an agent owner.
    expect(mockQueueInitialMembershipGrants).not.toHaveBeenCalled();
  });

  it('does NOT queue for a human with a null walletAddress (gate needs the address)', async () => {
    await recordPEAccrual(baseParams({ ownerType: 'human', walletAddress: null }));
    await flush();
    expect(mockQueueInitialMembershipGrants).not.toHaveBeenCalled();
  });
});
