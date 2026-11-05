/**
 * Generate the Genesis SETTLEMENT approval manifest — the successor artifact
 * that the epoch-0 settlement policy event names.
 *
 * WHY THIS EXISTS. The Gate 1 approval manifest (`704c1a2d…`) cannot authorize
 * Genesis settlement, for two independent and unfixable reasons:
 *
 * 1. It declares `signing_permitted: false` / `approval_status:
 * "gate_1_plain_english_policy_approved_non_signable"`, so
 * `manifestPermitsSigning` refuses it and no signature over it — however
 * genuine — is ever accepted.
 * 2. Its embedded `genesis_settlement_authorization_subject.campaign_id` is
 * `pvt9_genesis_pending`, the campaign name as it stood when Gate 1 was
 * frozen. The live campaign is `pvt9_genesis_v1` (renamed at arming), and
 * `isGenesisSettlementAuthorizationSubject` requires exact equality with
 * `GENESIS_SETTLEMENT_CAMPAIGN_ID`. The frozen artifact therefore names a
 * campaign that no longer exists.
 *
 * A successor is a FACTUAL CORRECTION, not a loosening of a gate.
 *
 * WHAT THIS DOES NOT DO. It does not touch the frozen Gate 1 artifact, its
 * hash, `FROZEN_MANIFEST_SHA256`, `PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256`, or
 * `manifestPermitsSigning`. Gate 1 stays byte-identical as history, and the
 * activation route that binds it keeps working unchanged. It does not add
 * an admit route: the epoch-0 pin remains ONE exact-equality check against ONE
 * hash. It only changes WHICH hash — from an artifact that provably cannot
 * authorize to one that can.
 *
 * WHAT IT STILL REQUIRES. Everything else. The epoch-0 event must exist in
 * Firestore, carry `approval_status: 'approved_by_frank'`, and carry a real
 * ed25519 SSHSIG over THESE EXACT BYTES by the configured production key. This
 * generator produces BYTES ONLY and never signs. No signature is checked into
 * the repository, so shipping this file opens nothing on its own.
 *
 * Every field of the authorization subject is DERIVED from the modules the
 * reader consults, never copied — so the artifact cannot drift from what
 * `loadAuthorizedGenesisSettlementPolicyEvent` demands.
 *
 * Usage: npx tsx scripts/generate-genesis-settlement-approval-manifest.ts [--check]
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC } from '../src/core/pvt/genesis-settlement-budget';
import {
  GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
  GENESIS_SETTLEMENT_CAMPAIGN_ID,
  GENESIS_SETTLEMENT_CHAIN_ID,
  GENESIS_SETTLEMENT_KERNEL_ID,
  GENESIS_SETTLEMENT_LAUNCH_EVENT_ID,
  createGenesisSettlementAuthorizationSubject,
  genesisSettlementAuthorizationSubjectSha256,
} from '../src/core/pvt/policy/genesis-settlement-authorization';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../src/core/pvt/policy/proposed-genesis-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from '../src/core/pvt/policy/pvt9-approval-manifest.generated';

const ARTIFACT_PATH = 'src/core/pvt/policy/__artifacts__/genesis-settlement-approval-manifest.json';
const MODULE_PATH = 'src/core/pvt/policy/genesis-settlement-approval-manifest.ts';

/** The exact bytes. Built from the reader's own constants and constructor. */
export function buildGenesisSettlementApprovalManifestBytes(): Buffer {
  const subject = createGenesisSettlementAuthorizationSubject({
    event_id: GENESIS_SETTLEMENT_LAUNCH_EVENT_ID,
    policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    authorized_at_epoch: 0,
    effective_epoch: 0,
    cap_atomic: INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC,
    previous_event_hash: null,
    authorization_scope: GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
    chain_id: GENESIS_SETTLEMENT_CHAIN_ID,
    campaign_id: GENESIS_SETTLEMENT_CAMPAIGN_ID,
    settlement_kernel_id: GENESIS_SETTLEMENT_KERNEL_ID,
  });
  return Buffer.from(`${JSON.stringify({
    schema_version: 'pvt9-policy-approval-manifest/v1',
    approval_status: 'approvable_after_independent_review',
    signing_permitted: true,

    manifest_role: 'genesis_settlement_epoch_zero_authorization',
    supersedes_for_settlement_only: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
    supersession_reason:
      'The Gate 1 approval manifest is non-signable (signing_permitted:false) and its embedded '
      + 'genesis_settlement_authorization_subject names campaign_id "pvt9_genesis_pending", the '
      + 'pre-arming campaign name. The live campaign is "pvt9_genesis_v1". The Gate 1 artifact is '
      + 'therefore structurally incapable of authorizing settlement for the campaign that exists, '
      + 'and is superseded FOR THE SETTLEMENT EPOCH-ZERO PIN ONLY. It remains byte-identical, '
      + 'remains the Gate 1 evidence of record, and remains the artifact bound by the Genesis '
      + 'runtime activation route. Nothing else moves.',
    supersession_does_not_grant:
      'This manifest grants no deployment, activation, mint, settlement, transaction, admin, '
      + 'owner, proxy, executor, timelock, or governance authority. It authorizes exactly one '
      + 'artifact: the epoch-zero Genesis settlement budget policy event described below. It does '
      + 'not open the record-time monetary policy rail (verifyCurrentPvtManifestApproval), which '
      + 'reads the Gate 1 constant and stays refused.',

    authorized_artifact: 'genesis_settlement_budget_policy_event',
    authorized_epoch: 0,
    genesis_settlement_authorization_subject: subject,
    genesis_settlement_authorization_subject_sha256:
      genesisSettlementAuthorizationSubjectSha256(subject),

    decided_settlement_economics: {
      note:
        'Recorded, not chosen. Every value below EQUALS the existing ratified literal in '
        + 'proposed-genesis-policy.ts and the armed on-chain epoch-zero policy; none is a new '
        + 'economic decision.',
      initial_genesis_sub_budget_atomic: INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC,
      policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
      campaign_id: GENESIS_SETTLEMENT_CAMPAIGN_ID,
      chain_id: GENESIS_SETTLEMENT_CHAIN_ID,
      settlement_kernel_id: GENESIS_SETTLEMENT_KERNEL_ID,
    },

    signature_protocol: {
      scheme: 'sshsig-ed25519',
      namespace: 'provian-pvt-policy',
      signer_identity: 'frank',
      signed_over: 'the exact bytes of this file, unmodified',
      note:
        'No signature is stored in the repository. The signature lives in the Firestore '
        + 'epoch-zero policy event and is produced by the operator at emission time. Until that event '
        + 'exists and verifies, loadAuthorizedGenesisSettlementPolicyEvent refuses and no '
        + 'settlement is possible.',
    },
  }, null, 2)}\n`, 'utf8');
}

