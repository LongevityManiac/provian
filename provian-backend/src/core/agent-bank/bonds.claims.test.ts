/**
 * Bond claim binding, dedup, and resolution — Capability-Truthfulness Pass-2
 * regression tests (#1 write-only/griefable resolution leg, #10 replay-stacking).
 *
 * Uses the in-memory fake Firestore (real transaction + query semantics) so the
 * dedup markers, pending_claims decrement, and withdrawal-unblock are exercised
 * for real rather than against a hand-rolled stub.
 */

import { fileClaim, resolveBondClaim, withdrawBond } from './bonds';
import { fileGeneralDispute, castGeneralDisputeVote } from './court';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { AgentBankDeps, FileClaimRequest } from './types';

// pe-utils is shared by bonds.ts AND court.ts — one mock covers both.
jest.mock('./pe-utils', () => ({
  generatePE: jest.fn(),
}));

jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmClaimFiled: jest.fn(),
  verifyEvmBondClaimResolved: jest.fn(),
  verifyEvmBondWithdrawn: jest.fn(),
  verifyEvmContractCall: jest.fn().mockResolvedValue({ ok: true, blockNumber: 1, confirmations: 5 }),
  verifyEvmBondPosted: jest.fn(),
  verifyEvmBondRenewed: jest.fn(),
  // agent directory: the Court-settlement log-recovery reader (the general-dispute leg and
  // the scheduler mirror observe settlements through it).
  recoverEvmBondClaimResolution: jest.fn(),
}));

import { generatePE } from './pe-utils';
import {
  verifyEvmClaimFiled,
  verifyEvmBondClaimResolved,
  verifyEvmBondWithdrawn,
  recoverEvmBondClaimResolution,
} from '../onchain/tx-verifier';

// bond lifecycle: minimal acting-wallet doc for the machine's kill-switch-first gate
// (only `.status` is read at the module boundary; a non-'active' status blocks).
import type { AgentWalletDocument } from '../agent-wallet/types';
const ACTING_WALLET = { status: 'active' } as unknown as AgentWalletDocument;


const mockGeneratePE = generatePE as jest.Mock;
const mockClaimFiled = verifyEvmClaimFiled as jest.Mock;
const mockClaimResolved = verifyEvmBondClaimResolved as jest.Mock;
const mockBondWithdrawn = verifyEvmBondWithdrawn as jest.Mock;
const mockRecoverResolution = recoverEvmBondClaimResolution as jest.Mock;

const POOL_ADDRESS = '0x' + '1'.repeat(40);
const SETTLEMENT_TX = '0x' + '8'.repeat(64);
const ONCHAIN_CLAIM_ID = '0x' + 'c'.repeat(64);
const FILING_TX = '0x' + 'a'.repeat(64);

const CLAIMANT = 'wallet_claimant';
const RESPONDENT = 'wallet_respondent';
const CLAIMANT_ADDR = '0x' + 'b'.repeat(40);
const RESPONDENT_ADDR = '0x' + 'd'.repeat(40);
const BOND_ID = 'bond_test_1';

function makeDeps(fs: FakeFirestore): AgentBankDeps {
  return {
    db: fs as unknown as AgentBankDeps['db'],
    cache: {} as AgentBankDeps['cache'],
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(),
  } as unknown as AgentBankDeps;
}

function seedWallet(fs: FakeFirestore, id: string, address: string, agentId: string, extra: Record<string, unknown> = {}): void {
  fs.store.set(`agent_wallets/${id}`, {
    id,
    address,
    agent_id: agentId,
    // agent directory: the kill-switch-first gates read the acting wallet's status.
    status: 'active',
    governance_score: 50,
    pe_count: 100,
    economic_activity_usd: 1000,
    badges: [],
    ...extra,
  });
}

