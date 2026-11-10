import { AbiCoder, Interface, sha256 } from 'ethers';

export const HASH_ACCOUNT_ABI = new Interface([
  'function keyCommitment() view returns(bytes32)', 'function nonce() view returns(uint256)',
  'function intentDigest(address,uint256,uint256,bytes,bytes32) view returns(bytes32)',
  'function signatureDigest(bytes32) view returns(bytes32)',
  'function isValidSignature(bytes32,bytes) view returns(bytes4)',
  'function execute(address,uint256,uint256,bytes,bytes32,bytes,bytes) returns(bool)',
  'event Executed(uint256 indexed nonce,address indexed target,bool success)',
]);
export interface HashAccountIntent {
  readonly chainId: string; readonly account: string; readonly nonce: string;
  readonly target: string; readonly value: string; readonly callGas: string;
  readonly data: string; readonly nextCommitment: string;
}
export interface SignedHashAccountOperation extends HashAccountIntent {
  readonly signingRoot: string; readonly publicKey: string; readonly signature: string;
}
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const zero = /^0x0+$/;
export function hashAccountContractDigest(account: string, commitment: string, digest: string): string {
  if (!address.test(account) || zero.test(account) || !hash.test(commitment) || zero.test(commitment) || !hash.test(digest)) {
    throw new Error('hash_account_message_invalid');
  }
  return sha256(AbiCoder.defaultAbiCoder().encode(['string', 'uint256', 'address', 'bytes32', 'bytes32'],
    ['Provian hash account signature', 8453, account, commitment, digest]));
}
function uint(value: string): boolean { return /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < 2n ** 256n; }
export function hashAccountIntentDigest(intent: HashAccountIntent): string {
  if (![intent.account, intent.target].every(v => address.test(v) && !zero.test(v))
    || ![intent.chainId, intent.nonce, intent.value, intent.callGas].every(uint)
    || intent.chainId !== '8453' || BigInt(intent.callGas) === 0n
    || !/^0x(?:[0-9a-f]{2})*$/.test(intent.data) || !hash.test(intent.nextCommitment) || zero.test(intent.nextCommitment)) {
    throw new Error('hash_account_intent_invalid');
  }
  return sha256(AbiCoder.defaultAbiCoder().encode(
    ['string', 'uint256', 'address', 'uint256', 'address', 'uint256', 'uint256', 'bytes32', 'bytes32'],
    ['Provian hash account', intent.chainId, intent.account, intent.nonce, intent.target, intent.value,
      intent.callGas, sha256(intent.data), intent.nextCommitment]));
}
export function hashAccountCall(operation: SignedHashAccountOperation): string {
  hashAccountIntentDigest(operation);
  if (!hash.test(operation.publicKey) || !hash.test(operation.signingRoot)
    || sha256(operation.publicKey) !== operation.signingRoot || operation.signingRoot === operation.nextCommitment
    || !/^0x[0-9a-f]{15712}$/.test(operation.signature)) throw new Error('hash_account_signature_invalid');
  return HASH_ACCOUNT_ABI.encodeFunctionData('execute', [operation.target, operation.value, operation.callGas,
    operation.data, operation.nextCommitment, operation.publicKey, operation.signature]);
}
export function parseSignedHashAccountOperation(value: unknown): SignedHashAccountOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('hash_account_signature_invalid');
  const row = value as Record<string, unknown>;
  const fields = ['chainId','account','nonce','target','value','callGas','data','nextCommitment','signingRoot','publicKey','signature'];
  if (Object.keys(row).length !== fields.length || fields.some(field => typeof row[field] !== 'string')) throw Error('hash_account_signature_invalid');
  const operation = row as unknown as SignedHashAccountOperation;
  hashAccountCall(operation); return operation;
}
/** Consumes already independently verified canonical receipt logs. A successful
 * transaction alone does not prove the target action succeeded. */
export function hashAccountOutcome(operation: SignedHashAccountOperation,
  logs: readonly { address: string; topics: readonly string[]; data: string }[]): 'succeeded' | 'target_failed' {
  const topic = HASH_ACCOUNT_ABI.getEvent('Executed')!.topicHash;
  const matches = logs.filter(log => log.address.toLowerCase() === operation.account && log.topics[0] === topic)
    .map(log => HASH_ACCOUNT_ABI.parseLog({ topics: [...log.topics], data: log.data })!)
    .filter(log => log.args.nonce === BigInt(operation.nonce) && String(log.args.target).toLowerCase() === operation.target);
  if (matches.length !== 1) throw new Error('hash_account_execution_missing');
  return matches[0].args.success ? 'succeeded' : 'target_failed';
}