function moduleSource(bytes: Buffer): string {
  const sha256 = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  return `/**
 * The Genesis SETTLEMENT approval manifest — the artifact the epoch-zero
 * settlement policy event must name.
 *
 * AUTO-GENERATED by scripts/generate-genesis-settlement-approval-manifest.ts
 * from __artifacts__/genesis-settlement-approval-manifest.json. DO NOT EDIT.
 *
 * The Gate 1 manifest (\`704c1a2d…\`) is NOT touched and NOT moved. It is
 * non-signable and names the pre-arming campaign \`pvt9_genesis_pending\`; this
 * successor names the live campaign and is signable. The epoch-zero pin remains
 * a SINGLE exact-equality check — only its target changes.
 *
 * These are BYTES, not an approval. No signature ships with them.
 */
export const GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256 =
  '${sha256}' as const;

export const GENESIS_SETTLEMENT_APPROVAL_MANIFEST_UTF8_BASE64 =
  '${bytes.toString('base64')}' as const;

export const GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SIGNING_PERMITTED = true as const;

export const GENESIS_SETTLEMENT_APPROVAL_MANIFEST_APPROVAL_STATUS =
  'approvable_after_independent_review' as const;

/** The exact bytes every settlement approval signature is taken over. */
export function genesisSettlementApprovalManifestBytes(): Buffer {
  return Buffer.from(GENESIS_SETTLEMENT_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
}
`;
}

function main(): void {
  const check = process.argv.includes('--check');
  const root = path.resolve(__dirname, '..');
  const bytes = buildGenesisSettlementApprovalManifestBytes();
  const artifactAbs = path.join(root, ARTIFACT_PATH);
  const moduleAbs = path.join(root, MODULE_PATH);
  const source = moduleSource(bytes);

  if (check) {
    const artifactOk = fs.existsSync(artifactAbs)
      && fs.readFileSync(artifactAbs).equals(bytes);
    const moduleOk = fs.existsSync(moduleAbs)
      && fs.readFileSync(moduleAbs, 'utf8') === source;
    if (!artifactOk || !moduleOk) {
      console.error(`DRIFT: artifact=${artifactOk} module=${moduleOk}`);
      process.exitCode = 1;
      return;
    }
    console.log('ok — settlement approval manifest artifact and module match the derived bytes');
    return;
  }

  fs.mkdirSync(path.dirname(artifactAbs), { recursive: true });
  fs.writeFileSync(artifactAbs, bytes);
  fs.writeFileSync(moduleAbs, source);
  console.log(`wrote ${ARTIFACT_PATH} (${bytes.length} bytes)`);
  console.log(`wrote ${MODULE_PATH}`);
  console.log(`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`);
}

if (require.main === module) main();
