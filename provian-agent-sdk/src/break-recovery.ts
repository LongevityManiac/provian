import { AbiCoder, Interface, ZeroAddress, ZeroHash, concat, hexlify, keccak256, sha256 } from 'ethers';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import { OWNER_EXECUTOR_ABI } from './recourse-owner-operation';
import { recoveryCommitment, recoverySigningRoot, signRecoveryIntent } from './recourse-hash-authorization';

const coder = AbiCoder.defaultAbiCoder();
export const BREAK_RECOVERY_ABI = new Interface([
  'function ownerAuthorization() view returns(address)', 'function restorationAuthority() view returns(address)',
  'function kernel() view returns(address)', 'function breakOrigin() view returns(address)',
  'function predecessor() view returns(address)', 'function lastGoodBlock() view returns(uint256)',
  'function restorationRoot() view returns(bytes32)', 'function hashAccountCodeHash() view returns(bytes32)',
  'function restoredIdentity(bytes32) view returns(bool)', 'function keyCommitment() view returns(bytes32)',
  'function ownerRecoveryCommitment(bytes32) view returns(bytes32)', 'function ownerSigningRoot(bytes32) view returns(bytes32)',
  'function ownerAuthorizationNonce(bytes32) view returns(uint256)',
  'function ownerUsedSigningRoot(bytes32,bytes32) view returns(bool)',
  'function ownerUsedRecoveryCommitment(bytes32,bytes32) view returns(bool)',
  'function ownerAuthorizationDigest(bytes32,bytes32,bytes32,bytes32) view returns(bytes32)',
  'function registerBreakOwner(bytes32,uint256,bytes32,bytes32,bytes32[])',
]);
const abi = BREAK_RECOVERY_ABI;
const hash = /^0x[0-9a-f]{64}$/;
const address = /^0x[0-9a-f]{40}$/;
export interface BreakOwnerEntitlement {
  readonly identity: string;
  readonly amount: string;
  readonly commitment: string;
  readonly proof: readonly string[];
}
export interface BreakRecoveryBackup {
  readonly kernel: string;
  readonly identity: string;
  readonly destination: string;
  readonly destinationSigningSeed: Uint8Array;
  readonly nextRecoverySecret: Uint8Array;
  readonly nextRecoverySigningSeed: Uint8Array;
  readonly operationHash: string | null;
}
export interface PreparedBreakRecovery {
  readonly phase: 'register_owner' | 'restore_balance';
  readonly kernel: string;
  readonly executor: string;
  readonly authority: string;
  readonly manifestHash: string;
  readonly identity: string;
  readonly destination: string;
  readonly amount: string;
  /** Exact current-executor calldata; only restore_balance needs the separately
   * authenticated restoration authority. Registration can be sponsored by anyone. */
  readonly data: string;
  readonly ownerIntent: string | null;
}
/** Builds the actual two-stage free restoration from an authenticated last-good
 * entitlement. No old curve signature, relay authentication or membership is
 * involved. The destination must already be the deployed hash account whose
 * seed the owner possesses. Every replacement seed is durably encrypted before
 * a public recovery preimage or signature leaves this function. */
