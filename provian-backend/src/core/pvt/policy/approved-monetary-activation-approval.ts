/**
 * Scoped approval for the standard monetary activation document.
 *
 * The frozen Gate 1 manifest remains byte-identical. Its signing_permitted
 * field cannot be flipped to activate a rail: that would invalidate the
 * manifest hash. This module instead requires the frozen hash and a separately
 * signed authorization for pvt_policy_activations/monetary.
 *
 * monetaryApprovalSigningBytes serializes the exact approved scope and template
 * digest with a schema/scope domain separator. Signing the shared manifest
 * bytes here would replay a Genesis authorization into the monetary rail;
 * signing these distinct bytes prevents that cross-scope authority replay.
 *
 * Absent/malformed records, moved or rejected manifests, template drift,
 * policy-version or scope mismatch, automation-generated documents, missing or
 * mismatched trusted keys, unverifiable signatures and exceptions all refuse.
 */

import crypto from 'crypto';

import {
  approvalVerifierConfigFromEnv,
  verifySshApprovalSignature,
  type SshApprovalSignature,
  type SshApprovalVerifierConfig,
} from './approval-signature';
import {
  PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
  PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64,
} from './pvt9-approval-manifest.generated';
import { isRejectedPvtApprovalManifestSha256 } from './rejected-approval-manifests';
// Both from `proposed-monetary-policy`, NOT from the runtime rail. Importing the
// digest from the rail created a genuine cycle once the rail was wired to
// consult this module — and that cycle made this module unmockable from the
// rail's own suite, so the wiring control could not be written at all.
// moved the digest beside the template it hashes; the rail re-exports it.
import {
  PROPOSED_MONETARY_POLICY_TEMPLATE,
  hashProposedMonetaryPolicyTemplate,
} from './proposed-monetary-policy';

/**
 * SHA256 of the byte-frozen Gate 1 approval manifest — `check:wp2`'s
 * `frozenManifestSha256`. A PRECONDITION, not a bypass: this record is valid only
 * while that artifact is exactly these bytes. The suite recomputes it from the
 * embedded bytes, so this literal is never the only witness.
 */
export const BOUND_GATE1_MANIFEST_SHA256 =
  'sha256:704c1a2d9e555b56d9b4a5803b3f641b0e29e5e3012af0c0c3dc5ae665be6e71' as const;

/** The sentinel status meaning nothing is approved: no verdict surfaces under it. */
export const NO_MONETARY_ACTIVATION_APPROVED_STATUS =
  'no_monetary_activation_approved_yet' as const;

/**
 * Status for an activation record signed over this module's canonical scope.
 * A changed template remains on the nothing-approved sentinel until a fresh
 * signature binds its exact scope. The status cannot authorize unsigned bytes.
 */
export const APPROVED_MONETARY_ACTIVATION_STATUS =
  'monetary_activation_record_and_settlement_recorded' as const;

/**
 * SSHSIG over monetaryApprovalSigningBytes, domain-separated from Genesis.
 * The runtime verifies the namespace, the independently configured trusted
 * key digest, and the exact scope bytes. Trusting only the signature's own
 * embedded key would be circular and accept an arbitrary signer.
 * The signature includes the policy-template digest: changing any scope field
 * invalidates it and returns signature_not_verified with the rail closed.
 */
export const APPROVED_MONETARY_ACTIVATION_SIGNATURE: SshApprovalSignature = Object.freeze({
  "scheme": "sshsig-ed25519",
  "signer_identity": "frank",
  "namespace": "provian-pvt-policy",
  "public_key_sha256": "sha256:200b11f0842bdf578eeb2ebb4859c9fcd3ba870159e53d6747ffaff893462974",
  "armored_signature": "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgUB/0kKB7GhF3pkygXWgk4hLbmG\naio+uJRPGXPetVnp4AAAAScHJvdmlhbi1wdnQtcG9saWN5AAAAAAAAAAZzaGE1MTIAAABT\nAAAAC3NzaC1lZDI1NTE5AAAAQPkN2KqCVsoGMC4ESeIBos2+4LH3TN89ovYCBlamMHjJkF\nnYmOF32Yr7ShgvNn7W/8AszciNxZxDWOzooiZfnQw=\n-----END SSH SIGNATURE-----\n"
});

