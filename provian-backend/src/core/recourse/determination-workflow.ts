import { randomUUID } from 'crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { assessRestoration, assertCheckedDetermination, prepareDetermination,
  type CheckedDetermination, type RestorationJudgment } from './determination';
import { RESTORATION_REQUESTS } from './restoration-request';
import { recourseExecutionId, RECOURSE_EXECUTIONS, cancelUnsignedRecourseCall, type RecourseExecutionCall } from './execution-transaction';

export const DETERMINATION_WORKFLOWS = 'recourse_determination_workflows_v1';
export const DETERMINATION_COORDINATION = 'recourse_determination_coordination_v1';
type Phase = 'reviewed' | 'attested' | 'reversed' | 'allocated' | 'delivered' | 'recorded' | 'declined' | 'needs_review';
interface Workflow {
  readonly request: string;
  readonly accepted: boolean;
  readonly checkpointBlock: number;
  readonly judgment: RestorationJudgment;
  readonly evidenceHash: string;
  readonly shortfall: string;
  readonly phase: Phase;
  readonly transactions: Readonly<Record<string, string>>;
  readonly pending?: { readonly id: string; readonly kind: RecourseExecutionCall['kind'] } | null;
}

/** Only an independently checked adjudication can enter the execution queue.
 * Admission and the request state change are atomic. Repeating it is harmless;
 * replacing a finding after any execution has started is forbidden. */
export async function queueDetermination(db: Firestore, value: CheckedDetermination): Promise<void> {
  assertCheckedDetermination(value);
  const ref = db.collection(DETERMINATION_WORKFLOWS).doc(value.packet.request);
  const requestRef = db.collection(RESTORATION_REQUESTS).doc(value.packet.request);
  await db.runTransaction(async tx => {
    const [prior, request, coordination] = await Promise.all([tx.get(ref), tx.get(requestRef),
      tx.get(db.collection(DETERMINATION_COORDINATION).doc('execution'))]);
    if (!request.exists || !['awaiting_determination', 'under_determination'].includes(String(request.get('status')))) {
      throw Error('recourse_determination_not_authorized');
    }
    if (prior.exists) {
      if (prior.get('evidenceHash') === value.evidenceHash) return;
      if (prior.get('phase') !== 'needs_review' || prior.get('pending')
        || (coordination.get('owner') && Number(coordination.get('expiresAtMs')) > Date.now())) throw Error('recourse_determination_already_queued');
    }
    tx.set(ref, {
      request: value.packet.request, accepted: value.accepted,
      checkpointBlock: value.packet.evidence.checkpoint.block,
      judgment: value.judgment, evidenceHash: value.evidenceHash,
      shortfall: value.accepted ? value.trace.shortfallAtomic : '0',
      phase: 'reviewed', transactions: {}, pending: null, createdAtMs: Date.now(),
    }, {merge:true});
    tx.update(requestRef, { status: 'under_determination', determinationEvidenceHash: value.evidenceHash });
  });
}

export interface DeterminationWorkflowPort {
  recheck(row: Workflow): Promise<CheckedDetermination>;
  prepare(value: CheckedDetermination, kind: 'attest' | 'reverse' | 'decline'): Promise<RecourseExecutionCall>;
  recorded(requests: readonly string[], kind: 'allocate' | 'record' | 'deliver'): Promise<RecourseExecutionCall>;
  execute(plan: RecourseExecutionCall): Promise<{ status: 'submitted' | 'confirmed' | 'reverted'; transactionHash: string }>;
  /** Null means no signed bytes were persisted; only a freshly checked plan may sign. */
  resume(id: string): Promise<{ status: 'submitted' | 'confirmed' | 'reverted'; transactionHash: string } | null>;
  record(request: string, transactions: Readonly<Record<string, string>>): Promise<void>;
  delivered?(request:string):Promise<{transactionHash:string}|null>;
}
export async function recheckQueuedDetermination(db: Firestore, row: Workflow): Promise<CheckedDetermination> {
  const packet = await prepareDetermination(db, row.request, undefined, row.checkpointBlock);
  const checked = assessRestoration(packet, row.judgment);
  if (checked.evidenceHash !== row.evidenceHash || checked.accepted !== row.accepted
    || (checked.accepted && checked.trace.shortfallAtomic !== row.shortfall)) throw Error('recourse_determination_changed');
  return checked;
}

