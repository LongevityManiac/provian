import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { creditPrivateMembership, recordPrivateMembershipIssuance,
  type PrivateMembershipEpisode, type PrivateCalendarRules } from './private-membership-calendar';
import { exactMembershipDebitDigest, parseExactMembershipDebit, parseMembershipAuthorizationDomain,
  type ExactMembershipDebit, type MembershipAuthorizationDomain } from './membership-authorization';
import { parseMembershipIssuanceContext, type MembershipIssuanceContext } from './issuance-ticket';
import type { AddressIssuanceContribution, PrivateIssuanceRecipient } from './private-monthly-earnings';
import { assertMembershipReceipt, MEMBERSHIP_RECEIPT_ABI, type VerifiedMembershipReceipt } from './membership-receipt';
import { utcCalendarMonth } from './calendar-month';
import { RECOURSE_COLLECTIONS } from './ownership';
import { assertDebitRevocation, type VerifiedDebitRevocation } from './membership-debit-revocation';

export const PRIVATE_MEMBERSHIP_COLLECTIONS = Object.freeze({
  owners: 'recourse_private_memberships_v1', reservations: 'recourse_private_membership_reservations_v1',
  receipts: 'recourse_private_membership_receipts_v1',
  effects: 'recourse_private_membership_effects_v1',
});
export interface PrivateMembershipCheckpoint {
  readonly pool: string; readonly block: number; readonly blockHash: string;
}
export interface PrivateMembershipAccount {
  readonly ownerIdentity: string; readonly version: number;
  readonly episode: PrivateMembershipEpisode;
  /** Set only by the complete canonical event scanner, never a status query. */
  readonly checkpoint: PrivateMembershipCheckpoint;
  readonly needsScan: boolean;
  readonly pendingReservation: string | null;
  readonly admission?: { readonly block: number; readonly blockHash: string; readonly logIndex: number; readonly timestamp: number } | null;
  readonly closure?: { readonly block: number; readonly blockHash: string; readonly logIndex: number; readonly timestamp: number } | null;
}
interface ReservationBase {
  readonly id: string; readonly ownerIdentity: string; readonly accountVersion: number;
  readonly beforeHash: string; readonly domain: MembershipAuthorizationDomain;
  readonly checkpoint: PrivateMembershipCheckpoint;
}
export interface PrivateDebitReservation extends ReservationBase {
  readonly kind: 'debit'; readonly debit: ExactMembershipDebit; readonly digest: string;
}
export interface PrivateIssuanceReservation extends ReservationBase {
  readonly kind: 'issuance'; readonly context: MembershipIssuanceContext;
  /** Ordinary batch ordinal, not a public owner-specific group number. */
  readonly recipients: readonly (AddressIssuanceContribution & { readonly ordinal: number })[];
}
export type PrivateMembershipReservation = PrivateDebitReservation | PrivateIssuanceReservation;
const HASH = /^0x[0-9a-f]{64}$/;
const invalid = (reason: string): never => { throw Error(`recourse_private_reservation_${reason}`); };
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) return invalid('encoding'); return encoded;
}
function digest(value: unknown): string { return `0x${createHash('sha256').update(stable(value)).digest('hex')}`; }
function base(account: PrivateMembershipAccount, domain: MembershipAuthorizationDomain): Omit<ReservationBase, 'id'> {
  const parsed = parseMembershipAuthorizationDomain(domain);
  if (parsed.chainId !== '8453' || !HASH.test(account.ownerIdentity) || /^0x0+$/.test(account.ownerIdentity)
    || !Number.isSafeInteger(account.version) || account.version < 0 || account.pendingReservation !== null || account.needsScan !== false
    || account.checkpoint.pool !== parsed.pool || !Number.isSafeInteger(account.checkpoint.block) || account.checkpoint.block < 0
    || !HASH.test(account.checkpoint.blockHash)) return invalid('account');
  return { ownerIdentity: account.ownerIdentity, accountVersion: account.version, beforeHash: digest(account),
    domain: parsed, checkpoint: { ...account.checkpoint } };
}
/** Planning changes no paid amount. Persist the reservation BEFORE exposing any
 * signature; all addresses of this private owner contend on the same lock. */
