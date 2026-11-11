import { hexlify } from 'ethers';
import { readOwnerChainState, verifyOwnerOperationReceipt } from './recourse-owner-chain';
import { recoveryCommitment, recoverySigningRoot, signRecoveryIntent } from './recourse-hash-authorization';
import { ownerOperationIntent, parseRestorationScope, type RecoveryOwnerOperation } from './recourse-owner-operation';
import { readBreakRecoveryContext } from './break-recovery';
import { withAgentHashRecoveryRecord, withAgentRecoveryMaterial } from './break-recovery-store';
import { discoverHashAccount } from './hash-account-deployment';
import type { AgentHashReplacementInput, AgentHashReplacementPlan, AgentHashRestoration } from './agent-hash-replacement';

/** The one-use loss scope is retained before signing. A retry preserves that
 * scope and the fresh destination; no old spending-key signature is requested. */
export async function prepareAgentHashOwnerOperation(supplied: AgentHashReplacementInput & {
  readonly plan: AgentHashReplacementPlan; readonly loss?: AgentHashRestoration;
}): Promise<RecoveryOwnerOperation> {
  const input = { ...supplied }, plan = { ...supplied.plan };
  const loss = supplied.loss ? { ...supplied.loss, scope: { ...parseRestorationScope(supplied.loss.scope) } } : undefined;
  if (loss && (!/^0x[0-9a-f]{64}$/.test(loss.transactionHash) || !Number.isSafeInteger(loss.block) || loss.block < 1
    || !/^0x[0-9a-f]{40}$/.test(loss.kernel))) throw Error('hash_replacement_loss_invalid');
  return withAgentHashRecoveryRecord({ ...input, ...plan }, async (record, persist) => {
    const state = record.replacement;
    if (!state || state.nonce !== plan.nonce || record.destination !== plan.account) throw Error('hash_replacement_plan_changed');
    if (loss && state.loss && (state.loss.transactionHash !== loss.transactionHash || state.loss.block !== loss.block
      || JSON.stringify(state.loss.scope) !== JSON.stringify(loss.scope))) throw Error('hash_replacement_loss_changed');
    if (await readBreakRecoveryContext(input.network) !== plan.context) throw Error('hash_replacement_context_changed');
    const owner = await readOwnerChainState(plan.identity, input.network);
    if (state.operation) {
      if (loss && (!state.loss || state.loss.transactionHash !== loss.transactionHash || state.loss.block !== loss.block
        || JSON.stringify(state.loss.scope) !== JSON.stringify(loss.scope))) throw Error('hash_replacement_loss_changed');
      const previous = state.operation;
      if (owner.nonce === previous.nonce + 1 && owner.destination === previous.destination
        && owner.commitment === previous.proof.nextCommitment && owner.signingRoot === previous.proof.nextSigningRoot) return previous;
      if (owner.nonce !== previous.nonce || owner.commitment !== plan.commitment || owner.signingRoot !== previous.proof.signingRoot) throw Error('hash_replacement_authority_changed');
      if (previous.kernel === owner.deployment.addresses.kernel.toLowerCase()) {
        if (previous.revision !== String(owner.deployment.revision)) { state.operation = { ...previous, revision: String(owner.deployment.revision) }; persist(); }
        return state.operation;
      }
      // The pointer now selects another kernel, while the old authorization is
      // still unconsumed. Preserve all economic fields in the new signed domain.
      delete state.operation; delete state.ownerIntent; delete state.ownerKernel; persist();
    } else if (loss && !state.loss) {
      if (state.ownerIntent) throw Error('hash_replacement_loss_changed');
      if (loss.kernel !== owner.deployment.addresses.kernel.toLowerCase()) throw Error('hash_replacement_loss_kernel_changed');
      state.loss = loss; persist();
    }
    if (owner.nonce !== plan.nonce || owner.commitment !== plan.commitment) throw Error('hash_replacement_authority_changed');
    if (state.ownerIntent && state.ownerKernel !== owner.deployment.addresses.kernel.toLowerCase()) {
      if (!state.ownerKernel) throw Error('hash_replacement_intent_changed');
      delete state.ownerIntent; delete state.ownerKernel; persist();
    }
    const spendingSeed = Buffer.from(record.destinationSigningSeed.slice(2), 'hex'), nextSecret = Buffer.from(record.nextRecoverySecret.slice(2), 'hex'), nextSeed = Buffer.from(record.nextRecoverySigningSeed.slice(2), 'hex');
    try {
      const initialRoot = await recoverySigningRoot(spendingSeed), nextSigningRoot = await recoverySigningRoot(nextSeed);
      if (initialRoot !== plan.initialRoot) throw Error('hash_replacement_plan_changed');
      const account = await discoverHashAccount(initialRoot, input.network, plan.context);
      if (!account.deployed || account.account !== plan.account || account.currentRoot !== initialRoot || account.nonce !== '0'
        || account.manifestHash !== owner.deployment.manifestHash) throw Error('hash_replacement_destination_changed');
      const operation = await withAgentRecoveryMaterial({ ...input, ...plan }, async (secret, seed) => {
        const signingRoot = await recoverySigningRoot(seed);
        if (signingRoot !== owner.signingRoot || recoveryCommitment(secret, signingRoot) !== owner.commitment) throw Error('hash_replacement_authority_changed');
        const value: RecoveryOwnerOperation = { kernel: owner.deployment.addresses.kernel.toLowerCase(), revision: String(owner.deployment.revision),
          identity: plan.identity, destination: plan.account, nonce: plan.nonce,
          ...(state.loss ? { restoration: state.loss.scope } : {}),
          proof: { recoverySecret: hexlify(secret), signingRoot, nextCommitment: recoveryCommitment(nextSecret, nextSigningRoot), nextSigningRoot,
            publicKey: `0x${'00'.repeat(32)}`, signature: '0x' } };
        const intent = ownerOperationIntent(value);
        const signed = await signRecoveryIntent(seed, intent, { async reserve(_root, reserved) {
          if (reserved !== intent || (state.ownerIntent && state.ownerIntent !== intent)) throw Error('hash_replacement_intent_changed');
          state.ownerIntent = intent; state.ownerKernel = value.kernel; persist();
        } });
        return { ...value, proof: { ...value.proof, ...signed } };
      });
      state.operation = operation; persist(); return operation;
    } finally { spendingSeed.fill(0); nextSecret.fill(0); nextSeed.fill(0); }
  });
}

export async function confirmAgentHashOwnerOperation(supplied: AgentHashReplacementInput & {
  readonly plan: AgentHashReplacementPlan; readonly transactionHash: string;
}): Promise<void> {
  const input = { ...supplied }, plan = { ...supplied.plan };
  return withAgentHashRecoveryRecord({ ...input, ...plan }, async (record, persist) => {
    const state = record.replacement;
    if (!state?.operation || record.destination !== plan.account || state.nonce !== plan.nonce
      || (state.authorizationTxHash && state.authorizationTxHash !== input.transactionHash)) throw Error('hash_replacement_receipt_changed');
    await verifyOwnerOperationReceipt(state.operation, input.transactionHash, input.network);
    state.authorizationTxHash = input.transactionHash; persist();
  });
}
