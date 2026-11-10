import { describe, it, expect } from 'vitest';
import { getBytes } from 'ethers';
import { HASH_ACCOUNT_ABI, hashAccountIntentDigest, prepareHashAccountOperation, hashAccountCall, hashAccountOutcome } from './hash-account';
const seed = new Uint8Array(32).fill(11), nextSeed = new Uint8Array(32).fill(12);
const intent = { chainId: '8453', account: `0x${'11'.repeat(20)}`, nonce: '2', target: `0x${'22'.repeat(20)}`,
  value: '0', callGas: '2000000', data: '0x1234' };
describe('hash account exact execution', () => {
  it('persists successor before returning a real independent SLH signature; every intent field is bound', async () => {
    let saved = false;
    const operation = await prepareHashAccountOperation({ intent, signingSeed: seed, nextSigningSeed: nextSeed,
      async persistBeforeSigning(record, material) { expect(record.target).toBe(intent.target); expect(material).toEqual(nextSeed); saved = true; } });
    expect(saved).toBe(true);
    const { slh_dsa_sha2_128s: slh } = await import('@noble/post-quantum/slh-dsa.js');
    const verify = (record: typeof operation) => slh.verify(getBytes(operation.signature), getBytes(hashAccountIntentDigest(record)), getBytes(operation.publicKey));
    expect(verify(operation)).toBe(true);
    for (const delta of [{ account: intent.target }, { nonce: '3' }, { target: intent.account }, { value: '1' },
      { callGas: '2000001' }, { data: '0x1235' }, { nextCommitment: `0x${'33'.repeat(32)}` }]) expect(verify({ ...operation, ...delta })).toBe(false);
    expect(HASH_ACCOUNT_ABI.decodeFunctionData('execute', hashAccountCall(operation))[3]).toBe(intent.data);
    for (const success of [true, false]) {
      const log = { address: intent.account, ...HASH_ACCOUNT_ABI.encodeEventLog(HASH_ACCOUNT_ABI.getEvent('Executed')!, [2, intent.target, success]) };
      expect(hashAccountOutcome(operation, [log])).toBe(success ? 'succeeded' : 'target_failed');
      expect(() => hashAccountOutcome(operation, [])).toThrow('execution_missing');
      expect(() => hashAccountOutcome(operation, [log, log])).toThrow('execution_missing');
      expect(() => hashAccountOutcome(operation, [{ ...log, address: intent.target }])).toThrow('execution_missing');
    }
  });
  it('refuses signing without durable successor storage and refuses reused keys', async () => {
    await expect(prepareHashAccountOperation({ intent, signingSeed: seed, nextSigningSeed: nextSeed,
      async persistBeforeSigning() { throw Error('disk unavailable'); } })).rejects.toThrow('disk unavailable');
    await expect(prepareHashAccountOperation({ intent, signingSeed: seed, nextSigningSeed: seed,
      async persistBeforeSigning() { throw Error('must not reach'); } })).rejects.toThrow('reused_key');
  });
});
