/**
 * Pool refund keeper (P4-02) — Gate B identity guard + refundExpiredPool
 * classification.
 *
 * The keeper drives the PERMISSIONLESS on-chain ProvianPool.refundPool(poolId) for
 * an expired under-threshold pool from a dedicated GAS-ONLY EOA (POOL_KEEPER_KEY).
 * Gate B is the economic-safety boundary (the key must never be the PVT minter,
 * deployer/treasury, Foundation Safe, or founder admin EOA). refundExpiredPool
 * NEVER flips Firestore — it returns a status the scheduler acts on; a refund is
 * only asserted when confirmed off the PoolRefunded event, never on a bare mined tx.
 */

import { ethers } from 'ethers';

// Override ONLY ethers.Contract (keep Wallet real so Gate B + construction work).
const mockRefundPool = jest.fn();
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  class MockContract {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(..._args: any[]) {
      return { refundPool: (...a: unknown[]) => mockRefundPool(...a) };
    }
  }
  return { ...actual, ethers: { ...actual.ethers, Contract: MockContract } };
});

// Control the tx-verifier reads the keeper depends on.
const mockRecoverPoolId = jest.fn();
const mockReadStatus = jest.fn();
const mockRefundedMatches = jest.fn();
jest.mock('../onchain/tx-verifier', () => ({
  recoverPoolIdFromContributionTx: (...a: unknown[]) => mockRecoverPoolId(...a),
  readOnchainPoolStatus: (...a: unknown[]) => mockReadStatus(...a),
  poolRefundedEventMatches: (...a: unknown[]) => mockRefundedMatches(...a),
  POOL_STATUS_OPEN: 0,
  POOL_STATUS_REFUNDED: 3,
}));

// pools.ts pulls in a heavy import graph; we only need the address resolver.
jest.mock('./pools', () => ({
  resolvePoolContractAddress: () => '0x' + '5'.repeat(40),
}));

jest.mock('../onchain/rpc-provider', () => ({
  getChainProvider: jest.fn(() => ({})),
}));

import { assertPoolKeeperIdentity, createPoolKeeperGateway } from './pool-keeper';
import type { PoolDocument } from './types';

const FOUNDER_EOA = '0xD395c8f59131a4736aa4d9eE6e5dEb8fDA07Ce0a';
const POOL_ID = '0x' + 'ab'.repeat(32);
const TX_A = '0x' + 'a'.repeat(64);
const TX_B = '0x' + 'b'.repeat(64);
const ADDR_A = '0x' + '1'.repeat(40);
const ADDR_B = '0x' + '2'.repeat(40);

function poolDoc(overrides: Partial<PoolDocument> = {}): PoolDocument {
  return {
    pool_id: 'pool_1',
    creator_wallet_id: 'wallet_creator',
    creator_address: '0x' + 'c'.repeat(40),
    target_address: '0x' + 'd'.repeat(40),
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
      wallet_a: { address: ADDR_A, amount_usdc: 40, contributed_at: 0, tx_hash: TX_A },
    },
    pe_ids: [],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as PoolDocument;
}

/** A clean, unprivileged gas-only keeper key + env. */
function withCleanKey(): void {
  delete process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS;
  delete process.env.PROVIAN_TREASURY_ADDRESS;
  delete process.env.FOUNDATION_TREASURY_ADDRESS;
  delete process.env.PVT_MINTER_KEY;
  process.env.POOL_KEEPER_KEY = ethers.Wallet.createRandom().privateKey;
}

