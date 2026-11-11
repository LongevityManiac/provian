import { createHash } from 'crypto';
import { ethers } from 'ethers';
import type { AgentBankDeps } from '../agent-bank/types';
import { generateApiCredentialsAsync, verifyApiCredentialAsync } from '../agent-wallet/api-key';
import { prepareKeyRotationTransition, executeKeyRotationTransition, createHashRotationIdentity } from '../agent-wallet/key-rotation-transition';
import { identityHash, primaryBindingIdentity, recoveryHash, RECOURSE_COLLECTIONS, type RegisteredAddress } from './ownership';
import { createRecourseChainPort, type RecourseChainPort } from './chain-ledger';
import { currentProtocolDeployment } from '../protocol/runtime';
import { readAgreedBaseHead } from '../onchain/economic-discovery';
import { verifyRecoveryAuthorization } from './recovery-authorization';
import { verifyHashDestinationProof } from './hash-destination-proof';

export interface AgentRecoveryRequest {
  readonly kernel: string; readonly identity: string; readonly preimage: string; readonly destination: string;
  readonly nextCommitment: string; readonly nextSigningRoot: string; readonly requestId: string; readonly expiresAtMs: number;
  readonly authorizationTxHash: string; readonly authorizationNonce: number; readonly publicKey: string; readonly apiKey: string; readonly apiSecret: string; readonly signature: string;
  readonly destinationKind?: 'hash'; readonly breakDestinationRoot?: string;
}
const HASH = /^0x[0-9a-f]{64}$/;
export function parseAgentRecoveryRequest(value: unknown): AgentRecoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_recovery_request_invalid');
  const fields = ['kernel', 'identity', 'preimage', 'destination', 'nextCommitment', 'nextSigningRoot', 'requestId',
    'authorizationTxHash', 'publicKey', 'apiKey', 'apiSecret', 'signature'] as const;
  for (const field of fields) {
    if (!(field in value) || typeof Reflect.get(value, field) !== 'string') throw new Error('recourse_recovery_request_invalid');
  }
  if (!('authorizationNonce' in value) || typeof value.authorizationNonce !== 'number') throw new Error('recourse_recovery_request_invalid');
  if (!('expiresAtMs' in value) || typeof value.expiresAtMs !== 'number') throw new Error('recourse_recovery_request_invalid');
  const input = value as AgentRecoveryRequest;
  agentRecoveryMessage(input);
  if (!(input.destinationKind === 'hash' ? /^0x[0-9a-f]{15776}$/ : /^0x[0-9a-fA-F]{130}$/).test(input.signature)) throw new Error('recourse_destination_proof_invalid');
  return input;
}
export function agentRecoveryMessage(input: Omit<AgentRecoveryRequest, 'signature'>): string {
  if (!/^0x[0-9a-f]{40}$/.test(input.kernel) || !Number.isSafeInteger(input.authorizationNonce) || input.authorizationNonce < 0 || input.authorizationNonce >= Number.MAX_SAFE_INTEGER
    || !HASH.test(input.authorizationTxHash) || !HASH.test(input.identity) || !/^0x[0-9a-f]{128}$/.test(input.preimage) || !HASH.test(input.nextCommitment)
    || !HASH.test(input.nextSigningRoot) || !HASH.test(input.requestId) || !/^0x[0-9a-f]{40}$/.test(input.destination)
    || (input.destinationKind !== undefined && input.destinationKind !== 'hash')
    || (input.destinationKind === 'hash' ? input.publicKey !== `hash:${input.destination}` : !/^[0-9a-f]{128}$/.test(input.publicKey))
    || (input.breakDestinationRoot !== undefined && (input.destinationKind !== 'hash' || !HASH.test(input.breakDestinationRoot) || /^0x0+$/.test(input.breakDestinationRoot)))
    || !/^pvn_live_[0-9a-f]{32}$/.test(input.apiKey)
    || !/^pvns_[0-9a-f]{64}$/.test(input.apiSecret) || !Number.isSafeInteger(input.expiresAtMs)) {
    throw new Error('recourse_recovery_request_invalid');
  }
  const credentialHash = createHash('sha256').update(`${input.apiKey}:${input.apiSecret}`).digest('hex');
  const commitment = recoveryHash(Buffer.from(input.preimage.slice(2), 'hex'));
  return ['Provian agent ownership recovery', 'chain:8453', `kernel:${input.kernel}`,
    `identity:${input.identity}`, `recovery:${commitment}`, `destination:${input.destination}`,
    `next:${input.nextCommitment}`, `next-hash-authority:${input.nextSigningRoot}`, `public-key:${input.publicKey}`, `credentials:${credentialHash}`,
    `authorization:${input.authorizationTxHash}`, `authorization-nonce:${input.authorizationNonce}`, `request:${input.requestId}`, `expires:${input.expiresAtMs}`,
    ...(input.destinationKind === 'hash' ? ['destination-signature:hash'] : []),
    ...(input.breakDestinationRoot === undefined ? [] : [`break-destination-root:${input.breakDestinationRoot}`])].join('\n');
}

/** Recovery requires finalized owner hash authorization and fresh-key possession,
 * not the lost key, beneficiary relationship or a member-controlled verified bit.
 * The caller stages new credentials locally before making this request. */
export async function recoverAgentOwnership(deps: AgentBankDeps, input: AgentRecoveryRequest,
  chain: RecourseChainPort = createRecourseChainPort(), nowMs = Date.now(),
  readHead: () => Promise<number> = readAgreedBaseHead,
  verifyAuthorization: typeof verifyRecoveryAuthorization = verifyRecoveryAuthorization):
