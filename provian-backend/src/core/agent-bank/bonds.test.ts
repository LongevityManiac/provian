/**
 * Insurance Bonds - Unit Tests (Phase 5)
 *
 * Tests bond sizing, trust discount computation, self-claim rejection,
 * withdrawal blocking with pending claims, and bond lifecycle.
 */

import {
  computeTrustDiscount,
  postBond,
  fileClaim,
  withdrawBond,
  getRequiredBond,
  checkBondStatus,
} from './bonds';
import type { AgentBankDeps } from './types';
import { SAFETY_LIMITS } from './types';

// bond lifecycle: minimal acting-wallet doc for the machine's kill-switch-first gate
// (only `.status` is read at the module boundary; a non-'active' status blocks).
import type { AgentWalletDocument } from '../agent-wallet/types';
import { countVisibleAgentPEs } from '../agent-wallet/agent-pe-activity';
const mockCountVisibleAgentPEs = countVisibleAgentPEs as jest.Mock;
const ACTING_WALLET = { status: 'active' } as unknown as AgentWalletDocument;

// A dummy Firestore handle for the direct computeTrustDiscount tests — the db is
// only threaded into the (mocked) countVisibleAgentPEs, never touched otherwise.
const DUMMY_DB = {} as any;


// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

jest.mock('./pe-utils', () => ({
  generatePE: jest.fn().mockResolvedValue({
    peId: 'pe_mock',
    peHash: 'hash_mock',
    prevHash: 'prev_mock',
  }),
}));

// the stored `agent_wallets.pe_count` tally is gone; computeTrustDiscount
// now reads the LIVE visible-PE count via countVisibleAgentPEs. Mock it so the
// pe-count trust band is exercisable deterministically.
jest.mock('../agent-wallet/agent-pe-activity', () => ({
  countVisibleAgentPEs: jest.fn().mockResolvedValue(0),
}));

jest.mock('../onchain/tx-verifier', () => ({
  // withdrawBond uses the generic contract-call verifier.
  verifyEvmContractCall: jest.fn().mockResolvedValue({
    ok: true,
    blockNumber: 12345,
    confirmations: 5,
  }),
  // Pass-2 (#10): fileClaim decodes the ClaimFiled event + recovers the claimId.
  verifyEvmClaimFiled: jest.fn().mockResolvedValue({
    ok: true,
    onchainClaimId: '0x' + 'c'.repeat(64),
    blockNumber: 12345,
    confirmations: 5,
  }),
  // FIX C: postBond / renewBond / withdrawBond decode their bond events.
  verifyEvmBondPosted: jest.fn().mockResolvedValue({
    ok: true,
    blockNumber: 12345,
    confirmations: 5,
  }),
  verifyEvmBondRenewed: jest.fn().mockResolvedValue({
    ok: true,
    blockNumber: 12345,
    confirmations: 5,
  }),
  verifyEvmBondWithdrawn: jest.fn().mockResolvedValue({
    ok: true,
    blockNumber: 12345,
    confirmations: 5,
  }),
}));

// ---------------------------------------------------------------------------
// Mock Firestore helpers
// ---------------------------------------------------------------------------

