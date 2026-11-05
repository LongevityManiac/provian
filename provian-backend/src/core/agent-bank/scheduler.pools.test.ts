/**
 * processExpiredPools (P4-02) — the scheduler-driven pool expiry refund.
 *
 * Pre-fix: the scheduler batch-flipped EVERY expired pool to 'refunded' and emitted
 * a pool_refunded PE asserting refunded_usdc while the contract kept the funds
 * locked (no keeper, no on-chain refund). Post-fix: it drives the injected
 * poolKeeper's permissionless on-chain refundPool and flips Firestore + emits a
 * pool_refunded PE ONLY when the on-chain refund is confirmed (refunded /
 * already_refunded); every other keeper status leaves the pool 'open' for retry.
 * Zero-contribution pools have nothing on-chain to refund and are closed directly.
 */

import { processExpiredPools } from './scheduler';
import type { AgentBankDeps, PoolDocument, PoolRefundResult } from './types';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_refund', peHash: 'h', prevHash: 'p' });
jest.mock('./pe-utils', () => ({
  generateSchedulerPE: (...a: unknown[]) => mockGeneratePE(...a),
  generatePE: (...a: unknown[]) => mockGeneratePE(...a),
}));

interface PoolSnap {
  ref: { update: jest.Mock };
  data: () => PoolDocument;
}

function makePoolSnap(pool: PoolDocument): PoolSnap {
  return { ref: { update: jest.fn(async () => {}) }, data: () => pool };
}

function usdcPool(overrides: Partial<PoolDocument> = {}): PoolDocument {
  return {
    pool_id: 'pool_1',
    creator_wallet_id: 'wallet_creator',
    creator_address: '0x' + 'e'.repeat(40),
    target_address: '0x' + 'f'.repeat(40),
    target_description: 't',
    currency: 'usdc',
    threshold_usdc: 100,
    fee_usdc: 0.5,
    net_to_target_usdc: 99.5,
    total_contributed_usdc: 40,
    max_contributors: 10,
    chain: 'base',
    deadline: 0,
    status: 'open',
    contributions: {
      wallet_a: { address: '0x' + '1'.repeat(40), amount_usdc: 40, contributed_at: 0, tx_hash: '0x' + 'a'.repeat(64) },
    },
    pe_ids: [],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as PoolDocument;
}

interface PoolKeeperMock {
  canSign: jest.Mock;
  refundExpiredPool: jest.Mock;
}

function makeKeeper(result: PoolRefundResult, canSign = true): PoolKeeperMock {
  return {
    canSign: jest.fn(() => canSign),
    refundExpiredPool: jest.fn().mockResolvedValue(result),
  };
}

function makeDeps(
  snaps: PoolSnap[],
  keeper?: PoolKeeperMock,
): { deps: AgentBankDeps; whereCalls: Array<{ field: string; op: string; value: unknown }> } {
  const whereCalls: Array<{ field: string; op: string; value: unknown }> = [];
  interface QueryMock { where: jest.Mock; limit: jest.Mock; get: jest.Mock }
  const poolsCollection: QueryMock = {
    where: jest.fn((field: string, op: string, value: unknown) => {
      whereCalls.push({ field, op, value });
      return poolsCollection;
    }),
    limit: jest.fn(() => poolsCollection),
    get: jest.fn().mockResolvedValue({ empty: snaps.length === 0, size: snaps.length, docs: snaps }),
  };
  const agentWalletsCollection = { doc: jest.fn((id: string) => ({ id })) };
  const db = {
    collection: jest.fn((name: string) => (name === 'pools' ? poolsCollection : agentWalletsCollection)),
    getAll: jest.fn(async (...refs: Array<{ id: string }>) =>
      refs.map((r) => ({ exists: true, id: r.id, data: () => ({ agent_id: `agent-${r.id}`, address: `0xwallet-${r.id}` }) })),
    ),
  };
  return { deps: { db, poolKeeper: keeper } as unknown as AgentBankDeps, whereCalls };
}

beforeEach(() => jest.clearAllMocks());

describe('processExpiredPools - query', () => {
  it('queries open pools past their deadline', async () => {
    const { deps, whereCalls } = makeDeps([]);
    const count = await processExpiredPools(deps);
    expect(count).toBe(0);
    expect(whereCalls).toContainEqual({ field: 'status', op: '==', value: 'open' });
    expect(whereCalls.find((c) => c.field === 'deadline' && c.op === '<=')).toBeDefined();
  });
});

describe('processExpiredPools - confirmed on-chain refund', () => {
  it('refunded: flips Firestore + emits a truthful pool_refunded PE with the tx hash', async () => {
    const snap = makePoolSnap(usdcPool());
    const keeper = makeKeeper({ status: 'refunded', txHash: '0xrefund', onchainPoolId: '0xpid', confirmedContributorWalletIds: ['wallet_a'] });
    const { deps } = makeDeps([snap], keeper);

    const processed = await processExpiredPools(deps);

    expect(keeper.refundExpiredPool).toHaveBeenCalledTimes(1);
    expect(keeper.refundExpiredPool.mock.calls[0][0]).toMatchObject({ pool_id: 'pool_1' });
    expect(processed).toBe(1);
    expect(snap.ref.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'refunded', refund_tx_hash: '0xrefund' }),
    );
    const peArg = mockGeneratePE.mock.calls[0][1];
    expect(peArg.actionType).toBe('pool_refunded');
    expect(peArg.metadata).toMatchObject({
      pool_id: 'pool_1',
      currency: 'usdc',
      reason: 'deadline_expired',
      onchain_refund_confirmed: true,
      refund_tx_hash: '0xrefund',
      refunded_usdc: 40,
    });
  });

  it('already_refunded (raced, no tx): still flips + emits, but with no refund_tx_hash', async () => {
    const snap = makePoolSnap(usdcPool());
    const keeper = makeKeeper({ status: 'already_refunded', onchainPoolId: '0xpid', confirmedContributorWalletIds: ['wallet_a'] });
    const { deps } = makeDeps([snap], keeper);

    const processed = await processExpiredPools(deps);

    expect(processed).toBe(1);
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'refunded' }));
    const updateArg = snap.ref.update.mock.calls[0][0];
    expect(updateArg.refund_tx_hash).toBeUndefined();
    const peArg = mockGeneratePE.mock.calls[0][1];
    expect(peArg.metadata.onchain_refund_confirmed).toBe(true);
    expect(peArg.metadata.refund_tx_hash).toBeUndefined();
  });

  it('emits a PE ONLY for keeper-confirmed on-chain contributors (skips a bare-transfer Firestore contributor)', async () => {
    const snap = makePoolSnap(usdcPool({
      total_contributed_usdc: 100,
      contributions: {
        wallet_a: { address: '0x' + '1'.repeat(40), amount_usdc: 60, contributed_at: 0, tx_hash: '0x' + 'a'.repeat(64) },
        wallet_b: { address: '0x' + '2'.repeat(40), amount_usdc: 40, contributed_at: 0, tx_hash: '0x' + 'b'.repeat(64) },
      },
    }));
    // Keeper confirmed only wallet_a on-chain; wallet_b's "contribution" was a bare
    // transfer refundPool never paid — it must NOT receive a pool_refunded PE.
    const keeper = makeKeeper({ status: 'refunded', txHash: '0xr', onchainPoolId: '0xpid', confirmedContributorWalletIds: ['wallet_a'] });
    const { deps } = makeDeps([snap], keeper);

    const processed = await processExpiredPools(deps);

    expect(processed).toBe(1);
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'refunded' }));
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    expect(mockGeneratePE.mock.calls[0][1].walletId).toBe('wallet_a');
  });

  it('PVT pool: currency-aware refunded_pvt metadata', async () => {
    const snap = makePoolSnap(usdcPool({
      currency: 'pvt',
      total_contributed_pvt: '40000000000000000000',
      contributions: {
        wallet_a: { address: '0x' + '1'.repeat(40), amount_usdc: 0, amount_pvt: '40000000000000000000', contributed_at: 0, tx_hash: '0x' + 'a'.repeat(64) },
      },
    }));
    const keeper = makeKeeper({ status: 'refunded', txHash: '0xr', onchainPoolId: '0xpid', confirmedContributorWalletIds: ['wallet_a'] });
    const { deps } = makeDeps([snap], keeper);

    await processExpiredPools(deps);
    const peArg = mockGeneratePE.mock.calls[0][1];
    expect(peArg.metadata).toMatchObject({ currency: 'pvt', refunded_pvt: '40000000000000000000' });
    expect(peArg.metadata.refunded_usdc).toBeUndefined();
  });
});

