/**
 * court.castVote — Pass-3 #15 (exclude chain-FAILED votes from the tally) and
 * #1 (record the verdict ONLY after the on-chain escrow is confirmed settled).
 *
 * #15: the tally read only the release_to_recipient boolean; a vote whose on-chain
 *   castVote reverted (status:'failed') was still counted toward the 2-of-3
 *   majority (the comment claimed otherwise). It must be excluded.
 *
 * #1: reaching a Firestore majority used to flip the escrow → 'resolved' + emit
 *   court_verdict PEs with NO on-chain settlement. It must now gate the verdict on
 *   escrowChain.settleDispute returning a terminal on-chain resolution (fail-closed
 *   → leave the dispute pending and let it escalate at its voting deadline).
 */

import { castVote } from './court';
import type {
  AgentBankDeps,
  CourtDisputeDocument,
  CourtVoteRecord,
  EscrowDocument,
  EscrowDisputeSettleResult,
} from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';

// agent directory: minimal acting-wallet doc for the kill-switch-first machine gate.
const ACTING_WALLET = { status: 'active' } as unknown as AgentWalletDocument;
const SUSPENDED_WALLET = { status: 'suspended' } as unknown as AgentWalletDocument;
// agent directory: the machine requires a REAL 64-hex settlement receipt anchor.
const SETTLE_TX = '0x' + 'ab'.repeat(32);

let peCounter = 0;
const mockGeneratePE = jest.fn(async (..._a: unknown[]) => ({ peId: `pe_${++peCounter}`, peHash: 'h', prevHash: 'p' }));
jest.mock('./pe-utils', () => ({
  generatePE: (...a: unknown[]) => mockGeneratePE(...a),
  generateSchedulerPE: (...a: unknown[]) => mockGeneratePE(...a),
}));

const mockVerifyEvmContractCall = jest.fn();
jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmContractCall: (...a: unknown[]) => mockVerifyEvmContractCall(...a),
}));

jest.mock('./bonds', () => ({
  resolveBondClaim: jest.fn(),
  recordBondClaimCourtFinding: jest.fn(),
  getClaimDetails: jest.fn(),
  bondPoolAddressForChain: jest.fn(),
  chainIdForChain: jest.fn(() => 8453),
}));
jest.mock('./chain-registry', () => ({
  assertSupportedAgentBankChain: () => undefined,
  chainIdForName: () => 8453,
  courtAddressForChain: () => '0xCourt',
}));

const FUTURE = Date.now() + 1_000_000;