/**
 * The single approved scope. Every field is an EXACT equality the candidate
 * activation document must satisfy; none is a pattern, a range, or a default.
 */
export interface ApprovedMonetaryActivationScope {
  /** The monetary policy version this record authorizes, and no other. */
  readonly policy_version: string;
  /** The policy TEMPLATE digest this record authorizes, and no other. */
  readonly policy_template_sha256: string;
  /** The activation scope this record authorizes, and no other. */
  readonly activation_scope: 'record_and_settlement';
  /** The Gate 1 manifest digest this record is bound to. */
  readonly bound_gate1_manifest_sha256: string;
  /** The SSHSIG namespace and signer identity the signature must carry. */
  readonly sshsig_namespace: string;
  readonly signer_identity: string;
}

export interface ApprovedMonetaryActivationRecord {
  readonly schema_version: 'approved-monetary-activation-approval/v1';
  readonly scope: 'monetary_runtime_activation_document';
  /**
   * Widened to `string` on purpose: the sentinel record must be CONSTRUCTIBLE by
   * a test without a cast, or the self-gate becomes an unreachable branch.
   */
  readonly status: string;
  readonly approved: ApprovedMonetaryActivationScope;
}

/**
 * The approved scope. Policy version and template digest are READ from the
 * proposal template rather than copied, so a record that drifted from the
 * approved template is impossible to write by editing this file alone — the
 * "derive, never copy" rule the precedent adopted after a reviewer caught it
 * applied unevenly.
 */
export const APPROVED_MONETARY_ACTIVATION: ApprovedMonetaryActivationRecord = Object.freeze({
  schema_version: 'approved-monetary-activation-approval/v1',
  scope: 'monetary_runtime_activation_document',
  // The signed scope binds the canonical template and its action-policy matrix.
  // Unknown types record without minting until a named row is signed. Hardware
  // pricing requires an admitted scheme and a release-bound measured observer.
  // Deploy compatible code before changing the live activation documents;
  // both documents must bind the template digest computed by that code.
  status: APPROVED_MONETARY_ACTIVATION_STATUS,
  approved: Object.freeze({
    policy_version: PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion,
    /**
     * A getter, so a template edit is observed on every read rather than frozen
     * at import — the "derive, never copy" rule. (It was ALSO a cycle
     * workaround until moved the digest out of the runtime rail; that
     * reason is gone, this one stands on its own.)
     */
    get policy_template_sha256(): string {
      return hashProposedMonetaryPolicyTemplate();
    },
    activation_scope: 'record_and_settlement',
    bound_gate1_manifest_sha256: BOUND_GATE1_MANIFEST_SHA256,
    sshsig_namespace: 'provian-pvt-policy',
    signer_identity: 'frank',
  }),
});

/**
 * THE EXACT BYTES FRANK SIGNS.
 *
 * Deterministic, domain-separated, and derived from the scope rather than
 * restated: a newline-terminated field list prefixed by the schema version and
 * scope name. Domain separation is what makes a signature over these bytes
 * unusable for Genesis or any future scope, and vice versa.
 *
 * Exported so the signing handoff and the verifier compute the identical
 * message. The suite asserts they agree; nothing re-derives this by hand.
 */
