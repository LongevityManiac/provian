import type { OwnerChainNetwork } from './recourse-owner-chain';
import { readOwnerChainState } from './recourse-owner-chain';
import { readBreakRecoveryContext } from './break-recovery';
import { recoveryCommitment, recoverySigningRoot } from './recourse-hash-authorization';
import { prepareReplacementDeploymentRequest } from './replacement-deployment-proof';
import { discoverHashAccount } from './hash-account-deployment';
import type { ReplacementDeploymentRequest } from './break-deployment-data';
import { withAgentHashRecoveryRecord, withAgentRecoveryMaterial } from './break-recovery-store';
import type { RecoveryOwnerOperation, RestorationScope } from './recourse-owner-operation';

export interface AgentHashReplacementState {
  readonly nonce: number; readonly sourceAddress: string;
  deploymentDigest?: string;
  deployment?: ReplacementDeploymentRequest;
  operation?: RecoveryOwnerOperation;
  ownerIntent?: string;
  ownerKernel?: string;
  authorizationTxHash?: string;
  installed?: boolean;
  loss?: AgentHashRestoration;
  continuedLosses?: AgentHashRestoration[];
}
export interface AgentHashRestoration {
  readonly transactionHash: string; readonly block: number; readonly kernel: string; readonly scope: RestorationScope;
  submitted?: boolean;
}
export interface AgentHashReplacementLocator {
  readonly identity: string; readonly commitment: string; readonly context: string;
}
export interface AgentHashReplacementPlan extends AgentHashReplacementLocator {
  readonly nonce: number; readonly account: string; readonly initialRoot: string; readonly deployed: boolean;
}
export interface AgentHashReplacementInput { readonly directory: string; readonly passphrase: string; readonly network: OwnerChainNetwork }

/** Select only independently verified recovery material. A stolen spending key
 * may have changed the old account's root; that root is never consulted here. */
export async function prepareAgentHashReplacement(supplied: AgentHashReplacementInput & { identity: string }): Promise<AgentHashReplacementPlan> {
  const input = { ...supplied };
  const context = await readBreakRecoveryContext(input.network), owner = await readOwnerChainState(input.identity, input.network);
  if (owner.nonce < 1 || !Number.isSafeInteger(owner.nonce) || /^0x0+$/.test(owner.destination)) throw Error('hash_replacement_not_restored');
  const locator = { identity: input.identity, commitment: owner.commitment, context };
  // Validate the existing backup before making a fresh key record.
  await withAgentRecoveryMaterial({ ...input, ...locator }, async (secret, seed) => {
    const root = await recoverySigningRoot(seed);
    if (root !== owner.signingRoot || recoveryCommitment(secret, root) !== owner.commitment) throw Error('hash_replacement_authority_changed');
  });
  return withAgentHashRecoveryRecord({ ...input, ...locator, create: true }, async (record, persist) => {
    if (record.prepared || record.restoredTransaction) throw Error('hash_replacement_record_conflict');
    if (!record.replacement) { record.replacement = { nonce: owner.nonce, sourceAddress: owner.destination }; persist(); }
    if (record.replacement.nonce !== owner.nonce || record.replacement.sourceAddress !== owner.destination) throw Error('hash_replacement_authority_changed');
    const seed = Buffer.from(record.destinationSigningSeed.slice(2), 'hex');
    try {
      const initialRoot = await recoverySigningRoot(seed), account = await discoverHashAccount(initialRoot, input.network, context);
      if (account.manifestHash !== owner.deployment.manifestHash || account.account === owner.destination
        || (record.destination && record.destination !== account.account)
        || (account.deployed && (account.currentRoot !== initialRoot || account.nonce !== '0'))) throw Error('hash_replacement_destination_changed');
      const latest = await readOwnerChainState(input.identity, input.network);
      if (latest.nonce !== owner.nonce || latest.commitment !== owner.commitment || latest.signingRoot !== owner.signingRoot
        || latest.destination !== owner.destination || latest.deployment.manifestHash !== owner.deployment.manifestHash) throw Error('hash_replacement_authority_changed');
      record.destination = account.account; persist();
      return { ...locator, nonce: owner.nonce, account: account.account, initialRoot, deployed: account.deployed };
    } finally { seed.fill(0); }
  });
}
/** A sponsor receives only a proof fixed to this durable fresh seed, current
 * owner nonce and deployment domain. Retrying cannot choose another account. */
export async function prepareAgentHashReplacementDeployment(supplied: AgentHashReplacementInput & { plan: AgentHashReplacementPlan }): Promise<ReplacementDeploymentRequest> {
  const input = { ...supplied }, plan = { ...supplied.plan };
  return withAgentHashRecoveryRecord({ ...input, ...plan }, async (record, persist) => {
    if (!record.replacement || record.replacement.nonce !== plan.nonce || record.destination !== plan.account) throw Error('hash_replacement_plan_changed');
    const destinationSeed = Buffer.from(record.destinationSigningSeed.slice(2), 'hex');
    try {
      if (await recoverySigningRoot(destinationSeed) !== plan.initialRoot) throw Error('hash_replacement_plan_changed');
      const request = await withAgentRecoveryMaterial({ ...input, ...plan }, (secret, seed) => prepareReplacementDeploymentRequest({
        network: input.network, identity: plan.identity, expectedBreakOrigin: plan.context,
        destinationSigningSeed: destinationSeed, recoverySecret: secret, recoverySigningSeed: seed,
        async persistBeforePublishing(value) {
          if (value.account !== plan.account || value.breakOrigin !== plan.context || value.nonce !== plan.nonce) throw Error('hash_replacement_plan_changed');
          record.replacement!.deploymentDigest = value.digest; persist();
        },
      }));
      if (request.commitment !== plan.commitment || request.initialRoot !== plan.initialRoot || request.account !== plan.account) throw Error('hash_replacement_plan_changed');
      record.replacement.deployment = request; persist(); return request;
    } finally { destinationSeed.fill(0); }
  });
}
