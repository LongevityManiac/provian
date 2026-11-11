import { describe, expect, it } from 'vitest';
import { getBytes, verifyMessage, Wallet } from 'ethers';
import { addressMembershipDigest, exactMembershipDebitDigest, exactMembershipDebitSigningHash,
  parseAddressMembershipConsent, parseExactMembershipDebit, parseMembershipAuthorizationDomain } from './recourse-membership-authorization';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const domain = { chainId: '8453', pointer: a(1), kernel: a(2), pool: a(3) };
const consent = { binding: h(4), account: a(5), nonce: '0', joined: true, revision: '1', ruleHash: h(6), expiresAt: '1300' };
const debit = { binding: h(4), payer: a(5), month: '100', burn: '100', reserve: '100', nonce: '0',
  generation: '1', revision: '1', ruleHash: h(6), expiresAt: '1300' };
describe('independent address membership authorizations', () => {
  it('signs exact bytes with a separate domain from enrollment', async () => {
    const wallet = new Wallet(h(77)), signing = exactMembershipDebitSigningHash(domain, debit);
    const signature = await wallet.signMessage(getBytes(signing));
    expect(verifyMessage(getBytes(signing), signature)).toBe(wallet.address);
    expect(verifyMessage(getBytes(exactMembershipDebitSigningHash(domain, { ...debit, burn: '101' })), signature)).not.toBe(wallet.address);
    expect(exactMembershipDebitDigest(domain, debit)).not.toBe(addressMembershipDigest(domain, consent));
  });
  it('binds every contract, chain, payer, month, amount, nonce, generation, rule, revision and expiry', () => {
    const digest = exactMembershipDebitDigest(domain, debit);
    for (const key of ['pointer', 'kernel', 'pool'] as const) expect(exactMembershipDebitDigest({ ...domain, [key]: a(9) }, debit)).not.toBe(digest);
    expect(exactMembershipDebitDigest({ ...domain, chainId: '8454' }, debit)).not.toBe(digest);
    for (const key of ['month', 'burn', 'reserve', 'nonce', 'generation', 'revision', 'expiresAt'] as const)
      expect(exactMembershipDebitDigest(domain, { ...debit, [key]: String(BigInt(debit[key]) + 1n) })).not.toBe(digest);
    for (const patch of [{ binding: h(9) }, { ruleHash: h(9) }, { payer: a(9) }])
      expect(exactMembershipDebitDigest(domain, { ...debit, ...patch })).not.toBe(digest);
  });
  it('refuses extra private fields, noncanonical integers, zeros and malformed types', () => {
    for (const extra of [{ owner: 'private' }, { invoice: 'private' }, { siblings: [a(7)] }]) {
      expect(() => parseExactMembershipDebit({ ...debit, ...extra })).toThrow('invalid');
      expect(() => parseAddressMembershipConsent({ ...consent, ...extra })).toThrow('invalid');
    }
    for (const bad of ['-1', '01', '1e3', String(1n << 256n), 100, null])
      expect(() => parseExactMembershipDebit({ ...debit, burn: bad })).toThrow('invalid');
    expect(() => parseExactMembershipDebit({ ...debit, burn: '0', reserve: '0' })).toThrow('invalid');
    expect(() => parseExactMembershipDebit({ ...debit, generation: '0' })).toThrow('invalid');
    expect(() => parseAddressMembershipConsent({ ...consent, joined: 'true' })).toThrow('invalid');
    expect(() => parseMembershipAuthorizationDomain({ ...domain, pointer: a(0) })).toThrow('invalid');
  });
});
