import { PROPOSED_MONETARY_POLICY_TEMPLATE } from './proposed-monetary-policy';
import crypto from 'crypto';
import {
  PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS,
  PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
  PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED,
  PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64,
} from './pvt9-approval-manifest.generated';
import {
  hashProposedMonetaryPolicyTemplate,
  isValidMonetaryPolicyActivation,
  type MonetaryPolicyActivationDocument,
} from './runtime-monetary-policy';

function activation(): MonetaryPolicyActivationDocument {
  return {
    schema_version: 'pvt-monetary-policy-activation/v1',
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
    approval_signature: {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace: 'provian-pvt-policy',
      public_key_sha256: `sha256:${'a'.repeat(64)}`,
      armored_signature: 'non-empty-but-not-cryptographic',
    },
    policy_version: PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion,
    policy_template_sha256: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: 1_000,
    effective_until_ms: null,
    activation_scope: 'record_and_settlement',
    automation_generated: false,
    activated_at_ms: 900,
    activated_by: 'operator:test',
  };
}

describe('runtime monetary policy activation', () => {
  test('keeps the Gate 1-approved status manifest cryptographically inert', () => {
    expect(PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED).toBe(false);
    expect(PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS)
      .toBe('gate_1_plain_english_policy_approved_non_signable');
    expect(isValidMonetaryPolicyActivation(activation())).toBe(false);
  });

  test('binds the runtime hash to the exact embedded UTF-8 bytes', () => {
    const bytes = Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
    expect(`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`)
      .toBe(PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256);
    expect(bytes.at(-1)).toBe(0x0a);
  });

  test('rejects a changed manifest hash and a non-empty signature reference substitute', () => {
    expect(isValidMonetaryPolicyActivation({
      ...activation(),
      approval_manifest_sha256: `sha256:${'f'.repeat(64)}`,
    })).toBe(false);
    expect(isValidMonetaryPolicyActivation({
      ...activation(),
      approval_signature: 'ssh-signature:local-test-fixture',
    })).toBe(false);
  });

  test('rejects automation activation and a changed policy template', () => {
    expect(isValidMonetaryPolicyActivation({
      ...activation(),
      automation_generated: true,
    })).toBe(false);
    expect(isValidMonetaryPolicyActivation({
      ...activation(),
      policy_template_sha256: `sha256:${'e'.repeat(64)}`,
    })).toBe(false);
  });
});
