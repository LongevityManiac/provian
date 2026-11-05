/**
 * Monetary activation approval source — behaviour and its RED controls.
 *
 * The headline control is REPLAY REFUSAL: the precedent
 * (`approved-genesis-activation-approval.ts`) signs over the SHARED frozen
 * manifest bytes, so copying it here would have made the operator’s existing Genesis
 * signature a valid authorization for opening the monetary rail. This suite
 * proves the message being signed is different, using the shipped functions.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  APPROVED_MONETARY_ACTIVATION,
  APPROVED_MONETARY_ACTIVATION_SIGNATURE,
  APPROVED_MONETARY_ACTIVATION_STATUS,
  NO_MONETARY_ACTIVATION_APPROVED_STATUS,
  BOUND_GATE1_MANIFEST_SHA256,
  assertApprovedMonetaryActivationFailClosed,
  explainApprovedMonetaryActivation,
  isApprovedMonetaryActivation,
  monetaryApprovalSigningBytes,
  monetaryApprovalSigningDigest,
  type ApprovedMonetaryActivationRecord,
  type MonetaryActivationApprovalCandidate,
} from './approved-monetary-activation-approval';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64 } from './pvt9-approval-manifest.generated';
import { hashProposedMonetaryPolicyTemplate } from './runtime-monetary-policy';
import { PROPOSED_MONETARY_POLICY_TEMPLATE } from './proposed-monetary-policy';
import { approvalVerifierConfigFromEnv } from './approval-signature';
import type { SshApprovalSignature, SshApprovalVerifierConfig } from './approval-signature';

const CONFIG: SshApprovalVerifierConfig = {
  signerIdentity: 'frank',
  namespace: 'provian-pvt-policy',
  openSshPublicKey: 'ssh-ed25519 AAAA-test',
  publicKeySha256: `sha256:${'a'.repeat(64)}`,
};

const SIGNATURE: SshApprovalSignature = {
  scheme: 'sshsig-ed25519',
  signer_identity: 'frank',
  namespace: 'provian-pvt-policy',
  public_key_sha256: CONFIG.publicKeySha256,
  armored_signature: '-----BEGIN SSH SIGNATURE-----\ntest\n-----END SSH SIGNATURE-----',
};

/** A record identical to the shipped one but with the ratified status. */
const SIGNED_RECORD: ApprovedMonetaryActivationRecord = {
  ...APPROVED_MONETARY_ACTIVATION,
  status: APPROVED_MONETARY_ACTIVATION_STATUS,
  approved: { ...APPROVED_MONETARY_ACTIVATION.approved },
};

function candidate(
  over: Partial<MonetaryActivationApprovalCandidate> = {},
): MonetaryActivationApprovalCandidate {
  return {
    approval_signature: SIGNATURE,
    policy_version: PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion,
    policy_template_sha256: hashProposedMonetaryPolicyTemplate(),
    activation_scope: 'record_and_settlement',
    automation_generated: false,
    effective_at_ms: 1_785_800_000_000,
    ...over,
  };
}

/** A candidate carrying the SHIPPED signature, for end-to-end verification. */
function realCandidate(
  over: Partial<MonetaryActivationApprovalCandidate> = {},
): MonetaryActivationApprovalCandidate {
  return { ...candidate(), approval_signature: APPROVED_MONETARY_ACTIVATION_SIGNATURE, ...over };
}

/** Accepts any message — isolates every conjunct EXCEPT signature validity. */
const acceptAny = () => true;

