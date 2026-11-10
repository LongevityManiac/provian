import { test } from 'vitest';
import assert from 'node:assert/strict';
import { exerciseRead, exerciseReceipt } from './exercise-read.mjs';

test('rate-limited reads retry without changing the operation or its result', async () => {
  let calls = 0; const waits = [];
  const result = await exerciseRead(async () => {
    if (++calls < 3) throw { info: { error: { message: 'HTTP error 429 rate limit' } } };
    return '0x1234';
  }, { wait: async ms => { waits.push(ms); } });
  assert.equal(result, '0x1234'); assert.equal(calls, 3);
  assert.deepEqual(waits, [60_000, 60_000]);
});
test('reverts and malformed calls are never retried', async () => {
  const failure = Error('execution reverted'); let calls = 0;
  await assert.rejects(exerciseRead(async () => { ++calls; throw failure; }), error => error === failure);
  assert.equal(calls, 1);
});
test('persistent rate limits exhaust a finite retry budget', async () => {
  const failure = Error('rate limit'); let calls = 0;
  await assert.rejects(exerciseRead(async () => { ++calls; throw failure; }, { wait: async () => {} }),
    error => error === failure);
  assert.equal(calls, 6);
});
test('receipt polling survives a mining race without ever submitting another transaction', async () => {
  const calls = [], hash = `0x${'11'.repeat(32)}`, expected = { transactionHash: hash, status: '0x1' };
  const provider = { async send(method, params) {
    calls.push([method, params]);
    if (calls.length === 1) throw Error('upstream archive refusal');
    return calls.length === 2 ? null : expected;
  } };
  assert.equal(await exerciseReceipt(provider, hash, { wait: async () => {} }), expected);
  assert.deepEqual(calls, Array(3).fill(['eth_getTransactionReceipt', [hash]]));
  await assert.rejects(exerciseReceipt({ send: async () => null }, hash, { wait: async () => {}, attempts: 2 }), /unavailable/);
});
