import { Interface, Wallet, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { acquireSignerLease, SETTLEMENT_SIGNER_LEASES_COLLECTION, type SettlementDb } from '../pvt/settlement/durable-settlement-store';
import { simulatedBase, laneTestWallet } from './__test-helpers__/lane-chain-fixture';
import { RECOURSE_LANE_COLLECTION, runRecourseLane, type LaneKind, type LaneRow } from './transaction-lane';
import { drainLegacyRecourse, LEGACY_DRAIN_DOC } from './transaction-lane-legacy';
import { BINDING_OPERATIONS } from './binding-operation';

/** A request signed by the settlement minter before Recourse had its own lane. */
const minter = new Wallet(`0x${'6b'.repeat(32)}`), MINTER = minter.address.toLowerCase();
const target = `0x${'ab'.repeat(20)}`, call = new Interface(['function record(bytes32)']);
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const calldata = (id: string) => call.encodeFunctionData('record', [id]);
const COLLECTION = 'legacy_requests';

function setup() {
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const base = simulatedBase(minter.address), settled: string[] = [];
  let clock = 1_800_000_000_000;
  const now = () => clock + base.elapsedMs();
  const kind: LaneKind = { name: 'legacy', collection: COLLECTION,
    async prepare(row: LaneRow) { return { kind: 'sign', plan: { executor: target, calldata: calldata(row.id), fields: {} } }; },
    expected: row => ({ executor: target, calldata: calldata(row.id) }),
    async settle(row, receipt) { settled.push(row.id); return receipt.status === 1 ? { status: 'confirmed', reason: 'ok' } : { status: 'failed', reason: 'reverted' }; } };
  const leaseRef = `${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${MINTER}`;
  const settlement = async () => (await acquireSignerLease(db as unknown as SettlementDb,
    { signer: MINTER, workerId: `settlement-${Math.random()}`, nowMs: now(), leaseTtlMs: 1 })).kind;
  const drain = () => drainLegacyRecourse(db, [kind], () => base, now);
  const signLegacy = async (id: string) => {
    const raw = await minter.signTransaction({ type: 2, chainId: 8453, nonce: 0, to: target, data: calldata(id), value: 0,
      gasLimit: 100_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 6n });
    fake.store.set(`${COLLECTION}/${id}`, { status: 'submitted', signedTransaction: raw, transactionHash: keccak256(raw), executor: target, gasPayer: MINTER });
    fake.store.set(leaseRef, { signer: MINTER, owner: 'old-relay-worker', expires_at_ms: now() - 1, pending_operation: id });
    return raw;
  };
  return { fake, db, base, kind, settled, leaseRef, settlement, drain, signLegacy, now, tick: (ms: number) => { clock += ms; } };
}

test('a minter-signed request in flight at the cutover is rebroadcast, settled at twelve confirmations, and the minter released', async () => {
  const f = setup(), id = h(1);
  const raw = await f.signLegacy(id);
  // RED: while the old reservation stands, settlement cannot take its own signer.
  expect(await f.settlement()).toBe('refused');
  expect(await f.drain()).toMatchObject({ waiting: 1, rebroadcast: 1, settled: 0 });
  expect(f.base.state.broadcasts).toEqual([raw]);
  expect(f.fake.store.get(f.leaseRef)?.pending_operation).toBe(id);
  f.base.mine(); f.base.advance(10);
  expect(await f.drain()).toMatchObject({ waiting: 1, settled: 0 });
  f.base.advance(1);
  expect(await f.drain()).toMatchObject({ settled: 1 });
  expect(f.fake.store.get(`${COLLECTION}/${id}`)).toMatchObject({ status: 'confirmed', terminalReason: 'ok', signedTransaction: raw });
  expect(f.fake.store.get(f.leaseRef)?.pending_operation).toBeNull();
  expect(f.settled).toEqual([id]);
  expect(await f.settlement()).toBe('acquired');
  // Settled once: a later check finds nothing to do.
  expect(await f.drain()).toMatchObject({ settled: 0, waiting: 0 });
  expect(f.settled).toEqual([id]);
});
test('a reservation with no signed bytes behind it is released; nothing was ever broadcast', async () => {
  const f = setup(), id = h(2);
  f.fake.store.set(`${COLLECTION}/${id}`, { status: 'queued', createdAtMs: 5 });
  f.fake.store.set(f.leaseRef, { signer: MINTER, owner: 'old', expires_at_ms: 0, pending_operation: id });
  expect(await f.settlement()).toBe('refused');
  expect(await f.drain()).toMatchObject({ released: 1, adopted: 1 });
  expect(await f.settlement()).toBe('acquired');
  expect(f.base.state.broadcasts).toHaveLength(0);
});
test('a request queued before the lane existed is given a queue key and sent by the lane, oldest first', async () => {
  const f = setup(), older = h(3), newer = h(4);
  f.fake.store.set(`${COLLECTION}/${newer}`, { status: 'queued', createdAtMs: 200 });
  f.fake.store.set(`${COLLECTION}/${older}`, { status: 'queued', createdAtMs: 100 });
  expect(await f.drain()).toMatchObject({ adopted: 2 });
  const gas = laneTestWallet(), lane = simulatedBase(gas.address);
  const report = await runRecourseLane({ db: f.db, signer: { address: gas.address.toLowerCase(), signTransaction: tx => gas.signTransaction(tx) },
    chain: lane, kinds: [f.kind], workerId: 'w', now: lane.now }, lane.now() + 5_000);
  expect(report.signed).toBe(2);
  expect([f.fake.store.get(`${COLLECTION}/${older}`)?.laneNonce, f.fake.store.get(`${COLLECTION}/${newer}`)?.laneNonce]).toEqual([0, 1]);
});
test('a reservation another operator tool holds for its own record is never touched', async () => {
  const f = setup();
  // Its lease has lapsed between calls, as an operator tool's does while its transaction finalizes.
  f.fake.store.set(f.leaseRef, { signer: MINTER, owner: 'break-authority', expires_at_ms: 0, pending_operation: h(9) });
  expect(await f.drain()).toMatchObject({ released: 0, settled: 0, waiting: 0 });
  expect(f.fake.store.get(f.leaseRef)?.pending_operation).toBe(h(9));
  expect(await f.settlement()).toBe('refused');
});
test('a reservation an old relay worker still holds live is left to that worker until its lease lapses', async () => {
  const f = setup(), id = h(7);
  f.fake.store.set(`${COLLECTION}/${id}`, { status: 'queued', createdAtMs: 5 });
  f.fake.store.set(f.leaseRef, { signer: MINTER, owner: 'old-relay-worker', expires_at_ms: f.now() + 60_000, pending_operation: id });
  expect(await f.drain()).toMatchObject({ released: 0, waiting: 1 });
  expect(f.fake.store.get(f.leaseRef)?.pending_operation).toBe(id);
  f.tick(60_001);
  expect(await f.drain()).toMatchObject({ released: 1 });
  expect(f.fake.store.get(f.leaseRef)?.pending_operation).toBeNull();
});
test('the old binding worker reserved `binding:<id>`: that reservation is settled and released the same way', async () => {
  const f = setup(), id = h(11);
  const binding: LaneKind = { ...f.kind, name: 'binding', collection: BINDING_OPERATIONS };
  const raw = await minter.signTransaction({ type: 2, chainId: 8453, nonce: 0, to: target, data: calldata(id), value: 0, gasLimit: 100_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n });
  f.fake.store.set(`${BINDING_OPERATIONS}/${id}`, { status: 'submitted', signedTransaction: raw, transactionHash: keccak256(raw), executor: target, gasSigner: MINTER });
  f.fake.store.set(f.leaseRef, { signer: MINTER, owner: 'old', expires_at_ms: 0, pending_operation: `binding:${id}` });
  const drain = () => drainLegacyRecourse(f.db, [f.kind, binding], () => f.base, f.now);
  expect(await drain()).toMatchObject({ waiting: 1, rebroadcast: 1 });
  f.base.mine(); f.base.advance(11);
  expect(await drain()).toMatchObject({ settled: 1 });
  expect(f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)).toMatchObject({ status: 'confirmed' });
  expect(await f.settlement()).toBe('acquired');
});
test('a reservation left on a request the lane later signed with its own key is released', async () => {
  const f = setup(), id = h(12);
  f.fake.store.set(`${COLLECTION}/${id}`, { status: 'submitted', signedTransaction: '0x02', transactionHash: keccak256('0x02'), laneSigner: '0xlane', laneNonce: 0 });
  f.fake.store.set(f.leaseRef, { signer: MINTER, owner: 'old', expires_at_ms: 0, pending_operation: id });
  expect(await f.settlement()).toBe('refused');
  expect(await f.drain()).toMatchObject({ released: 1 });
  expect(await f.settlement()).toBe('acquired');
  // The lane's own row is untouched.
  expect(f.fake.store.get(`${COLLECTION}/${id}`)).toMatchObject({ status: 'submitted', laneSigner: '0xlane' });
});
test('every unkeyed queued request is adopted, however many keyed ones are queued beside it', async () => {
  const f = setup();
  for (let i = 0; i < 250; i++) f.fake.store.set(`${COLLECTION}/${h(1000 + i)}`, { status: 'queued', createdAtMs: i, laneQueueKey: `k${i}` });
  // Its id sorts after every keyed one, so a read capped below the queue's size would miss it.
  f.fake.store.set(`${COLLECTION}/${h(5000)}`, { status: 'queued', createdAtMs: 1 });
  expect(await f.drain()).toMatchObject({ adopted: 1 });
  expect(f.fake.store.get(`${COLLECTION}/${h(5000)}`)?.laneQueueKey).toBeDefined();
});
test('bytes that do not match the request are never broadcast and never release the minter', async () => {
  const f = setup(), id = h(5);
  await f.signLegacy(id);
  const other = await minter.signTransaction({ type: 2, chainId: 8453, nonce: 0, to: target, data: calldata(h(6)), value: 0, gasLimit: 100_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n });
  f.fake.store.set(`${COLLECTION}/${id}`, { ...f.fake.store.get(`${COLLECTION}/${id}`), signedTransaction: other, transactionHash: keccak256(other) });
  await expect(f.drain()).rejects.toThrow('recourse_legacy_record_invalid');
  expect(f.base.state.broadcasts).toHaveLength(0);
  expect(f.fake.store.get(f.leaseRef)?.pending_operation).toBe(id);
});
test('one reservation that cannot be handled never stops pre-lane requests from being queued', async () => {
  const f = setup(), id = h(20), queued = h(21);
  await f.signLegacy(id);
  // Bytes that do not match their request: refused, and reported.
  const other = await minter.signTransaction({ type: 2, chainId: 8453, nonce: 0, to: target, data: calldata(h(22)), value: 0, gasLimit: 100_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n });
  f.fake.store.set(`${COLLECTION}/${id}`, { ...f.fake.store.get(`${COLLECTION}/${id}`), signedTransaction: other, transactionHash: keccak256(other) });
  f.fake.store.set(`${COLLECTION}/${queued}`, { status: 'queued', createdAtMs: 3 });
  await expect(f.drain()).rejects.toThrow('recourse_legacy_record_invalid');
  expect(f.fake.store.get(`${COLLECTION}/${queued}`)?.laneQueueKey).toBeDefined();
});
test('a reservation that keeps failing keeps the check running and reporting, however long it lasts', async () => {
  const f = setup(), id = h(30);
  await f.signLegacy(id);
  const other = await minter.signTransaction({ type: 2, chainId: 8453, nonce: 0, to: target, data: calldata(h(31)), value: 0, gasLimit: 100_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n });
  f.fake.store.set(`${COLLECTION}/${id}`, { ...f.fake.store.get(`${COLLECTION}/${id}`), signedTransaction: other, transactionHash: keccak256(other) });
  for (let hour = 0; hour < 3; hour++) {
    await expect(f.drain()).rejects.toThrow('recourse_legacy_record_invalid');
    f.tick(60 * 60_000);
  }
  expect(f.fake.store.get(`${RECOURSE_LANE_COLLECTION}/${LEGACY_DRAIN_DOC}`)?.quietSinceMs).toBeNull();
  expect(f.base.state.broadcasts).toHaveLength(0);
  expect(f.fake.store.get(f.leaseRef)?.pending_operation).toBe(id);
});
test('one reservation that cannot be handled never holds up another signer\'s', async () => {
  const f = setup(), bad = h(32), good = h(33);
  // A lease that sorts first, on a record whose bytes do not match it.
  const other = await minter.signTransaction({ type: 2, chainId: 8453, nonce: 0, to: target, data: calldata(h(34)), value: 0, gasLimit: 100_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n });
  f.fake.store.set(`${COLLECTION}/${bad}`, { status: 'submitted', signedTransaction: other, transactionHash: keccak256(other) });
  f.fake.store.set(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/0x${'00'.repeat(20)}`, { owner: 'old', expires_at_ms: 0, pending_operation: bad });
  // A later lease whose reservation has no signed bytes behind it.
  f.fake.store.set(`${COLLECTION}/${good}`, { status: 'failed' });
  const goodLease = `${SETTLEMENT_SIGNER_LEASES_COLLECTION}/0x${'ff'.repeat(20)}`;
  f.fake.store.set(goodLease, { owner: 'old', expires_at_ms: 0, pending_operation: good });
  await expect(f.drain()).rejects.toThrow('recourse_legacy_record_invalid');
  expect(f.fake.store.get(goodLease)?.pending_operation).toBeNull();
});
test('once nothing is found for an hour the check stops reading', async () => {
  const f = setup();
  expect(await f.drain()).not.toHaveProperty('skipped');
  f.tick(30 * 60_000);
  expect(await f.drain()).not.toHaveProperty('skipped');
  f.tick(30 * 60_000);
  expect(await f.drain()).toMatchObject({ skipped: true });
});