describe('assertPoolKeeperIdentity (Gate B)', () => {
  const ORIG = { ...process.env };
  afterEach(() => { process.env = { ...ORIG }; });

  it('REJECTS the founder admin EOA', () => {
    expect(() => assertPoolKeeperIdentity(FOUNDER_EOA)).toThrow(/legacy admin wallet/i);
    expect(() => assertPoolKeeperIdentity(FOUNDER_EOA)).toThrow(/GATE B FAILED/);
  });

  it('REJECTS the founder EOA case-insensitively', () => {
    expect(() => assertPoolKeeperIdentity(FOUNDER_EOA.toLowerCase())).toThrow(/GATE B FAILED/);
  });

  it('REJECTS the configured deployer/treasury address', () => {
    const w = ethers.Wallet.createRandom();
    process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS = w.address;
    expect(() => assertPoolKeeperIdentity(w.address)).toThrow(/treasury/i);
  });

  it('REJECTS the address under the former variable name the deployed environment carries', () => {
    delete process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS;
    const w = ethers.Wallet.createRandom();
    process.env.PROVIAN_TREASURY_ADDRESS = w.address;
    expect(() => assertPoolKeeperIdentity(w.address)).toThrow(/treasury key identity \(PROVIAN_TREASURY_ADDRESS\)/);
  });

  it('REJECTS the configured Foundation Safe address', () => {
    const w = ethers.Wallet.createRandom();
    process.env.FOUNDATION_TREASURY_ADDRESS = w.address;
    expect(() => assertPoolKeeperIdentity(w.address)).toThrow(/Foundation Safe/i);
  });

  it('REJECTS the PVT minter (derived from PVT_MINTER_KEY)', () => {
    const w = ethers.Wallet.createRandom();
    process.env.PVT_MINTER_KEY = w.privateKey;
    expect(() => assertPoolKeeperIdentity(w.address)).toThrow(/minter/i);
  });

  it('ACCEPTS a clean, unprivileged gas-only address', () => {
    delete process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS;
    delete process.env.PROVIAN_TREASURY_ADDRESS;
    delete process.env.FOUNDATION_TREASURY_ADDRESS;
    delete process.env.PVT_MINTER_KEY;
    const w = ethers.Wallet.createRandom();
    expect(() => assertPoolKeeperIdentity(w.address)).not.toThrow();
  });
});

describe('createPoolKeeperGateway - construction', () => {
  const ORIG = { ...process.env };
  afterEach(() => { process.env = { ...ORIG }; });

  it('canSign() is false when POOL_KEEPER_KEY is unset', () => {
    delete process.env.POOL_KEEPER_KEY;
    expect(createPoolKeeperGateway().canSign()).toBe(false);
  });

  it('canSign() is true for a clean, unprivileged key', () => {
    withCleanKey();
    expect(createPoolKeeperGateway().canSign()).toBe(true);
  });

  it('FAILS CLOSED at construction when the key collides with a forbidden identity', () => {
    const w = ethers.Wallet.createRandom();
    process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS = w.address;
    process.env.POOL_KEEPER_KEY = w.privateKey;
    expect(() => createPoolKeeperGateway()).toThrow(/GATE B FAILED/);
  });
});

