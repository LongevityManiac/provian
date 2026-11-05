/**
 * activation — the Genesis runtime activation document: assembler + refusal explainer.
 *
 * WHY THIS MODULE EXISTS. `shouldPersistGenesisQualification` is a single
 * boolean over ~20 conjuncts spread across three modules. When it refuses there
 * is no way to tell WHICH conjunct refused, and the three possibilities have
 * completely different remedies:
 *
 * - the document is malformed → fix the document;
 * - the signature does not verify → sign with the configured key;
 * - the approval manifest is NOT → NO document and NO key can ever be
 * SIGNABLE accepted. A successor signable
 * approval manifest is required, which
 * moves `FROZEN_MANIFEST_SHA256` and is
 * the operator’s separate approval.
 *
 * The third case is indistinguishable from the second at the call sites, and
 * that ambiguity is exactly why the blocker was only found by probing. This
 * module makes the distinction executable, so an operator gets a named reason
 * instead of a silent `false`.
 *
 * NOTHING HERE WRITES, MINTS, SETTLES, OR SIGNS. It assembles plain data and
 * explains a refusal. The activation document is inert until a writer commits
 * it, and a writer must refuse to commit one that this module says is refused.
 */

import {
  hashGenesisCampaignPolicyManifest,
  validateGenesisCampaignActivation,
  verifyGenesisCampaignActivationApproval,
  type GenesisActivationApprovalVerifier,
  type GenesisCampaignActivation,
  type GenesisReservationDenyReason,
} from './policy/genesis-policy-engine';
import {
  PROPOSED_GENESIS_CAMPAIGN_POLICY,
} from './policy/proposed-genesis-policy';
import {
  PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS,
  PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
  PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED,
} from './policy/pvt9-approval-manifest.generated';
import { hashProposedMonetaryPolicyTemplate } from './policy/runtime-monetary-policy';
import {hasGenesisMonetaryBinding} from './policy/genesis-monetary-binding';
import type { SshApprovalSignature } from './policy/approval-signature';

/**
 * The approval status the signing rail requires. Bound to one module-scope
 * definition and referenced by both the explainer and its tests, rather than
 * re-declared in a test that would then assert its own construction.
 */
export const SIGNABLE_APPROVAL_STATUS = 'approvable_after_independent_review' as const;

/**
 * The canonical ledger namespace, READ FROM the approved manifest rather than
 * copied. Reviewer defect 3: a fresh `'pvt9_genesis_v1'` literal here was a
 * second copy of `PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.ledger_namespace`, and
 * nothing cross-checks the document's namespace against the manifest — so a
 * drifted copy assembles a document that admits, then denies every real grant
 * with `ledger_namespace_mismatch` against an existing wallet ledger.
 */
export const PVT9_GENESIS_LEDGER_NAMESPACE =
  PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.ledger_namespace;

export interface BuildGenesisActivationDocumentParams {
  /** the policy setter approval audit id. Canonical identifier. */
  readonly frankApprovalAuditId: string;
  /** The operator's activation audit id. Canonical identifier. */
  readonly operatorActivationAuditId: string;
  /** Canonical PVT manifest id recorded on the document. */
  readonly canonicalPvtManifestId: string;
  /**
   * SSHSIG over the EXACT approval-manifest bytes. `null` assembles the
   * complete UNSIGNED document — the dry-run shape, which by construction
   * cannot be accepted by any call site.
   */
  readonly approvalSignature: SshApprovalSignature | null;
  /** Defaults to the approved window start. */
  readonly effectiveAtMs?: number;
  readonly ledgerNamespace?: string;
}

/**
 * Assemble the exact 16-key activation document.
 *
 * Every hash and version is DERIVED from the single approved source, never
 * passed in: a caller that could supply `approved_policy_manifest_hash` could
 * bind the signature to a policy the relay is not running.
 */
export function buildGenesisActivationDocument(
  params: BuildGenesisActivationDocumentParams,
): GenesisCampaignActivation {
  const effectiveAtMs = params.effectiveAtMs
    ?? PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms;
  // `window.start_ms` is nullable in the manifest type (an unarmed window is
  // null), so a null here is a real condition and must not be assembled into a
  // document that would then be refused for an unexplained reason.
  if (typeof effectiveAtMs !== 'number'
    || !Number.isSafeInteger(effectiveAtMs)
    || effectiveAtMs < 0) {
    throw new Error('genesis_activation_effective_at_invalid');
  }
  return {
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
    approval_signature: params.approvalSignature,
    frank_approval_audit_id: params.frankApprovalAuditId,
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
    ),
    approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: effectiveAtMs,
    // An OPEN campaign carries no cutoff. Closing is a separate evented
    // operation (`closeGenesisAdmission`), never part of assembling the doc.
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: params.canonicalPvtManifestId,
    ledger_namespace: params.ledgerNamespace ?? PVT9_GENESIS_LEDGER_NAMESPACE,
    prior_reservations_reconciled: true,
    operator_activation_audit_id: params.operatorActivationAuditId,
  };
}

