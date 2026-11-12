import { readOwnerChainState } from './owner-chain';
import { formatUnits } from 'ethers';
import RelayAPIService from '../../services/RelayAPIService';
import { currentProtocolDeployment, ownerChainNetwork } from '../protocol/runtime';
import { waitForRecourseBinding } from './binding-chain';
import { withBiometricAction } from '../security/biometricAction';
import { translate } from '../../i18n/translate';
import { bindingMessage, humanBindingMemberChallenge, prepareHumanOwnershipBinding, type OwnershipBinding } from './ownership';
import { standingMembershipSigningHash } from './membership-authorization';
import type { ExternalWalletProofApi } from '../../screens/Agent/LinkExternalWalletScreen';
import { recoverHumanAccount } from './human-recovery';
import { readRecoursePoolChain } from './pool-chain';
import { readAddressRecoveryBinding } from './binding-chain';
import { useWalletStore } from '../../store/walletStore';
import SeedManager from '../wallet/SeedManager';
import { readBreakRecoveryContext } from './break-recovery';
import { recoverHumanAuxiliaryBreak } from './human-break-recovery';
import { readContinuedRestorationStatus } from './restoration-ticket';

export interface RecourseView {
  primaryIdentity: string | null;
  identity: string; historyState: 'pending' | 'available' | 'unavailable'; membershipState: 'available' | 'unavailable'; enrolled: boolean; grace: boolean; month: string; endMonthExclusive: string;
  participationBurnAtomic: string; noEarningsContributionAtomic: string; earningsBps: number;
  unpaidAtomic: string; reserveAtomic: string;
  addresses: { identity: string; address: string; openingBalanceAtomic: string; boundAtMs: number; confirmed: boolean }[];
  requests: { identity: string; requestId: string; status: string; transactionHash: string }[];
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

/** Recover only the selected auxiliary lineage. Membership is irrelevant to
 * restoring registered balances after a break; primary login stays untouched. */
export async function recoverHumanBoundAddress(identity: string): Promise<void> {
  text(identity, hash);
  await withBiometricAction(translate('recourse.recoverAddress', 'Recover this wallet'), async action => {
    const owner = object(await RelayAPIService.recourseRequest('ownership'));
    if (owner.identity === identity || !Array.isArray(owner.addresses)) throw Error('recourse_auxiliary_binding_invalid');
    const origins = owner.addresses.map(object).filter(row => row.identity === identity && row.recoveryGeneration === 0
      && row.chainBindingStatus === 'confirmed');
    if (origins.length !== 1) throw Error('recourse_auxiliary_binding_invalid');
    const originAddress = text(origins[0].address, address), network = ownerChainNetwork();
    let afterBreak = true;
    try { await readBreakRecoveryContext(network); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'break_recovery_unavailable') throw error;
      afterBreak = false;
    }
    const current = afterBreak ? await readOwnerChainState(identity, network) : null;
    const cutComplete = current && current.nonce > 0 && owner.addresses.map(object).some(row => row.identity === identity
      && row.address === current.destination && row.chainBindingStatus === 'confirmed');
    if (afterBreak && !cutComplete) {
      const mnemonic = await SeedManager.getMnemonic(action);
      if (!mnemonic) throw Error('recourse_seed_unavailable');
      await recoverHumanAuxiliaryBreak(mnemonic, action, { identity, originAddress }, { network });
    } else await recoverHumanAccount(action, { auxiliaryBinding: identity, newRecovery: true });
  });
}

