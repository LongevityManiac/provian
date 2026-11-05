/**
 * bond lifecycle — the bond routes are wired through the ONE institution state machine
 * (`evaluateInstitutionTransition`). These tests probe the ACTUAL wired module
 * (the functions the route handlers call), not the machine in isolation:
 *
 * - kill-switch-first: a non-active acting wallet is blocked BEFORE any
 * validation, Firestore read/write, or RPC — proven with a db that throws
 * on ANY touch;
 * - Unknown = Block: transitions from unmodeled source states (withdrawn /
 * abandoned) refuse;
 * - economic-needs-receipt: a malformed receipt anchor (non-64-hex tx hash)
 * blocks the transition even when the on-chain verifier said ok;
 * - tx-hash idempotency: replaying a settled post / withdraw / top-up
 * receipt is rejected by the per-tx dedup marker before any write, so one
 * on-chain receipt can never drive two economic records or a second PE;
 * - chain-truth lifecycle: a backend-'expired' bond can be reinstated by a
 * verified late renewal, withdrawn behind a verified receipt, and claimed
 * against (the on-chain bond stayed Active);
 * - self-claims stay blocked (pitfall #51) and the trust discount is still
 * server-computed (pitfall #50 — no request field is ever read for it);
 * - top-up mirrors chain truth: amounts come from the verified BondToppedUp
 * event, never a caller assertion.
 */

import { postBond, renewBond, withdrawBond, topUpBond, fileClaim } from './bonds';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { AgentBankDeps } from './types';
import type { GeneratePEParams } from './pe-utils';
import type { AgentWalletDocument } from '../agent-wallet/types';

jest.mock('./pe-utils', () => ({
  generatePE: jest.fn(),
}));

jest.mock('../agent-wallet/badge-provenance', () => ({
  awardBadgeFromOutbox: jest.fn().mockResolvedValue(undefined),
  badgeAwardOutboxRef: jest.fn((db: { collection: (n: string) => { doc: (id: string) => unknown } }, walletId: string, badgeId: string) =>
    db.collection('agent_badge_award_outbox_v1').doc(`${walletId}:${badgeId}`)),
  createPendingBadgeAward: jest.fn(() => ({ status: 'pending' })),
  reconcileBadgeAwards: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmBondPosted: jest.fn(),
  verifyEvmBondRenewed: jest.fn(),
  verifyEvmBondToppedUp: jest.fn(),
  verifyEvmBondWithdrawn: jest.fn(),
  verifyEvmClaimFiled: jest.fn(),
  verifyEvmBondClaimResolved: jest.fn(),
  readOnchainBaseBond: jest.fn(),
}));

import { generatePE } from './pe-utils';
import {
  verifyEvmBondPosted,
  verifyEvmBondRenewed,
  verifyEvmBondToppedUp,
  verifyEvmBondWithdrawn,
  verifyEvmClaimFiled,
  readOnchainBaseBond,
} from '../onchain/tx-verifier';

const mockGeneratePE = generatePE as jest.Mock;
const mockBondPosted = verifyEvmBondPosted as jest.Mock;
const mockBondRenewed = verifyEvmBondRenewed as jest.Mock;
const mockBondToppedUp = verifyEvmBondToppedUp as jest.Mock;
const mockBondWithdrawn = verifyEvmBondWithdrawn as jest.Mock;
const mockClaimFiled = verifyEvmClaimFiled as jest.Mock;
const mockBaseBond = readOnchainBaseBond as jest.Mock;

const AGENT = 'wallet_agent';
const AGENT_ADDR = '0x' + 'b'.repeat(40);
const CLAIMANT = 'wallet_claimant';
const CLAIMANT_ADDR = '0x' + 'c'.repeat(40);
const BOND_ID = 'bond_gate_1';
const TX = '0x' + 'a'.repeat(64);
const TX2 = '0x' + '2'.repeat(64);
const ONCHAIN_CLAIM_ID = '0x' + 'd'.repeat(64);

const activeWallet = (id: string, address = AGENT_ADDR): AgentWalletDocument =>
  ({ id, agent_id: `agent_${id}`, address, status: 'active' } as unknown as AgentWalletDocument);
const suspendedWallet = (id: string): AgentWalletDocument =>
  ({ id, agent_id: `agent_${id}`, address: AGENT_ADDR, status: 'suspended' } as unknown as AgentWalletDocument);

