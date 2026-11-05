/**
 * withdrawContribution (P4-01) — the user-initiated pool exit.
 *
 * Pre-fix: the route reported "Contribution withdrawn successfully" and deleted
 * the Firestore contribution with NO on-chain withdrawal — funds stayed locked in
 * the pool contract. Post-fix: the caller broadcasts the msg.sender-bound
 * withdrawContribution(bytes32) and passes its tx_hash; the relay VERIFIES the
 * on-chain PoolWithdrawal event before deleting the contribution or emitting the
 * pool_withdrawn PE. This suite locks in that no state changes / no PE is asserted
 * unless the on-chain withdrawal verifies.
 */

import { withdrawContribution } from './pools';
import { ValidationError, NotFoundError } from './errors';
import type { AgentBankDeps, PoolDocument } from './types';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_withdraw', peHash: 'h', prevHash: 'p' });
jest.mock('./pe-utils', () => ({
  generatePE: (...a: unknown[]) => mockGeneratePE(...a),
  generateSchedulerPE: (...a: unknown[]) => mockGeneratePE(...a),
}));

const mockVerifyWithdrawal = jest.fn();
const mockRecoverPoolId = jest.fn();
jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmPoolWithdrawal: (...a: unknown[]) => mockVerifyWithdrawal(...a),
  recoverPoolIdFromContributionTx: (...a: unknown[]) => mockRecoverPoolId(...a),
  verifyTransfer: jest.fn(),
  verifyEvmContractCall: jest.fn(),
}));

// Avoid the PVT-principal env/cache dance — the pool-currency routing just needs
// this predicate true for the PVT contract-address resolver.
jest.mock('./pvt-principal-config', () => ({
  isPvtPrincipalEnabledForChain: () => true,
  // chain-registry now consults this first; undefined → env fallback.
  pvtPrincipalInstitutionAddress: () => undefined,
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: () => '__DELETE__',
    arrayUnion: (...a: unknown[]) => ({ __arrayUnion: a }),
  },
}));

const POOL_ID = '0x' + 'ab'.repeat(32);
const CONTRIB_ADDR = '0x1111111111111111111111111111111111111111';
const CONTRIB_TX = '0x' + 'c'.repeat(64);
const WITHDRAW_TX = '0x' + 'd'.repeat(64);

function makeDeps(pool: PoolDocument | null, wallet: unknown = { agent_id: 'agent_a', address: CONTRIB_ADDR }) {
  const poolRef = {
    get: jest.fn(async () => ({ exists: pool != null, data: () => pool })),
    update: jest.fn(async () => {}),
  };
  const walletRef = { get: jest.fn(async () => ({ exists: wallet != null, data: () => wallet })) };
  const db = {
    collection: jest.fn((name: string) => ({
      doc: jest.fn(() => (name === 'pools' ? poolRef : walletRef)),
    })),
  };
  return { deps: { db } as unknown as AgentBankDeps, poolRef, walletRef };
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
      wallet_a: { address: CONTRIB_ADDR, amount_usdc: 40, contributed_at: 0, tx_hash: CONTRIB_TX },
    },
    pe_ids: [],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as PoolDocument;
}

beforeAll(() => {
  process.env.POOL_CONTRACT_ADDRESS_BASE = '0x' + '5'.repeat(40);
  process.env.POOL_V3_CONTRACT_ADDRESS_BASE = '0x' + '6'.repeat(40);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGeneratePE.mockResolvedValue({ peId: 'pe_withdraw', peHash: 'h', prevHash: 'p' });
  mockRecoverPoolId.mockResolvedValue(POOL_ID);
  mockVerifyWithdrawal.mockResolvedValue({ ok: true });
});

describe('withdrawContribution - guards (fail before any on-chain verify)', () => {
  it('requires a tx_hash', async () => {
    const { deps, poolRef } = makeDeps(usdcPool());
    await expect(withdrawContribution(deps, 'pool_1', 'wallet_a', '')).rejects.toThrow(ValidationError);
    expect(poolRef.get).not.toHaveBeenCalled();
  });

  it('404s an unknown pool', async () => {
    const { deps } = makeDeps(null);
    await expect(withdrawContribution(deps, 'pool_x', 'wallet_a', WITHDRAW_TX)).rejects.toThrow(NotFoundError);
  });

  it('rejects a pool that is not open', async () => {
    const { deps } = makeDeps(usdcPool({ status: 'funded' }));
    await expect(withdrawContribution(deps, 'pool_1', 'wallet_a', WITHDRAW_TX)).rejects.toThrow(/expected open/);
  });

  it('rejects a wallet with no contribution', async () => {
    const { deps } = makeDeps(usdcPool({ contributions: {} }));
    await expect(withdrawContribution(deps, 'pool_1', 'wallet_a', WITHDRAW_TX)).rejects.toThrow(/No contribution/);
  });
});

