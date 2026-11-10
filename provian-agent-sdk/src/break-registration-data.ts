import { AbiCoder, sha256 } from 'ethers';
import { parseBreakDeploymentRequest, type BreakDeploymentRequest } from './break-deployment-data';

export interface BreakRegistrationRequest { readonly deployment: BreakDeploymentRequest; readonly kernel: string; }
export function parseBreakRegistration(value: unknown): BreakRegistrationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('break_registration_invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'deployment,kernel' || typeof row.kernel !== 'string'
    || !/^0x[0-9a-f]{40}$/.test(row.kernel) || /^0x0+$/.test(row.kernel)) throw Error('break_registration_invalid');
  return { deployment: parseBreakDeploymentRequest(row.deployment), kernel: row.kernel };
}
export function breakRegistrationId(request: BreakRegistrationRequest): string {
  return sha256(AbiCoder.defaultAbiCoder().encode(['string','address','bytes32','bytes32'],
    ['Provian break owner registration', request.kernel, request.deployment.identity, request.deployment.commitment]));
}
