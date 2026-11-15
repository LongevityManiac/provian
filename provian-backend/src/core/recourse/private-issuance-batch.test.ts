import { joinPrivateMembership } from './private-membership-calendar';
import { planPrivateIssuance, type PrivateMembershipAccount } from './private-membership-reservation';
import { seedMembershipJournal } from './__test-helpers__/membership-journal-fixture';
import { Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { KERNEL_SETTLEMENT_ABI } from '../pvt/settlement/settlement-cycle-runner';
import { SETTLEMENT_BATCHES_COLLECTION, SETTLEMENT_BATCH_SCHEMA, type SettlementBatchDoc } from '../pvt/settlement/durable-settlement-store';
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
import { issuanceBatchFixture as setup } from './__test-helpers__/issuance-batch-fixture';
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

test('retiring parent cannot acquire or retain an issuance signature even while its status remains reserved',async()=>{
  for(const acquired of [false,true]){
    const s=setup();if(acquired)await reservePrivateIssuanceBatch(s.db,s.batch);
    const key=`${SETTLEMENT_BATCHES_COLLECTION}/${h(600)}`;
    s.fake.store.set(key,{...s.fake.store.get(key)!,retirement_reason:'cancel requested'});
    const before=new Map(s.fake.store);
    if(acquired)await expect(retainPrivateIssuanceSignature(s.db,s.batch,'0x1234')).rejects.toThrow('parent');
    else await expect(reservePrivateIssuanceBatch(s.db,s.batch)).rejects.toThrow('parent');
    expect(s.fake.store).toEqual(before);
  }
});

test('an all-unadmitted terminal batch rejects changed finalized event positions without rewriting effect fences',async()=>{
 const s=setup();await reservePrivateIssuanceBatch(s.db,s.batch);s.issuance();
 await commitPrivateIssuanceBatch(s.db,s.batch.id,await s.f.read(),s.rules);
 const before=new Map(s.fake.store);
 s.f.state.effects=s.f.state.effects.map((event,i)=>({...event,logIndex:`0x${(i+10).toString(16)}`}));
 await expect(commitPrivateIssuanceBatch(s.db,s.batch.id,await s.f.read(),s.rules)).rejects.toThrow('receipt_changed');
 expect(s.fake.store).toEqual(before);
});
