/**
 * agent directory — the Court routes are wired through the ONE institution state machine
 * (`evaluateInstitutionTransition`). These tests probe the ACTUAL wired module
 * (the functions the route handlers call), not the machine in isolation:
 *
 * - kill-switch-first: a non-active acting wallet is blocked BEFORE any
 * validation, Firestore read/write, or RPC — proven with a db that throws
 * on ANY touch (castVote, fileGeneralDispute, castGeneralDisputeVote,
 * submitEvidence, and the bonds-side observeBondClaimSettlement);
 * - notice: filing a general dispute writes the respondent's OWN hash chain
 * (the dual-party court_general_dispute_filed PE, role 'respondent');
 * - Unknown = Block at the wired layer: panel assignment / votes refuse on
 * out-of-lifecycle dispute states, and the general-dispute voting deadline
 * is enforced at the vote write;
 * - no slash authority here: the Court module can only RECORD a finding on a
 * bond claim — the claim's status flip is the receipt-gated
 * resolveBondClaim bridge (probed in bonds.claims.test.ts).
 */

import { castVote, fileGeneralDispute, castGeneralDisputeVote, submitEvidence } from './court';
import { observeBondClaimSettlement } from './bonds';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { AgentBankDeps } from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { presentedPeFixture } from '../meter/__test-helpers__/presented-pe';

// pe-utils is shared by court.ts AND bonds.ts — one mock covers both.
jest.mock('./pe-utils', () => ({
  generatePE: jest.fn(),
  generateSchedulerPE: jest.fn(),
}));

jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmContractCall: jest.fn(),
  verifyEvmClaimFiled: jest.fn(),
  verifyEvmBondClaimResolved: jest.fn(),
  verifyEvmBondPosted: jest.fn(),
  verifyEvmBondRenewed: jest.fn(),
  verifyEvmBondToppedUp: jest.fn(),
  verifyEvmBondWithdrawn: jest.fn(),
  readOnchainBaseBond: jest.fn(),
  recoverEvmBondClaimResolution: jest.fn(),
}));

import { generatePE } from './pe-utils';
import { recoverEvmBondClaimResolution } from '../onchain/tx-verifier';

const mockGeneratePE = generatePE as jest.Mock;
const mockRecoverResolution = recoverEvmBondClaimResolution as jest.Mock;

const ACTIVE = { status: 'active' } as unknown as AgentWalletDocument;
const SUSPENDED = { status: 'suspended' } as unknown as AgentWalletDocument;

/** A db where ANY access is a probe failure — proves the gate ran first. */
function throwingDeps(): AgentBankDeps {
  const db = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`I/O before the kill-switch gate: db.${String(prop)} was touched`);
      },
    },
  );
  return { db, peBuffer: { enqueue: jest.fn() }, recordPEAccrual: jest.fn() } as unknown as AgentBankDeps;
}

function fakeDeps(fs: FakeFirestore): AgentBankDeps {
  return {
    db: fs as unknown as AgentBankDeps['db'],
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(),
  } as unknown as AgentBankDeps;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BOND_POOL_CONTRACT_ADDRESS_BASE = '0x' + '1'.repeat(40);
  mockGeneratePE.mockImplementation(async () => ({ peId: `pe_${Math.random().toString(36).slice(2, 8)}`, peHash: 'h', prevHash: 'p' }));
});

// ---------------------------------------------------------------------------
// Kill-switch FIRST — before ANY I/O, on every wired Court entry
// ---------------------------------------------------------------------------