Promise<{ readonly walletId: string; readonly destination: string; readonly generation: number }> {
  const kernel = (await currentProtocolDeployment()).addresses.kernel.toLowerCase();
  const message = agentRecoveryMessage(input);
  if (input.expiresAtMs < nowMs || input.expiresAtMs > nowMs + 300_000) throw new Error('recourse_recovery_expired');
  try {
    if (input.destinationKind === 'hash') await verifyHashDestinationProof(input.destination,message,input.signature);
    else if (ethers.computeAddress(`0x04${input.publicKey}`).toLowerCase() !== input.destination
      || ethers.verifyMessage(message, input.signature).toLowerCase() !== input.destination) {
      throw new Error('invalid');
    }
  } catch { throw new Error('recourse_destination_proof_invalid'); }
  const owner = await deps.db.collection(RECOURSE_COLLECTIONS.identities).doc(input.identity).get();
  const walletId: unknown = owner.get('walletId');
  if (!owner.exists || owner.get('ownerType') !== 'agent' || typeof walletId !== 'string'
    || owner.get('ownerIdentity') !== identityHash('agent', walletId)
    || input.identity !== await primaryBindingIdentity(deps.db, { type: 'agent', id: walletId, walletId })) throw new Error('recourse_recovery_proof_invalid');
  const preimage = Buffer.from(input.preimage.slice(2), 'hex');
  try {
    const receipt = await deps.db.collection(RECOURSE_COLLECTIONS.recoveries).doc(input.requestId).get();
    if (receipt.exists) {
      const wallet = await deps.db.collection('agent_wallets').doc(walletId).get();
      if (receipt.get('authorizationTxHash') !== input.authorizationTxHash || receipt.get('identity') !== input.identity || receipt.get('destination') !== input.destination
        || receipt.get('nextCommitment') !== input.nextCommitment || receipt.get('nextSigningRoot') !== input.nextSigningRoot || receipt.get('consumedCommitment') !== recoveryHash(preimage)
        || wallet.get('address') !== input.destination || wallet.get('public_key') !== input.publicKey
        || !await verifyApiCredentialAsync(input.apiKey, input.apiSecret,
          String(wallet.get('api_key_hash')), String(wallet.get('api_key_salt')))) throw new Error('recourse_recovery_replay');
      return { walletId, destination: input.destination, generation: Number(receipt.get('generation')) };
    }
    // Admission is prospective at the observed head, never backdated to a
    // finalized proof block. Loss snapshots use finality separately.
    const block = await readHead();
    const blockHash = await chain.blockHash(block);
    if (!blockHash) throw new Error('recourse_admission_unavailable');
    const generation = owner.get('recoveryGeneration');
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
      throw new Error('recourse_recovery_generation_invalid');
    }
    const authorization = await verifyAuthorization({ kernel: input.kernel, currentKernel: kernel, identity: input.identity,
      destination: input.destination, consumedCommitment: recoveryHash(preimage),
      nextCommitment: input.nextCommitment, nextSigningRoot: input.nextSigningRoot,
      nonce: input.authorizationNonce, transactionHash: input.authorizationTxHash,
      ...(input.breakDestinationRoot === undefined ? {} : {breakDestinationRoot:input.breakDestinationRoot}) });
    if (authorization.generation !== input.authorizationNonce + 1) throw new Error('recourse_recovery_generation_invalid');
    // Destination ownership freshness is enforced by the atomic native/proven
    // address indexes below. A deposit to the publicly revealed new key must
    // never prevent its owner from completing recovery.
    const openingBalance = await chain.balance(kernel, input.destination, authorization.accountingBlockHash ?? authorization.blockHash);
    const credentials = await generateApiCredentialsAsync({ api_key: input.apiKey, api_secret: input.apiSecret });
    const newIdentity = input.destinationKind === 'hash' ? await createHashRotationIdentity({destination:input.destination,credentials,message,signature:input.signature})
      : { newAddress: input.destination, newPublicKey: input.publicKey, newApiCredentials: credentials };
    const plan = await prepareKeyRotationTransition({ db: deps.db, walletId, newIdentity,
      rotationId: `recourse_${input.requestId.slice(2)}`, now: nowMs, readBaseHead: async () => block });
    if (await chain.blockHash(block) !== blockHash) throw new Error('recourse_admission_reorg');
    const binding: RegisteredAddress = { identity: input.identity, ownerIdentity: identityHash('agent', walletId), address: input.destination, kernel,
      boundBlock: authorization.accountingBlock ?? authorization.block, boundAtMs: nowMs, boundBlockHash: authorization.accountingBlockHash ?? authorization.blockHash, openingBalanceAtomic: openingBalance.toString(),
      bindingDigest: ethers.hashMessage(message), recoveryGeneration: generation + 1, chainBindingStatus: 'confirmed', ledgerNeedsCatchup: true };
    await executeKeyRotationTransition(deps, plan, { binding, proof: { identity: input.identity, preimage,
      destination: input.destination, nextCommitment: input.nextCommitment, nextSigningRoot: input.nextSigningRoot, requestId: input.requestId, nowMs, authorizationTxHash: input.authorizationTxHash, authorization } });
    await deps.cache.del(`agent_wallet:${plan.expected.oldApiKeyPrefix}`).catch(() => {});
    return { walletId, destination: input.destination, generation: generation + 1 };
  } finally { preimage.fill(0); }
}
