import { createHash } from 'crypto';
import { utcCalendarMonth, type MembershipPosition } from './calendar-month';

export interface PoolMembershipEvent extends MembershipPosition {
  readonly transactionHash: string; readonly blockHash: string;
  readonly enrolled: boolean; readonly generation: number;
}
export interface HistoricalMonthlyInvoice {
  readonly month: number; readonly burnDue: string; readonly contributionDue: string;
  readonly burnPaid: string; readonly contributionPaid: string; readonly earnings: boolean;
}
export interface LossMembershipEvidence {
  readonly active: boolean; readonly periodIndex: number | null;
  readonly unpaidAtomic: string; readonly completedNonissuanceMonths: readonly number[];
  readonly evidenceHash: string;
}
const HASH = /^0x[0-9a-f]{64}$/;
const before = (a: MembershipPosition, b: MembershipPosition): boolean => a.block < b.block
  || (a.block === b.block && a.logIndex < b.logIndex);

/** Membership events are cut immediately before the first loss outflow. Invoices
 * are read from that episode at the canonical loss block; later enrollment cannot
 * replace them. Grace follows calendar obligations, never keeper execution. */
export function membershipAtLoss(identity: string, events: readonly PoolMembershipEvent[],
  loss: MembershipPosition & { readonly blockHash: string }, invoices: readonly HistoricalMonthlyInvoice[]): LossMembershipEvidence {
  if (!HASH.test(identity) || !HASH.test(loss.blockHash) || !Number.isSafeInteger(loss.block) || loss.block < 0
    || !Number.isSafeInteger(loss.logIndex) || loss.logIndex < 0) throw new Error('recourse_loss_position_invalid');
  const lossMonth = utcCalendarMonth(loss.timestamp);
  let previous: PoolMembershipEvent | undefined;
  let joined: PoolMembershipEvent | undefined;
  for (const event of events) {
    if (!Number.isSafeInteger(event.block) || event.block < 0 || !Number.isSafeInteger(event.logIndex) || event.logIndex < 0
      || !Number.isSafeInteger(event.generation) || event.generation < 1 || !HASH.test(event.blockHash) || !HASH.test(event.transactionHash)
      || !before(event, loss) || event.timestamp > loss.timestamp || (event.block === loss.block && event.blockHash !== loss.blockHash)
      || (previous && (!before(previous, event) || event.timestamp < previous.timestamp
        || event.generation < previous.generation || (event.block === previous.block && event.blockHash !== previous.blockHash)))) {
      throw new Error('recourse_membership_history_invalid');
    }
    if (event.enrolled) {
      if (previous && event.generation <= previous.generation) throw new Error('recourse_membership_history_incomplete');
      joined = event;
    } else {
      if (!joined || event.generation !== joined.generation) throw new Error('recourse_membership_history_incomplete');
      joined = undefined;
    }
    previous = event;
  }
  let active = Boolean(joined), unpaid = 0n;
  const nonEarning: number[] = [];
  if (joined) {
    const startMonth = utcCalendarMonth(joined.timestamp);
    if (invoices.length !== lossMonth - startMonth) throw new Error('recourse_membership_invoices_incomplete');
    for (let i = 0; i < invoices.length; ++i) {
      const invoice = invoices[i];
      if (invoice.month !== startMonth + i || ![invoice.burnDue, invoice.contributionDue, invoice.burnPaid, invoice.contributionPaid]
        .every(value => /^(0|[1-9][0-9]*)$/.test(value))) throw new Error('recourse_membership_invoice_invalid');
      const burn = BigInt(invoice.burnDue) - BigInt(invoice.burnPaid);
      const reserve = BigInt(invoice.contributionDue) - BigInt(invoice.contributionPaid);
      if (burn < 0n || reserve < 0n) throw new Error('recourse_membership_invoice_invalid');
      unpaid += burn + reserve;
      if (!invoice.earnings) nonEarning.push(invoice.month);
      if (burn + reserve > 0n && invoice.month + 1 < lossMonth) active = false;
    }
  } else if (invoices.length !== 0) throw new Error('recourse_membership_invoice_invalid');
  const evidenceHash = `0x${createHash('sha256').update(JSON.stringify({ domain: 'provian calendar membership at loss', identity, events, invoices, loss })).digest('hex')}`;
  return { active, periodIndex: active && joined ? joined.generation - 1 : null,
    unpaidAtomic: unpaid.toString(), completedNonissuanceMonths: nonEarning, evidenceHash };
}
