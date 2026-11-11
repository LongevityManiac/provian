import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { getAgreedBaseLogs } from '../onchain/economic-discovery';
import { readPrivateMembershipScan, commitPrivateMembershipScan } from './private-membership-scan';
import { fixture, a, h, old, pointer, tx } from './__test-helpers__/membership-receipt-fixture';
import { MEMBERSHIP_RECEIPT_ABI } from './membership-receipt';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS } from './ownership';
import { joinPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../onchain/economic-discovery', () => ({ getAgreedBaseLogs: jest.fn() }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: {
  address: '0x0000000000000000000000000000000000000001', runtimeHash: require('ethers').keccak256('0x6000'),
} }));
jest.mock('./chain-ledger', () => ({ createRecourseChainPort: () => ({
  finalizedBlock: async () => 100, blockHash: async (n: number) => `0x${n.toString(16).padStart(64, '0')}`,
}) }));
const rules: PrivateCalendarRules = () => ({ ruleHash: h(9), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453,
  pointer, firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
const key = `${C.owners}/${h(500)}`;
function setup() {
  const f = fixture(); f.state.priorRevision = 1; f.state.publications = []; f.state.effects = [];
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true });
  fake.store.set(key, { ownerIdentity: h(500), version: 2, pendingReservation: null, needsScan: true,
    checkpoint: { pool: old[8], block: 99, blockHash: h(99) }, episode: joinPrivateMembership(null, 24286, rules) });
  fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/${a(3)}`, { ownerIdentity: h(500), address: a(3), identity: h(2), recoveryGeneration: 0 });
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([]);
  return { f, fake, db: fake as unknown as Firestore };
}
function event(name: string, args: readonly unknown[], index = 5) {
  return { address: old[8], blockNumber: 100, blockHash: h(100), transactionHash: tx, transactionIndex: 0, logIndex: index, removed: false,
    ...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent(name)!, args) };
}
test('a complete unchanged range advances only the checkpoint, never the calendar clock', async () => {
  const s = setup(), before = s.fake.store.get(key)?.episode;
  const proof = await readPrivateMembershipScan(s.db, h(500));
  await expect(commitPrivateMembershipScan(s.db, { ...proof })).rejects.toThrow('unverified');
  await commitPrivateMembershipScan(s.db, proof);
  expect(s.fake.store.get(key)).toMatchObject({ version: 3, needsScan: false, checkpoint: { block: 100 }, episode: before });
  await expect(commitPrivateMembershipScan(s.db, proof)).rejects.toThrow('concurrent');
});
test('an omitted consent or debit cannot pass endpoint counters', async () => {
  const s = setup(); s.f.state.consentAfter = [2, 1, false]; s.f.state.debitNonceAfter = 8;
  await expect(readPrivateMembershipScan(s.db, h(500))).rejects.toThrow('history_gap');
  s.f.state.consentAfter = [1, 1, true];
  await expect(readPrivateMembershipScan(s.db, h(500))).rejects.toThrow('history_gap');
  expect(s.fake.store.get(key)?.needsScan).toBe(true);
});
test('real contract consent events carry the consumed nonce: join zero then departure one', async () => {
  const s = setup(); s.f.state.consentBefore = [0, 0, false]; s.f.state.consentAfter = [2, 1, false];
  s.f.state.debitNonceAfter = 8;
  const events = [event('AddressConsentChanged', [h(2), 1, true, 0]), event('AddressConsentChanged', [h(2), 1, false, 1], 6)];
  s.f.state.effects = events.map(e => ({ logIndex: `0x${e.logIndex.toString(16)}`, topics: e.topics, data: e.data }));
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue(events);
  const proof = await readPrivateMembershipScan(s.db, h(500));
  expect(proof.receipts).toHaveLength(1);
  await expect(commitPrivateMembershipScan(s.db, proof)).rejects.toThrow('uncredited_effect');
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([event('AddressConsentChanged', [h(2), 1, true, 1]), events[1]]);
  await expect(readPrivateMembershipScan(s.db, h(500))).rejects.toThrow('history_gap');
});
test('actual debit effects require their globally unique durable credit before catchup can finish', async () => {
  const s = setup(), e = event('MembershipDebitExecuted', [h(1), h(2), a(3), 24286, 100, 0, 7]);
  s.f.state.debitNonceAfter = 8; s.f.state.effects = [{ logIndex: '0x5', topics: e.topics, data: e.data }];
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([e]);
  const proof = await readPrivateMembershipScan(s.db, h(500));
  expect(proof.receipts).toHaveLength(1);
  await expect(commitPrivateMembershipScan(s.db, proof)).rejects.toThrow('uncredited_effect');
  const id = `0x${createHash('sha256').update(JSON.stringify([old[0], old[8], tx, 5])).digest('hex')}`;
  s.fake.store.set(`${C.effects}/${id}`, { ownerIdentity: h(500) });
  await commitPrivateMembershipScan(s.db, proof);
  expect(s.fake.store.get(key)?.needsScan).toBe(false);
});
test('pending signed issuance, concurrent account changes and changed portfolio all prevent checkpoint advance', async () => {
  const s = setup(), proof = await readPrivateMembershipScan(s.db, h(500)), original = s.fake.store.get(key)!;
  s.fake.store.set(key, { ...original, pendingReservation: h(900) });
  await expect(commitPrivateMembershipScan(s.db, proof)).rejects.toThrow('concurrent');
  s.fake.store.set(key, { ...original, version: 3 });
  await expect(commitPrivateMembershipScan(s.db, proof)).rejects.toThrow('concurrent');
  s.fake.store.set(key, original);
  s.fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/${a(4)}`, { ownerIdentity: h(500), address: a(4), identity: h(4), recoveryGeneration: 0 });
  await expect(commitPrivateMembershipScan(s.db, proof)).rejects.toThrow('concurrent');
});
test('out of order and wrong-nonce events refuse even when an endpoint increment matches', async () => {
  const s = setup(); s.f.state.debitNonceAfter = 8;
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([event('MembershipDebitCancelled', [h(2), 8])]);
  await expect(readPrivateMembershipScan(s.db, h(500))).rejects.toThrow('history_gap');
  (getAgreedBaseLogs as jest.Mock).mockResolvedValue([event('MembershipDebitCancelled', [h(2), 7]), event('MembershipDebitCancelled', [h(2), 8], 4)]);
  await expect(readPrivateMembershipScan(s.db, h(500))).rejects.toThrow('log_order');
});
test('a pointer change requires succession replay rather than carrying an unrelated pool checkpoint', async () => {
  const s = setup(); s.f.state.endRevision = 2;
  await expect(readPrivateMembershipScan(s.db, h(500))).rejects.toThrow('succession_required');
});

