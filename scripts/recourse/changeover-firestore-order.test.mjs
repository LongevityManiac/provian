import { test, expect } from 'vitest';
import { Wallet, Transaction, Interface, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { openChangeoverJournal, CHANGEOVER_STAGES, CHANGEOVER_ATTEMPTS } from '../../provian-backend/src/core/recourse/changeover-journal.ts';
import { openChangeoverFeeBudget } from '../../provian-backend/src/core/recourse/changeover-fees.ts';
import { openHashAuthorityOperationStore, HASH_AUTHORITY_OPERATIONS } from '../../provian-backend/src/core/recourse/hash-authority-operation-store.ts';
import { hashAccountCall, hashAccountIntentDigest } from '../../provian-backend/src/core/recourse/hash-account-data.ts';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../../provian-backend/src/core/pvt/wp4/durable-settlement-store.ts';

// Opt-in only. Existing production database, random test identities, actual
// persistence adapters. Chain evidence is synthetic; no provider or real signer.
const integration = test.runIf(process.env.RECOURSE_FIRESTORE_ORDER_PROOF === 'provian-ai/relay');
const h = n => '0x' + n.toString(16).padStart(64, '0'), a = n => '0x' + n.toString(16).padStart(40, '0');
async function database() {
  expect(process.env.GOOGLE_CLOUD_PROJECT).toBe('provian-ai');
  expect(process.env.FIRESTORE_DATABASE_ID).toBe('relay');
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBeUndefined();
  const { scriptDb } = await import('../../provian-backend/scripts/lib/script-db.ts');
  return scriptDb();
}
const oracle = new Interface(['function getL1Fee(bytes) view returns(uint256)',
  'function getL1FeeUpperBound(uint256) view returns(uint256)', 'function getOperatorFee(uint256) view returns(uint256)']);
const readers = ['proof-one', 'proof-two'].map(operatorId => ({ operatorId, request: async (method, params) => {
  if (method === 'eth_chainId') return '0x2105';
  expect(method).toBe('eth_call');
  const call = oracle.parseTransaction({ data: params[0].data });
  return oracle.encodeFunctionResult(call.name, [100]);
} }));

integration.each(['pointer', 'successor', 'activation'])('production Firestore %s journal, fee reservation and terminal replay ignore map order', async phase => {
  const db = await database(), wallet = Wallet.createRandom(), from = wallet.address.toLowerCase();
  const planDigest = sha256(toUtf8Bytes(phase + wallet.address));
  const steps = Array.from({ length: 2 }, (_, index) => ({ from, to: a(22), data: `0x1234${index.toString(16).padStart(2, '0')}`, value: '0' }));
  const stageDigest = sha256(toUtf8Bytes(JSON.stringify({ planDigest, steps })));
  const headRef = db.collection(CHANGEOVER_STAGES).doc(stageDigest);
  const refs = [headRef, db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(from)];
  for (let i = 0; i < 2; i++) for (const suffix of ['', ':fee']) refs.push(db.collection(CHANGEOVER_ATTEMPTS).doc(`${stageDigest}:${i}${suffix}`));
  for (const ref of refs) expect((await ref.get()).exists).toBe(false);
  let journal;
  try {
    journal = await openChangeoverJournal(db, { planDigest, steps });
    const budget = await openChangeoverFeeBudget(db, { stageDigest, approvedBudgetWei: '1000000', readers, assertLease: () => journal.assertLease() });
    for (let index = 0; index < 2; index++) {
      const step = steps[index];
      const identity = keccak256(Transaction.from({ type: 2, chainId: 8453, nonce: 0, to: step.to, value: 0,
        data: step.data, gasLimit: 0, maxFeePerGas: 0, maxPriorityFeePerGas: 0 }).unsignedSerialized);
      const unsigned = { identity, from, nonce: index, raw: null, hash: null };
      await journal.persist({ ...journal.read(), attempts: { ...journal.read().attempts, [index]: unsigned } });
      const ref = db.collection(CHANGEOVER_ATTEMPTS).doc(`${stageDigest}:${index}`);
      const stored = (await ref.get()).get('attempt');
      expect(JSON.stringify(stored)).not.toBe(JSON.stringify(unsigned)); // real readback kills old comparator
      expect(stored).toEqual(unsigned);
      const transaction = { type: 2, chainId: 8453, nonce: index, to: step.to, data: step.data,
        value: 0, gasLimit: 100000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 };
      await budget.reserve(index, from, transaction, h(100));
      const fee = (await db.collection(CHANGEOVER_ATTEMPTS).doc(`${stageDigest}:${index}:fee`).get()).data();
      expect(fee.unsignedHash).toBe(keccak256(Transaction.from(transaction).unsignedSerialized));
      const raw = await wallet.signTransaction(transaction), signed = { ...unsigned, raw, hash: keccak256(raw) };
      if (index === 0) {
        for (const changed of [{ ...stored, nonce: 99 }, { ...stored, extra: true }]) {
          await ref.update({ attempt: changed });
          await expect(journal.persist({ ...journal.read(), attempts: { ...journal.read().attempts, [index]: signed } })).rejects.toThrow('record_changed');
        }
        await ref.update({ attempt: stored });
      }
      await journal.persist({ ...journal.read(), attempts: { ...journal.read().attempts, [index]: signed } });
      expect((await ref.get()).get('attempt')).toEqual(signed);
      console.log('FIRESTORE_CHANGEOVER_ORDER', JSON.stringify({ phase, index, storedKeys: Object.keys(stored), constructedKeys: Object.keys(unsigned) }));
    }
    const saved = journal.read(), fees = (await headRef.get()).get('feeReservedWei');
    await journal.release();
    journal = await openChangeoverJournal(db, { planDigest, steps });
    expect(journal.read()).toEqual(saved);
    expect((await headRef.get()).get('feeReservedWei')).toBe(fees);
    const finalized = async raw => ({ hash: keccak256(raw), status: 1 });
    await journal.complete(finalized); await journal.release(); journal = null;
    const terminal = await openChangeoverJournal(db, { planDigest, steps, requireCompleted: true });
    await terminal.complete(finalized); expect(terminal.read().completed).toBe(true); await terminal.release();
    console.log('FIRESTORE_CHANGEOVER_PASS', JSON.stringify({ phase, stageDigest, attempts: 2, mutationRefusals: 2, realBroadcasts: 0 }));
  } finally {
    if (journal) await journal.release();
    for (const ref of refs) await ref.delete();
    for (const ref of refs) expect((await ref.get()).exists).toBe(false);
  }
}, 180000);

integration('production Firestore authority payload retains exact string bytes and rejects tampering', async () => {
  const db = await database(), slot = sha256(toUtf8Bytes(Wallet.createRandom().address)), store = openHashAuthorityOperationStore(db);
  const ref = db.collection(HASH_AUTHORITY_OPERATIONS).doc(slot.slice(2));
  expect((await ref.get()).exists).toBe(false);
  // Public format fixture only. Real SLH signature validation is separately
  // tested in hash-authority-durable; no executable real authority is used.
  const operation = { chainId: '8453', account: a(1), target: a(2), nonce: '0', value: '0', callGas: '2000000', data: '0x1234',
    nextCommitment: h(2), publicKey: h(3), signingRoot: sha256(h(3)), signature: '0x' + '00'.repeat(7856) };
  const record = { schema: 'provian.durable-hash-authority.v1', planDigest: h(4), accountRuntimeHash: h(5), operation,
    nextItemId: 'public-proof-reference', intentDigest: hashAccountIntentDigest(operation), verifiedBlock: { number: 100, hash: h(100) },
    transaction: { chainId: '8453', to: operation.account, value: '0', data: hashAccountCall(operation) } };
  try {
    await store.create(slot, record);
    const row = (await ref.get()).data();
    expect(typeof row.payload).toBe('string'); expect(row.payload).toBe(JSON.stringify(record));
    expect(await store.read(slot)).toEqual(record);
    await expect(store.create(slot, record)).rejects.toThrow('slot_exists');
    await ref.update({ payload: row.payload + ' ' });
    await expect(store.read(slot)).rejects.toThrow('record_corrupt');
    console.log('FIRESTORE_AUTHORITY_PASS', JSON.stringify({ slot, exactPayloadBytes: true, corruptionRefused: true }));
  } finally { await ref.delete(); expect((await ref.get()).exists).toBe(false); }
}, 90000);
