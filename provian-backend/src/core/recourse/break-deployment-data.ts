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