function seedActiveBond(fs: FakeFirestore, pendingClaims: number): void {
  fs.store.set(`bonds/${BOND_ID}`, {
    bond_id: BOND_ID,
    agent_wallet_id: RESPONDENT,
    agent_address: RESPONDENT_ADDR,
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
    pending_claims: pendingClaims,
    pe_ids: [],
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

function seedFiledClaim(fs: FakeFirestore, claimId: string): void {
  fs.store.set(`bond_claims/${claimId}`, {
    claim_id: claimId,
    bond_id: BOND_ID,
    claimant_wallet_id: CLAIMANT,
    claimant_address: CLAIMANT_ADDR,
    respondent_wallet_id: RESPONDENT,
    respondent_address: RESPONDENT_ADDR,
    description: 'agent failed to deliver the contracted work',
    evidence_pe_ids: ['pe_ev1'],
    filing_fee_pvt: '15',
    status: 'filed',
    chain: 'base',
    filing_tx_hash: FILING_TX,
    filing_block_number: 100,
    onchain_claim_id: ONCHAIN_CLAIM_ID,
    pe_ids: ['pe_filing'],
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

const baseClaimBody: FileClaimRequest = {
  respondent_wallet_id: RESPONDENT,
  description: 'agent failed to deliver the contracted work product',
  evidence_pe_ids: ['pe_ev1'],
  tx_hash: FILING_TX,
  chain: 'base',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BOND_POOL_CONTRACT_ADDRESS_BASE = POOL_ADDRESS;
  mockGeneratePE.mockResolvedValue({ peId: 'pe_mock', peHash: 'h', prevHash: 'p' });
  mockClaimFiled.mockResolvedValue({
    ok: true,
    onchainClaimId: ONCHAIN_CLAIM_ID,
    blockNumber: 100,
    confirmations: 5,
  });
  mockBondWithdrawn.mockResolvedValue({ ok: true, blockNumber: 101, confirmations: 5 });
  mockClaimResolved.mockResolvedValue({
    ok: true,
    verdict: 'upheld',
    onchainClaimId: ONCHAIN_CLAIM_ID,
    slashClaimantAmountWei: '600000000000000000000',
    slashBurnedAmountWei: '150000000000000000000',
    blockNumber: 200,
    confirmations: 5,
  });
  // agent directory default: NO recoverable on-chain settlement (the fail-closed steady
  // state). Tests that exercise the observed-settlement path override this.
  mockRecoverResolution.mockResolvedValue({ ok: false, reason: 'bondslashed_log_not_found' });
});

/** agent directory: an upheld settlement receipt as the verifier reports it. */
function mockUpheldSettlement(claimantWei = '600000000000000000000', burnedWei = '150000000000000000000'): void {
  mockClaimResolved.mockResolvedValue({
    ok: true,
    verdict: 'upheld',
    onchainClaimId: ONCHAIN_CLAIM_ID,
    slashClaimantAmountWei: claimantWei,
    slashBurnedAmountWei: burnedWei,
    blockNumber: 200,
    confirmations: 5,
  });
}

/** agent directory: a dismissed settlement receipt as the verifier reports it. */
function mockDismissedSettlement(): void {
  mockClaimResolved.mockResolvedValue({
    ok: true,
    verdict: 'dismissed',
    onchainClaimId: ONCHAIN_CLAIM_ID,
    blockNumber: 200,
    confirmations: 5,
  });
}

const SETTLEMENT = { txHash: SETTLEMENT_TX, chain: 'base' };

// ---------------------------------------------------------------------------
// #10 — bind + dedup fileClaim
// ---------------------------------------------------------------------------

describe('fileClaim — on-chain binding + dedup (#10)', () => {
  it('rejects a replay of the same on-chain ClaimFiled tx (does not stack pending_claims)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 0);

    // First filing succeeds and bumps pending_claims to 1.
    await fileClaim(deps, CLAIMANT, ACTING_WALLET, baseClaimBody);
    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(1);

    // Replaying the SAME tx (verifier recovers the same on-chain claimId) is rejected.
    await expect(fileClaim(deps, CLAIMANT, ACTING_WALLET, baseClaimBody)).rejects.toThrow(/already filed/i);

    // pending_claims must NOT have stacked.
    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(1);
  });

  it('allows a distinct on-chain claim (different claimId + tx) to stack legitimately', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 0);

    await fileClaim(deps, CLAIMANT, ACTING_WALLET, baseClaimBody);

    // A genuinely new on-chain filing: new claimId + new tx hash.
    const otherClaimId = '0x' + 'f'.repeat(64);
    const otherTx = '0x' + '9'.repeat(64);
    mockClaimFiled.mockResolvedValueOnce({ ok: true, onchainClaimId: otherClaimId, blockNumber: 101, confirmations: 5 });
    await fileClaim(deps, CLAIMANT, ACTING_WALLET, { ...baseClaimBody, tx_hash: otherTx });

    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(2);
  });

  it('rejects when the on-chain ClaimFiled agent is not the posted respondent (fail closed)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 0);

    // Verifier reports the on-chain agent did not match the respondent's bond.
    mockClaimFiled.mockResolvedValue({ ok: false, reason: 'claim_agent_mismatch' });

    await expect(fileClaim(deps, CLAIMANT, ACTING_WALLET, baseClaimBody)).rejects.toThrow(/claim_agent_mismatch/);

    // No claim doc created, pending_claims untouched.
    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(0);
    const claimDocs = [...fs.store.keys()].filter((k) => k.startsWith('bond_claims/'));
    expect(claimDocs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #1 — resolveBondClaim resolution leg
// ---------------------------------------------------------------------------

describe('resolveBondClaim — resolution + pending_claims (#1)', () => {
  it('decrements pending_claims and unblocks the respondent withdrawal', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_resolve_1');

    // Before resolution, withdrawal is blocked.
    await expect(
      withdrawBond(deps, RESPONDENT, ACTING_WALLET, { bond_id: BOND_ID, tx_hash: '0x' + '7'.repeat(64) }),
    ).rejects.toThrow(/pending claims/i);

    await resolveBondClaim(deps, { claimId: 'claim_resolve_1', settlement: SETTLEMENT });

    const bond = fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number };
    expect(bond.pending_claims).toBe(0);
    const claim = fs.store.get('bond_claims/claim_resolve_1') as { status: string };
    expect(claim.status).toBe('upheld');

    // Now withdrawal succeeds.
    const result = await withdrawBond(deps, RESPONDENT, ACTING_WALLET, { bond_id: BOND_ID, tx_hash: '0x' + '7'.repeat(64) });
    expect(result.status).toBe('withdrawn');
    expect((fs.store.get(`bonds/${BOND_ID}`) as { status: string }).status).toBe('withdrawn');
  });

  it('is idempotent: a second resolve does not double-decrement pending_claims', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_idem');

    mockDismissedSettlement();
    await resolveBondClaim(deps, { claimId: 'claim_idem', settlement: SETTLEMENT });
    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(0);

    // agent directory: replaying the SAME recorded settlement is an idempotent no-op — the
    // resolved claim comes back unchanged, no second PE, no double-decrement.
    const peCountAfterFirst = mockGeneratePE.mock.calls.length;
    const replay = await resolveBondClaim(deps, { claimId: 'claim_idem', settlement: SETTLEMENT });
    expect(replay.status).toBe('dismissed');
    expect(mockGeneratePE.mock.calls.length).toBe(peCountAfterFirst);
    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(0);

    // A DIFFERENT settlement tx against the resolved claim is an error.
    await expect(
      resolveBondClaim(deps, { claimId: 'claim_idem', settlement: { txHash: '0x' + '6'.repeat(64), chain: 'base' } }),
    ).rejects.toThrow(/not in filed state/i);
    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(0);
  });

  it('upheld returns the filing fee to the claimant and routes a slash', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_upheld');

    await resolveBondClaim(deps, { claimId: 'claim_upheld', settlement: SETTLEMENT });

    const claim = fs.store.get('bond_claims/claim_upheld') as { fee_outcome: string; onchain_settlement: string };
    expect(claim.fee_outcome).toBe('returned_to_claimant');
    // agent directory: a claim can only resolve on a VERIFIED settlement — always confirmed.
    expect(claim.onchain_settlement).toBe('confirmed');

    const resolvedPE = mockGeneratePE.mock.calls
      .map((c) => c[1])
      .find((p) => p.actionType === 'bond_claim_resolved');
    expect(resolvedPE).toBeDefined();
    expect(resolvedPE.metadata.verdict).toBe('upheld');
    expect(resolvedPE.metadata.fee_outcome).toBe('returned_to_claimant');
    expect(resolvedPE.metadata.slash_outcome).toBe('bond_slashed');
    expect(resolvedPE.counterpartyAddress).toBe(RESPONDENT_ADDR);
  });

  it('dismissed burns the filing fee and routes no slash', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_dismissed');

    mockDismissedSettlement();
    await resolveBondClaim(deps, { claimId: 'claim_dismissed', settlement: SETTLEMENT });

    const claim = fs.store.get('bond_claims/claim_dismissed') as { fee_outcome: string; status: string };
    expect(claim.status).toBe('dismissed');
    expect(claim.fee_outcome).toBe('burned');

    const resolvedPE = mockGeneratePE.mock.calls
      .map((c) => c[1])
      .find((p) => p.actionType === 'bond_claim_resolved');
    expect(resolvedPE.metadata.fee_outcome).toBe('burned');
    expect(resolvedPE.metadata.slash_outcome).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// #1 — Court verdict drives resolution (no admin free-pick)
// ---------------------------------------------------------------------------

describe('Court general-dispute verdict drives bond claim resolution (#1)', () => {
  const ARBS = ['wallet_arb1', 'wallet_arb2', 'wallet_arb3'];

  function seedArbitrators(fs: FakeFirestore): void {
    ARBS.forEach((id, i) => {
      seedWallet(fs, id, '0x' + String(i + 2).repeat(40), `agent-${id}`);
      fs.store.set(`arbitrators/${id}`, {
        wallet_id: id,
        address: '0x' + String(i + 2).repeat(40),
        is_active: true,
        total_cases: 1,
        majority_votes: 0,
        minority_votes: 0,
      });
    });
  }

  it('rejects fileGeneralDispute linking a bond claim with a mismatched respondent', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedWallet(fs, 'wallet_other', '0x' + '5'.repeat(40), 'agent-other');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_link');
    // Subject PE the claimant has standing on (checked before the link guard).
    // PE METER: standing reads the subject's 31-day act key (its actor), never a stored PE.
    fs.store.set('meter_act_keys_v1/pe_ev1', { actor_id: 'agent-claimant', action_type: 'escrow_completed', timestamp: 1 });

    await expect(
      fileGeneralDispute(deps, {
        filedBy: CLAIMANT,
        respondent: 'wallet_other', // not the claim's respondent
        subjectPeIds: ['pe_ev1'],
        description: 'escalating my bond claim',
        requestedRemedy: 'slash the bond',
        bondClaimId: 'claim_link',
      }),
    ).rejects.toThrow(/respondent must match/i);
  });

  it('a 2-of-3 upheld verdict resolves the linked bond claim and decrements pending_claims', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedArbitrators(fs);
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_court');

    // Dispute already has one upheld vote; the second vote reaches majority.
    const now = Date.now();
    fs.store.set('general_disputes/gd_court', {
      dispute_id: 'gd_court',
      filed_by: CLAIMANT,
      respondent: RESPONDENT,
      subject_pe_ids: ['pe_ev1'],
      description: 'agent failed to deliver',
      requested_remedy: 'slash the bond',
      evidence_pe_ids: [],
      status: 'voting',
      panel_wallet_ids: ARBS,
      votes: { [ARBS[0]]: 'upheld' },
      bond_claim_id: 'claim_court',
      pe_ids: [],
      created_at: now,
      updated_at: now,
      filed_at: now,
      voting_deadline: now + 48 * 60 * 60 * 1000,
    });

    // agent directory: the on-chain Court settlement is RECOVERABLE (BondSlashed at Base
    // finality) — the verdict flip rides that receipt, not the Firestore tally.
    mockRecoverResolution.mockResolvedValue({ ok: true, verdict: 'upheld', txHash: SETTLEMENT_TX, blockNumber: 200, confirmations: 15 });

    const dispute = await castGeneralDisputeVote(deps, 'gd_court', ARBS[1], ACTING_WALLET, 'upheld');
    expect(dispute.status).toBe('resolved');
    expect(dispute.resolution).toBe('upheld');

    const claim = fs.store.get('bond_claims/claim_court') as {
      status: string;
      fee_outcome: string;
      slash_basis: string;
      resolved_by_dispute_id: string;
      onchain_settlement: string;
      resolution_tx_hash: string;
      court_finding: { verdict: string; slash_basis: string; dispute_id: string };
    };
    expect(claim.status).toBe('upheld');
    expect(claim.fee_outcome).toBe('returned_to_claimant');
    expect(claim.slash_basis).toBe('full');
    expect(claim.resolved_by_dispute_id).toBe('gd_court');
    // The panel FINDING is preserved for reconciliation…
    expect(claim.court_finding).toEqual(expect.objectContaining({ verdict: 'upheld', slash_basis: 'full', dispute_id: 'gd_court' }));
    // …and the flip is receipt-backed, always confirmed.
    expect(claim.onchain_settlement).toBe('confirmed');
    expect(claim.resolution_tx_hash).toBe(SETTLEMENT_TX.toLowerCase());

    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(0);
  });

  it('agent directory fail-closed: with NO recoverable on-chain settlement, the verdict records a FINDING and the claim stays filed', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedArbitrators(fs);
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_nosettle');

    const now = Date.now();
    fs.store.set('general_disputes/gd_nosettle', {
      dispute_id: 'gd_nosettle',
      filed_by: CLAIMANT,
      respondent: RESPONDENT,
      subject_pe_ids: ['pe_ev1'],
      description: 'agent failed to deliver',
      requested_remedy: 'slash the bond',
      evidence_pe_ids: [],
      status: 'voting',
      panel_wallet_ids: ARBS,
      votes: { [ARBS[0]]: 'upheld' },
      bond_claim_id: 'claim_nosettle',
      pe_ids: [],
      created_at: now,
      updated_at: now,
      filed_at: now,
      voting_deadline: now + 48 * 60 * 60 * 1000,
    });

    // Default mockRecoverResolution: bondslashed_log_not_found (no settlement).
    const dispute = await castGeneralDisputeVote(deps, 'gd_nosettle', ARBS[1], ACTING_WALLET, 'upheld');
    expect(dispute.status).toBe('resolved'); // the DISPUTE record resolves (record-only)

    const claim = fs.store.get('bond_claims/claim_nosettle') as {
      status: string;
      court_finding: { verdict: string; slash_basis: string; dispute_id: string };
      onchain_settlement?: string;
    };
    // The claim does NOT flip — no Base-final receipt, no economic transition —
    // but the panel's finding is preserved on the record.
    expect(claim.status).toBe('filed');
    expect(claim.onchain_settlement).toBeUndefined();
    expect(claim.court_finding).toEqual(expect.objectContaining({ verdict: 'upheld', slash_basis: 'full', dispute_id: 'gd_nosettle' }));
    // pending_claims untouched: the bond stays frozen until the chain settles.
    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(1);
    // No bond_claim_resolved PE was emitted.
    const resolvedPE = mockGeneratePE.mock.calls.map((c) => c[1]).find((p) => p.actionType === 'bond_claim_resolved');
    expect(resolvedPE).toBeUndefined();
  });

  it('a 2-of-3 PARTIAL verdict records slash_basis=partial (distinguishable from full upheld)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedArbitrators(fs);
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_partial');

    const now = Date.now();
    fs.store.set('general_disputes/gd_partial', {
      dispute_id: 'gd_partial',
      filed_by: CLAIMANT,
      respondent: RESPONDENT,
      subject_pe_ids: ['pe_ev1'],
      description: 'agent partially at fault',
      requested_remedy: 'partial slash',
      evidence_pe_ids: [],
      status: 'voting',
      panel_wallet_ids: ARBS,
      votes: { [ARBS[0]]: 'partial' },
      bond_claim_id: 'claim_partial',
      pe_ids: [],
      created_at: now,
      updated_at: now,
      filed_at: now,
      voting_deadline: now + 48 * 60 * 60 * 1000,
    });

    // The on-chain settlement: a SlashPartial majority landed (the event is
    // still BondSlashed / verdict 'upheld'; the amounts are the 50% floor).
    mockRecoverResolution.mockResolvedValue({ ok: true, verdict: 'upheld', txHash: SETTLEMENT_TX, blockNumber: 200, confirmations: 15 });
    mockUpheldSettlement('300000000000000000000', '75000000000000000000'); // 375 PVT

    const dispute = await castGeneralDisputeVote(deps, 'gd_partial', ARBS[1], ACTING_WALLET, 'partial');
    expect(dispute.status).toBe('resolved');
    expect(dispute.resolution).toBe('partial');

    const claim = fs.store.get('bond_claims/claim_partial') as {
      status: string;
      fee_outcome: string;
      slash_basis: string;
    };
    // Fee routing collapses partial→upheld (claim has merit), but the slash
    // MAGNITUDE category survives losslessly as a structured field.
    expect(claim.status).toBe('upheld');
    expect(claim.fee_outcome).toBe('returned_to_claimant');
    expect(claim.slash_basis).toBe('partial');

    // The bond_claim_resolved PE carries the same distinguishing input.
    const resolvedPE = mockGeneratePE.mock.calls
      .map((c) => c[1])
      .find((p) => p.actionType === 'bond_claim_resolved');
    expect(resolvedPE.metadata.slash_basis).toBe('partial');
    expect(resolvedPE.metadata.verdict).toBe('upheld');
  });
});

// ---------------------------------------------------------------------------
// Part 3 (WS1-hardening) — partial vs full slash basis preserved for settlement
// ---------------------------------------------------------------------------

describe('resolveBondClaim — slash basis preserved (WS1-hardening)', () => {
  it('a full upheld and a partial upheld produce DISTINGUISHABLE settlement inputs', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 2);
    seedFiledClaim(fs, 'claim_full');
    seedFiledClaim(fs, 'claim_part');

    const full = await resolveBondClaim(deps, { claimId: 'claim_full', settlement: SETTLEMENT, slashBasis: 'full' });
    mockUpheldSettlement('300000000000000000000', '75000000000000000000'); // 375 PVT — the on-chain 50% floor
    const partial = await resolveBondClaim(deps, {
      claimId: 'claim_part',
      settlement: { txHash: '0x' + '5'.repeat(64), chain: 'base' },
      slashBasis: 'partial',
    });

    // Both upheld + fee returned, but slash basis differs — recoverable from the
    // persisted claim record alone (no cross-collection dispute read needed).
    expect(full.status).toBe('upheld');
    expect(partial.status).toBe('upheld');
    expect(full.fee_outcome).toBe('returned_to_claimant');
    expect(partial.fee_outcome).toBe('returned_to_claimant');
    expect(full.slash_basis).toBe('full');
    expect(partial.slash_basis).toBe('partial');
    expect(full.slash_basis).not.toBe(partial.slash_basis);

    expect((fs.store.get('bond_claims/claim_full') as { slash_basis: string }).slash_basis).toBe('full');
    expect((fs.store.get('bond_claims/claim_part') as { slash_basis: string }).slash_basis).toBe('partial');

    // ...and from the bond_claim_resolved PE payloads.
    const peBases = mockGeneratePE.mock.calls
      .map((c) => c[1])
      .filter((p) => p.actionType === 'bond_claim_resolved')
      .map((p) => p.metadata.slash_basis);
    expect(peBases).toEqual(expect.arrayContaining(['full', 'partial']));
  });

  it('upheld defaults to slash_basis=full when none supplied (direct resolution)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_default');

    const resolved = await resolveBondClaim(deps, { claimId: 'claim_default', settlement: SETTLEMENT });
    expect(resolved.slash_basis).toBe('full');
  });

  it('dismissed records no slash basis (no slash to settle)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_dismiss');

    mockDismissedSettlement();
    const resolved = await resolveBondClaim(deps, { claimId: 'claim_dismiss', settlement: SETTLEMENT });
    expect(resolved.slash_basis).toBeUndefined();
    expect((fs.store.get('bond_claims/claim_dismiss') as { slash_basis?: string }).slash_basis).toBeUndefined();

    const resolvedPE = mockGeneratePE.mock.calls
      .map((c) => c[1])
      .find((p) => p.actionType === 'bond_claim_resolved');
    expect(resolvedPE.metadata.slash_basis).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WS1 (Pass-2 remediation) — concrete slash amount + real on-chain settlement
