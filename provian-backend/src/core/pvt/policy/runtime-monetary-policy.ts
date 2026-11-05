import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { ActionPolicyGateResolution } from './action-policy-gate';
import {
  MONETARY_ACCOUNTING_SCHEMA_VERSION,
  type ActionMonetaryPolicy,
  type MintDisposition,
  type MintReasonCode,
  type MonetaryPolicyVersion,
} from './monetary-accounting';
import {
  PROPOSED_MONETARY_POLICY_TEMPLATE,
  hashProposedMonetaryPolicyTemplate,
  canonicalPolicyJson,
} from './proposed-monetary-policy';
import { classAdmissionProfile, isWitnessClass, type WitnessClass } from './evidence-class';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './pvt9-approval-manifest.generated';
import {
  approvalVerifierConfigFromEnv,
  type SshApprovalSignature,
  type SshApprovalVerifierConfig,
} from './approval-signature';
import { verifyCurrentPvtManifestApproval } from './current-approval';
// One-directional: the approval source imports the template digest from
// `proposed-monetary-policy`, never from here, so this is not a cycle. See the
// note at the re-export below for why that mattered..
import {
  isApprovedMonetaryActivation,
  type ApprovedMonetaryActivationRecord,
} from './approved-monetary-activation-approval';

export const MONETARY_POLICY_ACTIVATION_COLLECTION = 'pvt_policy_activations';
export const MONETARY_POLICY_ACTIVATION_DOCUMENT = 'monetary';

export interface MonetaryPolicyActivationDocument {
  readonly schema_version: 'pvt-monetary-policy-activation/v1';
  readonly approval_status: 'approved_by_frank';
  readonly approval_manifest_sha256: string;
  readonly approval_signature: SshApprovalSignature;
  readonly policy_version: string;
  readonly policy_template_sha256: string;
  readonly effective_at_ms: number;
  readonly effective_until_ms: number | null;
  readonly activation_scope: 'record_and_settlement';
  readonly automation_generated: false;
  readonly activated_at_ms: number;
  readonly activated_by: string;
}

// `canonicalJson` and `hashProposedMonetaryPolicyTemplate` MOVED to
// `proposed-monetary-policy`, beside the template they hash. Keeping them here
// forced any module needing the digest to import this rail, which became a real
// import cycle once the rail was wired to consult the monetary approval source —
// and that cycle made the approval source unmockable from this module's own
// suite. Re-exported so every existing importer is unaffected.
export { hashProposedMonetaryPolicyTemplate } from './proposed-monetary-policy';


export function materializeProposedMonetaryPolicy(
  effectiveAtMs: number,
  effectiveUntilMs: number | null = null,
  policyVersion = PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion,
): MonetaryPolicyVersion {
  if (!Number.isSafeInteger(effectiveAtMs) || effectiveAtMs < 0) {
    throw new Error('monetary policy effective_at must be a non-negative safe integer');
  }
  if (effectiveUntilMs !== null
    && (!Number.isSafeInteger(effectiveUntilMs) || effectiveUntilMs <= effectiveAtMs)) {
    throw new Error('monetary policy effective_until must follow effective_at');
  }
  return Object.freeze({
    schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION,
    policyVersion,
    effectiveAtMs,
    effectiveUntilMs,
    basePointsAtomic: PROPOSED_MONETARY_POLICY_TEMPLATE.basePointsAtomic,
    attestationMultipliersBps: PROPOSED_MONETARY_POLICY_TEMPLATE.attestationMultipliersBps,
    evidencePricedAttestationMultipliersBps:
      PROPOSED_MONETARY_POLICY_TEMPLATE.evidencePricedAttestationMultipliersBps,
    linkageMultipliersBps: PROPOSED_MONETARY_POLICY_TEMPLATE.linkageMultipliersBps,
    evidenceClassBasesBps: PROPOSED_MONETARY_POLICY_TEMPLATE.evidenceClassBasesBps,
    actions: PROPOSED_MONETARY_POLICY_TEMPLATE.actions,
  });
}

