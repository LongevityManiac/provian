import * as SecureStore from 'expo-secure-store';
import { Interface, sha256, toUtf8Bytes } from 'ethers';
import { ownerChainNetwork } from '../protocol/runtime';
import { withBiometricAction, type BiometricAction } from '../security/biometricAction';
import { ActionWallet } from '../security/ActionWallet';
import SeedManager from '../wallet/SeedManager';
import TransactionService from '../wallet/TransactionService';
import { useWalletStore } from '../../store/walletStore';
import { translate } from '../../i18n/translate';
import { humanMembershipRelay, signHumanMembershipBytes } from './human-membership';
import { prepareMembershipDebit, prepareMembershipApproval, submitMembershipDebit, validateMembershipDebit,
  type MembershipDebitChallenge, type MembershipDebitPreparation, type MembershipOperationStatus } from './membership-client';
import { deriveHumanAccount, readHumanAccountSelection } from './human-account';
import { prepareHumanHashSpending } from './human-hash-spending';
import { deliverHumanHashSpending, pendingHumanHashDeliveryOperation } from './human-hash-delivery';
import { hashDeliveryId, type HashDeliveryResult } from './hash-account-delivery';

const TOKEN = new Interface(['function allowance(address,address) view returns(uint256)', 'function approveCurrent(address,uint256,uint256) returns(bool)']);
function account(): string {
  const value = useWalletStore.getState().address?.toLowerCase();
  if (!value || !/^0x[0-9a-f]{40}$/.test(value)) throw Error('recourse_address_unavailable'); return value;
}
export function prepareHumanMembershipDebit(): Promise<MembershipDebitPreparation> {
  return prepareMembershipDebit(humanMembershipRelay(), account());
}
export type HumanMembershipDebitResult = { readonly status: 'submitted'; readonly operation: MembershipOperationStatus }
  | { readonly status: 'approval'; readonly delivery: HashDeliveryResult };

const approvalKey = (payer: string) => `provian_membership_approval_${payer.slice(2)}`;
interface ApprovalProvenance {
  readonly version: 1; readonly account: string; readonly kernel: string; readonly pool: string;
  readonly revision: string; readonly amountAtomic: string; readonly data: string; readonly reservationId: string;
}
/** Written only after independent challenge verification and exact allowance
 * construction, before signing an account operation that may outlive it. */
async function retainApproval(challenge: MembershipDebitChallenge, data: string): Promise<void> {
  const value: ApprovalProvenance = { version: 1, account: challenge.debit.payer, kernel: challenge.domain.kernel,
    pool: challenge.domain.pool, revision: challenge.debit.revision, amountAtomic: challenge.allowanceAtomic,
    data, reservationId: challenge.reservationId };
  const raw = JSON.stringify(value), key = approvalKey(value.account);
  await SecureStore.setItemAsync(key, raw, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (await SecureStore.getItemAsync(key) !== raw) throw Error('recourse_membership_approval_write_unconfirmed');
}
async function approveExact(challenge: MembershipDebitChallenge, action: BiometricAction): Promise<HashDeliveryResult | null> {
  const payer = account(), network = ownerChainNetwork();
  const tx = await prepareMembershipApproval(challenge, payer, network), deployment = await network.deployment();
  if (deployment.addresses.kernel.toLowerCase() !== tx.to || String(deployment.revision) !== challenge.debit.revision) throw Error('recourse_membership_retired');
  const values = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_call', [{ to: tx.to,
    data: TOKEN.encodeFunctionData('allowance', [payer, challenge.domain.pool]) }, { blockHash: deployment.blockHash, requireCanonical: true }])));
  if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('recourse_membership_allowance_disagreement');
  const allowance = BigInt(TOKEN.decodeFunctionResult('allowance', values[0])[0]);
  const pending = await pendingHumanHashDeliveryOperation(payer);
  if (pending) {
    // Never execute a different previously signed account action under a debit
    // review. Its own transaction screen remains the place to resume that call.
    if (pending.target !== tx.to || pending.value !== '0' || pending.data !== tx.data) throw Error('recourse_hash_spending_pending');
    await retainApproval(challenge, tx.data);
    const result = await deliverHumanHashSpending(payer, action, hashDeliveryId(pending));
    if (result.status !== 'complete' || result.outcome !== 'succeeded') return result;
    return null;
  }
  if (allowance === BigInt(challenge.allowanceAtomic)) return null;
  const mnemonic = await SeedManager.getMnemonic(action);
  if (!mnemonic) throw Error('recourse_seed_unavailable');
  const root = await deriveHumanAccount(mnemonic, 0), selected = await readHumanAccountSelection(root.evm);
  if (selected?.kind === 'hash') {
    const estimates = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_estimateGas', [{ from: payer,
      to: tx.to, data: tx.data, value: '0x0' }])));
    if (!estimates.every(v => typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) && BigInt(v) > 0n)) throw Error('recourse_gas_estimate_unavailable');
    const gas = estimates.map(v => BigInt(String(v))).reduce((a, b) => a > b ? a : b);
    // Execution headroom, not a spending allowance or membership amount.
    await retainApproval(challenge, tx.data);
    const prepared = await prepareHumanHashSpending(mnemonic, { target: tx.to, value: '0', data: tx.data, callGas: String(gas + gas / 5n) }, action);
    return deliverHumanHashSpending(payer, action, hashDeliveryId(prepared));
  }
  const signer = new ActionWallet(await SeedManager.getEVMPrivateKey(action), action, TransactionService.providerFor(8453),
    sha256(toUtf8Bytes(`membership-approval:${challenge.reservationId}`)));
  if (signer.address.toLowerCase() !== payer) throw Error('recourse_membership_wrong_wallet');
  const sent = await signer.sendTransaction(tx), receipt = await sent.wait();
  if (!receipt || receipt.status !== 1) throw Error('recourse_membership_approval_failed');
  return null;
}
/** The screen displays exact burn, reserve and month before this single owner
 * approval. An expired mandate is refreshed for review, never silently changed. */
