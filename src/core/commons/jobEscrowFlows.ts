/**
 * jobEscrowFlows — the job screen's money steps, each "sign on-chain with your own key, then
 * tell the relay", with the relay's known lag handled in one place:
 *
 * fund → POST /fund retried while the relay waits for confirmations
 * release → releaseEscrow on-chain, then POST /complete (payment_released, or
 * payment_release_pending until the relay observes the release)
 * dispute → disputeEscrow on-chain, receipt, then POST /dispute (retried while the relay's
 * chain read still says Funded — 409 onchain_dispute_required)
 * claim → claimDisputeTimeout on-chain (permissionless), then POST /dispute/settle
 * status → POST /dispute/settle; a 409 dispute_pending is an answer (the refund date), not an error
 *
 * Dependencies are injected (defaults are the real service + signer) so each flow is unit-tested.
 * Court escalation is never offered: nothing here reaches Court.
 */
import * as CommonsService from './CommonsService';
import { withBiometricAction, type BiometricAction } from '../security/biometricAction';
import { CommonsError, type HumanJob, type JobDisputeView } from './CommonsService';
import {
  runEscrowActionOnChain,
  buildEscrowActionCall,
  type EscrowAction,
  type EscrowActionResult,
  type EscrowActionTarget,
} from '../wallet/HumanJobEscrowActions';

export interface JobEscrowDeps {
  getEscrow: (jobId: string) => Promise<EscrowActionTarget>;
  runAction: (action: EscrowAction, target: EscrowActionTarget, biometricReason: string) => Promise<EscrowActionResult>;
  complete: (jobId: string) => Promise<HumanJob>;
  fund: (jobId: string, txHash: string) => Promise<unknown>;
  fileDispute: (jobId: string, body: { reason: string; evidence?: string }) => Promise<JobDisputeView>;
  settleDispute: (jobId: string) => Promise<JobDisputeView>;
  sleep: (ms: number) => Promise<void>;
}