function makeDeps(opts: {
  votes: Record<string, CourtVoteRecord>;
  settle?: EscrowDisputeSettleResult;
  panel?: string[];
}): {
  deps: AgentBankDeps;
  disputeData: CourtDisputeDocument;
  escrowUpdate: jest.Mock;
  settleDispute: jest.Mock;
  escrowTxUpdates: () => Record<string, unknown>[];
  disputeTxUpdates: () => Record<string, unknown>[];
} {
  const panel = opts.panel ?? ['arb1', 'arb2', 'arb3'];
  const disputeData: CourtDisputeDocument = {
    escrow_id: 'esc1',
    panel,
    panel_addresses: panel.map((p) => `0x${p}`),
    chain: 'base',
    votes: { ...opts.votes },
    voting_deadline: FUTURE,
    status: 'pending',
    created_at: 0,
    updated_at: 0,
    pe_ids: [],
  } as CourtDisputeDocument;

  const disputeRef = {
    get: jest.fn().mockResolvedValue({ exists: true, data: () => disputeData }),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const escrowData = {
    escrow_id: 'esc1',
    depositor_wallet_id: 'wd',
    recipient_wallet_id: 'wr',
    depositor_address: '0xwd',
    recipient_address: '0xwr',
    currency: 'usdc',
    amount_usdc: 100,
    chain: 'base',
    status: 'disputed',
    pe_ids: ['pe_created'],
  } as unknown as EscrowDocument;
  const escrowUpdate = jest.fn().mockResolvedValue(undefined);
  const escrowRef = {
    get: jest.fn().mockResolvedValue({ exists: true, data: () => escrowData }),
    update: escrowUpdate,
  };

  const walletRefs = new Map<string, { get: jest.Mock; update: jest.Mock }>();
  const walletRef = (id: string) => {
    if (!walletRefs.has(id)) {
      walletRefs.set(id, {
        get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ agent_id: `agent_${id}`, address: `0x${id}` }) }),
        update: jest.fn().mockResolvedValue(undefined),
      });
    }
    return walletRefs.get(id)!;
  };

  // agent directory: transactional writes captured for assertions (the resolution claim
  // txn now carries BOTH the dispute verdict and the escrow flip).
  const txUpdates: Array<{ ref: unknown; data: Record<string, unknown> }> = [];
  const db = {
    collection: jest.fn((name: string) => {
      if (name === 'court_disputes') return { doc: () => disputeRef };
      if (name === 'escrows') return { doc: () => escrowRef };
      if (name === 'agent_wallets') return { doc: (id: string) => walletRef(id) };
      if (name === 'arbitrators') return { doc: () => ({ update: jest.fn().mockResolvedValue(undefined) }) };
      return { doc: jest.fn() };
    }),
    runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      // Route gets by ref identity (dispute vs escrow); apply updates in-place
      // so later reads observe the committed state (fake-atomic).
      const tx = {
        get: async (ref: unknown) => {
          if (ref === disputeRef) return { exists: true, data: () => disputeData };
          if (ref === escrowRef) return { exists: true, data: () => escrowData };
          return { exists: false, data: () => undefined };
        },
        update: jest.fn((ref: unknown, data: Record<string, unknown>) => {
          txUpdates.push({ ref, data });
          if (ref === disputeRef) Object.assign(disputeData, data);
          if (ref === escrowRef) Object.assign(escrowData, data);
        }),
        set: jest.fn(),
        create: jest.fn(),
      };
      return fn(tx);
    }),
  };

  const settleDispute = jest.fn().mockResolvedValue(
    opts.settle ?? { status: 'already_resolved', onchainId: '0xoid', txHash: SETTLE_TX },
  );
  const escrowChain = { canSign: () => true, settle: jest.fn(), settleDispute };

  const escrowTxUpdates = () => txUpdates.filter((u) => u.ref === escrowRef).map((u) => u.data);
  const disputeTxUpdates = () => txUpdates.filter((u) => u.ref === disputeRef).map((u) => u.data);
  return {
    deps: { db, escrowChain } as unknown as AgentBankDeps,
    disputeData,
    escrowUpdate,
    settleDispute,
    escrowTxUpdates,
    disputeTxUpdates,
  };
}

beforeEach(() => {
  peCounter = 0;
  mockGeneratePE.mockClear();
  mockVerifyEvmContractCall.mockReset();
});

describe('castVote - #15: chain-FAILED votes excluded from the tally', () => {
  it('does NOT reach majority when a failed vote would have been the 2nd matching vote', async () => {
    // arb1 release (confirmed) + arb2 release (FAILED on-chain). Pre-fix, arb2
    // counted → 2 release → majority. Post-fix, arb2 is excluded.
    const { deps, escrowUpdate, settleDispute } = makeDeps({
      votes: {
        arb1: { release_to_recipient: true, status: 'confirmed', cast_at: 0 },
        arb2: { release_to_recipient: true, status: 'failed', cast_at: 0, failure_reason: 'reverted' },
      },
    });

    // arb3 casts refund (no tx_hash → pending_chain, still counts).
    const dispute = await castVote(deps, 'esc1', 'arb3', ACTING_WALLET, false);

    // 1 release (arb1) + 1 refund (arb3), arb2 excluded → NO majority.
    expect(dispute.status).toBe('pending');
    expect(settleDispute).not.toHaveBeenCalled();
    expect(escrowUpdate).not.toHaveBeenCalled();
    // Only the court_vote_cast PE — no court_verdict PEs.
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
  });

  it('a failed vote is not enough to resolve even with one confirmed matching vote', async () => {
    // arb1 release (FAILED). arb2 casts release (confirmed). Only 1 valid release
    // vote → no majority (2 required).
    mockVerifyEvmContractCall.mockResolvedValue({ ok: true, blockNumber: 1 });
    const { deps, settleDispute } = makeDeps({
      votes: { arb1: { release_to_recipient: true, status: 'failed', cast_at: 0 } },
    });

    const dispute = await castVote(deps, 'esc1', 'arb2', ACTING_WALLET, true, '0xvotetx');

    expect(dispute.status).toBe('pending');
    expect(settleDispute).not.toHaveBeenCalled();
  });
});

