import { ethers } from 'ethers';
import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import { currentProtocolDeployment } from '../protocol/runtime';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId,
  AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION } from '../pvt/native-wallet-registration';
import { PROVEN_ADDRESSES_COLLECTION, HUMAN_PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { createRecourseChainPort, type RecourseChainPort } from './chain-ledger';
import { verifyRecoveryAuthorization } from './recovery-authorization';
import { verifyHashDestinationProof } from './hash-destination-proof';
import { ownedBindingIdentity, identityHash, recoveryHash, prepareRecoveryTransaction, RECOURSE_COLLECTIONS as R,
  type RecourseOwner, type PreparedRecovery, type RegisteredAddress } from './ownership';

export interface AuxiliaryRecoveryRequest {
  readonly kernel: string; readonly identity: string; readonly preimage: string; readonly destination: string;
  readonly nextCommitment: string; readonly nextSigningRoot: string; readonly requestId: string;
  readonly authorizationTxHash: string; readonly authorizationNonce: number;
  readonly expiresAtMs: number; readonly signature: string;
  readonly destinationKind?: 'hash'; readonly breakDestinationRoot?: string;
}
const hash = /^0x[0-9a-f]{64}$/, address = /^0x[0-9a-f]{40}$/;
export function auxiliaryRecoveryMessage(input: Omit<AuxiliaryRecoveryRequest, 'signature'>): string {
  if (![input.kernel, input.destination].every(v => typeof v === 'string' && address.test(v) && !/^0x0+$/.test(v))
    || ![input.identity, input.nextCommitment, input.nextSigningRoot, input.requestId, input.authorizationTxHash]
      .every(v => typeof v === 'string' && hash.test(v) && !/^0x0+$/.test(v))
    || typeof input.preimage !== 'string' || !/^0x[0-9a-f]{128}$/.test(input.preimage)
    || !Number.isSafeInteger(input.expiresAtMs) || !Number.isSafeInteger(input.authorizationNonce)
    || input.authorizationNonce < 0 || input.authorizationNonce >= Number.MAX_SAFE_INTEGER
    || (input.destinationKind !== undefined && input.destinationKind !== 'hash')
    || (input.breakDestinationRoot !== undefined && (input.destinationKind !== 'hash'
      || !hash.test(input.breakDestinationRoot) || /^0x0+$/.test(input.breakDestinationRoot)))) throw Error('recourse_auxiliary_recovery_invalid');
  return ['Provian auxiliary ownership recovery', 'chain:8453', `kernel:${input.kernel}`, `identity:${input.identity}`,
    `recovery:${recoveryHash(Buffer.from(input.preimage.slice(2), 'hex'))}`, `destination:${input.destination}`,
    `next:${input.nextCommitment}`, `next-hash-authority:${input.nextSigningRoot}`,
    `authorization:${input.authorizationTxHash}`, `authorization-nonce:${input.authorizationNonce}`,
    `request:${input.requestId}`, `expires:${input.expiresAtMs}`,
    ...(input.destinationKind === 'hash' ? ['destination-signature:hash'] : []),
    ...(input.breakDestinationRoot === undefined ? [] : [`break-destination-root:${input.breakDestinationRoot}`])].join('\n');
}
export function parseAuxiliaryRecoveryRequest(value: unknown): AuxiliaryRecoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('recourse_auxiliary_recovery_invalid');
  const keys = ['kernel', 'identity', 'preimage', 'destination', 'nextCommitment', 'nextSigningRoot', 'requestId',
    'authorizationTxHash', 'authorizationNonce', 'expiresAtMs', 'signature'];
  if ('destinationKind' in value) keys.push('destinationKind');
  if ('breakDestinationRoot' in value) keys.push('breakDestinationRoot');
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw Error('recourse_auxiliary_recovery_invalid');
  const input = value as AuxiliaryRecoveryRequest;
  auxiliaryRecoveryMessage(input);
  if (typeof input.signature !== 'string' || !(input.destinationKind === 'hash'
    ? /^0x[0-9a-f]{15776}$/ : /^0x[0-9a-fA-F]{130}$/).test(input.signature)) throw Error('recourse_destination_proof_invalid');
  return input;
}
export interface AuxiliaryRecoveryPorts {
  readonly chain: RecourseChainPort;
  verify: typeof verifyRecoveryAuthorization;
  verifyHashDestination?: typeof verifyHashDestinationProof;
}

