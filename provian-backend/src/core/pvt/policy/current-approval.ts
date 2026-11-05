import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';

import {
  approvalVerifierConfigFromEnv,
  verifySshApprovalSignature,
  type SshApprovalSignature,
  type SshApprovalVerifierConfig,
} from './approval-signature';
import {
  PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS,
  PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
  PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED,
  PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64,
} from './pvt9-approval-manifest.generated';
import {
  GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256,
  genesisSettlementApprovalManifestBytes,
} from './genesis-settlement-approval-manifest';
import { isRejectedPvtApprovalManifestSha256 } from './rejected-approval-manifests';

export const PVT_APPROVAL_MANIFEST_BYTES_COLLECTION = 'pvt_approval_manifest_bytes';

export type ApprovalManifestBytesResolver = (
  approvalManifestSha256: string,
) => Promise<Buffer | null>;

export interface CanonicalApprovalManifestBytesDocument {
  readonly schema_version: 'pvt-approval-manifest-bytes/v1';
  readonly approval_manifest_sha256: string;
  readonly manifest_utf8_base64: string;
  readonly registered_at_ms: number;
  readonly registered_by: string;
}

export function approvalManifestSha256(bytes: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function embeddedCurrentManifestBytes(): Buffer {
  return Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
}

function decodeCanonicalBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8 * 1024 * 1024) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.toString('base64') === value ? bytes : null;
}

/** Resolve immutable exact bytes by hash; unknown/malformed registry rows fail closed. */
export async function resolveApprovalManifestBytesByHash(
  db: Firestore,
  approvalManifestHash: string,
): Promise<Buffer | null> {
  if (!/^sha256:[a-f0-9]{64}$/.test(approvalManifestHash)) return null;
  if (isRejectedPvtApprovalManifestSha256(approvalManifestHash)) return null;
  if (approvalManifestHash === PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256) {
    const bytes = embeddedCurrentManifestBytes();
    return approvalManifestSha256(bytes) === approvalManifestHash ? bytes : null;
  }
  // The Genesis settlement approval manifest is embedded for the same reason the
  // Gate 1 one is: so the epoch-zero pin never depends on a WRITABLE Firestore
  // registry row. This resolves BYTES only — `manifestPermitsSigning`, the SSHSIG
  // check, the embedded-subject match and the epoch-zero pin all still run
  // downstream, unchanged. It admits nothing on its own.
  if (approvalManifestHash === GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256) {
    const bytes = genesisSettlementApprovalManifestBytes();
    return approvalManifestSha256(bytes) === approvalManifestHash ? bytes : null;
  }
  const snap = await db.collection(PVT_APPROVAL_MANIFEST_BYTES_COLLECTION)
    .doc(approvalManifestHash.slice('sha256:'.length))
    .get();
  if (!snap.exists) return null;
  const doc = snap.data() as Partial<CanonicalApprovalManifestBytesDocument> | undefined;
  if (doc?.schema_version !== 'pvt-approval-manifest-bytes/v1'
    || doc.approval_manifest_sha256 !== approvalManifestHash
    || !Number.isSafeInteger(doc.registered_at_ms)
    || (doc.registered_at_ms ?? -1) < 0
    || typeof doc.registered_by !== 'string'
    || doc.registered_by.trim().length === 0) return null;
  const bytes = decodeCanonicalBase64(doc.manifest_utf8_base64);
  return bytes && approvalManifestSha256(bytes) === approvalManifestHash ? bytes : null;
}

function manifestPermitsSigning(bytes: Buffer): boolean {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    return parsed.schema_version === 'pvt9-policy-approval-manifest/v1'
      && parsed.approval_status === 'approvable_after_independent_review'
      && parsed.signing_permitted === true;
  } catch {
    return false;
  }
}

export async function verifyPvtManifestApprovalByHash(
  approvalManifestHash: string,
  signature: SshApprovalSignature,
  resolver: ApprovalManifestBytesResolver,
  verifierConfig: SshApprovalVerifierConfig | null = approvalVerifierConfigFromEnv(),
): Promise<boolean> {
  return (await resolveVerifiedPvtManifestApprovalBytesByHash(
    approvalManifestHash,
    signature,
    resolver,
    verifierConfig,
  )) !== null;
}

/** Returns the exact verified bytes so downstream economic consumers can
 * parse and bind the signed authorization semantics, not just trust a boolean
 * signature verdict. */
export async function resolveVerifiedPvtManifestApprovalBytesByHash(
  approvalManifestHash: string,
  signature: SshApprovalSignature,
  resolver: ApprovalManifestBytesResolver,
  verifierConfig: SshApprovalVerifierConfig | null = approvalVerifierConfigFromEnv(),
): Promise<Buffer | null> {
  if (isRejectedPvtApprovalManifestSha256(approvalManifestHash)) return null;
  if (verifierConfig === null) return null;
  const bytes = await resolver(approvalManifestHash);
  return bytes !== null
    && approvalManifestSha256(bytes) === approvalManifestHash
    && manifestPermitsSigning(bytes)
    && verifySshApprovalSignature(bytes, signature, verifierConfig)
    ? bytes
    : null;
}

export function verifyCurrentPvtManifestApproval(
  signature: SshApprovalSignature,
  verifierConfig: SshApprovalVerifierConfig | null = approvalVerifierConfigFromEnv(),
): boolean {
  const signingPermitted: boolean = PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED;
  if (isRejectedPvtApprovalManifestSha256(PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256)
    || !signingPermitted
    || String(PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS)
      !== 'approvable_after_independent_review'
    || verifierConfig === null) return false;
  const bytes = embeddedCurrentManifestBytes();
  const hash = approvalManifestSha256(bytes);
  return hash === PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256
    && verifySshApprovalSignature(bytes, signature, verifierConfig);
}
