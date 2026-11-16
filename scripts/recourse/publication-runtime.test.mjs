import { beforeEach, expect, test, vi } from 'vitest';
import { Interface, Transaction, Wallet, sha256, toUtf8Bytes } from 'ethers';
import { createFakeFirestore } from '../../provian-backend/src/core/pvt/__test-helpers__/fake-firestore.ts';
import { BASE_GAS_PRICE_ORACLE } from '../../provian-backend/src/core/recourse/base-transaction-fees.ts';
import { PUBLICATION_JOURNALS, PUBLICATION_ATTEMPTS, openPublicationJournal } from '../../provian-backend/src/core/recourse/publication-journal.ts';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../../provian-backend/src/core/pvt/settlement/durable-settlement-store.ts';
import { runPublicationDelivery } from './publication-runtime.mjs';
import { carriesBuilderCode, matchesPlannedCall, withBuilderCode } from '../../provian-backend/src/core/onchain/builder-code.ts';
const checks = vi.hoisted(() => ({ progress: vi.fn(), history: vi.fn(), plan: vi.fn(), durable: vi.fn() }));
vi.mock('./publication-recovery.mjs', () => ({ readPublicationProgress: checks.progress, readPublicationHistory: checks.history }));
vi.mock('./pointer-publication.mjs', () => ({ preparePointerPublication: checks.plan }));
vi.mock('./hash-authority-durable.mjs', () => ({ prepareDurableHashAuthority: checks.durable }));
const a = n => `0x${n.toString(16).padStart(40, '0')}`, h = n => `0x${n.toString(16).padStart(64, '0')}`;
const oracle = new Interface(['function getL1Fee(bytes) view returns(uint256)', 'function getL1FeeUpperBound(uint256) view returns(uint256)',
  'function getOperatorFee(uint256) view returns(uint256)']);
