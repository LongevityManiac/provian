import type { Firestore } from 'firebase-admin/firestore';
import { getAgreedBaseLogs } from '../onchain/economic-discovery';
import { PRIVATE_ISSUANCE_ADDRESSES, PRIVATE_ISSUANCE_BATCHES } from './issuance-lock';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { membershipJournalHash as hash, checkMembershipJournalEntry, PRIVATE_MEMBERSHIP_JOURNAL as J, type MembershipJournalEntry } from './private-membership-journal';
import { readIssuanceSuccession, assertIssuanceSuccession } from './issuance-succession-proof';
import { commitPrivateIssuanceBatch, privateIssuanceReceiptEffects, type PrivateIssuanceBatchRecord } from './private-issuance-batch';
import { MEMBERSHIP_RECEIPT_ABI, readMembershipReceipt, type VerifiedMembershipReceipt } from './membership-receipt';
import { readPrivateCalendarRules } from './private-calendar-rules';

const fail = (reason: string): never => { throw Error(`recourse_issuance_succession_${reason}`); };
/** Reconcile the whole batch before any owner's calendar crosses its cutoff.
 * This never releases the parent's settlement claims or gas nonce. */
export async function reconcilePrivateIssuanceSuccession(db: Firestore, id: string): Promise<'current' | 'committed' | 'cancelled' | 'superseded'> {
  if (!/^0x[0-9a-f]{64}$/.test(id)) return fail('id');
  const ref = db.collection(PRIVATE_ISSUANCE_BATCHES).doc(id), row = await ref.get();
  if (!row.exists) return fail('missing');
  const initial = row.data() as PrivateIssuanceBatchRecord, batch = initial.batch;
  if (batch.id !== id) return fail('id');
  if (initial.status === 'committed' || initial.status === 'cancelled' || initial.status === 'superseded') return initial.status;
  const proof = await readIssuanceSuccession(batch.domain,batch.context.batchId);
  if (!proof) return 'current';
  assertIssuanceSuccession(proof);
  if (batch.domain.pointer !== proof.pointer) return fail('pointer');
  if (proof.settled || proof.cancelled) {
    const transactions = new Set<string>();
    const topics = ['IssuanceTicketConsumed','IssuanceBatchCancelled'].map(n => MEMBERSHIP_RECEIPT_ABI.getEvent(n)!.topicHash);
    for (let start = batch.checkpoint.block + 1; start <= proof.cutoff.block; start += 500) {
      const end = Math.min(start+499,proof.cutoff.block);
      for (const log of await getAgreedBaseLogs({ address:batch.domain.pool, topics:[topics,batch.context.batchId], fromBlock:start,toBlock:end })) {
        if (log.removed || log.address !== batch.domain.pool || log.blockNumber < start || log.blockNumber > end) return fail('log');
        const event = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics:[...log.topics],data:log.data });
        if (!event || event.args.batchId !== batch.context.batchId) return fail('log');
        transactions.add(log.transactionHash);
      }
    }
    if (transactions.size !== 1) return fail('receipt_missing');
    const receipt = await readMembershipReceipt([...transactions][0],batch.domain.pool);
    if (receipt.block <= batch.checkpoint.block || receipt.block > proof.cutoff.block) return fail('receipt_range');
    if (privateIssuanceReceiptEffects(batch,receipt).status !== (proof.settled ? 'committed' : 'cancelled')) return fail('receipt_state');
    const rules = batch.reservations.length > 0
      ? await readPrivateCalendarRules(db,{ pool:batch.domain.pool,block:receipt.block,blockHash:receipt.blockHash })
      : () => fail('unexpected_invoice');
    const status = await commitPrivateIssuanceBatch(db,id,receipt,rules);
    if (status !== (proof.settled ? 'committed' : 'cancelled')) return fail('receipt_state');
    return status;
  }
  return db.runTransaction(async tx => {
    const currentRow = await tx.get(ref), current = currentRow.data() as PrivateIssuanceBatchRecord;
    if (!currentRow.exists || hash(current) !== hash(initial)) return fail('concurrent');
    const fences = await Promise.all(batch.tickets.map(t => tx.get(db.collection(PRIVATE_ISSUANCE_ADDRESSES).doc(t.account))));
    if (fences.some(f => f.get('batchId') !== id)) return fail('fence');
    const pending: { account:PrivateMembershipAccount; reservationId:string }[] = [];
    for (const reservation of batch.reservations) {
      const [retained,owner] = await Promise.all([tx.get(db.collection(C.reservations).doc(reservation.id)),tx.get(db.collection(C.owners).doc(reservation.ownerIdentity))]);
      if (!retained.exists || !owner.exists || hash(retained.get('reservation')) !== hash(reservation)
        || retained.get('issuanceBatchId') !== id || owner.get('ownerIdentity') !== reservation.ownerIdentity) return fail('reservation');
      const account = owner.data() as PrivateMembershipAccount, status: unknown = retained.get('status');
      if (status === 'pending') {
        if (account.pendingReservation !== reservation.id || !Number.isSafeInteger(account.version + 1)) return fail('reservation');
        pending.push({ account,reservationId:reservation.id });
      } else if (status === 'committed' || status === 'cancelled') {
        // A receipt on a discarded branch remains audit evidence. Its calendar
        // is rolled back by the normal membership bridge, never credited here.
        const transactionHash: unknown = retained.get('transactionHash');
        if (typeof transactionHash !== 'string' || !proof.afterBreak) return fail('reservation');
        const evidence = await tx.get(db.collection(C.receipts).doc(hash([reservation.ownerIdentity,reservation.id,transactionHash])));
        const receipt = evidence.get('receipt') as VerifiedMembershipReceipt | undefined;
        if (!evidence.exists || evidence.get('status') !== status || !receipt || evidence.get('receiptHash') !== hash(receipt)
          || receipt.transactionHash !== transactionHash || receipt.block <= proof.cutoff.block || account.pendingReservation === reservation.id) return fail('reservation');
      } else if (status === 'superseded') {
        // An owner may already have crossed this exact boundary on an earlier
        // retry. Retain its branch and clear only the still-pending batch fences.
        const head: unknown = retained.get('successionHead');
        if (typeof head !== 'string') return fail('reservation');
        const entryRow = await tx.get(db.collection(J).doc(head)), entry = entryRow.data() as MembershipJournalEntry;
        if (!entryRow.exists) return fail('reservation');
        checkMembershipJournalEntry(entry);
        if (entry.ownerIdentity !== reservation.ownerIdentity || entry.kind !== 'succession'
          || entry.succession?.cutoff.kernel !== proof.cutoff.kernel || entry.succession.cutoff.pool !== proof.cutoff.pool
          || entry.succession.cutoff.block !== proof.cutoff.block || entry.succession.cutoff.blockHash !== proof.cutoff.blockHash
          || account.pendingReservation === reservation.id) return fail('reservation');
      } else return fail('reservation');
    }
    for (const item of pending) {
      tx.update(db.collection(C.reservations).doc(item.reservationId),{ status:'superseded',issuanceSuccession:hash(proof) });
      tx.update(db.collection(C.owners).doc(item.account.ownerIdentity),{ pendingReservation:null,version:item.account.version+1,needsScan:true });
    }
    for (const ticket of batch.tickets) tx.update(db.collection(PRIVATE_ISSUANCE_ADDRESSES).doc(ticket.account),{ batchId:null });
    tx.update(ref,{ status:'superseded',succession:proof });
    return 'superseded' as const;
  });
}

/** Reads only relay-private locks. No grouping is sent to the chain or public API. */
export async function reconcileAddressIssuance(db: Firestore, addresses: readonly string[]): Promise<void> {
  const ids = new Set<string>();
  for (const address of addresses) {
    if (!/^0x[0-9a-f]{40}$/.test(address)) return fail('address');
    const fence = await db.collection(PRIVATE_ISSUANCE_ADDRESSES).doc(address).get(), id: unknown = fence.get('batchId');
    if (id == null) continue;
    if (typeof id !== 'string') return fail('fence'); ids.add(id);
  }
  for (const id of ids) await reconcilePrivateIssuanceSuccession(db,id);
}