/** One durable cohort executes its reversals before one pro-rata allocation.
 * New determinations enter the next cohort; restarts retain the exact cohort,
 * signed transactions and allocation batch. No member-facing waiting period
 * or amount threshold is introduced by this worker lease. */
export async function runDeterminationWorkflow(db: Firestore, port: DeterminationWorkflowPort): Promise<{ pending: boolean; completed: number }> {
  const worker = randomUUID(), lock = db.collection(DETERMINATION_COORDINATION).doc('execution');
  const ttl = 120_000;
  const cohort = await db.runTransaction(async tx => {
    const state = await tx.get(lock);
    if (state.get('owner') && Number(state.get('expiresAtMs')) > Date.now()) throw Error('recourse_determination_worker_busy');
    let requests = state.get('requests') as string[] | undefined;
    if (!requests?.length) {
      const rows = await tx.get(db.collection(DETERMINATION_WORKFLOWS).where('phase', 'in', ['reviewed', 'attested', 'reversed', 'allocated']));
      requests = rows.docs.map(row => row.id).sort();
    }
    tx.set(lock, { owner: worker, expiresAtMs: Date.now() + ttl, requests }, { merge: true });
    return requests;
  });
  const requireLease = async (tx: Transaction): Promise<void> => {
    const state = await tx.get(lock);
    if (state.get('owner') !== worker || Number(state.get('expiresAtMs')) <= Date.now()) throw Error('recourse_determination_lease_lost');
  };
  const renew = async (): Promise<void> => db.runTransaction(async tx => {
    await requireLease(tx); tx.update(lock, { expiresAtMs: Date.now() + ttl });
  });
  const read = async (request: string): Promise<Workflow> => {
    const doc = await db.collection(DETERMINATION_WORKFLOWS).doc(request).get();
    if (!doc.exists || doc.get('request') !== request) throw Error('recourse_determination_workflow_missing');
    return doc.data() as Workflow;
  };
  let completed = 0;
  const deferReview = async (request:string, reason:string):Promise<void> => {
    const row=await read(request);
    if(!['reviewed','attested'].includes(row.phase))throw Error('recourse_determination_completed_reversal');
    if(row.pending){
      const operation=await db.collection(RECOURSE_EXECUTIONS).doc(row.pending.id).get();
      if(operation.get('signedTransaction')!==undefined){
        if(operation.get('status')!=='reverted')throw Error('recourse_execution_signed_pending');
      }else await cancelUnsignedRecourseCall(db,row.pending.id);
    }
    await db.runTransaction(async tx=>{
      await requireLease(tx);
      tx.update(db.collection(DETERMINATION_WORKFLOWS).doc(request),{
        phase:'needs_review',pending:null,reviewReason:reason,
        previousExecution:row.pending??null,previousTransactions:row.transactions,
      });
    });
  };
  const step = async (requests: readonly string[], kind: RecourseExecutionCall['kind'], next: Phase,
    prepare: () => Promise<RecourseExecutionCall>): Promise<boolean> => {
    await renew();
    const rows = await Promise.all(requests.map(read));
    const pending = rows[0].pending;
    if (rows.some(row => JSON.stringify(row.pending ?? null) !== JSON.stringify(pending ?? null))) throw Error('recourse_determination_batch_changed');
    if (pending && pending.kind !== kind) throw Error('recourse_determination_phase_invalid');
    let result = pending ? await port.resume(pending.id) : null;
    if (!result) {
      // No signed bytes exist: release the old reservation before deriving a
      // fresh capability at today's canonical preparation block.
      if(pending)await cancelUnsignedRecourseCall(db,pending.id);
      const plan = await prepare(), id = recourseExecutionId(plan);
      if (plan.kind !== kind) throw Error('recourse_determination_plan_changed');
      await db.runTransaction(async tx => {
        await requireLease(tx);
        for (const request of requests) tx.update(db.collection(DETERMINATION_WORKFLOWS).doc(request), { pending: { id, kind } });
      });
      result = await port.execute(plan);
    }
    if (result.status === 'submitted') return false;
    if (result.status === 'reverted') {
      if(['allocate','record','deliver'].includes(kind)){
        // The reversal is final and must not be repeated or repriced. A fresh
        // pool attempt derives its amounts from that recorded on-chain result.
        await db.runTransaction(async tx=>{
          await requireLease(tx);
          for(const request of requests)tx.update(db.collection(DETERMINATION_WORKFLOWS).doc(request),{
            pending:null,lastRevertedTransaction:result!.transactionHash,
          });
        });
        return false;
      }
      throw Error('recourse_determination_transaction_reverted');
    }
    const transactionHash = result.transactionHash;
    await db.runTransaction(async tx => {
      await requireLease(tx);
      for (const row of rows) tx.update(db.collection(DETERMINATION_WORKFLOWS).doc(row.request), {
        phase: next, pending: null, transactions: { ...row.transactions, [kind]: transactionHash },
      });
    });
    return true;
  };
  try {
    for (const request of cohort) {
      try {
      let row = await read(request);
      if (row.phase === 'reviewed') {
        const kind = row.accepted ? 'attest' : 'decline';
        if (!await step([request], kind, row.accepted ? 'attested' : 'declined', async () => port.prepare(await port.recheck(row), kind))) return { pending: true, completed };
        row = await read(request);
      }
      if (row.phase === 'attested') {
        if (!await step([request], 'reverse', 'reversed', async () => port.prepare(await port.recheck(row), 'reverse'))) return { pending: true, completed };
      }
      } catch(error) {
        const refreshable=['recourse_execution_stale','recourse_execution_retired','recourse_determination_changed',
          'recourse_determination_judgment_invalid','recourse_determination_transaction_reverted'];
        if(!(error instanceof Error)||!refreshable.includes(error.message))throw error;
        await deferReview(request,error.message);
      }
    }
    const ready = await Promise.all(cohort.map(read));
    const allocations = ready.filter(row => row.phase === 'reversed' && row.shortfall !== '0').map(row => row.request);
    if (allocations.length && !await step(allocations, 'allocate', 'allocated', () => port.recorded(allocations, 'allocate'))) return { pending: true, completed };
    for (const request of cohort) {
      let row = await read(request);
      if (row.phase === 'reversed') {
        if (!await step([request], 'record', 'delivered', () => port.recorded([request], 'record'))) return { pending: true, completed };
        row = await read(request);
      }
      if (row.phase === 'allocated') {
        const external=!row.pending&&port.delivered?await port.delivered(request):null;
        if(external){
          await db.runTransaction(async tx=>{
            await requireLease(tx);
            tx.update(db.collection(DETERMINATION_WORKFLOWS).doc(request),{
              phase:'delivered',transactions:{...row.transactions,deliver:external.transactionHash},
            });
          });
        }else if (!await step([request], 'deliver', 'delivered', () => port.recorded([request], 'deliver'))) return { pending: true, completed };
        row = await read(request);
      }
    }
    // Money execution is complete even when a member has not yet published a
    // mailbox key. Keep that PE pending separately so it cannot freeze others.
    await db.runTransaction(async tx => { await requireLease(tx); tx.update(lock, { requests: [] }); });
    const outcomes=await db.collection(DETERMINATION_WORKFLOWS).where('phase','in',['delivered','declined']).get();
    let pending=false;
    for(const document of outcomes.docs){
        const row=await read(document.id),request=row.request;
        await renew();
        try { await port.record(request, row.transactions); }
        catch(error){
          if(!(error instanceof Error)||error.message!=='relay_act_owner_message_key_required')throw error;
          pending=true;continue;
        }
        await db.runTransaction(async tx => {
          await requireLease(tx);
          tx.update(db.collection(DETERMINATION_WORKFLOWS).doc(request), { phase: 'recorded' });
          tx.update(db.collection(RESTORATION_REQUESTS).doc(request), { status: row.accepted ? 'restored' : 'declined' });
        });
        completed++;
    }
    return { pending, completed };
  } finally {
    await db.runTransaction(async tx => {
      const current = await tx.get(lock);
      if (current.get('owner') === worker) tx.update(lock, { owner: null, expiresAtMs: 0 });
    });
  }
}