export function monetaryApprovalSigningBytes(
  scope: ApprovedMonetaryActivationScope = APPROVED_MONETARY_ACTIVATION.approved,
): Buffer {
  const lines = [
    'provian-monetary-activation-approval/v1',
    'scope=monetary_runtime_activation_document',
    `policy_version=${scope.policy_version}`,
    `policy_template_sha256=${scope.policy_template_sha256}`,
    `activation_scope=${scope.activation_scope}`,
    `bound_gate1_manifest_sha256=${scope.bound_gate1_manifest_sha256}`,
    `sshsig_namespace=${scope.sshsig_namespace}`,
    `signer_identity=${scope.signer_identity}`,
  ];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/** Convenience digest of the signing bytes, for the handoff and for logging. */
export function monetaryApprovalSigningDigest(
  scope: ApprovedMonetaryActivationScope = APPROVED_MONETARY_ACTIVATION.approved,
): string {
  return `sha256:${crypto.createHash('sha256').update(monetaryApprovalSigningBytes(scope)).digest('hex')}`;
}

/**
 * The minimal shape this source judges. Deliberately NOT the runtime activation
 * document type: a narrow type would make several violating cases
 * unconstructible in a test, which is the "guard whose violating case cannot be
 * built" defect this WP keeps producing. The narrow type stays at the call site.
 */
export interface MonetaryActivationApprovalCandidate {
  readonly approval_signature: unknown;
  readonly policy_version: unknown;
  readonly policy_template_sha256: unknown;
  readonly activation_scope: unknown;
  readonly automation_generated: unknown;
  readonly effective_at_ms: unknown;
}

export interface ApprovedMonetaryActivationDeps {
  readonly record?: ApprovedMonetaryActivationRecord;
  readonly verifierConfig?: SshApprovalVerifierConfig | null;
  readonly verifySignature?: typeof verifySshApprovalSignature;
  /** Injectable frozen-manifest bytes; production uses the embedded frozen bytes. */
  readonly manifestBytes?: Buffer;
}

/** Every distinct way this source can refuse. `approved` is the only admit. */
export type ApprovedMonetaryActivationVerdict =
  | 'approved'
  | 'record_absent_or_malformed'
  | 'status_gates_everything'
  | 'frozen_manifest_moved'
  | 'manifest_digest_rejected'
  | 'policy_version_mismatch'
  | 'policy_template_drifted'
  | 'activation_scope_mismatch'
  | 'automation_generated_refused'
  | 'effective_instant_malformed'
  | 'signature_malformed'
  | 'verifier_key_not_configured'
  | 'signature_key_mismatch'
  | 'signature_not_verified'
  | 'threw';

/**
 * True while the record's status is the nothing-approved sentinel. Takes `status`
 * as a WIDENED `string` so TS cannot narrow the comparison to always-false and
 * turn the self-gate into an unreachable branch.
 */
function statusGatesEverything(status: string): boolean {
  return status === NO_MONETARY_ACTIVATION_APPROVED_STATUS;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecordWellFormed(record: unknown): record is ApprovedMonetaryActivationRecord {
  if (typeof record !== 'object' || record === null) return false;
  const r = record as Partial<ApprovedMonetaryActivationRecord>;
  if (r.schema_version !== 'approved-monetary-activation-approval/v1') return false;
  if (r.scope !== 'monetary_runtime_activation_document') return false;
  if (typeof r.status !== 'string' || r.status.length === 0) return false;
  const a = r.approved as Partial<ApprovedMonetaryActivationScope> | undefined;
  return typeof a === 'object' && a !== null
    && typeof a.policy_version === 'string' && a.policy_version.length > 0
    && typeof a.policy_template_sha256 === 'string' && a.policy_template_sha256.length > 0
    && a.activation_scope === 'record_and_settlement'
    && typeof a.bound_gate1_manifest_sha256 === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(a.bound_gate1_manifest_sha256)
    && typeof a.sshsig_namespace === 'string' && a.sshsig_namespace.length > 0
    && typeof a.signer_identity === 'string' && a.signer_identity.length > 0;
}

function isStructuredSignature(value: unknown): value is SshApprovalSignature {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<SshApprovalSignature>;
  return s.scheme === 'sshsig-ed25519'
    && typeof s.signer_identity === 'string'
    && typeof s.namespace === 'string'
    && typeof s.public_key_sha256 === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(s.public_key_sha256)
    && typeof s.armored_signature === 'string'
    && s.armored_signature.length > 0;
}

/**
 * Judge a candidate monetary activation document and return the NAMED verdict.
 * Ordered so each refusal is attributable to one conjunct. Every branch returns a
 * refusal except the final `approved`; any throw is caught into `threw`.
 */
export function explainApprovedMonetaryActivation(
  candidate: MonetaryActivationApprovalCandidate,
  deps: ApprovedMonetaryActivationDeps = {},
): ApprovedMonetaryActivationVerdict {
  try {
    // `deps.record ?? SHIPPED` would be FAIL-OPEN: an EXPLICITLY null record
    // would fall through `??` to the shipped record and admit. "Not supplied"
    // and "supplied as absent" are different facts; only the first falls back.
    // The precedent shipped this bug and its own control caught it.
    const record = Object.prototype.hasOwnProperty.call(deps, 'record')
      ? deps.record
      : APPROVED_MONETARY_ACTIVATION;
    if (!isRecordWellFormed(record)) return 'record_absent_or_malformed';
    if (statusGatesEverything(record.status)) return 'status_gates_everything';
    const scope = record.approved;

    // (1) THE FROZEN ARTIFACT MUST BE UNMOVED. Recomputed from the embedded
    //     bytes, so this is an observation rather than a claim.
    const manifestBytes = deps.manifestBytes
      ?? Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
    const liveDigest = `sha256:${crypto.createHash('sha256').update(manifestBytes).digest('hex')}`;
    if (liveDigest !== scope.bound_gate1_manifest_sha256
      || PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 !== scope.bound_gate1_manifest_sha256) {
      return 'frozen_manifest_moved';
    }
    if (isRejectedPvtApprovalManifestSha256(scope.bound_gate1_manifest_sha256)) {
      return 'manifest_digest_rejected';
    }

    // (2) THE DOCUMENT MUST BE THE ONE ARTIFACT THIS RECORD AUTHORIZES. The
    //     template digest is recomputed live, so a template edit invalidates the
    //     approval instead of silently riding along under it.
    if (candidate.policy_version !== scope.policy_version) return 'policy_version_mismatch';
    if (hashProposedMonetaryPolicyTemplate() !== scope.policy_template_sha256
      || candidate.policy_template_sha256 !== scope.policy_template_sha256) {
      return 'policy_template_drifted';
    }
    if (candidate.activation_scope !== scope.activation_scope) return 'activation_scope_mismatch';

    // (3) A GENERATED DOCUMENT IS NEVER AN APPROVAL. Activation is a human act.
    if (candidate.automation_generated !== false) return 'automation_generated_refused';
    if (!isSafeNonNegativeInteger(candidate.effective_at_ms)) return 'effective_instant_malformed';

    // (4) THE SIGNATURE MUST BE REAL, BY THE CONFIGURED KEY, OVER THIS MODULE'S
    //     OWN SCOPE BYTES — not over the shared frozen manifest. See the header:
    //     signing the shared bytes would let the Genesis signature replay here.
    if (!isStructuredSignature(candidate.approval_signature)) return 'signature_malformed';
    const signature = candidate.approval_signature;
    if (signature.namespace !== scope.sshsig_namespace
      || signature.signer_identity !== scope.signer_identity) {
      return 'signature_malformed';
    }
    const config = deps.verifierConfig === undefined
      ? approvalVerifierConfigFromEnv()
      : deps.verifierConfig;
    if (config === null) return 'verifier_key_not_configured';
    if (signature.public_key_sha256 !== config.publicKeySha256) return 'signature_key_mismatch';
    const verify = deps.verifySignature ?? verifySshApprovalSignature;
    if (!verify(monetaryApprovalSigningBytes(scope), signature, config)) {
      return 'signature_not_verified';
    }

    return 'approved';
  } catch {
    return 'threw';
  }
}

/**
 * The boolean the monetary rail consults. Admits only on the single `approved`
 * verdict, so a future verdict added to the union defaults to REFUSE.
 */
export function isApprovedMonetaryActivation(
  candidate: MonetaryActivationApprovalCandidate,
  deps: ApprovedMonetaryActivationDeps = {},
): boolean {
  return explainApprovedMonetaryActivation(candidate, deps) === 'approved';
}

/**
 * Fail-closed invariant on the SHIPPED record. Throws if the record is
 * malformed, if its bound digest is not the live frozen digest, or if its
 * template digest has drifted. Called by the suite; safe to call at boot.
 */
export function assertApprovedMonetaryActivationFailClosed(): void {
  const record = APPROVED_MONETARY_ACTIVATION;
  if (!isRecordWellFormed(record)) {
    throw new Error('approved-monetary-activation: shipped record is malformed');
  }
  const bytes = Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
  const liveDigest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  if (liveDigest !== record.approved.bound_gate1_manifest_sha256) {
    throw new Error('approved-monetary-activation: bound Gate 1 digest is not the live frozen digest');
  }
  if (hashProposedMonetaryPolicyTemplate() !== record.approved.policy_template_sha256) {
    throw new Error('approved-monetary-activation: policy template digest drifted');
  }
}