export function planPrivateDebit(account: PrivateMembershipAccount, domain: MembershipAuthorizationDomain,
  input: ExactMembershipDebit, nowMonth: number, rules: PrivateCalendarRules): PrivateDebitReservation {
  const debit = parseExactMembershipDebit(input), common = base(account, domain);
  const invoiceMonth = Number(debit.month);
  if (!Number.isSafeInteger(invoiceMonth) || debit.ruleHash !== rules(invoiceMonth).ruleHash) return invalid('rule');
  creditPrivateMembership(account.episode, nowMonth, invoiceMonth, { burnAtomic: debit.burn, reserveAtomic: debit.reserve }, rules);
  const operation = { ...common, kind: 'debit' as const, debit, digest: exactMembershipDebitDigest(domain, debit) };
  return { ...operation, id: digest(operation) };
}
export function planPrivateIssuance(account: PrivateMembershipAccount, domain: MembershipAuthorizationDomain,
  input: MembershipIssuanceContext, recipients: readonly (PrivateIssuanceRecipient & { readonly ordinal: number })[],
  rules: PrivateCalendarRules): PrivateIssuanceReservation {
  const common = base(account, domain), context = parseMembershipIssuanceContext(input), month = Number(context.month);
  if (!Number.isSafeInteger(month) || context.membershipRuleHash !== rules(month).ruleHash
    || recipients.some((row, i) => !Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || (i > 0 && row.ordinal <= recipients[i - 1].ordinal))) return invalid('issuance');
  const planned = recordPrivateMembershipIssuance(account.episode, month, recipients, rules);
  const operation = { ...common, kind: 'issuance' as const, context,
    recipients: planned.contributions.map((row, i) => ({ ...row, ordinal: recipients[i].ordinal })) };
  return { ...operation, id: digest(operation) };
}
/** No expiration-on-wall-clock unlock: signed bytes may already have executed.
 * Unlock only from verified exact success or a permanent chain cancellation. */
