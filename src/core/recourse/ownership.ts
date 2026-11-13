import { getBytes, hexlify, randomBytes } from 'ethers';
import { readRecoursePoolChain } from './pool-chain';
import { parseMemberBindingChallenge, type MemberBindingConsent } from './member-binding';
import { standingMembershipSigningHash, membershipExitCommitment, type MembershipAuthorizationDomain, type StandingMembershipAuthorization } from './membership-authorization';
import { recoveryCommitment, recoverySigningRoot } from './hash-authorization';
import { humanRecoverySecret, humanRecoverySigningSeed, humanMembershipExitSecret } from './human-secret';
import SeedManager from '../wallet/SeedManager';
import { ActionWallet } from '../security/ActionWallet';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { currentProtocolDeployment, ownerChainNetwork } from '../protocol/runtime';
import { acceptedBindingDigest, waitForRecourseBinding } from './binding-chain';
import { addressRecoveryBinding } from './address-binding';

import { recourseBindingMessage as bindingMessage, type RecourseBinding as OwnershipBinding } from './binding';
export { recourseBindingMessage as bindingMessage, type RecourseBinding as OwnershipBinding } from './binding';
interface PreparedMemberBinding { readonly domain: MembershipAuthorizationDomain; readonly authorization: StandingMembershipAuthorization }
const memberChallenges = new WeakMap<OwnershipBinding, PreparedMemberBinding>();
export function humanBindingMemberChallenge(binding: OwnershipBinding): PreparedMemberBinding | undefined { return memberChallenges.get(binding); }
export interface RecourseBindingPort {
  request(path: 'binding-challenge' | 'bind', body: unknown): Promise<unknown>;
  userId: string;
}
export { humanRecoverySecret } from './human-secret';
/** Reuses the owner's existing biometric action; no second prompt or new backup secret. */
export async function prepareHumanOwnershipBinding(port: RecourseBindingPort, address: string,
  action: BiometricAction): Promise<OwnershipBinding> {
  assertBiometricAction(action);
  const mnemonic = await SeedManager.getMnemonic(action);
  if (!mnemonic) throw new Error('recourse_seed_unavailable');
  const deployment = await currentProtocolDeployment();
  const identity = addressRecoveryBinding({ chainId: '8453', pointer: deployment.pointer.toLowerCase(), origin: address.toLowerCase() });
  const secret = humanRecoverySecret(mnemonic, 0, identity);
  const seed = humanRecoverySigningSeed(mnemonic, 0, identity);
  let signingRoot: string, commitment: string;
  try { signingRoot = await recoverySigningRoot(seed); commitment = recoveryCommitment(secret, signingRoot); }
  finally { secret.fill(0); seed.fill(0); }
  const raw = await port.request('binding-challenge', { address: address.toLowerCase(), recoveryCommitment: commitment, signingRoot });
  if (!raw || typeof raw !== 'object' || !('binding' in raw) || !('message' in raw)
    || !raw.binding || typeof raw.binding !== 'object') throw new Error('recourse_challenge_invalid');
  const binding = raw.binding as OwnershipBinding;
  if (binding.identity !== identity || binding.address !== address.toLowerCase()
    || binding.kernel !== deployment.addresses.kernel.toLowerCase() || binding.recoveryCommitment !== commitment || binding.signingRoot !== signingRoot
    || binding.expiresAtMs < Date.now() || binding.expiresAtMs > Date.now() + 5 * 60_000
    || raw.message !== bindingMessage(binding)) throw new Error('recourse_challenge_invalid');
  if ('memberConsent' in raw && raw.memberConsent !== null && raw.memberConsent !== undefined) {
    const pool = await readRecoursePoolChain(identity, ownerChainNetwork());
    const challenge = parseMemberBindingChallenge(raw.memberConsent, binding, {
      domain: { chainId: '8453', pointer: deployment.pointer.toLowerCase(), kernel: binding.kernel, pool: pool.pool },
      revision: String(deployment.revision), nonce: pool.consentNonce, ruleHash: pool.signedRuleHash, timestamp: pool.timestamp, earningsBps: pool.earningsBps,
    });
    const exitSalt = hexlify(randomBytes(32));
    memberChallenges.set(binding, { domain: challenge.domain, authorization: { consent: challenge.consent, admissionMonth: pool.month, rejoinPayments:[],fixedChargePayer:false,
      burnLimit: "0", reserveLimit: "0", earningsBpsLimit: challenge.earningsBpsLimit, exitSalt,
      exitCommitment: membershipExitCommitment(humanMembershipExitSecret(mnemonic, challenge.domain, binding.identity, exitSalt)) } });
  }
  return binding;
}

export async function bindHumanOwnership(port: RecourseBindingPort, address: string, action: BiometricAction,
  externalSign?: (message: string | Uint8Array) => Promise<string>): Promise<void> {
  const binding = await prepareHumanOwnershipBinding(port, address, action);
  let signature: string;
  if (externalSign) signature = await externalSign(bindingMessage(binding));
  else {
    const signer = new ActionWallet(await SeedManager.getEVMPrivateKey(action), action);
    if (signer.address.toLowerCase() !== binding.address) throw new Error('recourse_address_mismatch');
    signature = await signer.signMessage(bindingMessage(binding));
  }
  const challenge = humanBindingMemberChallenge(binding);
  let memberConsent: MemberBindingConsent | undefined;
  if (challenge) {
    const bytes = getBytes(standingMembershipSigningHash(challenge.domain, challenge.authorization));
    const ownerSignature = externalSign ? await externalSign(bytes)
      : await new ActionWallet(await SeedManager.getEVMPrivateKey(action), action).signMessage(bytes);
    memberConsent = { authorization: challenge.authorization, ownerSignature };
  }
  const reply = await port.request('bind', { binding, signature, ...(memberConsent ? { memberConsent } : {}) });
  await waitForRecourseBinding(binding, ownerChainNetwork(), undefined, acceptedBindingDigest(reply, binding));
}

export { acceptedBindingDigest } from './binding-chain';
