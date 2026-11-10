import { AbiCoder, Interface, ZeroHash, concat, hexlify, sha256 } from 'ethers';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import type { BreakOwnerEntitlement } from './break-recovery';
import { BREAK_RECOVERY_ABI } from './break-recovery';
import { prepareHashAccountDeployment } from './hash-account-deployment';
import { recoveryCommitment, recoverySigningRoot, signRecoveryIntent } from './recourse-hash-authorization';

import { breakDeploymentDigest, type BreakDeploymentRequest } from './break-deployment-data';
export { breakDeploymentDigest, type BreakDeploymentRequest } from './break-deployment-data';

/** Gas sponsorship cannot select another destination. The same independent
 * owner key that authorizes restoration signs the exact deterministic account,
 * after the backup has durably retained its destination material. */
export async function prepareBreakDeploymentRequest(input: {
  network: OwnerChainNetwork; entitlement: BreakOwnerEntitlement; destinationSigningSeed: Uint8Array;
  expectedBreakOrigin?: string;
  recoverySecret: Uint8Array; recoverySigningSeed: Uint8Array;
  persistBeforePublishing(request: { account: string; breakOrigin: string; digest: string }): Promise<void>;
}): Promise<BreakDeploymentRequest> {
  const e = input.entitlement;
  if (!/^0x[0-9a-f]{64}$/.test(e.identity) || e.identity === ZeroHash || !/^0x[0-9a-f]{64}$/.test(e.commitment)
    || !/^(0|[1-9][0-9]*)$/.test(e.amount) || BigInt(e.amount) >= 2n ** 256n
    || !Array.isArray(e.proof) || e.proof.length > 256 || !e.proof.every(value => /^0x[0-9a-f]{64}$/.test(value))) throw Error('break_deployment_entitlement_invalid');
  const secret = new Uint8Array(input.recoverySecret), seed = new Uint8Array(input.recoverySigningSeed);
  const destinationSeed = new Uint8Array(input.destinationSigningSeed);
  try {
    const initialRoot = await recoverySigningRoot(destinationSeed), signingRoot = await recoverySigningRoot(seed);
    if (hexlify(secret) === hexlify(destinationSeed) || hexlify(secret) === hexlify(seed)
      || initialRoot === signingRoot || recoveryCommitment(secret, signingRoot) !== e.commitment) throw Error('break_deployment_material_invalid');
    const plan = await prepareHashAccountDeployment(initialRoot, input.network, input.expectedBreakOrigin);
    const deployment = await input.network.deployment();
    if (deployment.manifestHash !== plan.manifestHash) throw Error('break_deployment_protocol_changed');
    const tag = { blockHash: deployment.blockHash, requireCanonical: true };
    const call = async (to: string, abi: Interface, name: string) => {
      const replies = await Promise.all(input.network.rpcs.map(rpc => rpc.request('eth_call', [{ to, data: abi.encodeFunctionData(name) }, tag])));
      if (typeof replies[0] !== 'string' || replies[0] !== replies[1]) throw Error('break_deployment_rpc_disagreement');
      return abi.decodeFunctionResult(name, replies[0])[0];
    };
    const previous = await call(plan.breakOrigin, BREAK_RECOVERY_ABI, 'predecessor');
    const block = await call(plan.breakOrigin, BREAK_RECOVERY_ABI, 'lastGoodBlock');
    const root = await call(plan.breakOrigin, BREAK_RECOVERY_ABI, 'restorationRoot');
    let leaf = sha256(AbiCoder.defaultAbiCoder().encode(['string', 'address', 'uint256', 'bytes32', 'uint256', 'bytes32'],
      ['Provian restoration', previous, block, e.identity, e.amount, e.commitment]));
    for (const sibling of e.proof) leaf = sha256(concat(leaf < sibling ? [leaf, sibling] : [sibling, leaf]));
    if (leaf !== root) throw Error('break_deployment_entitlement_invalid');
    const base = { kind: 'deploy' as const, breakOrigin: plan.breakOrigin, factory: plan.factory, account: plan.account,
      initialRoot, identity: e.identity, amount: e.amount, commitment: e.commitment, proof: [...e.proof], recoverySecret: hexlify(secret), signingRoot };
    const digest = breakDeploymentDigest(base);
    const signed = await signRecoveryIntent(seed, digest, { reserve: async () => input.persistBeforePublishing({
      account: plan.account, breakOrigin: plan.breakOrigin, digest }) });
    if ((await input.network.deployment()).manifestHash !== plan.manifestHash) throw Error('break_deployment_protocol_changed');
    return { ...base, publicKey: signed.publicKey, signature: signed.signature };
  } finally { secret.fill(0); seed.fill(0); destinationSeed.fill(0); }
}
