import { emptyPrivateMonthlyEarnings, planPrivateMonthlyEarnings,
  type PrivateMonthlyEarnings, type PrivateIssuanceRecipient, type AddressIssuanceContribution } from './private-monthly-earnings';
import type { RejoinPayment } from './membership-authorization';
import type { RecourseMembershipRule } from './membership-rule';

/** Owner-wide accounting. Every field stays in encrypted relay storage; public
 * address tickets contain neither this episode nor an invoice identifier. */
export interface PrivateMembershipInvoice {
  readonly month: number; readonly ruleHash: string;
  readonly burnDueAtomic: string; readonly burnPaidAtomic: string;
  readonly noEarningsContributionAtomic: string; readonly reserveDueAtomic: string; readonly reservePaidAtomic: string;
  readonly earnings: PrivateMonthlyEarnings;
}
export interface PrivateMembershipEpisode {
  readonly generation: number; readonly joined: boolean; readonly startMonth: number;
  readonly admissionMonth: number; readonly observedMonth: number;
  readonly lastAssessedMonth: number; readonly firstUnpaidMonth: number; readonly endMonthExclusive: number | null;
  readonly invoices: Readonly<Record<string, PrivateMembershipInvoice>>;
}
export interface PrivateCalendarRule { readonly rule: RecourseMembershipRule; readonly ruleHash: string }
export type PrivateCalendarRules = (month: number) => PrivateCalendarRule;
const invalid = (): never => { throw Error('recourse_private_calendar_invalid'); };
function month(value: number): void { if (!Number.isSafeInteger(value) || value < 0) invalid(); }
function amount(value: string): bigint { if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid(); return BigInt(value); }
function invoiceAt(state: PrivateMembershipEpisode, target: number): PrivateMembershipInvoice {
  const invoice = state.invoices[String(target)];
  if (!invoice || invoice.month !== target) return invalid();
  return invoice;
}
function initialInvoice(target: number, rules: PrivateCalendarRules): PrivateMembershipInvoice {
  const { rule, ruleHash } = rules(target);
  if (rule.firstMonth > target || !/^0x[0-9a-f]{64}$/.test(ruleHash) || /^0x0+$/.test(ruleHash)) invalid();
  amount(rule.participationBurnAtomic); amount(rule.noEarningsContributionAtomic);
  return { month: target, ruleHash, burnDueAtomic: rule.participationBurnAtomic, burnPaidAtomic: '0',
    noEarningsContributionAtomic: rule.noEarningsContributionAtomic, reserveDueAtomic: '0', reservePaidAtomic: '0',
    earnings: emptyPrivateMonthlyEarnings(rule.earningsBps) };
}
function unpaid(invoice: PrivateMembershipInvoice, completed: boolean): boolean {
  const reserve = completed && amount(invoice.earnings.grossAtomic) === 0n
    ? invoice.noEarningsContributionAtomic : invoice.reserveDueAtomic;
  return amount(invoice.burnPaidAtomic) < amount(invoice.burnDueAtomic)
    || amount(invoice.reservePaidAtomic) < amount(reserve);
}
export function privateMembershipStatus(prior: PrivateMembershipEpisode, nowMonth: number, rules: PrivateCalendarRules): {
  readonly protectedNow: boolean; readonly grace: boolean; readonly endMonthExclusive: number | null;
} {
  month(nowMonth);
  const state = assessPrivateMembership(prior, nowMonth, rules);
  if (!state.joined) return { protectedNow: false, grace: false, endMonthExclusive: state.endMonthExclusive };
  for (let m = state.firstUnpaidMonth; m < nowMonth; ++m) {
    const invoice = state.invoices[String(m)];
    if (invoice && unpaid(invoice, true)) {
      const end = m + 2;
      return { protectedNow: nowMonth < end, grace: nowMonth < end, endMonthExclusive: end };
    }
  }
  return { protectedNow: true, grace: false, endMonthExclusive: null };
}

/** Pure plan only. The durable journal must retain the previous episode and
 * commit credits solely after exact independently verified chain receipts. */
/** A break cutoff can precede the owner's first admission. This is an explicit
 * absence of membership, with no invoices or debt imported from the discarded branch. */
