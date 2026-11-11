import { formatUnits } from 'ethers';
import RelayAPIService from '../../services/RelayAPIService';
import { currentProtocolDeployment, ownerChainNetwork } from '../protocol/runtime';
import { waitForRecourseBinding } from './binding-chain';
import { withBiometricAction } from '../security/biometricAction';
import { translate } from '../../i18n/translate';
import { bindingMessage, humanBindingMemberChallenge, prepareHumanOwnershipBinding, type OwnershipBinding } from './ownership';
import { addressMembershipSigningHash } from './membership-authorization';
import type { ExternalWalletProofApi } from '../../screens/Agent/LinkExternalWalletScreen';
import { recoverHumanAccount } from './human-recovery';
import { readRecoursePoolChain } from './pool-chain';
import { readAddressRecoveryBinding } from './binding-chain';
import { useWalletStore } from '../../store/walletStore';

export interface RecourseView {
  identity: string; historyState: 'pending' | 'available' | 'unavailable'; membershipState: 'available' | 'unavailable'; enrolled: boolean; grace: boolean; month: string; endMonthExclusive: string;
  participationBurnAtomic: string; noEarningsContributionAtomic: string; earningsBps: number;
  unpaidAtomic: string; reserveAtomic: string;
  addresses: { address: string; openingBalanceAtomic: string; boundAtMs: number; confirmed: boolean }[];
  requests: { requestId: string; status: string; transactionHash: string }[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_reply_invalid');
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('recourse_reply_invalid');
  return value;
}
const atomic = /^(0|[1-9][0-9]*)$/, address = /^0x[0-9a-f]{40}$/, hash = /^0x[0-9a-f]{64}$/;
export function pvtAmount(value: string): string { return formatUnits(value, 18); }

export async function submitHumanRestorationRequest(transactionHash: string, block: number): Promise<void> {
  text(transactionHash, hash);
  if (!Number.isSafeInteger(block) || block < 1) throw new Error('recourse_loss_block_invalid');
  await withBiometricAction(translate('recourse.restoreAuthorize', 'Authorize your restoration request'), async action => {
    const recovered = await recoverHumanAccount(action, { lossTransaction: transactionHash, lossBlock: block });
    useWalletStore.getState().setAddress(recovered.destination);
    await RelayAPIService.recourseRequest('restoration-requests', { transactionHash, block,
      recoveryRequestId: recovered.requestId }, action);
  });
}

export async function readRecourseView(): Promise<RecourseView> {
  const userId = await RelayAPIService.getUserId();
  if (!userId) throw new Error('recourse_identity_unavailable');
  const account = useWalletStore.getState().address;
  if (!account) throw Error('recourse_address_unavailable');
  const identity = await readAddressRecoveryBinding(account.toLowerCase(), ownerChainNetwork());
  const pool = await readRecoursePoolChain(identity, ownerChainNetwork());
  let membership: { enrolled: boolean; grace: boolean; month: string; endMonthExclusive: string; unpaidAtomic: string } | null = null;
  try {
    const reply = object(await RelayAPIService.recourseRequest('pool'));
    if (reply.identity !== identity || reply.pool !== pool.pool || reply.kernel !== pool.kernel) throw Error('recourse_reply_invalid');
    const privateView = object(reply.membership);
    if (typeof privateView.enrolled !== 'boolean' || typeof privateView.grace !== 'boolean') throw Error('recourse_reply_invalid');
    membership = { enrolled: privateView.enrolled, grace: privateView.grace, month: text(privateView.month, atomic),
      endMonthExclusive: text(privateView.endMonthExclusive, atomic), unpaidAtomic: text(privateView.unpaidAtomic, atomic) };
  } catch { /* The public reserve and direct allocated exit remain usable. */ }
  return { identity, historyState: 'pending', membershipState: membership ? 'available' : 'unavailable',
    enrolled: membership?.enrolled ?? false, grace: membership?.grace ?? false, earningsBps: pool.earningsBps,
    month: membership?.month ?? pool.month, endMonthExclusive: membership?.endMonthExclusive ?? '0',
    participationBurnAtomic: pool.participationBurnAtomic, noEarningsContributionAtomic: pool.noEarningsContributionAtomic,
    unpaidAtomic: membership?.unpaidAtomic ?? '0', reserveAtomic: pool.reserveAtomic, addresses: [], requests: [] };
}
/** Address/request history is separate from private membership reconciliation. */
export async function readRecourseHistory(view: RecourseView): Promise<RecourseView> {
  try {
    const [rawOwner, rawRequests] = await Promise.all([
      RelayAPIService.recourseRequest('ownership'), RelayAPIService.recourseRequest('restoration-requests'),
    ]);
    const owner = object(rawOwner), requests = object(rawRequests).requests;
    if (owner.identity !== view.identity || !Array.isArray(owner.addresses) || !Array.isArray(requests)) throw new Error('recourse_reply_invalid');
    return { ...view, historyState: 'available', addresses: owner.addresses.map(value => {
      const row = object(value);
      if (typeof row.boundAtMs !== 'number' || !Number.isSafeInteger(row.boundAtMs)) throw new Error('recourse_reply_invalid');
      return { address: text(row.address, address), openingBalanceAtomic: text(row.openingBalanceAtomic, atomic), boundAtMs: row.boundAtMs,
        confirmed: row.chainBindingStatus === 'confirmed' };
    }), requests: requests.map(value => { const row = object(value); return { requestId: text(row.requestId, hash),
      transactionHash: text(row.transactionHash, hash), status: text(row.status, /^[a-z_]+$/) }; }) };
  } catch { return { ...view, historyState: 'unavailable' }; }
}
export { withdrawHumanRestoration } from './human-restoration-exit';

/** Uses the existing WalletConnect and pasted-signature flow. Only public
 * challenge material survives while the owner signs in the outside wallet. */
export function recourseExternalProofApi(): ExternalWalletProofApi {
  const pending = new Map<string, OwnershipBinding>();
  return {
    async list() {
      const raw = object(await RelayAPIService.recourseRequest('ownership'));
      if (!Array.isArray(raw.addresses)) throw new Error('recourse_reply_invalid');
      return raw.addresses.filter(value => object(value).chainBindingStatus === 'confirmed').map(value => { const row = object(value); return { address: text(row.address, address),
        provenAt: typeof row.boundAtMs === 'number' ? row.boundAtMs : 0 }; });
    },
    async challenge(value) {
      try {
        return await withBiometricAction(translate('recourse.bindAuthorize', 'Bind an address to your recovery commitment'), async action => {
          const userId = await RelayAPIService.getUserId();
          if (!userId) throw new Error('recourse_identity_unavailable');
          const binding = await prepareHumanOwnershipBinding({ userId,
            request: (path, body) => RelayAPIService.recourseRequest(path, body, action) }, value, action);
          pending.set(binding.nonce, binding);
          const member = humanBindingMemberChallenge(binding);
          return { ok: true as const, challenge: { challengeId: binding.nonce, address: binding.address,
            expiresAt: binding.expiresAtMs, message: bindingMessage(binding),
            ...(member ? { memberConsentMessageHex: addressMembershipSigningHash(member.domain, member.consent) } : {}) } };
        });
      } catch { return { ok: false, error: 'challenge_failed' }; }
    },
    async verify(input) {
      const binding = pending.get(input.challengeId);
      if (!binding || binding.address !== input.address.toLowerCase() || binding.expiresAtMs < Date.now()) return { ok: false, error: 'challenge_expired' };
      try {
        const deployment = await currentProtocolDeployment();
        if (binding.kernel !== deployment.addresses.kernel.toLowerCase()) throw new Error('protocol_pointer_changed');
        const member = humanBindingMemberChallenge(binding);
        if (Boolean(member) !== Boolean(input.memberSignature)) throw new Error('recourse_member_signature_required');
        await RelayAPIService.recourseRequest('bind', { binding, signature: input.signature,
          ...(member ? { memberConsent: { consent: member.consent, ownerSignature: input.memberSignature } } : {}) });
        await waitForRecourseBinding(binding, ownerChainNetwork());
        pending.delete(input.challengeId);
        return { ok: true, provenAddress: binding.address };
      } catch { return { ok: false, error: 'verification_failed' }; }
    },
  };
}