beforeEach(() => { for (const check of Object.values(checks)) check.mockReset(); });
function fixture(options = {}) {
  const db = options.db ?? createFakeFirestore({ strictTransactionOrder: true }), wallet = options.wallet ?? new Wallet('0x' + '11'.repeat(32)), from = wallet.address.toLowerCase();
  const state = { gasNonce: 0, authorityNonce: 0, retired: false, published: false, final: 19,
    records: [], prepared: null, loaded: 0, signed: 0, sent: 0, loseBroadcast: false, sponsorDuringSimulation: false,
    outerRevert: false, durableFailure: false, simulateFailure: false, unknownPending: false };
  const goal = { pointer: a(20), authority: a(21), revision: '1', componentsDigest: options.componentsDigest ?? h(50) };
  const lifecycleDigest = sha256(toUtf8Bytes(JSON.stringify(goal)));
  const components = Array.from({ length: 10 }, (_, i) => a(i + 30)), hashes = components.map(() => h(5));
  const baseline = { components, componentHashes: hashes }, transactions = new Map();
  const request = async (method, params) => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? 21 : params[0] === 'finalized' ? state.final : Number(BigInt(params[0]));
      return { number: '0x' + n.toString(16), hash: h(n) };
    }
    if (method === 'eth_getTransactionCount') return '0x' + (params[1] === 'pending' && state.unknownPending ? state.gasNonce + 1
      : ['latest', 'pending'].includes(params[1]) || Number(BigInt(params[1])) >= 21 ? state.gasNonce : 0).toString(16);
    if (method === 'eth_call') {
      if (params[0].to === BASE_GAS_PRICE_ORACLE) {
        const call = oracle.parseTransaction({ data: params[0].data }); return oracle.encodeFunctionResult(call.name, [100]);
      }
      if (state.simulateFailure) throw Error('simulation_refused');
      if (!matchesPlannedCall(params[0].data, '0x')) {
        expect(state.records.some(row => matchesPlannedCall(params[0].data, row.record.transaction.data))).toBe(true);
        if (state.sponsorDuringSimulation) {
          state.sponsorDuringSimulation = false; state.retired = true; state.authorityNonce++; state.outerRevert = true;
        }
      }
      return '0x';
    }
    if (method === 'eth_estimateGas') return '0x7530';
    if (method === 'eth_sendRawTransaction') {
      const tx = Transaction.from(params[0]);
      expect(carriesBuilderCode(tx.data)).toBe(true); // every operator transaction carries Provian's Builder Code
      const retained = db.store ? [...db.store.entries()].filter(([key]) => key.startsWith(PUBLICATION_ATTEMPTS + '/') && key.includes(':variant:'))
        : [['proof', (await db.collection(PUBLICATION_ATTEMPTS).doc(`${lifecycleDigest}:${tx.nonce}:variant:0`).get()).data()]];
      expect(retained.some(([, row]) => row.variant.raw === params[0])).toBe(true);
      if (!transactions.has(tx.hash)) {
        expect(tx.nonce).toBe(state.gasNonce); state.gasNonce++; state.sent++;
        const operation = state.records.find(row => matchesPlannedCall(tx.data, row.record.transaction.data));
        const success = !state.outerRevert;
        if (operation && success) {
          if (operation.plan.stage === 'retire') state.retired = true; else state.published = true;
          state.authorityNonce++;
        }
        transactions.set(tx.hash, { tx, success });
      }
      if (state.loseBroadcast) { state.loseBroadcast = false; throw Error('broadcast_reply_lost'); }
      return tx.hash;
    }
    const row = transactions.get(params[0]), tx = row?.tx;
    if (method === 'eth_getTransactionReceipt') return tx ? { transactionHash: tx.hash, blockNumber: '0x15', blockHash: h(21),
      status: row.success ? '0x1' : '0x0', contractAddress: null } : null;
    if (method === 'eth_getTransactionByHash') return tx ? { hash: tx.hash, from: tx.from, to: tx.to, nonce: '0x' + tx.nonce.toString(16),
      chainId: '0x2105', value: '0x0', input: tx.data, blockNumber: '0x15', blockHash: h(21) } : null;
    throw Error('unexpected ' + method);
  };
  const readers = ['one', 'two'].map(operatorId => ({ operatorId, request }));
  checks.history.mockImplementation(async () => state.records.length ? { records: structuredClone(state.records), goal } : null);
  checks.progress.mockImplementation(async () => ({ records: structuredClone(state.records), nonce: String(state.authorityNonce),
    root: h(state.authorityNonce + 100), runtimeHash: h(90), baseline, checkpoint: { number: state.final, hash: h(state.final) },
    current: structuredClone(state.records.find(row => row.record.operation.nonce === String(state.authorityNonce)) ?? null),
    outcome: { goal, status: state.retired || state.published ? 'achieved' : 'pending', revision: state.published ? '1' : '0',
      publication: state.published ? { transactionHash: h(500) } : null } }));
  checks.plan.mockImplementation(async input => {
    state.prepared = { ...baseline, stage: input.stage, complete: input.stage === 'retire' && state.retired,
      hashAuthorityPlan: { nonce: String(state.authorityNonce), currentRoot: h(state.authorityNonce + 100) } };
    return structuredClone(state.prepared);
  });
  checks.durable.mockImplementation(async input => {
    expect(input.plan).toEqual(state.prepared.hashAuthorityPlan);
    if (state.durableFailure) throw Error('durable_write_unconfirmed');
    const record = { operation: { nonce: String(state.authorityNonce) }, transaction: { to: a(21), data: '0x1234' + state.authorityNonce.toString(16).padStart(2, '0') } };
    state.records.push({ plan: structuredClone(state.prepared), record, cancellation: null }); return structuredClone(record);
  });
  const input = { inputs: { callGas: '2000000', port: { rpcs: readers, finalizedBlock: async () => ({ number: state.final, hash: h(state.final) }), blockHash: async n => h(n) } },
    db, from, store: {}, vault: {}, approvedBudgetWei: '1000000', maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, maxGas: 100000n,
    loadSigner: async address => {
      expect(address).toBe(from); state.loaded++;
      const heads = db.store ? [...db.store.entries()].filter(([key]) => key.startsWith(PUBLICATION_JOURNALS + '/'))
        : [['proof', (await db.collection(PUBLICATION_JOURNALS).doc(lifecycleDigest).get()).data()]];
      expect(heads).toHaveLength(1); expect(BigInt(heads[0][1].feeReservedWei)).toBeGreaterThan(0n);
      return { getAddress: async () => from, signTransaction: async tx => { state.signed++; return wallet.signTransaction(tx); } };
    } };
  return { input, state, db, transactions, lifecycleDigest, goal, run: () => runPublicationDelivery(input) };
}
test.each(['existing-progress','existing-nonces','new-nonces'])('slow %s reads renew the same owner before reserving a gas nonce',async mode=>{
 const f=fixture();let clock=Date.now(),delayed=false;const now=vi.spyOn(Date,'now').mockImplementation(()=>clock);
 try{
  if(mode.startsWith('existing')){const plan=await checks.plan({stage:'retire'});await checks.durable({plan:plan.hashAuthorityPlan});}
  if(mode==='existing-progress'){
   const original=checks.progress.getMockImplementation();
   checks.progress.mockImplementation(async(...args)=>{if(!delayed){delayed=true;clock+=180000;}return original(...args);});
  }else for(const reader of f.input.inputs.port.rpcs){
   const original=reader.request;
   reader.request=async(method,params)=>{if(method==='eth_getTransactionCount'&&!delayed){delayed=true;clock+=180000;}return original(method,params);};
  }
  expect((await f.run()).status).toBe('submitted');expect(delayed).toBe(true);
  expect([f.state.signed,f.state.sent,f.state.records.length]).toEqual([1,1,1]);
 }finally{now.mockRestore();}
});
test('slow nonce reads cannot reserve or sign after a competing owner acquires and expires',async()=>{
 const f=fixture();let clock=Date.now(),delayed=false;const now=vi.spyOn(Date,'now').mockImplementation(()=>clock);
 try{
  for(const reader of f.input.inputs.port.rpcs){const original=reader.request;
   reader.request=async(method,params)=>{
    if(method==='eth_getTransactionCount'&&!delayed){
     delayed=true;clock+=180000;
     await openPublicationJournal(f.db,{goal:f.goal,from:f.input.from,approvedBudgetWei:f.input.approvedBudgetWei,
      readers:f.input.inputs.port.rpcs,workerId:'competing'});
     clock+=180000;
    }
    return original(method,params);
   };
  }
  await expect(f.run()).rejects.toThrow('lease_lost');
  expect([f.state.loaded,f.state.signed,f.state.sent]).toEqual([0,0,0]);
  const head=f.db.store.get(`${PUBLICATION_JOURNALS}/${f.lifecycleDigest}`);
  expect(head.attemptCount).toBe(0);expect(head.feeReservedWei).toBe('0');
  expect(f.db.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.input.from}`).owner).toBe('competing');
 }finally{now.mockRestore();}
});
test('actual journal and gas persistence deliver retirement and publication, surviving a lost broadcast reply', async () => {
  const f = fixture(); f.state.loseBroadcast = true;
  await expect(f.run()).rejects.toThrow(/broadcast_reply_lost/);
  expect(f.state.records).toHaveLength(1); expect(f.state.signed).toBe(1);
  expect((await f.run()).status).toBe('awaiting_finality'); expect(f.state.signed).toBe(1);
  f.state.final = 30; expect((await f.run()).status).toBe('advance');
  expect((await f.run()).status).toBe('submitted'); expect(f.state.records).toHaveLength(2);
  expect((await f.run()).status).toBe('advance'); expect((await f.run()).status).toBe('confirmed');
  const counts = [f.state.loaded, f.state.signed, f.state.sent];
  expect((await f.run()).status).toBe('confirmed'); expect([f.state.loaded, f.state.signed, f.state.sent]).toEqual(counts);
  expect(counts).toEqual([2, 2, 2]);
});
test('an outer revert closes only after finalized gas nonce consumption and reuses the durable authority proof', async () => {
  const f = fixture(); f.state.outerRevert = true;
  expect((await f.run()).status).toBe('submitted'); expect(f.state.authorityNonce).toBe(0);
  expect((await f.run()).status).toBe('awaiting_finality');
  f.state.final = 30; expect((await f.run()).status).toBe('advance'); f.state.outerRevert = false;
  expect((await f.run()).status).toBe('submitted'); expect(f.state.records).toHaveLength(1); expect(f.state.signed).toBe(2);
  expect(f.state.authorityNonce).toBe(1);
});
test('third-party sponsorship during simulation preserves the proof and never treats semantic success as gas closure', async () => {
  const f = fixture(); f.state.sponsorDuringSimulation = true;
  expect((await f.run()).status).toBe('submitted'); expect(f.state.authorityNonce).toBe(1);
  expect((await f.run()).status).toBe('awaiting_finality');
  const head = [...f.db.store.entries()].find(([key]) => key.startsWith(PUBLICATION_JOURNALS + '/'))[1];
  expect(head.completed).toBe(false);
  f.state.final = 30; expect((await f.run()).status).toBe('advance');
  f.state.outerRevert = false; expect((await f.run()).status).toBe('submitted');
  expect(f.state.records.map(row => row.record.operation.nonce)).toEqual(['0', '1']);
});
test('a shared budget cannot be reset by retrying an outer revert', async () => {
  const f = fixture(); f.input.approvedBudgetWei = '80000'; f.state.outerRevert = true;
  await f.run(); f.state.final = 30; await f.run();
  await expect(f.run()).rejects.toThrow(/budget_exhausted/); expect(f.state.signed).toBe(1);
  f.input.approvedBudgetWei = '1000000'; await expect(f.run()).rejects.toThrow(/configuration_changed/);
});
test.each(['durability', 'simulation', 'budget', 'unknown-pending', 'lineage', 'reader', 'configuration'])('%s refuses before any gas key access', async mode => {
  const f = fixture();
  if (mode === 'durability') f.state.durableFailure = true;
  if (mode === 'simulation') f.state.simulateFailure = true;
  if (mode === 'budget') f.input.approvedBudgetWei = '1';
  if (mode === 'unknown-pending') f.state.unknownPending = true;
  if (mode === 'lineage') checks.progress.mockRejectedValue(Error('unknown_current_root'));
  if (mode === 'reader') f.input.inputs.port.rpcs[1].operatorId = 'one';
  if (mode === 'configuration') f.input.maxGas = 0n;
  await expect(f.run()).rejects.toThrow(); expect([f.state.loaded, f.state.signed, f.state.sent]).toEqual([0, 0, 0]);
});
test('a retained gas call outside authenticated authority records refuses even on restart', async () => {
  const f = fixture(); await f.run(); f.state.records[0].record.transaction.data = '0xffff';
  await expect(f.run()).rejects.toThrow(/unknown_retained_operation/); expect(f.state.signed).toBe(1);
});
test('lost append response resumes exactly the persisted signature', async () => {
  const f = fixture(), transact = f.db.runTransaction.bind(f.db); let lost = false;
  f.db.runTransaction = async action => {
    const result = await transact(action);
    if (!lost && [...f.db.store.keys()].some(key => key.startsWith(PUBLICATION_ATTEMPTS + '/') && key.includes(':variant:'))) {
      lost = true; throw Error('append_reply_lost');
    }
    return result;
  };
  await expect(f.run()).rejects.toThrow(/append_reply_lost/); expect(f.state.signed).toBe(1); expect(f.state.sent).toBe(0);
  expect((await f.run()).status).toBe('submitted'); expect(f.state.signed).toBe(1); expect(f.state.sent).toBe(1);
});
test('fee and semantic goal changes cannot silently complete a held lifecycle', async () => {
  const f = fixture(); await f.run(); f.state.final = 30; await f.run(); await f.run(); await f.run();
  const base = checks.progress.getMockImplementation(); let reads = 0;
  checks.progress.mockImplementation(async (...args) => { const result = await base(...args); if (++reads > 1) result.outcome.publication = null; return result; });
  await expect(f.run()).rejects.toThrow(/goal_unverified/);
});
test('gas cancellation preserves original bytes and reserves its fee before signing the same nonce', async () => {
  const f = fixture(); await f.run();
  for (const reader of f.input.inputs.port.rpcs) {
    const original = reader.request;
    reader.request = async (method, params) => {
      if (method === 'eth_getTransactionReceipt') return null;
      if (method === 'eth_sendRawTransaction') {
        const tx = Transaction.from(params[0]); expect(tx.to.toLowerCase()).toBe(f.input.from);
        expect(tx.data).toBe(withBuilderCode('0x')); expect(tx.value).toBe(0n); expect(tx.nonce).toBe(0); // a self-cancel carries only the Builder Code
        const variants = [...f.db.store.entries()].filter(([key]) => key.startsWith(PUBLICATION_ATTEMPTS + '/') && key.includes(':variant:'));
        expect(variants).toHaveLength(2); expect(variants[0][1].variant.kind).toBe('call'); expect(variants[1][1].variant.kind).toBe('cancel');
        return tx.hash;
      }
      return original(method, params);
    };
  }
  f.input.cancelGas = true;
  checks.progress.mockRejectedValue(Error('current_source_changed'));
  await expect(f.run()).rejects.toThrow(/cancellation_fee_bump_required/); expect(f.state.signed).toBe(1);
  f.input.maxFeePerGas = 3n; f.input.maxPriorityFeePerGas = 2n;
  expect(await f.run()).toMatchObject({ status: 'submitted', kind: 'cancel' }); expect(f.state.signed).toBe(2);
  expect(await f.run()).toMatchObject({ status: 'submitted', kind: 'cancel' }); expect(f.state.signed).toBe(2);
  f.state.final = 30; expect((await f.run()).status).toBe('advance');
});
test.each(['durable', 'fee', 'key', 'signed'])('source drift during %s awaits refuses our next exposure/sign/send boundary', async boundary => {
  const f = fixture();
  const changed = () => checks.progress.mockRejectedValue(Error('source_reactivated'));
  if (boundary === 'durable') {
    const original = checks.durable.getMockImplementation();
    checks.durable.mockImplementation(async (...args) => { const record = await original(...args); changed(); return record; });
  }
  if (boundary === 'fee') for (const reader of f.input.inputs.port.rpcs) {
    const original = reader.request;
    reader.request = async (method, params) => {
      const result = await original(method, params); if (method === 'eth_call' && params[0].to === BASE_GAS_PRICE_ORACLE) changed(); return result;
    };
  }
  if (boundary === 'key' || boundary === 'signed') {
    const original = f.input.loadSigner;
    f.input.loadSigner = async (...args) => {
      const signer = await original(...args);
      if (boundary === 'key') changed();
      else { const sign = signer.signTransaction; signer.signTransaction = async tx => { const raw = await sign(tx); changed(); return raw; }; }
      return signer;
    };
  }
  await expect(f.run()).rejects.toThrow(/source_reactivated/);
  expect(f.state.sent).toBe(0); expect(f.state.signed).toBe(boundary === 'signed' ? 1 : 0);
});
test('source refusal cannot block canonical closure of an already consumed sponsor nonce', async () => {
  const f = fixture(); await f.run(); f.state.final = 30; checks.progress.mockRejectedValue(Error('source_reactivated'));
  expect((await f.run()).status).toBe('advance'); expect(f.state.signed).toBe(1);
  await expect(f.run()).rejects.toThrow(/source_reactivated/);
});
test('historical workflow completion markers cannot start a missing publication journal', async () => {
  const f = fixture(); f.input.requireCompleted = true;
  await expect(f.run()).rejects.toThrow(/not_completed/);
  expect(f.db.store.size).toBe(0); expect(f.state.loaded).toBe(0); expect(f.state.records).toHaveLength(0);
});
test.each(['latest-header', 'simulation', 'estimate'])('source drift during %s prevents the next executable proof RPC', async boundary => {
  const f = fixture(); let calls = 0, estimates = 0, feeCalls = 0;
  for (const reader of f.input.inputs.port.rpcs) {
    const original = reader.request;
    reader.request = async (method, params) => {
      if (method === 'eth_call' && params[0].to !== BASE_GAS_PRICE_ORACLE) calls++;
      if (method === 'eth_estimateGas') estimates++;
      if (method === 'eth_call' && params[0].to === BASE_GAS_PRICE_ORACLE) feeCalls++;
      const result = await original(method, params);
      if (boundary === 'latest-header' && method === 'eth_getBlockByNumber' && params[0] === 'latest'
        || boundary === 'simulation' && method === 'eth_call' && params[0].to !== BASE_GAS_PRICE_ORACLE
        || boundary === 'estimate' && method === 'eth_estimateGas')
        checks.progress.mockRejectedValue(Error('source_reactivated'));
      return result;
    };
  }
  await expect(f.run()).rejects.toThrow(/source_reactivated/);
  expect(calls).toBe(boundary === 'latest-header' ? 0 : 2);
  expect(estimates).toBe(boundary === 'estimate' ? 2 : 0);
  expect(feeCalls).toBe(0); expect(f.state.signed).toBe(0);
});

test('full publication proofs run at exposure boundaries rather than every lease renewal', async () => {
  const f = fixture(), events = []; f.input.onProgress = event => events.push(event);
  expect((await f.run()).status).toBe('submitted');
  expect(checks.progress).toHaveBeenCalledTimes(7); // two discovery reads, five exposure boundaries
  expect(events.filter(event => event.event === 'source_validation_verified').map(event => event.boundary))
    .toEqual(['simulation', 'estimate', 'fee', 'sign', 'broadcast']);
  expect(events.filter(event => event.event === 'transaction_signed')).toHaveLength(1);
  expect([f.state.signed, f.state.sent]).toEqual([1, 1]);
});

test('retained executable bytes revalidate after awaited broadcast reads without signing again', async () => {
  const f = fixture(), transact = f.db.runTransaction.bind(f.db); let lost = false;
  f.db.runTransaction = async action => {
    const result = await transact(action);
    if (!lost && [...f.db.store.keys()].some(key => key.includes(':variant:'))) {
      lost = true; throw Error('append_reply_lost');
    }
    return result;
  };
  await expect(f.run()).rejects.toThrow('append_reply_lost');
  const signed = f.state.signed;
  for (const reader of f.input.inputs.port.rpcs) {
    const original = reader.request;
    reader.request = async (method, params) => {
      const result = await original(method, params);
      if (method === 'eth_chainId') checks.progress.mockRejectedValue(Error('source_reactivated'));
      return result;
    };
  }
  await expect(f.run()).rejects.toThrow('source_reactivated');
  expect(f.state.signed).toBe(signed); expect(f.state.sent).toBe(0);
});

// Explicit opt-in integration proof: real production database adapter, isolated
// random signer/goal, synthetic RPC only. No admin/minter key or broadcast.
test.runIf(process.env.RECOURSE_FIRESTORE_ORDER_PROOF === 'provian-ai/relay')('production Firestore ordering survives the full publication runtime', async () => {
  expect(process.env.GOOGLE_CLOUD_PROJECT).toBe('provian-ai');
  expect(process.env.FIRESTORE_DATABASE_ID).toBe('relay');
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBeUndefined();
  const { scriptDb } = await import('../../provian-backend/scripts/lib/script-db.ts');
  const { SETTLEMENT_SIGNER_LEASES_COLLECTION } = await import('../../provian-backend/src/core/pvt/settlement/durable-settlement-store.ts');
  const db = scriptDb(), wallet = Wallet.createRandom();
  const f = fixture({ db, wallet, componentsDigest: sha256(toUtf8Bytes(wallet.address)) });
  const refs = [db.collection(PUBLICATION_JOURNALS).doc(f.lifecycleDigest),
    db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(f.input.from)];
  for (let index = 0; index < 2; index++) for (const suffix of ['', ':fee:0', ':variant:0'])
    refs.push(db.collection(PUBLICATION_ATTEMPTS).doc(`${f.lifecycleDigest}:${index}${suffix}`));
  for (const ref of refs) expect((await ref.get()).exists).toBe(false);
  try {
    expect((await f.run()).status).toBe('submitted');
    const ref = db.collection(PUBLICATION_ATTEMPTS).doc(`${f.lifecycleDigest}:0`);
    const stored = (await ref.get()).get('authorityTransaction');
    const constructed = { to: stored.to, data: stored.data };
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(constructed)); // old comparator RED on real readback
    console.log('FIRESTORE_PUBLICATION_ORDER', JSON.stringify({ storedKeys: Object.keys(stored), constructedKeys: Object.keys(constructed) }));
    expect((await f.run()).status).toBe('awaiting_finality');
    const counts = [f.state.loaded, f.state.signed, f.state.sent];
    for (const changed of [{ ...stored, to: a(99) }, { ...stored, data: '0xffff' },
      { ...stored, extra: true }, { to: stored.to }]) {
      await ref.update({ authorityTransaction: changed });
      await expect(f.run()).rejects.toThrow(/unknown_retained_operation|attempt_invalid|call_changed/);
      expect([f.state.loaded, f.state.signed, f.state.sent]).toEqual(counts);
    }
    await ref.update({ authorityTransaction: stored });
    f.state.final = 30;
    expect((await f.run()).status).toBe('advance');
    expect((await f.run()).status).toBe('submitted');
    expect((await f.run()).status).toBe('advance');
    expect((await f.run()).status).toBe('confirmed');
    const finalCounts = [f.state.loaded, f.state.signed, f.state.sent];
    expect((await f.run()).status).toBe('confirmed');
    expect([f.state.loaded, f.state.signed, f.state.sent]).toEqual(finalCounts);
    expect(finalCounts).toEqual([2, 2, 2]);
    console.log('FIRESTORE_PUBLICATION_PASS', JSON.stringify({ lifecycleDigest: f.lifecycleDigest, attempts: 2, mutationRefusals: 4, realBroadcasts: 0 }));
  } finally {
    for (const ref of refs) await ref.delete();
    for (const ref of refs) expect((await ref.get()).exists).toBe(false);
  }
}, 180000);

test('reordered publication call maps retain exact identity and reject value or field changes', async () => {
  const f = fixture(); await f.run();
  const key = `${PUBLICATION_ATTEMPTS}/${f.lifecycleDigest}:0`, row = f.db.store.get(key);
  const call = row.authorityTransaction;
  row.authorityTransaction = { data: call.data, to: call.to };
  expect((await f.run()).status).toBe('awaiting_finality');
  for (const changed of [{ ...call, data: '0xffff' }, { ...call, extra: true }]) {
    row.authorityTransaction = changed;
    await expect(f.run()).rejects.toThrow(/unknown_retained_operation|call_changed/);
    expect(f.state.signed).toBe(1);
  }
});
