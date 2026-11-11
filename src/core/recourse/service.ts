import { Contract, Interface, MaxUint256, formatUnits } from 'ethers';
import RelayAPIService from '../../services/RelayAPIService';
import { currentProtocolDeployment, ownerChainNetwork } from '../protocol/runtime';
import { waitForRecourseBinding } from './binding-chain';
import { ActionWallet } from '../security/ActionWallet';
import { withBiometricAction } from '../security/biometricAction';
import SeedManager from '../wallet/SeedManager';
import TransactionService from '../wallet/TransactionService';
import { translate } from '../../i18n/translate';
import { bindingMessage, prepareHumanOwnershipBinding, type OwnershipBinding } from './ownership';
import type { ExternalWalletProofApi } from '../../screens/Agent/LinkExternalWalletScreen';
import { recoverHumanAccount } from './human-recovery';
import { readRecoursePoolChain } from './pool-chain';
import { readAddressRecoveryBinding } from './binding-chain';
import { useWalletStore } from '../../store/walletStore';

export interface RecourseView {
  identity: string; historyState: 'pending' | 'available' | 'unavailable'; enrolled: boolean; grace: boolean; month: string; endMonthExclusive: string;
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
  return { identity, historyState: 'pending', enrolled: pool.enrolled, grace: pool.grace, earningsBps: pool.earningsBps,
    month: pool.month, endMonthExclusive: pool.endMonthExclusive,
    participationBurnAtomic: pool.participationBurnAtomic, noEarningsContributionAtomic: pool.noEarningsContributionAtomic,
    unpaidAtomic: pool.unpaidAtomic, reserveAtomic: pool.reserveAtomic, addresses: [], requests: [] };
}
/** History availability does not gate membership state, withdrawal or exit. */
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
const poolAbi = new Interface(['function primaryAddress(bytes32) view returns(address)', 'function enroll(bytes32)',
  'function leave(bytes32)', 'function settleMonth(bytes32)']);
const tokenAbi = new Interface(['function allowance(address,address) view returns(uint256)', 'function approveCurrent(address,uint256,uint256) returns(bool)']);

/** One owner action covers its approval and membership transaction. The pool
 * itself enforces calendar invoices and current deployment at execution. */
export async function changeRecourseMembership(operation: 'enroll' | 'leave' | 'settleMonth', identity: string): Promise<string> {
  text(identity, hash);
  return withBiometricAction(translate('recourse.authorize', 'Authorize your Recourse action'), async action => {
    const deployment = await currentProtocolDeployment();
    const provider = TransactionService.providerFor(8453);
    const signer = new ActionWallet(await SeedManager.getEVMPrivateKey(action), action, provider);
    const pool = new Contract(deployment.addresses.recoursePool, poolAbi, provider);
    const primary: unknown = await pool.primaryAddress(identity);
    if (typeof primary !== 'string' || primary.toLowerCase() !== signer.address.toLowerCase()) throw new Error('recourse_binding_not_current');
    if (operation === 'enroll' || operation === 'settleMonth') {
      const token = new Contract(deployment.addresses.kernel, tokenAbi, provider);
      const allowance: unknown = await token.allowance(signer.address, deployment.addresses.recoursePool);
      if (typeof allowance !== 'bigint') throw new Error('recourse_reply_invalid');
      if (allowance !== MaxUint256) {
        const approval = await signer.sendTransaction({ to: deployment.addresses.kernel, chainId: 8453,
          data: tokenAbi.encodeFunctionData('approveCurrent', [deployment.addresses.recoursePool, MaxUint256, deployment.revision]) });
        const receipt = await approval.wait();
        if (!receipt || receipt.status !== 1) throw new Error('recourse_approval_not_confirmed');
      }
    }
    // Re-resolve after an approval or a slow biometric session. No stale target
    // may receive the subsequent owner transaction.
    const current = await currentProtocolDeployment();
    if (current.manifestHash !== deployment.manifestHash) throw new Error('protocol_pointer_changed');
    const args: readonly unknown[] = [identity];
    const tx = await signer.sendTransaction({ to: current.addresses.recoursePool, chainId: 8453,
      data: poolAbi.encodeFunctionData(operation, args) });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('recourse_transaction_not_confirmed');
    return tx.hash;
  });
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
          return { ok: true as const, challenge: { challengeId: binding.nonce, address: binding.address,
            expiresAt: binding.expiresAtMs, message: bindingMessage(binding) } };
        });
      } catch { return { ok: false, error: 'challenge_failed' }; }
    },
    async verify(input) {
      const binding = pending.get(input.challengeId);
      if (!binding || binding.address !== input.address.toLowerCase() || binding.expiresAtMs < Date.now()) return { ok: false, error: 'challenge_expired' };
      try {
        const deployment = await currentProtocolDeployment();
        if (binding.kernel !== deployment.addresses.kernel.toLowerCase()) throw new Error('protocol_pointer_changed');
        await RelayAPIService.recourseRequest('bind', { binding, signature: input.signature });
        await waitForRecourseBinding(binding, ownerChainNetwork());
        pending.delete(input.challengeId);
        return { ok: true, provenAddress: binding.address };
      } catch { return { ok: false, error: 'verification_failed' }; }
    },
  };
}