describe('castVote - #1: verdict gated on confirmed on-chain settlement', () => {
  it('records the verdict after the on-chain escrow is confirmed resolved (receipt-anchored)', async () => {
    mockVerifyEvmContractCall.mockResolvedValue({ ok: true, blockNumber: 1 });
    const { deps, settleDispute, escrowTxUpdates, disputeTxUpdates } = makeDeps({
      votes: { arb1: { release_to_recipient: true, status: 'confirmed', cast_at: 0 } },
      settle: { status: 'already_resolved', onchainId: '0xoid', txHash: SETTLE_TX },
    });

    const dispute = await castVote(deps, 'esc1', 'arb2', ACTING_WALLET, true, '0xvotetx');

    expect(settleDispute).toHaveBeenCalledTimes(1);
    expect(settleDispute.mock.calls[0][1]).toBe(true); // verdict = release_to_recipient
    expect(dispute.status).toBe('resolved');
    // agent directory: the escrow flip lands INSIDE the resolution claim txn, behind the
    // same verified settlement receipt, with the tx hash recorded on BOTH docs.
    expect(escrowTxUpdates()).toContainEqual(
      expect.objectContaining({ status: 'resolved', resolution_tx_hash: SETTLE_TX.toLowerCase() }),
    );
    expect(disputeTxUpdates()).toContainEqual(
      expect.objectContaining({ status: 'resolved', resolution_tx_hash: SETTLE_TX.toLowerCase() }),
    );
  });

  it('the relay\'s verdict rows on the two escrow parties are records — neither counts as an adverse event', async () => {
    const { deriveCompositionSignals, countsAsAdverse, ADVERSE_STANDING_TYPES } =
      jest.requireActual('../pvt/actor-stats') as typeof import('../pvt/actor-stats');
    mockVerifyEvmContractCall.mockResolvedValue({ ok: true, blockNumber: 1 });
    mockGeneratePE.mockClear();
    const { deps } = makeDeps({
      votes: { arb1: { release_to_recipient: true, status: 'confirmed', cast_at: 0 } },
      settle: { status: 'already_resolved', onchainId: '0xoid', txHash: SETTLE_TX },
    });
    await castVote(deps, 'esc1', 'arb2', ACTING_WALLET, true, '0xvotetx');
    const verdicts = (mockGeneratePE.mock.calls as unknown as Array<[unknown, { actionType: string; metadata: Record<string, unknown> }]>)
      .map(([, p]) => p).filter((p) => p.actionType === 'court_verdict');
    expect(verdicts.map((p) => p.metadata.role).sort()).toEqual(['depositor', 'recipient']);
    // RED: by type alone (the pre- rule) both parties — the winner included — are marked.
    expect(verdicts.filter((p) => ADVERSE_STANDING_TYPES.has(p.actionType))).toHaveLength(2);
    expect(verdicts.filter((p) => countsAsAdverse(p.actionType, deriveCompositionSignals(p.metadata, null)))).toHaveLength(0);
    // The watcher's row for the same on-chain Verdict is the one that counts, on the loser.
    expect(countsAsAdverse('court_verdict', deriveCompositionSignals({ standing: 'adverse', canonical_event_id: 'base:0xab:1' }, null))).toBe(true);
  });

  it('agent directory FAIL-CLOSED: a terminal settlement WITHOUT a recoverable tx hash records no verdict', async () => {
    mockVerifyEvmContractCall.mockResolvedValue({ ok: true, blockNumber: 1 });
    const { deps, escrowUpdate, settleDispute, escrowTxUpdates, disputeTxUpdates } = makeDeps({
      votes: { arb1: { release_to_recipient: true, status: 'confirmed', cast_at: 0 } },
      // Terminal on-chain, but no receipt anchor recovered — the machine's
      // economic pending→resolved edge cannot fire without one.
      settle: { status: 'already_resolved', onchainId: '0xoid' },
    });

    const dispute = await castVote(deps, 'esc1', 'arb2', ACTING_WALLET, true, '0xvotetx');

    expect(settleDispute).toHaveBeenCalledTimes(1);
    expect(dispute.status).toBe('pending');
    expect(escrowUpdate).not.toHaveBeenCalled();
    expect(escrowTxUpdates()).toHaveLength(0);
    expect(disputeTxUpdates().filter((u) => u.status === 'resolved')).toHaveLength(0);
    // court_vote_cast PE only; no court_verdict / arbitrator PEs.
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
  });

  it('agent directory kill-switch-first: a suspended acting wallet is blocked before ANY read', async () => {
    const { deps, settleDispute } = makeDeps({
      votes: { arb1: { release_to_recipient: true, status: 'confirmed', cast_at: 0 } },
    });

    await expect(castVote(deps, 'esc1', 'arb2', SUSPENDED_WALLET, true, '0xvotetx')).rejects.toThrow(/Agent wallet is not active/);
    // Blocked BEFORE any I/O: no Firestore collection touched, no settle, no PE.
    expect((deps.db as unknown as { collection: jest.Mock }).collection).not.toHaveBeenCalled();
    expect(settleDispute).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('records the ACTUAL on-chain verdict, not the Firestore tally, when they diverge', async () => {
    mockVerifyEvmContractCall.mockResolvedValue({ ok: true, blockNumber: 1 });
    const { deps, escrowTxUpdates } = makeDeps({
      votes: { arb1: { release_to_recipient: true, status: 'confirmed', cast_at: 0 } },
      // Firestore tally will say release (2x), but the chain actually REFUNDED.
      settle: { status: 'already_resolved', onchainId: '0xoid', txHash: SETTLE_TX, resolvedReleaseToRecipient: false },
    });

    await castVote(deps, 'esc1', 'arb2', ACTING_WALLET, true, '0xvotetx');

    // Escrow resolution records the on-chain refund, not the Firestore release tally.
    expect(escrowTxUpdates()).toContainEqual(expect.objectContaining({ resolution: 'refund_to_depositor' }));
  });

  it('FAIL-CLOSED: leaves the dispute pending + writes NO verdict when not settled on-chain', async () => {
    mockVerifyEvmContractCall.mockResolvedValue({ ok: true, blockNumber: 1 });
    const { deps, escrowUpdate, settleDispute, escrowTxUpdates } = makeDeps({
      votes: { arb1: { release_to_recipient: true, status: 'confirmed', cast_at: 0 } },
      settle: { status: 'pending_onchain', onchainId: '0xoid' },
    });

    const dispute = await castVote(deps, 'esc1', 'arb2', ACTING_WALLET, true, '0xvotetx');

    // Majority reached, but the on-chain escrow is not settled → no verdict.
    expect(settleDispute).toHaveBeenCalledTimes(1);
    expect(dispute.status).toBe('pending');
    expect(escrowUpdate).not.toHaveBeenCalled();
    expect(escrowTxUpdates()).toHaveLength(0);
    // court_vote_cast PE only; no court_verdict / arbitrator PEs.
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
  });
});
