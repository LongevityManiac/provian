import { hexlify } from 'ethers';
import type { OwnerChainNetwork } from './owner-chain';
import { readOwnerChainState } from './owner-chain';
import { prepareHashAccountDeployment } from './hash-account-deployment';
import { recoveryCommitment, recoverySigningRoot, signRecoveryIntent } from './hash-authorization';
import { replacementDeploymentDigest, type ReplacementDeploymentRequest } from './break-deployment-data';

/** Sponsorship is bound to the current recovery nonce and one deterministic
 * account. Neither the sponsor nor a replay can select a different root. */
export async function prepareReplacementDeploymentRequest(input: {
  network: OwnerChainNetwork; identity: string; expectedBreakOrigin: string;
  destinationSigningSeed: Uint8Array; recoverySecret: Uint8Array; recoverySigningSeed: Uint8Array;
  persistBeforePublishing(request: { account: string; breakOrigin: string; nonce: number; digest: string }): Promise<void>;
}): Promise<ReplacementDeploymentRequest> {
  const identity = input.identity, origin = input.expectedBreakOrigin;
  const secret = new Uint8Array(input.recoverySecret), seed = new Uint8Array(input.recoverySigningSeed), next = new Uint8Array(input.destinationSigningSeed);
  try {
    const initialRoot = await recoverySigningRoot(next), signingRoot = await recoverySigningRoot(seed), commitment = recoveryCommitment(secret, signingRoot);
    if (hexlify(secret) === hexlify(next) || hexlify(secret) === hexlify(seed) || initialRoot === signingRoot) throw Error('replacement_deployment_material_invalid');
    const current = await readOwnerChainState(identity, input.network);
    if (current.nonce < 1 || current.commitment !== commitment || current.signingRoot !== signingRoot) throw Error('replacement_deployment_owner_changed');
    const plan = await prepareHashAccountDeployment(initialRoot, input.network, origin);
    if (current.deployment.manifestHash !== plan.manifestHash || current.destination === plan.account) throw Error('replacement_deployment_state_changed');
    const base = { kind: 'replacement' as const, kernel: current.deployment.addresses.kernel.toLowerCase(), revision: String(current.deployment.revision),
      nonce: current.nonce, breakOrigin: origin, factory: plan.factory, account: plan.account, initialRoot, identity, commitment,
      recoverySecret: hexlify(secret), signingRoot };
    const digest = replacementDeploymentDigest(base);
    const signed = await signRecoveryIntent(seed, digest, { reserve: async () => input.persistBeforePublishing({ account: plan.account,
      breakOrigin: origin, nonce: current.nonce, digest }) });
    const latest = await readOwnerChainState(identity, input.network);
    if (latest.deployment.manifestHash !== current.deployment.manifestHash || latest.nonce !== current.nonce
      || latest.commitment !== current.commitment || latest.signingRoot !== current.signingRoot || latest.destination !== current.destination) throw Error('replacement_deployment_state_changed');
    return { ...base, publicKey: signed.publicKey, signature: signed.signature };
  } finally { secret.fill(0); seed.fill(0); next.fill(0); }
}
