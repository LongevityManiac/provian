import { assessPrivateMembership, creditPrivateMembership, joinPrivateMembership, leavePrivateMembership,
  privateMembershipStatus, recordPrivateMembershipIssuance, type PrivateCalendarRules } from './private-membership-calendar';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const rules: PrivateCalendarRules = () => ({ ruleHash: h(1), rule: {
  schema: 'provian-recourse-membership/v1', chainId: 8453, pointer: `0x${'11'.repeat(20)}`, firstMonth: 0,
  participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100,
} });
const row = (n: number, gross: string, contributor = gross) => ({ occurrence: h(n),
  account: `0x${n.toString(16).padStart(40, '0')}`, grossAtomic: gross, contributorAtomic: contributor });
const start = () => joinPrivateMembership(null, 10, rules);

test('both monthly obligations apply; no earnings becomes a reserve obligation only at month close', () => {
  const joined = start();
  expect(joined.invoices['10']).toMatchObject({ burnDueAtomic: '100', reserveDueAtomic: '0' });
  expect(() => creditPrivateMembership(joined, 10, 10, { burnAtomic: '0', reserveAtomic: '100' }, rules)).toThrow('overcredit');
  const burned = creditPrivateMembership(joined, 10, 10, { burnAtomic: '100', reserveAtomic: '0' }, rules);
  expect(privateMembershipStatus(burned, 11, rules)).toEqual({ protectedNow: true, grace: true, endMonthExclusive: 12 });
  const paid = creditPrivateMembership(burned, 11, 10, { burnAtomic: '0', reserveAtomic: '100' }, rules);
  expect(privateMembershipStatus(paid, 11, rules)).toEqual({ protectedNow: true, grace: false, endMonthExclusive: null });
  expect(paid.invoices['11'].burnDueAtomic).toBe('100');
  expect(() => creditPrivateMembership(paid, 11, 10, { burnAtomic: '0', reserveAtomic: '1' }, rules)).toThrow('overcredit');
});

test('late keeper preserves the original deadline and neither late payment nor issuance can revive it', () => {
  const joined = start(), late = assessPrivateMembership(joined, 1000, rules);
  expect(late).toMatchObject({ joined: false, endMonthExclusive: 12 });
  expect(Object.keys(late.invoices)).toEqual(['10', '11']);
  expect(privateMembershipStatus(joined, 12, rules).protectedNow).toBe(false);
  expect(() => creditPrivateMembership(joined, 12, 10, { burnAtomic: '100', reserveAtomic: '100' }, rules)).toThrow('lapsed');
  expect(() => recordPrivateMembershipIssuance(joined, 12, [row(1, '100')], rules)).toThrow('lapsed');
  const onTime = assessPrivateMembership(assessPrivateMembership(joined, 11, rules), 12, rules);
  expect(late.invoices).toEqual(onTime.invoices);
  expect(() => joinPrivateMembership(late, 999, rules)).toThrow('rollback');
});

test('same-month leave and rejoin preserves burn credits, exact earnings and fractional remainder', () => {
  const paid = creditPrivateMembership(start(), 10, 10, { burnAtomic: '100', reserveAtomic: '0' }, rules);
  const earned = recordPrivateMembershipIssuance(paid, 10, [row(1, '199')], rules);
  const rejoined = joinPrivateMembership(leavePrivateMembership(earned.state, 10, rules), 10, rules);
  expect(rejoined.generation).toBe(2);
  expect(rejoined.invoices['10']).toEqual(earned.state.invoices['10']);
  const next = recordPrivateMembershipIssuance(rejoined, 10, [row(2, '1')], rules);
  expect(next.contributions[0].contributionAtomic).toBe('1');
  expect(next.state.invoices['10']).toMatchObject({ burnPaidAtomic: '100', reserveDueAtomic: '2', reservePaidAtomic: '2' });
  expect(() => creditPrivateMembership(rejoined, 10, 10, { burnAtomic: '1', reserveAtomic: '0' }, rules)).toThrow('overcredit');
});

