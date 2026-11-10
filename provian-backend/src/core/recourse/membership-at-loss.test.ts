import { membershipAtLoss, type PoolMembershipEvent, type HistoricalMonthlyInvoice } from './membership-at-loss';
import { utcCalendarMonth } from './calendar-month';
const identity = `0x${'11'.repeat(32)}`, blockHash = `0x${'22'.repeat(32)}`, transactionHash = `0x${'33'.repeat(32)}`;
const time = (s: string) => Date.parse(s) / 1000;
const jan = time('2026-01-01'), feb = time('2026-02-01'), mar = time('2026-03-01');
const point = (block: number, timestamp: number, logIndex = 0) => ({ block, timestamp, logIndex, blockHash, transactionHash });
const enrolled: PoolMembershipEvent = { ...point(1, jan), enrolled: true, generation: 1 };
const invoice = (timestamp: number, changes: Partial<HistoricalMonthlyInvoice> = {}): HistoricalMonthlyInvoice => ({
  month: utcCalendarMonth(timestamp), burnDue: '100', contributionDue: '100', burnPaid: '0', contributionPaid: '0', earnings: false, ...changes });
test('one calendar month of grace expires without keeper or forced closure', () => {
  expect(membershipAtLoss(identity, [enrolled], point(100, feb), [invoice(jan)])).toMatchObject({ active: true, periodIndex: 0, unpaidAtomic: '200' });
  expect(membershipAtLoss(identity, [enrolled], point(100, mar), [invoice(jan), invoice(feb)])).toMatchObject({ active: false, periodIndex: null });
});
test('each completed month requires separate burn and contribution even when earning', () => {
  const earned = invoice(jan, { earnings: true, contributionDue: '10', contributionPaid: '10' });
  expect(membershipAtLoss(identity, [enrolled], point(100, mar), [earned, invoice(feb)]).active).toBe(false);
  expect(membershipAtLoss(identity, [enrolled], point(100, mar), [{ ...earned, burnPaid: '100' }, invoice(feb)]).active).toBe(true);
  const noEarningsBurnOnly = invoice(jan, { burnPaid: '100' });
  expect(membershipAtLoss(identity, [enrolled], point(100, mar), [noEarningsBurnOnly, invoice(feb)]).active).toBe(false);
});
test('same-block membership closure and prospective rejoin use exact event order', () => {
  const closed: PoolMembershipEvent = { ...point(100, feb, 2), enrolled: false, generation: 1 };
  expect(membershipAtLoss(identity, [enrolled, closed], point(100, feb, 3), []).active).toBe(false);
  expect(membershipAtLoss(identity, [enrolled], point(100, feb, 1), [invoice(jan)]).active).toBe(true);
  expect(() => membershipAtLoss(identity, [enrolled, closed], point(100, feb, 1), [])).toThrow('history_invalid');
  const reopened = { ...point(101, mar), enrolled: true, generation: 2 };
  expect(membershipAtLoss(identity, [enrolled, closed, reopened], point(102, mar), [])).toMatchObject({ active: true, periodIndex: 1 });
});
test('missing invoices, duplicate events, overpayments and inconsistent block hashes fail closed', () => {
  expect(() => membershipAtLoss(identity, [enrolled], point(100, feb), [])).toThrow('invoices_incomplete');
  expect(() => membershipAtLoss(identity, [enrolled, enrolled], point(100, feb), [invoice(jan)])).toThrow('history_invalid');
  expect(() => membershipAtLoss(identity, [enrolled], point(100, feb), [invoice(jan, { burnPaid: '101' })])).toThrow('invoice_invalid');
  expect(() => membershipAtLoss(identity, [enrolled, { ...point(100, feb, 1), blockHash: identity, enrolled: false, generation: 1 }], point(100, feb, 2), [])).toThrow('history_invalid');
});
