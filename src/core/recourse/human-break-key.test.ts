import { expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { humanBreakKey, humanRecoverySecret, humanRecoverySigningSeed, type HumanBreakKeyContext } from './human-secret';
const phrase = 'test test test test test test test test test test test junk';
const context = { identity: `0x${'11'.repeat(32)}`, breakOrigin: `0x${'22'.repeat(20)}`, chainId: '8453' };
it('the unchanged seed backup reconstructs each break key with independent domains', () => {
  const key = (c = context, purpose: 'spending' | 'recovery-secret' | 'recovery-signing' = 'spending', generation = '0') =>
    bytesToHex(humanBreakKey(phrase, c, purpose, generation));
  expect(key()).toBe(key());
  const values = [key(), key(context, 'recovery-secret'), key(context, 'recovery-signing'), key(context, 'spending', '1'),
    key({ ...context, identity: `0x${'33'.repeat(32)}` }), key({ ...context, breakOrigin: `0x${'44'.repeat(20)}` }),
    key({ ...context, chainId: '1' }), bytesToHex(humanRecoverySecret(phrase)), bytesToHex(humanRecoverySigningSeed(phrase))];
  expect(new Set(values).size).toBe(values.length);
  const old = humanBreakKey(phrase, context, 'spending', '0'); old.fill(0);
  expect(key()).not.toBe(bytesToHex(old));
});
it('rejects ambiguous, zero and overflowing domains before deriving any key', () => {
  for (const bad of [{ identity: `0x${'00'.repeat(32)}` }, { breakOrigin: `0x${'00'.repeat(20)}` },
    { chainId: '08453' }, { chainId: (2n ** 256n).toString() }, { identity: '11' }]) {
    expect(() => humanBreakKey(phrase, { ...context, ...bad }, 'spending', '0')).toThrow('context_invalid');
  }
  for (const generation of ['-1', '01', '1.1', (2n ** 256n).toString()]) {
    expect(() => humanBreakKey(phrase, context, 'spending', generation)).toThrow('context_invalid');
  }
  expect(() => humanBreakKey(phrase, context as HumanBreakKeyContext, 'unknown' as 'spending', '0')).toThrow('context_invalid');
});
