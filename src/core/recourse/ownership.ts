import { recoveryCommitment, recoverySigningRoot } from './hash-authorization';
import { humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import SeedManager from '../wallet/SeedManager';
import { ActionWallet } from '../security/ActionWallet';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { currentProtocolDeployment, ownerChainNetwork } from '../protocol/runtime';
import { waitForRecourseBinding } from './binding-chain';

import { recourseBindingMessage as bindingMessage, type RecourseBinding as OwnershipBinding } from './binding';
export { recourseBindingMessage as bindingMessage, type RecourseBinding as OwnershipBinding } from './binding';
export interface RecourseBindingPort {
  request(path: 'binding-challenge' | 'bind', body: unknown): Promise<unknown>;
  userId: string;
}
export { humanRecoverySecret } from './human-secret';
export function humanOwnershipIdentity(userId: string): string {
  return `0x${bytesToHex(sha256(utf8ToBytes(JSON.stringify(['provian ownership', 'human', userId]))))}`;
}
/** Reuses the owner's existing biometric action; no second prompt or new backup secret. */
export async function prepareHumanOwnershipBinding(port: RecourseBindingPort, address: string,
  action: BiometricAction): Promise<OwnershipBinding> {
  assertBiometricAction(action);
  const mnemonic = await SeedManager.getMnemonic(action);
  if (!mnemonic) throw new Error('recourse_seed_unavailable');
  const generation = await SeedManager.getRecoveryGeneration();
  const secret = humanRecoverySecret(mnemonic, generation);
  const seed = humanRecoverySigningSeed(mnemonic, generation);
  let signingRoot: string, commitment: string;
  try { signingRoot = await recoverySigningRoot(seed); commitment = recoveryCommitment(secret, signingRoot); }
  finally { secret.fill(0); seed.fill(0); }
  const raw = await port.request('binding-challenge', { address: address.toLowerCase(), recoveryCommitment: commitment, signingRoot });
  if (!raw || typeof raw !== 'object' || !('binding' in raw) || !('message' in raw)
    || !raw.binding || typeof raw.binding !== 'object') throw new Error('recourse_challenge_invalid');
  const binding = raw.binding as OwnershipBinding;
  const deployment = await currentProtocolDeployment();
  if (binding.identity !== humanOwnershipIdentity(port.userId) || binding.address !== address.toLowerCase()
    || binding.kernel !== deployment.addresses.kernel.toLowerCase() || binding.recoveryCommitment !== commitment || binding.signingRoot !== signingRoot
    || binding.expiresAtMs < Date.now() || binding.expiresAtMs > Date.now() + 5 * 60_000
    || raw.message !== bindingMessage(binding)) throw new Error('recourse_challenge_invalid');
  return binding;
}

export async function bindHumanOwnership(port: RecourseBindingPort, address: string, action: BiometricAction,
  externalSign?: (message: string) => Promise<string>): Promise<void> {
  const binding = await prepareHumanOwnershipBinding(port, address, action);
  let signature: string;
  if (externalSign) signature = await externalSign(bindingMessage(binding));
  else {
    const signer = new ActionWallet(await SeedManager.getEVMPrivateKey(action), action);
    if (signer.address.toLowerCase() !== binding.address) throw new Error('recourse_address_mismatch');
    signature = await signer.signMessage(bindingMessage(binding));
  }
  await port.request('bind', { binding, signature });
  await waitForRecourseBinding(binding, ownerChainNetwork());
}
