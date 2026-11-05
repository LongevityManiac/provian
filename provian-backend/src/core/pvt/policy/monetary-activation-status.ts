

import type { Firestore } from 'firebase-admin/firestore';

import {
  MONETARY_POLICY_ACTIVATION_COLLECTION,
  MONETARY_POLICY_ACTIVATION_DOCUMENT,
  isValidMonetaryPolicyActivation,
  readSelectedMonetaryActivation,
} from './runtime-monetary-policy';
import {
  PROPOSED_MONETARY_POLICY_TEMPLATE,
  hashProposedMonetaryPolicyTemplate,
} from './proposed-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './pvt9-approval-manifest.generated';
import {
  explainApprovedMonetaryActivation,
  type ApprovedMonetaryActivationRecord,
  type ApprovedMonetaryActivationVerdict,
} from './approved-monetary-activation-approval';
import {
  approvalVerifierConfigFromEnv,
  type SshApprovalVerifierConfig,
} from './approval-signature';

/** Where the live state is readable without reading logs. */
export const MONETARY_STATUS_COLLECTION = 'system_status';
export const MONETARY_STATUS_DOCUMENT = 'monetary_activation';

/**
 * How many times the boot probe attempts the activation read before concluding it
 * genuinely failed.
 *
 * A cold-started Cloud Run instance runs this probe immediately at boot, before the
 * Firestore client / ADC is necessarily warm, so the FIRST read can throw on an otherwise
 * healthy service. That intermittently produced an `alarm_read_failed` status snapshot
 * (`digest_match:false`, `pinned:null`) which, being last-writer-wins, poisoned
 * `system_status/monetary_activation` until a later clean boot rewrote it — a false
 * `monetary.digest_mismatch` / `status.alarm.monetary` critical that flapped for hours
 * while the served template and the signed pin were both correct.
 *
 * Retrying a few times with short backoff absorbs the boot race, so `alarm_read_failed`
 * reflects a PERSISTENT failure (which must alarm) rather than a cold-start blip. An ABSENT
 * document is a real state (`alarm_document_absent`) and is never retried.
 */
export const MONETARY_ACTIVATION_READ_ATTEMPTS = 4;
const monetaryActivationReadBackoffMs = (attempt: number): number =>
  Math.min(2_000, 250 * 2 ** attempt);
const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Named outcomes. Exactly two are quiet; everything else alarms. */
export type MonetaryActivationVerdict =
  /** Valid document, floor reached: standard-lane acts price under real policy. */
  | 'quiet_active'
  /** Valid document, floor not yet reached. The expected state before 2026-08-03. */
  | 'quiet_valid_before_floor'
  | 'alarm_read_failed'
  | 'alarm_document_absent'
  | 'alarm_approval_env_absent'
  /** THE CAUSE, named: an action-policy row moved the template digest. */
  | 'alarm_template_digest_drifted'
  | 'alarm_structurally_invalid'
  | 'alarm_approval_refused'
  /**
   * The attributing explainer and the REAL validator disagree. Fail-closed and
   * loud: it means this module has drifted from the gate it claims to describe,
   * which is worse than either answer alone.
   */
  | 'alarm_explainer_disagrees';

const QUIET: ReadonlySet<MonetaryActivationVerdict> = new Set<MonetaryActivationVerdict>([
  'quiet_active',
  'quiet_valid_before_floor',
]);

export function isMonetaryActivationAlarm(verdict: MonetaryActivationVerdict): boolean {
  return !QUIET.has(verdict);
}

/**
 * The named field group that refuses, in the validator's own order. Kept as a
 * separate axis from the verdict so a structural refusal is attributable to a
 * field rather than reported as an undifferentiated "invalid".
 */
export type MonetaryStructuralField =
  | 'schema_version'
  | 'approval_status'
  | 'approval_manifest_sha256'
  | 'approval_signature'
  | 'policy_version'
  | 'policy_template_sha256'
  | 'effective_at_ms'
  | 'effective_until_ms'
  | 'activation_scope'
  | 'automation_generated'
  | 'activated_at_ms'
  | 'activated_by';

/**
 * Name the first structural conjunct that refuses, in the validator's order.
 *
 * This DESCRIBES `isValidMonetaryPolicyActivation`; it never replaces it. The
 * authoritative admit/refuse is always the real validator, and
 * `alarm_explainer_disagrees` fires if these two ever part company — so a drift
 * between them is a loud failure rather than a quiet misattribution.
 */
