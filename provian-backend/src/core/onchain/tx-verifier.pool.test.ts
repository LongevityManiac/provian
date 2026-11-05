/**
 * tx-verifier — pool fund-exit helpers (P4-01 / P4-02).
 *
 * These verify the on-chain settlement of a pool's two exit legs before any PE
 * asserts funds returned:
 *   - verifyEvmPoolWithdrawal    — a contributor's own withdrawContribution(bytes32)
 *   - recoverPoolIdFromContributionTx — recover the on-chain bytes32 poolId
 *   - readOnchainPoolStatus      — the pool's on-chain Status enum (word 6)
 *   - poolRefundedEventMatches   — confirm a refundPool landed (PoolRefunded log)
 *
 * The pool contract log fixtures are encoded with the SAME event signatures the
 * verifier pins, so a signature drift would fail the encode here too (fail-closed).
 */

import { ethers } from 'ethers';
import {
  verifyEvmPoolContribution,
  verifyEvmPoolWithdrawal,
  recoverPoolIdFromContributionTx,
  readOnchainPoolStatus,
  poolRefundedEventMatches,
} from './tx-verifier';

const mockGetTransactionReceipt = jest.fn();
const mockCall = jest.fn();

jest.mock('./economic-finality', () => ({
  verifyBaseEconomicTransactionFinality: jest.fn(async () => ({
    evidence: {
      blockNumber: 100,
      blockHash: `0x${'b'.repeat(64)}`,
      confirmations: 12,
    },
  })),
}));

jest.mock('./rpc-provider', () => ({
  getVerifierProvider: jest.fn(() => ({
    getTransactionReceipt: (...args: unknown[]) => mockGetTransactionReceipt(...args),
    call: (...args: unknown[]) => mockCall(...args),
  })),
}));

const BASE = 8453;
const POOL = '0x' + '5'.repeat(40);
const OTHER_CONTRACT = '0x' + '9'.repeat(40);
const CONTRIBUTOR = '0x1111111111111111111111111111111111111111';
const OTHER_ADDR = '0x2222222222222222222222222222222222222222';
const POOL_ID = '0x' + 'ab'.repeat(32);
const OTHER_POOL_ID = '0x' + 'cd'.repeat(32);
const TX = '0x' + 'a'.repeat(64);

// Byte-identical to the ABI the verifier pins.
const IFACE = new ethers.Interface([
  'event PoolContribution(bytes32 indexed poolId, address indexed contributor, uint256 amount, uint256 totalContributed)',
  'event PoolContributionPVT(bytes32 indexed poolId, address indexed contributor, uint256 amount, uint256 totalContributed)',
  'event PoolWithdrawal(bytes32 indexed poolId, address indexed contributor, uint256 amount)',
  'event PoolWithdrawalPVT(bytes32 indexed poolId, address indexed contributor, uint256 amount)',
  'event PoolRefunded(bytes32 indexed poolId, uint256 contributorCount)',
  'event PoolRefundedPVT(bytes32 indexed poolId, uint256 contributorCount)',
]);

function log(name: string, args: unknown[], address = POOL) {
  const { topics, data } = IFACE.encodeEventLog(name, args);
  return { address, topics, data };
}

function receipt(logs: Array<ReturnType<typeof log>>, overrides: Record<string, unknown> = {}) {
  return {
    status: 1,
    blockNumber: 100,
    confirmations: async () => 12,
    logs,
    ...overrides,
  };
}

/** 8-word pools() struct return (V3 shape); word 6 = status enum. */
function poolStructReturn(status: number): string {
  const zero = '0'.repeat(64);
  const statusWord = status.toString(16).padStart(64, '0');
  return '0x' + zero.repeat(6) + statusWord + zero;
}

beforeEach(() => jest.clearAllMocks());

