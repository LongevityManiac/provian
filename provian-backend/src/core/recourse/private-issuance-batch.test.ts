import { joinPrivateMembership } from './private-membership-calendar';
import { planPrivateIssuance, type PrivateMembershipAccount } from './private-membership-reservation';
import { seedMembershipJournal } from './__test-helpers__/membership-journal-fixture';
import { Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { KERNEL_SETTLEMENT_ABI } from '../pvt/wp4/settlement-cycle-runner';
import { SETTLEMENT_BATCHES_COLLECTION, SETTLEMENT_BATCH_SCHEMA, type SettlementBatchDoc } from '../pvt/wp4/durable-settlement-store';
import { fixture, a, h, old, pointer } from './__test-helpers__/membership-receipt-fixture';
import { planSettlementIssuance } from './settlement-issuance';
import { privateIssuanceBatchId, reservePrivateIssuanceBatch, retainPrivateIssuanceSignature,
  commitPrivateIssuanceBatch, type PrivateIssuanceBatch } from './private-issuance-batch';
import { PRIVATE_ISSUANCE_ADDRESSES, PRIVATE_ISSUANCE_BATCHES } from './issuance-lock';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { membershipJournalHash } from './private-membership-journal';
import { MEMBERSHIP_RECEIPT_ABI } from './membership-receipt';
import { MEMBER_SETTLEMENT_ABI } from './issuance-ticket';
import { utcCalendarMonth } from './calendar-month';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: {
  address: '0x0000000000000000000000000000000000000001', runtimeHash: require('ethers').keccak256('0x6000'),
} }));
function setup() {
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true }), db = fake as unknown as Firestore;
  const calldata = new Interface(KERNEL_SETTLEMENT_ABI).encodeFunctionData('settleStandardPEBatch', [h(600), 1, h(601), 0, 2,
    [[a(3), 1, 1], [a(4), 1, 1]], [[h(700), 100], [h(701), 100]]]);
  const parent: SettlementBatchDoc = { schema_version: SETTLEMENT_BATCH_SCHEMA, batch_id: h(600), cycle_id: 'cycle', lane: 'standard', epoch: 1,
    policy_hash: h(601), cursor_start: '0', cursor_end: '2', recipient_count: 2, claim_count: 2, total_minted_atomic: '199', reserved_nonce: 0, calldata,
    members: [700, 701].map(n => ({ pe_id: String(n), leg: 'sole', claim_id: h(n) })), status: 'reserved', dead_reason: null,
    attempts: [], confirmed_tx_hash: null, confirmed_fee_wei: null, applied: false, writebacks_complete: false, created_at: 0, updated_at: 0 };
  fake.store.set(`${SETTLEMENT_BATCHES_COLLECTION}/${h(600)}`, { ...parent });
  const policy = { kernel: old[0], epoch: '1', policyHash: h(601), mintRateAtomic: '1000000000000000000', agentFoundationBps: '50' };
  const plan = planSettlementIssuance(parent, policy), record = { ownerIdentity: h(500), address: a(3), identity: h(3), kernel: old[0], chainBindingStatus: 'confirmed', recoveryGeneration: 0 };
  fake.store.set(`${R.addresses}/${a(3)}`, record); fake.store.set(`${R.owners}/${h(500)}`, { ownerIdentity: h(500) });
  const batch: PrivateIssuanceBatch = { id: privateIssuanceBatchId(old[0], h(600)), domain: { chainId: '8453', pointer, kernel: old[0], pool: old[8] },
    context: { batchId: h(600), lane: 0, epoch: '1', policyHash: h(601), settlementDigest: plan.settlementDigest,
      revision: '1', month: String(utcCalendarMonth(1700000000)), membershipRuleHash: h(9) }, policy, kernelCall: calldata, target: old[9],
    checkpoint: { block: 99, blockHash: h(99) }, tickets: plan.recipients.map(r => ({ account: r.account, gross: r.grossAtomic,
      contributor: r.contributorAtomic, contribution: '0', consentNonce: '0', protectedMember: false })), reservations: [],
    unadmitted: [{ ordinal: 0, ownerIdentity: h(500), addressRecordHash: membershipJournalHash(record) }, { ordinal: 1, ownerIdentity: null, addressRecordHash: null }] };
  const f = fixture(); f.state.batchDigest = plan.settlementDigest;
  const issuance = () => { f.state.effects = batch.tickets.map((t, i) => ({ logIndex: `0x${(i + 5).toString(16)}`,
    ...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('IssuanceTicketConsumed')!, [h(600), i, t.account, t.gross, t.contribution, h(9)]) })); };
  const rules = () => { throw Error('unadmitted recipients must not create an invoice'); };
  return { fake, db, batch, parent, f, issuance, rules };
}
test('all recipients, including unregistered and never-joined payees, reserve before immutable outer bytes are retained', async () => {
  const s = setup();
  expect((await reservePrivateIssuanceBatch(s.db, s.batch)).status).toBe('reserved');
  const signed = await retainPrivateIssuanceSignature(s.db, s.batch, '0x1234');
  const decoded = MEMBER_SETTLEMENT_ABI.decodeFunctionData('settleMemberBatch', signed.calldata!);
  expect(decoded[0]).toBe(s.parent.calldata);
  expect(decoded[2]).toHaveLength(2);
  expect((await retainPrivateIssuanceSignature(s.db, s.batch, '0x1234')).calldata).toBe(signed.calldata);
  await expect(retainPrivateIssuanceSignature(s.db, s.batch, '0x1235')).rejects.toThrow('replay');
  expect(s.fake.store.get(`${SETTLEMENT_BATCHES_COLLECTION}/${h(600)}`)?.calldata).toBe(s.parent.calldata);
  expect([...s.fake.store.keys()].filter(k => k.startsWith(C.owners))).toHaveLength(0);
});
test('a concurrent first membership or registration refuses the entire acquisition', async () => {
  for (const mutation of ['member', 'binding', 'transition']) {
    const s = setup();
    if (mutation === 'member') s.fake.store.set(`${C.owners}/${h(500)}`, { version: 1 });
    if (mutation === 'binding') s.fake.store.set(`${R.addresses}/${a(4)}`, { ownerIdentity: h(501) });
    if (mutation === 'transition') s.fake.store.set(`${R.owners}/${h(500)}`, { ownerIdentity: h(500), membershipTransition: h(900) });
    await expect(reservePrivateIssuanceBatch(s.db, s.batch)).rejects.toThrow('ownership_changed');
    expect([...s.fake.store.keys()].filter(k => k.startsWith(PRIVATE_ISSUANCE_ADDRESSES))).toHaveLength(0);
    expect(s.fake.store.has(`${PRIVATE_ISSUANCE_BATCHES}/${s.batch.id}`)).toBe(false);
  }
});
test('incomplete or fabricated recipient partitions and changed inner calldata cannot reserve', async () => {
  const s = setup();
  await expect(reservePrivateIssuanceBatch(s.db, { ...s.batch, unadmitted: s.batch.unadmitted.slice(1) })).rejects.toThrow('partition');
  await expect(reservePrivateIssuanceBatch(s.db, { ...s.batch, tickets: [{ ...s.batch.tickets[0], gross: '101' }, s.batch.tickets[1]] })).rejects.toThrow('kernel_call');
  await expect(reservePrivateIssuanceBatch(s.db, { ...s.batch, kernelCall: '0x' })).rejects.toThrow('parent');
});
test('only complete exact finalized effects release fences and record zero credit once', async () => {
  const s = setup(); await reservePrivateIssuanceBatch(s.db, s.batch); s.issuance();
  const last = s.f.state.effects.pop()!;
  await expect(commitPrivateIssuanceBatch(s.db, s.batch.id, await s.f.read(), s.rules)).rejects.toThrow('receipt_effect');
  expect(s.fake.store.get(`${PRIVATE_ISSUANCE_ADDRESSES}/${a(3)}`)?.batchId).toBe(s.batch.id);
  s.f.state.effects.push(last);
  const receipt = await s.f.read();
  await expect(commitPrivateIssuanceBatch(s.db, s.batch.id, { ...receipt }, s.rules)).rejects.toThrow('unverified');
  expect(await commitPrivateIssuanceBatch(s.db, s.batch.id, receipt, s.rules)).toBe('committed');
  expect(await commitPrivateIssuanceBatch(s.db, s.batch.id, receipt, s.rules)).toBe('committed');
  expect(s.fake.store.get(`${PRIVATE_ISSUANCE_ADDRESSES}/${a(3)}`)?.batchId).toBeNull();
  expect([...s.fake.store.keys()].filter(k => k.startsWith(C.effects + '/'))).toHaveLength(2);
  expect(s.fake.store.has(`${C.owners}/${h(500)}`)).toBe(false);
});
test('permanent ticket cancellation, not a gas self-transfer or reverted transaction, releases nonmember reservations', async () => {
  const s = setup(); await reservePrivateIssuanceBatch(s.db, s.batch);
  s.f.state.effects = [];
  await expect(s.f.read()).rejects.toThrow();
  s.f.state.effects = [{ logIndex: '0x5', ...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('IssuanceBatchCancelled')!, [h(600)]) }];
  expect(await commitPrivateIssuanceBatch(s.db, s.batch.id, await s.f.read(), s.rules)).toBe('cancelled');
  expect([...s.fake.store.keys()].filter(k => k.startsWith(C.effects + '/'))).toHaveLength(0);
});
test('same-domain pointer republication can cancel tickets from the previous revision', async () => {
  const s = setup(); await reservePrivateIssuanceBatch(s.db, s.batch);
  s.f.state.priorRevision = 1; s.f.state.endRevision = 2;
  s.f.state.publications = [s.f.publication(1, 2, old)];
  s.f.state.effects = [{ logIndex: '0x5', ...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('IssuanceBatchCancelled')!, [h(600)]) }];
  const receipt = await s.f.read();
  expect(receipt.events[0].revision).toBe('2');
  expect(await commitPrivateIssuanceBatch(s.db, s.batch.id, receipt, s.rules)).toBe('cancelled');
  expect(s.fake.store.get(`${PRIVATE_ISSUANCE_ADDRESSES}/${a(3)}`)?.batchId).toBeNull();
});

