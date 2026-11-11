import type { Firestore } from 'firebase-admin/firestore';
import { PRIVATE_ISSUANCE_ADDRESSES, PRIVATE_ISSUANCE_BATCHES } from './issuance-lock';
import { membershipJournalHash as digest } from './private-membership-journal';
import { parseMembershipAuthorizationDomain, type MembershipAuthorizationDomain } from './membership-authorization';
import { parseMembershipIssuanceContext, parseMembershipIssuanceTickets, MEMBER_SETTLEMENT_ABI,
  type MembershipIssuanceContext, type MembershipIssuanceTicket } from './issuance-ticket';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, preparePrivateMembershipReservation, commitPrivateMembershipReceipt,
  type PrivateIssuanceReservation } from './private-membership-reservation';
import type { PrivateCalendarRules } from './private-membership-calendar';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { SETTLEMENT_BATCHES_COLLECTION, type SettlementBatchDoc } from '../pvt/wp4/durable-settlement-store';
import { planSettlementIssuance, type SettlementIssuancePolicy } from './settlement-issuance';
import { assertMembershipReceipt, MEMBERSHIP_RECEIPT_ABI, type VerifiedMembershipReceipt } from './membership-receipt';
import { utcCalendarMonth } from './calendar-month';

export interface UnadmittedIssuanceRecipient {
  readonly ordinal: number;
  /** Null means not registered at reservation, never an unknown active owner. */
  readonly ownerIdentity: string | null;
  readonly addressRecordHash: string | null;
}
export interface PrivateIssuanceBatch {
  readonly id: string; readonly domain: MembershipAuthorizationDomain; readonly context: MembershipIssuanceContext;
  readonly policy: SettlementIssuancePolicy; readonly kernelCall: string; readonly target: string;
  readonly checkpoint: { readonly block: number; readonly blockHash: string };
  readonly tickets: readonly MembershipIssuanceTicket[];
  readonly reservations: readonly PrivateIssuanceReservation[];
  readonly unadmitted: readonly UnadmittedIssuanceRecipient[];
}
export interface PrivateIssuanceBatchRecord {
  readonly batch: PrivateIssuanceBatch; readonly status: 'reserved' | 'signed' | 'committed' | 'cancelled' | 'superseded';
  readonly signature: string | null; readonly calldata: string | null; readonly transactionHash: string | null;
}
const HASH = /^0x[0-9a-f]{64}$/;
const fail = (reason: string): never => { throw Error(`recourse_issuance_batch_${reason}`); };
export function privateIssuanceBatchId(kernel: string, batchId: string): string { return digest([kernel, batchId]); }
function validate(input: PrivateIssuanceBatch): void {
  const domain = parseMembershipAuthorizationDomain(input.domain), context = parseMembershipIssuanceContext(input.context);
  parseMembershipIssuanceTickets(input.tickets);
  if (input.id !== privateIssuanceBatchId(domain.kernel, context.batchId) || input.policy.kernel !== domain.kernel
    || input.policy.epoch !== context.epoch || input.policy.policyHash !== context.policyHash
    || !/^0x[0-9a-f]{40}$/.test(input.target) || /^0x0+$/.test(input.target)
    || !Number.isSafeInteger(input.checkpoint.block) || input.checkpoint.block < 0 || !HASH.test(input.checkpoint.blockHash)
    || new Set(input.reservations.map(r => r.ownerIdentity)).size !== input.reservations.length) return fail('input');
  const covered = new Set<number>();
  const take = (ordinal: number): MembershipIssuanceTicket => {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= input.tickets.length || covered.has(ordinal)) return fail('partition');
    covered.add(ordinal); return input.tickets[ordinal];
  };
  for (const r of input.reservations) {
    if (digest(r.domain) !== digest(domain) || digest(r.context) !== digest(context)) return fail('domain');
    for (const row of r.recipients) {
      const ticket = take(row.ordinal);
      if (ticket.account !== row.account || ticket.gross !== row.grossAtomic || ticket.contributor !== row.contributorAtomic
        || ticket.contribution !== row.contributionAtomic || ticket.protectedMember !== (r.protectedMember !== false)) return fail('ticket');
    }
  }
  for (const row of input.unadmitted) {
    const ticket = take(row.ordinal);
    if (ticket.protectedMember || ticket.contribution !== '0' || (row.ownerIdentity === null) !== (row.addressRecordHash === null)
      || (row.ownerIdentity !== null && (!HASH.test(row.ownerIdentity) || !HASH.test(row.addressRecordHash!)))
      || input.reservations.some(r => r.ownerIdentity === row.ownerIdentity)) return fail('unadmitted');
  }
  if (covered.size !== input.tickets.length) return fail('partition');
}

/** The parent settlement document already owns its claims and gas nonce. This
 * transaction attaches every recipient fence and every private owner lock at
 * once. No attestation may leave the process before this durable reservation. */
