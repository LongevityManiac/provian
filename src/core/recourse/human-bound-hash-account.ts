import { ZeroAddress } from 'ethers';
import type { OwnerChainNetwork } from './owner-chain';
import { readOwnerChainState } from './owner-chain';
import { readBreakRecoveryContext } from './break-recovery';
import { discoverHashAccount } from './hash-account-deployment';
import { humanBreakKey, type HumanBreakKeyContext } from './human-secret';
import { recoveryCommitment, recoverySigningRoot } from './hash-authorization';

export interface BoundHumanHashAccount {
  readonly identity: string; readonly evm: string; readonly recoveryGeneration: number; readonly recoveryCommitment: string;
  readonly manifestHash: string;
  readonly hashAccount: HumanBreakKeyContext & { readonly factory: string; readonly nonce: string; readonly accountGeneration: string };
}

/** Seed-only discovery works for a primary or auxiliary binding, including a
 * replacement after theft. No relay or primary-wallet selector chooses a key.
 * An account generation and its spending nonce are independent key domains. */
export async function discoverBoundHumanHashAccount(mnemonic: string, identity: string,
  network: OwnerChainNetwork): Promise<BoundHumanHashAccount> {
  if (!/^0x[0-9a-f]{64}$/.test(identity) || /^0x0+$/.test(identity)) throw Error('recourse_hash_identity_invalid');
  const breakOrigin = await readBreakRecoveryContext(network), owner = await readOwnerChainState(identity, network);
  if (owner.destination === ZeroAddress || !Number.isSafeInteger(owner.nonce) || owner.nonce < 1) throw Error('recourse_hash_account_not_restored');
  const base = { identity, breakOrigin, chainId: '8453' as const };
  // The first account predates its first authorization. Every later account
  // is named by its recovery authorization generation; search newest first.
  for (let generation = owner.nonce; generation >= 0; generation--) {
    const context = { ...base, accountGeneration: String(generation) };
    const initialSeed = humanBreakKey(mnemonic, context, 'spending', '0');
    let initialRoot: string;
    try { initialRoot = await recoverySigningRoot(initialSeed); } finally { initialSeed.fill(0); }
    const account = await discoverHashAccount(initialRoot, network, breakOrigin);
    if (account.manifestHash !== owner.deployment.manifestHash) throw Error('recourse_hash_account_state_changed');
    if (account.account !== owner.destination) continue;
    if (!account.deployed || account.nonce === null || account.currentRoot === null) throw Error('recourse_hash_account_not_deployed');
    const spendingSeed = humanBreakKey(mnemonic, context, 'spending', account.nonce);
    const recoverySecret = humanBreakKey(mnemonic, base, 'recovery-secret', String(owner.nonce));
    const recoverySeed = humanBreakKey(mnemonic, base, 'recovery-signing', String(owner.nonce));
    try {
      if (await recoverySigningRoot(spendingSeed) !== account.currentRoot) throw Error('recourse_hash_account_key_mismatch');
      const recoveryRoot = await recoverySigningRoot(recoverySeed);
      if (recoveryRoot !== owner.signingRoot || recoveryCommitment(recoverySecret, recoveryRoot) !== owner.commitment) throw Error('recourse_hash_account_recovery_mismatch');
    } finally { spendingSeed.fill(0); recoverySecret.fill(0); recoverySeed.fill(0); }
    const confirmed = await discoverHashAccount(initialRoot, network, breakOrigin), latest = await readOwnerChainState(identity, network);
    if (confirmed.manifestHash !== account.manifestHash || confirmed.account !== account.account
      || confirmed.currentRoot !== account.currentRoot || confirmed.nonce !== account.nonce
      || latest.deployment.manifestHash !== owner.deployment.manifestHash || latest.nonce !== owner.nonce
      || latest.commitment !== owner.commitment || latest.signingRoot !== owner.signingRoot || latest.destination !== owner.destination) {
      throw Error('recourse_hash_account_state_changed');
    }
    return { identity, evm: account.account, recoveryGeneration: owner.nonce, recoveryCommitment: owner.commitment,
      manifestHash: account.manifestHash, hashAccount: { ...context, factory: account.factory, nonce: account.nonce } };
  }
  throw Error('recourse_hash_account_backup_mismatch');
}