// ---------------------------------------------------------------------------

describe('resolveBondClaim — concrete slash amount (WS1 redeploy)', () => {
  it('full upheld persists slash_amount_pvt = the whole bond (cap) on claim + PE', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1); // amount_pvt = '750'
    seedFiledClaim(fs, 'claim_amt_full');

    const resolved = await resolveBondClaim(deps, { claimId: 'claim_amt_full', settlement: SETTLEMENT, slashBasis: 'full' });

    expect(resolved.slash_amount_pvt).toBe('750');
    expect((fs.store.get('bond_claims/claim_amt_full') as { slash_amount_pvt: string }).slash_amount_pvt).toBe('750');

    const pe = mockGeneratePE.mock.calls.map((c) => c[1]).find((p) => p.actionType === 'bond_claim_resolved');
    expect(pe.metadata.slash_amount_pvt).toBe('750');
  });

  it('partial upheld persists slash_amount_pvt = 50% floor; distinguishable from full', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 2); // amount_pvt = '750'
    seedFiledClaim(fs, 'claim_amt_full2');
    seedFiledClaim(fs, 'claim_amt_part');

    const full = await resolveBondClaim(deps, { claimId: 'claim_amt_full2', settlement: SETTLEMENT, slashBasis: 'full' });
    mockUpheldSettlement('300000000000000000000', '75000000000000000000'); // 375 PVT on-chain
    const partial = await resolveBondClaim(deps, {
      claimId: 'claim_amt_part',
      settlement: { txHash: '0x' + '5'.repeat(64), chain: 'base' },
      slashBasis: 'partial',
    });

    // full = cap (750), partial = floor (50% of 750 = 375): distinguishable from
    // the persisted claim alone (no cross-collection read).
    expect(full.slash_amount_pvt).toBe('750');
    expect(partial.slash_amount_pvt).toBe('375');
    expect(full.slash_amount_pvt).not.toBe(partial.slash_amount_pvt);

    expect((fs.store.get('bond_claims/claim_amt_part') as { slash_amount_pvt: string }).slash_amount_pvt).toBe('375');
    expect((fs.store.get('bond_claims/claim_amt_full2') as { slash_amount_pvt: string }).slash_amount_pvt).toBe('750');
  });

  it('default (no basis) upheld persists the full bond amount', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_amt_default');

    const resolved = await resolveBondClaim(deps, { claimId: 'claim_amt_default', settlement: SETTLEMENT });
    expect(resolved.slash_amount_pvt).toBe('750');
  });

  it('dismissed records no slash amount (nothing to slash)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_amt_dismiss');

    mockDismissedSettlement();
    const resolved = await resolveBondClaim(deps, { claimId: 'claim_amt_dismiss', settlement: SETTLEMENT });
    expect(resolved.slash_amount_pvt).toBeUndefined();
    expect((fs.store.get('bond_claims/claim_amt_dismiss') as { slash_amount_pvt?: string }).slash_amount_pvt).toBeUndefined();

    const pe = mockGeneratePE.mock.calls.map((c) => c[1]).find((p) => p.actionType === 'bond_claim_resolved');
    expect(pe.metadata.slash_amount_pvt).toBeNull();
  });
});

