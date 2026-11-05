/**
 * the dispute fallback on every Commons hire (admin path + the 30-day permissionless
 * refund), bound to the chain. RED controls (each reddens under the named mutation):
 * - FILE records nothing unless the chain says Disputed. (skip the on-chain status check → RED)
 * - only the payer (poster/depositor) files. (drop the role check → RED)
 * - SETTLE inside the dispute window refuses 409 and never asks the chain to resolve.
 * (drop the window check → RED)
 * - a stranger can neither read nor settle.
 * - Court escalation is never offered.
 * - RECONCILIATION : a dispute the chain holds but the relay missed (late POST past the
 * relay's auto_release_at, or resolved on-chain first) is recorded, never left `funded`
 * forever; a funded record whose chain holds NO dispute is never flipped.
 * (drop the observed branch → RED)
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockDisputeEscrow = jest.fn(async (..._args: unknown[]) => ({
  escrow_id: 'esc_1', status: 'disputed', currency: 'pvt', disputed_at: 1000, dispute_reason: 'late',
}));
const mockResolveDispute = jest.fn(async (..._args: unknown[]) => ({
  escrow_id: 'esc_1', status: 'resolved', currency: 'pvt', resolution: 'refund_to_depositor', resolution_tx_hash: '0xabc',
}));
jest.mock('../agent-bank/escrow', () => ({
  __esModule: true,
  disputeEscrow: (...args: unknown[]) => mockDisputeEscrow(...args),
  resolveDispute: (...args: unknown[]) => mockResolveDispute(...args),
}));

import { fileJobDispute, getJobDispute, settleJobDispute, observeResolvedHireDisputes, JobDisputeConflictError } from './job-disputes';
import { COMMONS_COLLECTIONS } from './types';
import { ONCHAIN_ESCROW_STATUS, type AgentBankDeps, type EscrowDisputeStateRead } from '../agent-bank/types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const POSTER = 'user_payer';
const HIRED = 'wallet_aw_worker';
const STRANGER = 'user_stranger';
const NOW = 2_000_000_000_000;
const DEADLINE_SEC = BigInt(Math.floor(NOW / 1000) + 3600); // one hour from NOW

let chainState: EscrowDisputeStateRead;

function makeDeps(db: FakeFirestore, withReader = true): AgentBankDeps {
  return {
    db,
    escrowChain: {
      canSign: () => true,
      settle: async () => ({ status: 'failed' }),
      settleDispute: async () => ({ status: 'failed' }),
      ...(withReader ? { readDisputeState: async () => chainState } : {}),
    },
  } as unknown as AgentBankDeps;
}

function seed(db: FakeFirestore, escrowStatus = 'funded'): void {
  db.store.set(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`, {
    job_id: 'hjob1', poster_wallet_id: POSTER, accepted_applicant_wallet_id: HIRED, escrow_id: 'esc_1', status: 'in_progress', title: 't',
  });
  db.store.set('escrows/esc_1', {
    escrow_id: 'esc_1', status: escrowStatus, currency: 'pvt', chain: 'base', onchain_escrow_id: '0x' + '11'.repeat(32),
    depositor_wallet_id: POSTER, recipient_wallet_id: HIRED,
  });
}

beforeEach(() => {
  mockDisputeEscrow.mockClear();
  mockResolveDispute.mockClear();
  chainState = { ok: true, onchainId: '0x' + '11'.repeat(32), status: ONCHAIN_ESCROW_STATUS.DISPUTED, disputeDeadlineSec: DEADLINE_SEC };
});

describe('FILE — the payer records the dispute it raised on-chain', () => {
  it('REACHABILITY: chain Disputed → recorded via the existing escrow dispute; view carries the refund date, never Court', async () => {
    const db = createFakeFirestore();
    seed(db);
    const view = await fileJobDispute(makeDeps(db), POSTER, 'hjob1', { reason: 'late', evidence: 'no delivery' }, NOW);
    expect(mockDisputeEscrow).toHaveBeenCalledWith(expect.anything(), 'esc_1', POSTER, 'late', 'no delivery');
    expect(view.onchain_status).toBe('disputed');
    expect(view.refund_opens_at).toBe(Number(DEADLINE_SEC) * 1000);
    expect(view.refund_claimable).toBe(false);
    expect(view.court_escalation_available).toBe(false);
  });

  it('RED: the chain is not Disputed → 409 onchain_dispute_required, nothing recorded', async () => {
    const db = createFakeFirestore();
    seed(db);
    chainState = { ok: true, onchainId: '0x' + '11'.repeat(32), status: ONCHAIN_ESCROW_STATUS.FUNDED, disputeDeadlineSec: 0n };
    await expect(fileJobDispute(makeDeps(db), POSTER, 'hjob1', { reason: 'late' }, NOW)).rejects.toMatchObject({
      status: 409, code: 'onchain_dispute_required',
    });
    expect(mockDisputeEscrow).not.toHaveBeenCalled();
  });

  it('RED: an unreadable chain (or no reader) refuses — never a relay-only flip', async () => {
    const db = createFakeFirestore();
    seed(db);
    chainState = { ok: false, reason: 'rpc down' };
    await expect(fileJobDispute(makeDeps(db), POSTER, 'hjob1', { reason: 'x' }, NOW)).rejects.toBeInstanceOf(JobDisputeConflictError);
    await expect(fileJobDispute(makeDeps(db, false), POSTER, 'hjob1', { reason: 'x' }, NOW)).rejects.toMatchObject({ code: 'onchain_state_unreadable' });
    expect(mockDisputeEscrow).not.toHaveBeenCalled();
  });

  it('RED: only the payer files (the hired party is protected by auto-release; strangers are refused)', async () => {
    const db = createFakeFirestore();
    seed(db);
    await expect(fileJobDispute(makeDeps(db), HIRED, 'hjob1', { reason: 'x' }, NOW)).rejects.toThrow(/Only the payer/);
    await expect(fileJobDispute(makeDeps(db), STRANGER, 'hjob1', { reason: 'x' }, NOW)).rejects.toThrow(/poster or the hired/);
    expect(mockDisputeEscrow).not.toHaveBeenCalled();
  });

  it('input bounds: reason required; only a funded escrow is disputable', async () => {
    const db = createFakeFirestore();
    seed(db);
    await expect(fileJobDispute(makeDeps(db), POSTER, 'hjob1', { reason: '  ' }, NOW)).rejects.toThrow(/reason is required/);
    seed(db, 'completed');
    await expect(fileJobDispute(makeDeps(db), POSTER, 'hjob1', { reason: 'x' }, NOW)).rejects.toThrow(/Only a funded escrow/);
  });
});

describe('SETTLE — admin resolution observed, or the 30-day refund once its deadline passes', () => {
  it('RED: inside the window with no on-chain resolution → 409 dispute_pending with the date; the chain is never asked', async () => {
    const db = createFakeFirestore();
    seed(db, 'disputed');
    await expect(settleJobDispute(makeDeps(db), HIRED, 'hjob1', NOW)).rejects.toMatchObject({
      status: 409, code: 'dispute_pending', details: { refund_opens_at: Number(DEADLINE_SEC) * 1000 },
    });
    expect(mockResolveDispute).not.toHaveBeenCalled();
  });

  it('past the deadline → the permissionless refund (resolveDispute, refund direction)', async () => {
    const db = createFakeFirestore();
    seed(db, 'disputed');
    const after = Number(DEADLINE_SEC) * 1000 + 1;
    const view = await settleJobDispute(makeDeps(db), POSTER, 'hjob1', after);
    expect(mockResolveDispute).toHaveBeenCalledWith(expect.anything(), 'esc_1', false, 'dispute_timeout_refund', { hireJobId: 'hjob1' });
    expect(view.resolution).toBe('refund_to_depositor');
  });

  it('an admin resolution already on-chain is OBSERVED (either party may ask), in the direction the chain paid', async () => {
    const db = createFakeFirestore();
    seed(db, 'disputed');
    chainState = { ok: true, onchainId: '0x' + '11'.repeat(32), status: ONCHAIN_ESCROW_STATUS.RESOLVED, disputeDeadlineSec: DEADLINE_SEC };
    await settleJobDispute(makeDeps(db), HIRED, 'hjob1', NOW);
    expect(mockResolveDispute).toHaveBeenCalledWith(expect.anything(), 'esc_1', false, 'onchain_resolution_observed', { hireJobId: 'hjob1' });
  });

  it('RED: a stranger cannot settle or read; no open dispute → 400', async () => {
    const db = createFakeFirestore();
    seed(db, 'disputed');
    await expect(settleJobDispute(makeDeps(db), STRANGER, 'hjob1', NOW)).rejects.toThrow(/poster or the hired/);
    await expect(getJobDispute(makeDeps(db), STRANGER, 'hjob1', NOW)).rejects.toThrow(/poster or the hired/);
    seed(db, 'completed');
    await expect(settleJobDispute(makeDeps(db), POSTER, 'hjob1', NOW)).rejects.toThrow(/no open dispute/);
    expect(mockResolveDispute).not.toHaveBeenCalled();
  });
});

describe('READ — both parties see the same view', () => {
  it('refund_claimable flips only once the on-chain deadline has passed', async () => {
    const db = createFakeFirestore();
    seed(db, 'disputed');
    expect((await getJobDispute(makeDeps(db), HIRED, 'hjob1', NOW)).refund_claimable).toBe(false);
    expect((await getJobDispute(makeDeps(db), POSTER, 'hjob1', Number(DEADLINE_SEC) * 1000)).refund_claimable).toBe(true);
  });
});

describe('RECONCILIATION — the chain holds a dispute the relay record missed', () => {
  function seedPastAutoRelease(db: FakeFirestore): void {
    seed(db);
    const esc = db.store.get('escrows/esc_1') as Record<string, unknown>;
    db.store.set('escrows/esc_1', { ...esc, auto_release_at: NOW - 60_000 });
  }

  it('RED: a dispute mined before auto-release whose POST lands after the relay deadline is RECORDED (not refused, not left funded)', async () => {
    const db = createFakeFirestore();
    seedPastAutoRelease(db);
    const view = await fileJobDispute(makeDeps(db), POSTER, 'hjob1', { reason: 'late', evidence: 'none' }, NOW);
    expect(mockDisputeEscrow).not.toHaveBeenCalled(); // the relay-time check would refuse it
    const esc = db.store.get('escrows/esc_1') as Record<string, unknown>;
    expect(esc.status).toBe('disputed');
    expect(esc.dispute_reason).toBe('late');
    expect(esc.dispute_recorded_from_chain).toBe(true);
    expect(view.escrow_status).toBe('disputed');
    expect((db.store.get(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`) as Record<string, unknown>).status).toBe('disputed');
  });

  it('RED: resolved on-chain before the relay heard of the dispute → FILE records it and settles in the chain\'s direction', async () => {
    const db = createFakeFirestore();
    seed(db);
    chainState = { ok: true, onchainId: '0x' + '11'.repeat(32), status: ONCHAIN_ESCROW_STATUS.RESOLVED, disputeDeadlineSec: DEADLINE_SEC };
    await fileJobDispute(makeDeps(db), POSTER, 'hjob1', { reason: 'late' }, NOW);
    expect((db.store.get('escrows/esc_1') as Record<string, unknown>).status).toBe('disputed'); // recorded first…
    expect(mockResolveDispute).toHaveBeenCalledWith(expect.anything(), 'esc_1', false, 'onchain_resolution_observed', { hireJobId: 'hjob1' }); // …then settled
  });

  it('RED: SETTLE on a funded record whose chain is Resolved reconciles it (either party — the worker paid by the admin can close it)', async () => {
    const db = createFakeFirestore();
    seed(db);
    chainState = { ok: true, onchainId: '0x' + '11'.repeat(32), status: ONCHAIN_ESCROW_STATUS.RESOLVED, disputeDeadlineSec: DEADLINE_SEC };
    await settleJobDispute(makeDeps(db), HIRED, 'hjob1', NOW);
    expect((db.store.get('escrows/esc_1') as Record<string, unknown>).status).toBe('disputed');
    expect(mockResolveDispute).toHaveBeenCalledWith(expect.anything(), 'esc_1', false, 'onchain_resolution_observed', { hireJobId: 'hjob1' });
  });

  it('SETTLE on a funded record whose chain is Disputed inside the window records the dispute, then answers dispute_pending', async () => {
    const db = createFakeFirestore();
    seed(db);
    await expect(settleJobDispute(makeDeps(db), HIRED, 'hjob1', NOW)).rejects.toMatchObject({ status: 409, code: 'dispute_pending' });
    expect((db.store.get('escrows/esc_1') as Record<string, unknown>).status).toBe('disputed');
    expect(mockResolveDispute).not.toHaveBeenCalled();
  });

  it('RED control: a funded record whose chain holds NO dispute (or cannot be read) is never flipped', async () => {
    const db = createFakeFirestore();
    seed(db);
    chainState = { ok: true, onchainId: '0x' + '11'.repeat(32), status: ONCHAIN_ESCROW_STATUS.FUNDED, disputeDeadlineSec: 0n };
    await expect(settleJobDispute(makeDeps(db), POSTER, 'hjob1', NOW)).rejects.toThrow(/no open dispute/);
    chainState = { ok: false, reason: 'rpc down' };
    await expect(settleJobDispute(makeDeps(db), POSTER, 'hjob1', NOW)).rejects.toThrow(/no open dispute/);
    expect((db.store.get('escrows/esc_1') as Record<string, unknown>).status).toBe('funded');
    expect(mockResolveDispute).not.toHaveBeenCalled();
  });
});


describe('a hire dispute the chain resolved that nobody reported (Standing sweep)', () => {
  const resolved = (): void => { chainState = { ok: true, status: ONCHAIN_ESCROW_STATUS.RESOLVED, disputeDeadlineSec: DEADLINE_SEC, onchainId: '0x' + '11'.repeat(32) } as EscrowDisputeStateRead; };
  const disputedOnchain = (): void => { chainState = { ok: true, status: ONCHAIN_ESCROW_STATUS.DISPUTED, disputeDeadlineSec: DEADLINE_SEC, onchainId: '0x' + '11'.repeat(32) } as EscrowDisputeStateRead; };

  it('RED then GREEN: a relay-disputed hire escrow the chain already resolved is recorded with its job id — no party asked', async () => {
    const db = createFakeFirestore();
    seed(db, 'disputed');
    resolved();
    expect(mockResolveDispute).not.toHaveBeenCalled(); // RED: nothing records it without the sweep
    const out = await observeResolvedHireDisputes(makeDeps(db), NOW);
    expect(out).toMatchObject({ escrows_checked: 1, resolutions_recorded: 1, failures: 0 });
    expect(mockResolveDispute).toHaveBeenCalledWith(expect.anything(), 'esc_1', false, 'onchain_resolution_observed', { hireJobId: 'hjob1' });
  });

  it('never drives an outcome: a dispute still open on-chain — even past its deadline — is left alone', async () => {
    const db = createFakeFirestore();
    seed(db, 'disputed');
    disputedOnchain();
    const out = await observeResolvedHireDisputes(makeDeps(db), NOW + 40 * 86_400_000);
    expect(out).toMatchObject({ escrows_checked: 1, resolutions_recorded: 0, still_open: 1 });
    expect(mockResolveDispute).not.toHaveBeenCalled();
  });

  it('a hire the relay still holds as funded past auto-release, resolved on-chain, is recorded as a dispute and then settled', async () => {
    const db = createFakeFirestore();
    seed(db, 'funded');
    db.store.set('escrows/esc_1', { ...(db.store.get('escrows/esc_1') as object), auto_release_at: NOW - 1 });
    resolved();
    const out = await observeResolvedHireDisputes(makeDeps(db), NOW);
    expect(out.resolutions_recorded).toBe(1);
    expect(db.store.get('escrows/esc_1')).toMatchObject({ status: 'disputed', dispute_recorded_from_chain: true });
    expect(mockResolveDispute).toHaveBeenCalledWith(expect.anything(), 'esc_1', false, 'onchain_resolution_observed', { hireJobId: 'hjob1' });
  });

  it('an escrow that is not a hire, an unreadable chain, and a funded hire not yet due are all left alone', async () => {
    const db = createFakeFirestore();
    seed(db, 'disputed');
    db.store.delete(`${COMMONS_COLLECTIONS.HUMAN_JOBS}/hjob1`); // no job names this escrow
    resolved();
    expect(await observeResolvedHireDisputes(makeDeps(db), NOW)).toMatchObject({ escrows_checked: 0, resolutions_recorded: 0 });
    seed(db, 'disputed');
    expect(await observeResolvedHireDisputes(makeDeps(db, false), NOW)).toMatchObject({ escrows_checked: 1, unreadable: 1, resolutions_recorded: 0 });
    seed(db, 'funded');
    db.store.set('escrows/esc_1', { ...(db.store.get('escrows/esc_1') as object), auto_release_at: NOW + 1000 });
    expect(await observeResolvedHireDisputes(makeDeps(db), NOW)).toMatchObject({ escrows_checked: 0 });
    expect(mockResolveDispute).not.toHaveBeenCalled();
  });

  it('every candidate is read: a resolved hire behind a full first page of other disputes is still recorded (RED: one fixed page hid it)', async () => {
    const db = createFakeFirestore();
    seed(db, 'disputed');
    // Non-hire disputed escrows that sort BEFORE the hire and never leave the query.
    for (const id of ['esc_0a', 'esc_0b', 'esc_0c']) db.store.set(`escrows/${id}`, { escrow_id: id, status: 'disputed' });
    resolved();
    const out = await observeResolvedHireDisputes(makeDeps(db), NOW, 1);
    expect(out).toMatchObject({ escrows_checked: 1, resolutions_recorded: 1, failures: 0 });
  });
});