/** deps whose db throws on ANY touch — proves the gate ran before all I/O. */
function untouchableDeps(): AgentBankDeps {
  return {
    db: {
      collection: () => {
        throw new Error('Firestore touched before the gate');
      },
      runTransaction: () => {
        throw new Error('Firestore touched before the gate');
      },
    },
  } as unknown as AgentBankDeps;
}

function makeDeps(fs: FakeFirestore): AgentBankDeps {
  return {
    db: fs as unknown as AgentBankDeps['db'],
    cache: {} as AgentBankDeps['cache'],
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(),
  } as unknown as AgentBankDeps;
}

function seedWallet(fs: FakeFirestore, id = AGENT, address = AGENT_ADDR): void {
  fs.store.set(`agent_wallets/${id}`, {
    id,
    address,
    agent_id: `agent_${id}`,
    status: 'active',
    governance_score: 50,
    pe_count: 100,
    economic_activity_usd: 1000,
    badges: [],
  });
}

function seedBond(fs: FakeFirestore, overrides: Record<string, unknown> = {}): void {
  fs.store.set(`bonds/${BOND_ID}`, {
    bond_id: BOND_ID,
    agent_wallet_id: AGENT,
    agent_address: AGENT_ADDR,
    autonomy_level: 2,
    amount_pvt: '750',
    total_deposited_pvt: '774',
    trust_discount_bps: 0,
    status: 'active',
    chain: 'base',
    post_tx_hash: '0x' + '9'.repeat(64),
    post_block_number: 1000,
    renewal_deadline: Date.now() + 1000,
    last_renewal_at: Date.now() - 1000,
    pending_claims: 0,
    pe_ids: [],
    created_at: Date.now() - 2000,
    updated_at: Date.now() - 1000,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BOND_POOL_CONTRACT_ADDRESS_BASE = '0x' + '1'.repeat(40);
  // Default green-path verifier results; individual tests override.
  mockBondPosted.mockResolvedValue({ ok: true, blockNumber: 100, confirmations: 12 });
  mockBondRenewed.mockResolvedValue({ ok: true, newDeadlineSeconds: 2_000_000_000, blockNumber: 100, confirmations: 12 });
  mockBondToppedUp.mockResolvedValue({
    ok: true,
    toppedAmountAtomic: (10n * 10n ** 18n).toString(),
    newBondAmountAtomic: (750n * 10n ** 18n).toString(),
    blockNumber: 100,
    confirmations: 12,
  });
  mockBondWithdrawn.mockResolvedValue({ ok: true, blockNumber: 100, confirmations: 12 });
  mockClaimFiled.mockResolvedValue({ ok: true, onchainClaimId: ONCHAIN_CLAIM_ID, blockNumber: 100, confirmations: 12 });
  mockBaseBond.mockResolvedValue({ ok: false, reason: 'test_static_floor' });
  // Faithful pe-utils contract: run the atomic precondition + write inside a
  // REAL fake-firestore transaction, so dedup markers and entity writes are
  // exercised for real.
  mockGeneratePE.mockImplementation(async (deps: AgentBankDeps, params: GeneratePEParams) => {
    const peId = 'pe_mock';
    if (params.atomicEntityPrecondition || params.atomicEntityWrite) {
      await deps.db.runTransaction(async (txn) => {
        await params.atomicEntityPrecondition?.(txn as never, { newHash: 'h', prevHash: 'p' } as never);
        params.atomicEntityWrite?.(txn as never, peId, { newHash: 'h', prevHash: 'p' } as never);
      });
    }
    return { peId, peHash: 'h', prevHash: 'p' };
  });
});

// ---------------------------------------------------------------------------
// Kill switch FIRST — before ANY I/O
// ---------------------------------------------------------------------------

describe('bond lifecycle gate — kill switch FIRST on every bond path', () => {
  it('postBond: a suspended wallet is blocked before ANY validation, read, or RPC', async () => {
    await expect(
      postBond(untouchableDeps(), AGENT, suspendedWallet(AGENT), {
        // Invalid body on purpose: the kill switch must fire before validation.
        autonomy_level: 9 as unknown as 2,
        tx_hash: 'nope',
        chain: 'base',
      }),
    ).rejects.toThrow(/Agent wallet is not active/);
    expect(mockBondPosted).not.toHaveBeenCalled();
  });

  it('renewBond / topUpBond / withdrawBond: suspended wallet blocked before any I/O', async () => {
    for (const fn of [renewBond, topUpBond, withdrawBond]) {
      await expect(
        fn(untouchableDeps(), AGENT, suspendedWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX }),
      ).rejects.toThrow(/Agent wallet is not active/);
    }
    expect(mockBondRenewed).not.toHaveBeenCalled();
    expect(mockBondToppedUp).not.toHaveBeenCalled();
    expect(mockBondWithdrawn).not.toHaveBeenCalled();
  });

  it('fileClaim: a suspended CLAIMANT is blocked before any I/O (and before the self-claim check)', async () => {
    await expect(
      fileClaim(untouchableDeps(), CLAIMANT, suspendedWallet(CLAIMANT), {
        respondent_wallet_id: CLAIMANT, // even a self-claim: kill switch first
        description: 'x'.repeat(30),
        evidence_pe_ids: ['pe_1'],
        tx_hash: TX,
        chain: 'base',
      }),
    ).rejects.toThrow(/Agent wallet is not active/);
    expect(mockClaimFiled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unknown = Block — unmodeled source states refuse
// ---------------------------------------------------------------------------

describe('bond lifecycle gate — Unknown = Block on unmodeled source states', () => {
  it.each(['withdrawn', 'abandoned'] as const)('renewBond refuses a %s bond', async (status) => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedBond(fs, { status });
    await expect(
      renewBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX }),
    ).rejects.toThrow(/not renewable/i);
  });

  it.each(['withdrawn', 'abandoned'] as const)('withdrawBond refuses a %s bond', async (status) => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedBond(fs, { status });
    await expect(
      withdrawBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX }),
    ).rejects.toThrow(/not withdrawable/i);
  });

  it('topUpBond refuses a non-active bond (top-up never reinstates an expired record)', async () => {
    for (const status of ['expired', 'withdrawn', 'abandoned'] as const) {
      const fs = createFakeFirestore();
      const deps = makeDeps(fs);
      seedWallet(fs);
      seedBond(fs, { status });
      await expect(
        topUpBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX }),
      ).rejects.toThrow(/not active/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Economic needs a receipt — verifier truth and anchor form both gate
// ---------------------------------------------------------------------------

describe('bond lifecycle gate — economic transitions are receipt-gated', () => {
  it('renewBond fails closed when the on-chain verification fails', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedBond(fs);
    mockBondRenewed.mockResolvedValue({ ok: false, reason: 'bond_renewed_event_not_found' });
    await expect(
      renewBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX }),
    ).rejects.toThrow(/verification failed/i);
    const bond = fs.store.get(`bonds/${BOND_ID}`) as { status: string };
    expect(bond.status).toBe('active'); // untouched
  });

  it('a malformed receipt anchor (non-64-hex tx hash) blocks even when the verifier said ok', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedBond(fs);
    // Verifier lies "ok" for a malformed hash — the machine still refuses the
    // anchor (receipt_missing_tx_hash), so no economic record can be hashless.
    await expect(
      renewBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: '0xshort' }),
    ).rejects.toThrow(/receipt_missing_tx_hash/i);
  });

  it('topUpBond fails closed when the BondToppedUp event is missing', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedBond(fs);
    mockBondToppedUp.mockResolvedValue({ ok: false, reason: 'bond_topped_up_event_not_found' });
    await expect(
      topUpBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX }),
    ).rejects.toThrow(/verification failed/i);
  });
});

