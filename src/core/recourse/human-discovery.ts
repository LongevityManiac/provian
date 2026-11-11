import { sha256, toUtf8Bytes } from 'ethers';
import { ownerChainNetwork } from '../protocol/runtime';
import { readOwnerChainState, type OwnerChainNetwork } from './owner-chain';
import { deriveHumanAccount, discoverHumanHashAccountSelection, type HumanAccountSelection } from './human-account';
import { discoverHumanIdentityHistory, discoverHistoricalCurveGeneration } from './human-break-history';
import { humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import { recoveryCommitment, recoverySigningRoot } from './hash-authorization';

/** An old backup selects its current account from the permanent pointer and
 * independent chain reads. Relay identity responses cannot select a signer. */
export async function discoverHumanAccount(mnemonic: string, network: OwnerChainNetwork = ownerChainNetwork()): Promise<{
  identity: string; selection: HumanAccountSelection | null;
} | null> {
  const root = await deriveHumanAccount(mnemonic, 0);
  const history = await discoverHumanIdentityHistory(mnemonic, network);
  if (!history) return null;
  const identity = history.identity;
  const state = await readOwnerChainState(identity, network);
  if (!/^0x0{40}$/.test(history.points[0].breakOrigin)) {
    if (/^0x0{40}$/.test(state.destination)) throw Error('recourse_break_restoration_required');
    const generation = await discoverHistoricalCurveGeneration(mnemonic, history, network);
    const requestId = sha256(toUtf8Bytes(JSON.stringify(['Provian recovered hash account', identity, history.points[0].breakOrigin, state.nonce, state.destination])));
    return { identity, selection: await discoverHumanHashAccountSelection(mnemonic, identity, requestId, network, generation) };
  }
  const secret = humanRecoverySecret(mnemonic, state.nonce, identity), seed = humanRecoverySigningSeed(mnemonic, state.nonce, identity);
  try {
    const signingRoot = await recoverySigningRoot(seed);
    if (state.signingRoot !== signingRoot || state.commitment !== recoveryCommitment(secret, signingRoot)) {
      throw new Error('recourse_backup_commitment_mismatch');
    }
  } finally { secret.fill(0); seed.fill(0); }
  if (state.nonce === 0) return { identity, selection: null };
  // Each spending-account transition advances at least one authorization nonce.
  // Determinations may advance the nonce without changing the spending account.
  for (let generation = state.nonce; generation >= 0; --generation) {
    const derived = generation === 0 ? root : await deriveHumanAccount(mnemonic, generation);
    if (derived.evm !== state.destination) continue;
    const current = await readOwnerChainState(identity, network);
    if (current.nonce !== state.nonce || current.commitment !== state.commitment || current.destination !== state.destination
      || current.deployment.manifestHash !== state.deployment.manifestHash) throw new Error('recourse_owner_state_changed');
    return { identity, selection: { rootAddress: root.evm, generation, ...derived, recoveryGeneration: state.nonce,
      recoveryCommitment: state.commitment,
      requestId: sha256(toUtf8Bytes(JSON.stringify(['Provian recovered account', identity, state.nonce, derived.evm]))) } };
  }
  throw new Error('recourse_backup_destination_mismatch');
}
