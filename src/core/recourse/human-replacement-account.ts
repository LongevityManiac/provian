import { hashMessage } from 'ethers';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import RelayAPIService from '../../services/RelayAPIService';
import { humanBreakKey, type HumanBreakKeyContext } from './human-secret';
import { recoverySigningRoot, recoveryCommitment } from './hash-authorization';
import { readBreakRecoveryContext } from './break-recovery';
import { readOwnerChainState, type OwnerChainNetwork } from './owner-chain';
import { discoverHashAccount } from './hash-account-deployment';
import { prepareReplacementDeploymentRequest } from './replacement-deployment-proof';
import { accountDeploymentDigest } from './break-deployment-data';
import { signHashAccountMessage } from './hash-account';

export class ReplacementSpendingKeyChangedError extends Error {
  constructor() { super('recourse_replacement_spending_key_changed'); }
}
export interface HumanReplacementAccount {
  readonly identity: string; readonly breakOrigin: string; readonly nonce: number;
  readonly account: string; readonly initialRoot: string; readonly accountGeneration: string;
}
function context(plan: HumanReplacementAccount): HumanBreakKeyContext {
  if (!/^0x[0-9a-f]{64}$/.test(plan.identity) || /^0x0+$/.test(plan.identity)
    || !/^0x[0-9a-f]{40}$/.test(plan.breakOrigin) || /^0x0+$/.test(plan.breakOrigin)
    || !Number.isSafeInteger(plan.nonce) || plan.nonce < 1 || plan.nonce >= Number.MAX_SAFE_INTEGER
    || plan.accountGeneration !== String(plan.nonce + 1) || !/^0x[0-9a-f]{40}$/.test(plan.account)
    || !/^0x[0-9a-f]{64}$/.test(plan.initialRoot)) throw Error('recourse_replacement_plan_invalid');
  return { identity: plan.identity, breakOrigin: plan.breakOrigin, chainId: '8453', accountGeneration: plan.accountGeneration };
}
/** Theft may have rotated the spending key to an attacker-chosen root. Only
 * independent recovery material is required here; current spending possession
 * must never be a prerequisite for replacing a stolen account. */
export async function prepareHumanReplacementAccount(mnemonic: string, identity: string,
  network: OwnerChainNetwork): Promise<HumanReplacementAccount> {
  const breakOrigin = await readBreakRecoveryContext(network), owner = await readOwnerChainState(identity, network);
  if (owner.nonce < 1 || !Number.isSafeInteger(owner.nonce) || owner.nonce >= Number.MAX_SAFE_INTEGER) throw Error('recourse_replacement_not_restored');
  const accountGeneration = String(owner.nonce + 1), base = { identity, breakOrigin, chainId: '8453' as const, accountGeneration };
  const secret = humanBreakKey(mnemonic, base, 'recovery-secret', String(owner.nonce));
  const recoverySeed = humanBreakKey(mnemonic, base, 'recovery-signing', String(owner.nonce));
  const spendingSeed = humanBreakKey(mnemonic, base, 'spending', '0');
  try {
    const root = await recoverySigningRoot(recoverySeed);
    if (root !== owner.signingRoot || recoveryCommitment(secret, root) !== owner.commitment) throw Error('recourse_replacement_backup_mismatch');
    const initialRoot = await recoverySigningRoot(spendingSeed), account = await discoverHashAccount(initialRoot, network, breakOrigin);
    if (account.manifestHash !== owner.deployment.manifestHash || account.account === owner.destination
      || (account.deployed && (account.currentRoot !== initialRoot || account.nonce !== '0'))) throw Error('recourse_replacement_state_changed');
    const latest = await readOwnerChainState(identity, network);
    if (latest.deployment.manifestHash !== owner.deployment.manifestHash || latest.nonce !== owner.nonce
      || latest.commitment !== owner.commitment || latest.signingRoot !== owner.signingRoot || latest.destination !== owner.destination) throw Error('recourse_replacement_state_changed');
    return { identity, breakOrigin, nonce: owner.nonce, account: account.account, initialRoot, accountGeneration };
  } finally { secret.fill(0); recoverySeed.fill(0); spendingSeed.fill(0); }
}
/** The caller durably journals the returned plan before invoking sponsorship.
 * The relay cannot replace its address; both status and final deployed runtime
 * are checked against the exact seed-derived root. */