export function unadmittedPrivateMembership(nowMonth: number): PrivateMembershipEpisode {
  month(nowMonth);
  return { generation: 0, joined: false, startMonth: nowMonth, admissionMonth: nowMonth,
    observedMonth: nowMonth, lastAssessedMonth: nowMonth, firstUnpaidMonth: nowMonth,
    endMonthExclusive: null, invoices: {} };
}
export function assessPrivateMembership(prior: PrivateMembershipEpisode, nowMonth: number,
  rules: PrivateCalendarRules): PrivateMembershipEpisode {
  month(nowMonth);
  if (nowMonth < prior.observedMonth) throw Error('recourse_private_calendar_rollback');
  if (prior.generation === 0) {
    if (prior.joined || Object.keys(prior.invoices).length !== 0 || prior.endMonthExclusive !== null) invalid();
    return unadmittedPrivateMembership(nowMonth);
  }
  const invoices = { ...prior.invoices };
  let state: PrivateMembershipEpisode = { ...prior, observedMonth: nowMonth, invoices };
  if (!state.joined) {
    const last = invoiceAt(state, state.lastAssessedMonth);
    if (last.month < nowMonth && amount(last.earnings.grossAtomic) === 0n) {
      invoices[String(last.month)] = { ...last, reserveDueAtomic: last.noEarningsContributionAtomic };
    }
    return state;
  }
  const advancePaid = (through: number): void => {
    let first = state.firstUnpaidMonth;
    while (first < through && (!invoices[String(first)] || !unpaid(invoiceAt(state, first), true))) first++;
    state = { ...state, firstUnpaidMonth: first };
  };
  let cursor = state.lastAssessedMonth;
  while (cursor < nowMonth) {
    const previous = invoiceAt(state, cursor);
    if (amount(previous.earnings.grossAtomic) === 0n) {
      invoices[String(cursor)] = { ...previous, reserveDueAtomic: previous.noEarningsContributionAtomic };
    }
    cursor++; advancePaid(cursor);
    if (state.firstUnpaidMonth + 1 < cursor) return { ...state, joined: false,
      lastAssessedMonth: cursor - 1, endMonthExclusive: state.firstUnpaidMonth + 2 };
    invoices[String(cursor)] ??= initialInvoice(cursor, rules);
  }
  advancePaid(nowMonth);
  return { ...state, lastAssessedMonth: nowMonth };
}
export function joinPrivateMembership(prior: PrivateMembershipEpisode | null, nowMonth: number,
  rules: PrivateCalendarRules): PrivateMembershipEpisode {
  month(nowMonth);
  const old = prior === null ? null : assessPrivateMembership(prior, nowMonth, rules);
  if (old && privateMembershipStatus(old, nowMonth, rules).protectedNow) throw Error('recourse_private_membership_already_joined');
  const generation = (old?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) invalid();
  // Rejoining in the same calendar month cannot duplicate either obligation,
  // discard an earned-issuance remainder, or erase a previously paid amount.
  const invoice = old?.invoices[String(nowMonth)] ?? initialInvoice(nowMonth, rules);
  if (privateRejoinPayments(old, nowMonth, rules).length) throw Error('recourse_private_membership_rejoin_unpaid');
  return { generation, joined: true, startMonth: nowMonth,
    admissionMonth: nowMonth, observedMonth: nowMonth, lastAssessedMonth: nowMonth,
    firstUnpaidMonth: nowMonth, endMonthExclusive: null,
    invoices: { [String(nowMonth)]: invoice } };
}
export function leavePrivateMembership(prior: PrivateMembershipEpisode, nowMonth: number,
  rules: PrivateCalendarRules): PrivateMembershipEpisode {
  const state = assessPrivateMembership(prior, nowMonth, rules);
  if (!state.joined) return state;
  return { ...state, joined: false, endMonthExclusive: nowMonth };
}
export function creditPrivateMembership(prior: PrivateMembershipEpisode, nowMonth: number, invoiceMonth: number,
  credit: { readonly burnAtomic: string; readonly reserveAtomic: string }, rules: PrivateCalendarRules): PrivateMembershipEpisode {
  const state = assessPrivateMembership(prior, nowMonth, rules);
  month(invoiceMonth);
  if (!privateMembershipStatus(state, nowMonth, rules).protectedNow || invoiceMonth < state.startMonth || invoiceMonth > nowMonth) {
    throw Error('recourse_private_membership_credit_lapsed');
  }
  const invoice = invoiceAt(state, invoiceMonth), burn = amount(credit.burnAtomic), reserve = amount(credit.reserveAtomic);
  if (burn > amount(invoice.burnDueAtomic) - amount(invoice.burnPaidAtomic)
    || reserve > amount(invoice.reserveDueAtomic) - amount(invoice.reservePaidAtomic)) throw Error('recourse_private_membership_overcredit');
  const next = { ...invoice, burnPaidAtomic: String(amount(invoice.burnPaidAtomic) + burn),
    reservePaidAtomic: String(amount(invoice.reservePaidAtomic) + reserve) };
  return assessPrivateMembership({ ...state, invoices: { ...state.invoices, [String(invoiceMonth)]: next } }, nowMonth, rules);
}
export function recordPrivateMembershipIssuance(prior: PrivateMembershipEpisode, nowMonth: number,
  recipients: readonly PrivateIssuanceRecipient[], rules: PrivateCalendarRules): {
    readonly state: PrivateMembershipEpisode; readonly contributions: readonly AddressIssuanceContribution[];
  } {
  const state = assessPrivateMembership(prior, nowMonth, rules);
  if (!privateMembershipStatus(state, nowMonth, rules).protectedNow) throw Error('recourse_private_membership_issuance_lapsed');
  const invoice = invoiceAt(state, nowMonth), planned = planPrivateMonthlyEarnings(invoice.earnings, recipients);
  const paid = planned.contributions.reduce((total, row) => total + BigInt(row.contributionAtomic), 0n);
  const next = { ...invoice, earnings: planned.next, reserveDueAtomic: planned.next.dueAtomic,
    reservePaidAtomic: String(amount(invoice.reservePaidAtomic) + paid) };
  return { state: { ...state, invoices: { ...state.invoices, [String(nowMonth)]: next } }, contributions: planned.contributions };
}