function createMockDoc(data: Record<string, unknown> | null) {
  return {
    exists: data !== null,
    data: () => data,
    id: (data?.bond_id || data?.wallet_id || data?.id || 'mock-id') as string,
    ref: {
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function createMockCollection(docs: ReturnType<typeof createMockDoc>[] = []) {
  const chain: Record<string, jest.Mock> = {};

  chain.doc = jest.fn().mockReturnValue({
    get: jest.fn().mockResolvedValue(docs[0] || createMockDoc(null)),
    set: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  });
  chain.where = jest.fn().mockReturnThis();
  chain.orderBy = jest.fn().mockReturnThis();
  chain.limit = jest.fn().mockReturnThis();
  chain.get = jest.fn().mockResolvedValue({
    docs,
    empty: docs.length === 0,
    size: docs.length,
  });
  chain.count = jest.fn().mockReturnValue({
    get: jest.fn().mockResolvedValue({ data: () => ({ count: 0 }) }),
  });

  return chain;
}

function createMockDeps(overrides?: Partial<AgentBankDeps>): AgentBankDeps {
  const runTransaction = jest.fn(async (fn: (txn: {
    get: jest.Mock;
    set: jest.Mock;
    update: jest.Mock;
  }) => Promise<unknown>) => {
    const txn = {
      get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
      set: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    return fn(txn);
  });

  return {
    db: {
      collection: jest.fn().mockReturnValue(createMockCollection()),
      runTransaction,
    } as any,
    cache: {
      checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    } as any,
    peBuffer: {
      enqueue: jest.fn(),
    },
    recordPEAccrual: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeWalletData(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wallet_aw_test',
    agent_id: 'agent-1',
    address: '0xAgent1',
    display_name: 'Test Agent',
    economic_activity_usd: 1000,
    badges: [],
    streak_days: 5,
    x402_payment_count: 0,
    linked_human_wallet_id: null,
    created_at: Date.now(),
    ...overrides,
  };
}

// Reset the live-PE-count mock before every test so a value set by one test
// (e.g. a getRequiredBond discount case) never leaks into the next.
beforeEach(() => {
  mockCountVisibleAgentPEs.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// Tests: Trust Discount Computation
// ---------------------------------------------------------------------------

describe('computeTrustDiscount', () => {

  it('returns 0 for a brand new agent', async () => {
    const wallet = makeWalletData({ economic_activity_usd: 0 });
    expect(await computeTrustDiscount(DUMMY_DB, wallet as any)).toBe(0);
  });

  it('adds 1000 for a live PE count >= 5000', async () => {
    // the band reads the LIVE visible-PE count, not a stored tally.
    mockCountVisibleAgentPEs.mockResolvedValue(6000);
    const wallet = makeWalletData({ economic_activity_usd: 0 });
    expect(await computeTrustDiscount(DUMMY_DB, wallet as any)).toBe(1000);
  });

  it('does not add for a live PE count below 5000', async () => {
    mockCountVisibleAgentPEs.mockResolvedValue(4999);
    const wallet = makeWalletData({ economic_activity_usd: 0 });
    expect(await computeTrustDiscount(DUMMY_DB, wallet as any)).toBe(0);
  });

  it('adds 1000 for economic_activity >= $50K', async () => {
    const wallet = makeWalletData({ economic_activity_usd: 60000 });
    expect(await computeTrustDiscount(DUMMY_DB, wallet as any)).toBe(1000);
  });

  it('reaches its maximum (3500) from all four live stat factors — never exceeds the cap', async () => {
    // the governance_score term is gone. The maximum reachable discount
    // is now 1000 (pe) + 1000 (econ) + 1000 (pvtHeld) + 500 (pvtBurned) = 3500,
    // which is below the 5000 hard cap — so the cap is respected trivially.
    mockCountVisibleAgentPEs.mockResolvedValue(50000);
    const wallet = makeWalletData({
      economic_activity_usd: 200000,
      pvt_held_cached: (10_000n * 10n ** 18n).toString(),
      pvt_burned_attributable: (1_000n * 10n ** 18n).toString(),
    });
    const discount = await computeTrustDiscount(DUMMY_DB, wallet as any);
    expect(discount).toBeLessThanOrEqual(SAFETY_LIMITS.MAX_TRUST_DISCOUNT_BPS);
    expect(discount).toBe(3500);
  });

  it('bond lifecycle: badge state contributes NOTHING to the trust discount (record-only artifact removed)', async () => {
    // Gate 1 approved no badge-based bond discount — badges are record-only
    // and must not move economic value. A wallet whose ONLY signal is badges
    // gets zero discount; badges on top of stats change nothing.
    const badgesOnly = makeWalletData({
      economic_activity_usd: 0,
      badges: [
        { id: 'chain_builder', earned_at: 1 },
        { id: 'architect', earned_at: 1 },
        { id: 'constellation', earned_at: 1 },
        { id: 'governed', earned_at: 1 },
        { id: 'thirty_day_streak', earned_at: 1 },
      ],
    });
    expect(await computeTrustDiscount(DUMMY_DB, badgesOnly as any)).toBe(0);

    const statsNoBadges = makeWalletData({ economic_activity_usd: 60000, badges: [] });
    const statsWithBadges = makeWalletData({
      economic_activity_usd: 60000,
      badges: [{ id: 'chain_builder', earned_at: 1 }, { id: 'governed', earned_at: 1 }],
    });
    const withBadges = await computeTrustDiscount(DUMMY_DB, statsWithBadges as any);
    const noBadges = await computeTrustDiscount(DUMMY_DB, statsNoBadges as any);
    expect(withBadges).toBe(noBadges);
    expect(withBadges).toBe(1000); // the econ factor alone; badges add nothing
  });

  it('adds 1000 for pvt_held_cached >= 1000 PVT', async () => {
    const wallet = makeWalletData({
      economic_activity_usd: 0,
      pvt_held_cached: (1_000n * 10n ** 18n).toString(),
    });
    expect(await computeTrustDiscount(DUMMY_DB, wallet as any)).toBe(1000);
  });

  it('does not add for pvt_held_cached below 1000 PVT', async () => {
    const wallet = makeWalletData({
      economic_activity_usd: 0,
      pvt_held_cached: (999n * 10n ** 18n).toString(),
    });
    expect(await computeTrustDiscount(DUMMY_DB, wallet as any)).toBe(0);
  });

  it('adds 500 for pvt_burned_attributable >= 100 PVT', async () => {
    const wallet = makeWalletData({
      economic_activity_usd: 0,
      pvt_burned_attributable: (100n * 10n ** 18n).toString(),
    });
    expect(await computeTrustDiscount(DUMMY_DB, wallet as any)).toBe(500);
  });

  it('combines both PVT factors', async () => {
    const wallet = makeWalletData({
      economic_activity_usd: 0,
      pvt_held_cached: (2_000n * 10n ** 18n).toString(),
      pvt_burned_attributable: (500n * 10n ** 18n).toString(),
    });
    // 1000 (held) + 500 (burned) = 1500
    expect(await computeTrustDiscount(DUMMY_DB, wallet as any)).toBe(1500);
  });

  it('treats missing or malformed PVT fields as zero', async () => {
    const wallet = makeWalletData({
      economic_activity_usd: 0,
      pvt_held_cached: 'not-a-number',
      pvt_burned_attributable: undefined,
    });
    expect(await computeTrustDiscount(DUMMY_DB, wallet as any)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Bond Sizing
// ---------------------------------------------------------------------------

describe('getRequiredBond', () => {
  it('returns correct Level 2 base bond with no discount', async () => {
    const deps = createMockDeps();
    const result = await getRequiredBond(deps, 2);
    expect(result.base_pvt).toBe(SAFETY_LIMITS.BOND_LEVEL_2_BASE_PVT);
    expect(result.trust_discount_bps).toBe(0);
    expect(result.required_pvt).toBe(SAFETY_LIMITS.BOND_LEVEL_2_BASE_PVT);
  });

  it('returns correct Level 3 base bond with no discount', async () => {
    const deps = createMockDeps();
    const result = await getRequiredBond(deps, 3);
    expect(result.base_pvt).toBe(SAFETY_LIMITS.BOND_LEVEL_3_BASE_PVT);
    expect(result.required_pvt).toBe(SAFETY_LIMITS.BOND_LEVEL_3_BASE_PVT);
  });

  it('applies trust discount when wallet provided', async () => {
    // governance_score is gone. Build a 2500-bps discount from the live
    // stat factors: pe-count (+1000) + economic activity (+1000) + burned (+500).
    mockCountVisibleAgentPEs.mockResolvedValue(6000);
    const wallet = makeWalletData({
      economic_activity_usd: 60000,
      pvt_burned_attributable: (100n * 10n ** 18n).toString(),
    });

    const deps = createMockDeps();
    (deps.db.collection as jest.Mock).mockImplementation((name: string) => {
      if (name === 'agent_wallets') {
        return createMockCollection([createMockDoc(wallet)]);
      }
      return createMockCollection();
    });

    const result = await getRequiredBond(deps, 2, 'wallet_aw_test');
    expect(result.trust_discount_bps).toBe(2500); // 1000 + 1000 + 500
    expect(result.required_pvt).toBe(
      Math.ceil(SAFETY_LIMITS.BOND_LEVEL_2_BASE_PVT * 7500 / 10000),
    );
  });

  it('never produces a zero-cost bond', async () => {
    // Even at the MAXIMUM reachable discount, the bond stays substantial.
    // max discount is now 3500 bps (1000 pe + 1000 econ + 1000 held +
    // 500 burned); badges are inert; governance_score is removed.
    mockCountVisibleAgentPEs.mockResolvedValue(50000);
    const wallet = makeWalletData({
      economic_activity_usd: 200000,
      pvt_held_cached: (10_000n * 10n ** 18n).toString(),
      pvt_burned_attributable: (1_000n * 10n ** 18n).toString(),
    });

    const deps = createMockDeps();
    (deps.db.collection as jest.Mock).mockImplementation((name: string) => {
      if (name === 'agent_wallets') {
        return createMockCollection([createMockDoc(wallet)]);
      }
      return createMockCollection();
    });

    const result = await getRequiredBond(deps, 2, 'wallet_aw_test');
    expect(result.trust_discount_bps).toBe(3500);
    expect(result.required_pvt).toBeGreaterThan(0);
    expect(result.required_pvt).toBe(
      Math.ceil(SAFETY_LIMITS.BOND_LEVEL_2_BASE_PVT * 6500 / 10000),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Self-Claim Rejection
// ---------------------------------------------------------------------------

describe('fileClaim - self-claim rejection', () => {
  it('rejects claim where claimant is the respondent', async () => {
    const deps = createMockDeps();

    await expect(
      fileClaim(deps, 'wallet_same', ACTING_WALLET, {
        respondent_wallet_id: 'wallet_same',
        description: 'This agent harmed me by being myself',
        evidence_pe_ids: ['pe_1'],
        tx_hash: '0x' + 'a'.repeat(64),
        chain: 'base',
      })
    ).rejects.toThrow('Cannot file a claim against your own bond');
  });
});

// ---------------------------------------------------------------------------
// Tests: Bond Status Check
// ---------------------------------------------------------------------------

describe('checkBondStatus', () => {
  it('returns has_bond: false when no active bond exists', async () => {
    const deps = createMockDeps();
    const status = await checkBondStatus(deps, 'wallet_unknown');
    expect(status.has_bond).toBe(false);
    expect(status.bond_active).toBe(false);
    expect(status.bond_healthy).toBe(false);
    expect(status.autonomy_level).toBeNull();
  });

  it('returns healthy bond status when bond is active and not expired', async () => {
    const bondDoc = {
      bond_id: 'bond_1',
      agent_wallet_id: 'wallet_1',
      autonomy_level: 2,
      amount_pvt: '5000',
      status: 'active',
      renewal_deadline: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days from now
    };

    const deps = createMockDeps();
    (deps.db.collection as jest.Mock).mockImplementation((name: string) => {
      if (name === 'bonds') {
        return createMockCollection([createMockDoc(bondDoc)]);
      }
      return createMockCollection();
    });

    const status = await checkBondStatus(deps, 'wallet_1');
    expect(status.has_bond).toBe(true);
    expect(status.bond_active).toBe(true);
    expect(status.bond_healthy).toBe(true);
    expect(status.autonomy_level).toBe(2);
  });

  it('returns unhealthy when bond is past renewal deadline', async () => {
    const bondDoc = {
      bond_id: 'bond_1',
      agent_wallet_id: 'wallet_1',
      autonomy_level: 3,
      amount_pvt: '20000',
      status: 'active',
      renewal_deadline: Date.now() - 1000, // Already expired
    };

    const deps = createMockDeps();
    (deps.db.collection as jest.Mock).mockImplementation((name: string) => {
      if (name === 'bonds') {
        return createMockCollection([createMockDoc(bondDoc)]);
      }
      return createMockCollection();
    });

    const status = await checkBondStatus(deps, 'wallet_1');
    expect(status.has_bond).toBe(true);
    expect(status.bond_active).toBe(true);
    expect(status.bond_healthy).toBe(false); // Expired
  });
});