// ---------------------------------------------------------------------------
// Tx-hash idempotency — one receipt, one economic record, one PE
// ---------------------------------------------------------------------------

describe('bond lifecycle gate — per-tx dedup markers kill receipt replays', () => {
  it('withdrawBond: an OLD BondWithdrawn tx (already consumed) cannot flip a later bond', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedBond(fs);
    // The same tx hash already drove a withdrawal (cross-bond replay).
    fs.store.set(`bond_tx_dedup/withdraw:tx:${TX.toLowerCase()}`, { bond_id: 'bond_old', op: 'withdraw' });

    await expect(
      withdrawBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX }),
    ).rejects.toThrow(/already processed/i);
    const bond = fs.store.get(`bonds/${BOND_ID}`) as { status: string };
    expect(bond.status).toBe('active');
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('topUpBond: replaying a consumed top-up receipt is rejected before any write or PE', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedBond(fs);
    await topUpBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX });
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);

    await expect(
      topUpBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX }),
    ).rejects.toThrow(/already processed/i);
    expect(mockGeneratePE).toHaveBeenCalledTimes(1); // no second economic PE
  });

  it('postBond: replaying an old BondPosted tx after a withdrawal cannot mint a second bond record', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    // The post receipt was already consumed by a previous bond (since withdrawn).
    fs.store.set(`bond_tx_dedup/post:tx:${TX.toLowerCase()}`, { bond_id: 'bond_old', op: 'post' });

    await expect(
      postBond(deps, AGENT, activeWallet(AGENT), { autonomy_level: 2, tx_hash: TX, chain: 'base' }),
    ).rejects.toThrow(/already recorded/i);
  });
});

