import { hashMessage } from 'ethers';
import RelayAPIService from '../../services/RelayAPIService';
import SeedManager from '../wallet/SeedManager';
import { ActionWallet } from '../security/ActionWallet';
import { withBiometricAction, type BiometricAction } from '../security/biometricAction';
import { ownerChainNetwork } from '../protocol/runtime';
import { useWalletStore } from '../../store/walletStore';
import { translate } from '../../i18n/translate';
import { signHumanHashDigest } from './human-hash-message';
import { beginMembershipTransition, readMembershipTransition, submitMembershipConsent,
  type MembershipRelay, type MembershipConsentChallenge, type MembershipTransitionView } from './membership-client';

export const humanMembershipRelay = (action?: BiometricAction): MembershipRelay => ({
  request: (path, body) => RelayAPIService.recourseRequest(path, body, action),
});
export function readHumanMembershipTransition(id?: string): Promise<MembershipTransitionView | null> {
  return readMembershipTransition(humanMembershipRelay(), id);
}
export function beginHumanMembership(kind: 'join' | 'leave'): Promise<MembershipTransitionView> {
  return beginMembershipTransition(humanMembershipRelay(), kind);
}
export async function signHumanMembershipBytes(account: string, bytes: Uint8Array, action: BiometricAction): Promise<string> {
  if (useWalletStore.getState().address?.toLowerCase() !== account) throw Error('recourse_membership_wrong_wallet');
  const mnemonic = await SeedManager.getMnemonic(action);
  if (!mnemonic) throw Error('recourse_seed_unavailable');
  const signature = await signHumanHashDigest(mnemonic, account, hashMessage(bytes), action);
  if (signature !== null) return signature;
  const signer = new ActionWallet(await SeedManager.getEVMPrivateKey(action), action);
  if (signer.address.toLowerCase() !== account) throw Error('recourse_membership_wrong_wallet');
  return signer.signMessage(bytes);
}
export function authorizeHumanMembershipConsent(transition: Pick<MembershipTransitionView, 'id' | 'kind'>, challenge: MembershipConsentChallenge) {
  return withBiometricAction(translate('recourse.authorize', 'Authorize your Recourse action'), action =>
    submitMembershipConsent(humanMembershipRelay(action), ownerChainNetwork(), { transitionId: transition.id, kind: transition.kind,
      account: challenge.consent.account, challenge, signBytes: bytes => signHumanMembershipBytes(challenge.consent.account, bytes, action) }));
}
/** Outside wallets sign for themselves. The parsed challenge is independently
 * checked before opening their signer and again before relay submission. */
export function authorizeExternalMembershipConsent(transition: Pick<MembershipTransitionView, 'id' | 'kind'>,
  challenge: MembershipConsentChallenge, signBytes: (bytes: Uint8Array) => Promise<string>) {
  return submitMembershipConsent(humanMembershipRelay(), ownerChainNetwork(), { transitionId: transition.id, kind: transition.kind,
    account: challenge.consent.account, challenge, signBytes });
}
