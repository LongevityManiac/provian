import { expect, test } from 'vitest';
import { membershipIssuanceDigest, parseMembershipIssuanceContext, parseMembershipIssuanceTickets } from './recourse-issuance-ticket';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const domain = { chainId: '8453', pointer: a(1), kernel: a(2), pool: a(3) };
const context = { batchId: h(1), lane: 0 as const, epoch: '1', policyHash: h(2), settlementDigest: h(3),
  revision: '1', month: '100', membershipRuleHash: h(4) };
const tickets = [{ account: a(5), gross: '199', contributor: '198', contribution: '1', consentNonce: '1', protectedMember: true },
  { account: a(6), gross: '1', contributor: '1', contribution: '1', consentNonce: '1', protectedMember: true }];
test('ticket signature binds exact batch, deployment, original kernel digest and recipient order', () => {
  const digest = membershipIssuanceDigest(domain, context, tickets);
  expect(membershipIssuanceDigest(domain, context, [...tickets].reverse())).not.toBe(digest);
  expect(membershipIssuanceDigest(domain, context, [tickets[0]])).not.toBe(digest);
  for (const key of ['batchId', 'policyHash', 'settlementDigest', 'membershipRuleHash'] as const)
    expect(membershipIssuanceDigest(domain, { ...context, [key]: h(99) }, tickets)).not.toBe(digest);
  for (const key of ['epoch', 'revision', 'month'] as const)
    expect(membershipIssuanceDigest(domain, { ...context, [key]: String(BigInt(context[key]) + 1n) }, tickets)).not.toBe(digest);
  expect(membershipIssuanceDigest(domain, { ...context, lane: 1 }, tickets)).not.toBe(digest);
  for (const key of ['pointer', 'kernel', 'pool'] as const)
    expect(membershipIssuanceDigest({ ...domain, [key]: a(99) }, context, tickets)).not.toBe(digest);
});
test('exact per-recipient amounts, eligibility and consent nonce cannot be swapped', () => {
  const digest = membershipIssuanceDigest(domain, context, tickets);
  for (const patch of [{ contribution: '2' }, { contributor: '197' }, { gross: '200' }, { account: a(8) },
    { consentNonce: '2' }, { protectedMember: false, contribution: '0' }])
    expect(membershipIssuanceDigest(domain, context, [{ ...tickets[0], ...patch }, tickets[1]])).not.toBe(digest);
});
test('private owner fields, bad arithmetic, empty populations, sparse arrays and integer aliases refuse', () => {
  for (const extra of [{ owner: 'private' }, { invoice: 'private' }, { ownerGross: '200' }, { remainder: 99 }])
    expect(() => parseMembershipIssuanceTickets([{ ...tickets[0], ...extra }])).toThrow('invalid');
  for (const bad of [[], new Array(1), [{ ...tickets[0], contributor: '200' }], [{ ...tickets[0], contribution: '199' }],
    [{ ...tickets[0], gross: '0199' }], [{ ...tickets[0], protectedMember: false }], [{ ...tickets[0], consentNonce: -1 }]])
    expect(() => parseMembershipIssuanceTickets(bad)).toThrow('invalid');
  expect(() => parseMembershipIssuanceContext({ ...context, epoch: String(1n << 64n) })).toThrow('invalid');
  expect(() => parseMembershipIssuanceContext({ ...context, revision: '0' })).toThrow('invalid');
  expect(() => parseMembershipIssuanceContext({ ...context, owner: 'private' })).toThrow('invalid');
});
