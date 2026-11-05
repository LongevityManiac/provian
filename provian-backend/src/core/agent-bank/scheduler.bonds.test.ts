/**
 * processAbandonedBonds — Capability-Truthfulness Pass-2 (WS2 #24) regression.
 *
 * Two coupled defects, both about asserting an on-chain burn that has not
 * happened:
 *   1. The off-chain abandonment cutoff was +180d, but on-chain processAbandonment
 *      reverts until renewalDeadline + renewalGracePeriod + abandonmentPeriod (30d + 365d
 *      = +395d on the deployed ProvianBondPool). The relay's cutoff is the same: its grace
 *      (30d since B5, 2026-10-22; 14d before) + its abandonment literal (365d since the
 *      2026-10-23 close-out; 180d before) = +395d. The chain refuses an earlier burn and
 *      nothing is asserted until it confirms one.
 *   2. The scheduler emitted a "burned" bond_abandonment_processed PE + flipped
 *      status to 'abandoned' UNCONDITIONALLY, even though nothing ever calls the
 *      on-chain processAbandonment, so no burn occurred.
 *
 * After the fix: the cutoff is +395d, and the burn PE / status flip happen ONLY
 * when the chain actually shows the bond Abandoned (readOnchainBondStatus).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  BOND_ABANDONMENT_PERIOD_MS,
  BOND_GRACE_PERIOD_MS,
  processAbandonedBonds,
  processBondRenewals,
} from './scheduler';
import type { AgentBankDeps } from './types';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_mock', peHash: 'h', prevHash: 'p' });
jest.mock('./pe-utils', () => ({
  generateSchedulerPE: (...args: unknown[]) => mockGeneratePE(...args),
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

const mockBondStatus = jest.fn();
// bond lifecycle: the abandonment mirror recovers a Base-final BondAbandoned receipt when
// another caller performed the burn (the machine's economic edge needs a
// receipt anchor). Mockable per-case.
const mockRecoverAbandoned = jest.fn();
jest.mock('../onchain/tx-verifier', () => ({
  readOnchainBondStatus: (...args: unknown[]) => mockBondStatus(...args),
  recoverEvmBondAbandoned: (...args: unknown[]) => mockRecoverAbandoned(...args),
  recoverEvmClaimExpired: jest.fn(),
  // bonds.ts (loaded transitively) imports these; unused in this suite.
  verifyEvmBondPosted: jest.fn(),
  verifyEvmBondRenewed: jest.fn(),
  verifyEvmBondToppedUp: jest.fn(),
  verifyEvmBondWithdrawn: jest.fn(),
  verifyEvmClaimFiled: jest.fn(),
  verifyEvmBondClaimResolved: jest.fn(),
  readOnchainBaseBond: jest.fn(),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The deployed contract's own literals, read from its source — the single source the
 * relay must agree with for the renewal grace AND the abandonment period (not a redeclared
 * copy of the relay's constants). B5: the relay carried 14d grace while ProvianBondPool
 * ships 30d; the 2026-10-23 close-out: the relay carried 180d abandonment while the pool
 * ships 365d (abandonmentPeriod() = 31536000 on Base, no scheduled override).
 */
function contractDays(name: 'renewalGracePeriod' | 'abandonmentPeriod'): number {
  const sol = fs.readFileSync(
    path.resolve(__dirname, '../../../../contracts/src/ProvianBondPool.sol'), 'utf8');
  const m = sol.match(new RegExp(`uint256 public ${name} = (\\d+) days;`));
  if (!m) throw new Error(`ProvianBondPool.sol: ${name} literal not found`);
  return Number(m[1]);
}
const CONTRACT_GRACE_DAYS = contractDays('renewalGracePeriod');
const CONTRACT_ABANDONMENT_DAYS = contractDays('abandonmentPeriod');
// The chain's own processAbandonment horizon: renewalDeadline + grace + abandonment.
const CONTRACT_CUTOFF_DAYS = CONTRACT_GRACE_DAYS + CONTRACT_ABANDONMENT_DAYS;

// bond lifecycle: the machine requires well-formed 64-hex receipt anchors — short fake
// hashes are rejected by design.
const BURN_TX = '0x' + 'b'.repeat(64);
const RECOVERED_TX = '0x' + 'd'.repeat(64);

interface BondDocMock {
  id: string;
  data: () => Record<string, unknown>;
  ref: {
    update: jest.Mock;
    _snap: () => { exists: boolean; data: () => Record<string, unknown> | null };
  };
}

