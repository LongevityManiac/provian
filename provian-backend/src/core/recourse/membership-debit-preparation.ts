import { pendingMembershipDebit } from './membership-progress';
import type { SponsoredOperationStatus } from './sponsored-operation-queue';
import type { Firestore } from 'firebase-admin/firestore';
import { currentProtocolDeployment } from '../protocol/runtime';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, planPrivateDebit, reservePrivateMembership,
  type PrivateMembershipAccount, type PrivateDebitReservation, type PrivateMembershipReservation } from './private-membership-reservation';
import { assessPrivateMembership, privateMembershipStatus, type PrivateCalendarRules } from './private-membership-calendar';
import { reconcileCurrentPrivateMembership } from './membership-preparation';
import { readRecoursePoolState, readHistoricalRecoursePoolState, type RecoursePoolState } from './pool-state';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { utcCalendarMonth } from './calendar-month';
import { exactMembershipDebitSigningHash, type MembershipAuthorizationDomain, type ExactMembershipDebit } from './membership-authorization';

export interface MembershipPaymentSelection { readonly month: string; readonly burn: string; readonly reserve: string }
export interface MembershipDebitChallenge {
  readonly reservationId: string; readonly domain: MembershipAuthorizationDomain; readonly debit: ExactMembershipDebit;
  readonly messageHex: string; readonly allowanceAtomic: string;
}
export type MembershipDebitPreparation = { readonly status: 'ready'; readonly challenge: MembershipDebitChallenge }
  | { readonly status: 'settled' } | { readonly status: 'pending'; readonly operation: SponsoredOperationStatus | null };
const fail = (reason: string): never => { throw Error(`recourse_membership_debit_${reason}`); };
export function parseMembershipPaymentSelection(value: unknown): MembershipPaymentSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('amount');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'burn,month,reserve' || !Object.values(row).every(v =>
    typeof v === 'string' && v.length <= 78 && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < (1n << 256n))) return fail('amount');
  return { month: String(row.month), burn: String(row.burn), reserve: String(row.reserve) };
}

/** Choose only currently payable obligations, oldest month first. Completed
 * no-earnings months owe the flat reserve contribution; the current month
 * cannot be classified no-earnings before it ends. Burn is a separate amount. */
export function selectMembershipPayment(account: PrivateMembershipAccount, month: number, rules: PrivateCalendarRules,
  requested?: MembershipPaymentSelection): MembershipPaymentSelection | null {
  const state = assessPrivateMembership(account.episode, month, rules);
  if (!privateMembershipStatus(state, month, rules).protectedNow) return fail('join_required');
  if (requested) {
    requested = parseMembershipPaymentSelection(requested);
    const selectedMonth = Number(requested.month), invoice = state.invoices[requested.month];
    if (!Number.isSafeInteger(selectedMonth) || selectedMonth < state.startMonth || selectedMonth > month || month - selectedMonth > 1
      || !invoice || BigInt(requested.burn) > BigInt(invoice.burnDueAtomic) - BigInt(invoice.burnPaidAtomic)
      || BigInt(requested.reserve) > BigInt(invoice.reserveDueAtomic) - BigInt(invoice.reservePaidAtomic)
      || BigInt(requested.burn) + BigInt(requested.reserve) === 0n) return fail('amount');
    return { ...requested };
  }
  for (const invoice of Object.values(state.invoices).sort((a, b) => a.month - b.month)) {
    if (invoice.month < state.startMonth || invoice.month > month || month - invoice.month > 1) continue;
    const burn = BigInt(invoice.burnDueAtomic) - BigInt(invoice.burnPaidAtomic);
    const reserve = BigInt(invoice.reserveDueAtomic) - BigInt(invoice.reservePaidAtomic);
    if (burn + reserve > 0n) return { month: String(invoice.month), burn: String(burn), reserve: String(reserve) };
  }
  return null;
}
export function membershipDebitChallenge(reservation: PrivateDebitReservation): MembershipDebitChallenge {
  return { reservationId: reservation.id, domain: reservation.domain, debit: reservation.debit,
    messageHex: exactMembershipDebitSigningHash(reservation.domain, reservation.debit),
    allowanceAtomic: String(BigInt(reservation.debit.burn) + BigInt(reservation.debit.reserve)) };
}
export function debitMatchesCheckpoint(state: RecoursePoolState, checkpoint: RecoursePoolState): void {
  if (state.pool !== checkpoint.pool || state.kernel !== checkpoint.kernel || state.currentAddress !== checkpoint.currentAddress
    || !state.addressConsent || !checkpoint.addressConsent || state.debitNonce !== checkpoint.debitNonce
    || state.consentGeneration !== checkpoint.consentGeneration) return fail('reconciliation_pending');
}

