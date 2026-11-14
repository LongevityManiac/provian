import { Transaction, Wallet, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { acquireSignerLease, SETTLEMENT_SIGNER_LEASES_COLLECTION, type SettlementDb } from '../pvt/wp4/durable-settlement-store';
import { openChangeoverJournal, CHANGEOVER_STAGES, CHANGEOVER_ATTEMPTS, type ChangeoverStep, type ChangeoverAttempt } from './changeover-journal';

function fixture(count = 1) {
  const fake = createFakeFirestore({ strictTransactionOrder: true });
  const wallet = new Wallet(`0x${'11'.repeat(32)}`), from = wallet.address.toLowerCase();
  const steps: ChangeoverStep[] = Array.from({ length: count }, (_, index) => ({ from,
    to: `0x${'22'.repeat(20)}`, value: '0', data: `0x1234${index.toString(16).padStart(4, '0')}` }));
  let clock = 1000;
  const input = { planDigest: `0x${'33'.repeat(32)}`, steps, now: () => clock };
  const db = fake as unknown as Firestore;
  const attempt = (index = 0): ChangeoverAttempt => ({ from, nonce: index,
    identity: keccak256(Transaction.from({ type: 2, chainId: 8453, nonce: 0, to: steps[index].to,
      value: 0, data: steps[index].data, gasLimit: 0, maxFeePerGas: 0, maxPriorityFeePerGas: 0 }).unsignedSerialized), raw: null, hash: null });
  const signed = async (index = 0): Promise<ChangeoverAttempt> => {
    const raw = await wallet.signTransaction({ type: 2, chainId: 8453, nonce: index, to: steps[index].to,
      value: 0, data: steps[index].data, gasLimit: 100000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 });
    return { ...attempt(index), raw, hash: keccak256(raw) };
  };
  const open = (workerId = 'worker-one') => openChangeoverJournal(db, { ...input, workerId });
  const otherLease = () => acquireSignerLease(fake as unknown as SettlementDb, {
    signer: from, workerId: 'settlement', nowMs: clock, leaseTtlMs: 120000,
  });
  return { fake, db, input, from, wallet, open, attempt, signed, otherLease, clock: (value: number) => { clock = value; } };
}

test('crash recovery retains exact signed bytes, including after lease expiry, until every transaction finalizes', async () => {
  const f = fixture(2), first = await f.open();
  for (let index = 0; index < 2; index++) {
    await first.persist({ ...first.read(), attempts: { ...first.read().attempts, [index]: f.attempt(index) } });
    await first.persist({ ...first.read(), attempts: { ...first.read().attempts, [index]: await f.signed(index) } });
  }
  const expected = first.read(); await first.release(); f.clock(500000);
  expect(await f.otherLease()).toMatchObject({ kind: 'refused', reason: 'operation_reserved' });
  const restart = await f.open('restarted'); expect(restart.read()).toEqual(expected);
  await expect(restart.complete(async () => null)).rejects.toThrow('not_finalized');
  await expect(restart.complete(async raw => ({ hash: keccak256(raw), status: 0 }))).rejects.toThrow('not_finalized');
  expect(await f.otherLease()).toMatchObject({ kind: 'refused' });
  await restart.complete(async raw => ({ hash: keccak256(raw), status: 1 }));
  expect(restart.read().completed).toBe(true);
  await restart.release(); expect(await f.otherLease()).toMatchObject({ kind: 'acquired' });
});

test('stores each signed attempt separately and keeps the stage document small', async () => {
  const f = fixture(8), store = await f.open();
  for (let index = 0; index < 8; index++) {
    await store.persist({ ...store.read(), attempts: { ...store.read().attempts, [index]: f.attempt(index) } });
    await store.persist({ ...store.read(), attempts: { ...store.read().attempts, [index]: await f.signed(index) } });
  }
  const head = f.fake.store.get(`${CHANGEOVER_STAGES}/${store.stageDigest}`)!;
  expect(head.attemptCount).toBe(8); expect(head.attempts).toBeUndefined();
  expect(JSON.stringify(head).length).toBeLessThan(500);
  expect([...f.fake.store.keys()].filter(key => key.startsWith(`${CHANGEOVER_ATTEMPTS}/`))).toHaveLength(8);
});

test('refuses replacement, dropped or skipped attempts, unsigned completion and forged signed targets', async () => {
  const f = fixture(2), store = await f.open();
  await expect(store.persist({ ...store.read(), attempts: { 0: await f.signed() } })).rejects.toThrow('unsigned_reservation_required');
  await store.persist({ ...store.read(), attempts: { 0: f.attempt() } });
  await expect(store.complete(async () => null)).rejects.toThrow('incomplete');
  await expect(store.persist({ ...store.read(), attempts: { 0: f.attempt(), 1: f.attempt(1) } })).rejects.toThrow('prior_unsigned');
  const wrong = await f.wallet.signTransaction({ type: 2, chainId: 8453, nonce: 0, to: `0x${'44'.repeat(20)}`,
    data: f.input.steps[0].data, value: 0, gasLimit: 100000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 });
  await expect(store.persist({ ...store.read(), attempts: { 0: { ...f.attempt(), raw: wrong, hash: keccak256(wrong) } } })).rejects.toThrow('signed_binding');
  const signed = await f.signed(); await store.persist({ ...store.read(), attempts: { 0: signed } });
  await expect(store.persist({ ...store.read(), attempts: {} })).rejects.toThrow('attempt_sequence');
  await expect(store.persist({ ...store.read(), attempts: { 0: f.attempt() } })).rejects.toThrow('attempt_replaced');
  await expect(store.persist({ ...store.read(), attempts: { 0: signed, 2: f.attempt(1) } })).rejects.toThrow('attempt_binding');
  await expect(store.persist({ ...store.read(), attempts: { 0: signed, 1: { ...f.attempt(1), nonce: 8 } } })).rejects.toThrow('nonce_sequence');
  await expect(store.persist({ ...store.read(), completed: true })).rejects.toThrow('state_invalid');
});

test('a different stage and settlement cannot steal a crashed stage reservation', async () => {
  const f = fixture(), store = await f.open(); await store.release(); f.clock(900000);
  await expect(openChangeoverJournal(f.db, { ...f.input, planDigest: `0x${'55'.repeat(32)}` })).rejects.toThrow('signer_busy');
  expect(await f.otherLease()).toMatchObject({ kind: 'refused' });
  const resumed = await f.open('resumed'); await resumed.assertLease();
});

test('stale workers and concurrent head writes cannot persist, renew for signing, or release another worker lease', async () => {
  const f = fixture(), first = await f.open(); f.clock(200000);
  const second = await f.open('second');
  await expect(first.persist({ ...first.read(), attempts: { 0: f.attempt() } })).rejects.toThrow('lease_lost');
  await first.release(); await second.assertLease();
  expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.from}`)?.owner).toBe('second');
  await second.persist({ ...second.read(), attempts: { 0: f.attempt() } });
  const headKey = `${CHANGEOVER_STAGES}/${second.stageDigest}`, head = f.fake.store.get(headKey)!;
  f.fake.store.set(headKey, { ...head, revision: Number(head.revision) + 1 });
  await expect(second.assertLease()).rejects.toThrow('concurrent_write');
  await expect(second.persist({ ...second.read(), attempts: { 0: await f.signed() } })).rejects.toThrow('concurrent_write');
});

test('missing and substituted durable rows fail closed on restart', async () => {
  const f = fixture(), first = await f.open(); await first.persist({ ...first.read(), attempts: { 0: f.attempt() } });
  await first.release(); const key = `${CHANGEOVER_ATTEMPTS}/${first.stageDigest}:0`, row = f.fake.store.get(key)!;
  f.fake.store.delete(key); await expect(f.open('missing')).rejects.toThrow('attempt_missing');
  f.fake.store.set(key, { ...row, attempt: { ...f.attempt(), from: `0x${'99'.repeat(20)}` } });
  await expect(f.open('substituted')).rejects.toThrow('attempt_binding');
});

test('caller mutation cannot alter the privately bound plan or returned journal', async () => {
  const f = fixture(), store = await f.open();
  const original = f.attempt(); f.input.steps[0] = { ...f.input.steps[0], data: '0xffff' };
  await store.persist({ ...store.read(), attempts: { 0: original } });
  const copy = store.read(); (copy.attempts as Record<string, ChangeoverAttempt>)['0'] = { ...original, nonce: 99 };
  expect(store.read().attempts['0'].nonce).toBe(0);
});

test('lost completion response reopens read-only even while a later settlement owns the signer', async () => {
  const f = fixture(), store = await f.open();
  await store.persist({ ...store.read(), attempts: { 0: f.attempt() } });
  await store.persist({ ...store.read(), attempts: { 0: await f.signed() } });
  const runTransaction = f.fake.runTransaction.bind(f.fake);
  f.fake.runTransaction = async callback => {
    const result = await runTransaction(callback);
    if (f.fake.store.get(`${CHANGEOVER_STAGES}/${store.stageDigest}`)?.completed === true) {
      f.fake.runTransaction = runTransaction; throw Error('completion reply lost');
    }
    return result;
  };
  await expect(store.complete(async raw => ({ hash: keccak256(raw), status: 1 }))).rejects.toThrow('completion reply lost');
  f.clock(500000); expect(await f.otherLease()).toMatchObject({ kind: 'acquired' });
  const leaseKey = `${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.from}`;
  const leaseBefore = structuredClone(f.fake.store.get(leaseKey));
  const reopened = await f.open('reopened'); expect(reopened.read().completed).toBe(true);
  await reopened.complete(async raw => ({ hash: keccak256(raw), status: 1 }));
  await expect(reopened.assertLease()).rejects.toThrow('completed');
  await reopened.release(); expect(f.fake.store.get(leaseKey)).toEqual(leaseBefore);
  await expect(reopened.complete(async () => null)).rejects.toThrow('not_finalized');
});

test('database map key order cannot block signing later attempts in the same stage', async () => {
  const f = fixture(2), store = await f.open();
  for (let index = 0; index < 2; index++) {
    await store.persist({ ...store.read(), attempts: { ...store.read().attempts, [index]: f.attempt(index) } });
    const key = `${CHANGEOVER_ATTEMPTS}/${store.stageDigest}:${index}`, row = f.fake.store.get(key)!;
    const attempt = row.attempt as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(attempt).sort(([a], [b]) => a.localeCompare(b)));
    expect(reordered).toEqual(attempt); expect(JSON.stringify(reordered)).not.toEqual(JSON.stringify(attempt));
    f.fake.store.set(key, { ...row, attempt: reordered });
    const prior = Object.fromEntries(Object.entries(store.read().attempts).map(([k, v]) => [k,
      Object.fromEntries(Object.entries(v).reverse()) as unknown as ChangeoverAttempt]));
    await store.persist({ ...store.read(), attempts: { ...prior, [index]: await f.signed(index) } });
  }
  await store.complete(async raw => ({ hash: keccak256(raw), status: 1 }));
  expect(store.read().completed).toBe(true);
});

test.each(['nonce', 'identity', 'from', 'raw', 'hash', 'unexpected'])('actual database field change still refuses signing: %s', async field => {
  const f = fixture(), store = await f.open();
  await store.persist({ ...store.read(), attempts: { 0: f.attempt() } });
  const key = `${CHANGEOVER_ATTEMPTS}/${store.stageDigest}:0`, row = f.fake.store.get(key)!;
  f.fake.store.set(key, { ...row, attempt: { ...(row.attempt as ChangeoverAttempt), [field]: field === 'nonce' ? 99 : 'changed' } });
  await expect(store.persist({ ...store.read(), attempts: { 0: await f.signed() } })).rejects.toThrow('record_changed');
  expect(store.read().attempts['0'].raw).toBeNull();
});