/** Stateful bond doc: txn re-reads observe prior updates (fresh-status gate). */
function makeBondDoc(overrides: Record<string, unknown> = {}): BondDocMock {
  const state: { current: Record<string, unknown> } = {
    current: {
      bond_id: 'bond_1',
      agent_wallet_id: 'wallet_1',
      agent_address: '0x' + 'a'.repeat(40),
      chain: 'base',
      status: 'expired',
      amount_pvt: '750',
      post_block_number: 1000,
      renewal_deadline: Date.now() - 400 * DAY_MS, // past the +395d cutoff
      ...overrides,
    },
  };
  const update = jest.fn(async (patch: Record<string, unknown>) => {
    state.current = { ...state.current, ...patch };
  });
  return {
    id: state.current.bond_id as string,
    data: () => state.current,
    ref: {
      update,
      _snap: () => ({ exists: true, data: () => state.current }),
    },
  };
}

interface KeeperMock {
  canSign: jest.Mock;
  processAbandonment: jest.Mock;
}

/** Fake bond keeper. `result` is what processAbandonment resolves to. */
function makeKeeper(result: Record<string, unknown>, canSign = true): KeeperMock {
  return {
    canSign: jest.fn(() => canSign),
    processAbandonment: jest.fn().mockResolvedValue(result),
  };
}

function makeDeps(bondDocs: BondDocMock[], keeper?: KeeperMock): {
  deps: AgentBankDeps;
  whereCalls: Array<{ field: string; op: string; value: unknown }>;
} {
  const whereCalls: Array<{ field: string; op: string; value: unknown }> = [];
  interface QueryMock { where: jest.Mock; limit: jest.Mock; get: jest.Mock }
  const bondsCollection: QueryMock = {
    where: jest.fn((field: string, op: string, value: unknown) => {
      whereCalls.push({ field, op, value });
      return bondsCollection;
    }),
    limit: jest.fn(() => bondsCollection),
    get: jest.fn().mockResolvedValue({ empty: bondDocs.length === 0, size: bondDocs.length, docs: bondDocs }),
  };
  const agentWalletsCollection = { doc: jest.fn((id: string) => ({ id })) };
  const db = {
    collection: jest.fn((name: string) => (name === 'agent_wallets' ? agentWalletsCollection : bondsCollection)),
    getAll: jest.fn(async (...refs: Array<{ id: string }>) =>
      refs.map((r) => ({ exists: true, id: r.id, data: () => ({ agent_id: `agent-${r.id}`, address: '0xwallet' }) })),
    ),
    // bond lifecycle: the abandonment flip is transactional (machine-gated on fresh state).
    runTransaction: jest.fn(async (fn: (txn: unknown) => Promise<void>) => {
      const txn = {
        get: jest.fn(async (ref: BondDocMock['ref']) => ref._snap()),
        update: jest.fn((ref: BondDocMock['ref'], patch: Record<string, unknown>) => { void ref.update(patch); }),
        set: jest.fn(),
        create: jest.fn(),
      };
      await fn(txn);
    }),
  };
  return { deps: { db, bondKeeper: keeper } as unknown as AgentBankDeps, whereCalls };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BOND_POOL_CONTRACT_ADDRESS_BASE = '0x' + '1'.repeat(40);
});