describe('withdrawContribution - on-chain verification is load-bearing', () => {
  it('FAILS CLOSED when the on-chain withdrawal cannot be verified (no Firestore change, no PE)', async () => {
    mockVerifyWithdrawal.mockResolvedValue({ ok: false, reason: 'pool_withdrawal_event_not_found' });
    const { deps, poolRef } = makeDeps(usdcPool());
    await expect(withdrawContribution(deps, 'pool_1', 'wallet_a', WITHDRAW_TX))
      .rejects.toThrow(/On-chain pool withdrawal verification failed: pool_withdrawal_event_not_found/);
    expect(poolRef.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('binds the verification to this contributor + amount + recovered poolId', async () => {
    const { deps } = makeDeps(usdcPool());
    await withdrawContribution(deps, 'pool_1', 'wallet_a', WITHDRAW_TX);
    expect(mockVerifyWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: WITHDRAW_TX,
        expectedContributor: CONTRIB_ADDR,
        currency: 'usdc',
        expectedAmountUsdc: 40,
        expectedPoolId: POOL_ID,
      }),
    );
  });

  it('still verifies (without poolId binding) when the poolId cannot be recovered', async () => {
    mockRecoverPoolId.mockResolvedValue(null);
    const { deps } = makeDeps(usdcPool());
    await withdrawContribution(deps, 'pool_1', 'wallet_a', WITHDRAW_TX);
    const arg = mockVerifyWithdrawal.mock.calls[0][0];
    expect(arg.expectedPoolId).toBeUndefined();
    expect(arg.expectedContributor).toBe(CONTRIB_ADDR);
  });

  it('prefers the pool’s stored, entry-verified onchain_pool_id (no recovery RPC)', async () => {
    const storedPoolId = '0x' + 'ef'.repeat(32);
    const { deps } = makeDeps(usdcPool({ onchain_pool_id: storedPoolId }));
    await withdrawContribution(deps, 'pool_1', 'wallet_a', WITHDRAW_TX);
    expect(mockRecoverPoolId).not.toHaveBeenCalled();
    expect(mockVerifyWithdrawal).toHaveBeenCalledWith(expect.objectContaining({ expectedPoolId: storedPoolId }));
  });
});

describe('withdrawContribution - confirmed withdrawal effects', () => {
  it('USDC: deletes the contribution, decrements the total, emits a verified pool_withdrawn PE', async () => {
    const { deps, poolRef } = makeDeps(usdcPool());
    const result = await withdrawContribution(deps, 'pool_1', 'wallet_a', WITHDRAW_TX);

    expect(poolRef.update).toHaveBeenCalledWith(
      expect.objectContaining({
        'contributions.wallet_a': '__DELETE__',
        total_contributed_usdc: 0,
      }),
    );
    const peArg = mockGeneratePE.mock.calls[0][1];
    expect(peArg.actionType).toBe('pool_withdrawn');
    expect(peArg.metadata).toMatchObject({
      pool_id: 'pool_1',
      currency: 'usdc',
      tx_hash: WITHDRAW_TX,
      onchain_withdraw_confirmed: true,
      withdrawn_usdc: 40,
    });
    expect(result.contributions.wallet_a).toBeUndefined();
    expect(result.pe_ids).toContain('pe_withdraw');
  });

  it('PVT: uses the PVT event variant + withdrawn_pvt metadata + decrements total_contributed_pvt', async () => {
    const pvtPool = usdcPool({
      currency: 'pvt',
      total_contributed_pvt: '50000000000000000000',
      contributions: {
        wallet_a: {
          address: CONTRIB_ADDR,
          amount_usdc: 0,
          amount_pvt: '50000000000000000000',
          contributed_at: 0,
          tx_hash: CONTRIB_TX,
        },
      },
    });
    const { deps, poolRef } = makeDeps(pvtPool);
    await withdrawContribution(deps, 'pool_1', 'wallet_a', WITHDRAW_TX);

    expect(mockVerifyWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'pvt', expectedAmountPvtWei: 50000000000000000000n }),
    );
    expect(poolRef.update).toHaveBeenCalledWith(
      expect.objectContaining({ 'contributions.wallet_a': '__DELETE__', total_contributed_pvt: '0' }),
    );
    const peArg = mockGeneratePE.mock.calls[0][1];
    expect(peArg.metadata).toMatchObject({ currency: 'pvt', withdrawn_pvt: '50000000000000000000' });
  });
});
