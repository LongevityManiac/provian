/**
 * contribute() entry-side on-chain verification + onchain_pool_id binding.
 *
 * Pre-fix: contribute() verified only a bare ERC-20 `Transfer` into the pool
 * contract (`verifyTransfer`), so a bare `usdc.transfer(poolContract, X)` — funds
 * moved into the contract but NEVER credited to `contributions`/`contributorList`
 * on-chain (uncontributable, unwithdrawable, unrefundable) — passed and was recorded
 * as a Firestore contributor. That malformed state is exactly what the exit legs'
 * adversarial review had to defend against. Post-fix: contribute() verifies a REAL
 * on-chain `contribute` (the `PoolContribution` event) and binds the recovered
 * on-chain bytes32 poolId to the pool (first contributor sets it; later contributors
 * must match). This suite locks in: no on-chain contribute → no Firestore write, and
 * every recorded contributor is bound to one on-chain poolId.
 */

import { contribute } from './pools';
import { ValidationError, NotFoundError } from './errors';
import type { AgentBankDeps, PoolDocument } from './types';
import type { GeneratePEParams } from './pe-utils';

/**
 * Bound to production's own field name — `Extract` is `never`, and this line an
 * assignment error, the moment `GeneratePEParams` stops declaring it. See
 * `relay-emitter-durability-fence.test.ts` for why relay emitters must not
 * carry it.
 */
const DURABLE_MARKER: Extract<keyof GeneratePEParams, 'durableViaOrdinaryIntake'> =
  'durableViaOrdinaryIntake';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_contrib', peHash: 'h', prevHash: 'p' });
jest.mock('./pe-utils', () => ({
  generatePE: (...a: unknown[]) => mockGeneratePE(...a),
  generateSchedulerPE: (...a: unknown[]) => mockGeneratePE(...a),
}));

const mockVerifyContribution = jest.fn();
jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmPoolContribution: (...a: unknown[]) => mockVerifyContribution(...a),
  verifyEvmPoolWithdrawal: jest.fn(),
  recoverPoolIdFromContributionTx: jest.fn(),
  verifyEvmContractCall: jest.fn(),
}));

const mockUpdateWalletStats = jest.fn().mockResolvedValue(undefined);
jest.mock('./wallet-stats', () => ({ updateWalletStats: (...a: unknown[]) => mockUpdateWalletStats(...a) }));

jest.mock('./pvt-principal-config', () => ({
  isPvtPrincipalEnabledForChain: () => true,
  // chain-registry now consults this first; undefined → env fallback (the
  // POOL_V3_CONTRACT_ADDRESS_BASE this suite sets).
  pvtPrincipalInstitutionAddress: () => undefined,
}));

const POOL_ID = '0x' + 'ab'.repeat(32);
const POOL_ID_OTHER = '0x' + 'cd'.repeat(32);
const CONTRIB_ADDR = '0x1111111111111111111111111111111111111111';
const CONTRIB_TX = '0x' + 'c'.repeat(64);

function makeDeps(pool: PoolDocument | null, opts: { fresh?: PoolDocument | null; wallet?: unknown } = {}) {
  const wallet = opts.wallet ?? { agent_id: 'agent_a', address: CONTRIB_ADDR };
  const fresh = opts.fresh === undefined ? pool : opts.fresh;
  const poolRef = { get: jest.fn(async () => ({ exists: pool != null, data: () => pool })) };
  const walletRef = { get: jest.fn(async () => ({ exists: wallet != null, data: () => wallet })) };
  const txUpdate = jest.fn();
  const db = {
    collection: jest.fn((name: string) => ({ doc: jest.fn(() => (name === 'pools' ? poolRef : walletRef)) })),
    runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: jest.fn(async () => ({ exists: fresh != null, data: () => fresh })),
        update: jest.fn((_ref: unknown, patch: Record<string, unknown>) => txUpdate(patch)),
      };
      return fn(tx);
    }),
  };
  return { deps: { db } as unknown as AgentBankDeps, txUpdate };
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
    total_contributed_usdc: 0,
    max_contributors: 10,
    chain: 'base',
    deadline: 0,
    status: 'open',
    contributions: {},
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
  mockGeneratePE.mockResolvedValue({ peId: 'pe_contrib', peHash: 'h', prevHash: 'p' });
  mockVerifyContribution.mockResolvedValue({ ok: true, poolId: POOL_ID });
});

describe('contribute - guards', () => {
  it('404s an unknown pool', async () => {
    const { deps } = makeDeps(null);
    await expect(contribute(deps, 'pool_x', 'wallet_a', { amountUsdc: 10 }, CONTRIB_TX)).rejects.toThrow(NotFoundError);
  });

  it('rejects a pool that is not open', async () => {
    const { deps } = makeDeps(usdcPool({ status: 'funded' }));
    await expect(contribute(deps, 'pool_1', 'wallet_a', { amountUsdc: 10 }, CONTRIB_TX)).rejects.toThrow(/expected open/);
  });

  it('rejects a non-positive USDC amount', async () => {
    const { deps } = makeDeps(usdcPool());
    await expect(contribute(deps, 'pool_1', 'wallet_a', { amountUsdc: 0 }, CONTRIB_TX)).rejects.toThrow(/amount_usdc/);
  });
});