export async function reservePrivateIssuanceBatch(db: Firestore, input: PrivateIssuanceBatch): Promise<PrivateIssuanceBatchRecord> {
  const batch = JSON.parse(JSON.stringify(input)) as PrivateIssuanceBatch;
  validate(batch);
  const ref = db.collection(PRIVATE_ISSUANCE_BATCHES).doc(batch.id);
  return db.runTransaction(async tx => {
    const [existing, settlement] = await Promise.all([tx.get(ref), tx.get(db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(batch.context.batchId))]);
    if (existing.exists) {
      const record = existing.data() as PrivateIssuanceBatchRecord;
      if (digest(record.batch) !== digest(batch)) return fail('replay');
      return record;
    }
    const parent = settlement.data() as SettlementBatchDoc;
    if (!settlement.exists || parent.calldata !== batch.kernelCall || parent.status !== 'reserved' || parent.attempts.length !== 0) return fail('parent');
    const plan = planSettlementIssuance(parent, batch.policy);
    if (plan.settlementDigest !== batch.context.settlementDigest || plan.lane !== batch.context.lane
      || plan.recipients.length !== batch.tickets.length || plan.recipients.some((r, i) => {
        const ticket = batch.tickets[i]; return ticket.account !== r.account || ticket.gross !== r.grossAtomic || ticket.contributor !== r.contributorAtomic;
      })) return fail('kernel_call');
    const fences = await Promise.all(batch.tickets.map(t => tx.get(db.collection(PRIVATE_ISSUANCE_ADDRESSES).doc(t.account))));
    if (fences.some(row => row.get('batchId') != null)) return fail('busy');
    for (const item of batch.unadmitted) {
      const account = batch.tickets[item.ordinal].account;
      const row = await tx.get(db.collection(R.addresses).doc(account));
      if (item.ownerIdentity === null) {
        if (row.exists) return fail('ownership_changed');
      } else {
        const [owner, membership] = await Promise.all([tx.get(db.collection(R.owners).doc(item.ownerIdentity)), tx.get(db.collection(C.owners).doc(item.ownerIdentity))]);
        if (!row.exists || digest(row.data()) !== item.addressRecordHash || row.get('ownerIdentity') !== item.ownerIdentity
          || row.get('address') !== account || row.get('kernel') !== batch.domain.kernel || row.get('chainBindingStatus') !== 'confirmed'
          || !owner.exists || owner.get('ownerIdentity') !== item.ownerIdentity || owner.get('membershipTransition') != null || membership.exists) return fail('ownership_changed');
      }
    }
    const writes: (() => void)[] = [];
    for (const r of batch.reservations) writes.push(await preparePrivateMembershipReservation(db, tx, r));
    const record: PrivateIssuanceBatchRecord = { batch, status: 'reserved', signature: null, calldata: null, transactionHash: null };
    for (const write of writes) write();
    for (const reservation of batch.reservations) tx.update(db.collection(C.reservations).doc(reservation.id), { issuanceBatchId: batch.id });
    for (const ticket of batch.tickets) tx.set(db.collection(PRIVATE_ISSUANCE_ADDRESSES).doc(ticket.account), { batchId: batch.id });
    tx.create(ref, record);
    return record;
  });
}

/** The attestor caller verifies its signature at the canonical authority
 * checkpoint before saving it. Once saved, retries use these exact bytes. */
export async function retainPrivateIssuanceSignature(db: Firestore, input: PrivateIssuanceBatch, signature: string): Promise<PrivateIssuanceBatchRecord> {
  const batch = JSON.parse(JSON.stringify(input)) as PrivateIssuanceBatch;
  validate(batch);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) return fail('signature');
  const calldata = MEMBER_SETTLEMENT_ABI.encodeFunctionData('settleMemberBatch', [batch.kernelCall, batch.context, batch.tickets, signature]);
  const ref = db.collection(PRIVATE_ISSUANCE_BATCHES).doc(batch.id);
  return db.runTransaction(async tx => {
    const row = await tx.get(ref), record = row.data() as PrivateIssuanceBatchRecord;
    if (!row.exists || digest(record.batch) !== digest(batch)) return fail('replay');
    if (record.status === 'superseded') return fail('superseded');
    if (record.status !== 'reserved') {
      if (record.signature !== signature || record.calldata !== calldata) return fail('replay');
      return record;
    }
    const next: PrivateIssuanceBatchRecord = { ...record, status: 'signed', signature, calldata };
    tx.update(ref, { status: next.status, signature, calldata }); return next;
  });
}

/** Proves the WHOLE recipient list, including nonmembers. A revert, elapsed
 * deadline, missing receipt or gas-nonce cancellation cannot release a ticket. */