describe('verifyEvmPoolWithdrawal (P4-01)', () => {
  it('confirms a real USDC withdrawal (contributor + amount + poolId match)', async () => {
    const amount = 10_000_000n; // 10 USDC atomic (usdcToAtomic(10))
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolWithdrawal', [POOL_ID, CONTRIBUTOR, amount])]),
    );
    const r = await verifyEvmPoolWithdrawal({
      chainId: BASE,
      txHash: TX,
      poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR,
      currency: 'usdc',
      expectedAmountUsdc: 10,
      expectedPoolId: POOL_ID,
    });
    expect(r.ok).toBe(true);
  });

  it('confirms a real PVT withdrawal via the PVT event variant', async () => {
    const amountWei = 50n * 10n ** 18n;
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolWithdrawalPVT', [POOL_ID, CONTRIBUTOR, amountWei])]),
    );
    const r = await verifyEvmPoolWithdrawal({
      chainId: BASE,
      txHash: TX,
      poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR,
      currency: 'pvt',
      expectedAmountPvtWei: amountWei,
      expectedPoolId: POOL_ID,
    });
    expect(r.ok).toBe(true);
  });

  it('REJECTS when the on-chain withdrawer is a different contributor (no self-forge)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolWithdrawal', [POOL_ID, OTHER_ADDR, 10_000_000n])]),
    );
    const r = await verifyEvmPoolWithdrawal({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10, expectedPoolId: POOL_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pool_withdrawal_contributor_mismatch');
  });

  it('REJECTS when the withdrawn amount differs from the recorded contribution', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolWithdrawal', [POOL_ID, CONTRIBUTOR, 5_000_000n])]),
    );
    const r = await verifyEvmPoolWithdrawal({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10, expectedPoolId: POOL_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pool_withdrawal_amount_or_poolid_mismatch');
  });

  it('REJECTS a same-contract withdrawal from a DIFFERENT pool (poolId binding)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolWithdrawal', [OTHER_POOL_ID, CONTRIBUTOR, 10_000_000n])]),
    );
    const r = await verifyEvmPoolWithdrawal({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10, expectedPoolId: POOL_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pool_withdrawal_amount_or_poolid_mismatch');
  });

  it('ignores a PoolWithdrawal emitted by a DIFFERENT contract address', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolWithdrawal', [POOL_ID, CONTRIBUTOR, 10_000_000n], OTHER_CONTRACT)]),
    );
    const r = await verifyEvmPoolWithdrawal({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10, expectedPoolId: POOL_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pool_withdrawal_event_not_found');
  });

  it('rejects a reverted withdrawal tx', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt([], { status: 0 }));
    const r = await verifyEvmPoolWithdrawal({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tx_failed');
  });

  it('still verifies contributor + amount when no poolId binding is supplied (legacy)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolWithdrawal', [POOL_ID, CONTRIBUTOR, 10_000_000n])]),
    );
    const r = await verifyEvmPoolWithdrawal({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10,
      // expectedPoolId omitted
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a bad tx-hash format before any RPC', async () => {
    const r = await verifyEvmPoolWithdrawal({
      chainId: BASE, txHash: 'nope', poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_tx_hash_format');
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe('verifyEvmPoolContribution (entry-side)', () => {
  it('confirms a real USDC contribute (contributor + amount) and returns the on-chain poolId', async () => {
    const amount = 10_000_000n; // usdcToAtomic(10)
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolContribution', [POOL_ID, CONTRIBUTOR, amount, amount])]),
    );
    const r = await verifyEvmPoolContribution({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10,
    });
    expect(r.ok).toBe(true);
    expect(r.poolId).toBe(POOL_ID.toLowerCase());
  });

  it('confirms a real PVT contribute via the PVT event variant', async () => {
    const amountWei = 50n * 10n ** 18n;
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolContributionPVT', [POOL_ID, CONTRIBUTOR, amountWei, amountWei])]),
    );
    const r = await verifyEvmPoolContribution({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'pvt', expectedAmountPvtWei: amountWei,
    });
    expect(r.ok).toBe(true);
    expect(r.poolId).toBe(POOL_ID.toLowerCase());
  });

  it('REJECTS a bare ERC-20 transfer (no PoolContribution event) — the core entry gap', async () => {
    // A bare usdc.transfer(poolContract, amount) emits ONLY an ERC-20 Transfer (from
    // the USDC contract), never a PoolContribution from the pool contract.
    const usdcAddr = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const transferLog = {
      address: usdcAddr,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '0x' + CONTRIBUTOR.slice(2).toLowerCase().padStart(64, '0'),
        '0x' + POOL.slice(2).toLowerCase().padStart(64, '0'),
      ],
      data: '0x' + (10_000_000n).toString(16).padStart(64, '0'),
    };
    mockGetTransactionReceipt.mockResolvedValue(receipt([transferLog]));
    const r = await verifyEvmPoolContribution({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pool_contribution_event_not_found');
    expect(r.poolId).toBeUndefined();
  });

  it('REJECTS when the contribute amount differs from the claimed amount', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolContribution', [POOL_ID, CONTRIBUTOR, 5_000_000n, 5_000_000n])]),
    );
    const r = await verifyEvmPoolContribution({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pool_contribution_amount_mismatch');
  });

  it('REJECTS when the on-chain contributor is someone else', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolContribution', [POOL_ID, OTHER_ADDR, 10_000_000n, 10_000_000n])]),
    );
    const r = await verifyEvmPoolContribution({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pool_contribution_contributor_mismatch');
  });

  it('ignores a PoolContribution emitted by a DIFFERENT contract', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolContribution', [POOL_ID, CONTRIBUTOR, 10_000_000n, 10_000_000n], OTHER_CONTRACT)]),
    );
    const r = await verifyEvmPoolContribution({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pool_contribution_event_not_found');
  });

  it('rejects a reverted contribute tx', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt([], { status: 0 }));
    const r = await verifyEvmPoolContribution({
      chainId: BASE, txHash: TX, poolContractAddress: POOL,
      expectedContributor: CONTRIBUTOR, currency: 'usdc', expectedAmountUsdc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tx_failed');
  });
});

describe('recoverPoolIdFromContributionTx (P4-02 poolId recovery)', () => {
  it('recovers the indexed poolId from the contributor’s PoolContribution event', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolContribution', [POOL_ID, CONTRIBUTOR, 10_000_000n, 10_000_000n])]),
    );
    const id = await recoverPoolIdFromContributionTx({
      chainId: BASE, poolContractAddress: POOL, txHash: TX, expectedContributor: CONTRIBUTOR,
    });
    expect(id).toBe(POOL_ID.toLowerCase());
  });

  it('recovers from the PVT contribution variant', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolContributionPVT', [POOL_ID, CONTRIBUTOR, 1n, 1n])]),
    );
    const id = await recoverPoolIdFromContributionTx({
      chainId: BASE, poolContractAddress: POOL, txHash: TX, expectedContributor: CONTRIBUTOR,
    });
    expect(id).toBe(POOL_ID.toLowerCase());
  });

  it('returns null when no contribution by this contributor is in the tx', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PoolContribution', [POOL_ID, OTHER_ADDR, 1n, 1n])]),
    );
    const id = await recoverPoolIdFromContributionTx({
      chainId: BASE, poolContractAddress: POOL, txHash: TX, expectedContributor: CONTRIBUTOR,
    });
    expect(id).toBeNull();
  });

  it('returns null on an unreadable receipt (fail-closed)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(null);
    const id = await recoverPoolIdFromContributionTx({
      chainId: BASE, poolContractAddress: POOL, txHash: TX, expectedContributor: CONTRIBUTOR,
    });
    expect(id).toBeNull();
  });
});