export function explainMonetaryStructuralRefusal(
  value: unknown,
): MonetaryStructuralField | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'schema_version';
  }
  const doc = value as Record<string, unknown>;
  const sig = doc.approval_signature as Record<string, unknown> | undefined;
  if (doc.schema_version !== 'pvt-monetary-policy-activation/v1') return 'schema_version';
  if (doc.approval_status !== 'approved_by_frank') return 'approval_status';
  if (doc.approval_manifest_sha256 !== PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256) {
    return 'approval_manifest_sha256';
  }
  if (typeof sig !== 'object' || sig === null
    || sig.scheme !== 'sshsig-ed25519'
    || typeof sig.signer_identity !== 'string'
    || typeof sig.namespace !== 'string'
    || typeof sig.public_key_sha256 !== 'string'
    || typeof sig.armored_signature !== 'string') {
    return 'approval_signature';
  }
  if (doc.policy_version !== PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion) {
    return 'policy_version';
  }
  if (doc.policy_template_sha256 !== hashProposedMonetaryPolicyTemplate()) {
    return 'policy_template_sha256';
  }
  if (typeof doc.effective_at_ms !== 'number'
    || !Number.isSafeInteger(doc.effective_at_ms)
    || doc.effective_at_ms < 0) {
    return 'effective_at_ms';
  }
  if (!(doc.effective_until_ms === null
    || (typeof doc.effective_until_ms === 'number'
      && Number.isSafeInteger(doc.effective_until_ms)
      && doc.effective_until_ms > doc.effective_at_ms))) {
    return 'effective_until_ms';
  }
  if (doc.activation_scope !== 'record_and_settlement') return 'activation_scope';
  if (doc.automation_generated !== false) return 'automation_generated';
  if (typeof doc.activated_at_ms !== 'number' || !Number.isSafeInteger(doc.activated_at_ms)) {
    return 'activated_at_ms';
  }
  if (typeof doc.activated_by !== 'string' || doc.activated_by.trim().length === 0) {
    return 'activated_by';
  }
  return null;
}

export interface MonetaryActivationStatusInput {
  /**
   * The raw document as Firestore returned it, `undefined` when the document is
   * absent, and `'read_failed'` when the read itself threw. Three distinct
   * facts, never collapsed: an absent document and an unreachable Firestore have
   * different remedies, and collapsing them reports the right severity for the
   * wrong reason.
   */
  readonly document: unknown | undefined | 'read_failed';
  readonly approvalPublicKeyRaw: string | undefined;
  readonly approvalKeySha256Raw: string | undefined;
  /** Injected so the floor comparison is deterministic in test. */
  readonly nowMs: number;
  readonly verifierConfig: SshApprovalVerifierConfig | null;
  /**
   * Test seam for the attributing explainer, and the ONLY way the
   * `alarm_explainer_disagrees` branch is constructible.
   *
   * That branch fires when this module's explainer and the real validator part
   * company. While they agree — which is the whole point — the disagreement is
   * by construction unbuildable, which is exactly the "guard whose
   * violating case cannot be constructed" shape: it would read as coverage
   * while never once executing. Widening the INPUT here makes the violation
   * constructible; the narrow default keeps production bound to the real
   * explainer, and no call site passes this.
   */
  readonly explainStructural?: (value: unknown) => MonetaryStructuralField | null;
  /**
   * Test seam for the checked-in approval record (the
   * ApprovedMonetaryActivationDeps.record pattern). While a template re-issue
   * awaits the policy setter signature the SHIPPED record is sentinel-gated and
   * refuses every candidate, which makes the probe's quiet branches otherwise
   * unreachable in test. Production passes nothing and always consults the
   * shipped record.
   */
  readonly approvalRecord?: ApprovedMonetaryActivationRecord;
}

export interface MonetaryActivationResolution {
  readonly verdict: MonetaryActivationVerdict;
  readonly alarm: boolean;
  readonly document_found: boolean;
  /** The approval layer's own named verdict. `null` when never reached. */
  readonly approval_verdict: ApprovedMonetaryActivationVerdict | null;
  readonly signature_verified: boolean;
  /** What the document pins. `null` when absent/unreadable. */
  readonly pinned_template_sha256: string | null;
  /** What this build computes. Always present — it needs no document. */
  readonly computed_template_sha256: string;
  readonly digest_match: boolean;
  readonly effective_at_ms: number | null;
  /** Set only for a structural refusal. */
  readonly failing_field: MonetaryStructuralField | null;
  /** The REAL validator's answer. Authoritative. */
  readonly validator_admits: boolean;
}

/**
 * Stamp the verdict and DERIVE `alarm` from it.
 *
 * `alarm` used to be hand-written at each of the nine returns, which made
 * `isMonetaryActivationAlarm` a second, unconsulted source of truth for the
 * same fact — and a mutation hard-wiring that function to `return false` passed
 * all 26 tests. A guard nothing consults cannot fail. One source, one place.
 */
