import { humanMembershipExitSecret } from './human-secret';
import { hashMessage } from 'ethers';
import RelayAPIService from '../../services/RelayAPIService';
import SeedManager from '../wallet/SeedManager';
import { ActionWallet } from '../security/ActionWallet';
import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { ownerChainNetwork } from '../protocol/runtime';
import { useWalletStore } from '../../store/walletStore';
import { translate } from '../../i18n/translate';
import { signHumanHashDigest } from './human-hash-message';
import { discoverBoundHumanHashAccount, discoverBoundHumanDepartureAccount } from './human-bound-hash-account';
import { humanBreakKey } from './human-secret';
import { signHashAccountMessage, signHashAccountDeparture } from './hash-account';
import { readHashAccountDepartureRoot } from './hash-account-chain';
import { recoverySigningRoot } from './hash-authorization';
import { beginMembershipTransition, readMembershipTransition, submitMembershipConsent, retainMembershipDeparture,
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
export async function signHumanMembershipBytes(account: string, bytes: Uint8Array, action: BiometricAction, binding?: string): Promise<string> {
  const mnemonic = await SeedManager.getMnemonic(action);
  if (!mnemonic) throw Error('recourse_seed_unavailable');
  if (useWalletStore.getState().address?.toLowerCase() !== account) {
    if (!binding) throw Error('recourse_membership_wrong_wallet');
    const network = ownerChainNetwork(), current = await discoverBoundHumanHashAccount(mnemonic,binding,network);
    if (current.evm !== account) throw Error('recourse_membership_wrong_wallet');
    const seed = humanBreakKey(mnemonic,current.hashAccount,'spending',current.hashAccount.nonce);
    try {
      assertBiometricAction(action);
      const signature = await signHashAccountMessage(account,hashMessage(bytes),seed);
      const latest = await discoverBoundHumanHashAccount(mnemonic,binding,network);
      if (latest.evm !== current.evm || latest.manifestHash !== current.manifestHash
        || latest.hashAccount.nonce !== current.hashAccount.nonce || latest.recoveryCommitment !== current.recoveryCommitment) throw Error('recourse_membership_changed');
      assertBiometricAction(action); return signature;
    } finally { seed.fill(0); }
  }
  const signature = await signHumanHashDigest(mnemonic, account, hashMessage(bytes), action);
  if (signature !== null) return signature;
  const signer = new ActionWallet(await SeedManager.getEVMPrivateKey(action), action);
  if (signer.address.toLowerCase() !== account) throw Error('recourse_membership_wrong_wallet');
  return signer.signMessage(bytes);
}
export async function signHumanMembershipDeparture(account:string,binding:string,bytes:Uint8Array,action:BiometricAction):Promise<string>{
  const network=ownerChainNetwork(),deployment=await network.deployment();
  const codes=await Promise.all(network.rpcs.map(rpc=>rpc.request('eth_getCode',[account,{blockHash:deployment.blockHash,requireCanonical:true}])));
  if(typeof codes[0]!=='string'||codes[0]!==codes[1])throw Error('recourse_membership_changed');
  if(codes[0]==='0x')return signHumanMembershipBytes(account,bytes,action,binding);
  const mnemonic=await SeedManager.getMnemonic(action);if(!mnemonic)throw Error('recourse_seed_unavailable');
  const current=await discoverBoundHumanDepartureAccount(mnemonic,binding,network);
  if(current.evm!==account)throw Error('recourse_membership_wrong_wallet');
  const seed=humanBreakKey(mnemonic,current.hashAccount,'spending','0');
  try{
    const initial=await readHashAccountDepartureRoot(account,network);
    if(await recoverySigningRoot(seed)!==initial.root||initial.manifestHash!==current.manifestHash)throw Error('recourse_membership_changed');
    assertBiometricAction(action);const signature=await signHashAccountDeparture(account,hashMessage(bytes),seed);
    const latest=await discoverBoundHumanDepartureAccount(mnemonic,binding,network),after=await readHashAccountDepartureRoot(account,network);
    if(latest.evm!==current.evm||latest.manifestHash!==current.manifestHash||latest.recoveryGeneration!==current.recoveryGeneration
      ||latest.recoveryCommitment!==current.recoveryCommitment||after.root!==initial.root||after.manifestHash!==initial.manifestHash)throw Error('recourse_membership_changed');
    assertBiometricAction(action);return signature;
  }finally{seed.fill(0);}
}
export function authorizeHumanMembershipConsent(transition: Pick<MembershipTransitionView, 'id' | 'kind'>, challenge: MembershipConsentChallenge) {
  return withBiometricAction(translate('recourse.authorize', 'Authorize your Recourse action'), action =>
    submitMembershipConsent(humanMembershipRelay(action), ownerChainNetwork(), { transitionId: transition.id, kind: transition.kind,
      account: challenge.consent.account, challenge, signBytes: bytes => transition.kind==='leave'
        ? signHumanMembershipDeparture(challenge.consent.account,challenge.consent.binding,bytes,action)
        : signHumanMembershipBytes(challenge.consent.account, bytes, action, challenge.consent.binding),
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
    await retainMembershipDeparture(humanMembershipRelay(action),ownerChainNetwork(),{transitionId:view.id,
      signBytes:(account,binding,bytes)=>signHumanMembershipDeparture(account,binding,bytes,action),
      exitSecret:async(challenge,salt)=>humanMembershipExitSecret(mnemonic,challenge.domain,challenge.consent.binding,salt)});
  });
}
