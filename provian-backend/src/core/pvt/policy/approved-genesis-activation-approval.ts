/**
 * Approved Genesis activation approval source — the Genesis runtime activation
 * record.
 *
 * THE PRECEDENT. This mirrors `approved-pvt-cost-catalog.ts` exactly: a separate
 * checked-in approval module that BINDS the byte-frozen artifact's hash, leaves
 * that artifact untouched, and is deliberately NOT routed through the
 * signing-manifest rail. There, the frozen artifact is the proposal cost catalog
 * (`d1a5844c…`); here it is the Gate 1 approval manifest (`704c1a2d…`).
 *
 * WHAT IT DOES AND DOES NOT DO. It does NOT bypass the frozen manifest — it
 * REQUIRES it unmoved, and it requires a real ed25519 SSHSIG binding its hash and the exact
 * policy template, verified by the untouched `verifySshApprovalSignature`. What it
 * supplies is a second, narrowly scoped approval route for ONE artifact: the
 * Genesis runtime activation document for campaign `pvt9_genesis_v1`. It is not
 * a general `signing_permitted: true`, and it authorizes nothing else.
 *
 * WHAT IS DELIBERATELY UNTOUCHED. `current-approval.ts` is not modified by one
 * byte. `verifyCurrentPvtManifestApproval` keeps its `signing_permitted: false`
 * refusal for every existing caller, including the monetary-policy rail at
 * `runtime-monetary-policy.ts:118`, which never imports this module and
 * therefore cannot reach it. `manifestPermitsSigning` is untouched.
 * `FROZEN_MANIFEST_SHA256` does not move; this module asserts it has not.
 *
 * FAIL-CLOSED IN EVERY DIRECTION. Absent record, malformed entry, campaign-id
 * mismatch, manifest-id mismatch, moved frozen hash, missing/mismatched key,
 * out-of-window effective instant, unverifiable signature, a rejected manifest
 * digest, or ANY throw all refuse. There is no default-admit branch: the verdict
 * is a conjunction and every conjunct must hold.
 */

import crypto from 'crypto';
export const BOUND_GENESIS_TEMPLATE_SHA256 = 'sha256:8a6390074ac8d6d1530105f473fe0df142e7f1494cb7b23b67ad20720022ac39';

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
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './proposed-genesis-policy';

/**
 * SHA256 of the byte-frozen Gate 1 approval manifest — `check:wp2`'s
 * `frozenManifestSha256`, and the sha256 of
 * `docs/audit/pvt-wp0-wp1/pvt-policy-approval-manifest.generated.json`.
 *
 * This is a PRECONDITION, not a bypass: the record below is valid only while the
 * frozen artifact is exactly these bytes. The accompanying test recomputes it
 * from the file on disk AND from the embedded bytes the signature is taken over,
 * and fails if either drifts — so this literal can never be the only witness.
 */
export const BOUND_GATE1_MANIFEST_SHA256 =
  'sha256:704c1a2d9e555b56d9b4a5803b3f641b0e29e5e3012af0c0c3dc5ae665be6e71' as const;

/** The sentinel status meaning nothing is approved: no verdict surfaces under it. */
export const NO_GENESIS_ACTIVATION_APPROVED_STATUS =
  'no_genesis_activation_approved_yet' as const;

/** This record's status: the one Genesis activation the operator has ratified. */
export const APPROVED_GENESIS_ACTIVATION_STATUS =
  'genesis_activation_pvt9_genesis_v1_recorded' as const;

/**
 * The single approved scope. Every field is an EXACT equality the candidate
 * activation document must satisfy; none is a pattern, a range, or a default.
 */
export interface ApprovedGenesisActivationScope {
  /** The campaign this record authorizes, and no other. */
  readonly campaign_ledger_namespace: string;
  /** The canonical PVT manifest id this record authorizes, and no other. */
  readonly canonical_pvt_manifest_id: string;
  /** The approved window, in milliseconds. */
  readonly window_start_ms: number;
  readonly window_end_ms: number;
  /** The Gate 1 manifest digest this record is bound to. */
  readonly bound_gate1_manifest_sha256: string;
  /** The SSHSIG namespace and signer identity the signature must carry. */
  readonly sshsig_namespace: string;
  readonly signer_identity: string;
}

export interface ApprovedGenesisActivationRecord {
  readonly schema_version: 'approved-genesis-activation-approval/v1';
  readonly scope: 'genesis_runtime_activation_document';
  /**
   * Widened to `string` on purpose: the sentinel record must be CONSTRUCTIBLE by
   * a test without a cast, or the self-gate above becomes untestable.
   */
  readonly status: string;
  readonly approved: ApprovedGenesisActivationScope;
}

/**
 * The approved scope. The window is READ from the approved manifest rather than
 * copied, so a record that drifted from the window is impossible to write
 * by editing this file alone — the same "derive, never copy" rule the assembler
 * follows, and the defect class that has bitten this WP repeatedly.
 */