test('a scan captured before atomic binding cannot clear its later confirmation freeze', async () => {
  const s = setup(), proof = await readPrivateMembershipScan(s.db, h(500));
  const ownerKey = `${RECOURSE_COLLECTIONS.owners}/${h(500)}`, addressKey = `${RECOURSE_COLLECTIONS.addresses}/${a(3)}`;
  s.fake.store.set(ownerKey, { ownerIdentity: h(500), membershipScanRequired: true });
  s.fake.store.set(addressKey, { ...s.fake.store.get(addressKey), chainBindingStatus: 'confirmed', boundBlock: 101, boundBlockHash: h(101) });
  await expect(commitPrivateMembershipScan(s.db, proof)).rejects.toThrow('concurrent');
  expect(s.fake.store.get(ownerKey)?.membershipScanRequired).toBe(true);
  await expect(readPrivateMembershipScan(s.db, h(500))).rejects.toThrow('checkpoint');
});

test('an explicit finalized old-domain cutoff can reconcile after a pointer change without clearing a newer binding freeze', async () => {
  const s = setup(); s.f.state.endRevision = 2;
  const ownerKey = `${RECOURSE_COLLECTIONS.owners}/${h(500)}`;
  s.fake.store.set(ownerKey, { ownerIdentity: h(500), membershipScanRequired: true });
  const proof = await readPrivateMembershipScan(s.db, h(500), { pool: old[8], block: 99, blockHash: h(99) });
  expect(proof.historical).toBe(true); await commitPrivateMembershipScan(s.db, proof);
  expect(s.fake.store.get(key)).toMatchObject({ needsScan: true, checkpoint: { block: 99 } });
  expect(s.fake.store.get(ownerKey)?.membershipScanRequired).toBe(true);
  await expect(readPrivateMembershipScan(s.db, h(500), { pool: old[8], block: 101, blockHash: h(101) })).rejects.toThrow('checkpoint');
  await expect(readPrivateMembershipScan(s.db, h(500), { pool: old[8], block: 99, blockHash: h(98) })).rejects.toThrow('reorg');
});
