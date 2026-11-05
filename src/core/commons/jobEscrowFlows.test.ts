/**
 * the job screen's money flows (release, dispute, claim, status). Dependencies are injected,
 * so each flow is exercised end to end without a chain or a relay. RED controls: a bad dispute reason
 * never reaches the chain; a non-lag refusal is not retried; Court is never involved.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommonsError, type HumanJob, type JobDisputeView } from './CommonsService';
import {
  releaseJobPayment,
  disputeJob,
  checkDisputeStatus,
  claimJobRefund,
  submitFundingWithRetry,
  type JobEscrowDeps,
} from './jobEscrowFlows';
import type { EscrowActionTarget } from '../wallet/HumanJobEscrowActions';

const TARGET: EscrowActionTarget = {
  contract_address: '0x96560fDF49e563eFCdc2d502934676DC074732d0',
  onchain_escrow_id: '0x' + 'cd'.repeat(32),
  chain: 'base',
  depositor_address: '0x1111111111111111111111111111111111111111',
};

function job(overrides: Partial<HumanJob> = {}): HumanJob {
  return {
    job_id: 'hjob_1', poster_wallet_id: 'user_a', title: 'T', description: 'D', category: 'other', skills_required: [],
    location: { type: 'remote' }, compensation_type: 'fixed', status: 'completed', applicant_count: 1, posted_at: 1,
    payment_released: true, ...overrides,
  };
}

function view(overrides: Partial<JobDisputeView> = {}): JobDisputeView {
  return {
    job_id: 'hjob_1', escrow_id: 'esc_1', escrow_status: 'disputed', currency: 'usdc', disputed_at: 1, dispute_reason: 'late',
    resolution: null, resolution_tx_hash: null, onchain_status: 'disputed', refund_opens_at: 2_000, refund_claimable: false,
    court_escalation_available: false, onchain_escrow_id: TARGET.onchain_escrow_id ?? null, ...overrides,
  };
}

function deps(overrides: Partial<JobEscrowDeps> = {}): JobEscrowDeps {
  return {
    getEscrow: vi.fn(async () => TARGET),
    runAction: vi.fn(async () => ({ txHash: '0xabc', alreadyDone: false, onchainEscrowId: TARGET.onchain_escrow_id as string })),
    complete: vi.fn(async () => job()),
    fund: vi.fn(async () => undefined),
    fileDispute: vi.fn(async () => view()),
    settleDispute: vi.fn(async () => view({ resolution: 'refund_to_depositor', escrow_status: 'resolved' })),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('releaseJobPayment — sign releaseEscrow, then /complete', () => {
  it('signs the release on-chain FIRST, then tells the relay', async () => {
    const order: string[] = [];
    const d = deps({
      runAction: vi.fn(async (action) => { order.push(`chain:${action}`); return { txHash: '0xabc', alreadyDone: false, onchainEscrowId: 'x' }; }),
      complete: vi.fn(async () => { order.push('relay:complete'); return job(); }),
    });
    const out = await releaseJobPayment('hjob_1', 'why', d);
    expect(order).toEqual(['chain:release', 'relay:complete']);
    expect(out).toMatchObject({ txHash: '0xabc', pending: false });
  });

  it('reports payment_release_pending plainly when the relay has not observed the release yet', async () => {
    const d = deps({ complete: vi.fn(async () => job({ status: 'in_progress', payment_released: false, payment_release_pending: true })) });
    const out = await releaseJobPayment('hjob_1', 'why', d);
    expect(out.pending).toBe(true);
  });

  it('RED: a refused on-chain release never reaches /complete', async () => {
    const d = deps({ runAction: vi.fn(async () => { throw new Error('not funded'); }) });
    await expect(releaseJobPayment('hjob_1', 'why', d)).rejects.toThrow(/not funded/);
    expect(d.complete).not.toHaveBeenCalled();
  });
});

describe('disputeJob — sign disputeEscrow, wait, then /dispute', () => {
  it('files the dispute after the on-chain act, retrying while the relay still reads Funded (409 onchain_dispute_required)', async () => {
    let calls = 0;
    const d = deps({
      fileDispute: vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new CommonsError('not disputed on-chain yet', 409, undefined, undefined, 'onchain_dispute_required');
        return view();
      }),
    });
    const out = await disputeJob('hjob_1', { reason: '  work never arrived  ', evidence: '' }, 'why', d);
    expect(d.runAction).toHaveBeenCalledWith('dispute', TARGET, 'why');
    expect(d.fileDispute).toHaveBeenCalledTimes(3);
    expect(d.fileDispute).toHaveBeenLastCalledWith('hjob_1', { reason: 'work never arrived' });
    expect(out.court_escalation_available).toBe(false);
  });

  it('RED: an empty reason is refused before ANY on-chain act', async () => {
    const d = deps();
    await expect(disputeJob('hjob_1', { reason: '   ' }, 'why', d)).rejects.toThrow(/reason/);
    expect(d.getEscrow).not.toHaveBeenCalled();
    expect(d.runAction).not.toHaveBeenCalled();
  });

  it('RED: a non-lag refusal (403) is not retried', async () => {
    const d = deps({ fileDispute: vi.fn(async () => { throw new CommonsError('Only the payer', 403); }) });
    await expect(disputeJob('hjob_1', { reason: 'x' }, 'why', d)).rejects.toThrow(/Only the payer/);
    expect(d.fileDispute).toHaveBeenCalledTimes(1);
  });
});

describe('checkDisputeStatus / claimJobRefund', () => {
  it('a 409 dispute_pending is an answer (the refund date), not an error', async () => {
    const d = deps({ settleDispute: vi.fn(async () => { throw new CommonsError('pending', 409, undefined, undefined, 'dispute_pending', { refund_opens_at: 1_900_000_000_000 }); }) });
    await expect(checkDisputeStatus('hjob_1', d)).resolves.toEqual({ kind: 'pending', refundOpensAt: 1_900_000_000_000 });
  });

  it('RED: any other refusal still throws', async () => {
    const d = deps({ settleDispute: vi.fn(async () => { throw new CommonsError('boom', 500); }) });
    await expect(checkDisputeStatus('hjob_1', d)).rejects.toThrow(/boom/);
  });

  it('claim signs claimDisputeTimeout, then records the refund', async () => {
    const d = deps();
    const out = await claimJobRefund('hjob_1', 'why', d);
    expect(d.runAction).toHaveBeenCalledWith('claim_refund', TARGET, 'why');
    expect(out).toMatchObject({ kind: 'settled', view: { resolution: 'refund_to_depositor' } });
  });
});

describe('submitFundingWithRetry', () => {
  it('retries while the relay waits for confirmations, then succeeds', async () => {
    let n = 0;
    const d = deps({ fund: vi.fn(async () => { n += 1; if (n < 2) throw new Error('insufficient_confirmations'); }) });
    await submitFundingWithRetry('hjob_1', '0xfund', d);
    expect(d.fund).toHaveBeenCalledTimes(2);
  });

  it('RED: a real rejection (wrong depositor) is not retried', async () => {
    const d = deps({ fund: vi.fn(async () => { throw new Error('transfer is not from the depositor'); }) });
    await expect(submitFundingWithRetry('hjob_1', '0xfund', d)).rejects.toThrow(/depositor/);
    expect(d.fund).toHaveBeenCalledTimes(1);
  });
});