function stamp(
  partial: Omit<MonetaryActivationResolution, 'verdict' | 'alarm'>,
  verdict: MonetaryActivationVerdict,
): MonetaryActivationResolution {
  return { ...partial, verdict, alarm: isMonetaryActivationAlarm(verdict) };
}

/**
 * Resolve the full picture. Pure and total: every branch is reachable in test,
 * including both quiet ones — a probe that can only ever alarm proves nothing
 * about the condition it claims to detect.
 */
export function resolveMonetaryActivationStatus(
  input: MonetaryActivationStatusInput,
): MonetaryActivationResolution {
  const computed = hashProposedMonetaryPolicyTemplate();
  const base = {
    approval_verdict: null,
    signature_verified: false,
    pinned_template_sha256: null,
    computed_template_sha256: computed,
    digest_match: false,
    effective_at_ms: null,
    failing_field: null,
    validator_admits: false,
  } as const;

  if (input.document === 'read_failed') {
    return stamp({ ...base, document_found: false }, 'alarm_read_failed');
  }
  if (input.document === undefined || input.document === null) {
    return stamp({ ...base, document_found: false }, 'alarm_document_absent');
  }

  const doc = input.document as Record<string, unknown>;
  const pinned = typeof doc.policy_template_sha256 === 'string'
    ? doc.policy_template_sha256
    : null;
  const effectiveAt = typeof doc.effective_at_ms === 'number' ? doc.effective_at_ms : null;
  const found = {
    document_found: true,
    pinned_template_sha256: pinned,
    computed_template_sha256: computed,
    digest_match: pinned === computed,
    effective_at_ms: effectiveAt,
  };

  // The approval env is a precondition of BOTH approval routes; without it the
  // verifier refuses for a reason that has nothing to do with the document.
  const keyPresent = typeof input.approvalPublicKeyRaw === 'string'
    && input.approvalPublicKeyRaw.trim() !== ''
    && typeof input.approvalKeySha256Raw === 'string'
    && input.approvalKeySha256Raw.trim() !== '';
  if (!keyPresent || input.verifierConfig === null) {
    return stamp({ ...base, ...found, failing_field: null }, 'alarm_approval_env_absent');
  }

  // AUTHORITATIVE: the real validator, the same call the record path makes.
  const admits = isValidMonetaryPolicyActivation(
    input.document,
    input.verifierConfig,
    input.approvalRecord,
  );
  const explain = input.explainStructural ?? explainMonetaryStructuralRefusal;
  const failingField = explain(input.document);
  const approvalVerdict = explainApprovedMonetaryActivation(
    {
      approval_signature: doc.approval_signature,
      policy_version: doc.policy_version,
      policy_template_sha256: doc.policy_template_sha256,
      activation_scope: doc.activation_scope,
      automation_generated: doc.automation_generated,
      effective_at_ms: doc.effective_at_ms,
    },
    input.approvalRecord === undefined
      ? { verifierConfig: input.verifierConfig }
      : { verifierConfig: input.verifierConfig, record: input.approvalRecord },
  );
  const resolved = {
    ...found,
    approval_verdict: approvalVerdict,
    signature_verified: approvalVerdict === 'approved',
    failing_field: failingField,
    validator_admits: admits,
  };

  if (admits) {
    // The explainer must agree with the gate. If it does not, THIS module is
    // wrong, and saying so is more useful than either answer on its own.
    if (failingField !== null) {
      return stamp(resolved, 'alarm_explainer_disagrees');
    }
    return stamp(
      resolved,
      input.nowMs >= (effectiveAt ?? Number.POSITIVE_INFINITY)
        ? 'quiet_active'
        : 'quiet_valid_before_floor',
    );
  }

  // Refused. Attribute it, most specific first — the digest drift is called out
  // by name because it is the one that already happened, silently, to Genesis.
  if (failingField === 'policy_template_sha256') {
    return stamp(resolved, 'alarm_template_digest_drifted');
  }
  if (failingField !== null) {
    return stamp(resolved, 'alarm_structurally_invalid');
  }
  return stamp(resolved, 'alarm_approval_refused');
}