test('restart after owner credit but before final fence release credits only once',async()=>{
 const s=setup(), m=Number(s.batch.context.month);
 const rules=()=>({ruleHash:h(9),rule:{schema:'provian-recourse-membership/v1' as const,chainId:8453 as const,pointer,firstMonth:0,participationBurnAtomic:'100',noEarningsContributionAtomic:'100',earningsBps:100}});
 const account:PrivateMembershipAccount={ownerIdentity:h(500),version:0,episode:joinPrivateMembership(null,m,rules),checkpoint:{pool:old[8],block:99,blockHash:h(99)},pendingReservation:null,needsScan:false};
 const stored=seedMembershipJournal(s.fake.store,account,{chainId:'8453',kernel:old[0],pool:old[8],block:98,blockHash:h(98),logIndex:1,timestamp:1699999999});
 s.fake.store.set(`${C.owners}/${h(500)}`,stored);
 s.fake.store.set(`${R.identities}/${h(3)}`,{identity:h(3),ownerIdentity:h(500),recoveryGeneration:0});
 const r=planPrivateIssuance(stored,s.batch.domain,s.batch.context,[{ordinal:0,occurrence:h(777),account:a(3),grossAtomic:'100',contributorAtomic:'99'}],rules);
 const batch={...s.batch,reservations:[r],unadmitted:s.batch.unadmitted.slice(1),tickets:[{...s.batch.tickets[0],protectedMember:true,contribution:'1'},s.batch.tickets[1]]};
 await reservePrivateIssuanceBatch(s.db,batch);
 s.f.state.effects=batch.tickets.map((t,i)=>({logIndex:`0x${i+5}`,...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('IssuanceTicketConsumed')!,[h(600),i,t.account,t.gross,t.contribution,h(9)])}));
 const receipt=await s.f.read();
 s.fake.store.set(`${PRIVATE_ISSUANCE_ADDRESSES}/${a(4)}`,{batchId:h(888)});
 await expect(commitPrivateIssuanceBatch(s.db,batch.id,receipt,rules)).rejects.toThrow('fence');
 expect(s.fake.store.get(`${C.reservations}/${r.id}`)?.status).toBe('committed');
 s.fake.store.set(`${PRIVATE_ISSUANCE_ADDRESSES}/${a(4)}`,{batchId:batch.id});
 await expect(commitPrivateIssuanceBatch(s.db,batch.id,receipt,rules)).resolves.toBe('committed');
 expect(s.fake.store.get(`${C.owners}/${h(500)}`)?.version).toBe(1);
 expect([...s.fake.store.keys()].filter(k=>k.startsWith(C.effects+'/'))).toHaveLength(2);
});