export const APPROVED_GENESIS_ACTIVATION: ApprovedGenesisActivationRecord = Object.freeze({
  schema_version: 'approved-genesis-activation-approval/v1',
  scope: 'genesis_runtime_activation_document',
  status: APPROVED_GENESIS_ACTIVATION_STATUS,
  approved: Object.freeze({
    campaign_ledger_namespace: PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.ledger_namespace,
    // READ from the approved manifest, not copied — the reviewer caught this as
    // the module's own "derive, never copy" rule applied unevenly. Same value
    // today; the point is that it cannot drift independently tomorrow.
    canonical_pvt_manifest_id:
      PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.canonical_pvt_manifest_id as string,
    window_start_ms: PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms as number,
    window_end_ms: PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms as number,
    bound_gate1_manifest_sha256: BOUND_GATE1_MANIFEST_SHA256,
    sshsig_namespace: 'provian-pvt-policy',
    signer_identity: 'frank',
  }),
});

export const APPROVED_GENESIS_ACTIVATION_SIGNATURE: SshApprovalSignature = Object.freeze({
  "scheme": "sshsig-ed25519",
  "signer_identity": "frank",
  "namespace": "provian-pvt-policy",
  "public_key_sha256": "sha256:200b11f0842bdf578eeb2ebb4859c9fcd3ba870159e53d6747ffaff893462974",
  "armored_signature": "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgUB/0kKB7GhF3pkygXWgk4hLbmG\naio+uJRPGXPetVnp4AAAAScHJvdmlhbi1wdnQtcG9saWN5AAAAAAAAAAZzaGE1MTIAAABT\nAAAAC3NzaC1lZDI1NTE5AAAAQHh3dn/GHW5Xdf7WnCHDy/WBJ5NSKBz5dCNQKFaSvcG4v8\nEhSIq+oWWNoBFp+ZBYHW6LnL7QA9J+89Tj6RophAE=\n-----END SSH SIGNATURE-----\n"
});

/** Domain-separated authorization of the campaign and the exact monetary template. */
export function genesisApprovalSigningBytes(scope: ApprovedGenesisActivationScope = APPROVED_GENESIS_ACTIVATION.approved): Buffer {
  return Buffer.from(JSON.stringify({
    schema_version: 'genesis-template-approval/v1',
    scope: 'genesis_runtime_activation_document',
    approved: scope,
    monetary_policy_template_sha256: BOUND_GENESIS_TEMPLATE_SHA256,
  }) + '\n', 'utf8');
}

/**
 * The minimal shape this source judges. Deliberately NOT
 * `GenesisCampaignActivation`: importing that type here would make this module
 * depend on the engine that consumes it, and — more importantly — a narrow type
 * would make several violating cases unconstructible in a test, which is the
 * "guard whose violating case cannot be built" defect this WP keeps producing.
 * The narrow type stays at the call site.
 */
export interface GenesisActivationApprovalCandidate {
  readonly approval_manifest_sha256: unknown;
  readonly approval_signature: unknown;
  readonly canonical_pvt_manifest_id: unknown;
  readonly ledger_namespace: unknown;
  readonly effective_at_ms: unknown;
}

export interface ApprovedGenesisActivationDeps {
  /** Injectable so a test can move the record without editing the shipped one. */
  readonly record?: ApprovedGenesisActivationRecord;
  /** Injectable verifier config; production resolves it from the environment. */
  readonly verifierConfig?: SshApprovalVerifierConfig | null;
  /** Injectable exact manifest bytes; production uses the embedded frozen bytes. */
  readonly manifestBytes?: Buffer;
  /** Injectable signature verifier; production uses the untouched SSHSIG verifier. */
  readonly verifySignature?: typeof verifySshApprovalSignature;
}

/** Every distinct way this source can refuse. `approved` is the only admit. */
export type ApprovedGenesisActivationVerdict =
  | 'approved'
  | 'record_absent_or_malformed'
  | 'status_gates_everything'
  | 'frozen_manifest_moved'
  | 'manifest_digest_rejected'
  | 'activation_manifest_digest_mismatch'
  | 'campaign_mismatch'
  | 'canonical_manifest_id_mismatch'
  | 'window_mismatch'
  | 'effective_instant_out_of_window'
  | 'signature_malformed'
  | 'verifier_key_not_configured'
  | 'signature_key_mismatch'
  | 'signature_not_verified'
  | 'threw';

/**
 * True while the record's status is the nothing-approved sentinel. Takes `status`
 * as a WIDENED `string` exactly as `approved-pvt-cost-catalog.ts` does — so TS
 * cannot narrow the comparison to always-false and turn the self-gate into an
 * unreachable branch. An unreachable guard is a guard that cannot fail.
 */
