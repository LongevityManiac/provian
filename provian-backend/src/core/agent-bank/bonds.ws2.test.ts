/**
 * Bond renewal + post-bond floor — Capability-Truthfulness Pass-2 (WS2)
 * regression tests:
 *   #9  renewBond tx_hash replay → unlimited deadline extensions (HIGH)
 *   #25 renewBond persists a re-derived now+90d instead of the on-chain deadline
 *   #26 postBond collateral floor is the static constant, not the live on-chain base
 *
 * Uses the in-memory fake Firestore (real transaction + query semantics) so the
 * renewal dedup marker and the floor argument are exercised for real.
 */

import { postBond, renewBond } from './bonds';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { AgentBankDeps, PostBondRequest } from './types';

jest.mock('./pe-utils', () => ({
  generatePE: jest.fn(),
}));

jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmBondPosted: jest.fn(),
  verifyEvmBondRenewed: jest.fn(),
  readOnchainBaseBond: jest.fn(),
}));

// computeTrustDiscount reads the LIVE visible-PE count (the stored
// per-wallet tally is gone). Mock it so the pe-count trust band is drivable.
jest.mock('../agent-wallet/agent-pe-activity', () => ({
  countVisibleAgentPEs: jest.fn().mockResolvedValue(0),
}));

import { generatePE } from './pe-utils';
import { verifyEvmBondPosted, verifyEvmBondRenewed, readOnchainBaseBond } from '../onchain/tx-verifier';
import { countVisibleAgentPEs } from '../agent-wallet/agent-pe-activity';
const mockCountVisibleAgentPEs = countVisibleAgentPEs as jest.Mock;

// bond lifecycle: minimal acting-wallet doc for the machine's kill-switch-first gate
// (only `.status` is read at the module boundary; a non-'active' status blocks).
import type { AgentWalletDocument } from '../agent-wallet/types';
const ACTING_WALLET = { status: 'active' } as unknown as AgentWalletDocument;


const mockGeneratePE = generatePE as jest.Mock;
const mockBondPosted = verifyEvmBondPosted as jest.Mock;
const mockBondRenewed = verifyEvmBondRenewed as jest.Mock;
const mockBaseBond = readOnchainBaseBond as jest.Mock;

const POOL_ADDRESS = '0x' + '1'.repeat(40);
const AGENT = 'wallet_agent';
const AGENT_ADDR = '0x' + 'b'.repeat(40);
const BOND_ID = 'bond_test_1';
const RENEW_TX = '0x' + 'a'.repeat(64);
const ATOMIC = 10n ** 18n;

function makeDeps(fs: FakeFirestore): AgentBankDeps {
  return {
    db: fs as unknown as AgentBankDeps['db'],
    cache: {} as AgentBankDeps['cache'],
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(),
  } as unknown as AgentBankDeps;
}

function seedWallet(fs: FakeFirestore): void {
  fs.store.set(`agent_wallets/${AGENT}`, {
    id: AGENT,
    address: AGENT_ADDR,
    agent_id: 'agent-1',
    economic_activity_usd: 1000,
    badges: [],
  });
}

/**
 * Seed a wallet with explicit trust-discount drivers so a test can target a
 * SPECIFIC server-computed discount. Post- the governance_score term is
 * gone and the pe-count band reads the LIVE count (drive it with
 * mockCountVisibleAgentPEs), leaving: pe≥5000→+1000, econ≥50k→+1000,
 * pvt_held≥1000→+1000, pvt_burned≥100→+500, cap 5000. Badges never contribute.
 */
function seedWalletStats(
  fs: FakeFirestore,
  stats: {
    economic_activity_usd?: number;
    badges?: Array<{ id: string }>;
    pvt_held_cached?: string;
    pvt_burned_attributable?: string;
  },
): void {
  fs.store.set(`agent_wallets/${AGENT}`, {
    id: AGENT,
    address: AGENT_ADDR,
    agent_id: 'agent-1',
    economic_activity_usd: stats.economic_activity_usd ?? 1000,
    badges: stats.badges ?? [],
    ...(stats.pvt_held_cached ? { pvt_held_cached: stats.pvt_held_cached } : {}),
    ...(stats.pvt_burned_attributable ? { pvt_burned_attributable: stats.pvt_burned_attributable } : {}),
  });
}