describe('resolveBondClaim — verified on-chain settlement (WS1 redeploy)', () => {
  it('records onchain_settlement=confirmed + resolution_tx_hash when the settlement tx is verified', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_settle');

    const resolved = await resolveBondClaim(deps, {
      claimId: 'claim_settle',
      slashBasis: 'full',
      settlement: { txHash: SETTLEMENT_TX, chain: 'base' },
    });

    // The verifier was called with the claim's bound on-chain claimId +
    // respondent. agent directory: no expectedVerdict is asserted by default — the on-chain
    // EVENT decides the verdict, never a caller/Firestore tally.
    expect(mockClaimResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedClaimId: ONCHAIN_CLAIM_ID,
        expectedAgent: RESPONDENT_ADDR,
        txHash: SETTLEMENT_TX,
      }),
    );
    expect(mockClaimResolved.mock.calls[0][0].expectedVerdict).toBeUndefined();
    expect(resolved.status).toBe('upheld');

    expect(resolved.onchain_settlement).toBe('confirmed');
    expect(resolved.resolution_tx_hash).toBe(SETTLEMENT_TX.toLowerCase());

    const claim = fs.store.get('bond_claims/claim_settle') as { onchain_settlement: string; resolution_tx_hash: string };
    expect(claim.onchain_settlement).toBe('confirmed');
    expect(claim.resolution_tx_hash).toBe(SETTLEMENT_TX.toLowerCase());

    const pe = mockGeneratePE.mock.calls.map((c) => c[1]).find((p) => p.actionType === 'bond_claim_resolved');
    expect(pe.metadata.onchain_settlement).toBe('confirmed');
    expect(pe.metadata.resolution_tx_hash).toBe(SETTLEMENT_TX.toLowerCase());
  });

  it('agent directory: a settlement receipt is REQUIRED — a claim cannot leave filed without one', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_pending');

    await expect(
      // @ts-expect-error — the agent directory signature requires settlement; this probes the runtime guard too.
      resolveBondClaim(deps, { claimId: 'claim_pending' }),
    ).rejects.toThrow(/settlement.*required/i);
    expect((fs.store.get('bond_claims/claim_pending') as { status: string }).status).toBe('filed');
    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(1);
    expect(mockClaimResolved).not.toHaveBeenCalled();
  });

  it('agent directory: a caller expectation contradicting the on-chain event fails closed', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_contra');

    // The verifier enforces the expectation against the event and reports a miss.
    mockClaimResolved.mockResolvedValue({ ok: false, reason: 'claim_dismissed_event_not_found' });
    await expect(
      resolveBondClaim(deps, { claimId: 'claim_contra', settlement: SETTLEMENT, expectedVerdict: 'dismissed' }),
    ).rejects.toThrow(/settlement verification failed/i);
    expect(mockClaimResolved).toHaveBeenCalledWith(expect.objectContaining({ expectedVerdict: 'dismissed' }));
    expect((fs.store.get('bond_claims/claim_contra') as { status: string }).status).toBe('filed');
    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(1);
  });

  it('fails closed when the on-chain settlement does not verify (claim stays filed, no decrement)', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    seedFiledClaim(fs, 'claim_badsettle');

    mockClaimResolved.mockResolvedValue({ ok: false, reason: 'bond_slashed_event_not_found' });

    await expect(
      resolveBondClaim(deps, {
        claimId: 'claim_badsettle',
        settlement: { txHash: SETTLEMENT_TX, chain: 'base' },
      }),
    ).rejects.toThrow(/settlement verification failed/i);

    // The verification runs BEFORE the Firestore transaction, so nothing moved:
    // the claim is still 'filed' and the bond is still frozen.
    expect((fs.store.get('bond_claims/claim_badsettle') as { status: string }).status).toBe('filed');
    expect((fs.store.get(`bonds/${BOND_ID}`) as { pending_claims: number }).pending_claims).toBe(1);
  });

  it('rejects a settlement on a claim with no bound on-chain claimId', async () => {
    const fs = createFakeFirestore();
    const deps = makeDeps(fs);
    seedWallet(fs, CLAIMANT, CLAIMANT_ADDR, 'agent-claimant');
    seedWallet(fs, RESPONDENT, RESPONDENT_ADDR, 'agent-respondent');
    seedActiveBond(fs, 1);
    // Legacy claim without onchain_claim_id.
    fs.store.set('bond_claims/claim_legacy', {
      claim_id: 'claim_legacy',
      bond_id: BOND_ID,
      claimant_wallet_id: CLAIMANT,
      claimant_address: CLAIMANT_ADDR,
      respondent_wallet_id: RESPONDENT,
      respondent_address: RESPONDENT_ADDR,
      description: 'legacy claim missing on-chain binding',
      evidence_pe_ids: ['pe_ev1'],
      filing_fee_pvt: '15',
      status: 'filed',
      chain: 'base',
      filing_tx_hash: FILING_TX,
      filing_block_number: 100,
      pe_ids: ['pe_filing'],
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    await expect(
      resolveBondClaim(deps, {
        claimId: 'claim_legacy',
        settlement: { txHash: SETTLEMENT_TX, chain: 'base' },
      }),
    ).rejects.toThrow(/no on-chain claimId/i);
    expect(mockClaimResolved).not.toHaveBeenCalled();
  });
});
