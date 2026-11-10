import { AbiCoder, concat, sha256 } from 'ethers';
import { OWNER_EXECUTOR_ABI } from './owner-operation';

export interface BreakRestorationRequest { readonly kernel: string; readonly ownerIntent: string; readonly data: string; }
export const BREAK_RESTORATION_TUPLE = 'tuple(bytes32 identity,uint256 amount,bytes32 originalCommitment,address destination,bytes32 destinationKeyRoot,bytes32[] snapshotProof)';
const coder = AbiCoder.defaultAbiCoder(), hash = /^0x[0-9a-f]{64}$/, zero = /^0x0+$/;
export function breakRestorationId(request: BreakRestorationRequest): string {
  return sha256(coder.encode(['string','address','bytes32'], ['Provian break restoration request', request.kernel, request.ownerIntent]));
}
export function breakRestorationDetails(request: BreakRestorationRequest) {
  const operation = OWNER_EXECUTOR_ABI.parseTransaction({ data: request.data });
  if (!operation || operation.name !== 'execute'
    || OWNER_EXECUTOR_ABI.encodeFunctionData('execute', [...operation.args]) !== request.data) throw Error('break_restoration_invalid');
  const payload = coder.decode(['uint8','bytes'], operation.args.payload);
  if (payload[0] !== 1n || coder.encode(['uint8','bytes'], [...payload]) !== operation.args.payload) throw Error('break_restoration_invalid');
  const restored = coder.decode([BREAK_RESTORATION_TUPLE], payload[1])[0], proof = operation.args.proof;
  if (coder.encode([BREAK_RESTORATION_TUPLE], [restored]) !== payload[1]
    || restored.identity !== operation.args.identity || zero.test(restored.identity)
    || zero.test(restored.destination) || zero.test(restored.destinationKeyRoot) || restored.snapshotProof.length > 256
    || typeof proof.publicKey !== 'string' || !hash.test(proof.publicKey)
    || typeof proof.signature !== 'string' || !/^0x[0-9a-f]{15712}$/.test(proof.signature)
    || sha256(proof.publicKey) !== proof.signingRoot || zero.test(proof.nextCommitment) || zero.test(proof.nextSigningRoot)
    || sha256(concat([proof.recoverySecret, proof.signingRoot])) !== restored.originalCommitment) throw Error('break_restoration_invalid');
  return { identity: String(restored.identity), amount: BigInt(restored.amount).toString(), commitment: String(restored.originalCommitment),
    destination: String(restored.destination).toLowerCase(), destinationKeyRoot: String(restored.destinationKeyRoot),
    snapshotProof: [...restored.snapshotProof] as string[], operationHash: String(operation.args.operationHash),
    proof: { recoverySecret: String(proof.recoverySecret), signingRoot: String(proof.signingRoot), nextCommitment: String(proof.nextCommitment),
      nextSigningRoot: String(proof.nextSigningRoot), publicKey: String(proof.publicKey), signature: String(proof.signature) } };
}
export function parseBreakRestorationRequest(value: unknown): BreakRestorationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('break_restoration_invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'data,kernel,ownerIntent'
    || typeof row.kernel !== 'string' || !/^0x[0-9a-f]{40}$/.test(row.kernel) || zero.test(row.kernel)
    || typeof row.ownerIntent !== 'string' || !hash.test(row.ownerIntent) || zero.test(row.ownerIntent)
    || typeof row.data !== 'string' || row.data.length > 128 * 1024 || !/^0x(?:[0-9a-f]{2})+$/.test(row.data)) throw Error('break_restoration_invalid');
  const request = { kernel: row.kernel, ownerIntent: row.ownerIntent, data: row.data };
  breakRestorationDetails(request); return request;
}
