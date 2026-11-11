import { joinPrivateMembership, creditPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { projectPrivateMembershipView } from './private-membership-view';
import type { PrivateMembershipAccount } from './private-membership-reservation';
const rules: PrivateCalendarRules = () => ({ ruleHash: `0x${'12'.repeat(32)}`, rule: {
  schema: 'provian-recourse-membership/v1', chainId: 8453, pointer: `0x${'34'.repeat(20)}`, firstMonth: 0,
  participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100,
} });
const account = (): PrivateMembershipAccount => ({ ownerIdentity: `0x${'56'.repeat(32)}`, version: 1,
  checkpoint: { pool: `0x${'78'.repeat(20)}`, block: 100, blockHash: `0x${'9a'.repeat(32)}` },
  needsScan: false, pendingReservation: null, episode: joinPrivateMembership(null, 100, rules) });
test('membership, grace and amounts derive from the private calendar without publishing owner keys or advancing stored time', () => {
  const state = account(), original = JSON.stringify(state);
  expect(projectPrivateMembershipView(state, 100, rules)).toMatchObject({ enrolled: true, grace: false, unpaidAtomic: '100' });
  expect(projectPrivateMembershipView(state, 101, rules)).toMatchObject({ enrolled: true, grace: true, unpaidAtomic: '300', endMonthExclusive: '102' });
  const expired = projectPrivateMembershipView(state, 102, rules);
  expect(expired).toMatchObject({ enrolled: false, grace: false, unpaidAtomic: '0', endMonthExclusive: '102' });
  expect(JSON.stringify(expired)).not.toContain(state.ownerIdentity);
  expect(JSON.stringify(state)).toBe(original);
});
test('the burn and no-earnings contribution are separate; paying only the burn does not erase the reserve obligation', () => {
  const state = account();
  const paid = { ...state, episode: creditPrivateMembership(state.episode, 100, 100, { burnAtomic: '100', reserveAtomic: '0' }, rules) };
  expect(projectPrivateMembershipView(paid, 100, rules).unpaidAtomic).toBe('0');
  expect(projectPrivateMembershipView(paid, 101, rules)).toMatchObject({ enrolled: true, grace: true, unpaidAtomic: '200' });
});