export function isValidMonetaryPolicyActivation(
  value: unknown,
  verifierConfig: SshApprovalVerifierConfig | null = approvalVerifierConfigFromEnv(),
  // Test-only injection point (the ApprovedMonetaryActivationDeps.record
  // pattern): production callers omit it, so the SHIPPED approval record —
  // sentinel-gated while a template re-issue awaits the policy setter signature —
  // is always the one consulted at runtime.
  approvalRecord?: ApprovedMonetaryActivationRecord,
): value is MonetaryPolicyActivationDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  const signature = doc.approval_signature as Partial<SshApprovalSignature> | undefined;
  const structural = doc.schema_version === 'pvt-monetary-policy-activation/v1'
    && doc.approval_status === 'approved_by_frank'
    && doc.approval_manifest_sha256 === PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256
    && typeof signature === 'object'
    && signature !== null
    && signature.scheme === 'sshsig-ed25519'
    && typeof signature.signer_identity === 'string'
    && typeof signature.namespace === 'string'
    && typeof signature.public_key_sha256 === 'string'
    && typeof signature.armored_signature === 'string'
    && doc.policy_version === PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion
    && doc.policy_template_sha256 === hashProposedMonetaryPolicyTemplate()
    && typeof doc.effective_at_ms === 'number'
    && Number.isSafeInteger(doc.effective_at_ms)
    && doc.effective_at_ms >= 0
    && (doc.effective_until_ms === null
      || (typeof doc.effective_until_ms === 'number'
        && Number.isSafeInteger(doc.effective_until_ms)
        && doc.effective_until_ms > doc.effective_at_ms))
    && doc.activation_scope === 'record_and_settlement'
    && doc.automation_generated === false
    && typeof doc.activated_at_ms === 'number'
    && Number.isSafeInteger(doc.activated_at_ms)
    && typeof doc.activated_by === 'string'
    && doc.activated_by.trim().length > 0;
  if (!structural) return false;
  // TWO approval routes, and the document must satisfy at least one. Both are
  // fail-closed; this is a disjunction of authorizations, never of rigour.
  //
  // (a) The ORIGINAL rail, untouched: the frozen Gate 1 manifest itself permits
  //     signing. It returns false today because `signing_permitted` is false
  //     INSIDE the frozen bytes, and flipping it would move 704c1a2d -> 672cbd7b
  // and trip stop-list item 3. Left exactly as it was, so if that
  //     manifest is ever legitimately re-approved this path still works.
  //
  // (b) 's scoped route: a separately signed authorization for THIS one
  //     document, which REQUIRES the frozen manifest unmoved rather than
  //     bypassing it, and whose signature is over its own domain-separated scope
  //     bytes — so no other approval's signature can be replayed into it. It
  //     ships with the NOTHING-APPROVED sentinel and therefore admits nothing
  // until the operator signs.
  if (verifyCurrentPvtManifestApproval(signature as SshApprovalSignature, verifierConfig)) {
    return true;
  }
  return isApprovedMonetaryActivation(
    {
      approval_signature: doc.approval_signature,
      policy_version: doc.policy_version,
      policy_template_sha256: doc.policy_template_sha256,
      activation_scope: doc.activation_scope,
      automation_generated: doc.automation_generated,
      effective_at_ms: doc.effective_at_ms,
    },
    approvalRecord === undefined
      ? { verifierConfig }
      : { verifierConfig, record: approvalRecord },
  );
}

/** Same signed authorization, addressed by template for an overlapping deployment.
 * Canonical operational authority is never bypassed: every source byte, including
 * disable/bounds and operator metadata, must still equal the approved source.
 */
