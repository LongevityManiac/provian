/**
 * disputeEscrow + resolveDispute — Pass-3 #1 (on-chain settle gate) and N2
 * (persist pe_ids + PE-before-status-flip).
 *
 * #1 (CRITICAL): resolveDispute used to flip Firestore → 'resolved' + emit
 *   escrow_resolved PEs while the on-chain escrow stayed Disputed forever (funds
 *   locked, both parties told they were paid). It must now go through the
 *   escrowChain.settleDispute gateway and record ONLY on a confirmed terminal
 *   on-chain resolution (fail-closed on every other status).
 *
 * N2: disputeEscrow/resolveDispute returned pe_ids to the caller but NEVER wrote
 *   them onto the escrow doc (so getEscrow's history omitted them), and flipped
 *   status BEFORE creating the PE (a PE failure then blocked the retry). Fix:
 *   emit the PE first, then persist pe_ids via arrayUnion in the status-flip update.
 */

import admin from 'firebase-admin';
import { disputeEscrow, resolveDispute } from './escrow';
import type { AgentBankDeps, EscrowDocument, EscrowDisputeSettleResult } from './types';

let peCounter = 0;
const mockGeneratePE = jest.fn(async (..._a: unknown[]) => ({ peId: `pe_${++peCounter}`, peHash: 'h', prevHash: 'p' }));
jest.mock('./pe-utils', () => ({ generatePE: (...a: unknown[]) => mockGeneratePE(...a) }));
jest.mock('../corroboration/CorroborationManager', () => ({
  emitBackendCorroboration: jest.fn(),
  resolveTargetPeHash: jest.fn().mockResolvedValue('h'),
}));
jest.mock('../onchain/tx-verifier', () => ({
  verifyTransfer: jest.fn(),
  verifyOnchainEscrowFunding: jest.fn(),
}));

const FUTURE = Date.now() + 1_000_000;