describe('processAbandonedBonds — abandonment window + burn confirmation (#24)', () => {
  it('the relay grace and abandonment equal the deployed contract literals (30d, 365d)', () => {
    // RED against the pre-B5 relay grace (14d) and the pre-close-out relay abandonment (180d).
    expect(CONTRACT_GRACE_DAYS).toBe(30);
    expect(CONTRACT_ABANDONMENT_DAYS).toBe(365);
    expect(BOND_GRACE_PERIOD_MS).toBe(CONTRACT_GRACE_DAYS * DAY_MS);
    expect(BOND_ABANDONMENT_PERIOD_MS).toBe(CONTRACT_ABANDONMENT_DAYS * DAY_MS);
  });

  it('queries with the chain\'s +395d cutoff (grace + abandonment), not +180d, +194d or +210d', async () => {
    const { deps, whereCalls } = makeDeps([]);
    const before = Date.now();
    await processAbandonedBonds(deps);
    const after = Date.now();

    const deadlineBound = whereCalls.find((c) => c.field === 'renewal_deadline' && c.op === '<=');
    expect(deadlineBound).toBeDefined();
    const cutoff = deadlineBound!.value as number;
    // cutoff = now - 395d, where `now` is captured INSIDE the call (before ≤ now ≤ after).
    // So cutoff ∈ [before - 395d, after - 395d]: timing-robust bounds (no ±1ms flake).
    expect(CONTRACT_CUTOFF_DAYS).toBe(395);
    expect(after - cutoff).toBeGreaterThanOrEqual(CONTRACT_CUTOFF_DAYS * DAY_MS);
    expect(before - cutoff).toBeLessThanOrEqual(CONTRACT_CUTOFF_DAYS * DAY_MS);
    // #24 + B5 + close-out: strictly MORE than the old 180d, pre-B5 194d and pre-close-out
    // 210d windows (RED against BOND_ABANDONMENT_PERIOD_MS = 180d).
    expect(before - cutoff).toBeGreaterThan(210 * DAY_MS);
  });

  it('marks abandoned + emits the burn PE ONLY when the chain confirms the burn (receipt recovered)', async () => {
    const bond = makeBondDoc();
    const { deps } = makeDeps([bond]);
    mockBondStatus.mockResolvedValue({ ok: true, status: 'abandoned', amountAtomic: 0n });
    // bond lifecycle: an already-burned bond needs its BondAbandoned receipt recovered
    // before the economic expired→abandoned transition may record.
    mockRecoverAbandoned.mockResolvedValue({ ok: true, txHash: RECOVERED_TX, confirmations: 12 });

    const processed = await processAbandonedBonds(deps);

    expect(processed).toBe(1);
    expect(bond.ref.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'abandoned', abandonment_tx_hash: RECOVERED_TX }),
    );
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    // generateSchedulerPE(deps, params) — params is the SECOND arg.
    const peArg = mockGeneratePE.mock.calls[0][1];
    expect(peArg.actionType).toBe('bond_abandonment_processed');
    expect(peArg.metadata.onchain_burn_confirmed).toBe(true);
    expect(peArg.metadata.burn_tx_hash).toBe(RECOVERED_TX);
  });

  it('bond lifecycle fail-closed: chain shows Abandoned but NO receipt is recoverable → assert nothing', async () => {
    const bond = makeBondDoc();
    const { deps } = makeDeps([bond]);
    mockBondStatus.mockResolvedValue({ ok: true, status: 'abandoned', amountAtomic: 0n });
    mockRecoverAbandoned.mockResolvedValue({ ok: false, reason: 'bondabandoned_log_not_found' });

    const processed = await processAbandonedBonds(deps);

    expect(processed).toBe(0);
    expect(bond.ref.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('does NOT assert a burn when on-chain active and NO keeper is configured', async () => {
    const bond = makeBondDoc();
    const { deps } = makeDeps([bond]); // no keeper injected
    mockBondStatus.mockResolvedValue({ ok: true, status: 'active', amountAtomic: 750n * 10n ** 18n });

    const processed = await processAbandonedBonds(deps);

    expect(processed).toBe(0);
    expect(bond.ref.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('fails closed: an unconfirmable on-chain read asserts nothing', async () => {
    const bond = makeBondDoc();
    const { deps } = makeDeps([bond]);
    mockBondStatus.mockResolvedValue({ ok: false, reason: 'rpc_error: down' });

    const processed = await processAbandonedBonds(deps);

    expect(processed).toBe(0);
    expect(bond.ref.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [CONFIG] closure — keeper actually burns the bond on-chain
// ---------------------------------------------------------------------------

describe('processAbandonedBonds — keeper-driven on-chain burn ([CONFIG] closure)', () => {
  it('REGRESSION: an on-chain-active eligible bond is burned via the keeper, then recorded with the burn tx', async () => {
    const bond = makeBondDoc();
    const keeper = makeKeeper({ status: 'burned', txHash: BURN_TX });
    const { deps } = makeDeps([bond], keeper);
    // Chain says still active (collateral present) → the scheduler must drive the burn.
    mockBondStatus.mockResolvedValue({ ok: true, status: 'active', amountAtomic: 750n * 10n ** 18n });

    const processed = await processAbandonedBonds(deps);

    expect(keeper.processAbandonment).toHaveBeenCalledTimes(1);
    expect(keeper.processAbandonment.mock.calls[0][0]).toMatchObject({ bond_id: 'bond_1' });
    expect(processed).toBe(1);
    expect(bond.ref.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'abandoned', abandonment_tx_hash: BURN_TX }),
    );
    const peArg = mockGeneratePE.mock.calls[0][1];
    expect(peArg.actionType).toBe('bond_abandonment_processed');
    expect(peArg.metadata.onchain_burn_confirmed).toBe(true);
    expect(peArg.metadata.burn_tx_hash).toBe(BURN_TX);
    // The keeper burned it this tick — no log recovery needed.
    expect(mockRecoverAbandoned).not.toHaveBeenCalled();
  });

  it('records the burn via receipt RECOVERY when another caller already burned it (race → already_burned)', async () => {
    const bond = makeBondDoc();
    const keeper = makeKeeper({ status: 'already_burned' });
    const { deps } = makeDeps([bond], keeper);
    mockBondStatus.mockResolvedValue({ ok: true, status: 'active', amountAtomic: 750n * 10n ** 18n });
    mockRecoverAbandoned.mockResolvedValue({ ok: true, txHash: RECOVERED_TX, confirmations: 12 });

    const processed = await processAbandonedBonds(deps);

    expect(keeper.processAbandonment).toHaveBeenCalledTimes(1);
    expect(processed).toBe(1);
    const peArg = mockGeneratePE.mock.calls[0][1];
    expect(peArg.metadata.onchain_burn_confirmed).toBe(true);
    // bond lifecycle: no hashless economic record — the recovered receipt anchors it.
    expect(peArg.metadata.burn_tx_hash).toBe(RECOVERED_TX);
  });

  it('ADVERSARIAL: does NOT assert a burn when the keeper reports not_yet_eligible (on-chain clock skew)', async () => {
    const bond = makeBondDoc();
    const keeper = makeKeeper({ status: 'not_yet_eligible', reason: 'revert_still_active' });
    const { deps } = makeDeps([bond], keeper);
    mockBondStatus.mockResolvedValue({ ok: true, status: 'active', amountAtomic: 750n * 10n ** 18n });

    const processed = await processAbandonedBonds(deps);

    expect(keeper.processAbandonment).toHaveBeenCalledTimes(1);
    expect(processed).toBe(0);
    expect(bond.ref.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('ADVERSARIAL: does NOT assert a burn when the keeper tx fails', async () => {
    const bond = makeBondDoc();
    const keeper = makeKeeper({ status: 'failed', reason: 'abandonment_failed: nonce too low' });
    const { deps } = makeDeps([bond], keeper);
    mockBondStatus.mockResolvedValue({ ok: true, status: 'active', amountAtomic: 750n * 10n ** 18n });

    const processed = await processAbandonedBonds(deps);

    expect(processed).toBe(0);
    expect(bond.ref.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('does NOT call the keeper when the bond is already Abandoned on-chain (records off the recovered receipt)', async () => {
    const bond = makeBondDoc();
    const keeper = makeKeeper({ status: 'burned', txHash: BURN_TX });
    const { deps } = makeDeps([bond], keeper);
    mockBondStatus.mockResolvedValue({ ok: true, status: 'abandoned', amountAtomic: 0n });
    mockRecoverAbandoned.mockResolvedValue({ ok: true, txHash: RECOVERED_TX, confirmations: 12 });

    const processed = await processAbandonedBonds(deps);

    expect(keeper.processAbandonment).not.toHaveBeenCalled();
    expect(processed).toBe(1);
    const peArg = mockGeneratePE.mock.calls[0][1];
    expect(peArg.metadata.onchain_burn_confirmed).toBe(true);
    expect(peArg.metadata.burn_tx_hash).toBe(RECOVERED_TX);
  });

  it('does NOT call the keeper or assert anything when the bond is withdrawn on-chain', async () => {
    const bond = makeBondDoc();
    const keeper = makeKeeper({ status: 'burned', txHash: BURN_TX });
    const { deps } = makeDeps([bond], keeper);
    mockBondStatus.mockResolvedValue({ ok: true, status: 'withdrawn', amountAtomic: 0n });

    const processed = await processAbandonedBonds(deps);

    expect(keeper.processAbandonment).not.toHaveBeenCalled();
    expect(processed).toBe(0);
    expect(bond.ref.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });
});

// B5 (2026-10-22): the renewal grace. The relay flips an overdue bond active→expired (the
// autonomy drop + bond_expired_processed PE) only once the contract's own 30-day
// renewalGracePeriod has passed. With the old 14-day constant a bond 20 days overdue —
// still inside the contract's grace, where renewBond succeeds on-chain — was expired 16 days early.
describe('processBondRenewals — grace equals the contract renewalGracePeriod (B5)', () => {
  function activeBond(daysOverdue: number) {
    return makeBondDoc({ status: 'active', renewal_deadline: Date.now() - daysOverdue * DAY_MS });
  }

  it('RED vs 14d: a bond 20 days overdue (inside the 30d contract grace) is NOT expired', async () => {
    const bond = activeBond(20);
    const { deps } = makeDeps([bond]);
    await processBondRenewals(deps);
    expect(bond.ref.update).not.toHaveBeenCalled();
    expect(bond.data().status).toBe('active');
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('a bond one day inside the contract grace (29 days overdue) is NOT expired', async () => {
    const bond = activeBond(CONTRACT_GRACE_DAYS - 1);
    const { deps } = makeDeps([bond]);
    await processBondRenewals(deps);
    expect(bond.data().status).toBe('active');
  });

  it('a bond past the contract grace (31 days overdue) IS expired, with the expiry PE', async () => {
    const bond = activeBond(CONTRACT_GRACE_DAYS + 1);
    const { deps } = makeDeps([bond]);
    await processBondRenewals(deps);
    expect(bond.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    expect(mockGeneratePE.mock.calls[0][1].actionType).toBe('bond_expired_processed');
  });
});