/** Only invoices for actual protected months exist. Never manufacture invoices
 * between the lapse and rejoin. Each retained invoice keeps its original rule
 * and all receipt-backed credits, including contributions withheld at issuance. */
export function privateRejoinPayments(prior: PrivateMembershipEpisode | null, nowMonth: number,
  rules: PrivateCalendarRules): readonly RejoinPayment[] {
  if (!prior) return [];
  const state = assessPrivateMembership(prior, nowMonth, rules);
  return Object.values(state.invoices).filter(i => i.month < nowMonth && unpaid(i, true))
    .sort((a, b) => a.month - b.month).map(i => ({ month: String(i.month), ruleHash: i.ruleHash,
      burn: String(amount(i.burnDueAtomic) - amount(i.burnPaidAtomic)),
      reserve: String(amount(i.reserveDueAtomic) - amount(i.reservePaidAtomic)) }));
}
/** Called only with independently verified finalized payment receipts. Paying
 * a closed episode changes its credits, never its protection interval. */
export function creditPrivateRejoin(prior: PrivateMembershipEpisode, nowMonth: number,
  payments: readonly RejoinPayment[], rules: PrivateCalendarRules): PrivateMembershipEpisode {
  const state = assessPrivateMembership(prior, nowMonth, rules);
  const expected = privateRejoinPayments(state, nowMonth, rules);
  if (privateMembershipStatus(state, nowMonth, rules).protectedNow || expected.length === 0
    || JSON.stringify(payments) !== JSON.stringify(expected)) throw Error('recourse_private_membership_rejoin_payment');
  const invoices = { ...state.invoices };
  for (const payment of expected) {
    const invoice = invoices[payment.month];
    invoices[payment.month] = { ...invoice, burnPaidAtomic: invoice.burnDueAtomic, reservePaidAtomic: invoice.reserveDueAtomic };
  }
  return { ...state, invoices };
}
