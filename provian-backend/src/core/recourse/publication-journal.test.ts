import { Interface, Wallet, keccak256, type TransactionLike } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { acquireSignerLease, SETTLEMENT_SIGNER_LEASES_COLLECTION, type SettlementDb } from '../pvt/wp4/durable-settlement-store';
import { openPublicationJournal, PUBLICATION_JOURNALS, PUBLICATION_ATTEMPTS,
  type PublicationClosureReader, type PublicationVariant, type PublicationJournal } from './publication-journal';
import type { BaseFeeReader } from './base-transaction-fees';
const block = `0x${'66'.repeat(32)}`;
const oracle = new Interface(['function getL1Fee(bytes) view returns(uint256)',
  'function getL1FeeUpperBound(uint256) view returns(uint256)', 'function getOperatorFee(uint256) view returns(uint256)']);
function fixture(budget = '2000000') {
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const wallet = new Wallet(`0x${'11'.repeat(32)}`), from = wallet.address.toLowerCase();
  const goal = { pointer: `0x${'22'.repeat(20)}`, authority: `0x${'33'.repeat(20)}`, revision: '1', componentsDigest: block };
  const authorityTransaction = { to: goal.authority, data: '0x1234' };
  let clock = 1000, extra = 0n;
  const readers: BaseFeeReader[] = ['one', 'two'].map(operatorId => ({ operatorId, request: async (method, params) => {
    if (method === 'eth_chainId') return '0x2105';
    expect(params[1]).toEqual({ blockHash: block, requireCanonical: true });
    const parsed = oracle.parseTransaction({ data: (params[0] as { data: string }).data })!;
    return oracle.encodeFunctionResult(parsed.name, [extra + (parsed.name === 'getL1FeeUpperBound' ? 700n : parsed.name === 'getL1Fee' ? 500n : 100n)]);
  } }));
  const input = { goal, from, approvedBudgetWei: budget, readers, now: () => clock };
  const open = (workerId = 'first') => openPublicationJournal(db, { ...input, workerId });
  const transaction = (nonce = 7, kind: PublicationVariant['kind'] = 'call'): TransactionLike => ({ type: 2, chainId: 8453, nonce,
    to: kind === 'call' ? authorityTransaction.to : from, data: kind === 'call' ? authorityTransaction.data : '0x',
    value: 0, gasLimit: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  const sign = async (tx = transaction(), kind: PublicationVariant['kind'] = 'call'): Promise<PublicationVariant> => {
    const raw = await wallet.signTransaction(tx); return { raw, hash: keccak256(raw), kind };
  };
  const append = async (journal: PublicationJournal, nonce = 7, kind: PublicationVariant['kind'] = 'call'): Promise<void> => {
    await journal.reserveFee(kind, transaction(nonce, kind), block); await journal.append(await sign(transaction(nonce, kind), kind));
  };
  const closure: PublicationClosureReader = async value => ({ status: 'consumed', from: value.from, nonce: value.nonce,
    finalizedNonce: String(value.nonce + 1), checkpoint: { number: 100, hash: block }, retainedHashes: value.variants.map(v => v.hash) });
  const otherLease = () => acquireSignerLease(fake as unknown as SettlementDb, { signer: from, workerId: 'settlement', nowMs: clock, leaseTtlMs: 120000 });
  return { fake, db, wallet, from, input, goal, authorityTransaction, open, transaction, sign, append, closure, otherLease,
    clock: (n: number) => { clock = n; }, extra: (n: bigint) => { extra = n; } };
}

test('retains original and cancellation bytes across crashes; finality closes gas without claiming authority success', async () => {
  const f = fixture(), journal = await f.open();
  await journal.reserve(7, f.authorityTransaction); await f.append(journal); await f.append(journal, 7, 'cancel');
  const saved = journal.read(); await journal.release(); f.clock(500000);
  expect(await f.otherLease()).toMatchObject({ kind: 'refused', reason: 'operation_reserved' });
  const reopened = await f.open('second'); expect(reopened.read()).toEqual(saved);
  await expect(reopened.close(async value => ({ ...await f.closure(value), status: 'open' }))).rejects.toThrow('nonce_not_closed');
  await reopened.close(f.closure);
  await expect(reopened.complete(f.closure, async () => false)).rejects.toThrow('goal_unverified');
  expect(await f.otherLease()).toMatchObject({ kind: 'refused' });
  await reopened.complete(f.closure, async goal => { expect(goal).toEqual(f.goal); return true; });
  expect(await f.otherLease()).toMatchObject({ kind: 'acquired' });
});

test('one aggregate budget includes replacements and fresh gas attempts; lower quotes never refund it', async () => {
  const f = fixture('650000'), journal = await f.open(); await journal.reserve(7, f.authorityTransaction);
  await journal.reserveFee('call', f.transaction(), block); expect(journal.read().feeReservedWei).toBe('200800');
  f.extra(100n); await journal.reserveFee('call', f.transaction(), block); expect(journal.read().feeReservedWei).toBe('201000');
  f.extra(0n); await f.append(journal); expect(journal.read().feeReservedWei).toBe('201000');
  await f.append(journal, 7, 'cancel'); expect(journal.read().feeReservedWei).toBe('401800');
  await journal.close(f.closure); await journal.reserve(8, f.authorityTransaction); await f.append(journal, 8);
  expect(journal.read().feeReservedWei).toBe('602600');
  await expect(journal.reserveFee('cancel', f.transaction(8, 'cancel'), block)).rejects.toThrow('budget_exhausted');
  await journal.release();
  await expect(openPublicationJournal(f.db, { ...f.input, approvedBudgetWei: '9999999' })).rejects.toThrow('configuration_changed');
  const restart = await f.open('restart'); expect(restart.read().feeReservedWei).toBe('602600');
});

test('unsigned abandonment is transactional, keeps fee reservations, and refuses late signatures', async () => {
  const f = fixture(), journal = await f.open(); await journal.reserve(7, f.authorityTransaction);
  await journal.reserveFee('call', f.transaction(), block);
  const late = await f.sign(), inspect = jest.fn(f.closure); await journal.close(inspect);
  expect(inspect).not.toHaveBeenCalled(); await expect(journal.append(late)).rejects.toThrow('no_open_attempt');
  await journal.reserve(7, f.authorityTransaction); await f.append(journal);
  expect(journal.read().feeReservedWei).toBe('401600');
});

test('fee reservation binds exact signed bytes and sponsor before any signature can be retained', async () => {
  const f = fixture(), journal = await f.open(); await journal.reserve(7, f.authorityTransaction);
  await expect(journal.append(await f.sign())).rejects.toThrow('fee_required');
  await journal.reserveFee('call', f.transaction(), block);
  await expect(journal.append(await f.sign({ ...f.transaction(), maxFeePerGas: 3 }))).rejects.toThrow('fee_required');
  for (const change of [{ nonce: 8 }, { to: f.from }, { value: 1 }, { data: '0xabcd' }, { chainId: 1 }]) {
    await expect(journal.append(await f.sign({ ...f.transaction(), ...change }))).rejects.toThrow();
  }
  const other = new Wallet(`0x${'44'.repeat(32)}`), raw = await other.signTransaction(f.transaction());
  await expect(journal.append({ kind: 'call', raw, hash: keccak256(raw) })).rejects.toThrow('signed_binding');
  await f.append(journal); await expect(journal.append(await f.sign())).rejects.toThrow('signed_binding');
});

test('closure must bind every retained hash, exact nonce and finalized consumption', async () => {
  const f = fixture(), journal = await f.open(); await journal.reserve(7, f.authorityTransaction); await f.append(journal);
  for (const change of [{ retainedHashes: [] }, { nonce: 8 }, { from: f.goal.pointer }, { finalizedNonce: '7' },
    { checkpoint: { number: 0, hash: block } }]) {
    await expect(journal.close(async value => ({ ...await f.closure(value), ...change }))).rejects.toThrow('nonce_not_closed');
  }
  await expect(journal.reserve(8, f.authorityTransaction)).rejects.toThrow('prior_not_closed');
  await expect(journal.complete(f.closure, async () => true)).rejects.toThrow('open_attempt');
  await journal.close(f.closure); await expect(journal.reserve(7, f.authorityTransaction)).rejects.toThrow('prior_not_closed');
  await journal.reserve(9, f.authorityTransaction); // Outside nonce consumption may legitimately skip a nonce.
});

test('replacement racing an RPC closure is retained and stale closure cannot release it', async () => {
  const f = fixture(), journal = await f.open(); await journal.reserve(7, f.authorityTransaction); await f.append(journal);
  await expect(journal.close(async value => {
    await f.append(journal, 7, 'cancel'); return f.closure(value);
  })).rejects.toThrow('concurrent_write');
  expect(journal.read().attempts[0].closed).toBe(false);
  expect(journal.read().attempts[0].variants).toHaveLength(2);
});

test('fee quotes cannot commit after unsigned closure and late signature cannot revive a reservation', async () => {
  const f = fixture(); let journal: PublicationJournal, invoked = false;
  const readers = f.input.readers.map(reader => ({ ...reader, request: async (method: string, params: readonly unknown[]) => {
    if (!invoked) { invoked = true; await journal.close(f.closure); }
    return reader.request(method, params);
  } }));
  journal = await openPublicationJournal(f.db, { ...f.input, readers }); await journal.reserve(7, f.authorityTransaction);
  await expect(journal.reserveFee('call', f.transaction(), block)).rejects.toThrow('concurrent_write');
  expect(journal.read().feeReservedWei).toBe('0');
});

test('stale worker cannot write or clear a successor lease, including after a slow quote', async () => {
  const f = fixture(), first = await f.open(); await first.reserve(7, f.authorityTransaction); f.clock(200000);
  const second = await f.open('second');
  await expect(first.close(f.closure)).rejects.toThrow('lease_lost');
  await first.release(); await second.assertLease();
  expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.from}`)?.owner).toBe('second');
});

test('lost completion response reopens read-only and rechecks canonical closure without taking later lease', async () => {
  const f = fixture(), journal = await f.open(); await journal.reserve(7, f.authorityTransaction); await f.append(journal); await journal.close(f.closure);
  const original = f.fake.runTransaction.bind(f.fake);
  f.fake.runTransaction = async callback => {
    const result = await original(callback);
    if (f.fake.store.get(`${PUBLICATION_JOURNALS}/${journal.lifecycleDigest}`)?.completed) {
      f.fake.runTransaction = original; throw Error('reply_lost');
    }
    return result;
  };
  await expect(journal.complete(f.closure, async () => true)).rejects.toThrow('reply_lost');
  expect(await f.otherLease()).toMatchObject({ kind: 'acquired' });
  const leaseKey = `${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.from}`, before = structuredClone(f.fake.store.get(leaseKey));
  const restart = await f.open('restart'), inspect = jest.fn(f.closure);
  await restart.complete(inspect, async () => true);
  expect(inspect.mock.calls[0][1]).toEqual({ number: 100, hash: block });
  await expect(restart.complete(async () => { throw Error('reorg'); }, async () => true)).rejects.toThrow('reorg');
  await expect(restart.reserve(8, f.authorityTransaction)).rejects.toThrow('closed');
  await restart.release(); expect(f.fake.store.get(leaseKey)).toEqual(before);
});

test('missing signed bytes and altered attempt bindings refuse restart', async () => {
  const f = fixture(), journal = await f.open(); await journal.reserve(7, f.authorityTransaction); await f.append(journal); await journal.release();
  const key = `${PUBLICATION_ATTEMPTS}/${journal.lifecycleDigest}:0:variant:0`, row = f.fake.store.get(key)!;
  f.fake.store.delete(key); await expect(f.open('missing')).rejects.toThrow('variant_missing');
  f.fake.store.set(key, { ...row, variant: { ...(row.variant as PublicationVariant), hash: block } });
  await expect(f.open('altered')).rejects.toThrow('signed_binding');
});

test('signer reservation prevents another goal or settlement from bypassing an unfinished lifecycle budget', async () => {
  const f = fixture(), journal = await f.open(); await journal.release(); f.clock(900000);
  await expect(openPublicationJournal(f.db, { ...f.input, goal: { ...f.goal, revision: '2' } })).rejects.toThrow('signer_busy');
  expect(await f.otherLease()).toMatchObject({ kind: 'refused' });
  const resume = await f.open('resume'); await resume.assertLease();
});

test('caller mutation cannot change goal, retained transaction or returned snapshot', async () => {
  const f = fixture(), journal = await f.open(); const original = structuredClone(f.authorityTransaction);
  const pending = journal.reserve(7, f.authorityTransaction); f.authorityTransaction.data = '0xffff'; await pending;
  expect(journal.read().attempts[0].authorityTransaction).toEqual(original);
  const read = journal.read(); (read.attempts[0].authorityTransaction as { data: string }).data = '0xabcd';
  expect(journal.read().attempts[0].authorityTransaction).toEqual(original);
  f.goal.authority = f.from; await journal.close(f.closure);
  await journal.complete(f.closure, async goal => { expect(goal.authority).toBe(original.to); return true; });
});

test('stores signed variants in separate documents without growing the journal head', async () => {
  const f = fixture(), journal = await f.open(); await journal.reserve(7, f.authorityTransaction); await f.append(journal); await f.append(journal, 7, 'cancel');
  const head = f.fake.store.get(`${PUBLICATION_JOURNALS}/${journal.lifecycleDigest}`)!;
  expect(JSON.stringify(head).length).toBeLessThan(600); expect(head.attempts).toBeUndefined();
  expect([...f.fake.store.keys()].filter(key => key.includes(':variant:'))).toHaveLength(2);
});

test('lost signed append response reopens exact variant and fee without a second reservation', async () => {
  const f = fixture(), journal = await f.open();
  await journal.reserve(7, f.authorityTransaction);
  await journal.reserveFee('call', f.transaction(), block);
  const variant = await f.sign(), original = f.fake.runTransaction.bind(f.fake);
  f.fake.runTransaction = async callback => {
    const result = await original(callback);
    if (f.fake.store.has(`${PUBLICATION_ATTEMPTS}/${journal.lifecycleDigest}:0:variant:0`)) {
      f.fake.runTransaction = original;
      throw Error('append_reply_lost');
    }
    return result;
  };
  await expect(journal.append(variant)).rejects.toThrow('append_reply_lost');
  await journal.release();
  const reopened = await f.open('restarted');
  expect(reopened.read().attempts[0].variants).toEqual([variant]);
  expect(reopened.read().feeReservedWei).toBe('200800');
  await expect(reopened.append(variant)).rejects.toThrow('signed_binding');
  await reopened.close(f.closure);
  await reopened.complete(f.closure, async () => true);
  expect(await f.otherLease()).toMatchObject({ kind: 'acquired' });
});

type Phase = 'quote' | 'close' | 'complete';
async function delayed(phase:Phase, interfere:(f:ReturnType<typeof fixture>)=>Promise<void>) {
 const f=fixture();let invoked=false;
 const pause=async()=>{if(!invoked){invoked=true;await interfere(f);}};
 const readers=f.input.readers.map(reader=>({...reader,request:async(method:string,params:readonly unknown[])=>{
  if(phase==='quote')await pause();return reader.request(method,params);
 }}));
 const journal=await openPublicationJournal(f.db,{...f.input,readers,workerId:'first'});
 await journal.reserve(7,f.authorityTransaction);
 if(phase!=='quote')await f.append(journal);
 if(phase==='complete')await journal.close(f.closure);
 const saved=journal.read();
 const operation=phase==='quote'?()=>journal.reserveFee('call',f.transaction(),block)
  :phase==='close'?()=>journal.close(async value=>{await pause();return f.closure(value);})
  :()=>journal.complete(f.closure,async()=>{await pause();return true;});
 return {f,journal,saved,operation};
}
test.each<Phase>(['quote','close','complete'])('long %s read renews only its unchanged owner before journal commit',async phase=>{
 const {f,journal,saved,operation}=await delayed(phase,async f=>{f.clock(200000);});
 await expect(operation()).resolves.toBeUndefined();
 expect(journal.read().attempts[0].variants).toEqual(saved.attempts[0].variants);
 if(phase==='quote')expect(journal.read().feeReservedWei).toBe('200800');
 if(phase==='close')expect(journal.read().attempts[0].closed).toBe(true);
 if(phase==='complete'){
  expect(journal.read().completed).toBe(true);
  expect(await f.otherLease()).toMatchObject({kind:'acquired'});
 }
});
test.each(['active','expired','released'] as const)('a %s successor lease cannot be reclaimed by a delayed completion',async mode=>{
 let successor:PublicationJournal|undefined;
 const {f,journal,saved,operation}=await delayed('complete',async f=>{
  f.clock(200000);successor=await f.open('successor');
  if(mode==='expired')f.clock(400000);
  if(mode==='released')await successor.release();
 });
 await expect(operation()).rejects.toThrow('lease_lost');
 expect(journal.read()).toEqual(saved);
 const leaseKey=`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.from}`;
 expect(f.fake.store.get(leaseKey)?.owner).toBe('successor');
 await journal.release();
 expect(f.fake.store.get(leaseKey)?.owner).toBe('successor');
});
test('delayed quote cannot change fees after expired successor takeover',async()=>{
 const {f,journal,saved,operation}=await delayed('quote',async f=>{f.clock(200000);await f.open('successor');f.clock(400000);});
 await expect(operation()).rejects.toThrow('lease_lost');expect(journal.read()).toEqual(saved);
 expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.from}`)?.owner).toBe('successor');
});
test('delayed closure cannot close bytes after released successor takeover',async()=>{
 const {f,journal,saved,operation}=await delayed('close',async f=>{f.clock(200000);const next=await f.open('successor');await next.release();});
 await expect(operation()).rejects.toThrow('lease_lost');expect(journal.read()).toEqual(saved);
 expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.from}`)?.owner).toBe('successor');
});
test('assertLease itself never reacquires a successor that later expires',async()=>{
 const f=fixture(),first=await f.open();f.clock(200000);await f.open('successor');f.clock(400000);
 await expect(first.assertLease()).rejects.toThrow('lease_lost');
 expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.from}`)?.owner).toBe('successor');
});
test('completed replay remains read-only after arbitrarily slow verification',async()=>{
 const f=fixture(),first=await f.open();await first.reserve(7,f.authorityTransaction);await f.append(first);await first.close(f.closure);
 await first.complete(f.closure,async()=>true);expect(await f.otherLease()).toMatchObject({kind:'acquired'});
 const key=`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.from}`,before=structuredClone(f.fake.store.get(key));
 const restarted=await f.open('restart');
 await restarted.complete(async value=>{f.clock(300000);return f.closure(value);},async()=>{f.clock(600000);return true;});
 expect(f.fake.store.get(key)).toEqual(before);
});
