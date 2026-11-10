import type { BiometricAction } from '../security/biometricAction';
import { assertBiometricAction } from '../security/biometricAction';
import { ownerChainNetwork } from '../protocol/runtime';
import { deriveHumanAccount, readHumanAccountSelection, discoverHumanHashAccountSelection } from './human-account';
import { humanBreakKey } from './human-secret';
import { signHashAccountMessage } from './hash-account';
import type { OwnerChainNetwork } from './owner-chain';

/** Returns null only for a protected curve selection. A present hash selection
 * must verify against chain before signing and never falls back to the seed's
 * curve key when verification fails. */
export async function signHumanHashDigest(mnemonic: string, destination: string, digest: string, action: BiometricAction,
  network: OwnerChainNetwork = ownerChainNetwork()): Promise<string | null> {
  assertBiometricAction(action);
  if (!/^0x[0-9a-f]{64}$/.test(digest)) throw Error('recourse_hash_message_invalid');
  const root = await deriveHumanAccount(mnemonic,0), selection = await readHumanAccountSelection(root.evm);
  if (selection?.kind !== 'hash') return null;
  const current = await discoverHumanHashAccountSelection(mnemonic, selection.hashAccount!.identity, selection.requestId, network);
  if (current.evm !== destination.toLowerCase()) throw Error('recourse_hash_message_destination_changed');
  const seed = humanBreakKey(mnemonic,current.hashAccount!,'spending',current.hashAccount!.nonce);
  try {
    assertBiometricAction(action);
    const signature = await signHashAccountMessage(current.evm,digest,seed);
    // Refuse a proof generated across an account/root or pointer transition.
    const confirmed = await discoverHumanHashAccountSelection(mnemonic,current.hashAccount!.identity,current.requestId,network);
    if (confirmed.evm !== current.evm || confirmed.hashAccount!.breakOrigin !== current.hashAccount!.breakOrigin
      || confirmed.hashAccount!.nonce !== current.hashAccount!.nonce) throw Error('recourse_hash_message_state_changed');
    assertBiometricAction(action); return signature;
  } finally { seed.fill(0); }
}
