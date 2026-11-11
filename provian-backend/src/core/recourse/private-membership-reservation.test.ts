import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { joinPrivateMembership, privateMembershipStatus, type PrivateCalendarRules } from './private-membership-calendar';
import { planPrivateDebit, planPrivateIssuance, reservePrivateMembership, commitPrivateMembershipReceipt,
  applyPrivateReservationReceipt, PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { MEMBERSHIP_RECEIPT_ABI } from './membership-receipt';
import { fixture, a, h, old, pointer } from './__test-helpers__/membership-receipt-fixture';
import { utcCalendarMonth } from './calendar-month';
import { RECOURSE_COLLECTIONS } from './ownership';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: {
  address: '0x0000000000000000000000000000000000000001', runtimeHash: require('ethers').keccak256('0x6000'),
} }));
const now = 1700000000, month = utcCalendarMonth(now);
const rules: PrivateCalendarRules = () => ({ ruleHash: h(9), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453,
  pointer, firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
const domain = { chainId: '8453', pointer, kernel: old[0], pool: old[8] };
const debit = (payer = a(3)) => ({ binding: h(2), payer, month: String(month), burn: '100', reserve: '0', nonce: '7', generation: '1',
  revision: '1', ruleHash: h(9), expiresAt: String(now + 300) });
const account = (): PrivateMembershipAccount => ({ ownerIdentity: h(500), version: 0, episode: joinPrivateMembership(null, month, rules),
  checkpoint: { pool: old[8], block: 99, blockHash: h(99) }, pendingReservation: null, needsScan: false });
const context = { batchId: h(600), lane: 0 as const, epoch: '1', policyHash: h(601), settlementDigest: h(602), revision: '1',
  month: String(month), membershipRuleHash: h(9) };
function store() {
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true });
  const key = `${C.owners}/${h(500)}`; fake.store.set(key, { ...account() });
  for (const n of [3, 4]) {
    const binding = n === 3 ? h(2) : h(4);
    fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/${a(n)}`, { identity: binding, address: a(n), ownerIdentity: h(500),
      kernel: old[0], chainBindingStatus: 'confirmed', recoveryGeneration: 0 });
    fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${binding}`, { identity: binding, ownerIdentity: h(500), recoveryGeneration: 0 });
  }
  return { fake, key, db: fake as unknown as Firestore,
    state: () => fake.store.get(key) as unknown as PrivateMembershipAccount };
}
function effects(f: ReturnType<typeof fixture>, name: string, args: readonly unknown[], index = 5): void {
  f.state.effects = [{ logIndex: `0x${index.toString(16)}`, ...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent(name)!, args) }];
}
test('one private owner lock prevents concurrent billing through a sibling address without crediting signatures', async () => {
  const s = store(), first = planPrivateDebit(s.state(), domain, debit(), month, rules);
  const sibling = planPrivateDebit(s.state(), domain, { ...debit(a(4)), binding: h(4) }, month, rules);
  await reservePrivateMembership(s.db, first); await reservePrivateMembership(s.db, first);
  await expect(reservePrivateMembership(s.db, sibling)).rejects.toThrow('concurrent');
  expect(s.state().episode.invoices[String(month)].burnPaidAtomic).toBe('0');
  expect(s.state().pendingReservation).toBe(first.id);
  expect(() => planPrivateDebit(s.state(), domain, debit(), month, rules)).toThrow('account');
  expect(() => planPrivateDebit(account(), domain, { ...debit(), burn: '101' }, month, rules)).toThrow('overcredit');
});
test('the same signed physical debit cannot be reserved for a different private owner', async () => {
  const s = store(), other = { ...account(), ownerIdentity: h(501) };
  s.fake.store.set(`${C.owners}/${other.ownerIdentity}`, other);
  const r = planPrivateDebit(other, domain, debit(), month, rules);
  await expect(reservePrivateMembership(s.db, r)).rejects.toThrow('ownership');
  expect(s.fake.store.get(`${C.owners}/${other.ownerIdentity}`)?.pendingReservation).toBeNull();
});
test('async caller mutation cannot alter the reserved signing bytes', async () => {
  const s = store(), r = planPrivateDebit(s.state(), domain, debit(), month, rules), expected = JSON.stringify(r);
  const running = reservePrivateMembership(s.db, r);
  Object.assign(r.debit, { burn: '99' });
  await running;
  expect(JSON.stringify(s.fake.store.get(`${C.reservations}/${r.id}`)?.reservation)).not.toContain('"burn":"99"');
  expect(s.fake.store.get(`${C.reservations}/${r.id}`)?.reservation).toEqual(JSON.parse(expected));
});
test('a finalized exact debit commits once and retains immutable before/after evidence', async () => {
  const s = store(), f = fixture(), r = planPrivateDebit(s.state(), domain, debit(), month, rules);
  await reservePrivateMembership(s.db, r);
  effects(f, 'MembershipDebitExecuted', [r.digest, r.debit.binding, r.debit.payer, month, 100, 0, 7]);
  const receipt = await f.read();
  await expect(commitPrivateMembershipReceipt(s.db, h(500), r.id, receipt, rules)).resolves.toBe('committed');
  await expect(commitPrivateMembershipReceipt(s.db, h(500), r.id, receipt, rules)).resolves.toBe('committed');
  expect(s.state()).toMatchObject({ version: 1, pendingReservation: null, needsScan: true });
  expect(s.state().episode.invoices[String(month)].burnPaidAtomic).toBe('100');
  expect([...s.fake.store.keys()].filter(k => k.startsWith(C.receipts + '/'))).toHaveLength(1);
  expect(() => planPrivateDebit(s.state(), domain, debit(), month, rules)).toThrow('account');
  // Status projection must not push the stored calendar past delayed receipts.
  privateMembershipStatus(s.state().episode, month + 10, rules);
  expect(s.state().episode.observedMonth).toBe(month);
});
test('a global effect fence prevents credit duplication even if private ownership metadata is later reassigned', async () => {
  const s = store(), f = fixture(), first = planPrivateDebit(s.state(), domain, debit(), month, rules);
  await reservePrivateMembership(s.db, first);
  const other = { ...account(), ownerIdentity: h(501) };
  s.fake.store.set(`${C.owners}/${h(501)}`, other);
  for (const key of [`${RECOURSE_COLLECTIONS.addresses}/${a(3)}`, `${RECOURSE_COLLECTIONS.identities}/${h(2)}`])
    s.fake.store.set(key, { ...s.fake.store.get(key), ownerIdentity: h(501) });
  const second = planPrivateDebit(other, domain, debit(), month, rules);
  await reservePrivateMembership(s.db, second);
  effects(f, 'MembershipDebitExecuted', [first.digest, first.debit.binding, first.debit.payer, month, 100, 0, 7]);
  const receipt = await f.read();
  await commitPrivateMembershipReceipt(s.db, h(500), first.id, receipt, rules);
  await expect(commitPrivateMembershipReceipt(s.db, h(501), second.id, receipt, rules)).rejects.toThrow('effect_replay');
  expect((s.fake.store.get(`${C.owners}/${h(501)}`)?.episode as PrivateMembershipAccount['episode']).invoices[String(month)].burnPaidAtomic).toBe('0');
});
test('a receipt-shaped object, wrong payer or wrong amount never credits the reserved debit', async () => {
  const s = store(), f = fixture(), r = planPrivateDebit(s.state(), domain, debit(), month, rules);
  await reservePrivateMembership(s.db, r);
  effects(f, 'MembershipDebitExecuted', [r.digest, r.debit.binding, a(4), month, 100, 0, 7]);
  let receipt = await f.read();
  expect(() => applyPrivateReservationReceipt(s.state(), r, { ...receipt }, rules)).toThrow('unverified');
  await expect(commitPrivateMembershipReceipt(s.db, h(500), r.id, receipt, rules)).rejects.toThrow('debit_effect');
  effects(f, 'MembershipDebitExecuted', [r.digest, r.debit.binding, r.debit.payer, month, 101, 0, 7]);
  receipt = await f.read();
  await expect(commitPrivateMembershipReceipt(s.db, h(500), r.id, receipt, rules)).rejects.toThrow('debit_effect');
  expect(s.state().episode.invoices[String(month)].burnPaidAtomic).toBe('0');
});
test('only an exact canonical cancellation releases a retained debit before selecting another payer', async () => {
  const s = store(), f = fixture(), r = planPrivateDebit(s.state(), domain, debit(), month, rules);
  await reservePrivateMembership(s.db, r);
  f.state.status = '0x0'; await expect(f.read()).rejects.toThrow();
  expect(s.state().pendingReservation).toBe(r.id);
  f.state.status = '0x1'; effects(f, 'MembershipDebitCancelled', [r.debit.binding, 6]);
  await expect(commitPrivateMembershipReceipt(s.db, h(500), r.id, await f.read(), rules)).rejects.toThrow('debit_effect');
  effects(f, 'MembershipDebitCancelled', [r.debit.binding, 7]);
  await expect(commitPrivateMembershipReceipt(s.db, h(500), r.id, await f.read(), rules)).resolves.toBe('cancelled');
  expect(s.state().episode.invoices[String(month)].burnPaidAtomic).toBe('0');
  // Stand in for the complete scanner, not an elapsed timeout or a status read.
  s.fake.store.set(s.key, { ...s.state(), needsScan: false, checkpoint: { pool: old[8], block: 100, blockHash: h(100) } });
  const replacement = planPrivateDebit(s.state(), domain, { ...debit(a(4)), binding: h(4), nonce: '0' }, month, rules);
  await reservePrivateMembership(s.db, replacement);
  await expect(commitPrivateMembershipReceipt(s.db, h(500), replacement.id, await f.read(), rules)).rejects.toThrow('state');
});
test('ordinary batch ordinals preserve exact private cross-address rounding without publishing owner totals', async () => {
  const s = store(), f = fixture(), r = planPrivateIssuance(s.state(), domain, context, [
    { ordinal: 0, occurrence: h(700), account: a(3), grossAtomic: '199', contributorAtomic: '199' },
    { ordinal: 2, occurrence: h(701), account: a(4), grossAtomic: '1', contributorAtomic: '1' },
  ], rules);
  expect(r.recipients.map(row => row.contributionAtomic)).toEqual(['1', '1']);
  await reservePrivateMembership(s.db, r);
  expect(s.state().episode.invoices[String(month)].earnings.grossAtomic).toBe('0');
  f.state.effects = [[0, a(3), 199, 1], [1, a(999), 100, 1], [2, a(4), 1, 1]].map((row, i) => ({
    logIndex: `0x${(5 + i).toString(16)}`, ...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('IssuanceTicketConsumed')!,
      [context.batchId, ...row, context.membershipRuleHash]),
  }));
  const receipt = await f.read();
  await expect(commitPrivateMembershipReceipt(s.db, h(500), r.id, receipt, rules)).resolves.toBe('committed');
  expect(s.state().episode.invoices[String(month)]).toMatchObject({ reserveDueAtomic: '2', reservePaidAtomic: '2',
    earnings: { grossAtomic: '200', remainder: 0 } });
  expect(JSON.stringify(receipt)).not.toContain(h(500));
});
test('signed or reverted issuance cannot release its private remainder; permanent batch cancellation can', async () => {
  const s = store(), f = fixture(), r = planPrivateIssuance(s.state(), domain, context, [
    { ordinal: 0, occurrence: h(700), account: a(3), grossAtomic: '199', contributorAtomic: '199' },
  ], rules);
  await reservePrivateMembership(s.db, r);
  const next = planPrivateIssuance(account(), domain, { ...context, batchId: h(603) }, [
    { ordinal: 0, occurrence: h(701), account: a(4), grossAtomic: '1', contributorAtomic: '1' },
  ], rules);
  await expect(reservePrivateMembership(s.db, next)).rejects.toThrow('concurrent');
  effects(f, 'IssuanceBatchCancelled', [context.batchId]);
  await expect(commitPrivateMembershipReceipt(s.db, h(500), r.id, await f.read(), rules)).resolves.toBe('cancelled');
  expect(s.state().episode.invoices[String(month)].earnings.grossAtomic).toBe('0');
});
