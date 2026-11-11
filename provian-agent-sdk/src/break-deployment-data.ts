import { AbiCoder, sha256 } from 'ethers';

export interface BreakDeploymentRequest {
  readonly kind: 'deploy'; readonly breakOrigin: string; readonly factory: string; readonly account: string;
  readonly initialRoot: string; readonly identity: string; readonly amount: string; readonly commitment: string;
  readonly proof: readonly string[]; readonly recoverySecret: string; readonly signingRoot: string;
  readonly publicKey: string; readonly signature: string;
}
export function breakDeploymentDigest(request: Pick<BreakDeploymentRequest,
  'breakOrigin' | 'factory' | 'account' | 'initialRoot' | 'identity' | 'amount' | 'commitment'>): string {
  return sha256(AbiCoder.defaultAbiCoder().encode(
    ['string', 'uint256', 'address', 'address', 'address', 'bytes32', 'bytes32', 'uint256', 'bytes32'],
    ['Provian break account deployment', 8453, request.breakOrigin, request.factory, request.account,
      request.initialRoot, request.identity, request.amount, request.commitment]));
}
export function parseBreakDeploymentRequest(value: unknown): BreakDeploymentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('break_deployment_request_invalid');
  const row = value as Record<string, unknown>;
  const fields = ['kind', 'breakOrigin', 'factory', 'account', 'initialRoot', 'identity', 'amount', 'commitment', 'proof',
    'recoverySecret', 'signingRoot', 'publicKey', 'signature'];
  if (Object.keys(row).length !== fields.length || fields.some(field => !(field in row)) || row.kind !== 'deploy'
    || !['breakOrigin', 'factory', 'account'].every(field => typeof row[field] === 'string' && /^0x[0-9a-f]{40}$/.test(row[field]) && !/^0x0+$/.test(row[field]))
    || !['initialRoot', 'identity', 'commitment', 'recoverySecret', 'signingRoot', 'publicKey'].every(field =>
      typeof row[field] === 'string' && /^0x[0-9a-f]{64}$/.test(row[field]))
    || [row.initialRoot, row.identity, row.commitment, row.signingRoot].some(field => /^0x0+$/.test(String(field)))
    || typeof row.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.amount) || BigInt(row.amount) >= 2n ** 256n
    || !Array.isArray(row.proof) || row.proof.length > 256 || !row.proof.every(value => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value))
    || typeof row.signature !== 'string' || !/^0x[0-9a-f]{15712}$/.test(row.signature)) throw Error('break_deployment_request_invalid');
  return { ...row, proof: [...row.proof] } as unknown as BreakDeploymentRequest;
}

/** A later theft uses the current independent owner authority, rather than a
 * historical break entitlement. The exact CREATE2 destination is signed. */
export interface ReplacementDeploymentRequest extends Omit<BreakDeploymentRequest, 'kind' | 'amount' | 'proof'> {
  readonly kind: 'replacement'; readonly kernel: string; readonly revision: string; readonly nonce: number;
}
export type AccountDeploymentRequest = BreakDeploymentRequest | ReplacementDeploymentRequest;
export function replacementDeploymentDigest(request: Omit<ReplacementDeploymentRequest, 'publicKey' | 'signature'>): string {
  return sha256(AbiCoder.defaultAbiCoder().encode(
    ['string', 'uint256', 'address', 'uint256', 'address', 'address', 'address', 'bytes32', 'bytes32', 'uint256', 'bytes32'],
    ['Provian replacement account deployment', 8453, request.kernel, request.revision, request.breakOrigin, request.factory,
      request.account, request.initialRoot, request.identity, request.nonce, request.commitment]));
}
export function accountDeploymentDigest(request: AccountDeploymentRequest): string {
  return request.kind === 'deploy' ? breakDeploymentDigest(request) : replacementDeploymentDigest(request);
}
export function parseAccountDeploymentRequest(value: unknown): AccountDeploymentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('break_deployment_request_invalid');
  const row = value as Record<string, unknown>;
  if (row.kind === 'deploy') return parseBreakDeploymentRequest(value);
  const fields = ['kind', 'breakOrigin', 'factory', 'account', 'initialRoot', 'identity', 'commitment', 'recoverySecret',
    'signingRoot', 'publicKey', 'signature', 'kernel', 'revision', 'nonce'];
  if (row.kind !== 'replacement' || Object.keys(row).length !== fields.length || fields.some(field => !(field in row))
    || typeof row.kernel !== 'string' || !/^0x[0-9a-f]{40}$/.test(row.kernel) || /^0x0+$/.test(row.kernel)
    || typeof row.revision !== 'string' || !/^[1-9][0-9]*$/.test(row.revision) || BigInt(row.revision) >= 2n ** 256n
    || typeof row.nonce !== 'number' || !Number.isSafeInteger(row.nonce) || row.nonce < 1 || row.nonce >= Number.MAX_SAFE_INTEGER) throw Error('break_deployment_request_invalid');
  // Reuse the existing exact common-material validation without accepting its
  // historical entitlement fields on this current-authority request.
  const { kernel: _kernel, revision: _revision, nonce: _nonce, ...common } = row;
  parseBreakDeploymentRequest({ ...common, kind: 'deploy', amount: '0', proof: [] });
  return { ...row } as unknown as ReplacementDeploymentRequest;
}