test('voluntary leave and rejoin cannot erase a still-payable prior month or extend its grace', () => {
  const left = leavePrivateMembership(start(), 10, rules);
  const rejoined = joinPrivateMembership(left, 11, rules);
  expect(rejoined).toMatchObject({ generation: 2, startMonth: 10, admissionMonth: 11, firstUnpaidMonth: 10 });
  expect(privateMembershipStatus(rejoined, 11, rules).grace).toBe(true);
  expect(privateMembershipStatus(rejoined, 12, rules).protectedNow).toBe(false);
  const cured = creditPrivateMembership(rejoined, 11, 10, { burnAtomic: '100', reserveAtomic: '100' }, rules);
  expect(privateMembershipStatus(cured, 11, rules).grace).toBe(false);
});

test('rejoin after expiry opens new protection without accepting a catch-up payment', () => {
  const rejoined = joinPrivateMembership(start(), 12, rules);
  expect(rejoined).toMatchObject({ generation: 2, startMonth: 12, admissionMonth: 12 });
  expect(privateMembershipStatus(rejoined, 12, rules).protectedNow).toBe(true);
  expect(Object.keys(rejoined.invoices)).toEqual(['12']);
  expect(() => creditPrivateMembership(rejoined, 12, 10, { burnAtomic: '100', reserveAtomic: '100' }, rules)).toThrow('lapsed');
  expect(() => joinPrivateMembership(rejoined, 12, rules)).toThrow('already_joined');
});

test('two addresses contribute on exact owner-wide gross while immutable contributor allocations remain intact', () => {
  const first = recordPrivateMembershipIssuance(start(), 10, [row(1, '199')], rules);
  const next = recordPrivateMembershipIssuance(first.state, 10, [row(2, '1')], rules);
  expect(next.state.invoices['10'].earnings).toMatchObject({ grossAtomic: '200', dueAtomic: '2', paidAtomic: '2', remainder: 0 });
  expect(next.state.invoices['10'].burnDueAtomic).toBe('100');
  const high: PrivateCalendarRules = m => { const r = rules(m); return { ...r, rule: { ...r.rule, earningsBps: 10000 } }; };
  const clipped = recordPrivateMembershipIssuance(joinPrivateMembership(null, 10, high), 10, [row(3, '10000', '9900')], high);
  expect(clipped.state.invoices['10']).toMatchObject({ reserveDueAtomic: '10000', reservePaidAtomic: '9900' });
  expect(clipped.contributions[0].contributionAtomic).toBe('9900');
});

test('prospective rule changes never rewrite an existing invoice or create a second same-month burn', () => {
  const changed: PrivateCalendarRules = m => { const r = rules(m); return m < 11 ? r : { ruleHash: h(2),
    rule: { ...r.rule, firstMonth: 11, participationBurnAtomic: '125', noEarningsContributionAtomic: '150', earningsBps: 200 } }; };
  const next = assessPrivateMembership(start(), 11, changed);
  expect(next.invoices['10']).toMatchObject({ burnDueAtomic: '100', reserveDueAtomic: '100', ruleHash: h(1) });
  expect(next.invoices['11']).toMatchObject({ burnDueAtomic: '125', ruleHash: h(2) });
  expect(() => assessPrivateMembership(start(), 9, rules)).toThrow('rollback');
});

test('zero prospective amounts do not manufacture unpaid months; projections assess the actual rules', () => {
  const free: PrivateCalendarRules = m => { const r = rules(m); return { ...r, rule: { ...r.rule,
    participationBurnAtomic: '0', noEarningsContributionAtomic: '0', earningsBps: 0 } }; };
  const joined = joinPrivateMembership(null, 10, free);
  expect(privateMembershipStatus(joined, 30, free)).toEqual({ protectedNow: true, grace: false, endMonthExclusive: null });
  expect(joined.lastAssessedMonth).toBe(10);
  expect(Object.keys(joined.invoices)).toEqual(['10']);
});
