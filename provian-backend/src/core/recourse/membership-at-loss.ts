import { utcCalendarMonth } from './calendar-month';
import { assessPrivateMembership, privateMembershipStatus, type PrivateCalendarRules } from './private-membership-calendar';
import { activeMembershipJournal, beforeMembershipPosition, membershipJournalHash, type MembershipJournalEntry, type MembershipJournalPosition } from './private-membership-journal';

export interface LossMembershipEvidence {
  readonly active: boolean; readonly periodIndex: number | null;
  readonly unpaidAtomic: string; readonly completedNonissuanceMonths: readonly number[];
  readonly evidenceHash: string;
  readonly admissionLogIndex?: number; readonly closureLogIndex?: number; readonly ruleHash?: string;
}
export interface LossAddressConsent {
  readonly generation: number; readonly active: boolean; readonly admissionLogIndex: number; readonly closureLogIndex: number;
}
/** The caller supplies a verified private journal and the independently read
 * single-address consent. Nothing learned after the loss credits its calendar.
 * The private randomized journal ID blinds the public evidence commitment. */
export function privateMembershipAtLoss(identity: string, journal: readonly MembershipJournalEntry[],
  loss: MembershipJournalPosition, consent: LossAddressConsent, rules: PrivateCalendarRules): LossMembershipEvidence {
  if (!/^0x[0-9a-f]{64}$/.test(identity) || !Number.isSafeInteger(consent.generation) || consent.generation < 0
    || ![loss.block, loss.logIndex, loss.timestamp, consent.admissionLogIndex, consent.closureLogIndex].every(n => Number.isSafeInteger(n) && n >= 0))
    throw Error('recourse_loss_position_invalid');
  const month = utcCalendarMonth(loss.timestamp);
  for (const entry of journal) {
    const cutoff = entry.succession?.cutoff;
    if (cutoff && cutoff.kernel === loss.kernel && cutoff.pool === loss.pool && beforeMembershipPosition(cutoff, loss)) {
      throw Error('recourse_membership_loss_after_cutoff');
    }
  }
  const history = activeMembershipJournal(journal).filter(entry => beforeMembershipPosition(entry.position, loss));
  const last = history[history.length - 1];
  if (last && (last.position.kernel !== loss.kernel || last.position.pool !== loss.pool || last.position.timestamp > loss.timestamp
    || (last.position.block === loss.block && last.position.blockHash !== loss.blockHash))) throw Error('recourse_membership_history_invalid');
  const state = last ? assessPrivateMembership(last.episode, month, rules) : null;
  const active = Boolean(last && state && consent.active && privateMembershipStatus(state, month, rules).protectedNow);
  const unpaid = state ? Object.values(state.invoices).filter(i => i.month < month && i.month >= state.startMonth)
    .reduce((sum, i) => sum + BigInt(i.burnDueAtomic) - BigInt(i.burnPaidAtomic) + BigInt(i.reserveDueAtomic) - BigInt(i.reservePaidAtomic), 0n) : 0n;
  const nonissuance = state ? Object.values(state.invoices).filter(i => i.month < month && i.month >= state.startMonth && i.earnings.grossAtomic === '0').map(i => i.month).sort((a,b) => a-b) : [];
  const ruleHash = rules(month).ruleHash;
  return { active, periodIndex: active && consent.generation > 0 ? consent.generation - 1 : null,
    unpaidAtomic: unpaid.toString(), completedNonissuanceMonths: nonissuance, admissionLogIndex: consent.admissionLogIndex,
    closureLogIndex: consent.closureLogIndex, ruleHash,
    evidenceHash: membershipJournalHash({ domain: 'Provian private membership at loss', identity, loss, consent,
      privateJournalCommitment: last?.id ?? null, state, ruleHash }) };
}