const realDeps = (biometricAction?: BiometricAction): JobEscrowDeps => ({
  getEscrow: (jobId) => CommonsService.getHumanJobEscrowFunding(jobId, biometricAction),
  runAction: (kind, target, reason) => runEscrowActionOnChain(kind, target, reason, biometricAction),
  complete: (jobId) => CommonsService.completeHumanJob(jobId, biometricAction),
  fund: (jobId, txHash) => CommonsService.fundHumanJobEscrow(jobId, txHash, biometricAction),
  fileDispute: (jobId, body) => CommonsService.fileJobDispute(jobId, body, biometricAction),
  settleDispute: (jobId) => CommonsService.settleJobDispute(jobId, biometricAction),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

function withDeps(overrides?: Partial<JobEscrowDeps>, biometricAction?: BiometricAction): JobEscrowDeps {
  return { ...realDeps(biometricAction), ...(overrides ?? {}) };
}

function approvedEscrowAction<T>(kind: EscrowAction, jobId: string, reason: string, overrides: Partial<JobEscrowDeps> | undefined, biometricAction: BiometricAction | undefined, fn: (deps: JobEscrowDeps, target: EscrowActionTarget) => Promise<T>): Promise<T> {
  const run = async (deps: JobEscrowDeps): Promise<T> => {
    const target = await deps.getEscrow(jobId);
    if (!overrides) buildEscrowActionCall(kind, target); // validate the authenticated record before signing
    return fn(deps, target);
  };
  if (overrides) return run(withDeps(overrides, biometricAction)); // injected signer controls its own approval
  return withBiometricAction(reason, action => run(withDeps(undefined, action)), biometricAction);
}

/** Relay waits for ~12 Base confirmations before it trusts a funding / dispute tx. */
const RELAY_LAG_RETRY_MS = 5_000;
const RELAY_LAG_MAX_TRIES = 24; // ~2 minutes

function isConfirmationLag(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /insufficient[_ ]confirmations|not enough confirmations|confirmations/i.test(msg);
}

/** Submit the fund tx, retrying while the relay waits for confirmations. */
export async function submitFundingWithRetry(jobId: string, txHash: string, overrides?: Partial<JobEscrowDeps>, biometricAction?: BiometricAction): Promise<void> {
  const d = withDeps(overrides, biometricAction);
  for (let attempt = 1; ; attempt++) {
    try {
      await d.fund(jobId, txHash);
      return;
    } catch (err) {
      if (!isConfirmationLag(err) || attempt >= RELAY_LAG_MAX_TRIES) throw err;
      await d.sleep(RELAY_LAG_RETRY_MS);
    }
  }
}

export interface ReleaseOutcome {
  job: HumanJob;
  /** The release tx, or null when the release had already happened on-chain. */
  txHash: string | null;
  /** The relay has not observed the release yet — it will update on its own. */
  pending: boolean;
}

/** Release the payment: releaseEscrow from the payer's own key, then tell the relay. */
export async function releaseJobPayment(jobId: string, biometricReason: string, overrides?: Partial<JobEscrowDeps>, biometricAction?: BiometricAction): Promise<ReleaseOutcome> {
  return approvedEscrowAction('release', jobId, biometricReason, overrides, biometricAction, async (d, target) => {
  const result = await d.runAction('release', target, biometricReason);
  const job = await d.complete(jobId);
  return {
    job,
    txHash: result.txHash,
    pending: job.status !== 'completed' && !job.payment_released,
  };
  });
}

/** Dispute: disputeEscrow from the payer's own key (receipt awaited), then record it on the relay. */
export async function disputeJob(
  jobId: string,
  body: { reason: string; evidence?: string },
  biometricReason: string,
  overrides?: Partial<JobEscrowDeps>,
  biometricAction?: BiometricAction,
): Promise<JobDisputeView> {
  const reason = body.reason.trim();
  if (reason.length === 0 || reason.length > 1000) {
    throw new Error('A dispute needs a reason of 1 to 1000 characters.');
  }
  const evidence = body.evidence?.trim();
  if (evidence && evidence.length > 2000) {
    throw new Error('Evidence can be at most 2000 characters.');
  }
  return approvedEscrowAction('dispute', jobId, biometricReason, overrides, biometricAction, async (d, target) => {
  await d.runAction('dispute', target, biometricReason);
  for (let attempt = 1; ; attempt++) {
    try {
      return await d.fileDispute(jobId, { reason, ...(evidence ? { evidence } : {}) });
    } catch (err) {
      const lagging = err instanceof CommonsError && err.status === 409 && err.code === 'onchain_dispute_required';
      if (!(lagging || isConfirmationLag(err)) || attempt >= RELAY_LAG_MAX_TRIES) throw err;
      await d.sleep(RELAY_LAG_RETRY_MS);
    }
  }
  });
}

export type DisputeStatusOutcome =
  | { kind: 'settled'; view: JobDisputeView }
  | { kind: 'pending'; refundOpensAt: number | null };

/** Ask the relay to record whatever the chain allows. A 409 dispute_pending is the answer "not yet". */
export async function checkDisputeStatus(jobId: string, overrides?: Partial<JobEscrowDeps>, biometricAction?: BiometricAction): Promise<DisputeStatusOutcome> {
  const d = withDeps(overrides, biometricAction);
  try {
    return { kind: 'settled', view: await d.settleDispute(jobId) };
  } catch (err) {
    if (err instanceof CommonsError && err.status === 409 && err.code === 'dispute_pending') {
      const at = err.details.refund_opens_at;
      return { kind: 'pending', refundOpensAt: typeof at === 'number' ? at : null };
    }
    throw err;
  }
}

/** The payer takes the refund: claimDisputeTimeout on-chain (permissionless), then record it. */
export async function claimJobRefund(jobId: string, biometricReason: string, overrides?: Partial<JobEscrowDeps>, biometricAction?: BiometricAction): Promise<DisputeStatusOutcome> {
  return approvedEscrowAction('claim_refund', jobId, biometricReason, overrides, biometricAction, async (d, target) => {
  await d.runAction('claim_refund', target, biometricReason);
  return checkDisputeStatus(jobId, d);
  });
}