describe('readOnchainPoolStatus', () => {
  it('reads the Refunded status (3) from word 6 of the pools() struct', async () => {
    mockCall.mockResolvedValue(poolStructReturn(3));
    const s = await readOnchainPoolStatus({ chainId: BASE, poolContractAddress: POOL, onchainPoolId: POOL_ID });
    expect(s).toBe(3);
  });

  it('reads the Open status (0)', async () => {
    mockCall.mockResolvedValue(poolStructReturn(0));
    const s = await readOnchainPoolStatus({ chainId: BASE, poolContractAddress: POOL, onchainPoolId: POOL_ID });
    expect(s).toBe(0);
  });

  it('returns null on a too-short return (fail-closed)', async () => {
    mockCall.mockResolvedValue('0x' + '0'.repeat(64 * 3));
    const s = await readOnchainPoolStatus({ chainId: BASE, poolContractAddress: POOL, onchainPoolId: POOL_ID });
    expect(s).toBeNull();
  });

  it('returns null on an RPC error (fail-closed)', async () => {
    mockCall.mockRejectedValue(new Error('boom'));
    const s = await readOnchainPoolStatus({ chainId: BASE, poolContractAddress: POOL, onchainPoolId: POOL_ID });
    expect(s).toBeNull();
  });
});

describe('poolRefundedEventMatches (P4-02 confirmation)', () => {
  it('matches a PoolRefunded log for the pool + poolId', () => {
    const logs = [log('PoolRefunded', [POOL_ID, 3])];
    expect(poolRefundedEventMatches(logs, POOL, POOL_ID)).toBe(true);
  });

  it('matches the PVT refund variant', () => {
    const logs = [log('PoolRefundedPVT', [POOL_ID, 2])];
    expect(poolRefundedEventMatches(logs, POOL, POOL_ID)).toBe(true);
  });

  it('does NOT match a refund for a different poolId', () => {
    const logs = [log('PoolRefunded', [OTHER_POOL_ID, 3])];
    expect(poolRefundedEventMatches(logs, POOL, POOL_ID)).toBe(false);
  });

  it('does NOT match a refund emitted by a different contract', () => {
    const logs = [log('PoolRefunded', [POOL_ID, 3], OTHER_CONTRACT)];
    expect(poolRefundedEventMatches(logs, POOL, POOL_ID)).toBe(false);
  });
});