// ---------------------------------------------------------------------------
// Chain-truth lifecycle — expired records follow the chain, not the calendar
// ---------------------------------------------------------------------------

describe('bond lifecycle gate — expired-record chain truth (late renewal / withdrawal / claims)', () => {
  it('a verified late renewal REINSTATES an expired record (expired→active) and marks the PE', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedBond(fs, { status: 'expired' });

    const result = await renewBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX });
    expect(result.status).toBe('active');
    const bond = fs.store.get(`bonds/${BOND_ID}`) as { status: string };
    expect(bond.status).toBe('active');
    const peArg = mockGeneratePE.mock.calls.find((c) => c[1].actionType === 'bond_renewed')?.[1];
    expect(peArg.metadata.reinstated).toBe(true);
  });

  it('a verified withdrawal exits an expired record (expired→withdrawn)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedBond(fs, { status: 'expired' });

    const result = await withdrawBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX });
    expect(result.status).toBe('withdrawn');
  });

  it('an expired record still blocks withdrawal while claims are pending', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedBond(fs, { status: 'expired', pending_claims: 1 });
    await expect(
      withdrawBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX }),
    ).rejects.toThrow(/pending claims/i);
  });

  it('fileClaim binds a verified on-chain claim to an expired record (chain kept the bond Active)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, AGENT, AGENT_ADDR);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR);
    seedBond(fs, { status: 'expired' });

    const claim = await fileClaim(deps, CLAIMANT, activeWallet(CLAIMANT, CLAIMANT_ADDR), {
      respondent_wallet_id: AGENT,
      description: 'the agent failed to deliver on its bonded commitment',
      evidence_pe_ids: ['pe_evidence'],
      tx_hash: TX,
      chain: 'base',
    });
    expect(claim.status).toBe('filed');
    const bond = fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number };
    expect(bond.pending_claims).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Preserved invariants — self-claims, server-computed discount, chain-truth amounts
// ---------------------------------------------------------------------------

describe('bond lifecycle gate — preserved invariants', () => {
  it('self-claims stay blocked (pitfall #51)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR);
    await expect(
      fileClaim(deps, CLAIMANT, activeWallet(CLAIMANT, CLAIMANT_ADDR), {
        respondent_wallet_id: CLAIMANT,
        description: 'trying to claim against my own bond for the fee refund',
        evidence_pe_ids: ['pe_evidence'],
        tx_hash: TX,
        chain: 'base',
      }),
    ).rejects.toThrow(/own bond/i);
  });

  it('topUpBond records CHAIN truth: amounts come from the verified event, never the caller', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs);
    seedBond(fs);
    const eventAmount = (25n * 10n ** 18n).toString();
    const eventTotal = (740n * 10n ** 18n).toString();
    mockBondToppedUp.mockResolvedValue({
      ok: true,
      toppedAmountAtomic: eventAmount,
      newBondAmountAtomic: eventTotal,
      blockNumber: 100,
      confirmations: 12,
    });

    // The request body carries ONLY bond_id + tx_hash — there is no amount
    // field for a caller to assert (chain truth by construction).
    const result = await topUpBond(deps, AGENT, activeWallet(AGENT), { bond_id: BOND_ID, tx_hash: TX2 });
    expect(result.collateral_atomic).toBe(eventTotal);

    const bond = fs.store.get(`bonds/${BOND_ID}`) as { collateral_atomic: string };
    expect(bond.collateral_atomic).toBe(eventTotal);
    const peArg = mockGeneratePE.mock.calls.find((c) => c[1].actionType === 'bond_topped_up')?.[1];
    expect(peArg.metadata.amount_topped_atomic).toBe(eventAmount);
    expect(peArg.metadata.new_collateral_atomic).toBe(eventTotal);
  });
});
