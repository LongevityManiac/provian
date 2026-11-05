/**
 * wiring controls for `isValidMonetaryPolicyActivation`.
 *
 * The existing suite asserts the rail REFUSES today. Necessary but not
 * sufficient: a wire that was never connected refuses identically. These tests
 * distinguish those cases — one proves the scoped route is consulted at all, the
 * others pin where in the order it sits.
 */

import { isApprovedMonetaryActivation } from './approved-monetary-activation-approval';
import {
  isValidMonetaryPolicyActivation,
  hashProposedMonetaryPolicyTemplate,
} from './runtime-monetary-policy';
import { PROPOSED_MONETARY_POLICY_TEMPLATE } from './proposed-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './pvt9-approval-manifest.generated';

jest.mock('./approved-monetary-activation-approval', () => {
  const actual = jest.requireActual('./approved-monetary-activation-approval');
  return { ...actual, isApprovedMonetaryActivation: jest.fn(() => false) };
});

const mocked = isApprovedMonetaryActivation as jest.MockedFunction<
  typeof isApprovedMonetaryActivation
>;

function activation(): Record<string, unknown> {
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

describe(' wiring — the scoped route is genuinely consulted', () => {
  beforeEach(() => {
    mocked.mockReset();
    mocked.mockReturnValue(false);
  });

  // RED CONTROL. If the wire were dead, forcing the scoped route to admit would
  // change nothing and this would still be false.
  it('RED CONTROL: forcing the scoped route to admit makes the rail admit', () => {
    mocked.mockReturnValue(true);
    expect(isValidMonetaryPolicyActivation(activation())).toBe(true);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("with the scoped route refusing, the rail refuses — today's real state", () => {
    expect(isValidMonetaryPolicyActivation(activation())).toBe(false);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('a structurally invalid document never reaches the scoped route at all', () => {
    mocked.mockReturnValue(true);
    expect(isValidMonetaryPolicyActivation({ ...activation(), activation_scope: 'wrong' }))
      .toBe(false);
    expect(mocked).not.toHaveBeenCalled();
  });

  it('the rail forwards the fields the scoped route judges', () => {
    isValidMonetaryPolicyActivation(activation());
    expect(mocked).toHaveBeenCalledWith(
      expect.objectContaining({
        activation_scope: 'record_and_settlement',
        automation_generated: false,
        policy_version: PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion,
      }),
      expect.anything(),
    );
  });
});
