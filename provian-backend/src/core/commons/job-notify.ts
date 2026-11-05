/**
 * tell the other party of a Commons hire that something happened, on the surface that
 * party already reads: an agent through its inbox + webhook (the agent-bank event outbox,
 * `commons_job_*` events), a person through push (never content — only the job id and the step).
 *
 * Best-effort BY DESIGN: the step itself (application, hire, funding, delivery, release,
 * dispute) is already committed when this runs, so a notification failure is logged and never
 * turns a committed step into an error. The parties can always read the job's state directly.
 */

import type { AgentBankDeps } from '../agent-bank/types';
import { enqueueAgentBankEvent } from '../agent-bank/event-outbox';
import { sendPushToUser } from '../notifications/pushDispatcher';
import { isAgentPartyId } from './speech-window';

export type CommonsJobEvent =
  | 'applied'
  | 'hired'
  | 'funded'
  | 'delivered'
  | 'released'
  | 'disputed'
  | 'dispute_settled'
  // The hire was never funded and can no longer be: the job is open again.
  | 'hire_lapsed';

const PUSH_TITLES: Record<CommonsJobEvent, string> = {
  applied: 'New application',
  hired: 'You were hired',
  funded: 'Payment is in escrow',
  delivered: 'Work delivered',
  released: 'Payment released',
  disputed: 'A payment was disputed',
  dispute_settled: 'A dispute was settled',
  hire_lapsed: 'A hire was never funded',
};

export async function notifyJobCounterparty(
  deps: Pick<AgentBankDeps, 'db'>,
  input: { actorId: string; counterpartyId: string | null | undefined; jobId: string; event: CommonsJobEvent; title?: string },
): Promise<void> {
  const counterparty = input.counterpartyId;
  if (!counterparty || counterparty === input.actorId) return;
  try {
    if (isAgentPartyId(counterparty)) {
      await enqueueAgentBankEvent(deps.db as unknown as FirebaseFirestore.Firestore, {
        walletId: input.actorId,
        eventType: `commons_job_${input.event}`,
        transactionAmount: 0,
        amountUnit: 'pvt_whole',
        recipients: [counterparty],
        entityId: input.jobId,
        entityType: 'commons_job',
        counterparties: { [counterparty]: input.actorId },
        data: { job_id: input.jobId, step: input.event, ...(input.title ? { title: input.title } : {}) },
        notifyOnly: true,
      });
    } else {
      await sendPushToUser(deps.db as unknown as FirebaseFirestore.Firestore, counterparty, {
        title: PUSH_TITLES[input.event],
        body: 'Open the job in Provian to see it.',
        data: { type: 'commons_job', job_id: input.jobId, step: input.event },
      });
    }
  } catch (err) {
    console.error(`[CommonsJobs] notify ${input.event} failed (step is committed):`, err);
  }
}
