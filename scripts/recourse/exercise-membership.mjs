import { Contract, getBytes, hashMessage, recoverAddress, verifyMessage, sha256, toUtf8Bytes } from 'ethers';
import { parseMembershipAuthorizationDomain, parseStandingMembershipAuthorization,
  standingMembershipSigningHash, standingMembershipDebitSigningHash, STANDING_MEMBERSHIP_ABI } from '../../provian-agent-sdk/dist/recourse-membership-authorization.js';
const ensure = (value, reason) => { if (!value) throw Error('exercise_membership_' + reason); };
const amount = (100n * 10n ** 18n).toString();

/** Public test challenges use the real protocol's signing format with a
 * distinct chain domain. These fixed exercise commands can never authorize a
 * debit on Base. No private key or recovery seed enters a challenge. */
export function exerciseMembershipChallenge(domain, method, authorization) {
  domain = parseMembershipAuthorizationDomain(domain);
  ensure(domain.chainId === '31337', 'wrong_chain');
  ensure(['setStandingConsent'].includes(method), 'method_invalid');
  authorization = parseStandingMembershipAuthorization(authorization);
  const consent = authorization.consent;
  ensure(consent.revision === '1' && consent.joined, 'revision_invalid');
  ensure(authorization.fixedChargePayer && authorization.burnLimit === amount
    && authorization.reserveLimit === amount && authorization.earningsBpsLimit === 100
    && authorization.rejoinPayments.length === 0, 'fixture_amount_changed');
  const messageHex = standingMembershipSigningHash(domain, authorization);
  return { schema: 'provian.isolated-membership-challenge.v1', domain, method, authorization, messageHex,
    account: consent.account,
    summary: 'Join on chain 31337: approve a 100 copied PVT monthly burn and a contribution of 1% of earnings, or 100 copied PVT without earnings. No Base balance changes.' };
}
export function verifyExerciseMembershipChallenge(challenge) {
  challenge = structuredClone(challenge);
  const rebuilt = exerciseMembershipChallenge(challenge?.domain, challenge?.method, challenge?.authorization);
  ensure(JSON.stringify(challenge) === JSON.stringify(rebuilt), 'challenge_changed');
  return rebuilt;
}
export function verifyExerciseMembershipSignature(challenge, signature) {
  const checked = verifyExerciseMembershipChallenge(challenge);
  ensure(verifyMessage(getBytes(checked.messageHex), signature).toLowerCase() === checked.account, 'wrong_wallet');
  return signature;
}
export function verifyExerciseMembershipSubmission(input, domain, attestor) {
  input = structuredClone(input);
  const challenge = verifyExerciseMembershipChallenge(input.challenge);
  domain = parseMembershipAuthorizationDomain(domain);
  ensure(JSON.stringify(challenge.domain) === JSON.stringify(domain), 'domain_changed');
  verifyExerciseMembershipSignature(challenge, input.ownerSignature);
  ensure(recoverAddress(hashMessage(getBytes(challenge.messageHex)), input.attestorSignature).toLowerCase() === attestor.toLowerCase(), 'attestor_changed');
  return { challenge, ownerSignature: input.ownerSignature, attestorSignature: input.attestorSignature };
}
export async function prepareExerciseMembership({ manifest, provider, registry, pool, account, kind, attestor }) {
  account = account.toLowerCase();
  ensure(manifest.chainId === 31337 && ['join', 'burn', 'reserve'].includes(kind), 'request_invalid');
  const head = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const binding = await registry.addressBinding(account), state = await pool.addressConsent(binding);
  ensure(await registry.ownerOf(account) === binding, 'binding_required');
  const currentMonth = await pool.calendarMonth(BigInt(head.timestamp)), month = kind === 'reserve' ? currentMonth - 1n : currentMonth;
  const rule = await pool.monthlyRule(month), expiresAt = (BigInt(head.timestamp) + 240n).toString();
  const domain = { chainId: '31337', pointer: manifest.addresses.ProvianProtocolPointer.toLowerCase(),
    kernel: manifest.addresses.ProvianRecourseKernel.toLowerCase(), pool: manifest.addresses.ProvianMemberRecoursePool.toLowerCase() };
  const standing = new Contract(await pool.standingMembership(), STANDING_MEMBERSHIP_ABI, provider);
  ensure(kind === 'join' ? !state.joined : state.joined, 'consent_changed');
  const consent = { binding, account, nonce: state.nonce.toString(), joined: true,
    revision: '1', ruleHash: rule.signedRuleHash, expiresAt };
  if (kind === 'join') {
    const salt = sha256(toUtf8Bytes(`EXERCISE ONLY: exit salt ${manifest.instanceId} ${account} ${state.nonce}`));
    const authorization = { consent, fixedChargePayer: true, burnLimit: rule.participationBurn.toString(),
      reserveLimit: rule.noEarningsContribution.toString(), earningsBpsLimit: Number(rule.earningsBps),
      exitCommitment: sha256(toUtf8Bytes(`EXERCISE ONLY: exit ${salt}`)), exitSalt: salt,
      admissionMonth: month.toString(), rejoinPayments: [] };
    const challenge = exerciseMembershipChallenge(domain, 'setStandingConsent', authorization);
    const digest = await standing.standingConsentDigest(authorization);
    ensure(digest === hashMessage(getBytes(challenge.messageHex)), 'digest_changed');
    return { challenge, attestorSignature: attestor.signingKey.sign(digest).serialized };
  }
  const authorization = { binding, payer: account, month: month.toString(),
    burn: kind === 'burn' ? rule.participationBurn.toString() : '0',
    reserve: kind === 'reserve' ? rule.noEarningsContribution.toString() : '0',
    nonce: (await pool.debitNonce(binding)).toString(), generation: state.generation.toString(),
    revision: '1', ruleHash: rule.signedRuleHash, expiresAt };
  const digest = await standing.debitDigest(authorization);
  ensure(digest === hashMessage(getBytes(standingMembershipDebitSigningHash(domain, authorization))), 'digest_changed');
  return { method: 'executeStandingDebit', authorization, attestorSignature: attestor.signingKey.sign(digest).serialized };
}