export async function reservePrivateMembership(db: Firestore, input: PrivateMembershipReservation): Promise<void> {
  // Detach before the first await: signing bytes cannot change while transaction
  // reads are in flight or while Firestore retries its callback.
  const reservation = JSON.parse(stable(input)) as PrivateMembershipReservation;
  const { id, ...body } = reservation;
  if (id !== digest(body)) return invalid('digest');
  const accountRef = db.collection(PRIVATE_MEMBERSHIP_COLLECTIONS.owners).doc(reservation.ownerIdentity);
  const reservationRef = db.collection(PRIVATE_MEMBERSHIP_COLLECTIONS.reservations).doc(id);
  await db.runTransaction(async transaction => {
    const [accountRow, existing] = await Promise.all([transaction.get(accountRef), transaction.get(reservationRef)]);
    if (!accountRow.exists) return invalid('missing_account');
    const account = accountRow.data() as PrivateMembershipAccount;
    const privateOwner = await transaction.get(db.collection(RECOURSE_COLLECTIONS.owners).doc(reservation.ownerIdentity));
    if (!privateOwner.exists || privateOwner.get('ownerIdentity') !== reservation.ownerIdentity) return invalid('ownership');
    if (privateOwner.get('membershipScanRequired') === true) return invalid('membership_scan_required');
    if (privateOwner.get('membershipTransition') != null) return invalid('membership_transition_pending');

    const addresses = reservation.kind === 'debit' ? [reservation.debit.payer] : reservation.recipients.map(row => row.account);
    const bindings = await Promise.all(addresses.map(account => transaction.get(db.collection(RECOURSE_COLLECTIONS.addresses).doc(account))));
    const identities = await Promise.all(bindings.map(row => {
      const identity: unknown = row.get('identity');
      if (!row.exists || typeof identity !== 'string' || !HASH.test(identity)) return invalid('ownership');
      return transaction.get(db.collection(RECOURSE_COLLECTIONS.identities).doc(identity));
    }));
    for (let i = 0; i < bindings.length; i++) {
      const binding = bindings[i], identity = identities[i];
      if (binding.get('ownerIdentity') !== reservation.ownerIdentity || binding.get('address') !== addresses[i]
        || binding.get('kernel') !== reservation.domain.kernel || binding.get('chainBindingStatus') !== 'confirmed'
        || !identity.exists || identity.get('ownerIdentity') !== reservation.ownerIdentity
        || identity.get('identity') !== binding.get('identity')
        || identity.get('recoveryGeneration') !== binding.get('recoveryGeneration')
        || (reservation.kind === 'debit' && binding.get('identity') !== reservation.debit.binding)) return invalid('ownership');
    }
    if (existing.exists) {
      if (stable(existing.get('reservation')) !== stable(reservation) || existing.get('status') !== 'pending'
        || account.pendingReservation !== id || digest({ ...account, pendingReservation: null }) !== reservation.beforeHash) return invalid('replay');
      return;
    }
    if (account.ownerIdentity !== reservation.ownerIdentity || account.version !== reservation.accountVersion
      || account.pendingReservation !== null || digest(account) !== reservation.beforeHash) return invalid('concurrent');
    transaction.create(reservationRef, { reservation, status: 'pending' });
    transaction.update(accountRef, { pendingReservation: id });
  });
}

/** These checks compare public effects with private, immutable reserved bytes.
 * A failed transaction, allowance, signature or unverified JSON never credits
 * the calendar. Contributions and burn remain separate obligations. */
