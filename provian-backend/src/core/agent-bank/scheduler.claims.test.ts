/**
 * processStaleClaims — Pass-3 #3 (Session B backend leg).
 *
 * A bond claim left 'filed' past CLAIM_RESOLUTION_TIMEOUT (60d) with no Court
 * panel/verdict freezes the respondent's collateral forever (pendingClaims > 0,
 * no admin escape). The on-chain expireStaleClaim() is the permissionless liveness
 * exit; this scheduler drives it and mirrors the pendingClaims decrement off the
 * ClaimExpired log. Fail-before: processStaleClaims did not exist; pass-after: it
 * expires stale claims truthfully and never asserts an effect the chain didn't emit.
 */

import { processStaleClaims, processFiledClaimCourtSettlements } from './scheduler';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { AgentBankDeps } from './types';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_mock', peHash: 'h', prevHash: 'p' });
jest.mock('./pe-utils', () => ({
  generateSchedulerPE: (...args: unknown[]) => mockGeneratePE(...args),
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

// bond lifecycle: the claim-expiry mirror recovers a Base-final ClaimExpired receipt when
// another caller drove the on-chain timeout. Mockable per-case.
const mockRecoverClaimExpired = jest.fn();
// agent directory: the Court-settlement mirror recovers BondSlashed/ClaimDismissed logs and
// verifies the recovered tx through verifyEvmBondClaimResolved.
const mockRecoverResolution = jest.fn();
const mockClaimResolved = jest.fn();
jest.mock('../onchain/tx-verifier', () => ({
  readOnchainBondStatus: jest.fn(),
  recoverEvmClaimExpired: (...args: unknown[]) => mockRecoverClaimExpired(...args),
  recoverEvmBondAbandoned: jest.fn(),
  recoverEvmBondClaimResolution: (...args: unknown[]) => mockRecoverResolution(...args),
  // bonds.ts (loaded transitively via scheduler.ts) imports these; unused here.
  verifyEvmBondPosted: jest.fn(),
  verifyEvmBondRenewed: jest.fn(),
  verifyEvmBondToppedUp: jest.fn(),
  verifyEvmBondWithdrawn: jest.fn(),
  verifyEvmClaimFiled: jest.fn(),
  verifyEvmBondClaimResolved: (...args: unknown[]) => mockClaimResolved(...args),
  readOnchainBaseBond: jest.fn(),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

// bond lifecycle: the machine requires well-formed 64-hex receipt anchors.
const EXPIRE_TX = '0x' + 'e'.repeat(64);
const RECOVERED_TX = '0x' + 'f'.repeat(64);

interface FakeRef {
  id: string;
  update: jest.Mock;
  _snap: () => { exists: boolean; data: () => Record<string, unknown> | null };
  _set: (d: Record<string, unknown> | null) => void;
}

function makeRef(id: string, data: Record<string, unknown> | null): FakeRef {
  const state: { current: Record<string, unknown> | null } = { current: data };
  const update = jest.fn(async (patch: Record<string, unknown>) => {
    if (state.current) state.current = { ...state.current, ...patch };
  });
  return {
    id,
    update,
    _snap: () => ({ exists: state.current !== null, data: () => state.current }),
    _set: (d) => { state.current = d; },
  };
}

interface ClaimSnap {
  id: string;
  data: () => Record<string, unknown>;
  ref: FakeRef;
}

function makeClaimSnap(overrides: Record<string, unknown> = {}): ClaimSnap {
  const data = {
    claim_id: 'claim_1',
    bond_id: 'bond_1',
    claimant_wallet_id: 'wallet_claimant',
    respondent_wallet_id: 'wallet_respondent',
    respondent_address: '0x' + 'b'.repeat(40),
    status: 'filed',
    chain: 'base',
    onchain_claim_id: '0x' + 'c'.repeat(64),
    created_at: Date.now() - 90 * DAY_MS, // 90d old — past the 60d timeout
    ...overrides,
  };
  const ref = makeRef(data.claim_id as string, { ...data });
  return { id: data.claim_id as string, data: () => data, ref };
}

interface ClaimKeeperMock {
  canSign: jest.Mock;
  processAbandonment: jest.Mock;
  expireStaleClaim: jest.Mock;
}

function makeClaimKeeper(result: Record<string, unknown>, canSign = true): ClaimKeeperMock {
  return {
    canSign: jest.fn(() => canSign),
    processAbandonment: jest.fn(),
    expireStaleClaim: jest.fn().mockResolvedValue(result),
  };
}

function makeDeps(
  claimSnaps: ClaimSnap[],
  bondRef: FakeRef,
  keeper?: ClaimKeeperMock,
): { deps: AgentBankDeps; whereCalls: Array<{ field: string; op: string; value: unknown }> } {
  const whereCalls: Array<{ field: string; op: string; value: unknown }> = [];
  interface QueryMock { where: jest.Mock; limit: jest.Mock; get: jest.Mock }
  const claimsCollection: QueryMock = {
    where: jest.fn((field: string, op: string, value: unknown) => {
      whereCalls.push({ field, op, value });
      return claimsCollection;
    }),
    limit: jest.fn(() => claimsCollection),
    get: jest.fn().mockResolvedValue({ empty: claimSnaps.length === 0, size: claimSnaps.length, docs: claimSnaps }),
  };
  const bondsCollection = { doc: jest.fn(() => bondRef) };
  const agentWalletsCollection = { doc: jest.fn((id: string) => ({ id })) };
  const db = {
    collection: jest.fn((name: string) => {
      if (name === 'bond_claims') return claimsCollection;
      if (name === 'bonds') return bondsCollection;
      return agentWalletsCollection;
    }),
    getAll: jest.fn(async (...refs: Array<{ id: string }>) =>
      refs.map((r) => ({ exists: true, id: r.id, data: () => ({ agent_id: `agent-${r.id}`, address: '0xwallet' }) })),
    ),
    runTransaction: jest.fn(async (fn: (txn: unknown) => Promise<void>) => {
      const txn = {
        get: jest.fn(async (ref: FakeRef) => ref._snap()),
        update: jest.fn((ref: FakeRef, patch: Record<string, unknown>) => { void ref.update(patch); }),
        set: jest.fn(),
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

describe('processStaleClaims — stale bond-claim expiry (Pass-3 #3)', () => {
  it('queries filed claims older than the on-chain 60d CLAIM_RESOLUTION_TIMEOUT', async () => {
    const { deps, whereCalls } = makeDeps([], makeRef('bond_1', { pending_claims: 1 }));
    const before = Date.now();
    await processStaleClaims(deps);
    const after = Date.now();

    expect(whereCalls).toContainEqual({ field: 'status', op: '==', value: 'filed' });
    const createdBound = whereCalls.find((c) => c.field === 'created_at' && c.op === '<=');
    expect(createdBound).toBeDefined();
    const cutoff = createdBound!.value as number;
    // cutoff = now - 60d, now captured inside the call → cutoff ∈ [before-60d, after-60d].
    expect(after - cutoff).toBeGreaterThanOrEqual(60 * DAY_MS);
    expect(before - cutoff).toBeLessThanOrEqual(60 * DAY_MS);
  });

  it('expires a stale filed claim, decrements the bond pending_claims, emits the PE', async () => {
    const claim = makeClaimSnap();
    const bondRef = makeRef('bond_1', { bond_id: 'bond_1', pending_claims: 2 });
    const keeper = makeClaimKeeper({ status: 'expired', txHash: EXPIRE_TX });
    const { deps } = makeDeps([claim], bondRef, keeper);

    const processed = await processStaleClaims(deps);

    expect(keeper.expireStaleClaim).toHaveBeenCalledTimes(1);
    expect(keeper.expireStaleClaim.mock.calls[0][0]).toMatchObject({ claim_id: 'claim_1' });
    expect(processed).toBe(1);
    expect(claim.ref.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired', fee_outcome: 'burned', resolution_tx_hash: EXPIRE_TX }),
    );
    expect(bondRef.update).toHaveBeenCalledWith(expect.objectContaining({ pending_claims: 1 }));
    const peArg = mockGeneratePE.mock.calls[0][1];
    expect(peArg.actionType).toBe('bond_claim_expired_processed');
    expect(peArg.metadata.claim_id).toBe('claim_1');
    expect(peArg.metadata.expire_tx_hash).toBe(EXPIRE_TX);
    // The keeper drove it this tick — no log recovery needed.
    expect(mockRecoverClaimExpired).not.toHaveBeenCalled();
  });

  it('mirrors an already-expired claim (raced) by RECOVERING the ClaimExpired receipt', async () => {
    const claim = makeClaimSnap();
    const bondRef = makeRef('bond_1', { bond_id: 'bond_1', pending_claims: 1 });
    const keeper = makeClaimKeeper({ status: 'already_expired', reason: 'onchain_claim_dismissed' });
    const { deps } = makeDeps([claim], bondRef, keeper);
    mockRecoverClaimExpired.mockResolvedValue({ ok: true, txHash: RECOVERED_TX, confirmations: 12 });

    const processed = await processStaleClaims(deps);

    expect(processed).toBe(1);
    expect(claim.ref.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired', resolution_tx_hash: RECOVERED_TX }),
    );
    expect(bondRef.update).toHaveBeenCalledWith(expect.objectContaining({ pending_claims: 0 }));
    const peArg = mockGeneratePE.mock.calls[0][1];
    expect(peArg.metadata.onchain_expiry_confirmed).toBe(true);
    // bond lifecycle: no hashless economic record — the recovered receipt anchors it.
    expect(peArg.metadata.expire_tx_hash).toBe(RECOVERED_TX);
  });

  it('bond lifecycle fail-closed: already expired on-chain but NO ClaimExpired receipt recoverable (e.g. Court dismissal) → assert nothing', async () => {
    const claim = makeClaimSnap();
    const bondRef = makeRef('bond_1', { bond_id: 'bond_1', pending_claims: 1 });
    const keeper = makeClaimKeeper({ status: 'already_expired', reason: 'onchain_claim_dismissed' });
    const { deps } = makeDeps([claim], bondRef, keeper);
    mockRecoverClaimExpired.mockResolvedValue({ ok: false, reason: 'claimexpired_log_not_found' });

    const processed = await processStaleClaims(deps);

    expect(processed).toBe(0);
    expect(claim.ref.update).not.toHaveBeenCalled();
    expect(bondRef.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('TRUTHFUL: does NOT relabel an on-chain Upheld (slashed) claim as expired', async () => {
    const claim = makeClaimSnap();
    const bondRef = makeRef('bond_1', { bond_id: 'bond_1', pending_claims: 1 });
    const keeper = makeClaimKeeper({ status: 'already_slashed', reason: 'onchain_claim_upheld' });
    const { deps } = makeDeps([claim], bondRef, keeper);

    const processed = await processStaleClaims(deps);

    expect(processed).toBe(0);
    expect(claim.ref.update).not.toHaveBeenCalled();
    expect(bondRef.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('ADVERSARIAL: does NOT expire when the keeper reports not_yet_expired (clock skew)', async () => {
    const claim = makeClaimSnap();
    const bondRef = makeRef('bond_1', { bond_id: 'bond_1', pending_claims: 1 });
    const keeper = makeClaimKeeper({ status: 'not_yet_expired', reason: 'revert_still_filed' });
    const { deps } = makeDeps([claim], bondRef, keeper);

    const processed = await processStaleClaims(deps);

    expect(keeper.expireStaleClaim).toHaveBeenCalledTimes(1);
    expect(processed).toBe(0);
    expect(claim.ref.update).not.toHaveBeenCalled();
    expect(bondRef.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('fails closed: no keeper configured → no on-chain call, no state change', async () => {
    const claim = makeClaimSnap();
    const bondRef = makeRef('bond_1', { bond_id: 'bond_1', pending_claims: 1 });
    const keeper = makeClaimKeeper({ status: 'expired', txHash: EXPIRE_TX }, /* canSign */ false);
    const { deps } = makeDeps([claim], bondRef, keeper);

    const processed = await processStaleClaims(deps);

    expect(keeper.expireStaleClaim).not.toHaveBeenCalled();
    expect(processed).toBe(0);
    expect(claim.ref.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('idempotent: a claim already resolved by the time the txn re-reads is not double-processed', async () => {
    const claim = makeClaimSnap();
    // The transactional fresh-read sees a non-'filed' status (another path resolved it).
    claim.ref._set({ claim_id: 'claim_1', bond_id: 'bond_1', status: 'dismissed' });
    const bondRef = makeRef('bond_1', { bond_id: 'bond_1', pending_claims: 1 });
    const keeper = makeClaimKeeper({ status: 'expired', txHash: EXPIRE_TX });
    const { deps } = makeDeps([claim], bondRef, keeper);

    const processed = await processStaleClaims(deps);

    expect(processed).toBe(0);
    expect(bondRef.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('skips a legacy claim with no on-chain binding (keeper not_found)', async () => {
    const claim = makeClaimSnap({ onchain_claim_id: undefined });
    const bondRef = makeRef('bond_1', { bond_id: 'bond_1', pending_claims: 1 });
    const keeper = makeClaimKeeper({ status: 'not_found', reason: 'claim has no onchain_claim_id' });
    const { deps } = makeDeps([claim], bondRef, keeper);

    const processed = await processStaleClaims(deps);

    expect(processed).toBe(0);
    expect(claim.ref.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// agent directory — processFiledClaimCourtSettlements: mirror on-chain Court settlements
// ---------------------------------------------------------------------------

describe('processFiledClaimCourtSettlements — agent directory Court-settlement mirror', () => {
  const SETTLE_TX = '0x' + '8'.repeat(64);
  const ONCHAIN_CLAIM_ID = '0x' + 'c'.repeat(64);
  const RESPONDENT_ADDR = '0x' + 'b'.repeat(40);

  function seedGraph(fs: FakeFirestore, claimOverrides: Record<string, unknown> = {}): void {
    fs.store.set('agent_wallets/wallet_claimant', {
      id: 'wallet_claimant', agent_id: 'agent-claimant', address: '0x' + 'a'.repeat(40),
      status: 'active', governance_score: 50, pe_count: 10, economic_activity_usd: 0, badges: [],
    });
    fs.store.set('agent_wallets/wallet_respondent', {
      id: 'wallet_respondent', agent_id: 'agent-respondent', address: RESPONDENT_ADDR,
      status: 'active', governance_score: 50, pe_count: 10, economic_activity_usd: 0, badges: [],
    });
    fs.store.set('bonds/bond_m1', {
      bond_id: 'bond_m1', agent_wallet_id: 'wallet_respondent', agent_address: RESPONDENT_ADDR,
      autonomy_level: 2, amount_pvt: '750', status: 'active', chain: 'base',
      pending_claims: 1, pe_ids: [], created_at: Date.now(), updated_at: Date.now(),
      renewal_deadline: Date.now() + 30 * DAY_MS, last_renewal_at: Date.now(),
    });
    fs.store.set('bond_claims/claim_m1', {
      claim_id: 'claim_m1', bond_id: 'bond_m1',
      claimant_wallet_id: 'wallet_claimant', claimant_address: '0x' + 'a'.repeat(40),
      respondent_wallet_id: 'wallet_respondent', respondent_address: RESPONDENT_ADDR,
      description: 'agent failed the obligation', evidence_pe_ids: ['pe_ev'],
      filing_fee_pvt: '15', status: 'filed', chain: 'base',
      filing_tx_hash: '0x' + '1'.repeat(64), filing_block_number: 100,
      onchain_claim_id: ONCHAIN_CLAIM_ID, pe_ids: ['pe_filing'],
      created_at: Date.now(), updated_at: Date.now(),
      ...claimOverrides,
    });
  }

  function fakeDeps(fs: FakeFirestore): AgentBankDeps {
    return {
      db: fs as unknown as AgentBankDeps['db'],
      peBuffer: { enqueue: jest.fn() },
      recordPEAccrual: jest.fn(),
    } as unknown as AgentBankDeps;
  }

  it('mirrors an on-chain SLASH: claim flips upheld off the recovered receipt, pending_claims decrements, PE emitted', async () => {
    const fs = createFakeFirestore();
    seedGraph(fs);
    mockRecoverResolution.mockResolvedValue({ ok: true, verdict: 'upheld', txHash: SETTLE_TX, blockNumber: 200, confirmations: 15 });
    mockClaimResolved.mockResolvedValue({
      ok: true, verdict: 'upheld', onchainClaimId: ONCHAIN_CLAIM_ID,
      slashClaimantAmountWei: '600000000000000000000', slashBurnedAmountWei: '150000000000000000000',
      blockNumber: 200, confirmations: 15,
    });

    const mirrored = await processFiledClaimCourtSettlements(fakeDeps(fs));
    expect(mirrored).toBe(1);

    // The recovery was bounded to THIS claim's on-chain identity + filing block.
    expect(mockRecoverResolution).toHaveBeenCalledWith(expect.objectContaining({
      onchainClaimId: ONCHAIN_CLAIM_ID,
      expectedAgent: RESPONDENT_ADDR,
      fromBlock: 100,
    }));

    const claim = fs.store.get('bond_claims/claim_m1') as Record<string, unknown>;
    expect(claim.status).toBe('upheld');
    expect(claim.onchain_settlement).toBe('confirmed');
    expect(claim.resolution_tx_hash).toBe(SETTLE_TX);
    expect(claim.slash_claimant_amount_wei).toBe('600000000000000000000');
    expect((fs.store.get('bonds/bond_m1') as { pending_claims: number }).pending_claims).toBe(0);
    const resolvedPE = mockGeneratePE.mock.calls.map((c) => c[1]).find((p) => p.actionType === 'bond_claim_resolved');
    expect(resolvedPE).toBeDefined();
    expect(resolvedPE.metadata.verdict).toBe('upheld');
  });

  it('mirrors an on-chain DISMISSAL: claim flips dismissed, fee burned', async () => {
    const fs = createFakeFirestore();
    seedGraph(fs);
    mockRecoverResolution.mockResolvedValue({ ok: true, verdict: 'dismissed', txHash: SETTLE_TX, blockNumber: 200, confirmations: 15 });
    mockClaimResolved.mockResolvedValue({
      ok: true, verdict: 'dismissed', onchainClaimId: ONCHAIN_CLAIM_ID, blockNumber: 200, confirmations: 15,
    });

    const mirrored = await processFiledClaimCourtSettlements(fakeDeps(fs));
    expect(mirrored).toBe(1);
    const claim = fs.store.get('bond_claims/claim_m1') as Record<string, unknown>;
    expect(claim.status).toBe('dismissed');
    expect(claim.fee_outcome).toBe('burned');
    expect((fs.store.get('bonds/bond_m1') as { pending_claims: number }).pending_claims).toBe(0);
  });

  it('FAIL-CLOSED: no recoverable Base-final settlement → claim stays filed, nothing asserted', async () => {
    const fs = createFakeFirestore();
    seedGraph(fs);
    mockRecoverResolution.mockResolvedValue({ ok: false, reason: 'bondslashed_log_not_found' });

    const mirrored = await processFiledClaimCourtSettlements(fakeDeps(fs));
    expect(mirrored).toBe(0);
    expect((fs.store.get('bond_claims/claim_m1') as { status: string }).status).toBe('filed');
    expect((fs.store.get('bonds/bond_m1') as { pending_claims: number }).pending_claims).toBe(1);
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: a recovered log below finality (insufficient confirmations) asserts nothing', async () => {
    const fs = createFakeFirestore();
    seedGraph(fs);
    mockRecoverResolution.mockResolvedValue({ ok: false, reason: 'insufficient_confirmations: 3/12', txHash: SETTLE_TX });

    const mirrored = await processFiledClaimCourtSettlements(fakeDeps(fs));
    expect(mirrored).toBe(0);
    expect((fs.store.get('bond_claims/claim_m1') as { status: string }).status).toBe('filed');
  });

  it('skips a legacy claim with no on-chain binding (no recovery attempted)', async () => {
    const fs = createFakeFirestore();
    seedGraph(fs, { onchain_claim_id: undefined });

    const mirrored = await processFiledClaimCourtSettlements(fakeDeps(fs));
    expect(mirrored).toBe(0);
    expect(mockRecoverResolution).not.toHaveBeenCalled();
    expect((fs.store.get('bond_claims/claim_m1') as { status: string }).status).toBe('filed');
  });
});
