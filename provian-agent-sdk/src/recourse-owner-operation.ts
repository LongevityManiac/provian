import { AbiCoder, Interface, concat, sha256 } from 'ethers';

/** Public, exact-intent authorization. Only the recovery preimage is disclosed;
 * the independent hash-signature seed and wallet key never enter this object. */
export interface RestorationScope {
  readonly request: string; readonly lossHash: string; readonly maximumLoss: string;
}
export interface RecoveryOwnerOperation {
  readonly restoration?: RestorationScope;
  readonly kernel: string; readonly revision: string; readonly identity: string;
  readonly destination: string; readonly nonce: number;
  readonly proof: {
    readonly recoverySecret: string; readonly signingRoot: string;
    readonly nextCommitment: string; readonly nextSigningRoot: string;
    readonly publicKey: string; readonly signature: string;
  };
}
const hash = /^0x[0-9a-f]{64}$/;
const address = /^0x[0-9a-f]{40}$/;
const zero = /^0x0+$/;
export const OWNER_EXECUTOR_ABI = new Interface([
  'function execute(bytes32 identity,bytes32 operationHash,(bytes32 recoverySecret,bytes32 signingRoot,bytes32 nextCommitment,bytes32 nextSigningRoot,bytes publicKey,bytes signature) proof,bytes payload)',
  'function ownerAuthorizationNonce(bytes32) view returns(uint256)',
  'function previousAuthorization() view returns(address)',
  'function ownerRecoveryCommitment(bytes32) view returns(bytes32)',
  'function ownerSigningRoot(bytes32) view returns(bytes32)',
  'function ownerAuthorizationDigest(bytes32,bytes32,bytes32,bytes32) view returns(bytes32)',
]);
export const OWNER_KERNEL_ABI = new Interface([
  'function ownerAuthorization() view returns(address)', 'function restorationAuthority() view returns(address)', 'function operationalMinter() view returns(address)',
]);
export function recoveryOperationHash(identity: string, destination: string, restoration?: RestorationScope): string {
  if (!hash.test(identity) || zero.test(identity) || !address.test(destination) || zero.test(destination)) throw new Error('recourse_owner_operation_invalid');
  if (restoration) {
    parseRestorationScope(restoration);
    return sha256(AbiCoder.defaultAbiCoder().encode(['string', 'tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss)'],
      ['Provian bounded restoration intent', { ...restoration, identity, destination }]));
  }
  return sha256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32', 'address'], ['Provian ownership recovery', identity, destination]));
}
export function ownerOperationIntent(operation: RecoveryOwnerOperation): string {
  return sha256(AbiCoder.defaultAbiCoder().encode(
    ['string', 'uint256', 'address', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
    ['Provian restoration owner authorization', 8453, operation.kernel, operation.identity,
      sha256(concat([operation.proof.recoverySecret, operation.proof.signingRoot])), operation.nonce,
      recoveryOperationHash(operation.identity, operation.destination, operation.restoration), operation.proof.nextCommitment, operation.proof.nextSigningRoot]));
}
export function parseRestorationScope(value: unknown): RestorationScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_restoration_scope_invalid');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join(',') !== 'lossHash,maximumLoss,request'
    || typeof fields.request !== 'string' || !hash.test(fields.request) || zero.test(fields.request)
    || typeof fields.lossHash !== 'string' || !hash.test(fields.lossHash) || zero.test(fields.lossHash)
    || typeof fields.maximumLoss !== 'string' || !/^[1-9][0-9]*$/.test(fields.maximumLoss)
    || BigInt(fields.maximumLoss) >= 2n ** 256n) throw new Error('recourse_restoration_scope_invalid');
  return value as RestorationScope;
}
export function parseRecoveryOwnerOperation(value: unknown): RecoveryOwnerOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_owner_operation_invalid');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join(',') !== (fields.restoration === undefined ? 'destination,identity,kernel,nonce,proof,revision' : 'destination,identity,kernel,nonce,proof,restoration,revision')
    || typeof fields.kernel !== 'string' || !address.test(fields.kernel) || zero.test(fields.kernel)
    || typeof fields.destination !== 'string' || !address.test(fields.destination) || zero.test(fields.destination)
    || typeof fields.identity !== 'string' || !hash.test(fields.identity) || zero.test(fields.identity)
    || typeof fields.revision !== 'string' || !/^[1-9][0-9]*$/.test(fields.revision) || BigInt(fields.revision) >= 2n ** 256n
    || typeof fields.nonce !== 'number' || !Number.isSafeInteger(fields.nonce) || fields.nonce < 0 || fields.nonce >= Number.MAX_SAFE_INTEGER
    || !fields.proof || typeof fields.proof !== 'object' || Array.isArray(fields.proof)) throw new Error('recourse_owner_operation_invalid');
  if (fields.restoration !== undefined) parseRestorationScope(fields.restoration);
  const proof = fields.proof as Record<string, unknown>;
  if (Object.keys(proof).sort().join(',') !== 'nextCommitment,nextSigningRoot,publicKey,recoverySecret,signature,signingRoot'
    || !['recoverySecret', 'signingRoot', 'nextCommitment', 'nextSigningRoot', 'publicKey'].every(key => typeof proof[key] === 'string' && hash.test(proof[key] as string))
    || typeof proof.signature !== 'string' || !/^0x[0-9a-f]{15712}$/.test(proof.signature)) throw new Error('recourse_owner_operation_invalid');
  const operation = value as RecoveryOwnerOperation;
  if (sha256(operation.proof.publicKey) !== operation.proof.signingRoot
    || zero.test(operation.proof.nextCommitment) || zero.test(operation.proof.nextSigningRoot)
    || operation.proof.nextSigningRoot === operation.proof.signingRoot
    || operation.proof.nextCommitment === sha256(concat([operation.proof.recoverySecret, operation.proof.signingRoot]))) throw new Error('recourse_owner_operation_invalid');
  return operation;
}
/** Recovery or a bounded restoration intent only. Source selection, exact
 * reversal and reserve allocation use a separate evidence-checked executor. */
export function recoveryOperationCall(operation: RecoveryOwnerOperation): string {
  parseRecoveryOwnerOperation(operation);
  const coder = AbiCoder.defaultAbiCoder();
  const payload = operation.restoration
    ? coder.encode(['uint8', 'bytes'], [3, coder.encode(['tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss)', 'uint256'],
      [{ ...operation.restoration, identity: operation.identity, destination: operation.destination }, operation.revision])])
    : coder.encode(['uint8', 'bytes'], [2, coder.encode(['bytes32', 'address', 'uint256'], [operation.identity, operation.destination, operation.revision])]);
  return OWNER_EXECUTOR_ABI.encodeFunctionData('execute', [operation.identity,
    recoveryOperationHash(operation.identity, operation.destination, operation.restoration), operation.proof, payload]);
}
export function recoveryOperationId(operation: RecoveryOwnerOperation): string {
  // The on-chain intent fixes every consequence; a retransmission with another
  // valid encoding of the signature remains the same recovery operation.
  parseRecoveryOwnerOperation(operation);
  return sha256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32', 'uint256'],
    ['Provian queued owner operation', ownerOperationIntent(operation), operation.revision]));
}
