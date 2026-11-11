import { Wallet, hexlify } from 'ethers';
import type { OwnerChainNetwork } from './owner-chain';
import { readOwnerChainState } from './owner-chain';
import { readBreakRecoveryContext } from './break-recovery';
import { auxiliaryAccountKey } from './auxiliary-account';
import { humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import { recoveryCommitment, recoverySigningRoot } from './hash-authorization';
import { discoverBoundHumanHashAccount } from './human-bound-hash-account';

export interface BoundHumanSpendingAccount {
  readonly account: string; readonly kind: 'curve' | 'hash'; readonly auxiliaryBinding: string;
  readonly generation: number; readonly manifestHash: string;
}
/** The binding selects a derivation domain, never a caller-supplied private key
 * or the primary wallet. Only the exact current recovered destination may send. */
export async function discoverBoundHumanSpendingAccount(mnemonic: string, identity: string,
  network: OwnerChainNetwork): Promise<BoundHumanSpendingAccount> {
  if (!/^0x[0-9a-f]{64}$/.test(identity) || /^0x0+$/.test(identity)) throw Error('recourse_auxiliary_binding_invalid');
  let broken = true;
  try { await readBreakRecoveryContext(network); }
  catch (error) { if (!(error instanceof Error) || error.message !== 'break_recovery_unavailable') throw error; broken = false; }
  if (broken) {
    const bound = await discoverBoundHumanHashAccount(mnemonic, identity, network);
    return { account: bound.evm, kind: 'hash', auxiliaryBinding: identity,
      generation: bound.recoveryGeneration, manifestHash: bound.manifestHash };
  }
  const owner = await readOwnerChainState(identity, network);
  if (!Number.isSafeInteger(owner.nonce) || owner.nonce < 1 || owner.nonce >= 0x80000000
    || /^0x0+$/.test(owner.destination)) throw Error('recourse_auxiliary_not_recovered');
  const secret = humanRecoverySecret(mnemonic, owner.nonce, identity), seed = humanRecoverySigningSeed(mnemonic, owner.nonce, identity);
  try {
    const root = await recoverySigningRoot(seed);
    if (root !== owner.signingRoot || recoveryCommitment(secret, root) !== owner.commitment) throw Error('recourse_auxiliary_recovery_mismatch');
  } finally { secret.fill(0); seed.fill(0); }
  for (let generation = owner.nonce; generation >= 1; generation--) {
    const key = await auxiliaryAccountKey(mnemonic, identity, generation);
    let account: string;
    try { account = new Wallet(hexlify(key)).address.toLowerCase(); } finally { key.fill(0); }
    if (account !== owner.destination) continue;
    const latest = await readOwnerChainState(identity, network);
    if (latest.deployment.manifestHash !== owner.deployment.manifestHash || latest.destination !== owner.destination
      || latest.nonce !== owner.nonce || latest.commitment !== owner.commitment || latest.signingRoot !== owner.signingRoot) throw Error('recourse_auxiliary_state_changed');
    return { account, kind: 'curve', auxiliaryBinding: identity, generation, manifestHash: owner.deployment.manifestHash };
  }
  throw Error('recourse_auxiliary_backup_mismatch');
}
