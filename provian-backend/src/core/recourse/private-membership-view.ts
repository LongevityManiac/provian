import { activeMembershipJournal, readMembershipJournal } from './private-membership-journal';
import type { Firestore } from 'firebase-admin/firestore';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { assessPrivateMembership, privateMembershipStatus, type PrivateCalendarRules } from './private-membership-calendar';
import { RECOURSE_COLLECTIONS } from './ownership';
import { PRIVATE_MEMBERSHIP_TRANSITIONS, type PrivateMembershipTransition } from './private-membership-transition';
import { pendingMembershipConsents } from './membership-progress';
import { privateCalendarRulesFromSchedule } from './private-calendar-rules';
import type { RecourseDisplayPool } from './pool-display';

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

/** The authenticated owner sees progress until all required receipts reconcile. */
export async function readPrivateMembershipView(db: Firestore, ownerIdentity: string,
  pool: Pick<RecourseDisplayPool, 'pool' | 'month' | 'block' | 'blockHash' | 'schedule'>): Promise<PrivateMembershipView | {
    membershipTransition: PrivateMembershipTransition['kind']; membershipApprovalPending?: true;
  } | null> {
  const ownerRef = db.collection(RECOURSE_COLLECTIONS.owners).doc(ownerIdentity);
  const owner = await ownerRef.get();
  if (owner.get('membershipTransition') != null) {
    const transition = await db.runTransaction(async tx => {
      const current = await tx.get(ownerRef);
      const id: unknown = current.get('membershipTransition');
      if (id == null) return null;
      if (current.get('ownerIdentity') !== ownerIdentity || typeof id !== 'string' || !/^0x[0-9a-f]{64}$/.test(id)) {
        throw Error('recourse_private_membership_transition_invalid');
      }
      const row = await tx.get(db.collection(PRIVATE_MEMBERSHIP_TRANSITIONS).doc(id));
      const operation: unknown = row.get('kind');
      const status: unknown = row.get('status');
      if (row.get('id') !== id || row.get('ownerIdentity') !== ownerIdentity
        || (status !== 'preparing' && status !== 'consenting')
        || (operation !== 'join' && operation !== 'leave' && operation !== 'renew')) {
        throw Error('recourse_private_membership_transition_invalid');
      }
      return { id, kind: row.get('departureRequested') === true ? 'leave' : operation } as const;
    }, { readOnly: true });
    if (transition !== null) {
      const pending = transition.kind === 'join' && (await pendingMembershipConsents(db, transition.id)).length > 0;
      return { membershipTransition: transition.kind, ...(pending ? { membershipApprovalPending: true } : {}) };
    }
  }
  const row = await db.collection(C.owners).doc(ownerIdentity).get();
  if (!row.exists) {
    // A locally confirmed binding can predate a migrated membership account.
    // Initial registration alone does not grant any protection.
    if (owner.get('membershipScanRequired') === true) return null;
    return { enrolled: false, grace: false, month: pool.month, endMonthExclusive: '0', unpaidAtomic: '0',
      block: pool.block, blockHash: pool.blockHash,
      details: { status: 'not_member', protectionStartedAtMs: null, nextMonthAtMs: null,
        nextBurnAtomic: null, noEarningsContributionAtomic: null, earningsBps: null } };
  }
  const account = row.data() as PrivateMembershipAccount;
  const month = Number(pool.month);
  if (account.ownerIdentity !== ownerIdentity || account.checkpoint?.pool !== pool.pool
    || !account.episode || account.episode.observedMonth > month
    || owner.get('membershipScanRequired') === true) return null;
  const rules = privateCalendarRulesFromSchedule(pool.schedule);
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
  return projectPrivateMembershipView(account, month, rules, started, left);
}