/** What an operator should do, per verdict. Rendered into the boot banner. */
export function monetaryActivationRemedy(
  resolution: MonetaryActivationResolution,
): string {
  switch (resolution.verdict) {
    case 'quiet_active':
      return 'No action: the activation document is valid and in force. Standard-lane acts '
        + 'price under the real monetary policy.';
    case 'quiet_valid_before_floor':
      return 'No action: the activation document is valid. Its effective floor has not been '
        + 'reached, so acts recorded now still seal record_only BY DESIGN — arming cannot '
        + 'reprice already-recorded work.';
    case 'alarm_read_failed':
      return 'The activation read threw. The monetary rail fails closed to record-only while '
        + 'this persists — every standard-lane act is under-priced until it clears.';
    case 'alarm_document_absent':
      return `No document at ${MONETARY_POLICY_ACTIVATION_COLLECTION}/`
        + `${MONETARY_POLICY_ACTIVATION_DOCUMENT}. The rail fails closed to record-only. `
        + 'Write the signed activation document.';
    case 'alarm_approval_env_absent':
      return 'Set FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY and FRANK_PVT_APPROVAL_SSH_KEY_SHA256 on '
        + 'the service. Without them no approval route can verify and the rail is record-only.';
    case 'alarm_template_digest_drifted':
      return 'THE ACTION-POLICY TEMPLATE MOVED AND DISARMED A SIGNED DOCUMENT. The document '
        + `pins ${resolution.pinned_template_sha256}; this build computes `
        + `${resolution.computed_template_sha256}. Adding, removing or editing a row in `
        + 'PROPOSED_ACTION_POLICY_ENTRIES changes the digest — even an inert record_only row '
        + 'worth zero. Re-issue the activation document at the current digest (the derived '
        + 'fields are not signature-covered, so no new signature is required), or revert the '
        + 'row. NOTE: the Genesis document carries the identical binding and fails the same '
        + 'way — check both.';
    case 'alarm_structurally_invalid':
      return `The activation document is structurally invalid at \`${resolution.failing_field}\`. `
        + 'The rail fails closed to record-only until it is corrected.';
    case 'alarm_approval_refused':
      return 'The document is structurally correct but no approval route admits it '
        + `(${resolution.approval_verdict}). The rail fails closed to record-only.`;
    case 'alarm_explainer_disagrees':
      return 'The real validator ADMITS this document while the attributing explainer names a '
        + `failing field (\`${resolution.failing_field}\`). One of them is wrong and this module `
        + 'is the likelier culprit. Treat the rail as unverified until reconciled.';
    default:
      return 'Unrecognized verdict — treat as an alarm.';
  }
}

/**
 * The boot banner. Multi-line and framed on purpose, and it always prints the
 * full resolution — found / valid / pinned vs computed / effective — because
 * the POINT of this module is that the line itself is evidence the process
 * performed the read. A banner that only spoke up on failure would leave the
 * healthy case exactly as unobservable as it was before.
 */
export function formatMonetaryActivationBanner(
  resolution: MonetaryActivationResolution,
): string {
  const bar = '='.repeat(78);
  const label = resolution.alarm ? 'ALARM' : 'ok';
  const effective = resolution.effective_at_ms === null
    ? '(none)'
    : `${resolution.effective_at_ms} (${new Date(resolution.effective_at_ms).toISOString()})`;
  return [
    '',
    bar,
    `[monetary-activation] ${label}: ${resolution.verdict}`,
    `[monetary-activation] document found   : ${resolution.document_found}`,
    `[monetary-activation] validator admits : ${resolution.validator_admits}`,
    `[monetary-activation] signature verified: ${resolution.signature_verified}`
      + ` (approval verdict: ${resolution.approval_verdict ?? 'not reached'})`,
    `[monetary-activation] template digest  : pinned=${resolution.pinned_template_sha256 ?? '(none)'}`,
    `[monetary-activation]                    computed=${resolution.computed_template_sha256}`,
    `[monetary-activation]                    match=${resolution.digest_match}`,
    `[monetary-activation] effective_at     : ${effective}`,
    `[monetary-activation] failing field    : ${resolution.failing_field ?? '(none)'}`,
    `[monetary-activation] ${monetaryActivationRemedy(resolution)}`,
    `[monetary-activation] live state: ${MONETARY_STATUS_COLLECTION}/${MONETARY_STATUS_DOCUMENT}`,
    bar,
    '',
  ].join('\n');
}

export interface MonetaryActivationStatusRecord {
  readonly schema_version: 'monetary-activation-status/v1';
  readonly verdict: MonetaryActivationVerdict;
  readonly alarm: boolean;
  readonly document_found: boolean;
  readonly validator_admits: boolean;
  readonly signature_verified: boolean;
  readonly approval_verdict: string | null;
  readonly pinned_template_sha256: string | null;
  readonly computed_template_sha256: string;
  readonly digest_match: boolean;
  readonly effective_at_ms: number | null;
  readonly failing_field: string | null;
  readonly remedy: string;
  readonly observed_at_ms: number;
}

