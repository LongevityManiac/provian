import { sha256, toUtf8Bytes } from 'ethers';

export interface RecoursePrivateAuthorization {
  readonly version: 1; readonly identity: string; readonly commitment: string;
  readonly recoverySecret: string; readonly publicKey: string;
  readonly issuedAtMs: number; readonly signature: string;
}
const hash = /^0x[0-9a-f]{64}$/;
const privatePath = /^(?:owner-operations\/(?:recovery|0x[0-9a-f]{64})|break-(?:entitlements|recovery-state)\/0x[0-9a-f]{40}\/0x[0-9a-f]{64}|break-(?:deployments|registrations|restorations)(?:\/0x[0-9a-f]{64})?|break-restorations\/0x[0-9a-f]{64}\/receipt)$/;
function requireValue(value: unknown): asserts value {
  if (!value) throw Error('recourse_private_access_refused');
}
/** Stable JSON data only. Every payload byte-equivalent value is included in
 * the authorization; ambiguous JSON values and prototype keys are refused. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    requireValue(Number.isSafeInteger(value)); return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  requireValue(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  return `{${Object.keys(value).sort().map(key => {
    requireValue(!['__proto__', 'constructor', 'prototype'].includes(key));
    return `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`;
  }).join(',')}}`;
}
export function privateRecourseRequestHash(request: unknown = null): string {
  return sha256(toUtf8Bytes(canonical(request)));
}
export function copyPrivateRecourseRequest(request: unknown = null): unknown {
  return JSON.parse(canonical(request)) as unknown;
}
/** This signature domain is never valid for a chain operation. The disclosed
 * recovery preimage is not sufficient: private reads additionally require the
 * independent, undisclosed SLH-DSA signing seed. Authorization travels only in
 * the HTTPS request body, which the route must erase and exclude from logging. */
export function privateRecourseIntent(input: Omit<RecoursePrivateAuthorization, 'signature'>,
  path: string, request: unknown = null): string {
  requireValue(input.version === 1 && hash.test(input.identity) && hash.test(input.commitment)
    && hash.test(input.recoverySecret) && hash.test(input.publicKey)
    && Number.isSafeInteger(input.issuedAtMs) && input.issuedAtMs > 0 && privatePath.test(path));
  const targetIdentity = /^break-(?:entitlements|recovery-state)\/0x[0-9a-f]{40}\/(0x[0-9a-f]{64})$/.exec(path)?.[1];
  requireValue(targetIdentity === undefined || targetIdentity === input.identity);
  return sha256(toUtf8Bytes(JSON.stringify([
    'provian.private-recourse-access.v1', 8453, 'POST', path, input.identity, input.commitment,
    sha256(input.publicKey), input.issuedAtMs, privateRecourseRequestHash(request),
  ])));
}