describe('processExpiredPools - fail-closed (no PE asserts an unperformed refund)', () => {
  it.each(['not_yet_expired', 'unrecoverable_id', 'not_refundable', 'failed'] as const)(
    'keeper=%s → pool left open, no flip, no PE',
    async (status) => {
      const snap = makePoolSnap(usdcPool());
      const keeper = makeKeeper({ status });
      const { deps } = makeDeps([snap], keeper);

      const processed = await processExpiredPools(deps);

      expect(processed).toBe(0);
      expect(snap.ref.update).not.toHaveBeenCalled();
      expect(mockGeneratePE).not.toHaveBeenCalled();
    },
  );

  it('no keeper configured → expired FUNDED pool left open, no PE', async () => {
    const snap = makePoolSnap(usdcPool());
    const { deps } = makeDeps([snap], undefined); // no poolKeeper
    const processed = await processExpiredPools(deps);
    expect(processed).toBe(0);
    expect(snap.ref.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('keeper present but cannot sign → expired FUNDED pool left open, no on-chain call', async () => {
    const snap = makePoolSnap(usdcPool());
    const keeper = makeKeeper({ status: 'refunded' }, /* canSign */ false);
    const { deps } = makeDeps([snap], keeper);
    const processed = await processExpiredPools(deps);
    expect(processed).toBe(0);
    expect(keeper.refundExpiredPool).not.toHaveBeenCalled();
    expect(snap.ref.update).not.toHaveBeenCalled();
  });
});

describe('processExpiredPools - zero-contribution pools', () => {
  it('closes an empty expired pool directly (no keeper, no PE)', async () => {
    const snap = makePoolSnap(usdcPool({ contributions: {}, total_contributed_usdc: 0 }));
    const keeper = makeKeeper({ status: 'refunded' });
    const { deps } = makeDeps([snap], keeper);

    const processed = await processExpiredPools(deps);

    expect(processed).toBe(1);
    expect(keeper.refundExpiredPool).not.toHaveBeenCalled();
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'refunded' }));
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('closes an empty pool even with NO keeper configured (nothing on-chain to refund)', async () => {
    const snap = makePoolSnap(usdcPool({ contributions: {}, total_contributed_usdc: 0 }));
    const { deps } = makeDeps([snap], undefined);
    const processed = await processExpiredPools(deps);
    expect(processed).toBe(1);
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'refunded' }));
  });
});