/**
 * Build the status record. NEVER carries a key value or a signature — only
 * digests and booleans — so the document is safe to read, copy, and paste.
 */
export function buildMonetaryActivationStatus(
  resolution: MonetaryActivationResolution,
  observedAtMs: number,
): MonetaryActivationStatusRecord {
  return {
    schema_version: 'monetary-activation-status/v1',
    verdict: resolution.verdict,
    alarm: resolution.alarm,
    document_found: resolution.document_found,
    validator_admits: resolution.validator_admits,
    signature_verified: resolution.signature_verified,
    approval_verdict: resolution.approval_verdict,
    pinned_template_sha256: resolution.pinned_template_sha256,
    computed_template_sha256: resolution.computed_template_sha256,
    digest_match: resolution.digest_match,
    effective_at_ms: resolution.effective_at_ms,
    failing_field: resolution.failing_field,
    remedy: monetaryActivationRemedy(resolution),
    observed_at_ms: observedAtMs,
  };
}

/**
 * Boot wiring: read the document, resolve, print the banner, upsert the status
 * document. Never throws — an alarm must not become an outage, and a failed
 * status write must not become one either (it is logged and the banner still
 * printed, so the louder surface survives the quieter one failing).
 */
/**
 * Read the activation document, retrying on a THROW (never on an absent document). Returns
 * the raw data, `undefined` for an absent document, or `'read_failed'` when every attempt
 * threw. Bounded and total — it never throws.
 */
export async function readMonetaryActivationDocument(
  db: Firestore,
  attempts: number = MONETARY_ACTIVATION_READ_ATTEMPTS,
  delay: (ms: number) => Promise<void> = realDelay,
  backoffMs: (attempt: number) => number = monetaryActivationReadBackoffMs,
): Promise<unknown | undefined | 'read_failed'> {
  const total = Math.max(1, attempts);
  for (let attempt = 0; attempt < total; attempt += 1) {
    try {
      return await readSelectedMonetaryActivation(db);
    } catch {
      if (attempt < total - 1) {
        try { await delay(backoffMs(attempt)); } catch { /* a broken delay must not throw */ }
      }
    }
  }
  return 'read_failed';
}

export async function reportMonetaryActivationAtStartup(
  db: Firestore,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
  log: (message: string) => void = console.warn,
  // `approvalVerifierConfigFromEnv` reads `process.env` directly and takes no
  // argument, so the config is a seam here rather than derived from `env` —
  // otherwise a test could pass an `env` that the verifier silently ignored,
  // and the two halves of this function would disagree about what "configured"
  // means. Production passes neither and gets the real process env for both.
  verifierConfig: SshApprovalVerifierConfig | null = approvalVerifierConfigFromEnv(),
  // The read seam. Production uses the retrying default; tests inject a fast delay
  // and a controllable attempt count. A boot-time cold-start read race must not poison the
  // last-writer-wins status doc with a spurious `alarm_read_failed`.
  readDocument: (db: Firestore) => Promise<unknown | undefined | 'read_failed'> =
    (d) => readMonetaryActivationDocument(d),
): Promise<MonetaryActivationStatusRecord> {
  const document: unknown | undefined | 'read_failed' = await readDocument(db);

  const observedAt = now();
  let resolution: MonetaryActivationResolution;
  try {
    resolution = resolveMonetaryActivationStatus({
      document,
      approvalPublicKeyRaw: env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY,
      approvalKeySha256Raw: env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256,
      nowMs: observedAt,
      verifierConfig,
    });
  } catch {
    // A throwing resolver is itself unknown state, and unknown alarms.
    resolution = stamp({
      document_found: document !== undefined && document !== 'read_failed',
      approval_verdict: null,
      signature_verified: false,
      pinned_template_sha256: null,
      computed_template_sha256: hashProposedMonetaryPolicyTemplate(),
      digest_match: false,
      effective_at_ms: null,
      failing_field: null,
      validator_admits: false,
    }, 'alarm_read_failed');
  }

  const status = buildMonetaryActivationStatus(resolution, observedAt);
  log(formatMonetaryActivationBanner(resolution));

  try {
    await db.collection(MONETARY_STATUS_COLLECTION)
      .doc(MONETARY_STATUS_DOCUMENT)
      .set(status, { merge: true });
  } catch (error) {
    log('[monetary-activation] status document write FAILED: '
      + `${error instanceof Error ? error.message : String(error)} — `
      + 'the banner above is the surviving surface.');
  }

  return status;
}