function baseEscrow(overrides: Partial<EscrowDocument> = {}): EscrowDocument {
  return {
    escrow_id: 'esc1',
    depositor_wallet_id: 'wd',
    recipient_wallet_id: 'wr',
    depositor_address: '0xwd',
    recipient_address: '0xwr',
    currency: 'usdc',
    amount_usdc: 100,
    fee_usdc: 0.5,
    net_to_recipient_usdc: 99.5,
    description: 'd',
    deliverables: 'dl',
    chain: 'base',
    deadline: FUTURE,
    auto_release_at: FUTURE,
    status: 'disputed',
    pe_ids: ['pe_created'],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as unknown as EscrowDocument;
}

/** linked-job settlement: stateful linked-job doc for the guarded settlement/mirror transactions. */
function makeJobDoc(id: string, data: Record<string, unknown>) {
  const held = { ...data };
  const patches: Record<string, unknown>[] = [];
  const ref = {
    id,
    _held: held,
    _patches: patches,
    update: jest.fn(async (patch: Record<string, unknown>) => {
      patches.push(patch);
      for (const [k, v] of Object.entries(patch)) {
        if (v instanceof admin.firestore.FieldValue) continue; // sentinel — not interpreted
        held[k] = v;
      }
    }),
    get: jest.fn(async () => ({ exists: true, id, data: () => held })),
  };
  return { id, ref, data: () => held, _patches: patches };
}

function makeDeps(opts: {
  escrow: EscrowDocument;
  settle?: EscrowDisputeSettleResult;
  noChain?: boolean;
  linkedJob?: ReturnType<typeof makeJobDoc>;
  linkedHumanJob?: ReturnType<typeof makeJobDoc>;
  /** the dispute went to the Court (`court_disputes/{escrowId}` exists). */
  courtDispute?: boolean;
}): {
  deps: AgentBankDeps;
  updateMock: jest.Mock;
  settleDispute: jest.Mock;
} {
  const updateMock = jest.fn().mockResolvedValue(undefined);
  const escrowRef = {
    get: jest.fn().mockResolvedValue({ exists: true, data: () => opts.escrow }),
    update: updateMock,
  };
  const escrowCollection = { doc: jest.fn(() => escrowRef) };
  const walletCollection = {
    doc: jest.fn((id: string) => ({
      get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ agent_id: `agent_${id}`, address: `0x${id}` }) }),
    })),
  };
  // linked-job settlement: resolveDispute/disputeEscrow now touch linked job docs via
  // job-settlement (where().limit(1).get() + guarded transactions).
  const linkedSnapshot = (d?: ReturnType<typeof makeJobDoc>) =>
    d ? { empty: false, docs: [d] } : { empty: true, docs: [] };
  const jobsCollection = {
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: jest.fn().mockResolvedValue(linkedSnapshot(opts.linkedJob)),
  };
  const humanJobsCollection = {
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: jest.fn().mockResolvedValue(linkedSnapshot(opts.linkedHumanJob)),
  };
  const db = {
    collection: jest.fn((name: string) => {
      if (name === 'escrows') return escrowCollection;
      if (name === 'jobs') return jobsCollection;
      if (name === 'commons_human_jobs') return humanJobsCollection;
      if (name === 'court_disputes') {
        return { doc: () => ({ get: async () => ({ exists: opts.courtDispute === true, data: () => ({}) }) }) };
      }
      return walletCollection;
    }),
    runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (ref: { get?: () => Promise<unknown> }) =>
          typeof ref?.get === 'function' ? ref.get() : { exists: false, data: () => undefined },
        update: (
          ref: { _held?: Record<string, unknown>; _patches?: Record<string, unknown>[] },
          patch: Record<string, unknown>,
        ) => {
          if (ref?._held && ref?._patches) {
            ref._patches.push(patch);
            for (const [k, v] of Object.entries(patch)) {
              if (v instanceof admin.firestore.FieldValue) continue;
              ref._held[k] = v;
            }
          }
        },
        set: jest.fn(),
        create: jest.fn(),
      };
      return fn(tx);
    }),
  };
  const settleDispute = jest.fn().mockResolvedValue(opts.settle ?? { status: 'already_resolved', onchainId: '0xoid' });
  const escrowChain = opts.noChain
    ? undefined
    : { canSign: () => true, settle: jest.fn(), settleDispute };
  return { deps: { db, escrowChain } as unknown as AgentBankDeps, updateMock, settleDispute };
}

beforeEach(() => {
  peCounter = 0;
  mockGeneratePE.mockClear();
});

