import { Interface, Transaction, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { getAgreedBaseLogs, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { advanceRelayAct, priceRelayAct, readRelayActIntake } from '../meter/meter-relay-authored';
import { finalizedOwnerTransaction } from './transaction-finality';
import { RECOURSE_EXECUTIONS, recourseExecutionId, type RecourseExecutionCall } from './execution-transaction';
import { DETERMINATION_WORKFLOWS } from './determination-workflow';
import { RECOURSE_COLLECTIONS } from './ownership';
import { RESTORATION_REQUESTS } from './restoration-request';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { findPoolWithdrawal } from './pool-withdrawal';

const reversal = new Interface(['event TheftReversed(bytes32 indexed request,bytes32 indexed identity,address indexed destination,uint256 amount,bytes32 evidenceHash)']);
export interface OutcomeReceiptPort {
  finalized: typeof finalizedOwnerTransaction;
  logs: typeof getAgreedBaseLogs;
}
const productionPort: OutcomeReceiptPort = { finalized: finalizedOwnerTransaction, logs: getAgreedBaseLogs };

/** Build the owner's result from finalized canonical events, not from the
 * requested amounts, the operator's intent, or a successful broadcast alone. */
export async function readDeterminationOutcome(db: Firestore, request: string,
  transactions: Readonly<Record<string, string>>, port: OutcomeReceiptPort = productionPort) {
  const [workflow, submitted] = await Promise.all([
    db.collection(DETERMINATION_WORKFLOWS).doc(request).get(),
    db.collection(RESTORATION_REQUESTS).doc(request).get(),
  ]);
  if (!workflow.exists || !submitted.exists || !['delivered', 'declined', 'recorded'].includes(String(workflow.get('phase')))
    || JSON.stringify(workflow.get('transactions')) !== JSON.stringify(transactions)) throw Error('recourse_outcome_not_completed');
  const identity: unknown = submitted.get('identity'), evidenceHash: unknown = workflow.get('evidenceHash');
  if (typeof identity !== 'string' || typeof evidenceHash !== 'string') throw Error('recourse_outcome_record_invalid');
  const accepted = workflow.get('accepted') === true;
  const finalKind = accepted ? (workflow.get('shortfall') === '0' ? 'record' : 'allocate') : 'decline';
  if (!transactions[finalKind] || (accepted && !transactions.reverse)
    || (accepted && finalKind === 'allocate' && !transactions.deliver)) throw Error('recourse_outcome_transactions_missing');
  const events: { kind: string; log: CanonicalEconomicLog }[] = [];
  for (const [kind, transactionHash] of Object.entries(transactions)) {
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) throw Error('recourse_outcome_transaction_invalid');
    const rows = await db.collection(RECOURSE_EXECUTIONS).where('transactionHash', '==', transactionHash).get();
    if(rows.empty && kind==='deliver'){
      const external=await findPoolWithdrawal(db,request);
      if(!external||external.transactionHash!==transactionHash)throw Error('recourse_outcome_external_withdrawal_invalid');
      events.push({kind,log:external});continue;
    }
    if (rows.size !== 1) throw Error('recourse_outcome_transaction_missing');
    const row = rows.docs[0], raw: unknown = row.get('signedTransaction'), plan = row.get('plan') as RecourseExecutionCall;
    if (typeof raw !== 'string' || !plan || plan.kind !== kind || row.id !== recourseExecutionId(plan)
      || row.get('status') !== 'confirmed' || keccak256(raw) !== transactionHash) throw Error('recourse_outcome_transaction_invalid');
    const tx = Transaction.from(raw);
    if (tx.to?.toLowerCase() !== plan.executor || tx.from?.toLowerCase() !== plan.signer || tx.data !== plan.calldata
      || tx.value !== 0n || tx.chainId !== 8453n) throw Error('recourse_outcome_transaction_invalid');
    const receipt = await port.finalized(raw);
    if (!receipt || receipt.status !== 1 || receipt.transactionHash !== transactionHash) throw Error('recourse_outcome_not_finalized');
    const logs = await port.logs({ address: plan.executor, topics: [], fromBlock: receipt.block, toBlock: receipt.block });
    for (const log of logs) {
      if (log.transactionHash !== transactionHash) continue;
      if (log.removed || log.blockHash !== receipt.blockHash || log.address !== plan.executor) throw Error('recourse_outcome_receipt_changed');
      events.push({ kind, log });
    }
  }
  const one = (kind: string, abi: Interface, name: string) => {
    const matches = events.filter(event => event.kind === kind).map(event => {
      try { return { event, decoded: abi.parseLog({topics:[...event.log.topics],data:event.log.data}) }; } catch { return null; }
    }).filter(value => value?.decoded?.name === name && value.decoded.args.request === request);
    if (matches.length !== 1 || !matches[0]?.decoded) throw Error('recourse_outcome_event_missing');
    return matches[0];
  };
  const determination = one(finalKind, RECOURSE_POOL_ABI, 'RestorationDetermined');
  const d = determination.decoded!.args;
  if (d.identity !== identity || d.evidenceHash !== evidenceHash || d.accepted !== accepted
    || d.occurrence !== request || String(d.shortfall) !== workflow.get('shortfall')) throw Error('recourse_outcome_determination_mismatch');
  let reversedAtomic = '0', assignedAtomic = '0', reversalDestination: string | null = null, poolDestination: string | null = null;
  if (accepted) {
    const r = one('reverse', reversal, 'TheftReversed').decoded!.args;
    if (r.identity !== identity || r.evidenceHash !== evidenceHash) throw Error('recourse_outcome_reversal_mismatch');
    reversedAtomic = String(r.amount); reversalDestination = String(r.destination).toLowerCase();
    if (finalKind === 'allocate') {
      const a = one('allocate', RECOURSE_POOL_ABI, 'RestorationAllocated').decoded!.args;
      const w = one('deliver', RECOURSE_POOL_ABI, 'RestorationWithdrawn').decoded!.args;
      if (a.identity !== identity || a.requested !== d.shortfall || a.assigned > a.requested || w.amount !== a.assigned) throw Error('recourse_outcome_allocation_mismatch');
      assignedAtomic = String(a.assigned);
      // A later independently authorized owner recovery can change the final
      // reserve destination. Record the actual event rather than the old key.
      poolDestination = String(w.destination).toLowerCase();
    }
  }
  return { request, identity, accepted, evidenceHash, reversedAtomic, shortfallAtomic: String(d.shortfall),
    assignedAtomic, reversalDestination, poolDestination, determinationRevision: String(d.revision),
    transactions, determinationBlock: determination.event.log.blockNumber,
    determinationBlockHash: determination.event.log.blockHash };
}

/** The chain advance, ciphertext intake and idempotency marker commit together.
 * A missing owner message key leaves durable work for retry, never a lost PE.
 * After delivery the relay retains hashes and the determination record only. */
export async function recordDeterminationOutcome(db: Firestore, request: string,
  transactions: Readonly<Record<string, string>>): Promise<void> {
  const ref = db.collection(DETERMINATION_WORKFLOWS).doc(request);
  const peId = `recourse_determination_${request.slice(2)}`;
  if ((await ref.get()).get('outcomePeHash')) {
    const intake = await readRelayActIntake(db, peId);
    if (intake) await priceRelayAct(db, intake);
    return;
  }
  const outcome = await readDeterminationOutcome(db, request, transactions);
  const owner = await db.collection(RECOURSE_COLLECTIONS.identities).doc(outcome.identity).get();
  const ownerType: unknown = owner.get('ownerType'), actorId: unknown = owner.get('ownerId'), walletId: unknown = owner.get('walletId');
  if (!owner.exists || !['human', 'agent'].includes(String(ownerType)) || typeof actorId !== 'string' || typeof walletId !== 'string') throw Error('recourse_outcome_owner_missing');
  const type = ownerType as 'human' | 'agent', timestamp = Date.now();
  try {
    const advanced = await advanceRelayAct(db, {
      actorId, walletId, ownerType: type, requiredRecipient: `${type}:${actorId}`,
      peId, timestamp, actionType: 'recourse_determination',
      content: { owner_id: actorId, wallet_id: walletId, witness: 'base_finalized', outcome },
      accrual: peHash => ({ peId, userId: actorId, actionType: 'recourse_determination', integrationSource: 'recourse_chain',
        attestationDepth: 'software_verified', peHash, timestamp, ownerType: type, throwOnError: true }),
      atomicPrecondition: async tx => {
        const row = await tx.get(ref);
        if (row.get('outcomePeHash')) throw Error('recourse_outcome_already_recorded');
        if (JSON.stringify(row.get('transactions')) !== JSON.stringify(transactions)) throw Error('recourse_outcome_record_changed');
      },
      atomicCoWrite: (tx, context) => tx.update(ref, { outcomePeId: peId, outcomePeHash: context.peHash }),
    });
    await priceRelayAct(db, advanced.intake);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'recourse_outcome_already_recorded') throw error;
    const intake = await readRelayActIntake(db, peId);
    if (intake) await priceRelayAct(db, intake);
  }
}