function seedActiveBond(fs: FakeFirestore): void {
  fs.store.set(`bonds/${BOND_ID}`, {
    bond_id: BOND_ID,
    agent_wallet_id: AGENT,
    agent_address: AGENT_ADDR,
    autonomy_level: 2,
    amount_pvt: '750',
    total_deposited_pvt: '773',
    trust_discount_bps: 0,
    status: 'active',
    chain: 'base',
    post_tx_hash: '0x' + 'e'.repeat(64),
    post_block_number: 1,
    renewal_deadline: Date.now() + 30 * 24 * 60 * 60 * 1000,
    last_renewal_at: Date.now(),
    pending_claims: 0,
    pe_ids: [],
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no live PEs, so the pe-count band is off unless a test opts in.
  mockCountVisibleAgentPEs.mockResolvedValue(0);
  process.env.BOND_POOL_CONTRACT_ADDRESS_BASE = POOL_ADDRESS;
  mockGeneratePE.mockResolvedValue({ peId: 'pe_mock', peHash: 'h', prevHash: 'p' });
  mockBondPosted.mockResolvedValue({ ok: true, blockNumber: 1, confirmations: 5 });
  // Far-future on-chain deadline (year ~2033), distinct from now+90d, so #25 can
  // assert the persisted value comes from the EVENT not a re-derivation.
  mockBondRenewed.mockResolvedValue({ ok: true, newDeadlineSeconds: 2_000_000_000, blockNumber: 2, confirmations: 5 });
  mockBaseBond.mockResolvedValue({ ok: true, baseBondAtomic: 750n * ATOMIC });
});

// ---------------------------------------------------------------------------
// #9 — renewBond tx_hash replay dedup
// ---------------------------------------------------------------------------

describe('renewBond — tx_hash replay dedup (#9)', () => {
  it('rejects a replay of the same on-chain BondRenewed tx (no second deadline extension)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedActiveBond(fs);

    await renewBond(deps, AGENT, ACTING_WALLET, { bond_id: BOND_ID, tx_hash: RENEW_TX });
    const afterFirst = (fs.store.get(`bonds/${BOND_ID}`) as { renewal_deadline: number }).renewal_deadline;
    expect(afterFirst).toBe(2_000_000_000 * 1000);
    // Dedup marker created.
    expect(fs.store.has(`bond_renewal_dedup/tx:${RENEW_TX.toLowerCase()}`)).toBe(true);

    // Replay the SAME tx → rejected, deadline NOT moved again.
    await expect(renewBond(deps, AGENT, ACTING_WALLET, { bond_id: BOND_ID, tx_hash: RENEW_TX })).rejects.toThrow(/already processed/i);
    const afterReplay = (fs.store.get(`bonds/${BOND_ID}`) as { renewal_deadline: number }).renewal_deadline;
    expect(afterReplay).toBe(afterFirst);

    // Exactly one renewal record persisted (the replay never reached the write).
    const renewalDocs = [...fs.store.keys()].filter((k) => k.startsWith('bond_renewals/'));
    expect(renewalDocs).toHaveLength(1);
  });

  it('allows a genuinely new renewal tx (different hash) to extend again', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedActiveBond(fs);

    await renewBond(deps, AGENT, ACTING_WALLET, { bond_id: BOND_ID, tx_hash: RENEW_TX });

    const otherTx = '0x' + '9'.repeat(64);
    mockBondRenewed.mockResolvedValueOnce({ ok: true, newDeadlineSeconds: 2_100_000_000, blockNumber: 3, confirmations: 5 });
    await renewBond(deps, AGENT, ACTING_WALLET, { bond_id: BOND_ID, tx_hash: otherTx });

    expect((fs.store.get(`bonds/${BOND_ID}`) as { renewal_deadline: number }).renewal_deadline).toBe(2_100_000_000 * 1000);
    const renewalDocs = [...fs.store.keys()].filter((k) => k.startsWith('bond_renewals/'));
    expect(renewalDocs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// #25 — renewBond persists the ON-CHAIN deadline, not a re-derived now+90d
// ---------------------------------------------------------------------------

describe('renewBond — persists the on-chain newDeadline (#25)', () => {
  it('stores BondRenewed.newDeadline (seconds→ms), not now+180d', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedActiveBond(fs);

    const before = Date.now();
    await renewBond(deps, AGENT, ACTING_WALLET, { bond_id: BOND_ID, tx_hash: RENEW_TX });

    const deadline = (fs.store.get(`bonds/${BOND_ID}`) as { renewal_deadline: number }).renewal_deadline;
    expect(deadline).toBe(2_000_000_000 * 1000);
    // Sanity: the on-chain value is far from a re-derived now+180d.
    const nowPlus180d = before + 180 * 24 * 60 * 60 * 1000;
    expect(Math.abs(deadline - nowPlus180d)).toBeGreaterThan(365 * 24 * 60 * 60 * 1000);
  });

  it('falls back to the policy default only when the verifier omits the deadline', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedActiveBond(fs);
    mockBondRenewed.mockResolvedValue({ ok: true, blockNumber: 2, confirmations: 5 }); // no newDeadlineSeconds

    const before = Date.now();
    await renewBond(deps, AGENT, ACTING_WALLET, { bond_id: BOND_ID, tx_hash: RENEW_TX });
    const deadline = (fs.store.get(`bonds/${BOND_ID}`) as { renewal_deadline: number }).renewal_deadline;
    // ProvianBondPool.renewalPeriod = 180 days (contracts/src/ProvianBondPool.sol).
    const expected = before + 180 * 24 * 60 * 60 * 1000;
    expect(Math.abs(deadline - expected)).toBeLessThan(60_000);
  });
});

// ---------------------------------------------------------------------------
// #26 — postBond collateral floor tracks the LIVE on-chain base bond
// ---------------------------------------------------------------------------

describe('postBond — live on-chain base-bond floor (#26)', () => {
  const baseBody: PostBondRequest = { autonomy_level: 2, tx_hash: '0x' + 'c'.repeat(64), chain: 'base' };

  function floorArg(): bigint {
    return mockBondPosted.mock.calls[0][0].expectedMinLockedAmount as bigint;
  }

  it('uses a REDUCED live base for the floor, not the higher static constant', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs); // 0 discount
    // Governance cut the on-chain base from 750 → 500. The static floor (750e18)
    // would fail a correctly-collateralized 500 PVT post; the live floor passes.
    mockBaseBond.mockResolvedValue({ ok: true, baseBondAtomic: 500n * ATOMIC });

    await postBond(deps, AGENT, ACTING_WALLET, baseBody);

    expect(floorArg()).toBe(500n * ATOMIC);
    expect(floorArg()).not.toBe(750n * ATOMIC);
  });

  it('applies the SERVER-computed discount to the live base (15% of 1000 → 850)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    // reconstruct the 1500-bps (15%) discount from the surviving factors:
    // pvt_held (+1000) + pvt_burned (+500) = 1500 bps.
    seedWalletStats(fs, {
      pvt_held_cached: (1_000n * 10n ** 18n).toString(),
      pvt_burned_attributable: (100n * 10n ** 18n).toString(),
    });
    mockBaseBond.mockResolvedValue({ ok: true, baseBondAtomic: 1000n * ATOMIC });

    await postBond(deps, AGENT, ACTING_WALLET, baseBody);

    // 1000 * (10000-1500)/10000 = 850, integer division (matches Solidity).
    expect(floorArg()).toBe(850n * ATOMIC);
  });

  it('falls back to the static floor when the live read fails (preserves WS5 guard)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    mockBaseBond.mockResolvedValue({ ok: false, reason: 'rpc_error: down' });

    await postBond(deps, AGENT, ACTING_WALLET, baseBody);

    // Static L2 base = 750 PVT, 0 discount.
    expect(floorArg()).toBe(750n * ATOMIC);
  });

  // --- Solidity-parity proof (independent reference values, NOT the formula's
  // own output). The on-chain ProvianBondPool.getRequiredBond is
  // `(baseBond * (10000 - d)) / 10000` (floor division); Foundry pins
  // getRequiredBond(2,0)==base and getRequiredBond(2,5000)==base/2
  // (ProvianBondPool.t.sol:190/236). These cases anchor the backend floor to
  // those contract-verified semantics. ---

  it('matches Solidity floor-division at the backend max discount (getRequiredBond(2,3500))', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    // the governance_score term is gone, so the MAXIMUM reachable
    // server discount is now pe(1000)+econ(1000)+pvt_held(1000)+pvt_burned(500)
    // = 3500 bps (below the 5000 cap). This anchors the backend floor to the
    // contract's `(base * (10000 - d)) / 10000` at the backend's true ceiling.
    mockCountVisibleAgentPEs.mockResolvedValue(5000);
    seedWalletStats(fs, {
      economic_activity_usd: 50_000,
      pvt_held_cached: (1_000n * 10n ** 18n).toString(),
      pvt_burned_attributable: (100n * 10n ** 18n).toString(),
    });
    mockBaseBond.mockResolvedValue({ ok: true, baseBondAtomic: 750n * ATOMIC });

    await postBond(deps, AGENT, ACTING_WALLET, baseBody);

    // 750 * (10000-3500)/10000 = 750 * 0.65 = 487.5 PVT (exact in wei).
    expect(floorArg()).toBe(487_500_000_000_000_000_000n);
  });

  it('removes the sub-PVT false-negative the OLD whole-PVT ceil floor caused (#26 root cause)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    // bond lifecycle (badge factor removed): the pvt_burned factor → exactly 500 bps (5%).
    seedWalletStats(fs, { pvt_burned_attributable: (100n * 10n ** 18n).toString() });
    mockBaseBond.mockResolvedValue({ ok: true, baseBondAtomic: 750n * ATOMIC });

    await postBond(deps, AGENT, ACTING_WALLET, baseBody);

    // Solidity getRequiredBond(2,500) = 750e18*9500/10000 = 712.5 PVT (exact in wei).
    const NEW_FLOOR = 712_500_000_000_000_000_000n;
    expect(floorArg()).toBe(NEW_FLOOR);

    // The OLD floor was BigInt(Math.ceil(750*9500/10000)) * 1e18 = ceil(712.5) = 713 PVT.
    const OLD_FLOOR = BigInt(Math.ceil((750 * (10000 - 500)) / 10000)) * ATOMIC; // 713e18
    expect(OLD_FLOOR).toBe(713n * ATOMIC);
    // The fix is real: the new floor is STRICTLY below the old one (by 0.5 PVT),
    // so a bond whose on-chain lock is exactly 712.5e18+dust now passes where the
    // old whole-PVT-ceil floor would have rejected it. (Verifier-level pass/fail
    // at the real lockedAmount is proven in tx-verifier.test.ts.)
    expect(floorArg()).toBeLessThan(OLD_FLOOR);
  });

  it('truncating regime: BigInt floor-division parity with Solidity on a non-multiple base', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    // reconstruct 1500 bps from pvt_held (+1000) + pvt_burned (+500).
    seedWalletStats(fs, {
      pvt_held_cached: (1_000n * 10n ** 18n).toString(),
      pvt_burned_attributable: (100n * 10n ** 18n).toString(),
    });
    // A base that is NOT a clean multiple of 1e18, so base*(10000-d) is not
    // divisible by 10000 and the division actually TRUNCATES (the only regime
    // where rounding direction can diverge).
    const liveBase = 100_000_000_000_000_000_007n; // 1e20 + 7 wei
    mockBaseBond.mockResolvedValue({ ok: true, baseBondAtomic: liveBase });

    await postBond(deps, AGENT, ACTING_WALLET, baseBody);

    // Independent hand computation, floor (toward zero) like Solidity:
    //   100000000000000000007 * 8500 = 850000000000000000059500
    //   / 10000 = 85000000000000000005.95  →  floor 85000000000000000005
    expect(floorArg()).toBe(85_000_000_000_000_000_005n);
    // Naive float math (1e20 is not float-exact) cannot reach this wei-precise
    // value — only BigInt floor division matches the contract here.
  });
});