export interface BreakRecoveryInput {
  network: OwnerChainNetwork;
  entitlement: BreakOwnerEntitlement;
  /** Bind a durable journal to the exact cryptographic-break origin. */
  expectedBreakOrigin?: string;
  recoverySecret: Uint8Array;
  recoverySigningSeed: Uint8Array;
  destination: string;
  destinationSigningSeed: Uint8Array;
  nextRecoverySecret: Uint8Array;
  nextRecoverySigningSeed: Uint8Array;
  persistBeforePublishing(backup: BreakRecoveryBackup): Promise<void>;
}
export async function prepareBreakRecovery(input: BreakRecoveryInput): Promise<PreparedBreakRecovery> {
  const local: BreakRecoveryInput = { ...input, entitlement: { ...input.entitlement, proof: [...input.entitlement.proof] },
    recoverySecret: new Uint8Array(input.recoverySecret), recoverySigningSeed: new Uint8Array(input.recoverySigningSeed),
    destinationSigningSeed: new Uint8Array(input.destinationSigningSeed), nextRecoverySecret: new Uint8Array(input.nextRecoverySecret),
    nextRecoverySigningSeed: new Uint8Array(input.nextRecoverySigningSeed) };
  try { return await prepareCopiedBreakRecovery(local); }
  finally { for (const seed of [local.recoverySecret, local.recoverySigningSeed, local.destinationSigningSeed,
    local.nextRecoverySecret, local.nextRecoverySigningSeed]) seed.fill(0); }
}
async function prepareCopiedBreakRecovery(input: BreakRecoveryInput): Promise<PreparedBreakRecovery> {
  const e = input.entitlement;
  if (!hash.test(e.identity) || e.identity === ZeroHash || !hash.test(e.commitment) || e.commitment === ZeroHash
    || !/^(0|[1-9][0-9]*)$/.test(e.amount) || BigInt(e.amount) >= 2n ** 256n
    || !Array.isArray(e.proof) || e.proof.length > 256 || !e.proof.every(p => hash.test(p))
    || !address.test(input.destination) || input.destination === ZeroAddress
    || [input.recoverySecret, input.recoverySigningSeed, input.destinationSigningSeed,
      input.nextRecoverySecret, input.nextRecoverySigningSeed].some(seed => seed.length !== 32)) throw Error('break_recovery_input_invalid');
  const secrets = [hexlify(input.recoverySecret), hexlify(input.nextRecoverySecret)];
  if (secrets[0] === secrets[1] || [input.recoverySigningSeed, input.destinationSigningSeed, input.nextRecoverySigningSeed]
    .some(seed => secrets.includes(hexlify(seed)))) throw Error('break_recovery_material_not_independent');
  const deployment = await input.network.deployment();
  const kernel = deployment.addresses.kernel.toLowerCase();
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const agreed = async (method: string, params: readonly unknown[]): Promise<string> => {
    const values = await Promise.all(input.network.rpcs.map(rpc => rpc.request(method, params)));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('break_recovery_rpc_disagreement');
    return values[0];
  };
  const call = async (to: string, name: string, args: readonly unknown[] = []) => abi.decodeFunctionResult(name,
    await agreed('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, tag]))[0];
  const executor = String(await call(kernel, 'ownerAuthorization')).toLowerCase();
  if (executor === ZeroAddress || String(await call(executor, 'kernel')).toLowerCase() !== kernel) throw Error('break_recovery_executor_invalid');
  const origin = String(await call(executor, 'breakOrigin')).toLowerCase();
  if (input.expectedBreakOrigin !== undefined && (!address.test(input.expectedBreakOrigin) || origin !== input.expectedBreakOrigin)) throw Error('break_recovery_context_changed');
  if (origin === ZeroAddress || await call(executor, 'restoredIdentity', [e.identity])) throw Error('break_recovery_unavailable');
  const predecessor = String(await call(origin, 'predecessor')).toLowerCase();
  const block = BigInt(await call(origin, 'lastGoodBlock'));
  const root = String(await call(origin, 'restorationRoot'));
  let leaf = sha256(coder.encode(['string', 'address', 'uint256', 'bytes32', 'uint256', 'bytes32'],
    ['Provian restoration', predecessor, block, e.identity, e.amount, e.commitment]));
  for (const sibling of e.proof) leaf = sha256(concat(leaf < sibling ? [leaf, sibling] : [sibling, leaf]));
  const signingRoot = await recoverySigningRoot(input.recoverySigningSeed);
  if (leaf !== root || recoveryCommitment(input.recoverySecret, signingRoot) !== e.commitment) throw Error('break_recovery_entitlement_invalid');
  const destinationRoot = await recoverySigningRoot(input.destinationSigningSeed);
  const accountCodeHash = String(await call(executor, 'hashAccountCodeHash'));
  if (keccak256(await agreed('eth_getCode', [input.destination, tag])) !== accountCodeHash
    || String(await call(input.destination, 'keyCommitment')) !== destinationRoot) throw Error('break_recovery_destination_invalid');
  const authority = String(await call(kernel, 'restorationAuthority')).toLowerCase();
  if (keccak256(await agreed('eth_getCode', [authority, tag])) !== accountCodeHash) throw Error('break_recovery_authority_invalid');
  const nextSigningRoot = await recoverySigningRoot(input.nextRecoverySigningSeed);
  const nextCommitment = recoveryCommitment(input.nextRecoverySecret, nextSigningRoot);
  if (nextSigningRoot === signingRoot || nextCommitment === e.commitment
    || await call(executor, 'ownerUsedSigningRoot', [e.identity, nextSigningRoot])
    || await call(executor, 'ownerUsedRecoveryCommitment', [e.identity, nextCommitment])) throw Error('break_recovery_reused_material');
  const commitment = String(await call(executor, 'ownerRecoveryCommitment', [e.identity]));
  const base = { kernel, executor, authority, manifestHash: deployment.manifestHash,
    identity: e.identity, destination: input.destination, amount: e.amount };
  const persist = async (operationHash: string | null): Promise<void> => {
    const backup = { kernel, identity: e.identity, destination: input.destination,
      destinationSigningSeed: new Uint8Array(input.destinationSigningSeed), nextRecoverySecret: new Uint8Array(input.nextRecoverySecret),
      nextRecoverySigningSeed: new Uint8Array(input.nextRecoverySigningSeed), operationHash };
    try { await input.persistBeforePublishing(backup); }
    finally { backup.destinationSigningSeed.fill(0); backup.nextRecoverySecret.fill(0); backup.nextRecoverySigningSeed.fill(0); }
  };
  let result: PreparedBreakRecovery;
  if (commitment === ZeroHash) {
    await persist(null);
    result = { ...base, phase: 'register_owner', ownerIntent: null, data: abi.encodeFunctionData('registerBreakOwner',
      [e.identity, e.amount, hexlify(input.recoverySecret), signingRoot, e.proof]) };
  } else {
    if (commitment !== e.commitment || String(await call(executor, 'ownerSigningRoot', [e.identity])) !== signingRoot) throw Error('break_recovery_owner_changed');
    const nonce = BigInt(await call(executor, 'ownerAuthorizationNonce', [e.identity]));
    const operation = sha256(coder.encode(['string', 'bytes32', 'uint256', 'address', 'bytes32', 'address', 'uint256'],
      ['Provian cryptographic break', e.identity, e.amount, input.destination, destinationRoot, predecessor, block]));
    const intent = sha256(coder.encode(['string', 'uint256', 'address', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
      ['Provian restoration owner authorization', 8453, kernel, e.identity, commitment, nonce, operation, nextCommitment, nextSigningRoot]));
    if (String(await call(executor, 'ownerAuthorizationDigest', [e.identity, operation, nextCommitment, nextSigningRoot])) !== intent) throw Error('break_recovery_intent_mismatch');
    const signed = await signRecoveryIntent(input.recoverySigningSeed, intent, { reserve: async () => persist(operation) });
    const proof = { recoverySecret: hexlify(input.recoverySecret), signingRoot, nextCommitment, nextSigningRoot,
      publicKey: signed.publicKey, signature: signed.signature };
    const payload = coder.encode(['uint8', 'bytes'], [1, coder.encode([
      'tuple(bytes32 identity,uint256 amount,bytes32 originalCommitment,address destination,bytes32 destinationKeyRoot,bytes32[] snapshotProof)',
    ], [{ identity: e.identity, amount: e.amount, originalCommitment: e.commitment, destination: input.destination,
      destinationKeyRoot: destinationRoot, snapshotProof: e.proof }])]);
    result = { ...base, phase: 'restore_balance', ownerIntent: intent,
      data: OWNER_EXECUTOR_ABI.encodeFunctionData('execute', [e.identity, operation, proof, payload]) };
  }
  if ((await input.network.deployment()).manifestHash !== deployment.manifestHash) throw Error('break_recovery_protocol_changed');
  return result;
}

/** Stable across ordinary successor deployments, distinct for each actual
 * cryptographic break. A rolled-back snapshot may repeat an old commitment;
 * it must not reuse the local destination/key journal from an earlier break. */
export async function readBreakRecoveryContext(network: OwnerChainNetwork): Promise<string> {
  const deployment = await network.deployment();
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const call = async (to: string, name: string): Promise<string> => {
    const values = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_call', [{ to, data: abi.encodeFunctionData(name) }, tag])));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('break_recovery_rpc_disagreement');
    return String(abi.decodeFunctionResult(name, values[0])[0]).toLowerCase();
  };
  const kernel = deployment.addresses.kernel.toLowerCase(), executor = await call(kernel, 'ownerAuthorization');
  if (executor === ZeroAddress || await call(executor, 'kernel') !== kernel) throw Error('break_recovery_executor_invalid');
  const context = await call(executor, 'breakOrigin');
  if (!address.test(context) || context === ZeroAddress) throw Error('break_recovery_unavailable');
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw Error('break_recovery_protocol_changed');
  return context;
}
