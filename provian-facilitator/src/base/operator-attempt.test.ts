import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';
import { assertOperatorAttempt } from './chain.js';

const account = privateKeyToAccount(`0x${'13'.repeat(32)}`);
const to = `0x${'ab'.repeat(20)}` as const;
describe('operator recovery binding', () => {
  it('accepts the actual signed call and refuses changed hash, sender, chain, nonce and business call', async () => {
    const raw = await account.signTransaction({ type: 'eip1559', chainId: 8453, to, data: '0x1234', value: 1n,
      nonce: 7, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
    const attempt = { raw, hash: keccak256(raw), nonce: 7, ready: true, intent: `${to}:0x1234:1` };
    await expect(assertOperatorAttempt(attempt, account.address, 8453)).resolves.toBeUndefined();
    for (const changed of [{ ...attempt, hash: `0x${'00'.repeat(32)}` }, { ...attempt, nonce: 8 },
      { ...attempt, intent: `${to}:0x1234:2` }, { ...attempt, intent: `${to}:0x5678:1` }]) {
      await expect(assertOperatorAttempt(changed, account.address, 8453)).rejects.toThrow('nonce_attempt_binding_invalid');
    }
    await expect(assertOperatorAttempt(attempt, to, 8453)).rejects.toThrow('nonce_attempt_binding_invalid');
    await expect(assertOperatorAttempt(attempt, account.address, 1)).rejects.toThrow('nonce_attempt_binding_invalid');
  });
});
