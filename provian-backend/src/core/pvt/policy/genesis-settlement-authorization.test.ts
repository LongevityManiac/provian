import {
  GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
  GENESIS_SETTLEMENT_CAMPAIGN_ID,
  GENESIS_SETTLEMENT_CHAIN_ID,
  GENESIS_SETTLEMENT_KERNEL_ID,
  GENESIS_SETTLEMENT_LAUNCH_EVENT_ID,
  createGenesisSettlementAuthorizationSubject,
  genesisSettlementAuthorizationSubjectSha256,
  parseGenesisSettlementAuthorizationManifest,
} from './genesis-settlement-authorization';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './proposed-genesis-policy';
import {
  PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64,
} from './pvt9-approval-manifest.generated';

function launchSubject() {
  return createGenesisSettlementAuthorizationSubject({
    event_id: GENESIS_SETTLEMENT_LAUNCH_EVENT_ID,
    policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    authorized_at_epoch: 0,
    effective_epoch: 0,
    cap_atomic:
      PROPOSED_GENESIS_CAMPAIGN_POLICY.settlement.initial_genesis_sub_budget_atomic,
    previous_event_hash: null,
    authorization_scope: GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
    chain_id: GENESIS_SETTLEMENT_CHAIN_ID,
    campaign_id: GENESIS_SETTLEMENT_CAMPAIGN_ID,
    settlement_kernel_id: GENESIS_SETTLEMENT_KERNEL_ID,
  });
}

function manifestBytes(
  approvalStatus: string,
  signingPermitted: boolean,
  subject = launchSubject(),
): Buffer {
  return Buffer.from(`${JSON.stringify({
    schema_version: 'pvt9-policy-approval-manifest/v1',
    approval_status: approvalStatus,
    signing_permitted: signingPermitted,
    genesis_settlement_authorization_subject: subject,
    genesis_settlement_authorization_subject_sha256:
      genesisSettlementAuthorizationSubjectSha256(subject),
  })}\n`, 'utf8');
}

describe('canonical Genesis settlement authorization subject', () => {
  it('parses the exact approvable subject and its non-circular commitment', () => {
    expect(parseGenesisSettlementAuthorizationManifest(manifestBytes(
      'approvable_after_independent_review',
      true,
    ))).toEqual(launchSubject());
  });

  it('rejects the current Gate 1-approved non-signable manifest independently of signature validity', () => {
    const current = Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
    expect(() => parseGenesisSettlementAuthorizationManifest(current))
      .toThrow('approval manifest is not approvable');
  });

  it.each([
    ['corrections_pending_not_approvable', true],
    ['approvable_after_independent_review', false],
  ])('rejects non-approvable manifest status/signing combination %s/%s', (
    approvalStatus,
    signingPermitted,
  ) => {
    expect(() => parseGenesisSettlementAuthorizationManifest(manifestBytes(
      approvalStatus,
      signingPermitted,
    ))).toThrow('approval manifest is not approvable');
  });

  it('rejects a changed canonical-subject commitment', () => {
    const subject = launchSubject();
    const bytes = Buffer.from(`${JSON.stringify({
      schema_version: 'pvt9-policy-approval-manifest/v1',
      approval_status: 'approvable_after_independent_review',
      signing_permitted: true,
      genesis_settlement_authorization_subject: subject,
      genesis_settlement_authorization_subject_sha256: `sha256:${'0'.repeat(64)}`,
    })}\n`, 'utf8');
    expect(() => parseGenesisSettlementAuthorizationManifest(bytes))
      .toThrow('authorization subject hash is invalid');
  });
});