/** Reserve exact bytes before returning signing material. An abandoned request
 * remains the owner's one financial reservation until canonical reconciliation
 * proves execution or permanent revocation, including after key recovery. */
export async function prepareMembershipDebit(db: Firestore, ownerIdentity: string, payer: string,
  requested?: MembershipPaymentSelection): Promise<MembershipDebitPreparation> {
  if (!/^0x[0-9a-f]{64}$/.test(ownerIdentity) || !/^0x[0-9a-f]{40}$/.test(payer)) return fail('input');
  await reconcileCurrentPrivateMembership(db, ownerIdentity);
  const [owner, accountRow, address] = await Promise.all([db.collection(R.owners).doc(ownerIdentity).get(),
    db.collection(C.owners).doc(ownerIdentity).get(), db.collection(R.addresses).doc(payer).get()]);
  if (!owner.exists || !accountRow.exists || owner.get('ownerIdentity') !== ownerIdentity) return fail('join_required');
  if (owner.get('membershipTransition') != null) return { status: 'pending', operation: null };
  if (!address.exists || address.get('ownerIdentity') !== ownerIdentity || address.get('chainBindingStatus') !== 'confirmed') return fail('payer');
  const binding: unknown = address.get('identity');
  if (typeof binding !== 'string') return fail('payer');
  const deployment = await currentProtocolDeployment(), state = await readRecoursePoolState(binding, deployment);
  if (state.currentAddress !== payer || state.kernel !== address.get('kernel')) return fail('payer');
  const account = accountRow.data() as PrivateMembershipAccount;
  if (typeof account.pendingReservation === 'string') {
    const row = await db.collection(C.reservations).doc(account.pendingReservation).get();
    const r = row.get('reservation') as PrivateMembershipReservation;
    if (!row.exists || row.get('status') !== 'pending' || !r || r.ownerIdentity !== ownerIdentity) return fail('pending_invalid');
    if (r.kind !== 'debit' || r.debit.payer !== payer || BigInt(r.debit.expiresAt) < BigInt(state.timestamp)
      || r.domain.pool !== state.pool || r.domain.kernel !== state.kernel || r.domain.pointer !== deployment.pointer.toLowerCase()
      || r.debit.revision !== String(deployment.revision)) return { status: 'pending', operation: null };
    if (requested && ['month', 'burn', 'reserve'].some(key => requested[key as keyof MembershipPaymentSelection] !== r.debit[key as keyof MembershipPaymentSelection])) return { status: 'pending', operation: null };
    const pending = await pendingMembershipDebit(db, r);
    if (pending) return { status: 'pending', operation: pending };
    return { status: 'ready', challenge: membershipDebitChallenge(r) };
  }
  if (owner.get('membershipScanRequired') === true || account.needsScan || account.checkpoint.pool !== state.pool) return fail('reconciliation_pending');
  debitMatchesCheckpoint(state, await readHistoricalRecoursePoolState(binding, account.checkpoint));
  const rules = await readPrivateCalendarRules(db, state), month = utcCalendarMonth(state.timestamp);
  const selected = selectMembershipPayment(account, month, rules, requested);
  if (!selected) return { status: 'settled' };
  const domain: MembershipAuthorizationDomain = { chainId: '8453', pointer: deployment.pointer.toLowerCase(), kernel: state.kernel, pool: state.pool };
  const debit: ExactMembershipDebit = { binding, payer, ...selected, nonce: state.debitNonce, generation: state.consentGeneration,
    revision: String(deployment.revision), ruleHash: rules(Number(selected.month)).ruleHash, expiresAt: String(state.timestamp + 300) };
  const reservation = planPrivateDebit(account, domain, debit, month, rules);
  if ((await currentProtocolDeployment()).manifestHash !== deployment.manifestHash) return fail('retired');
  await reservePrivateMembership(db, reservation);
  return { status: 'ready', challenge: membershipDebitChallenge(reservation) };
}