export type GenesisActivationRefusal =
  /** The gate admits. */
  | { readonly verdict: 'admits' }
  /** Kill switch set. Reversible: replace the document with the kill cleared. */
  | { readonly verdict: 'killed' }
  /** A structural/policy field is wrong. The reason names the failing class. */
  | { readonly verdict: 'malformed'; readonly reason: GenesisReservationDenyReason }
  /**
   * A well-formed hash that is not the REQUIRED hash. Separate from `malformed`
   * because `validateActivationStructure` only regex-checks these two fields;
   * the gate compares them itself (`genesis-award-state-machine.ts:419-421`), so
   * an explainer that skipped them would report `admits` on a document the gate
   * refuses. Reviewer defect 2.
   */
  | { readonly verdict: 'bound_hash_mismatch'; readonly field: 'approval_manifest_sha256' | 'approved_monetary_policy_template_hash' }
  /**
   * Everything except the approval layer is correct, and the approval manifest
   * itself declares that NO signature over it may be honoured. No key can help.
   */
  | {
    readonly verdict: 'manifest_non_signable';
    readonly signingPermitted: boolean;
    readonly approvalStatus: string;
    readonly requiredApprovalStatus: typeof SIGNABLE_APPROVAL_STATUS;
  }
  /** The manifest IS signable and everything else is correct: bad signature. */
  | { readonly verdict: 'signature_not_verified' };

export interface ExplainGenesisActivationOptions {
  /**
   * Injected so BOTH approval-layer branches are constructible. With these read
   * straight from the module constants, `signature_not_verified` is an
   * unreachable branch today — the "guard whose violating case cannot be
   * constructed" shape. The narrow production values stay the defaults.
   */
  readonly signingPermitted?: boolean;
  readonly approvalStatus?: string;
  readonly approvalVerifier?: GenesisActivationApprovalVerifier;
}

/**
 * Name the conjunct that refuses, in the order the gate evaluates it.
 *
 * The `manifest_non_signable` / `signature_not_verified` split is made by
 * isolating the approval layer: run the structural validation with an
 * always-true verifier. If that passes while the real verifier refuses, the
 * refusal is entirely in the approval layer, and the manifest's own signability
 * flags decide which of the two it is.
 */
export function explainGenesisActivationRefusal(
  activation: GenesisCampaignActivation,
  options: ExplainGenesisActivationOptions = {},
): GenesisActivationRefusal {
  const signingPermitted = options.signingPermitted
    ?? (PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED as boolean);
  const approvalStatus = options.approvalStatus
    ?? (PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS as string);
  const approvalVerifier = options.approvalVerifier
    ?? verifyGenesisCampaignActivationApproval;

  if (activation.genesis_kill_switch_active === true) return { verdict: 'killed' };

  // The gate's own equality conjuncts, which the structural validator does NOT
  // evaluate. Checked here in the gate's order so the isolation below is sound
  // relative to the GATE, not merely to validateActivationStructure.
  if (activation.approval_manifest_sha256 !== PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256) {
    return { verdict: 'bound_hash_mismatch', field: 'approval_manifest_sha256' };
  }
  if (!hasGenesisMonetaryBinding(activation)) {
    return { verdict: 'bound_hash_mismatch', field: 'approved_monetary_policy_template_hash' };
  }

  // Isolate the approval layer: everything EXCEPT signature verification.
  const structural = validateGenesisCampaignActivation(
    PROPOSED_GENESIS_CAMPAIGN_POLICY,
    activation,
    () => true,
  );
  if (structural !== null) return { verdict: 'malformed', reason: structural };

  if (approvalVerifier(activation)) return { verdict: 'admits' };

  if (!signingPermitted || approvalStatus !== SIGNABLE_APPROVAL_STATUS) {
    return {
      verdict: 'manifest_non_signable',
      signingPermitted,
      approvalStatus,
      requiredApprovalStatus: SIGNABLE_APPROVAL_STATUS,
    };
  }
  return { verdict: 'signature_not_verified' };
}

/** Human-readable one-liner for an operator CLI. */
export function describeGenesisActivationRefusal(
  refusal: GenesisActivationRefusal,
): string {
  switch (refusal.verdict) {
    case 'admits':
      return 'ADMITS — the persist gate accepts this document.';
    case 'killed':
      return 'REFUSED: genesis_kill_switch_active is true. Replace the document '
        + 'with the kill cleared to re-open (a field merge is not enough — see '
        + 'the writer notes on stale killed_at_ms/kill_reason keys).';
    case 'malformed':
      return `REFUSED: the document is structurally invalid (${refusal.reason}).`;
    case 'bound_hash_mismatch':
      return `REFUSED: ${refusal.field} is well formed but is not the required `
        + 'hash, so the document is bound to a policy the relay is not running.';
    case 'manifest_non_signable':
      return 'REFUSED STRUCTURALLY: the approval manifest declares itself '
        + `non-signable (signing_permitted=${refusal.signingPermitted}, `
        + `approval_status="${refusal.approvalStatus}", required `
        + `"${refusal.requiredApprovalStatus}"). Every other field of this `
        + 'document is correct and the signature is irrelevant: NO key and NO '
        + 'document can be accepted until a successor signable approval '
        + 'manifest exists. That moves FROZEN_MANIFEST_SHA256 and is the operator’s '
        + 'separate approval, not an engineering step.';
    case 'signature_not_verified':
      return 'REFUSED: the approval signature does not verify against the '
        + 'configured key over the exact approval-manifest bytes.';
    default: {
      const exhaustive: never = refusal;
      return String(exhaustive);
    }
  }
}