describe('contribute - entry-side on-chain verification is load-bearing', () => {
  it('FAILS CLOSED on a bare transfer (no PoolContribution) — no Firestore write, no PE', async () => {
    mockVerifyContribution.mockResolvedValue({ ok: false, reason: 'pool_contribution_event_not_found' });
    const { deps, txUpdate } = makeDeps(usdcPool());
    await expect(contribute(deps, 'pool_1', 'wallet_a', { amountUsdc: 10 }, CONTRIB_TX))
      .rejects.toThrow(/On-chain pool contribution verification failed: pool_contribution_event_not_found/);
    expect(txUpdate).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when verification returns ok but no poolId', async () => {
    mockVerifyContribution.mockResolvedValue({ ok: true, poolId: undefined });
    const { deps, txUpdate } = makeDeps(usdcPool());
    await expect(contribute(deps, 'pool_1', 'wallet_a', { amountUsdc: 10 }, CONTRIB_TX)).rejects.toThrow(/no_pool_id/);
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('verifies against the contributor + amount + currency', async () => {
    const { deps } = makeDeps(usdcPool());
    await contribute(deps, 'pool_1', 'wallet_a', { amountUsdc: 25 }, CONTRIB_TX);
    expect(mockVerifyContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: CONTRIB_TX,
        expectedContributor: CONTRIB_ADDR,
        currency: 'usdc',
        expectedAmountUsdc: 25,
      }),
    );
  });
});

describe('contribute - onchain_pool_id binding', () => {
  it('FIRST contributor binds the pool to the recovered on-chain poolId', async () => {
    const { deps, txUpdate } = makeDeps(usdcPool());
    const result = await contribute(deps, 'pool_1', 'wallet_a', { amountUsdc: 40 }, CONTRIB_TX);
    expect(txUpdate).toHaveBeenCalledWith(expect.objectContaining({ onchain_pool_id: POOL_ID }));
    expect(result.onchain_pool_id).toBe(POOL_ID);
    expect(mockGeneratePE.mock.calls[0][1].actionType).toBe('pool_contributed');
    // (RATIFIED): the durability marker is WATCHER-ONLY. A durable
    // `pool_contributed` here would be a policy-eligible row on the SAME
    // canonical event the institution funding watcher earns on — the
    // double-mint forbids. Runtime half of the fence in
    // `relay-emitter-durability-fence.test.ts`: that file scans the source,
    // this sees what is actually passed.
    expect(
      Object.prototype.hasOwnProperty.call(
        mockGeneratePE.mock.calls[0][1] as object,
        DURABLE_MARKER,
      ),
    ).toBe(false);
  });

  it('LATER contributor whose contribute targets the SAME poolId is accepted, does not re-bind', async () => {
    const bound = usdcPool({ onchain_pool_id: POOL_ID, total_contributed_usdc: 40, contributions: {
      wallet_a: { address: '0x' + '9'.repeat(40), amount_usdc: 40, contributed_at: 0, tx_hash: '0x' + '8'.repeat(64) },
    } });
    mockVerifyContribution.mockResolvedValue({ ok: true, poolId: POOL_ID });
    const { deps, txUpdate } = makeDeps(bound);
    await contribute(deps, 'pool_1', 'wallet_b', { amountUsdc: 30 }, CONTRIB_TX);
    // Already bound → the update must NOT re-write onchain_pool_id.
    const patch = txUpdate.mock.calls[0][0];
    expect(patch.onchain_pool_id).toBeUndefined();
    expect(patch['contributions.wallet_b']).toBeDefined();
  });

  it('REJECTS a contribution whose on-chain contribute targets a DIFFERENT pool (cross-pool guard)', async () => {
    const bound = usdcPool({ onchain_pool_id: POOL_ID });
    mockVerifyContribution.mockResolvedValue({ ok: true, poolId: POOL_ID_OTHER });
    const { deps, txUpdate } = makeDeps(bound);
    await expect(contribute(deps, 'pool_1', 'wallet_b', { amountUsdc: 10 }, CONTRIB_TX))
      .rejects.toThrow(/does not match this pool's bound on-chain poolId/);
    expect(txUpdate).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });
});

describe('contribute - PVT branch', () => {
  it('verifies with expectedAmountPvtWei and binds onchain_pool_id', async () => {
    const pvtPool = usdcPool({
      currency: 'pvt',
      threshold_pvt: '100000000000000000000',
      total_contributed_pvt: '0',
    });
    mockVerifyContribution.mockResolvedValue({ ok: true, poolId: POOL_ID });
    const { deps, txUpdate } = makeDeps(pvtPool);
    await contribute(deps, 'pool_1', 'wallet_a', { amountPvtWei: 50000000000000000000n }, CONTRIB_TX);
    expect(mockVerifyContribution).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'pvt', expectedAmountPvtWei: 50000000000000000000n }),
    );
    expect(txUpdate).toHaveBeenCalledWith(expect.objectContaining({ onchain_pool_id: POOL_ID }));
    expect(mockGeneratePE.mock.calls[0][1].metadata).toMatchObject({ currency: 'pvt' });
  });
});
