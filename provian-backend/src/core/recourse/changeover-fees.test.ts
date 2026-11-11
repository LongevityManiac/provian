import { Interface, Transaction, Wallet, keccak256, type TransactionLike } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { openChangeoverJournal, CHANGEOVER_STAGES, CHANGEOVER_ATTEMPTS } from './changeover-journal';
import { openChangeoverFeeBudget } from './changeover-fees';
import type { BaseFeeReader } from './base-transaction-fees';
const oracle = new Interface(['function getL1Fee(bytes) view returns(uint256)',
  'function getL1FeeUpperBound(uint256) view returns(uint256)', 'function getOperatorFee(uint256) view returns(uint256)']);
const block = `0x${'66'.repeat(32)}`;
async function fixture() {
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const wallet = new Wallet(`0x${'11'.repeat(32)}`), from = wallet.address.toLowerCase();
  const steps = [0, 1].map(n => ({ from, to: `0x${'22'.repeat(20)}`, value: '0' as const, data: `0x12340${n}` }));
  const journal = await openChangeoverJournal(db, { planDigest: `0x${'33'.repeat(32)}`, steps, workerId: 'test' });
  const transaction = (index = 0): TransactionLike => ({ type: 2, chainId: 8453, nonce: index, to: steps[index].to,
    data: steps[index].data, value: 0, gasLimit: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  const reserveNonce = async (index: number): Promise<void> => {
    await journal.persist({ ...journal.read(), attempts: { ...journal.read().attempts, [index]: { from, nonce: index, raw: null, hash: null,
      identity: keccak256(Transaction.from({ type: 2, chainId: 8453, nonce: 0, to: steps[index].to, value: 0,
        data: steps[index].data, gasLimit: 0, maxFeePerGas: 0, maxPriorityFeePerGas: 0 }).unsignedSerialized) } } });
  };
  let extra = 0n, lease = true;
  const readers: BaseFeeReader[] = ['one', 'two'].map(operatorId => ({ operatorId, request: async (method, params) => {
    if (method === 'eth_chainId') return '0x2105';
    expect(params[1]).toEqual({ blockHash: block, requireCanonical: true });
    const parsed = oracle.parseTransaction({ data: (params[0] as { data: string }).data })!;
    return oracle.encodeFunctionResult(parsed.name, [extra + (parsed.name === 'getL1FeeUpperBound' ? 700n : parsed.name === 'getL1Fee' ? 500n : 100n)]);
  } }));
  const input = { stageDigest: journal.stageDigest, approvedBudgetWei: '450000', readers,
    assertLease: async () => { if (!lease) throw Error('lease lost'); await journal.assertLease(); } };
  const open = () => openChangeoverFeeBudget(db, input);
  return { fake, db, wallet, from, journal, transaction, reserveNonce, input, open,
    extra: (value: bigint) => { extra = value; }, lease: (value: boolean) => { lease = value; } };
}

test('durable reservation includes all Base components and survives reopen without double counting', async () => {
  const f = await fixture(); await f.reserveNonce(0); const budget = await f.open();
  expect(await budget.reserve(0, f.from, f.transaction(), block)).toBe('200800');
  const head = (): Record<string, unknown> => f.fake.store.get(`${CHANGEOVER_STAGES}/${f.journal.stageDigest}`)!;
  expect(head().feeReservedWei).toBe('200800');
  const reopened = await f.open(); expect(await reopened.reserve(0, f.from, f.transaction(), block)).toBe('200800');
  f.extra(100n); expect(await reopened.reserve(0, f.from, f.transaction(), block)).toBe('201000');
  f.extra(0n); expect(await reopened.reserve(0, f.from, f.transaction(), block)).toBe('201000');
  expect(head().feeReservedWei).toBe('201000');
  const raw = await f.wallet.signTransaction(f.transaction());
  await f.journal.persist({ ...f.journal.read(), attempts: { 0: { ...f.journal.read().attempts['0'], raw, hash: keccak256(raw) } } });
  await f.reserveNonce(1); expect(await reopened.reserve(1, f.from, f.transaction(1), block)).toBe('200800');
  expect(head().feeReservedWei).toBe('401800');
  f.extra(30000n); await expect(reopened.reserve(1, f.from, f.transaction(1), block)).rejects.toThrow('budget_exhausted');
  expect(head().feeReservedWei).toBe('401800');
  await expect(reopened.reserve(0, f.from, f.transaction(), block)).rejects.toThrow('attempt_changed');
});

test('changed budget, unreserved nonce, substituted target, nonzero value and stale lease refuse', async () => {
  const f = await fixture(), budget = await f.open();
  await expect(budget.reserve(0, f.from, f.transaction(), block)).rejects.toThrow('attempt_missing');
  await f.reserveNonce(0);
  for (const change of [{ to: `0x${'44'.repeat(20)}` }, { data: '0xffff' }, { nonce: 99 }]) {
    await expect(budget.reserve(0, f.from, { ...f.transaction(), ...change }, block)).rejects.toThrow('attempt_changed');
  }
  await expect(budget.reserve(0, f.from, { ...f.transaction(), value: 1 }, block)).rejects.toThrow('request_invalid');
  await expect(openChangeoverFeeBudget(f.db, { ...f.input, approvedBudgetWei: '450001' })).rejects.toThrow('budget_changed');
  f.lease(false); await expect(budget.reserve(0, f.from, f.transaction(), block)).rejects.toThrow('lease lost');
  expect(f.fake.store.get(`${CHANGEOVER_STAGES}/${f.journal.stageDigest}`)?.feeReservedWei).toBe('0');
});

test('substituted durable reservation and corrupt total cannot free reserved fees', async () => {
  const f = await fixture(); await f.reserveNonce(0); const budget = await f.open();
  await budget.reserve(0, f.from, f.transaction(), block);
  const key = `${CHANGEOVER_ATTEMPTS}/${f.journal.stageDigest}:0:fee`, row = f.fake.store.get(key)!;
  f.fake.store.set(key, { ...row, nonce: 5 });
  await expect(budget.reserve(0, f.from, f.transaction(), block)).rejects.toThrow('reservation_changed');
  f.fake.store.set(key, row);
  const headKey = `${CHANGEOVER_STAGES}/${f.journal.stageDigest}`, head = f.fake.store.get(headKey)!;
  f.fake.store.set(headKey, { ...head, feeReservedWei: '1' });
  await expect(budget.reserve(0, f.from, f.transaction(), block)).rejects.toThrow('budget_exhausted');
  f.fake.store.set(headKey, { ...head, completed: true });
  await expect(f.open()).rejects.toThrow();
});

test('journal refuses unreserved signed bytes and fee escalation after reservation', async () => {
  const f = await fixture(); await f.reserveNonce(0); const budget = await f.open();
  const persist = async (transaction: TransactionLike): Promise<void> => {
    const raw = await f.wallet.signTransaction(transaction);
    await f.journal.persist({ ...f.journal.read(), attempts: { 0: { ...f.journal.read().attempts['0'], raw, hash: keccak256(raw) } } });
  };
  await expect(persist(f.transaction())).rejects.toThrow('fee_reservation_required');
  await budget.reserve(0, f.from, f.transaction(), block);
  await expect(persist({ ...f.transaction(), maxFeePerGas: 3n })).rejects.toThrow('fee_reservation_required');
  await persist(f.transaction());
  expect(f.journal.read().attempts['0'].raw).not.toBeNull();
});

test('a new budget cannot reset costs of already signed unbudgeted transactions', async () => {
  const f = await fixture(); await f.reserveNonce(0);
  const raw = await f.wallet.signTransaction(f.transaction());
  await f.journal.persist({ ...f.journal.read(), attempts: { 0: { ...f.journal.read().attempts['0'], raw, hash: keccak256(raw) } } });
  await expect(f.open()).rejects.toThrow('prior_unsigned_budget_required');
  await f.reserveNonce(1); await expect(f.open()).rejects.toThrow('prior_unsigned_budget_required');
  expect(f.fake.store.get(`${CHANGEOVER_STAGES}/${f.journal.stageDigest}`)?.feeBudgetWei).toBeUndefined();
});
