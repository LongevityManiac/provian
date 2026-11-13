import { test, expect } from 'vitest';
import { Wallet, getBytes } from 'ethers';
import { exerciseMembershipChallenge, verifyExerciseMembershipChallenge, verifyExerciseMembershipSignature,
  verifyExerciseMembershipSubmission } from './exercise-membership.mjs';
const address = n => '0x' + n.toString(16).padStart(40, '0'), hash = n => '0x' + n.toString(16).padStart(64, '0');
const owner = new Wallet('0x' + '11'.repeat(32));
const domain = { chainId: '31337', pointer: address(1), kernel: address(2), pool: address(3) };
const consent = { binding: hash(1), account: owner.address.toLowerCase(), nonce: '0', joined: true,
  revision: '1', ruleHash: hash(2), expiresAt: '1900000000' };
const mandate = { consent, fixedChargePayer:true, burnLimit:'100000000000000000000', reserveLimit:'100000000000000000000',
  earningsBpsLimit:100, exitCommitment:hash(3),exitSalt:hash(4),admissionMonth:'20',rejoinPayments:[] };
test('real owner signature authenticates isolated standing consent', async () => {
  const method='setStandingConsent', authorization=mandate;
  const challenge = exerciseMembershipChallenge(domain, method, authorization), signature = await owner.signMessage(getBytes(challenge.messageHex));
  expect(verifyExerciseMembershipChallenge(challenge)).toEqual(challenge);
  expect(verifyExerciseMembershipSignature(challenge, signature)).toBe(signature);
  for (const modified of [{ ...challenge, messageHex: hash(9) }, { ...challenge, summary: 'misleading' },
    { ...challenge, domain: { ...domain, chainId: '8453' } }, { ...challenge, domain: { ...domain, pool: address(9) } }]) {
    expect(() => verifyExerciseMembershipSignature(modified, signature)).toThrow();
  }
});
test('live-chain, changed amount, arbitrary method and wrong-wallet signatures refuse', async () => {
  expect(() => exerciseMembershipChallenge({ ...domain, chainId: '8453' }, 'setStandingConsent', mandate)).toThrow('wrong_chain');
  for(const method of ['approve','setAddressConsent','executeMembershipDebit'])
    expect(() => exerciseMembershipChallenge(domain, method, consent)).toThrow('method_invalid');
  for(const changed of [{burnLimit:'1'},{reserveLimit:'1'},{earningsBpsLimit:101},{fixedChargePayer:false},
    {rejoinPayments:[{month:'19',burn:mandate.burnLimit,reserve:'0',ruleHash:hash(2)}]}])
    expect(() => exerciseMembershipChallenge(domain, 'setStandingConsent', { ...mandate, ...changed })).toThrow('fixture_amount_changed');
  const challenge = exerciseMembershipChallenge(domain, 'setStandingConsent', mandate);
  const wrong = await new Wallet('0x' + '22'.repeat(32)).signMessage(getBytes(challenge.messageHex));
  expect(() => verifyExerciseMembershipSignature(challenge, wrong)).toThrow('wrong_wallet');
});
test('agent-sponsored submission fixes the simulator contracts and both independent signatures', async () => {
  const challenge = exerciseMembershipChallenge(domain, 'setStandingConsent', mandate), attestor = new Wallet('0x' + '22'.repeat(32));
  const signed = { challenge, ownerSignature: await owner.signMessage(getBytes(challenge.messageHex)),
    attestorSignature: await attestor.signMessage(getBytes(challenge.messageHex)) };
  expect(verifyExerciseMembershipSubmission(signed, domain, attestor.address)).toEqual(signed);
  for (const field of ['pointer', 'kernel', 'pool']) expect(() => verifyExerciseMembershipSubmission(signed,
    { ...domain, [field]: address(9) }, attestor.address)).toThrow('domain_changed');
  expect(() => verifyExerciseMembershipSubmission({ ...signed, attestorSignature: signed.ownerSignature }, domain, attestor.address)).toThrow('attestor_changed');
  expect(() => verifyExerciseMembershipSubmission({ ...signed, ownerSignature: signed.attestorSignature }, domain, attestor.address)).toThrow('wrong_wallet');
});