export function applyPrivateReservationReceipt(account: PrivateMembershipAccount, reservation: PrivateMembershipReservation,
  receipt: VerifiedMembershipReceipt, rules: PrivateCalendarRules): {
    readonly episode: PrivateMembershipEpisode; readonly status: 'committed' | 'cancelled'; readonly logIndexes: readonly number[];
  } {
  assertMembershipReceipt(receipt);
  const { id, ...body } = reservation;
  if (id !== digest(body) || receipt.pointer !== reservation.domain.pointer || receipt.chainId !== reservation.domain.chainId) return invalid('domain');
  const unlocked = { ...account, pendingReservation: null };
  if (account.pendingReservation !== reservation.id || account.ownerIdentity !== reservation.ownerIdentity
    || account.version !== reservation.accountVersion || digest(unlocked) !== reservation.beforeHash
    || receipt.block <= reservation.checkpoint.block) return invalid('state');
  const month = utcCalendarMonth(receipt.timestamp);
  const events = receipt.events.filter(event => event.pool === reservation.domain.pool && event.kernel === reservation.domain.kernel);
  if (events.length !== receipt.events.length) return invalid('domain');
  if (reservation.kind === 'debit') {
    const debit = reservation.debit;
    const matching = events.flatMap(event => {
      const log = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics: [...event.topics], data: event.data });
      return log && log.name === 'MembershipDebitExecuted' && log.args.digest === reservation.digest ? [{ event, log }] : [];
    });
    if (matching.length === 1) {
      const { event, log } = matching[0], a = log.args;
      if (event.revision !== debit.revision || a.binding !== debit.binding || String(a.payer).toLowerCase() !== debit.payer
        || String(a.month) !== debit.month || String(a.burn) !== debit.burn || String(a.reserve) !== debit.reserve || String(a.nonce) !== debit.nonce) return invalid('debit_effect');
      return { episode: creditPrivateMembership(account.episode, month, Number(debit.month),
        { burnAtomic: debit.burn, reserveAtomic: debit.reserve }, rules), status: 'committed', logIndexes: [event.logIndex] };
    }
    const cancelled = events.filter(event => {
      const log = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics: [...event.topics], data: event.data });
      return log?.name === 'MembershipDebitCancelled' && log.args.binding === debit.binding && String(log.args.nonce) === debit.nonce;
    });
    if (matching.length !== 0 || cancelled.length !== 1) return invalid('debit_effect');
    return { episode: account.episode, status: 'cancelled', logIndexes: [cancelled[0].logIndex] };
  }
  const context = reservation.context;
  const cancelled = events.filter(event => {
    const log = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics: [...event.topics], data: event.data });
    return log?.name === 'IssuanceBatchCancelled' && log.args.batchId === context.batchId;
  });
  const consumed = events.flatMap(event => {
    const log = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics: [...event.topics], data: event.data });
    return log?.name === 'IssuanceTicketConsumed' && log.args.batchId === context.batchId ? [{ event, log }] : [];
  });
  if (cancelled.length === 1 && consumed.length === 0) return { episode: account.episode, status: 'cancelled', logIndexes: [cancelled[0].logIndex] };
  if (cancelled.length !== 0 || month !== Number(context.month)) return invalid('issuance_effect');
  const selected = reservation.recipients.map(row => {
    const matches = consumed.filter(item => item.log.args.ordinal === BigInt(row.ordinal));
    if (matches.length !== 1) return invalid('issuance_effect');
    const { event, log } = matches[0];
    if (event.revision !== context.revision || String(log.args.account).toLowerCase() !== row.account
      || String(log.args.gross) !== row.grossAtomic || String(log.args.contribution) !== row.contributionAtomic
      || log.args.membershipRuleHash !== context.membershipRuleHash || event.settlement?.batchId !== context.batchId
      || event.settlement.settlementDigest !== context.settlementDigest || event.settlement.policyHash !== context.policyHash
      || event.settlement.lane !== context.lane || event.settlement.epoch !== context.epoch) return invalid('issuance_effect');
    return event.logIndex;
  });
  const planned = recordPrivateMembershipIssuance(account.episode, month, reservation.recipients, rules);
  if (planned.contributions.some((row, i) => row.contributionAtomic !== reservation.recipients[i].contributionAtomic)) return invalid('issuance_rounding');
  return { episode: planned.state, status: 'committed', logIndexes: selected };
}

/** Caller invokes this only after the complete scanner has applied all earlier
 * owner events. Immutable receipt rows survive a break; the active projection
 * can then be rebuilt through the same last-good cutoff as the token snapshot. */
