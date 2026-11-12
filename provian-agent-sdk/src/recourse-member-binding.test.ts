import { describe, expect, it } from 'vitest';
import { getBytes, hashMessage, verifyMessage, Wallet } from 'ethers';
import { memberBindingDigest, memberBindingSigningHash, parseMemberBindingChallenge } from './recourse-member-binding';
import { recourseBindingMessage } from './recourse-binding';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`, a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const domain = { chainId: '8453', pointer: a(1), kernel: a(2), pool: a(3) };
const binding = { identity: h(4), address: a(5), recoveryCommitment: h(6), signingRoot: h(7), kernel: a(2), nonce: h(8), expiresAtMs: 1300000 };
const consent = { binding: h(4), account: a(5), nonce: '0', joined: true, revision: '1', ruleHash: h(9), expiresAt: '1300' };
const expected = { domain, revision: '1', nonce: '0', ruleHash: h(9), timestamp: 1000, earningsBps:100 };
const authorization={consent,fixedChargePayer:false,burnLimit:'0',reserveLimit:'0',earningsBpsLimit:100,exitCommitment:h(12),exitSalt:h(13)};
describe('atomic additional member address binding', () => {
  it('has a separate attestation domain and cannot strip the membership mandate', async () => {
    const wallet = new Wallet(h(77)), bytes = getBytes(memberBindingSigningHash(domain, a(10), binding, authorization));
    const signature = await wallet.signMessage(bytes);
    expect(verifyMessage(bytes, signature)).toBe(wallet.address);
    expect(verifyMessage(recourseBindingMessage(binding), signature)).not.toBe(wallet.address);
    expect(memberBindingDigest(domain, a(10), binding, authorization)).not.toBe(hashMessage(recourseBindingMessage(binding)));
    for (const c of [{ ...consent, nonce: '1' }, { ...consent, revision: '2' }, { ...consent, ruleHash: h(11) }, { ...consent, expiresAt: '1299' }])
      expect(verifyMessage(getBytes(memberBindingSigningHash(domain, a(10), binding, {...authorization,consent:c})), signature)).not.toBe(wallet.address);
    expect(memberBindingDigest(domain, a(11), binding, authorization)).not.toBe(memberBindingDigest(domain, a(10), binding, authorization));
  });
  it('accepts only this address, current deployment, rule, nonce and bounded expiry', () => {
    expect(parseMemberBindingChallenge({ domain, consent, earningsBpsLimit:100 }, binding, expected)).toEqual({ domain, consent, earningsBpsLimit:100 });
    for (const patch of [{ binding: h(99) }, { account: a(99) }, { joined: false }, { revision: '2' }, { nonce: '1' },
      { ruleHash: h(99) }, { expiresAt: '999' }, { expiresAt: '1301' }, { privateOwner: h(99) }])
      expect(() => parseMemberBindingChallenge({ domain, earningsBpsLimit:100, consent: { ...consent, ...patch } }, binding, expected)).toThrow('invalid');
    for (const key of ['chainId', 'pointer', 'kernel', 'pool'] as const)
      expect(() => parseMemberBindingChallenge({ domain: { ...domain, [key]: key === 'chainId' ? '1' : a(99) }, consent,earningsBpsLimit:100 }, binding, expected)).toThrow('invalid');
    expect(() => parseMemberBindingChallenge({ domain, consent, siblings: [a(9)] }, binding, expected)).toThrow('invalid');
    expect(() => parseMemberBindingChallenge({ domain, consent, earningsBpsLimit:100 }, { ...binding, expiresAtMs: 1299000 }, expected)).toThrow('invalid');
  });
});
