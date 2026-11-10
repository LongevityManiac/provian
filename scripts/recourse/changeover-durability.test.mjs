import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Wallet, keccak256 } from 'ethers';
import { advanceChangeoverStage } from './changeover-stage.mjs';
import { openChangeoverJournal } from '../../provian-backend/src/core/recourse/changeover-journal.ts';
import { createFakeFirestore } from '../../provian-backend/src/core/pvt/__test-helpers__/fake-firestore.ts';

test('the actual ordered runner resumes an interrupted durable stage without signing another nonce', async () => {
  const db = createFakeFirestore({ strictTransactionOrder: true });
  const wallet = new Wallet('0x' + '11'.repeat(32)), from = wallet.address.toLowerCase();
  const steps = [0, 1].map(index => ({ from, to: '0x' + '22'.repeat(20), value: '0', data: '0x1234000' + index }));
  const planDigest = '0x' + '33'.repeat(32);
  let nonce = 0, signatures = 0, loseReply = true, final = false;
  const finalized = async raw => final ? { hash: keccak256(raw), status: 1 } : null;
  const signer = {
    chainId: async () => 8453n, signerAddress: async () => from,
    nonces: async () => ({ latest: nonce, pending: nonce }),
    prepare: async step => {
      signatures++;
      return wallet.signTransaction({ type: 2, chainId: 8453, nonce: step.nonce, to: step.to,
        data: step.data, value: 0, gasLimit: 100000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 });
    },
    finalized,
    broadcast: async raw => {
      if (loseReply) { loseReply = false; throw Error('lost RPC reply'); }
      nonce++; return keccak256(raw);
    },
  };
  async function run(workerId) {
    const store = await openChangeoverJournal(db, { planDigest, steps, workerId });
    try {
      return await advanceChangeoverStage({ steps, planDigest, journal: store.read(),
        port: { assertLease: store.assertLease, assertPlan: async hash => assert.equal(hash, planDigest),
          forSigner: () => signer, included: async raw => ({ hash: keccak256(raw), status: 1 }) },
        persist: next => next.completed ? store.complete(finalized) : store.persist(next) });
    } finally { await store.release(); }
  }
  await assert.rejects(run('first'), /lost RPC reply/); assert.equal(signatures, 1);
  assert.equal((await run('resumed')).status, 'awaiting_finality'); assert.equal(signatures, 2);
  final = true; assert.equal((await run('finished')).status, 'confirmed'); assert.equal(signatures, 2);
  assert.equal((await run('terminal-restart')).status, 'confirmed'); assert.equal(signatures, 2);
  final = false; await assert.rejects(run('bad-finality'), /not_finalized/); assert.equal(signatures, 2);
});