describe('agent directory kill-switch-first ordering (probed with a throwing db)', () => {
  it('castVote: a suspended arbitrator is blocked before any read', async () => {
    await expect(castVote(throwingDeps(), 'esc1', 'w1', SUSPENDED, true)).rejects.toThrow(/Agent wallet is not active/);
  });

  it('fileGeneralDispute (route path): a suspended filer is blocked before any read', async () => {
    await expect(
      fileGeneralDispute(throwingDeps(), {
        filedBy: 'w1',
        respondent: 'w2',
        subjectPeIds: ['pe1'],
        description: 'a description long enough to pass validation',
        requestedRemedy: 'remedy',
        actingWallet: SUSPENDED,
      }),
    ).rejects.toThrow(/Agent wallet is not active/);
  });

  it('fileGeneralDispute (internal path): a suspended filer wallet blocks after its own read, before any further I/O', async () => {
    const fs = createFakeFirestore();
    fs.store.set('agent_wallets/w1', { id: 'w1', agent_id: 'a1', address: '0x' + 'a'.repeat(40), status: 'suspended', governance_score: 50 });
    await expect(
      fileGeneralDispute(fakeDeps(fs), {
        filedBy: 'w1',
        respondent: 'w2',
        subjectPeIds: ['pe1'],
        description: 'a description long enough to pass validation',
        requestedRemedy: 'remedy',
      }),
    ).rejects.toThrow(/Agent wallet is not active/);
    // Nothing was written anywhere.
    expect([...fs.store.keys()].filter((k) => k.startsWith('general_disputes/'))).toHaveLength(0);
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('castGeneralDisputeVote: a suspended arbitrator is blocked before any read', async () => {
    await expect(castGeneralDisputeVote(throwingDeps(), 'gd1', 'w1', SUSPENDED, 'upheld')).rejects.toThrow(/Agent wallet is not active/);
  });

  it('submitEvidence: a suspended submitter is blocked before any read', async () => {
    await expect(
      submitEvidence(throwingDeps(), { disputeId: 'gd1', submittedBy: 'w1', evidencePeIds: ['pe1'], actingWallet: SUSPENDED }),
    ).rejects.toThrow(/Agent wallet is not active/);
  });

  it('observeBondClaimSettlement (route path): a suspended observer is blocked before any read', async () => {
    await expect(
      observeBondClaimSettlement(throwingDeps(), { claimId: 'c1', actingWallet: SUSPENDED }),
    ).rejects.toThrow(/Agent wallet is not active/);
    expect(mockRecoverResolution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Notice — the respondent's own chain records the filing
// ---------------------------------------------------------------------------

describe('agent directory notice: fileGeneralDispute writes the respondent-chain PE', () => {
  it('emits court_general_dispute_filed for BOTH parties with role fields', async () => {
    const fs = createFakeFirestore();
    fs.store.set('agent_wallets/w_filer', {
      id: 'w_filer', agent_id: 'a_filer', address: '0x' + 'a'.repeat(40), status: 'active', governance_score: 50,
    });
    fs.store.set('agent_wallets/w_resp', {
      id: 'w_resp', agent_id: 'a_resp', address: '0x' + 'b'.repeat(40), status: 'active', governance_score: 50,
    });
    fs.store.set('meter_act_keys_v1/pe_subject', { actor_id: 'a_filer', action_type: 'escrow_completed', timestamp: 1 });

    const { disputeId } = await fileGeneralDispute(fakeDeps(fs), {
      filedBy: 'w_filer',
      respondent: 'w_resp',
      subjectPeIds: ['pe_subject'],
      description: 'the agent failed the agreed obligation',
      requestedRemedy: 'uphold and record',
      actingWallet: { status: 'active' } as unknown as AgentWalletDocument,
    });

    const filedPEs = mockGeneratePE.mock.calls.map((c) => c[1]).filter((p) => p.actionType === 'court_general_dispute_filed');
    expect(filedPEs).toHaveLength(2);
    const complainantPE = filedPEs.find((p) => p.metadata.role === 'complainant');
    const noticePE = filedPEs.find((p) => p.metadata.role === 'respondent');
    expect(complainantPE.walletId).toBe('w_filer');
    expect(noticePE.walletId).toBe('w_resp');
    expect(noticePE.metadata.notice).toBe(true);
    expect(noticePE.metadata.dispute_id).toBe(disputeId);
    // Counterparties cross-reference each other.
    expect(complainantPE.counterpartyAddress).toBe('0x' + 'b'.repeat(40));
    expect(noticePE.counterpartyAddress).toBe('0x' + 'a'.repeat(40));
    // Both PE ids land on the dispute record.
    const dispute = fs.store.get(`general_disputes/${disputeId}`) as { pe_ids: string[] };
    expect(dispute.pe_ids).toHaveLength(2);
  });

  it('a notice-PE failure never unwinds the filed dispute (best-effort)', async () => {
    const fs = createFakeFirestore();
    fs.store.set('agent_wallets/w_filer', {
      id: 'w_filer', agent_id: 'a_filer', address: '0x' + 'a'.repeat(40), status: 'active', governance_score: 50,
    });
    fs.store.set('agent_wallets/w_resp', {
      id: 'w_resp', agent_id: 'a_resp', address: '0x' + 'b'.repeat(40), status: 'active', governance_score: 50,
    });
    fs.store.set('meter_act_keys_v1/pe_subject', { actor_id: 'a_filer', action_type: 'escrow_completed', timestamp: 1 });

    // Filing PE succeeds; notice PE fails.
    mockGeneratePE
      .mockImplementationOnce(async () => ({ peId: 'pe_filing', peHash: 'h', prevHash: 'p' }))
      .mockImplementationOnce(async () => { throw new Error('notice chain write failed'); });

    const { disputeId } = await fileGeneralDispute(fakeDeps(fs), {
      filedBy: 'w_filer',
      respondent: 'w_resp',
      subjectPeIds: ['pe_subject'],
      description: 'the agent failed the agreed obligation',
      requestedRemedy: 'uphold and record',
      actingWallet: { status: 'active' } as unknown as AgentWalletDocument,
    });

    const dispute = fs.store.get(`general_disputes/${disputeId}`) as { status: string; pe_ids: string[] };
    expect(dispute.status).toBe('filed');
    expect(dispute.pe_ids).toEqual(['pe_filing']);
  });
});

// ---------------------------------------------------------------------------
// PE METER — a cited PE resolves from its act key, else from the presented proof
// ---------------------------------------------------------------------------

describe('PE meter: Court citations', () => {
  function seedParties(fs: FakeFirestore): void {
    fs.store.set('agent_wallets/w_filer', {
      id: 'w_filer', agent_id: 'a_filer', address: '0x' + 'a'.repeat(40), status: 'active',
    });
    fs.store.set('agent_wallets/w_resp', {
      id: 'w_resp', agent_id: 'a_resp', address: '0x' + 'b'.repeat(40), status: 'active',
    });
  }
  const file = (fs: FakeFirestore, extra: Partial<Parameters<typeof fileGeneralDispute>[1]> = {}) => fileGeneralDispute(fakeDeps(fs), {
    filedBy: 'w_filer',
    respondent: 'w_resp',
    subjectPeIds: ['pe_client_1'],
    description: 'the agent failed the agreed obligation',
    requestedRemedy: 'uphold and record',
    actingWallet: { status: 'active' } as unknown as AgentWalletDocument,
    ...extra,
  });

  it('a counterparty files on an old PE the respondent owns by presenting it with its inclusion proof', async () => {
    const fs = createFakeFirestore();
    seedParties(fs);
    // The respondent's own act, long past its act key; the filer is its counterparty.
    const fx = presentedPeFixture({ actorId: 'a_resp', fields: { counterparty_address: '0x' + 'A'.repeat(40) } });
    // RED: without the proof the relay has nothing to read (it keeps no PE) → not found.
    await expect(file(fs)).rejects.toThrow(/PE pe_client_1 not found/);
    const { disputeId } = await file(fs, {
      subjectPeProofs: new Map([[fx.pe.pe_id, fx.proof]]),
      anchorContract: fx.anchorContract,
    });
    expect((fs.store.get(`general_disputes/${disputeId}`) as { status: string }).status).toBe('filed');
  });

  it('RED: a proven PE that does not name the filer grants no standing; an unanchored one is refused', async () => {
    const fs = createFakeFirestore();
    seedParties(fs);
    const fx = presentedPeFixture({ actorId: 'a_resp', fields: { counterparty_address: '0x' + 'c'.repeat(40) } });
    await expect(file(fs, { subjectPeProofs: new Map([[fx.pe.pe_id, fx.proof]]), anchorContract: fx.anchorContract }))
      .rejects.toThrow(/no standing/);
    await expect(file(fs, { subjectPeProofs: new Map([[fx.pe.pe_id, fx.proof]]), anchorContract: { verifyPE: async () => false } }))
      .rejects.toThrow(/pe_not_anchored/);
  });

  it('submitEvidence accepts an act-key PE and a presented old PE; RED: an unknown id is refused', async () => {
    const fs = createFakeFirestore();
    seedParties(fs);
    fs.store.set('general_disputes/gd_ev', {
      dispute_id: 'gd_ev', filed_by: 'w_filer', respondent: 'w_resp', status: 'evidence_period', evidence_pe_ids: [],
    });
    fs.store.set('meter_act_keys_v1/pe_recent', { actor_id: 'a_filer', action_type: 'escrow_completed', timestamp: 1 });
    const fx = presentedPeFixture({ actorId: 'a_filer' });
    const submit = (ids: string[], proofs?: Map<string, typeof fx.proof>) => submitEvidence(fakeDeps(fs), {
      disputeId: 'gd_ev',
      submittedBy: 'w_filer',
      evidencePeIds: ids,
      actingWallet: ACTIVE,
      ...(proofs ? { evidencePeProofs: proofs, anchorContract: fx.anchorContract } : {}),
    });
    await expect(submit(['pe_unknown'])).rejects.toThrow(/PE pe_unknown not found/);
    await submit(['pe_recent', fx.pe.pe_id], new Map([[fx.pe.pe_id, fx.proof]]));
    expect((fs.store.get('general_disputes/gd_ev') as { evidence_pe_ids: string[] }).evidence_pe_ids)
      .toEqual(['pe_recent', fx.pe.pe_id]);
  });
});

// ---------------------------------------------------------------------------
// Voting mechanics — deadline enforced, out-of-lifecycle states refuse
// ---------------------------------------------------------------------------

describe('agent directory voting mechanics at the wired layer', () => {
  function seedVotingDispute(fs: FakeFirestore, overrides: Record<string, unknown> = {}): void {
    fs.store.set('general_disputes/gd1', {
      dispute_id: 'gd1',
      filed_by: 'w_filer',
      respondent: 'w_resp',
      subject_pe_ids: ['pe_subject'],
      description: 'd',
      requested_remedy: 'r',
      evidence_pe_ids: [],
      status: 'voting',
      panel_wallet_ids: ['arb1', 'arb2', 'arb3'],
      votes: {},
      pe_ids: [],
      created_at: Date.now(),
      updated_at: Date.now(),
      filed_at: Date.now(),
      ...overrides,
    });
    fs.store.set('agent_wallets/arb1', { id: 'arb1', agent_id: 'a1', address: '0x' + 'c'.repeat(40), status: 'active' });
  }

  it('rejects a vote after the voting deadline (previously silently accepted)', async () => {
    const fs = createFakeFirestore();
    seedVotingDispute(fs, { voting_deadline: Date.now() - 1000 });
    await expect(castGeneralDisputeVote(fakeDeps(fs), 'gd1', 'arb1', ACTIVE, 'upheld')).rejects.toThrow(/deadline/i);
    expect((fs.store.get('general_disputes/gd1') as { votes: Record<string, string> }).votes).toEqual({});
  });

  it('rejects a vote on a dispute not in voting (evidence_period)', async () => {
    const fs = createFakeFirestore();
    seedVotingDispute(fs, { status: 'evidence_period' });
    await expect(castGeneralDisputeVote(fakeDeps(fs), 'gd1', 'arb1', ACTIVE, 'upheld')).rejects.toThrow(/expected voting/i);
  });

  it('rejects a double vote atomically', async () => {
    const fs = createFakeFirestore();
    seedVotingDispute(fs, { votes: { arb1: 'upheld' }, voting_deadline: Date.now() + 60_000 });
    await expect(castGeneralDisputeVote(fakeDeps(fs), 'gd1', 'arb1', ACTIVE, 'dismissed')).rejects.toThrow(/already voted/i);
  });
});