function statusGatesEverything(status: string): boolean {
  return status === NO_GENESIS_ACTIVATION_APPROVED_STATUS;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecordWellFormed(record: unknown): record is ApprovedGenesisActivationRecord {
  if (typeof record !== 'object' || record === null) return false;
  const r = record as Partial<ApprovedGenesisActivationRecord>;
  if (r.schema_version !== 'approved-genesis-activation-approval/v1') return false;
  if (r.scope !== 'genesis_runtime_activation_document') return false;
  if (typeof r.status !== 'string' || r.status.length === 0) return false;
  const a = r.approved as Partial<ApprovedGenesisActivationScope> | undefined;
  return typeof a === 'object' && a !== null
    && typeof a.campaign_ledger_namespace === 'string' && a.campaign_ledger_namespace.length > 0
    && typeof a.canonical_pvt_manifest_id === 'string' && a.canonical_pvt_manifest_id.length > 0
    && isSafeNonNegativeInteger(a.window_start_ms)
    && isSafeNonNegativeInteger(a.window_end_ms)
    && a.window_start_ms <= a.window_end_ms
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
 * Judge a candidate activation document against the approved Genesis record and
 * return the NAMED verdict.
 *
 * Ordered so each refusal is attributable to one conjunct. Every branch returns
 * a refusal except the final `approved`, and any throw is caught into `threw` —
 * there is no path that admits by omission.
 */
export function explainApprovedGenesisActivation(
  candidate: GenesisActivationApprovalCandidate,
  deps: ApprovedGenesisActivationDeps = {},
): ApprovedGenesisActivationVerdict {
  try {
    // `deps.record ?? SHIPPED` was FAIL-OPEN and my own control caught it: an
    // EXPLICITLY null record fell through `??` to the shipped record and
    // admitted. "Not supplied" and "supplied as absent" are different facts, and
    // only the first may fall back.
    const record = Object.prototype.hasOwnProperty.call(deps, 'record')
      ? deps.record
      : APPROVED_GENESIS_ACTIVATION;
    if (!isRecordWellFormed(record)) return 'record_absent_or_malformed';
    if (statusGatesEverything(record.status)) return 'status_gates_everything';
    const scope = record.approved;

    // (1) THE FROZEN ARTIFACT MUST BE UNMOVED. Recomputed from the exact bytes
    //     the signature is taken over, so this is an observation, not a claim.
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

    // (2) THE DOCUMENT MUST BE THE ONE ARTIFACT THIS RECORD AUTHORIZES.
    if (candidate.approval_manifest_sha256 !== scope.bound_gate1_manifest_sha256) {
      return 'activation_manifest_digest_mismatch';
    }
    if (candidate.ledger_namespace !== scope.campaign_ledger_namespace) {
      return 'campaign_mismatch';
    }
    if (candidate.canonical_pvt_manifest_id !== scope.canonical_pvt_manifest_id) {
      return 'canonical_manifest_id_mismatch';
    }

    // (3) THE WINDOW MUST BE THE APPROVED ONE, and the document's effective
    //     instant must sit inside it. Both halves matter: the first catches a
    //     record that drifted from the approved manifest, the second catches a
    //     document that is outside the window the record authorizes.
    const approvedStart = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms;
    const approvedEnd = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms;
    if (approvedStart !== scope.window_start_ms || approvedEnd !== scope.window_end_ms) {
      return 'window_mismatch';
    }
    if (!isSafeNonNegativeInteger(candidate.effective_at_ms)
      || candidate.effective_at_ms < scope.window_start_ms
      || candidate.effective_at_ms > scope.window_end_ms) {
      return 'effective_instant_out_of_window';
    }

    // (4) THE SIGNATURE MUST BE REAL, BY THE CONFIGURED KEY, OVER THE EXACT
    //     CAMPAIGN AND TEMPLATE. The frozen manifest is
    //     required, not bypassed.
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
    if (signature.public_key_sha256 !== config.publicKeySha256) {
      return 'signature_key_mismatch';
    }
    const verify = deps.verifySignature ?? verifySshApprovalSignature;
    if (!verify(genesisApprovalSigningBytes(scope), signature, config)) return 'signature_not_verified';

    return 'approved';
  } catch {
    return 'threw';
  }
}

/**
 * The boolean the Genesis engine consults. Admits only on the single `approved`
 * verdict, so a future verdict added to the union defaults to REFUSE.
 */
export function isApprovedGenesisActivation(
  candidate: GenesisActivationApprovalCandidate,
  deps: ApprovedGenesisActivationDeps = {},
): boolean {
  return explainApprovedGenesisActivation(candidate, deps) === 'approved';
}

/**
 * Fail-closed invariant on the SHIPPED record, mirroring the cost catalog's
 * `assertFailClosed`. Throws if the record is malformed, if its bound digest is
 * not the live frozen digest, or if its window has drifted from the approved
 * manifest. Called by the suite; safe to call at boot.
 */
export function assertApprovedGenesisActivationFailClosed(): void {
  const record = APPROVED_GENESIS_ACTIVATION;
  if (!isRecordWellFormed(record)) {
    throw new Error('approved-genesis-activation: shipped record is malformed');
  }
  const bytes = Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
  const liveDigest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  if (liveDigest !== record.approved.bound_gate1_manifest_sha256) {
    throw new Error('approved-genesis-activation: bound Gate 1 digest is not the live frozen digest');
  }
  if (PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms !== record.approved.window_start_ms
    || PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms !== record.approved.window_end_ms) {
    throw new Error('approved-genesis-activation: approved window drifted from the manifest');
  }
}