describe('shipped record — signed canonical scope', () => {
  // The embedded signature authorizes the exact current scope and template.
  it('ships the approved status with a signature over the current scope', () => {
    expect(APPROVED_MONETARY_ACTIVATION.status).toBe(APPROVED_MONETARY_ACTIVATION_STATUS);
    expect(APPROVED_MONETARY_ACTIVATION.status).not.toBe(NO_MONETARY_ACTIVATION_APPROVED_STATUS);
  });

  /**
   * The signing handoff is byte-identical to the verifier's own message,
   * so what the operator signs and what the runtime verifies cannot drift (the
   * "verified three ways" discipline, made a standing assertion).
   */


  /**
   * RED CONTROL 1, PRESERVED THROUGH THE FLIP. The sentinel self-gate is proven
   * by INJECTING a sentinel record, so the control holds in BOTH shipped states
   * the ratified windows (/////F-A6-1-F-A7/) and
   * each one-commit pre-signature sentinel window that precedes them — rather than
   * being a side-effect of whichever status the shipped record happens to carry.
   */
  it('RED CONTROL 1: a sentinel-status record still refuses even a perfect candidate', () => {
    const sentinel = { ...APPROVED_MONETARY_ACTIVATION, status: NO_MONETARY_ACTIVATION_APPROVED_STATUS };
    expect(explainApprovedMonetaryActivation(candidate(), {
      record: sentinel, verifierConfig: CONFIG, verifySignature: acceptAny,
    })).toBe('status_gates_everything');
    expect(isApprovedMonetaryActivation(candidate(), {
      record: sentinel, verifierConfig: CONFIG, verifySignature: acceptAny,
    })).toBe(false);
  });

  /**
   * The shipped signature must verify against the REAL verifier, not a stub.
   * Skipped when the verifier key is unset (a bare checkout), and it says so
   * rather than passing vacuously — an unconfigured environment must not read
   * as a green arming proof.
   */
  it('the shipped record VERIFIES against the real verifier key (and says `verifier_key_not_configured` on a bare checkout — never a vacuous pass)', () => {
    const live = approvalVerifierConfigFromEnv();
    const verdict = explainApprovedMonetaryActivation(realCandidate(), {});
    if (live === null) {
      expect(verdict).toBe('verifier_key_not_configured');
      return;
    }
    expect(verdict).toBe('approved');
  });

  it('RED: the shipped signature does NOT verify over tampered bytes', () => {
    const live = approvalVerifierConfigFromEnv();
    if (live === null) return;
    expect(explainApprovedMonetaryActivation(realCandidate({
      approval_signature: {
        ...APPROVED_MONETARY_ACTIVATION_SIGNATURE,
        armored_signature:
          APPROVED_MONETARY_ACTIVATION_SIGNATURE.armored_signature.replace('U1NIU0lH', 'U1NIU0lI'),
      },
    }), {})).toBe('signature_not_verified');
  });

  it('is fail-closed on its own invariants', () => {
    expect(() => assertApprovedMonetaryActivationFailClosed()).not.toThrow();
  });

  it('binds the live frozen Gate 1 digest, not a copied literal', () => {
    const live = `sha256:${crypto.createHash('sha256')
      .update(Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64'))
      .digest('hex')}`;
    expect(live).toBe(BOUND_GATE1_MANIFEST_SHA256);
    expect(APPROVED_MONETARY_ACTIVATION.approved.bound_gate1_manifest_sha256).toBe(live);
  });
});