describe('resolveDispute - on-chain settle gate (Pass-3 #1)', () => {
  it('records resolution ONLY after a confirmed on-chain settle (already_resolved)', async () => {
    const { deps, updateMock, settleDispute } = makeDeps({ escrow: baseEscrow(), settle: { status: 'already_resolved', onchainId: '0xoid' } });

    const result = await resolveDispute(deps, 'esc1', true, 'panel verdict');

    // Gated on the on-chain settlement, called with the requested direction.
    expect(settleDispute).toHaveBeenCalledTimes(1);
    expect(settleDispute.mock.calls[0][1]).toBe(true);
    // Firestore flip happened, both escrow_resolved PEs emitted.
    expect(mockGeneratePE).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('resolved');
    expect(result.resolution).toBe('release_to_recipient');
    const flip = updateMock.mock.calls.find((c) => (c[0] as { status?: string }).status === 'resolved');
    expect(flip).toBeDefined();
  });

  it('records the on-chain resolution tx hash when the gateway drove the settle', async () => {
    const { deps, updateMock } = makeDeps({ escrow: baseEscrow(), settle: { status: 'resolved', txHash: '0xsettle', onchainId: '0xoid', resolvedReleaseToRecipient: false } });

    await resolveDispute(deps, 'esc1', false, 'refund');

    const flip = updateMock.mock.calls.find((c) => (c[0] as { status?: string }).status === 'resolved');
    expect(flip?.[0]).toMatchObject({ resolution: 'refund_to_depositor', resolution_tx_hash: '0xsettle' });
  });

  // Review finding: the OBSERVE path (already_resolved) must record the ACTUAL
  // on-chain direction, not the caller's requested one — they can diverge (e.g. a
  // permissionless claimDisputeTimeout refunded the depositor even though the admin
  // requested release).
  it('records the ACTUAL on-chain direction, not the requested one, on already_resolved', async () => {
    const { deps, updateMock } = makeDeps({
      escrow: baseEscrow(),
      settle: { status: 'already_resolved', onchainId: '0xoid', resolvedReleaseToRecipient: false },
    });

    // Admin REQUESTED release, but the chain actually REFUNDED the depositor.
    const result = await resolveDispute(deps, 'esc1', true, 'admin requested release');

    expect(result.resolution).toBe('refund_to_depositor');
    const flip = updateMock.mock.calls.find((c) => (c[0] as { status?: string }).status === 'resolved');
    expect(flip?.[0]).toMatchObject({ resolution: 'refund_to_depositor' });
    // Both escrow_resolved PEs carry the actual (refund) direction.
    const peMetas = mockGeneratePE.mock.calls.map((c) => (c[1] as { metadata: { resolution?: string } }).metadata);
    expect(peMetas.every((m) => m.resolution === 'refund_to_depositor')).toBe(true);
  });

  it('FAIL-CLOSED: throws + writes nothing when the escrow is not settled on-chain (pending_onchain)', async () => {
    const { deps, updateMock } = makeDeps({ escrow: baseEscrow(), settle: { status: 'pending_onchain', onchainId: '0xoid' } });

    await expect(resolveDispute(deps, 'esc1', true, 'verdict')).rejects.toThrow(/not settled/i);
    // No Firestore theater: no status flip, no escrow_resolved PEs.
    expect(updateMock).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: throws when no release signer is configured (escrowChain absent)', async () => {
    const { deps, updateMock } = makeDeps({ escrow: baseEscrow(), noChain: true });

    await expect(resolveDispute(deps, 'esc1', true, 'verdict')).rejects.toThrow(/unavailable|unconfigured/i);
    expect(updateMock).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: throws when the on-chain escrow is not disputed', async () => {
    const { deps, updateMock } = makeDeps({ escrow: baseEscrow(), settle: { status: 'not_disputed_onchain', onchainId: '0xoid' } });

    await expect(resolveDispute(deps, 'esc1', true, 'verdict')).rejects.toThrow(/not in a disputed state/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: throws on a gateway failure', async () => {
    const { deps, updateMock } = makeDeps({ escrow: baseEscrow(), settle: { status: 'failed', reason: 'rpc_down' } });

    await expect(resolveDispute(deps, 'esc1', true, 'verdict')).rejects.toThrow(/failed/i);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('resolveDispute - N2: persist pe_ids + PE-before-flip', () => {
  it('persists the escrow_resolved PEs onto the escrow doc via arrayUnion', async () => {
    const { deps, updateMock } = makeDeps({ escrow: baseEscrow(), settle: { status: 'already_resolved', onchainId: '0xoid' } });

    await resolveDispute(deps, 'esc1', true, 'verdict');

    const flip = updateMock.mock.calls.find((c) => (c[0] as { status?: string }).status === 'resolved');
    // The finding: pe_ids were NEVER written to the doc. Now they are.
    expect(flip?.[0]).toHaveProperty('pe_ids');
  });

  it('emits the PEs BEFORE flipping status (retry-safe ordering)', async () => {
    const { deps, updateMock } = makeDeps({ escrow: baseEscrow(), settle: { status: 'already_resolved', onchainId: '0xoid' } });

    await resolveDispute(deps, 'esc1', true, 'verdict');

    const lastPeOrder = Math.max(...mockGeneratePE.mock.invocationCallOrder);
    const flipOrder = updateMock.mock.invocationCallOrder[0];
    expect(lastPeOrder).toBeLessThan(flipOrder);
  });
});

describe('disputeEscrow - self-report PE retired (dispute is chain-witnessed)', () => {
  it('flips to disputed WITHOUT emitting a self-report PE or writing pe_ids', async () => {
    const { deps, updateMock } = makeDeps({ escrow: baseEscrow({ status: 'funded' }) });

    const result = await disputeEscrow(deps, 'esc1', 'wd', 'bad work');

    // the escrow_disputed PE is now emitted ONLY by the institution
    // completion watcher from the on-chain `EscrowDisputed` event (parity with
    // escrow_resolved). The relay dispute is a Firestore state flip; it emits no
    // self-report PE. RED control: re-adding the self-report `generatePE` call, or
    // writing `pe_ids` back, trips this test.
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(result.status).toBe('disputed');
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0]).toMatchObject({ status: 'disputed' });
    expect(updateMock.mock.calls[0][0]).not.toHaveProperty('pe_ids');
  });
});

// ---------------------------------------------------------------------------
// linked-job settlement — linked-job wiring: dispute mirror + resolution-driven job settlement
// ---------------------------------------------------------------------------

const TX_RESOLVE = `0x${'ef'.repeat(32)}`;

describe('linked-job settlement: resolveDispute settles linked jobs off the ACTUAL direction', () => {
  it('REFUND: advances the linked agent job to refunded (worker NOT paid — never completed)', async () => {
    const linkedJob = makeJobDoc('job_linked', {
      job_id: 'job_linked',
      escrow_id: 'esc1',
      status: 'delivered',
    });
    const { deps } = makeDeps({
      escrow: baseEscrow(),
      settle: { status: 'resolved', txHash: TX_RESOLVE, onchainId: '0xoid', resolvedReleaseToRecipient: false },
      linkedJob,
    });

    await resolveDispute(deps, 'esc1', false, 'refund the poster');

    const job = linkedJob.data() as Record<string, unknown>;
    expect(job.status).toBe('refunded');
    expect(job.refunded_at as number).toBeGreaterThan(0);
    expect(job.settlement_tx_hash).toBe(TX_RESOLVE);
    // Dual-party job_refunded PEs, receipt-linked, refund direction recorded.
    const refundPes = mockGeneratePE.mock.calls.filter(
      (c) => (c[1] as { actionType?: string })?.actionType === 'job_refunded',
    );
    expect(refundPes).toHaveLength(2);
    const meta = (refundPes[0][1] as { metadata: Record<string, unknown> }).metadata;
    expect(meta.tx_hash).toBe(TX_RESOLVE);
    expect(meta.resolution).toBe('refund_to_depositor');
  });

  it('RELEASE: advances a linked (disputed) human job to completed with payment truth', async () => {
    const linkedHumanJob = makeJobDoc('hjob_linked', {
      job_id: 'hjob_linked',
      escrow_id: 'esc1',
      status: 'disputed',
    });
    const { deps } = makeDeps({
      escrow: baseEscrow(),
      settle: { status: 'resolved', txHash: TX_RESOLVE, onchainId: '0xoid', resolvedReleaseToRecipient: true },
      linkedHumanJob,
    });

    await resolveDispute(deps, 'esc1', true, 'work was delivered');

    const job = linkedHumanJob.data() as Record<string, unknown>;
    expect(job.status).toBe('completed');
    expect(job.payment_released).toBe(true);
    expect(job.settlement_tx_hash).toBe(TX_RESOLVE);
  });

  it('REFUND on a disputed human job terminates it refunded (payment_released stays false)', async () => {
    const linkedHumanJob = makeJobDoc('hjob_linked', {
      job_id: 'hjob_linked',
      escrow_id: 'esc1',
      status: 'disputed',
    });
    const { deps } = makeDeps({
      escrow: baseEscrow(),
      settle: { status: 'resolved', txHash: TX_RESOLVE, onchainId: '0xoid', resolvedReleaseToRecipient: false },
      linkedHumanJob,
    });

    await resolveDispute(deps, 'esc1', false, 'refund');

    const job = linkedHumanJob.data() as Record<string, unknown>;
    expect(job.status).toBe('refunded');
    expect(job.payment_released).toBe(false);
    const refundPes = mockGeneratePE.mock.calls.filter(
      (c) => (c[1] as { actionType?: string })?.actionType === 'human_job_refunded',
    );
    expect(refundPes).toHaveLength(2);
  });

  it('FAILS CLOSED: a resolution with no recoverable tx hash leaves the linked job un-advanced', async () => {
    const linkedJob = makeJobDoc('job_linked', {
      job_id: 'job_linked',
      escrow_id: 'esc1',
      status: 'delivered',
    });
    const { deps } = makeDeps({
      escrow: baseEscrow(),
      // Observe path that recovered the direction but no tx hash (legacy shape).
      settle: { status: 'already_resolved', onchainId: '0xoid', resolvedReleaseToRecipient: false },
      linkedJob,
    });

    await resolveDispute(deps, 'esc1', false, 'refund');

    const job = linkedJob.data() as Record<string, unknown>;
    expect(job.status).toBe('delivered'); // no evidence, no record
    expect(
      mockGeneratePE.mock.calls.filter(
        (c) => (c[1] as { actionType?: string })?.actionType === 'job_refunded',
      ),
    ).toHaveLength(0);
  });
});

describe('linked-job settlement: disputeEscrow mirrors the dispute onto linked jobs', () => {
  it('marks the agent-board job with escrow_disputed_at (field mirror, status unchanged)', async () => {
    const linkedJob = makeJobDoc('job_linked', {
      job_id: 'job_linked',
      escrow_id: 'esc1',
      status: 'delivered',
    });
    const { deps } = makeDeps({ escrow: baseEscrow({ status: 'funded' }), linkedJob });

    await disputeEscrow(deps, 'esc1', 'wd', 'bad work');

    const job = linkedJob.data() as Record<string, unknown>;
    expect(job.status).toBe('delivered'); // a dispute is not a payment outcome
    expect(job.escrow_disputed_at as number).toBeGreaterThan(0);
  });

  it('flips a linked human job in_progress → disputed through the guarded record-only edge', async () => {
    const linkedHumanJob = makeJobDoc('hjob_linked', {
      job_id: 'hjob_linked',
      escrow_id: 'esc1',
      status: 'in_progress',
    });
    const { deps } = makeDeps({ escrow: baseEscrow({ status: 'funded' }), linkedHumanJob });

    await disputeEscrow(deps, 'esc1', 'wd', 'bad work');

    const job = linkedHumanJob.data() as Record<string, unknown>;
    expect(job.status).toBe('disputed');
    expect(job.disputed_at as number).toBeGreaterThan(0);
  });

  it('BLOCKS the human-job mirror on an unmodeled source state (Unknown = Block)', async () => {
    const linkedHumanJob = makeJobDoc('hjob_linked', {
      job_id: 'hjob_linked',
      escrow_id: 'esc1',
      status: 'completed', // settled job — a dispute mirror here is not a declared edge
    });
    const { deps } = makeDeps({ escrow: baseEscrow({ status: 'funded' }), linkedHumanJob });

    await disputeEscrow(deps, 'esc1', 'wd', 'bad work');

    const job = linkedHumanJob.data() as Record<string, unknown>;
    expect(job.status).toBe('completed'); // untouched — fail-closed
    expect(job.disputed_at).toBeUndefined();
  });
});


describe('a HIRE dispute is one adverse event on the party the chain did not pay', () => {
  const { deriveCompositionSignals, countsAsAdverse } = jest.requireActual('../pvt/actor-stats') as typeof import('../pvt/actor-stats');
  const sealed = () => (mockGeneratePE.mock.calls as unknown as Array<[unknown, { walletId: string; actionType: string; metadata: Record<string, unknown> }]>)
    .map(([, p]) => ({ wallet: p.walletId, md: p.metadata, adverse: countsAsAdverse(p.actionType, deriveCompositionSignals(p.metadata, null)) }));

  it('timeout refund on a hire: the hired party (recipient) is marked, the payer is not', async () => {
    const { deps } = makeDeps({ escrow: baseEscrow(), settle: { status: 'resolved', txHash: '0x' + 'ab'.repeat(32), resolvedReleaseToRecipient: false, resolvedByCourt: false } as EscrowDisputeSettleResult });
    await resolveDispute(deps, 'esc1', false, 'dispute_timeout_refund', { hireJobId: 'hjob1' });
    const rows = sealed();
    expect(rows.map((r) => r.md.hire_job_id)).toEqual(['hjob1', 'hjob1']);
    expect(rows.filter((r) => r.adverse).map((r) => r.wallet)).toEqual(['wr']);
  });

  it('admin release on a hire: the payer (depositor) is marked — the direction is the one the chain paid', async () => {
    const { deps } = makeDeps({ escrow: baseEscrow(), settle: { status: 'already_resolved', onchainId: '0xoid', resolvedReleaseToRecipient: true, resolvedByCourt: false } as EscrowDisputeSettleResult });
    await resolveDispute(deps, 'esc1', false, 'onchain_resolution_observed', { hireJobId: 'hjob1' });
    expect(sealed().filter((r) => r.adverse).map((r) => r.wallet)).toEqual(['wd']);
  });

  it('RED: the same resolution with no hire context (every non-hire escrow, and all escrows before the ruling) marks nobody', async () => {
    const { deps } = makeDeps({ escrow: baseEscrow(), settle: { status: 'resolved', txHash: '0x' + 'ab'.repeat(32), resolvedReleaseToRecipient: false, resolvedByCourt: false } as EscrowDisputeSettleResult });
    await resolveDispute(deps, 'esc1', false, 'admin decision');
    const rows = sealed();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.md.hire_job_id === undefined)).toBe(true);
    expect(rows.filter((r) => r.adverse)).toHaveLength(0);
  });

  it('the admin route passes no hire context: the resolver finds the hire itself (RED: the loser was never marked)', async () => {
    const linkedHumanJob = makeJobDoc('hjob7', { status: 'disputed', escrow_id: 'esc1' });
    const { deps } = makeDeps({ escrow: baseEscrow(), linkedHumanJob, settle: { status: 'resolved', txHash: '0x' + 'ab'.repeat(32), resolvedReleaseToRecipient: false, resolvedByCourt: false } as EscrowDisputeSettleResult });
    await resolveDispute(deps, 'esc1', false, 'admin decision');
    const rows = sealed();
    expect(rows.map((r) => r.md.hire_job_id)).toEqual(['hjob7', 'hjob7']);
    expect(rows.filter((r) => r.adverse).map((r) => r.wallet)).toEqual(['wr']);
  });

  it('a dispute the Court decided is counted by its verdict, never a second time as a lost hire dispute', async () => {
    const { deps } = makeDeps({ escrow: baseEscrow(), settle: { status: 'already_resolved', onchainId: '0xoid', resolvedReleaseToRecipient: false, resolvedByCourt: true } as EscrowDisputeSettleResult });
    await resolveDispute(deps, 'esc1', false, 'onchain_resolution_observed', { hireJobId: 'hjob1' });
    const rows = sealed();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.md.hire_job_id === undefined)).toBe(true);
    expect(rows.filter((r) => r.adverse)).toHaveLength(0);
  });

  it('a relay Court record alone decides nothing: a panel seated but the timeout refund resolved it → the loser IS marked', async () => {
    const { deps } = makeDeps({ escrow: baseEscrow(), courtDispute: true, settle: { status: 'resolved', txHash: '0x' + 'ab'.repeat(32), resolvedReleaseToRecipient: false, resolvedByCourt: false } as EscrowDisputeSettleResult });
    await resolveDispute(deps, 'esc1', false, 'dispute_timeout_refund', { hireJobId: 'hjob1' });
    expect(sealed().filter((r) => r.adverse).map((r) => r.wallet)).toEqual(['wr']);
  });

  it('an unknown resolver marks nobody (a gateway that does not say who resolved it)', async () => {
    const { deps } = makeDeps({ escrow: baseEscrow(), settle: { status: 'already_resolved', onchainId: '0xoid', resolvedReleaseToRecipient: false } as EscrowDisputeSettleResult });
    await resolveDispute(deps, 'esc1', false, 'onchain_resolution_observed', { hireJobId: 'hjob1' });
    expect(sealed().filter((r) => r.adverse)).toHaveLength(0);
  });
});