/** Register one independently authorized successor in the private portfolio.
 * No wallet login, native-wallet index, API credential or earning proof changes.
 * The primary binding has a separate credential-recovery transaction. */
export async function recoverAuxiliaryOwnership(deps: AgentBankDeps, owner: RecourseOwner, input: AuxiliaryRecoveryRequest,
  nowMs = Date.now(), ports: AuxiliaryRecoveryPorts = { chain: createRecourseChainPort(), verify: verifyRecoveryAuthorization }):
Promise<{ identity: string; destination: string; generation: number }> {
  const message = auxiliaryRecoveryMessage(input);
  if (input.expiresAtMs < nowMs || input.expiresAtMs > nowMs + 300000) throw Error('recourse_destination_proof_invalid');
  await ownedBindingIdentity(deps.db, owner, input.identity);
  const ownerIdentity = identityHash(owner.type, owner.id);
  const ref = (collection: string, id: string) => deps.db.collection(collection).doc(id);
  const bindingRef = ref(R.identities, input.identity), ownerRef = ref(R.owners, ownerIdentity);
  const bindingRow = await bindingRef.get();
  if (bindingRow.get('primaryBinding') !== false) throw Error('recourse_auxiliary_binding_required');
  if (input.destinationKind === 'hash') await (ports.verifyHashDestination ?? verifyHashDestinationProof)(input.destination, message, input.signature);
  else if (ethers.verifyMessage(message, input.signature).toLowerCase() !== input.destination) throw Error('recourse_destination_proof_invalid');
  const kernel = (await currentProtocolDeployment()).addresses.kernel.toLowerCase();
  const preimage = Buffer.from(input.preimage.slice(2), 'hex');
  try {
    const proof = { identity: input.identity, preimage, destination: input.destination, nextCommitment: input.nextCommitment,
      nextSigningRoot: input.nextSigningRoot, requestId: input.requestId, nowMs, authorizationTxHash: input.authorizationTxHash };
    const authorization = await ports.verify({ kernel: input.kernel, currentKernel: kernel, identity: input.identity,
      destination: input.destination, consumedCommitment: recoveryHash(preimage), nextCommitment: input.nextCommitment,
      nextSigningRoot: input.nextSigningRoot, nonce: input.authorizationNonce, transactionHash: input.authorizationTxHash,
      ...(input.breakDestinationRoot === undefined ? {} : { breakDestinationRoot: input.breakDestinationRoot }) });
    const baselineBlock = authorization.accountingBlock ?? authorization.block;
    const baselineHash = authorization.accountingBlockHash ?? authorization.blockHash;
    const balance = await ports.chain.balance(kernel, input.destination, baselineHash);
    const destinationRef = ref(R.addresses, input.destination);
    const replay = await ref(R.recoveries, input.requestId).get();
    if (replay.exists) {
      return await deps.db.runTransaction(async tx => {
        const [binding, portfolio, destination] = await Promise.all([tx.get(bindingRef), tx.get(ownerRef), tx.get(destinationRef)]);
        checkOwner(binding, portfolio);
        const prepared = await prepareRecoveryTransaction(deps.db, tx, { ...proof, authorization });
        if (!prepared.replay || destination.get('identity') !== input.identity || destination.get('ownerIdentity') !== ownerIdentity
          || destination.get('recoveryGeneration') !== prepared.generation || binding.get('recoveryGeneration') !== prepared.generation
          || binding.get('recoveryCommitment') !== input.nextCommitment || binding.get('signingRoot') !== input.nextSigningRoot) throw Error('recourse_auxiliary_replay_invalid');
        return { identity: input.identity, destination: input.destination, generation: prepared.generation };
      });
    }
    const addresses = await deps.db.collection(R.addresses).where('identity', '==', input.identity).get();
    const current = addresses.docs.filter(row => row.get('recoveryGeneration') === bindingRow.get('recoveryGeneration'));
    if (current.length !== 1 || current[0].get('chainBindingStatus') !== 'confirmed'
      || current[0].get('ownerIdentity') !== ownerIdentity) throw Error('recourse_auxiliary_binding_invalid');
    const previous = current[0], oldAddress: unknown = previous.get('address');
    if (typeof oldAddress !== 'string' || !address.test(oldAddress) || oldAddress === input.destination) throw Error('recourse_auxiliary_binding_invalid');
    if (await ports.chain.blockHash(baselineBlock) !== baselineHash) throw Error('recourse_admission_reorg');
    let prepared: PreparedRecovery | undefined;
    await generatePE(deps, { walletId: owner.walletId, agentId: owner.id, ownerType: owner.type,
      actorAddress: input.destination, walletAddress: input.destination, actionType: 'recovery_action',
      peIdOverride: `pe_auxiliary_recovery_${input.requestId.slice(2)}`, timestampOverride: nowMs,
      metadata: { recovery_kind: 'auxiliary_owner_recovery', old_address: oldAddress, new_address: input.destination,
        authorization_transaction: input.authorizationTxHash, recovery_request: input.requestId },
      atomicEntityPrecondition: async tx => {
        const [binding, portfolio, previousNow, ...occupied] = await Promise.all([
          tx.get(bindingRef), tx.get(ownerRef), tx.get(ref(R.addresses, oldAddress)),
          tx.get(ref(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId(input.destination))),
          tx.get(ref(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION, input.destination)),
          tx.get(ref(PROVEN_ADDRESSES_COLLECTION, input.destination)), tx.get(ref(HUMAN_PROVEN_ADDRESSES_COLLECTION, input.destination)),
        ]);
        checkOwner(binding, portfolio);
        if (occupied.some(row => row.exists) || previousNow.get('identity') !== input.identity
          || previousNow.get('ownerIdentity') !== ownerIdentity || previousNow.get('chainBindingStatus') !== 'confirmed'
          || previousNow.get('recoveryGeneration') !== binding.get('recoveryGeneration')
          || previousNow.get('bindingDigest') !== previous.get('bindingDigest')) throw Error('recourse_auxiliary_state_changed');
        prepared = await prepareRecoveryTransaction(deps.db, tx, { ...proof, authorization });
        if (prepared.replay) throw Error('recourse_auxiliary_state_changed');
      },
      atomicEntityWrite: tx => {
        if (!prepared) throw Error('recourse_auxiliary_state_missing');
        prepared.write(tx);
        const binding: RegisteredAddress = { identity: input.identity, ownerIdentity, address: input.destination, kernel,
          boundBlock: baselineBlock, boundBlockHash: baselineHash, boundAtMs: nowMs, openingBalanceAtomic: balance.toString(),
          bindingDigest: ethers.hashMessage(message), recoveryGeneration: prepared.generation,
          chainBindingStatus: 'confirmed', ledgerNeedsCatchup: true };
        tx.create(destinationRef, binding);
      },
    });
    if (!prepared) throw Error('recourse_auxiliary_state_missing');
    return { identity: input.identity, destination: input.destination, generation: prepared.generation };
  } finally { preimage.fill(0); }

  function checkOwner(binding: FirebaseFirestore.DocumentSnapshot, portfolio: FirebaseFirestore.DocumentSnapshot): void {
    if (!binding.exists || !portfolio.exists || binding.get('identity') !== input.identity
      || binding.get('ownerIdentity') !== ownerIdentity || binding.get('ownerType') !== owner.type
      || binding.get('ownerId') !== owner.id || binding.get('walletId') !== owner.walletId
      || binding.get('primaryBinding') !== false || portfolio.get('primaryBinding') === input.identity
      || portfolio.get('ownerType') !== owner.type || portfolio.get('ownerId') !== owner.id
      || portfolio.get('walletId') !== owner.walletId) throw Error('recourse_auxiliary_owner_changed');
  }
}