export async function deployHumanReplacementAccount(mnemonic: string, supplied: HumanReplacementAccount,
  action: BiometricAction, network: OwnerChainNetwork, retain: (plan: HumanReplacementAccount) => Promise<void>, signal?: AbortSignal,
  send: (path: string, body: unknown, access: { identity: string; secret: Uint8Array; signingSeed: Uint8Array }) => Promise<unknown>
    = (path, body, access) => RelayAPIService.recourseRecoveryRequest(path, body, access)): Promise<void> {
  const plan = { ...supplied }, base = context(plan);
  assertBiometricAction(action); signal?.throwIfAborted();
  const spendingSeed = humanBreakKey(mnemonic, base, 'spending', '0');
  const secret = humanBreakKey(mnemonic, base, 'recovery-secret', String(plan.nonce));
  const signingSeed = humanBreakKey(mnemonic, base, 'recovery-signing', String(plan.nonce));
  try {
    if (await recoverySigningRoot(spendingSeed) !== plan.initialRoot) throw Error('recourse_replacement_backup_mismatch');
    const current = await discoverHashAccount(plan.initialRoot, network, plan.breakOrigin);
    if (current.account !== plan.account) throw Error('recourse_replacement_state_changed');
    if (current.deployed) {
      if (current.currentRoot !== plan.initialRoot || current.nonce !== '0') throw Error('recourse_replacement_state_changed');
      return;
    }
    const request = await prepareReplacementDeploymentRequest({ network, identity: plan.identity, expectedBreakOrigin: plan.breakOrigin,
      destinationSigningSeed: spendingSeed, recoverySecret: secret, recoverySigningSeed: signingSeed,
      async persistBeforePublishing(value) {
        assertBiometricAction(action);
        if (value.account !== plan.account || value.breakOrigin !== plan.breakOrigin || value.nonce !== plan.nonce) throw Error('recourse_replacement_state_changed');
        await retain({ ...plan });
      } });
    const id = accountDeploymentDigest(request), access = { identity: plan.identity, secret, signingSeed };
    assertBiometricAction(action);
    let response: unknown = await send('break-deployments', request, access);
    while (true) {
      assertBiometricAction(action); signal?.throwIfAborted();
      if (!response || typeof response !== 'object' || !('id' in response) || response.id !== id || !('status' in response)
        || !['queued','submitted','confirmed','failed'].includes(String(response.status))) throw Error('recourse_replacement_reply_invalid');
      if (response.status === 'failed') throw Error('recourse_replacement_deployment_failed');
      if (response.status === 'confirmed') break;
      await new Promise<void>(resolve => setTimeout(resolve, 5000));
      response = await send(`break-deployments/${id}`, undefined, access);
    }
    const deployed = await discoverHashAccount(plan.initialRoot, network, plan.breakOrigin);
    if (!deployed.deployed || deployed.account !== plan.account || deployed.currentRoot !== plan.initialRoot || deployed.nonce !== '0') throw Error('recourse_replacement_state_changed');
  } finally { spendingSeed.fill(0); secret.fill(0); signingSeed.fill(0); }
}
/** Fresh destination possession is distinct from the owner-recovery signature.
 * The replacement may have spent after the chain operation completed. */
export async function signHumanReplacementDestination(mnemonic: string, supplied: HumanReplacementAccount, message: string,
  action: BiometricAction, network: OwnerChainNetwork): Promise<string> {
  const plan = { ...supplied }, base = context(plan);
  assertBiometricAction(action);
  const account = await discoverHashAccount(plan.initialRoot, network, plan.breakOrigin);
  if (!account.deployed || account.account !== plan.account || account.nonce === null) throw Error('recourse_replacement_state_changed');
  const seed = humanBreakKey(mnemonic, base, 'spending', account.nonce);
  try {
    if (await recoverySigningRoot(seed) !== account.currentRoot) throw new ReplacementSpendingKeyChangedError();
    const signature = await signHashAccountMessage(plan.account, hashMessage(message), seed);
    const latest = await discoverHashAccount(plan.initialRoot, network, plan.breakOrigin);
    if (latest.manifestHash !== account.manifestHash || latest.currentRoot !== account.currentRoot || latest.nonce !== account.nonce) throw Error('recourse_replacement_state_changed');
    assertBiometricAction(action); return signature;
  } finally { seed.fill(0); }
}
