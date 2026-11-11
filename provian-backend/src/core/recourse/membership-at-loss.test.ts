import { privateMembershipAtLoss } from './membership-at-loss';
import { joinPrivateMembership, leavePrivateMembership, creditPrivateMembership, type PrivateMembershipEpisode, type PrivateCalendarRules } from './private-membership-calendar';
import { membershipJournalHash, type MembershipJournalEntry } from './private-membership-journal';
import { utcCalendarMonth } from './calendar-month';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const jan = Date.UTC(2026, 0, 1) / 1000, feb = Date.UTC(2026, 1, 1) / 1000, mar = Date.UTC(2026, 2, 1) / 1000;
const month = utcCalendarMonth(jan);
const rules: PrivateCalendarRules = () => ({ ruleHash: h(1), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453,
  pointer: a(1), firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
const point = (block: number, timestamp: number, logIndex = 0) => ({ chainId: '8453' as const, kernel: a(1), pool: a(2), block, blockHash: h(block), timestamp, logIndex });
const entry = (episode: PrivateMembershipEpisode, block: number, timestamp: number, logIndex = 0, salt = h(77)): MembershipJournalEntry => {
  const body = { ownerIdentity: h(9), previousId: null, salt, kind: 'admission' as const, beforeEpisodeHash: membershipJournalHash(null), episode,
    position: point(block, timestamp, logIndex), evidenceId: h(8) };
  return { id: membershipJournalHash(body), ...body };
};
const consent = { generation: 3, active: true, admissionLogIndex: 0, closureLogIndex: 0 };
const joined = () => joinPrivateMembership(null, month, rules);
test('one month grace expires without a keeper and public period uses address generation', () => {
  const history = [entry(joined(), 1, jan)];
  expect(privateMembershipAtLoss(h(5), history, point(50, feb), consent, rules)).toMatchObject({ active: true, periodIndex: 2, unpaidAtomic: '200' });
  expect(privateMembershipAtLoss(h(5), history, point(80, mar), consent, rules)).toMatchObject({ active: false, periodIndex: null });
});
test('later payment cannot change earlier loss evidence, but a timely prior payment does qualify', () => {
  const admitted = entry(joined(), 1, jan), paid = creditPrivateMembership(joined(), month + 1, month,
    { burnAtomic: '100', reserveAtomic: '100' }, rules);
  const loss = point(100, mar), before = privateMembershipAtLoss(h(5), [admitted], loss, consent, rules);
  expect(privateMembershipAtLoss(h(5), [admitted, entry(paid, 101, mar)], loss, consent, rules)).toEqual(before);
  expect(privateMembershipAtLoss(h(5), [admitted, entry(paid, 99, feb)], loss, consent, rules).active).toBe(true);
});
test('exact same-block order excludes the loss position itself and later admission, closure and rejoin', () => {
  const closed = leavePrivateMembership(joined(), month + 1, rules), rejoined = joinPrivateMembership(closed, month + 1, rules);
  const history = [entry(joined(), 1, jan), entry(closed, 50, feb, 2), entry(rejoined, 50, feb, 4)];
  expect(privateMembershipAtLoss(h(5), history, point(50, feb, 2), consent, rules).active).toBe(true);
  expect(privateMembershipAtLoss(h(5), history, point(50, feb, 3), consent, rules).active).toBe(false);
  expect(privateMembershipAtLoss(h(5), history, point(50, feb, 4), consent, rules).active).toBe(false);
  expect(privateMembershipAtLoss(h(5), history, point(50, feb, 5), consent, rules).active).toBe(true);
});
test('public single-address consent is required and a future rejoin cannot qualify a lapsed loss', () => {
  const history = [entry(joined(), 1, jan), entry(joinPrivateMembership(joined(), month + 2, rules), 100, mar, 5)];
  expect(privateMembershipAtLoss(h(5), history, point(100, mar, 4), consent, rules).active).toBe(false);
  expect(privateMembershipAtLoss(h(5), history, point(100, mar, 6), { ...consent, active: false }, rules).active).toBe(false);
  expect(privateMembershipAtLoss(h(5), [], point(100, mar, 6), consent, rules).active).toBe(false);
});
test('private random salt blinds identical calendar commitments; mismatched chain domain or position refuses', () => {
  const loss = point(50, feb), first = privateMembershipAtLoss(h(5), [entry(joined(), 1, jan)], loss, consent, rules);
  const second = privateMembershipAtLoss(h(5), [entry(joined(), 1, jan, 0, h(78))], loss, consent, rules);
  expect(first.evidenceHash).not.toBe(second.evidenceHash);
  expect(() => privateMembershipAtLoss(h(5), [entry(joined(), 1, jan)], { ...loss, kernel: a(3) }, consent, rules)).toThrow('history_invalid');
  expect(() => privateMembershipAtLoss(h(5), [entry(joined(), 50, feb, 1)], { ...loss, logIndex: 2, blockHash: h(3) }, consent, rules)).toThrow('history_invalid');
});