export interface StagedMonetaryActivation {
  readonly schema_version: 'pvt-monetary-activation-stage/v1';
  readonly source_sha256: string;
  readonly activation: MonetaryPolicyActivationDocument;
}
export function monetaryActivationStageDocument(): string {
  return `monetary-template-${hashProposedMonetaryPolicyTemplate().slice(7)}`;
}
export function monetaryActivationSourceHash(source: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalPolicyJson(source)).digest('hex')}`;
}
export function stageMonetaryActivation(
  source: MonetaryPolicyActivationDocument,
  activation: MonetaryPolicyActivationDocument,
): StagedMonetaryActivation {
  const carried = {...activation, policy_template_sha256: source.policy_template_sha256,
    approval_signature: source.approval_signature};
  if (monetaryActivationSourceHash(carried) !== monetaryActivationSourceHash(source)) {
    throw new Error('staged activation changed canonical operational fields');
  }
  return {schema_version:'pvt-monetary-activation-stage/v1',
    source_sha256:monetaryActivationSourceHash(source),activation};
}
export function selectMonetaryActivation(
  canonical: unknown, stage: unknown,
  verifierConfig: SshApprovalVerifierConfig | null = approvalVerifierConfigFromEnv(),
): unknown {
  if (isValidMonetaryPolicyActivation(canonical,verifierConfig)) return canonical;
  if (!canonical || typeof canonical !== 'object' || !stage || typeof stage !== 'object') return canonical;
  const candidate=stage as StagedMonetaryActivation;
  try {
    if(candidate.schema_version!=='pvt-monetary-activation-stage/v1'
      || candidate.source_sha256!==monetaryActivationSourceHash(canonical)
      || !isValidMonetaryPolicyActivation(candidate.activation,verifierConfig)) return canonical;
    // Source binding alone cannot authorize a stage with altered operational bounds.
    const expected=stageMonetaryActivation(canonical as MonetaryPolicyActivationDocument,candidate.activation);
    return expected.source_sha256===candidate.source_sha256?candidate.activation:canonical;
  } catch { return canonical; }
}
/** Return raw invalid canonical data for the existing alarm diagnostics. Only a
 * fully formed stale activation can consult its exact-template stage. Stage
 * selection rereads BOTH records in one transaction, so an operator change wins.
 */
const batchActivationReads = new WeakMap<Firestore, {
  selected?: Promise<unknown | undefined>;
  validated?: Promise<MonetaryPolicyActivationDocument | null>;
}>();

/** A pricing attempt shares raw signed activation selection, never a priced policy or timestamp. */
export function memoizeMonetaryActivationForBatch(db: Firestore): void {
  batchActivationReads.set(db, {});
}

export function readSelectedMonetaryActivation(db: Firestore): Promise<unknown | undefined> {
  const batch = batchActivationReads.get(db);
  if (!batch) return readSelectedMonetaryActivationFresh(db);
  return batch.selected ??= readSelectedMonetaryActivationFresh(db);
}

async function readSelectedMonetaryActivationFresh(db: Firestore): Promise<unknown | undefined> {
  const collection=db.collection(MONETARY_POLICY_ACTIVATION_COLLECTION);
  const ref=collection.doc(MONETARY_POLICY_ACTIVATION_DOCUMENT);
  const snap=await ref.get();
  if(!snap.exists)return undefined;
  const canonical:unknown=snap.data();
  if(isValidMonetaryPolicyActivation(canonical))return canonical;
  const raw=canonical as Partial<MonetaryPolicyActivationDocument> | null;
  if(!raw || raw.schema_version!=='pvt-monetary-policy-activation/v1'
    || raw.policy_template_sha256===hashProposedMonetaryPolicyTemplate())return canonical;
  const stageRef=collection.doc(monetaryActivationStageDocument());
  const stage=(await stageRef.get()).data();
  if(selectMonetaryActivation(canonical,stage)===canonical)return canonical;
  return db.runTransaction(async tx=>{
    const current=await tx.get(ref),staged=await tx.get(stageRef);
    return current.exists?selectMonetaryActivation(current.data(),staged.data()):undefined;
  });
}

function reasonForDisposition(disposition: MintDisposition): MintReasonCode {
  switch (disposition) {
    case 'eligible': return 'policy_eligible';
    case 'pending_evidence': return 'awaiting_evidence';
    case 'pending_review': return 'awaiting_review';
    case 'record_only': return 'policy_record_only';
    case 'ineligible_terminal': return 'policy_ineligible';
    case 'pending_compliance': return 'jurisdiction_unknown';
    case 'pending_cache': return 'cache_unavailable';
    case 'beneficiary_pending': return 'beneficiary_unresolved';
    case 'jurisdiction_deferred': return 'jurisdiction_deferred';
  }
}

function prospectiveAction(resolution: ActionPolicyGateResolution): ActionMonetaryPolicy | null {
  if (resolution.status !== 'classified_prospective') return null;
  return Object.freeze({
    category: resolution.category,
    baseWeightBps: resolution.baseActionWeightBps,
    policyOverrideBps: resolution.policyOverrideBps,
    mintDisposition: resolution.mintDisposition,
    mintReasonCode: reasonForDisposition(resolution.mintDisposition),
    policyReviewState: 'classified_prospective',
    policyReviewReasonCode: 'classification_approved_prospective',
    financialAttestationNeutral: resolution.financialAttestationNeutral,
    allowVerifiedAttestationUpgrade: resolution.allowVerifiedAttestationUpgrade,
    evidenceRequirement: resolution.evidenceRequirement,
    canonicalEventRequired: resolution.canonicalEventRequired,
    canonicalEventGroup: resolution.canonicalEventGroup,
    beneficialOwnershipPolicy: resolution.beneficialOwnershipPolicy,
    sessionLineagePolicy: resolution.sessionLineagePolicy,
    fixedGrantSource: resolution.fixedGrantSource,
    evidenceResolutionMode: resolution.evidenceResolutionMode,
  });
}

function inactiveRecordOnlyPolicy(): MonetaryPolicyVersion {
  return Object.freeze({
    schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION,
    policyVersion: 'pvt-monetary-policy-inactive-record-only/v1',
    effectiveAtMs: 0,
    effectiveUntilMs: null,
    basePointsAtomic: PROPOSED_MONETARY_POLICY_TEMPLATE.basePointsAtomic,
    attestationMultipliersBps: PROPOSED_MONETARY_POLICY_TEMPLATE.attestationMultipliersBps,
    evidencePricedAttestationMultipliersBps:
      PROPOSED_MONETARY_POLICY_TEMPLATE.evidencePricedAttestationMultipliersBps,
    linkageMultipliersBps: PROPOSED_MONETARY_POLICY_TEMPLATE.linkageMultipliersBps,
    // Inactive: no bases either — an unnamed type under an inactive policy stays record_only.
    actions: Object.freeze({}),
  });
}

/**
 * Select the immutable policy vintage at record time. Production requires a
 * signed, explicit activation document; a missing/malformed/not-yet-effective
 * activation fails closed to a zero-valued snapshot. Tests materialize the
 * policy directly so CI never needs mutable external state.
 */
export async function loadRuntimeMonetaryPolicy(
  db: Firestore,
  recordedAtMs: number,
  resolution: ActionPolicyGateResolution,
): Promise<MonetaryPolicyVersion> {
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) {
    throw new Error('recordedAtMs must be a non-negative safe integer');
  }

  // Unit/integration tests exercise the exact path without pretending to sign
  // an operator activation. This branch cannot run in a production process.
  if (process.env.NODE_ENV === 'test') {
    return withProspectiveAction(
      materializeProposedMonetaryPolicy(0),
      resolution,
    );
  }

  return loadActivatedRuntimeMonetaryPolicy(db, recordedAtMs, resolution);
}

/** The activated production path, also used by the emulator cost profile with shipped signed evidence. */
export async function loadActivatedRuntimeMonetaryPolicy(
  db: Firestore,
  recordedAtMs: number,
  resolution: ActionPolicyGateResolution,
): Promise<MonetaryPolicyVersion> {
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) {
    throw new Error('recordedAtMs must be a non-negative safe integer');
  }
  let activation: MonetaryPolicyActivationDocument | null = null;
  try {
    const validate = async (): Promise<MonetaryPolicyActivationDocument | null> => {
      const data = await readSelectedMonetaryActivation(db);
      if (!isValidMonetaryPolicyActivation(data)) return null;
      // Retain an immutable raw activation snapshot; no act timestamp or price is cached.
      return Object.freeze({ ...data, approval_signature: Object.freeze({ ...data.approval_signature }) });
    };
    const batch = batchActivationReads.get(db);
    activation = await (batch ? batch.validated ??= validate() : validate());
  } catch {
    return inactiveRecordOnlyPolicy();
  }
  if (activation === null
    || activation.effective_at_ms > recordedAtMs
    || (activation.effective_until_ms !== null
      && recordedAtMs >= activation.effective_until_ms)) {
    return inactiveRecordOnlyPolicy();
  }
  return withProspectiveAction(
    materializeProposedMonetaryPolicy(
      activation.effective_at_ms,
      activation.effective_until_ms,
      activation.policy_version,
    ),
    resolution,
  );
}

function withProspectiveAction(
  policy: MonetaryPolicyVersion,
  resolution: ActionPolicyGateResolution,
): MonetaryPolicyVersion {
  if (resolution.status === 'class_admitted') return withClassAdmission(policy, resolution.actionType, resolution.witnessClass);
  const action = prospectiveAction(resolution);
  if (action === null) return policy;
  return Object.freeze({
    ...policy,
    policyVersion: `${policy.policyVersion}+${resolution.effectivePolicyVersion}`,
    actions: Object.freeze({ ...policy.actions, [resolution.actionType]: action }),
  });
}

/**
 * the type of work is never
 * the gate, a witness is the gate on RECORDING, and the policy setter signature is the gate on EARNING. An
 * action type with no named row (and no rejection) is admitted for RECORDING under its witness
 * class and seals record_only at weight 0, WHATEVER the class: a never-seen type lands in the
 * pending-policy queue (when a non-actor witness vouched for it) and earns only from the signed
 * matrix row's activation forward. Nothing sealed before that signature is ever repriced.
 *
 * The synthesized row keeps `policyReviewState: 'class_admitted'` / `witness_class_admitted` it
 * means "admitted for recording on a witness lane, awaiting a signed row" and the class's
 * informational category. It carries the non-earning shape (no evidence requirement, no canonical
 * event, standard attestation pricing) so no class, hardware included, can price it.
 *
 * The signed template declares exactly this (`unknownActionAdmission`, re-signed in the post-
 * close-out; `unknown-action-admission.binding.test.ts` binds declaration, matrix and this function).
 * The template's `evidenceClassBasesBps` price only the hardware-rooted lift of an eligible NAMED
 * row (`withWitnessClassOverride`); they never price an unnamed type. A policy that carries no
 * bases (an inactive/legacy vintage) synthesizes nothing — the type stays unknown,
 * record_only. Never touches a NAMED row: existing named types price byte-identically.
 */
export function classAdmittedAction(
  policy: MonetaryPolicyVersion,
  actionType: string,
  witnessClass: WitnessClass,
): ActionMonetaryPolicy | null {
  const bases = policy.evidenceClassBasesBps;
  if (bases === undefined) return null;
  const base = bases[witnessClass];
  if (!Number.isSafeInteger(base) || base < 0) return null;
  const profile = classAdmissionProfile(witnessClass);
  return Object.freeze({
    category: profile.category,
    baseWeightBps: 0,
    policyOverrideBps: null,
    mintDisposition: 'record_only',
    mintReasonCode: 'policy_record_only',
    policyReviewState: 'class_admitted',
    policyReviewReasonCode: 'witness_class_admitted',
    financialAttestationNeutral: false,
    attestationPricing: 'standard',
    allowVerifiedAttestationUpgrade: false,
    evidenceRequirement: 'none',
    canonicalEventRequired: false,
    canonicalEventGroup: `witness_class:${witnessClass}:${actionType}`,
    beneficialOwnershipPolicy: 'not_applicable',
    sessionLineagePolicy: 'not_applicable',
    fixedGrantSource: 'none',
    evidenceResolutionMode: 'not_applicable',
  });
}

function withClassAdmission(
  policy: MonetaryPolicyVersion,
  actionType: string,
  witnessClass: WitnessClass,
): MonetaryPolicyVersion {
  if (policy.actions[actionType] !== undefined) return policy; // a named row always wins
  const action = classAdmittedAction(policy, actionType, witnessClass);
  if (action === null) return policy;
  return Object.freeze({
    ...policy,
    policyVersion: `${policy.policyVersion}+class:${witnessClass}`,
    actions: Object.freeze({ ...policy.actions, [actionType]: action }),
  });
}

/** The two rows class pricing never touches: Genesis fixed grants and the wallet birth certificate. */
function isFixedValueRow(actionType: string, action: ActionMonetaryPolicy): boolean {
  return action.fixedGrantSource !== 'none' || actionType === 'wallet_created';
}

/**
 * /§2.9 — the HARDWARE-ROOTED override. the operator: "hardware-rooted = 4.0×". When a
 * hardware attestation report verified against its public root vouched for THIS PE, an ELIGIBLE
 * named row is repriced to the hardware_rooted class base (40000 bps) on the evidence-priced table
 * (the accrual lifts the tier to hardware_full → 1.0×), so the act prices at exactly 4.0×. Fixed
 * grants and the wallet birth certificate keep their own value; record_only rows stay record_only
 * (a bookkeeping/security record does not mint because a TPM signed it). Any other class returns
 * the policy UNCHANGED — every existing PE (witnessClass absent → actor_declared) is byte-identical.
 */
export function withWitnessClassOverride(
  policy: MonetaryPolicyVersion,
  actionType: string,
  witnessClass: unknown,
): MonetaryPolicyVersion {
  if (!isWitnessClass(witnessClass) || witnessClass !== 'hardware_rooted') return policy;
  const named = policy.actions[actionType];
  if (named === undefined) return policy; // no row at all (inactive vintage): nothing to lift
  // An unnamed type's class-admitted row is record_only (new-type intake), so it is never lifted.
  if (named.mintDisposition !== 'eligible' || isFixedValueRow(actionType, named)) return policy;
  const base = policy.evidenceClassBasesBps?.hardware_rooted;
  if (!Number.isSafeInteger(base) || (base as number) <= 0) return policy;
  const lifted: ActionMonetaryPolicy = Object.freeze({
    ...named,
    baseWeightBps: base as number,
    policyOverrideBps: null,
    financialAttestationNeutral: false,
    attestationPricing: 'external_proof_priced',
    allowVerifiedAttestationUpgrade: false,
    evidenceRequirement: 'verified_witness_class',
    canonicalEventRequired: true,
    canonicalEventGroup: `witness_class:hardware_rooted:${actionType}`,
  });
  return Object.freeze({
    ...policy,
    policyVersion: `${policy.policyVersion}+hw:hardware_rooted`,
    actions: Object.freeze({ ...policy.actions, [actionType]: lifted }),
  });
}
