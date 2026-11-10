import { readFileSync } from 'fs';
import { resolve } from 'path';
import { signTestSshApproval } from '../../__test-helpers__/ssh-approval';
import { parseRecourseMembershipRule, recourseMembershipRuleHash, recourseMembershipSigningBytes,
  verifyRecourseMembershipRule, assertRecourseRuleTuple } from './membership-rule';
const pointer = `0x${'11'.repeat(20)}`;
const source: unknown = JSON.parse(readFileSync(resolve(__dirname, '../../../../config/recourse-membership-rule.json'), 'utf8'));
const rule = parseRecourseMembershipRule({ ...(source as object), pointer });
function fixture() {
  const { signature, config } = signTestSshApproval(recourseMembershipSigningBytes(rule));
  return { config, record: { rule, ruleHash: recourseMembershipRuleHash(rule), signature } };
}
test('the actual release amounts are signed together and match every contract field', () => {
  const { record, config } = fixture();
  const verified = verifyRecourseMembershipRule(record, pointer, config);
  const tuple = { firstMonth: BigInt(rule.firstMonth), participationBurn: BigInt(rule.participationBurnAtomic),
    noEarningsContribution: BigInt(rule.noEarningsContributionAtomic), earningsBps: BigInt(rule.earningsBps), signedRuleHash: record.ruleHash };
  assertRecourseRuleTuple(verified, tuple);
  for (const field of ['firstMonth', 'participationBurn', 'noEarningsContribution', 'earningsBps'] as const) {
    expect(() => assertRecourseRuleTuple(verified, { ...tuple, [field]: tuple[field] + 1n })).toThrow('chain_mismatch');
  }
  expect(() => assertRecourseRuleTuple(verified, { ...tuple, signedRuleHash: `0x${'22'.repeat(32)}` })).toThrow('chain_mismatch');
});
test('changing any amount, time or pointer invalidates a genuine signature, even with a recomputed hash', () => {
  const { record, config } = fixture();
  for (const changed of [{ ...rule, participationBurnAtomic: '101' }, { ...rule, noEarningsContributionAtomic: '101' },
    { ...rule, earningsBps: 101 }, { ...rule, firstMonth: 1 }, { ...rule, pointer: `0x${'22'.repeat(20)}` }]) {
    expect(() => verifyRecourseMembershipRule({ ...record, rule: changed, ruleHash: recourseMembershipRuleHash(changed) }, pointer, config)).toThrow('unverified');
  }
  expect(() => verifyRecourseMembershipRule(record, pointer, fixture().config)).toThrow('unverified');
  expect(() => verifyRecourseMembershipRule(record, pointer, null)).toThrow('unverified');
});
test('missing pointer, noncanonical amounts, extra fields and impossible contract values are refused', () => {
  expect(() => parseRecourseMembershipRule({ ...(source as object), pointer: null })).toThrow('invalid');
  for (const value of ['01', '-1', '1e18', (2n ** 256n).toString()]) {
    expect(() => parseRecourseMembershipRule({ ...rule, participationBurnAtomic: value })).toThrow('invalid');
  }
  expect(() => parseRecourseMembershipRule({ ...rule, earningsBps: 10001 })).toThrow('invalid');
  expect(() => parseRecourseMembershipRule({ ...rule, unrelated: true })).toThrow('invalid');
});