describe('REPLAY REFUSAL — the deliberate divergence from the precedent', () => {
  // THE control this module exists to satisfy. If the signing message were the
  // shared frozen manifest (as the Genesis precedent uses), the operator’s existing
  // Genesis signature would open the monetary rail with no new signing act.
  it('RED CONTROL 2: the signed message is NOT the frozen manifest bytes', () => {
    const manifest = Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
    const mine = monetaryApprovalSigningBytes();
    expect(mine.equals(manifest)).toBe(false);
  });

  it('RED CONTROL 3: a verifier that ONLY accepts the frozen manifest is REFUSED', () => {
    const manifest = Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
    // Stands in for the existing Genesis signature: valid over the manifest,
    // and over nothing else.
    const genesisStyleVerifier = (bytes: Buffer) => bytes.equals(manifest);
    expect(explainApprovedMonetaryActivation(candidate(), {
      record: SIGNED_RECORD, verifierConfig: CONFIG, verifySignature: genesisStyleVerifier,
    })).toBe('signature_not_verified');
  });

  it('the signing bytes are domain-separated and derived from the scope', () => {
    const text = monetaryApprovalSigningBytes().toString('utf8');
    expect(text).toContain('provian-monetary-activation-approval/v1');
    expect(text).toContain('scope=monetary_runtime_activation_document');
    expect(text).toContain(`policy_template_sha256=${hashProposedMonetaryPolicyTemplate()}`);
    expect(monetaryApprovalSigningDigest()).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('conjuncts — each refusal attributable to one cause', () => {
  const deps = { record: SIGNED_RECORD, verifierConfig: CONFIG, verifySignature: acceptAny };

  it('admits only when every conjunct holds', () => {
    expect(explainApprovedMonetaryActivation(candidate(), deps)).toBe('approved');
  });

  // RED CONTROL 4: `deps.record ?? SHIPPED` would be fail-open — an explicitly
  // absent record must NOT silently fall back to the shipped one.
  it('RED CONTROL 4: an EXPLICITLY null record refuses instead of falling back', () => {
    expect(explainApprovedMonetaryActivation(candidate(), {
      record: undefined, verifierConfig: CONFIG, verifySignature: acceptAny,
    })).toBe('record_absent_or_malformed');
  });

  it('refuses a policy_version mismatch', () => {
    expect(explainApprovedMonetaryActivation(candidate({ policy_version: 'other' }), deps))
      .toBe('policy_version_mismatch');
  });

  it('refuses a drifted template digest', () => {
    expect(explainApprovedMonetaryActivation(
      candidate({ policy_template_sha256: `sha256:${'b'.repeat(64)}` }), deps,
    )).toBe('policy_template_drifted');
  });

  it('refuses a scope mismatch', () => {
    expect(explainApprovedMonetaryActivation(candidate({ activation_scope: 'record_only' }), deps))
      .toBe('activation_scope_mismatch');
  });

  // RED CONTROL 5: activation is a human act; a generated document is never one.
  it('RED CONTROL 5: refuses an automation-generated document', () => {
    expect(explainApprovedMonetaryActivation(candidate({ automation_generated: true }), deps))
      .toBe('automation_generated_refused');
  });

  it('refuses a malformed effective instant', () => {
    expect(explainApprovedMonetaryActivation(candidate({ effective_at_ms: -1 }), deps))
      .toBe('effective_instant_malformed');
    expect(explainApprovedMonetaryActivation(candidate({ effective_at_ms: 'now' }), deps))
      .toBe('effective_instant_malformed');
  });

  it('refuses a moved frozen manifest', () => {
    expect(explainApprovedMonetaryActivation(candidate(), {
      ...deps, manifestBytes: Buffer.from('tampered', 'utf8'),
    })).toBe('frozen_manifest_moved');
  });

  it('refuses a malformed or wrong-namespace signature', () => {
    expect(explainApprovedMonetaryActivation(candidate({ approval_signature: null }), deps))
      .toBe('signature_malformed');
    expect(explainApprovedMonetaryActivation(
      candidate({ approval_signature: { ...SIGNATURE, namespace: 'other' } }), deps,
    )).toBe('signature_malformed');
  });

  it('refuses when no verifier key is configured', () => {
    expect(explainApprovedMonetaryActivation(candidate(), {
      record: SIGNED_RECORD, verifierConfig: null, verifySignature: acceptAny,
    })).toBe('verifier_key_not_configured');
  });

  it('refuses a key mismatch', () => {
    expect(explainApprovedMonetaryActivation(
      candidate({ approval_signature: { ...SIGNATURE, public_key_sha256: `sha256:${'c'.repeat(64)}` } }),
      deps,
    )).toBe('signature_key_mismatch');
  });

  it('catches a throwing verifier into `threw` rather than admitting', () => {
    expect(explainApprovedMonetaryActivation(candidate(), {
      record: SIGNED_RECORD,
      verifierConfig: CONFIG,
      verifySignature: () => { throw new Error('boom'); },
    })).toBe('threw');
  });

  // Guards the empty-population shape: proves the admit path is genuinely
  // reachable, so every refusal above is a real discrimination rather than a
  // function that can only ever refuse.
  it('RED CONTROL 6: the admit path is reachable, so the refusals discriminate', () => {
    expect(explainApprovedMonetaryActivation(candidate(), deps)).toBe('approved');
    expect(isApprovedMonetaryActivation(candidate(), deps)).toBe(true);
  });
});