export async function submitHumanRestorationRequest(transactionHash: string, block: number, binding?: string): Promise<void> {
  text(transactionHash, hash);
  if (binding !== undefined) text(binding, hash);
  if (!Number.isSafeInteger(block) || block < 1) throw new Error('recourse_loss_block_invalid');
  await withBiometricAction(translate('recourse.restoreAuthorize', 'Authorize your restoration request'), async action => {
    let primary: string | null;
    if (binding !== undefined) {
      const owner = object(await RelayAPIService.recourseRequest('ownership'));
      primary = owner.identity === null ? null : text(owner.identity, hash);
      if (!Array.isArray(owner.addresses) || !owner.addresses.some(value => object(value).identity === binding
        && object(value).chainBindingStatus === 'confirmed')) throw Error('recourse_binding_required');
    } else {
      const account = useWalletStore.getState().address;
      if (!account) throw Error('recourse_address_unavailable');
      primary = await readAddressRecoveryBinding(account.toLowerCase(), ownerChainNetwork());
    }
    const auxiliaryBinding = binding !== undefined && binding !== primary ? binding : undefined;
    const recovered = await recoverHumanAccount(action, { lossTransaction: transactionHash, lossBlock: block, auxiliaryBinding });
    if (auxiliaryBinding === undefined) useWalletStore.getState().setAddress(recovered.destination);
    const identity = binding ?? primary;
    if (!identity || !recovered.restoration) throw Error('recourse_restoration_scope_missing');
    const status = await readContinuedRestorationStatus(identity, recovered.destination, recovered.restoration, ownerChainNetwork());
    // This is an observation of the current chain, not a durable completion
    // flag. A later retry rechecks it, including after a reorganization.
    if (status === 'executed') return;
    if (status !== 'pending') throw Error('recourse_restoration_ticket_changed');
    const response = object(await RelayAPIService.recourseRequest('restoration-requests', { transactionHash, block,
      recoveryRequestId: recovered.requestId, restorationRequestId: recovered.restoration.request, identity }, action));
    if (response.requestId !== recovered.restoration.request || typeof response.status !== 'string'
      || !/^[a-z_]+$/.test(response.status)) throw Error('recourse_restoration_reply_invalid');
  });
}

export async function readRecourseView(): Promise<RecourseView> {
  const userId = await RelayAPIService.getUserId();
  if (!userId) throw new Error('recourse_identity_unavailable');
  const account = useWalletStore.getState().address;
  if (!account) throw Error('recourse_address_unavailable');
  let identity: string;
  let primaryIdentity: string | null = null;
  try { identity = await readAddressRecoveryBinding(account.toLowerCase(), ownerChainNetwork()); primaryIdentity = identity; }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'recourse_binding_required') throw error;
    // Public reserves and request-ID exits require no primary registration.
    identity = `0x${'00'.repeat(32)}`;
    try {
      const owner = object(await RelayAPIService.recourseRequest('ownership'));
      if (owner.identity !== null || !Array.isArray(owner.addresses)) throw Error('recourse_reply_invalid');
      const bindings = owner.addresses.map(object).filter(row => row.chainBindingStatus === 'confirmed')
        .map(row => text(row.identity, hash)).sort();
      if (bindings.length) identity = bindings[0];
    } catch { /* A public reserve view still works during a private-history outage. */ }
  }
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
  return { identity, primaryIdentity, historyState: 'pending', membershipState: membership ? 'available' : 'unavailable',
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
    if (!Array.isArray(owner.addresses) || !Array.isArray(requests)
      || (owner.identity !== view.identity && (owner.identity !== null
        || (!/^0x0+$/.test(view.identity) && !owner.addresses.some(value => object(value).identity === view.identity))))) throw new Error('recourse_reply_invalid');
    return { ...view, historyState: 'available', addresses: owner.addresses.map(value => {
      const row = object(value);
      if (typeof row.boundAtMs !== 'number' || !Number.isSafeInteger(row.boundAtMs)) throw new Error('recourse_reply_invalid');
      return { identity: text(row.identity, hash), address: text(row.address, address), openingBalanceAtomic: text(row.openingBalanceAtomic, atomic), boundAtMs: row.boundAtMs,
        confirmed: row.chainBindingStatus === 'confirmed' };
    }), requests: requests.map(value => { const row = object(value); return { identity: text(row.identity, hash), requestId: text(row.requestId, hash),
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
            ...(member ? { memberConsentMessageHex: standingMembershipSigningHash(member.domain, member.authorization) } : {}) } };
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
          ...(member ? { memberConsent: { authorization: member.authorization, ownerSignature: input.memberSignature } } : {}) });
        await waitForRecourseBinding(binding, ownerChainNetwork());
        pending.delete(input.challengeId);
        return { ok: true, provenAddress: binding.address };
      } catch { return { ok: false, error: 'verification_failed' }; }
    },
  };
}
