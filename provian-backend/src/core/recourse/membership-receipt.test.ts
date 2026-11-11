import { assertMembershipReceipt, MEMBERSHIP_RECEIPT_ABI, readMembershipReceipt } from './membership-receipt';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: {
  address: '0x0000000000000000000000000000000000000001', runtimeHash: require('ethers').keccak256('0x6000'),
} }));
import { fixture, configure, a, h, old, next } from './__test-helpers__/membership-receipt-fixture';
test('only finalized, authentic, frozen receipt effects enter the membership ledger', async () => {
  const f = fixture(), receipt = await f.read();
  expect(receipt.events).toHaveLength(1);
  expect(receipt.events[0]).toMatchObject({ kernel: old[0], pool: old[8], revision: '1', name: 'MembershipDebitExecuted', logIndex: 5 });
  expect(() => assertMembershipReceipt(receipt)).not.toThrow();
  expect(() => assertMembershipReceipt({ ...receipt })).toThrow('unverified');
  expect(Object.isFrozen(receipt.events[0].topics)).toBe(true);
});
test('a later pointer publication in the receipt block does not replace the earlier manifest', async () => {
  const f = fixture(); f.state.publications.push(f.publication(9, 2, next)); f.state.endRevision = 2; f.state.endTargets = next;
  expect((await f.read()).events[0].kernel).toBe(old[0]);
  f.state.publications.shift(); f.state.priorRevision = 1; // No earlier publication this block: use preceding canonical state.
  expect((await f.read()).events[0].kernel).toBe(old[0]);
});
test('same-block succession accepts the new pool only after publication and refuses retired pool effects', async () => {
  const f = fixture(); f.state.publications = [f.publication(1, 2, next)];
  f.state.priorRevision = 1; f.state.endRevision = 2; f.state.endTargets = next;
  await expect(f.read()).rejects.toThrow('retired_pool');
  f.state.pool = next[8]; expect((await f.read()).events[0].revision).toBe('2');
  f.state.publications = [f.publication(9, 2, next)];
  await expect(f.read()).rejects.toThrow('retired_pool');
});
test('reverts, unfinalized or changed receipts, forged manifests and runtime wiring refuse', async () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.state.status = '0x0'; }, f => { f.state.final = '0x63'; }, f => { f.state.chain = '0x1'; },
    f => { f.state.badCode = true; }, f => { f.state.wrongBinding = true; }, f => { f.state.receiptTx = h(99); },
    f => { f.state.reorg = true; }, f => { f.state.publications[0].address = a(999); },
    f => { f.state.publications.push(f.state.publications[0]); },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); await expect(f.read()).rejects.toThrow('recourse_membership_receipt_'); }
});
test('two distinct operators must agree on consumed receipt facts', async () => {
  const f = fixture();
  configure([f.legs[0], { operatorId: 'one', send: f.legs[1].send }]);
  await expect(f.read()).rejects.toThrow('operators');
  configure([f.legs[0], { operatorId: 'two', send: async (method, params) => method === 'eth_chainId' ? '0x1' : f.legs[1].send(method, params) }]);
  await expect(f.read()).rejects.toThrow('disagreement');
});
test('omitted all, last, or intermediate publications cannot authenticate retired-pool effects', async () => {
  const f = fixture(); f.state.priorRevision = 1; f.state.endRevision = 2; f.state.endTargets = next;
  f.state.publications = [];
  await expect(f.read()).rejects.toThrow('publication_gap');
  f.state.priorRevision = 0; f.state.publications = [f.publication(1, 1, old)];
  await expect(f.read()).rejects.toThrow('publication_gap');
  f.state.endRevision = 3; f.state.publications.push(f.publication(9, 3, next));
  await expect(f.read()).rejects.toThrow('publication_gap');
});