describe('refundExpiredPool - classification', () => {
  const ORIG = { ...process.env };
  beforeEach(() => { jest.clearAllMocks(); withCleanKey(); });
  afterEach(() => { process.env = { ...ORIG }; });

  it('returns unconfigured when no keeper key is set (no on-chain call)', async () => {
    delete process.env.POOL_KEEPER_KEY;
    const g = createPoolKeeperGateway();
    const r = await g.refundExpiredPool(poolDoc());
    expect(r.status).toBe('unconfigured');
    expect(mockReadStatus).not.toHaveBeenCalled();
  });

  it('returns no_contributors for an empty pool (nothing on-chain to refund)', async () => {
    const g = createPoolKeeperGateway();
    const r = await g.refundExpiredPool(poolDoc({ contributions: {} }));
    expect(r.status).toBe('no_contributors');
    expect(mockRecoverPoolId).not.toHaveBeenCalled();
  });

  it('returns unrecoverable_id when the on-chain poolId cannot be recovered', async () => {
    mockRecoverPoolId.mockResolvedValue(null);
    const g = createPoolKeeperGateway();
    const r = await g.refundExpiredPool(poolDoc());
    expect(r.status).toBe('unrecoverable_id');
    expect(mockReadStatus).not.toHaveBeenCalled();
  });

  it('idempotent: already_refunded when the pool is already Refunded on-chain', async () => {
    mockRecoverPoolId.mockResolvedValue(POOL_ID);
    mockReadStatus.mockResolvedValue(3); // Refunded
    const g = createPoolKeeperGateway();
    const r = await g.refundExpiredPool(poolDoc());
    expect(r.status).toBe('already_refunded');
    expect(r.confirmedContributorWalletIds).toEqual(['wallet_a']);
    expect(mockRefundPool).not.toHaveBeenCalled();
  });

  it('not_refundable when on-chain status is not Open (e.g. Funded)', async () => {
    mockRecoverPoolId.mockResolvedValue(POOL_ID);
    mockReadStatus.mockResolvedValue(1); // Funded
    const g = createPoolKeeperGateway();
    const r = await g.refundExpiredPool(poolDoc());
    expect(r.status).toBe('not_refundable');
    expect(mockRefundPool).not.toHaveBeenCalled();
  });

  it('failed (fail-closed) when the on-chain status is unreadable', async () => {
    mockRecoverPoolId.mockResolvedValue(POOL_ID);
    mockReadStatus.mockResolvedValue(null);
    const g = createPoolKeeperGateway();
    const r = await g.refundExpiredPool(poolDoc());
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('pool_status_unreadable');
  });

  it('refunded: broadcasts refundPool + confirms off the PoolRefunded event', async () => {
    mockRecoverPoolId.mockResolvedValue(POOL_ID);
    mockReadStatus.mockResolvedValue(0); // Open
    mockRefundPool.mockResolvedValue({ wait: async () => ({ status: 1, hash: '0xrefund', logs: [] }) });
    mockRefundedMatches.mockReturnValue(true);
    const g = createPoolKeeperGateway();
    const r = await g.refundExpiredPool(poolDoc());
    expect(mockRefundPool).toHaveBeenCalledWith(POOL_ID);
    expect(r.status).toBe('refunded');
    expect(r.txHash).toBe('0xrefund');
    expect(r.confirmedContributorWalletIds).toEqual(['wallet_a']);
  });

  it('confirms ONLY on-chain-real contributors — excludes a bare-transfer Firestore contributor', async () => {
    // wallet_a made a real on-chain contribute (its tx recovers the poolId); wallet_b
    // registered a bare usdc.transfer (no PoolContribution event → recovery null), so
    // refundPool never pays it and it must NOT be in the confirmed set.
    mockRecoverPoolId.mockImplementation(({ txHash }: { txHash: string }) =>
      Promise.resolve(txHash === TX_A ? POOL_ID : null),
    );
    mockReadStatus.mockResolvedValue(0);
    mockRefundPool.mockResolvedValue({ wait: async () => ({ status: 1, hash: '0xr', logs: [] }) });
    mockRefundedMatches.mockReturnValue(true);
    const pool = poolDoc({
      total_contributed_usdc: 100,
      contributions: {
        wallet_a: { address: ADDR_A, amount_usdc: 60, contributed_at: 0, tx_hash: TX_A },
        wallet_b: { address: ADDR_B, amount_usdc: 40, contributed_at: 0, tx_hash: TX_B },
      },
    });
    const g = createPoolKeeperGateway();
    const r = await g.refundExpiredPool(pool);
    expect(r.status).toBe('refunded');
    expect(r.confirmedContributorWalletIds).toEqual(['wallet_a']); // wallet_b excluded
  });

  it('failed: mined refund with NO PoolRefunded log is not asserted (truthful)', async () => {
    mockRecoverPoolId.mockResolvedValue(POOL_ID);
    mockReadStatus.mockResolvedValue(0);
    mockRefundPool.mockResolvedValue({ wait: async () => ({ status: 1, hash: '0xnope', logs: [] }) });
    mockRefundedMatches.mockReturnValue(false);
    const g = createPoolKeeperGateway();
    const r = await g.refundExpiredPool(poolDoc());
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('pool_refunded_event_not_found');
  });

  it('not_yet_expired: a revert that re-reads Open (deadline clock skew) asserts nothing', async () => {
    mockRecoverPoolId.mockResolvedValue(POOL_ID);
    mockReadStatus.mockResolvedValueOnce(0).mockResolvedValueOnce(0); // Open, still Open after revert
    mockRefundPool.mockRejectedValue(new Error('DeadlineNotReached'));
    const g = createPoolKeeperGateway();
    const r = await g.refundExpiredPool(poolDoc());
    expect(r.status).toBe('not_yet_expired');
  });

  it('idempotent on revert: re-reads Refunded (a concurrent caller won the race)', async () => {
    mockRecoverPoolId.mockResolvedValue(POOL_ID);
    mockReadStatus.mockResolvedValueOnce(0).mockResolvedValueOnce(3); // Open, then Refunded after revert
    mockRefundPool.mockRejectedValue(new Error('InvalidStatus'));
    const g = createPoolKeeperGateway();
    const r = await g.refundExpiredPool(poolDoc());
    expect(r.status).toBe('already_refunded');
  });
});