export async function commitPrivateMembershipReceipt(db: Firestore, ownerIdentity: string, reservationId: string,
  receipt: VerifiedMembershipReceipt, rules: PrivateCalendarRules): Promise<'committed' | 'cancelled'> {
  assertMembershipReceipt(receipt);
  if (!HASH.test(ownerIdentity) || !HASH.test(reservationId)) return invalid('identity');
  const accountRef = db.collection(PRIVATE_MEMBERSHIP_COLLECTIONS.owners).doc(ownerIdentity);
  const reservationRef = db.collection(PRIVATE_MEMBERSHIP_COLLECTIONS.reservations).doc(reservationId);
  const receiptRef = db.collection(PRIVATE_MEMBERSHIP_COLLECTIONS.receipts).doc(digest([ownerIdentity, reservationId, receipt.transactionHash]));
  return db.runTransaction(async transaction => {
    const [accountRow, reserved, existing] = await Promise.all([transaction.get(accountRef), transaction.get(reservationRef), transaction.get(receiptRef)]);
    if (!accountRow.exists || !reserved.exists) return invalid('missing_account');
    if (existing.exists) {
      const status: unknown = existing.get('status');
      if (existing.get('receiptHash') !== digest(receipt) || (status !== 'committed' && status !== 'cancelled')
        || reserved.get('status') !== status) return invalid('replay');
      return status;
    }
    if (reserved.get('status') !== 'pending') return invalid('replay');
    const account = accountRow.data() as PrivateMembershipAccount, reservation = reserved.get('reservation') as PrivateMembershipReservation;
    if (reservation.id !== reservationId || reservation.ownerIdentity !== ownerIdentity) return invalid('identity');
    const result = applyPrivateReservationReceipt(account, reservation, receipt, rules);
    const effectRefs = result.status === 'committed' ? result.logIndexes.map(logIndex => db.collection(PRIVATE_MEMBERSHIP_COLLECTIONS.effects)
      .doc(digest([reservation.domain.kernel, reservation.domain.pool, receipt.transactionHash, logIndex]))) : [];
    const effects = await Promise.all(effectRefs.map(ref => transaction.get(ref)));
    if (effects.some(row => row.exists)) return invalid('effect_replay');
    effectRefs.forEach((ref, i) => transaction.create(ref, { ownerIdentity, reservationId,
      transactionHash: receipt.transactionHash, logIndex: result.logIndexes[i], block: receipt.block, blockHash: receipt.blockHash }));
    transaction.create(receiptRef, { ownerIdentity, reservationId, receiptHash: digest(receipt), receipt, ...result,
      previousEpisode: account.episode, previousVersion: account.version });
    transaction.update(reservationRef, { status: result.status, transactionHash: receipt.transactionHash });
    transaction.update(accountRef, { episode: result.episode, pendingReservation: null, needsScan: true, version: account.version + 1 });
    return result.status;
  });
}

export async function releaseRevokedPrivateDebit(db: Firestore, ownerIdentity: string, reservationId: string,
  proof: VerifiedDebitRevocation): Promise<void> {
  assertDebitRevocation(proof);
  if (!HASH.test(ownerIdentity) || !HASH.test(reservationId)) return invalid('identity');
  const accountRef = db.collection(PRIVATE_MEMBERSHIP_COLLECTIONS.owners).doc(ownerIdentity);
  const reservedRef = db.collection(PRIVATE_MEMBERSHIP_COLLECTIONS.reservations).doc(reservationId);
  const evidenceRef = db.collection(PRIVATE_MEMBERSHIP_COLLECTIONS.receipts).doc(digest([ownerIdentity, reservationId, 'revocation']));
  await db.runTransaction(async transaction => {
    const [accountRow, reserved, existing] = await Promise.all([transaction.get(accountRef), transaction.get(reservedRef), transaction.get(evidenceRef)]);
    if (!accountRow.exists || !reserved.exists) return invalid('missing_account');
    const r = reserved.get('reservation') as PrivateMembershipReservation;
    if (r.id !== reservationId || r.ownerIdentity !== ownerIdentity || r.kind !== 'debit' || r.digest !== proof.digest
      || r.domain.pool !== proof.pool || r.domain.kernel !== proof.kernel || r.domain.pointer !== proof.pointer
      || r.checkpoint.block !== proof.fromBlock || r.checkpoint.blockHash !== proof.fromBlockHash
      || r.debit.nonce !== proof.nonceBefore) return invalid('revocation_domain');
    if (existing.exists && reserved.get('status') === 'revoked' && existing.get('digest') === proof.digest) return;
    const account = accountRow.data() as PrivateMembershipAccount;
    if (existing.exists || reserved.get('status') !== 'pending' || account.pendingReservation !== reservationId) return invalid('replay');
    transaction.create(evidenceRef, { ownerIdentity, reservationId, digest: proof.digest, proof, status: 'revoked',
      previousEpisode: account.episode, previousVersion: account.version });
    transaction.update(reservedRef, { status: 'revoked', revocationEvidenceHash: proof.evidenceHash });
    transaction.update(accountRef, { pendingReservation: null, needsScan: true, version: account.version + 1 });
  });
}
