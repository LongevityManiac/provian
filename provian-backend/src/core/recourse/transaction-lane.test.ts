import { Interface, Transaction, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { simulatedBase, laneTestWallet } from './__test-helpers__/lane-chain-fixture';
import { LANE_MAX_FEE_CEILING_WEI, LANE_MAX_PENDING, LANE_REPLACE_AFTER_MS, RECOURSE_LANE_COLLECTION, laneQueueKey,
  runRecourseLane, type LaneKind, type LaneRow } from './transaction-lane';

const wallet = laneTestWallet(), LANE = wallet.address.toLowerCase();
const target = `0x${'ab'.repeat(20)}`, call = new Interface(['function record(bytes32)']);
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const calldata = (id: string) => call.encodeFunctionData('record', [id]);

/** A minimal kind: each row's calldata commits to its own id. `expired` rows close unsigned. */
function testKind(collection: string, now: () => number, settled: string[] = []): LaneKind {
  return { name: collection, collection,
    async prepare(row: LaneRow) {
      if (Number(row.data.expiresAtMs ?? Infinity) <= now()) return { kind: 'finish', status: 'failed', reason: 'binding_expired' };
      if (row.data.poison === true) throw Error('transient_rpc');
      return { kind: 'sign', plan: { executor: target, calldata: calldata(row.id), fields: {} } };
    },
    expected: row => ({ executor: target, calldata: calldata(row.id) }),
    async settle(row, receipt) { settled.push(row.id); return receipt.status === 1 ? { status: 'confirmed', reason: 'ok' } : { status: 'failed', reason: 'reverted' }; },
  };
}
function setup() {
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const base = simulatedBase(wallet.address);
  let clock = 1_800_000_000_000;
  // Wall time of the simulation: explicit ticks plus two seconds per mined block.
  const now = () => clock + base.elapsedMs();
  const signer = { address: LANE, signTransaction: jest.fn((tx: Parameters<typeof wallet.signTransaction>[0]) => wallet.signTransaction(tx)) };
  const queue = (collection: string, n: number, at = clock, extra: Record<string, unknown> = {}) => {
    const id = h(n);
    fake.store.set(`${collection}/${id}`, { status: 'queued', transactionHash: null, createdAtMs: at, laneQueueKey: laneQueueKey(at, id), ...extra });
    return id;
  };
  const run = (kinds: LaneKind[], budget = 10_000, extra: Partial<Parameters<typeof runRecourseLane>[0]> = {}) =>
    runRecourseLane({ db, signer, chain: base, kinds, workerId: `w-${Math.random()}`, now, sleep: async ms => { clock += Math.max(0, ms - 2_000); base.mine(); }, ...extra }, now() + budget);
  return { fake, db, base, signer, queue, run, now, tick: (ms: number) => { clock += ms; } };
}

test('transactions go out back to back at consecutive nonces, never waiting for confirmations, bounded by the mempool limit', async () => {
  const f = setup(), kind = testKind('a', f.now);
  for (let i = 1; i <= 40; i++) f.queue('a', i, f.now() + i);
  const report = await f.run([kind], 60_000);
  expect(report.signed).toBe(40);
  const nonces = [...f.fake.store.entries()].filter(([k]) => k.startsWith('a/')).map(([, v]) => v.laneNonce as number).sort((x, y) => x - y);
  expect(nonces).toEqual([...Array(40).keys()]);
  expect(f.base.state.maxPending).toBeLessThanOrEqual(LANE_MAX_PENDING);
  expect(f.base.state.maxPending).toBe(LANE_MAX_PENDING);
});
test('the oldest live request goes first across kinds, and expired requests close without holding anything up', async () => {
  const f = setup(), a = testKind('a', f.now), b = testKind('b', f.now);
  const order = [f.queue('b', 3, 1000), f.queue('a', 1, 2000, { expiresAtMs: f.now() - 1 }), f.queue('a', 2, 3000), f.queue('b', 4, 4000)];
  const report = await f.run([a, b]);
  expect(report).toMatchObject({ signed: 3, failed: 1, closedUnsigned: 1, lapsed: 1 });
  const nonceOf = (key: string) => f.fake.store.get(key)?.laneNonce;
  expect([nonceOf(`b/${order[0]}`), nonceOf(`a/${order[2]}`), nonceOf(`b/${order[3]}`)]).toEqual([0, 1, 2]);
  expect(f.fake.store.get(`a/${order[1]}`)).toMatchObject({ status: 'failed', terminalReason: 'binding_expired' });
  expect(f.fake.store.get(`a/${order[1]}`)?.laneQueueKey).toBeUndefined();
});
test('a request that fails transiently is skipped for the run and never blocks the rows behind it', async () => {
  const f = setup(), kind = testKind('a', f.now);
  const poison = f.queue('a', 1, 1, { poison: true }), live = f.queue('a', 2, 2);
  const report = await f.run([kind]);
  expect(report).toMatchObject({ signed: 1, waiting: 1 });
  expect(report.errors).toContain(`transient_rpc:${poison}`);
  expect(f.fake.store.get(`a/${poison}`)?.status).toBe('queued');
  expect(f.fake.store.get(`a/${live}`)).toMatchObject({ status: 'submitted', laneNonce: 0 });
});
test('a stuck head-of-line transaction is replaced at the same nonce; only one variant lands and both are kept', async () => {
  const f = setup(), settled: string[] = [], kind = testKind('a', f.now, settled);
  const id = f.queue('a', 1);
  await f.run([kind], 1);
  const first = String(f.fake.store.get(`a/${id}`)!.signedTransaction);
  // Base fee jumps above what the first bytes pay.
  f.base.state.baseFee *= 10n; f.base.mine();
  f.tick(LANE_REPLACE_AFTER_MS);
  expect(await f.run([kind], 1)).toMatchObject({ replaced: 1, signed: 0 });
  const row = f.fake.store.get(`a/${id}`)!, second = String(row.signedTransaction);
  expect(row.replacedTransactions).toEqual([first]);
  const [a, b] = [Transaction.from(first), Transaction.from(second)];
  expect([b.nonce, b.to, b.data]).toEqual([a.nonce, a.to, a.data]);
  expect(b.maxFeePerGas! > a.maxFeePerGas!).toBe(true);
  f.base.mine(); f.base.advance(11);
  expect(await f.run([kind], 1)).toMatchObject({ confirmed: 1 });
  expect(f.fake.store.get(`a/${id}`)).toMatchObject({ status: 'confirmed', transactionHash: keccak256(second), replacedTransactions: [first] });
  expect(settled).toEqual([id]);
});
test('if the original bytes land after a replacement was sent, the landed variant is the one recorded', async () => {
  const f = setup(), kind = testKind('a', f.now);
  const id = f.queue('a', 1);
  await f.run([kind], 1);
  const first = String(f.fake.store.get(`a/${id}`)!.signedTransaction);
  f.base.state.inclusionFloor = 10n ** 18n; f.tick(LANE_REPLACE_AFTER_MS);
  await f.run([kind], 1);
  // The replacement never reached this node; the original is the one included.
  f.base.state.mempool.set(0, first); f.base.state.inclusionFloor = 0n; f.base.mine(); f.base.advance(11);
  expect(await f.run([kind], 1)).toMatchObject({ confirmed: 1 });
  const row = f.fake.store.get(`a/${id}`)!;
  expect(row.signedTransaction).toBe(first); expect(row.transactionHash).toBe(keccak256(first));
  expect((row.replacedTransactions as string[]).length).toBe(1);
});
test('replacement fees are bounded; reaching the ceiling stops the lane instead of overpaying', async () => {
  const f = setup(), kind = testKind('a', f.now);
  f.queue('a', 1);
  await f.run([kind], 1);
  f.base.state.baseFee = LANE_MAX_FEE_CEILING_WEI; f.tick(LANE_REPLACE_AFTER_MS);
  expect(await f.run([kind], 1)).toMatchObject({ replaced: 0, stopReason: 'recourse_lane_fee_ceiling' });
});
test('insufficient gas balance stops signing before any unfundable transaction is created', async () => {
  const f = setup(), kind = testKind('a', f.now);
  for (let i = 1; i <= 5; i++) f.queue('a', i, i);
  // Enough for two transactions at the quoted cost.
  f.base.state.balance = 2n * (100_000n * 120n / 100n * (f.base.state.baseFee * 3n + 1_000_000n) + 1_000n);
  const report = await f.run([kind]);
  expect(report).toMatchObject({ signed: 2, stopReason: 'recourse_lane_gas_unavailable' });
  expect([...f.fake.store.values()].filter(v => v.status === 'queued')).toHaveLength(3);
});
test('one writer: a second run while the lease is held does nothing', async () => {
  const f = setup(), kind = testKind('a', f.now);
  f.queue('a', 1);
  f.fake.store.set(`${RECOURSE_LANE_COLLECTION}/${LANE}`, { signer: LANE, owner: 'other', expires_at_ms: f.now() + 30_000, next_nonce: 0, open: {} });
  expect(await f.run([kind])).toMatchObject({ skipped: 'lane_busy', signed: 0 });
  expect(f.signer.signTransaction).not.toHaveBeenCalled();
});
test('an idle lane makes no chain call', async () => {
  const f = setup(), kind = testKind('a', f.now);
  const nonces = jest.spyOn(f.base, 'nonces');
  expect(await f.run([kind])).toMatchObject({ skipped: 'lane_idle' });
  f.fake.store.set(`${RECOURSE_LANE_COLLECTION}/${LANE}`, { signer: LANE, owner: null, expires_at_ms: 0, next_nonce: 7, open: {} });
  expect(await f.run([kind])).toMatchObject({ skipped: 'lane_idle', nextNonce: 7 });
  expect(nonces).not.toHaveBeenCalled();
});
test('a lost lease mid-run stops signing; the persisted nonce is never reused by a later writer', async () => {
  const f = setup(), kind = testKind('a', f.now);
  for (let i = 1; i <= 3; i++) f.queue('a', i, i);
  let signs = 0;
  f.signer.signTransaction.mockImplementation(async tx => {
    if (++signs === 2) f.fake.store.set(`${RECOURSE_LANE_COLLECTION}/${LANE}`, { ...f.fake.store.get(`${RECOURSE_LANE_COLLECTION}/${LANE}`), owner: 'thief' });
    return wallet.signTransaction(tx);
  });
  const report = await f.run([kind]);
  expect(report).toMatchObject({ signed: 1, stopReason: 'recourse_lane_lease_lost' });
  expect(f.fake.store.get(`${RECOURSE_LANE_COLLECTION}/${LANE}`)).toMatchObject({ next_nonce: 1 });
  expect(f.base.state.broadcasts).toHaveLength(1);
});
