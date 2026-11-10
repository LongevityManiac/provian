import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { concat, getBytes, sha256 } from 'ethers';
import { RECOURSE_COLLECTIONS } from './ownership';

export interface RecoursePrivateAuthorization {
  readonly version: 1; readonly identity: string; readonly commitment: string;
  readonly recoverySecret: string; readonly publicKey: string;
  readonly issuedAtMs: number; readonly signature: string;
}
export interface PrivateRecourseAccess { readonly identity: string; readonly path: string; readonly requestHash: string; }
const admitted = new WeakSet<PrivateRecourseAccess>();
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
  return `0x${createHash('sha256').update(canonical(request)).digest('hex')}`;
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
  return `0x${createHash('sha256').update(JSON.stringify([
    'provian.private-recourse-access.v1', 8453, 'POST', path, input.identity, input.commitment,
    sha256(input.publicKey), input.issuedAtMs, privateRecourseRequestHash(request),
  ])).digest('hex')}`;
}
type VerifyHashSignature = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => Promise<boolean>;
const verifyHashSignature: VerifyHashSignature = async (signature, message, publicKey) => {
  const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
  return slh_dsa_sha2_128s.verify(signature, message, publicKey);
};

export async function verifyRecoursePrivateAccess(db: Firestore, input: {
  readonly authorization: unknown; readonly path: string; readonly request?: unknown; readonly nowMs: number;
}): Promise<PrivateRecourseAccess> {
  const raw = input.authorization;
  requireValue(raw && typeof raw === 'object' && !Array.isArray(raw));
  const fields = raw as Record<string, unknown>;
  requireValue(Object.keys(fields).sort().join(',') === 'commitment,identity,issuedAtMs,publicKey,recoverySecret,signature,version'
    && fields.version === 1 && typeof fields.identity === 'string' && typeof fields.commitment === 'string'
    && typeof fields.recoverySecret === 'string' && typeof fields.publicKey === 'string'
    && typeof fields.issuedAtMs === 'number' && typeof fields.signature === 'string'
    && /^0x[0-9a-f]{15712}$/.test(fields.signature));
  const authorization: RecoursePrivateAuthorization = Object.freeze({ version: 1, identity: fields.identity,
    commitment: fields.commitment, recoverySecret: fields.recoverySecret, publicKey: fields.publicKey,
    issuedAtMs: fields.issuedAtMs, signature: fields.signature });
  const path = input.path, request = JSON.parse(canonical(input.request ?? null)) as unknown, nowMs = input.nowMs;
  const requestHash = privateRecourseRequestHash(request);
  const intent = privateRecourseIntent(authorization, path, request);
  requireValue(Number.isSafeInteger(nowMs) && authorization.issuedAtMs <= nowMs + 30_000
    && authorization.issuedAtMs >= nowMs - 300_000);
  requireValue(sha256(concat([authorization.recoverySecret, sha256(authorization.publicKey)])) === authorization.commitment);
  requireValue(await verifyHashSignature(getBytes(authorization.signature), getBytes(intent), getBytes(authorization.publicKey)));
  const [identity, historical] = await Promise.all([
    db.collection(RECOURSE_COLLECTIONS.identities).doc(authorization.identity).get(),
    db.collection(RECOURSE_COLLECTIONS.commitments).doc(`${authorization.identity}:${authorization.commitment}`).get(),
  ]);
  // Historical seeds deliberately retain read access so an original encrypted
  // backup can discover a completed recovery. Rotation is not read revocation.
  // This capability never substitutes for current owner-state write proofs.
  requireValue(identity.exists && identity.get('identity') === authorization.identity
    && (identity.get('recoveryCommitment') === authorization.commitment
      || (historical.exists && historical.get('identity') === authorization.identity
        && historical.get('commitment') === authorization.commitment)));
  const access = Object.freeze({ identity: authorization.identity, path, requestHash });
  admitted.add(access); return access;
}

export function assertRecoursePrivateAccess(access: PrivateRecourseAccess, expected: {
  readonly identity: string; readonly path: string; readonly request?: unknown;
}): void {
  // For operation-ID routes, expected.identity must come from the stored target
  // operation, never from the authorization body itself.
  requireValue(admitted.has(access) && access.identity === expected.identity && access.path === expected.path
    && access.requestHash === privateRecourseRequestHash(expected.request ?? null));
}