export function authorizeHumanMembershipDebit(challenge: MembershipDebitChallenge): Promise<HumanMembershipDebitResult> {
  return withBiometricAction(translate('recourse.authorize', 'Authorize your Recourse action'), async action => {
    const payer = account();
    await validateMembershipDebit(challenge, payer, ownerChainNetwork());
    const delivery = await approveExact(challenge, action);
    if (delivery) return { status: 'approval', delivery };
    const operation = await submitMembershipDebit(humanMembershipRelay(action), ownerChainNetwork(), {
      payer, challenge, signBytes: bytes => signHumanMembershipBytes(payer, bytes, action),
    });
    return { status: 'submitted', operation };
  });
}
/** A hash approval may outlive the short debit challenge. Finish its existing
 * transaction separately, then fetch a fresh exact challenge for review. */
export interface HumanMembershipApproval {
  readonly operationId: string; readonly account: string; readonly kernel: string;
  readonly pool: string; readonly amountAtomic: string; readonly revision: string;
}
export async function readHumanMembershipApproval(): Promise<HumanMembershipApproval | null> {
  const payer = account(), operation = await pendingHumanHashDeliveryOperation(payer);
  if (!operation || operation.value !== '0') return null;
  const parsed = TOKEN.parseTransaction({ data: operation.data });
  if (parsed?.name !== 'approveCurrent') return null;
  const raw = await SecureStore.getItemAsync(approvalKey(payer));
  if (raw === null) return null;
  const provenance = JSON.parse(raw) as ApprovalProvenance;
  if (!provenance || Object.keys(provenance).sort().join(',') !== 'account,amountAtomic,data,kernel,pool,reservationId,revision,version'
    || provenance.version !== 1 || !/^0x[0-9a-f]{64}$/.test(provenance.reservationId)
    || provenance.account !== payer || provenance.kernel !== operation.target || provenance.data !== operation.data
    || provenance.pool !== String(parsed.args[0]).toLowerCase() || provenance.amountAtomic !== String(parsed.args[1])
    || provenance.revision !== String(parsed.args[2])) return null;
  return { operationId: hashDeliveryId(operation), account: payer, kernel: operation.target,
    pool: String(parsed.args[0]).toLowerCase(), amountAtomic: String(parsed.args[1]), revision: String(parsed.args[2]) };
}
export async function resumeHumanMembershipApproval(reviewed: HumanMembershipApproval): Promise<HashDeliveryResult> {
  return withBiometricAction(translate('recourse.authorize', 'Authorize your Recourse action'), async action => {
    const current = await readHumanMembershipApproval();
    if (!current || Object.entries(current).some(([key, value]) => reviewed[key as keyof HumanMembershipApproval] !== value)) throw Error('recourse_membership_approval_changed');
    return deliverHumanHashSpending(current.account, action, current.operationId);
  });
}
