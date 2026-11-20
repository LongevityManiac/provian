import type { Firestore } from 'firebase-admin/firestore';
import { readMembershipLogWindows } from './membership-log-windows';
import { MEMBERSHIP_RECEIPT_ABI, readMembershipReceipt, assertMembershipReceipt, type VerifiedMembershipReceipt } from './membership-receipt';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, commitPrivateMembershipReceipt, type PrivateMembershipReservation } from './private-membership-reservation';
import { PRIVATE_MEMBERSHIP_TRANSITIONS as T, recordPrivateMembershipConsent, type PrivateMembershipTransition } from './private-membership-transition';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { readPrivateCalendarRules } from './private-calendar-rules';
import type { MembershipDomainCheckpoint } from './membership-succession-checkpoint';
import { PRIVATE_ISSUANCE_BATCHES } from './issuance-lock';
import { privateIssuanceBatchId, commitPrivateIssuanceBatch } from './private-issuance-batch';

/** Selection only: the existing branded receipt committer independently checks
 * every amount, domain, nonce, digest, immutable reservation and global fence. */
export function membershipReceiptMatchesReservation(receipt: VerifiedMembershipReceipt, reservation: PrivateMembershipReservation): boolean {
  assertMembershipReceipt(receipt);
  return receipt.events.some(e => {
    if (e.kernel !== reservation.domain.kernel || e.pool !== reservation.domain.pool) return false;
    const log = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics: [...e.topics], data: e.data });
    if (!log) return false;
    if (reservation.kind === 'debit') return (log.name === 'MembershipDebitExecuted' && log.args.digest === reservation.digest)
      || (log.name === 'MembershipDebitCancelled' && log.args.binding === reservation.debit.binding && String(log.args.nonce) === reservation.debit.nonce);
    return ['IssuanceTicketConsumed','IssuanceBatchCancelled'].includes(log.name) && log.args.batchId === reservation.context.batchId;
  });
}
export async function reconcilePrivateMembershipReceipt(db: Firestore, ownerIdentity: string, receipt: VerifiedMembershipReceipt): Promise<void> {
  assertMembershipReceipt(receipt);
  const account = await db.collection(C.owners).doc(ownerIdentity).get(), pendingId: unknown = account.get('pendingReservation');
  if (typeof pendingId === 'string') {
    const pending = await db.collection(C.reservations).doc(pendingId).get(), reservation = pending.get('reservation') as PrivateMembershipReservation;
    if (!pending.exists || pending.get('status') !== 'pending' || !reservation || reservation.ownerIdentity !== ownerIdentity) throw Error('recourse_membership_pending_invalid');
    if (membershipReceiptMatchesReservation(receipt,reservation)) {
      const rules = await readPrivateCalendarRules(db, { pool: reservation.domain.pool, block: receipt.block, blockHash: receipt.blockHash });
      const batchId = reservation.kind === 'issuance' ? privateIssuanceBatchId(reservation.domain.kernel, reservation.context.batchId) : null;
      const retainedBatchId: unknown = pending.get('issuanceBatchId');
      const coordinated = batchId !== null && (await db.collection(PRIVATE_ISSUANCE_BATCHES).doc(batchId).get()).exists;
      if (retainedBatchId != null && (retainedBatchId !== batchId || !coordinated)) throw Error('recourse_issuance_batch_missing');
      if (batchId && coordinated) {
        // Every recipient must reconcile before any one owner branches at a
        // succession. This includes recipients with no membership account.
        await commitPrivateIssuanceBatch(db,batchId,receipt,rules);
      } else {
        await commitPrivateMembershipReceipt(db,ownerIdentity,pendingId,receipt,rules);
      }
    }
  }
  const owner = await db.collection(R.owners).doc(ownerIdentity).get(), transitionId: unknown = owner.get('membershipTransition');
  if (typeof transitionId !== 'string') return;
  const row = await db.collection(T).doc(transitionId).get(), transition = row.data() as PrivateMembershipTransition;
  if (!row.exists || transition.ownerIdentity !== ownerIdentity) throw Error('recourse_membership_transition_invalid');
  if ((transition.status !== 'consenting' && !(transition.kind === 'leave' && transition.status === 'preparing')) || receipt.block <= transition.checkpoint.block) return;
  const relevant = receipt.events.some(e => {
    if (e.name !== (transition.kind === 'renew' ? 'AddressConsentRenewed' : 'AddressConsentChanged') || e.pool !== transition.pool || e.kernel !== transition.kernel) return false;
    const log = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics: [...e.topics], data: e.data });
    return log !== null && transition.bindings.some(b => b.binding === log.args.binding);
  });
  if (relevant) await recordPrivateMembershipConsent(db,transitionId,receipt);
}

/** A finalized, authenticated boundary comes from succession discovery. No
 * caller-supplied receipt or status is promoted into a credit. The later full
 * counter scanner must still prove there were no missing effects. */
export async function reconcilePrivateMembershipThrough(db: Firestore, ownerIdentity: string,
  fromBlock: number, cutoff: MembershipDomainCheckpoint): Promise<void> {
  if (!/^0x[0-9a-f]{64}$/.test(ownerIdentity) || !Number.isSafeInteger(fromBlock) || fromBlock < 0 || fromBlock > cutoff.block) throw Error('recourse_membership_reconcile_range');
  const addresses = await db.collection(R.addresses).where('ownerIdentity','==',ownerIdentity).get();
  const bindings = new Set(addresses.docs.map(r => String(r.get('identity')))), wallets = new Set(addresses.docs.map(r => String(r.get('address'))));
  if (bindings.size === 0) throw Error('recourse_membership_reconcile_owner');
  const topics = MEMBERSHIP_RECEIPT_ABI.fragments.filter(f => f.type === 'event').map(f => MEMBERSHIP_RECEIPT_ABI.getEvent(f.format())!.topicHash);
  const transactions = new Set<string>();
  let lastBlock = fromBlock, lastIndex = -1;
  for await (const { start, end, logs } of readMembershipLogWindows(cutoff.pool, topics, fromBlock, cutoff.block)) {
    for (const log of logs) {
      if (log.removed || log.address !== cutoff.pool || log.blockNumber < start || log.blockNumber > end || log.blockNumber < lastBlock
        || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || (log.blockNumber === lastBlock && log.logIndex <= lastIndex)) throw Error('recourse_membership_reconcile_log');
      lastBlock = log.blockNumber; lastIndex = log.logIndex;
      const event = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics: [...log.topics], data: log.data });
      if (!event) throw Error('recourse_membership_reconcile_log');
      if (event.name === 'IssuanceBatchCancelled' || (event.name === 'IssuanceTicketConsumed'
        ? wallets.has(String(event.args.account).toLowerCase()) : bindings.has(String(event.args.binding)))) transactions.add(log.transactionHash);
    }
  }
  for (const hash of transactions) {
    const receipt = await readMembershipReceipt(hash,cutoff.pool);
    if (receipt.block < fromBlock || receipt.block > cutoff.block || receipt.events.some(e => e.kernel !== cutoff.kernel || e.pool !== cutoff.pool)) throw Error('recourse_membership_reconcile_domain');
    await reconcilePrivateMembershipReceipt(db,ownerIdentity,receipt);
  }
}
