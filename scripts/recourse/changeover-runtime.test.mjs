import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Interface, Wallet, Transaction, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { runChangeoverStage } from './changeover-runtime.mjs';
import { createFakeFirestore } from '../../provian-backend/src/core/pvt/__test-helpers__/fake-firestore.ts';
import { CHANGEOVER_STAGES } from '../../provian-backend/src/core/recourse/changeover-journal.ts';
import { BASE_GAS_PRICE_ORACLE } from '../../provian-backend/src/core/recourse/base-transaction-fees.ts';
const oracle = new Interface(['function getL1Fee(bytes) view returns(uint256)',
  'function getL1FeeUpperBound(uint256) view returns(uint256)', 'function getOperatorFee(uint256) view returns(uint256)']);
const hash = n => '0x' + n.toString(16).padStart(64, '0');
function fixture() {
  const db = createFakeFirestore({ strictTransactionOrder: true });
  const wallet = new Wallet('0x' + '11'.repeat(32)), from = wallet.address.toLowerCase();
  const steps = [0, 1].map(index => ({ from, to: '0x' + '22'.repeat(20), value: '0', data: '0x1234000' + index }));
  const authorizedSteps = structuredClone(steps);
  const state = { nonce: 0, signed: 0, loaded: 0, sent: 0, final: 19, loseReply: false, refusePlan: false, refuseSimulation: false, oracleUnavailable: false };
  const transactions = new Map();
  const request = async (method, params) => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getTransactionCount') return '0x' + state.nonce.toString(16);
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? 21 : params[0] === 'finalized' ? state.final : Number(BigInt(params[0]));
      return { number: '0x' + n.toString(16), hash: hash(n) };
    }
    if (method === 'eth_call') {
      if (params[0].to === BASE_GAS_PRICE_ORACLE) {
        if (state.oracleUnavailable) throw Error('oracle unavailable');
        assert.deepEqual(params[1], { blockHash: hash(21), requireCanonical: true });
        const parsed = oracle.parseTransaction({ data: params[0].data });
        return oracle.encodeFunctionResult(parsed.name, [parsed.name === 'getOperatorFee' ? 100 : 700]);
      }
      if (state.refuseSimulation) throw Error('simulation refused');
      return '0x';
    }
    if (method === 'eth_estimateGas') return '0x7530';
    if (method === 'eth_sendRawTransaction') {
      const tx = Transaction.from(params[0]); assert.equal(tx.nonce, state.nonce);
      state.sent++; state.nonce++; transactions.set(tx.hash, tx);
      if (state.loseReply) { state.loseReply = false; throw Error('broadcast reply lost'); }
      return tx.hash;
    }
    const tx = transactions.get(params[0]);
    if (method === 'eth_getTransactionReceipt') return tx ? { transactionHash: tx.hash, blockNumber: '0x15', blockHash: hash(21), status: '0x1', contractAddress: null } : null;
    if (method === 'eth_getTransactionByHash') return tx ? { hash: tx.hash, from: tx.from, to: tx.to,
      nonce: '0x' + tx.nonce.toString(16), chainId: '0x2105', value: '0x0', input: tx.data, blockNumber: '0x15', blockHash: hash(21) } : null;
    throw Error('unexpected ' + method);
  };
  const input = { db, steps, planDigest: hash(99), readers: ['one', 'two'].map(operatorId => ({ operatorId, request })),
    approvedStageBudgetWei: '200000', maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, maxGas: 100000n,
    assertPlan: async checked => {
      assert.equal(checked.planDigest, hash(99)); assert.deepEqual(checked.steps, authorizedSteps);
      assert.equal(checked.stageDigest, sha256(toUtf8Bytes(JSON.stringify({ planDigest: hash(99), steps: authorizedSteps }))));
      if (state.refusePlan) throw Error('source changed');
    },
    loadSigner: async signer => {
      assert.equal(signer, from); state.loaded++;
      const heads = [...db.store.entries()].filter(([key]) => key.startsWith(CHANGEOVER_STAGES + '/'));
      assert.equal(heads.length, 1); assert.ok(BigInt(heads[0][1].feeReservedWei) > 0n);
      return { getAddress: async () => from, signTransaction: async tx => { state.signed++; return wallet.signTransaction(tx); } };
    } };
  return { input, state, db, run: () => runChangeoverStage(input) };
}
test('actual journal, fee oracle and RPC runner survive a lost broadcast response with no duplicate signatures', async () => {
  const f = fixture(); f.state.loseReply = true;
  await assert.rejects(f.run(), /broadcast reply lost/);
  assert.equal(f.state.signed, 1); assert.equal(f.state.sent, 1);
  const resumed = await f.run(); assert.equal(resumed.status, 'awaiting_finality');
  assert.equal(resumed.attempts, 2); assert.equal(f.state.signed, 2); assert.equal(f.state.sent, 2);
  f.state.final = 30; assert.equal((await f.run()).status, 'confirmed');
  const counts = { loaded: f.state.loaded, signed: f.state.signed, sent: f.state.sent };
  assert.equal((await f.run()).status, 'confirmed');
  assert.deepEqual({ loaded: f.state.loaded, signed: f.state.signed, sent: f.state.sent }, counts);
  const head = [...f.db.store.entries()].find(([key]) => key.startsWith(CHANGEOVER_STAGES + '/'))[1];
  assert.equal(head.feeReservedWei, '145600'); assert.equal(head.completed, true);
});
test('plan, simulation, oracle and insufficient fee budget prevent any key access', async () => {
  for (const change of [
    f => { f.state.refusePlan = true; },
    f => { f.state.refuseSimulation = true; },
    f => { f.state.oracleUnavailable = true; },
    f => { f.input.approvedStageBudgetWei = '1'; },
    f => { f.input.readers[1].operatorId = 'one'; },
  ]) {
    const f = fixture(); change(f); await assert.rejects(f.run());
    assert.equal(f.state.loaded, 0); assert.equal(f.state.signed, 0); assert.equal(f.state.sent, 0);
  }
});
test('a stage budget is shared by all steps and exhausted before the next signature', async () => {
  const f = fixture(); f.input.approvedStageBudgetWei = '100000';
  await assert.rejects(f.run(), /budget_exhausted/);
  assert.equal(f.state.signed, 1); assert.equal(f.state.sent, 1);
  await assert.rejects(f.run(), /budget_exhausted/);
  assert.equal(f.state.signed, 1); assert.equal(f.state.sent, 1);
});

test('the independent stage validator sees and refuses substituted executable steps', async () => {
  for (const change of [
    steps => { steps[0].data = '0xffff'; },
    steps => { steps[0].to = '0x' + '88'.repeat(20); },
    steps => { steps.reverse(); },
    steps => { steps[0].from = '0x' + '77'.repeat(20); },
  ]) {
    const f = fixture(); change(f.input.steps); await assert.rejects(f.run());
    assert.equal(f.state.loaded, 0); assert.equal(f.state.signed, 0); assert.equal(f.state.sent, 0);
    assert.equal(f.db.store.size, 0);
  }
});
