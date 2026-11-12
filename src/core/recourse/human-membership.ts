import { humanMembershipExitSecret } from './human-secret';
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
export function beginHumanMembership(kind: 'join' | 'leave' | 'renew'): Promise<MembershipTransitionView> {
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
      account: challenge.consent.account, challenge, signBytes: bytes => signHumanMembershipBytes(challenge.consent.account, bytes, action),
      exitSecret: async salt => { const mnemonic=await SeedManager.getMnemonic(action); if(!mnemonic)throw Error('recourse_seed_unavailable');
        return humanMembershipExitSecret(mnemonic,challenge.domain,challenge.consent.binding,salt); } }));
}
/** Outside wallets sign for themselves. The parsed challenge is independently
 * checked before opening their signer and again before relay submission. */
export function authorizeExternalMembershipConsent(transition: Pick<MembershipTransitionView, 'id' | 'kind'>,
  challenge: MembershipConsentChallenge, signBytes: (bytes: Uint8Array) => Promise<string>) {
  return withBiometricAction(translate('recourse.authorize','Authorize your Recourse action'),action=>
    submitMembershipConsent(humanMembershipRelay(action), ownerChainNetwork(), { transitionId: transition.id, kind: transition.kind,
      account: challenge.consent.account, challenge, signBytes,
      exitSecret:async salt=>{ const mnemonic=await SeedManager.getMnemonic(action); if(!mnemonic)throw Error('recourse_seed_unavailable');
        return humanMembershipExitSecret(mnemonic,challenge.domain,challenge.consent.binding,salt); } }));
}

/** One local approval can revoke every independently committed address. The
 * relay sends separate sponsored transactions, without a portfolio payload. */
export function leaveHumanMembership(view:MembershipTransitionView){
  if(view.kind!=='leave')throw Error('recourse_membership_scope');
  return withBiometricAction(translate('recourse.leave','Leave Recourse Pool'),async action=>{
    const mnemonic=await SeedManager.getMnemonic(action);if(!mnemonic)throw Error('recourse_seed_unavailable');
    for(const challenge of view.challenges){
      if(challenge.consent.joined)throw Error('recourse_membership_scope');
      await submitMembershipConsent(humanMembershipRelay(action),ownerChainNetwork(),{transitionId:view.id,kind:'leave',
        account:challenge.consent.account,challenge,signBytes:async()=>{throw Error('recourse_exit_requires_no_wallet_signature');},
        exitSecret:async salt=>humanMembershipExitSecret(mnemonic,challenge.domain,challenge.consent.binding,salt)});
    }
  });
}