export function privateIssuanceReceiptEffects(batch: PrivateIssuanceBatch, receipt: VerifiedMembershipReceipt):
  { readonly status: 'committed' | 'cancelled'; readonly logIndexes: readonly number[] } {
  assertMembershipReceipt(receipt); validate(batch);
  if (receipt.pointer !== batch.domain.pointer || receipt.chainId !== batch.domain.chainId || receipt.block <= batch.checkpoint.block
    || receipt.events.some(e => e.kernel !== batch.domain.kernel || e.pool !== batch.domain.pool)) return fail('receipt_domain');
  const matching = receipt.events.flatMap(event => {
    const log = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics: [...event.topics], data: event.data });
    return log && log.args.batchId === batch.context.batchId ? [{ event, log }] : [];
  });
  const cancelled = matching.filter(r => r.log.name === 'IssuanceBatchCancelled');
  const consumed = matching.filter(r => r.log.name === 'IssuanceTicketConsumed');
  // Cancellation uses the current pointer revision, which can advance while
  // retaining this same kernel/pool pair. The branded receipt authenticates
  // the publication at the event; the retired signing revision need not match.
  if (cancelled.length === 1 && consumed.length === 0) return { status: 'cancelled', logIndexes: [] };
  if (cancelled.length !== 0 || consumed.length !== batch.tickets.length || utcCalendarMonth(receipt.timestamp) !== Number(batch.context.month)) return fail('receipt_effect');
  const logIndexes = batch.tickets.map((t, ordinal) => {
    const rows = consumed.filter(r => String(r.log.args.ordinal) === String(ordinal));
    if (rows.length !== 1) return fail('receipt_effect');
    const { event: e, log: l } = rows[0], s = e.settlement;
    if (e.revision !== batch.context.revision || String(l.args.account).toLowerCase() !== t.account || String(l.args.gross) !== t.gross
      || String(l.args.contribution) !== t.contribution || l.args.membershipRuleHash !== batch.context.membershipRuleHash
      || !s || s.batchId !== batch.context.batchId || s.epoch !== batch.context.epoch || s.lane !== batch.context.lane
      || s.policyHash !== batch.context.policyHash || s.settlementDigest !== batch.context.settlementDigest) return fail('receipt_effect');
    return e.logIndex;
  });
  return { status: 'committed', logIndexes };
}

/** Idempotent across a crash between private-owner commits and parent claim
 * writeback. Recipient fences remain until every owner is reconciled. */
export async function commitPrivateIssuanceBatch(db: Firestore, id: string, receipt: VerifiedMembershipReceipt, rules: PrivateCalendarRules): Promise<'committed' | 'cancelled'> {
  assertMembershipReceipt(receipt);
  const ref = db.collection(PRIVATE_ISSUANCE_BATCHES).doc(id), row = await ref.get();
  if (!row.exists) return fail('missing');
  const initial = row.data() as PrivateIssuanceBatchRecord, batch = initial.batch;
  if (initial.status === 'superseded') return fail('superseded');
  const result = privateIssuanceReceiptEffects(batch, receipt);
  for (const r of batch.reservations) {
    const status = await commitPrivateMembershipReceipt(db, r.ownerIdentity, r.id, receipt, rules);
    if (status !== result.status) return fail('receipt_effect');
  }
  return db.runTransaction(async tx => {
    const latest = await tx.get(ref), current = latest.data() as PrivateIssuanceBatchRecord;
    if (!latest.exists || digest(current.batch) !== digest(batch)) return fail('replay');
    if (current.status === 'superseded') return fail('superseded');
    if (current.status === 'committed' || current.status === 'cancelled') {
      if (current.status !== result.status || current.transactionHash !== receipt.transactionHash) return fail('replay');
      return result.status;
    }
    const fences = await Promise.all(batch.tickets.map(t => tx.get(db.collection(PRIVATE_ISSUANCE_ADDRESSES).doc(t.account))));
    if (fences.some(row => row.get('batchId') !== id)) return fail('fence');
    const effects = result.status === 'committed' ? batch.unadmitted.map(r => ({ r, index: result.logIndexes[r.ordinal],
      ref: db.collection(C.effects).doc(digest([batch.domain.kernel, batch.domain.pool, receipt.transactionHash, result.logIndexes[r.ordinal]])) })) : [];
    const prior = await Promise.all(effects.map(e => tx.get(e.ref)));
    if (prior.some(r => r.exists)) return fail('effect_replay');
    effects.forEach(e => tx.create(e.ref, { ownerIdentity: e.r.ownerIdentity, issuanceBatchId: id, transactionHash: receipt.transactionHash,
      logIndex: e.index, block: receipt.block, blockHash: receipt.blockHash }));
    for (const ticket of batch.tickets) tx.update(db.collection(PRIVATE_ISSUANCE_ADDRESSES).doc(ticket.account), { batchId: null });
    tx.update(ref, { status: result.status, transactionHash: receipt.transactionHash, receipt });
    return result.status;
  });
}
