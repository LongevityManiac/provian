import { activeMembershipJournal, readMembershipJournal } from './private-membership-journal';
import { reconcilePrivateMembershipDomain } from './private-membership-domain';
import type { Firestore } from 'firebase-admin/firestore';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { assessPrivateMembership, privateMembershipStatus, type PrivateCalendarRules } from './private-membership-calendar';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { readPrivateMembershipScan, commitPrivateMembershipScan } from './private-membership-scan';
import { utcCalendarMonth } from './calendar-month';
import { RECOURSE_COLLECTIONS } from './ownership';
import type { RecoursePoolState } from './pool-state';

export interface PrivateMembershipView {
  readonly enrolled: boolean; readonly grace: boolean; readonly month: string;
  readonly endMonthExclusive: string; readonly unpaidAtomic: string;
  readonly block: number; readonly blockHash: string;
  readonly details: {
    readonly status: 'not_member' | 'protected' | 'grace' | 'lapsed';
    readonly protectionStartedAtMs: number | null;
    readonly nextMonthAtMs: number | null;
    readonly nextBurnAtomic: string | null;
    readonly noEarningsContributionAtomic: string | null;
    readonly earningsBps: number | null;
  };
}
/** A read projection never persists observedMonth: delayed on-time receipts
 * must still be applied at their canonical timestamp before grace is assessed. */
export function projectPrivateMembershipView(account: PrivateMembershipAccount, month: number,
  rules: PrivateCalendarRules, protectionStartedAtMs: number | null = account.admission ? account.admission.timestamp * 1000 : null, endedByLeaving = Boolean(account.closure)): PrivateMembershipView {
  const episode = assessPrivateMembership(account.episode, month, rules);
  const status = privateMembershipStatus(episode, month, rules);
  let unpaid = 0n;
  for (const invoice of Object.values(episode.invoices)) {
    if (invoice.month < episode.startMonth || invoice.month > month) continue;
    unpaid += BigInt(invoice.burnDueAtomic) - BigInt(invoice.burnPaidAtomic)
      + BigInt(invoice.reserveDueAtomic) - BigInt(invoice.reservePaidAtomic);
  }
  return { enrolled: status.protectedNow, grace: status.grace, month: String(month),
    endMonthExclusive: String(status.endMonthExclusive ?? 0), unpaidAtomic: String(unpaid),
    block: account.checkpoint.block, blockHash: account.checkpoint.blockHash,
    details: {
      status: status.protectedNow ? status.grace ? 'grace' : 'protected'
        : episode.generation > 0 && !endedByLeaving && episode.endMonthExclusive !== null ? 'lapsed' : 'not_member',
      protectionStartedAtMs,
      nextMonthAtMs: status.protectedNow ? Date.UTC(Math.floor((month + 1) / 12), (month + 1) % 12, 1) : null,
      nextBurnAtomic: status.protectedNow ? rules(month + 1).rule.participationBurnAtomic : null,
      noEarningsContributionAtomic: status.protectedNow ? rules(month).rule.noEarningsContributionAtomic : null,
      earningsBps: status.protectedNow ? rules(month).rule.earningsBps : null,
    } };
}

/** Authenticated caller supplies its private owner key, never a public binding
 * interpreted as a portfolio key. Outstanding operations show as unavailable
 * until their receipts reconcile; they never become fabricated zero dues. */
export async function readPrivateMembershipView(db: Firestore, ownerIdentity: string,
  pool: RecoursePoolState): Promise<PrivateMembershipView> {
  await reconcilePrivateMembershipDomain(db,ownerIdentity);
  const owner = await db.collection(RECOURSE_COLLECTIONS.owners).doc(ownerIdentity).get();
  if (owner.get('membershipTransition') != null) throw Error('recourse_private_membership_transition_pending');
  const ref = db.collection(C.owners).doc(ownerIdentity), initial = await ref.get();
  if (!initial.exists) {
    if (pool.addressConsent) throw Error('recourse_private_membership_unreconciled');
    return { enrolled: false, grace: false, month: pool.month, endMonthExclusive: '0', unpaidAtomic: '0',
      block: pool.block, blockHash: pool.blockHash,
      details: { status: 'not_member', protectionStartedAtMs: null, nextMonthAtMs: null,
        nextBurnAtomic: null, noEarningsContributionAtomic: null, earningsBps: null } };
  }
  if (initial.get('pendingReservation') !== null) throw Error('recourse_private_membership_pending');
  const scan = await readPrivateMembershipScan(db, ownerIdentity);
  await commitPrivateMembershipScan(db, scan);
  const row = await ref.get(), account = row.data() as PrivateMembershipAccount;
  if (account.ownerIdentity !== ownerIdentity || account.needsScan || account.pendingReservation !== null
    || account.checkpoint.pool !== pool.pool || account.checkpoint.block !== scan.block
    || account.checkpoint.blockHash !== scan.blockHash) throw Error('recourse_private_membership_changed');
  const rules = await readPrivateCalendarRules(db, account.checkpoint);
  let left = Boolean(account.closure);
  let started = account.admission ? account.admission.timestamp * 1000 : null;
  if (started === null && account.episode.generation > 0 && account.journalHead) {
    const journal = activeMembershipJournal(await readMembershipJournal(db, account));
    const admission = [...journal].reverse().find(entry => entry.kind === 'admission'
      && entry.episode.generation === account.episode.generation && entry.episode.startMonth === account.episode.startMonth);
    if (admission) started = admission.position.timestamp * 1000;
    left = journal.some(entry => entry.kind === 'closure' && entry.episode.generation === account.episode.generation
      && entry.episode.startMonth === account.episode.startMonth);
  }
  return projectPrivateMembershipView(account, utcCalendarMonth(scan.timestamp), rules, started, left);
}
