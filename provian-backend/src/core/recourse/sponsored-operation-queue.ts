import { matchesPlannedCall } from '../onchain/builder-code';
import { laneQueuedFields, laneHoldsOperation } from './transaction-lane';
import { Transaction, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../pvt/settlement/durable-settlement-store';
import type { SponsoredOperationAdapter, SponsoredOperationPlan } from './sponsored-operation-worker';

export interface SponsoredOperationStatus { readonly id: string; readonly status: 'queued' | 'submitted' | 'confirmed' | 'failed'; readonly transactionHash: string | null; }
export async function readSponsoredOperation(db: Firestore, collection: string, id: string): Promise<SponsoredOperationStatus> {
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw Error('recourse_sponsor_invalid');
  const row = await db.collection(collection).doc(id).get();
  const status: unknown = row.get('status'), hash: unknown = row.get('transactionHash');
  if (!row.exists || !['queued','submitted','confirmed','failed'].includes(String(status))
    || (hash !== null && (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(hash)))) throw Error('recourse_sponsor_unknown');
  return { id, status: status as SponsoredOperationStatus['status'], transactionHash: hash as string | null };
}
/** A finalized revert may retry the same logical operation. Preserve its prior
 * signed bytes and never replace a transaction whose nonce is unresolved. */
export async function queueSponsoredOperation<R, P extends SponsoredOperationPlan & { readonly manifestHash: string }>(db: Firestore,
  value: unknown, adapter: SponsoredOperationAdapter<R, P>): Promise<SponsoredOperationStatus> {
  const request = adapter.parse(value), id = adapter.id(request), ref = db.collection(adapter.collection).doc(id);
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw Error('recourse_sponsor_invalid');
  const prior = await ref.get();
  if (prior.exists && prior.get('status') !== 'failed') return readSponsoredOperation(db, adapter.collection, id);
  const oldRaw: unknown = prior.get('signedTransaction');
  let oldSigner: string | null = null;
  if (oldRaw !== undefined) {
    if (typeof oldRaw !== 'string' || keccak256(oldRaw) !== prior.get('transactionHash')) throw Error('recourse_sponsor_record_invalid');
    const old = adapter.parse(prior.get('request')), tx = Transaction.from(oldRaw);
    if (adapter.id(old) !== id || !tx.from || tx.from.toLowerCase() !== prior.get('gasPayer') || tx.chainId !== 8453n
      || tx.to?.toLowerCase() !== adapter.target(old, prior.get('executor')) || !matchesPlannedCall(tx.data, adapter.calldata(old)) || tx.value !== 0n) throw Error('recourse_sponsor_record_invalid');
    const result = await adapter.finalized(oldRaw);
    if (!result || result.status !== 0) throw Error('recourse_sponsor_retry_unreconciled');
    oldSigner = tx.from.toLowerCase();
  }
  const plan = await adapter.check(request); adapter.assert(plan);
  if (plan.id !== id || plan.executor !== adapter.target(request, plan.executor) || plan.calldata !== adapter.calldata(request)) throw Error('recourse_sponsor_plan_mismatch');
  const accepted = await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (current.exists && current.get('status') !== 'failed') return;
    if (current.get('signedTransaction') !== oldRaw) throw Error('recourse_sponsor_record_changed');
    const archiveRef = oldRaw === undefined ? null : db.collection(`${adapter.collection}_attempts`).doc(`${id}_${keccak256(String(oldRaw))}`);
    const archive = archiveRef ? await tx.get(archiveRef) : null;
    if (oldSigner !== null && ((await tx.get(db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(oldSigner))).get('pending_operation') === id
      || await laneHoldsOperation(tx, db, oldSigner, adapter.collection, id))) throw Error('recourse_sponsor_retry_unreconciled');
    const existing = await adapter.beforeQueue?.(tx, request);
    if (existing !== undefined) return existing;
    if (archiveRef && !archive?.exists) tx.create(archiveRef, { operation: id, signedTransaction: oldRaw,
      transactionHash: keccak256(String(oldRaw)), status: 'finalized_revert', archivedAtMs: Date.now() });
    tx.set(ref, { request, executor: plan.executor, gasPayer: plan.gasPayer, manifestHash: plan.manifestHash,
      status: adapter.satisfied(plan) ? 'confirmed' : 'queued', transactionHash: null, createdAtMs: Date.now(),
      ...(adapter.lane && !adapter.satisfied(plan) ? laneQueuedFields(Date.now(), id) : {}) });
  });
  return readSponsoredOperation(db, adapter.collection, accepted ?? id);
}
