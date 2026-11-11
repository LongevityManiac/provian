import { test, expect } from 'vitest';
import { Wallet, getBytes } from 'ethers';
import { exerciseMembershipChallenge, verifyExerciseMembershipChallenge, verifyExerciseMembershipSignature,
  verifyExerciseMembershipSubmission } from './exercise-membership.mjs';
const address = n => '0x' + n.toString(16).padStart(40, '0'), hash = n => '0x' + n.toString(16).padStart(64, '0');
const owner = new Wallet('0x' + '11'.repeat(32));
const domain = { chainId: '31337', pointer: address(1), kernel: address(2), pool: address(3) };
const consent = { binding: hash(1), account: owner.address.toLowerCase(), nonce: '0', joined: true,
  revision: '1', ruleHash: hash(2), expiresAt: '1900000000' };
const debit = { binding: hash(1), payer: owner.address.toLowerCase(), month: '20', burn: (100n * 10n ** 18n).toString(), reserve: '0',
  nonce: '1', generation: '1', revision: '1', ruleHash: hash(2), expiresAt: '1900000000' };
test.each([['setAddressConsent', consent], ['executeMembershipDebit', debit],
  ['executeMembershipDebit', { ...debit, burn: '0', reserve: debit.burn }]])('real owner signature authenticates isolated %s', async (method, authorization) => {
  const challenge = exerciseMembershipChallenge(domain, method, authorization), signature = await owner.signMessage(getBytes(challenge.messageHex));
  expect(verifyExerciseMembershipChallenge(challenge)).toEqual(challenge);
  expect(verifyExerciseMembershipSignature(challenge, signature)).toBe(signature);
  for (const modified of [{ ...challenge, messageHex: hash(9) }, { ...challenge, summary: 'misleading' },
    { ...challenge, domain: { ...domain, chainId: '8453' } }, { ...challenge, domain: { ...domain, pool: address(9) } }]) {
    expect(() => verifyExerciseMembershipSignature(modified, signature)).toThrow();
  }
});
test('live-chain, changed amount, arbitrary method and wrong-wallet signatures refuse', async () => {
  expect(() => exerciseMembershipChallenge({ ...domain, chainId: '8453' }, 'setAddressConsent', consent)).toThrow('wrong_chain');
  expect(() => exerciseMembershipChallenge(domain, 'approve', consent)).toThrow('method_invalid');
  expect(() => exerciseMembershipChallenge(domain, 'executeMembershipDebit', { ...debit, burn: '1' })).toThrow('fixture_amount_changed');
  const challenge = exerciseMembershipChallenge(domain, 'setAddressConsent', consent);
  const wrong = await new Wallet('0x' + '22'.repeat(32)).signMessage(getBytes(challenge.messageHex));
  expect(() => verifyExerciseMembershipSignature(challenge, wrong)).toThrow('wrong_wallet');
});
test('agent-sponsored submission fixes the simulator contracts and both independent signatures', async () => {
  const challenge = exerciseMembershipChallenge(domain, 'setAddressConsent', consent), attestor = new Wallet('0x' + '22'.repeat(32));
  const signed = { challenge, ownerSignature: await owner.signMessage(getBytes(challenge.messageHex)),
    attestorSignature: await attestor.signMessage(getBytes(challenge.messageHex)) };
  expect(verifyExerciseMembershipSubmission(signed, domain, attestor.address)).toEqual(signed);
  for (const field of ['pointer', 'kernel', 'pool']) expect(() => verifyExerciseMembershipSubmission(signed,
    { ...domain, [field]: address(9) }, attestor.address)).toThrow('domain_changed');
  expect(() => verifyExerciseMembershipSubmission({ ...signed, attestorSignature: signed.ownerSignature }, domain, attestor.address)).toThrow('attestor_changed');
  expect(() => verifyExerciseMembershipSubmission({ ...signed, ownerSignature: signed.attestorSignature }, domain, attestor.address)).toThrow('wrong_wallet');
});
