import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Firestore } from 'firebase-admin/firestore';

jest.mock('./policy/pvt9-approval-manifest.generated', () => {
  // Isolate a genuinely approvable fixture from the real Gate 1-approved
  // status manifest, which remains non-signable in every production/default test.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixtureFs = require('fs') as typeof fs;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixtureCrypto = require('crypto') as typeof crypto;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixturePath = require('path') as typeof path;
  const bytes = fixtureFs.readFileSync(fixturePath.join(
    process.cwd(),
    'src/core/pvt/policy/__fixtures__/approval/manifest-a.json',
  ));
  return {
    PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256:
      `sha256:${fixtureCrypto.createHash('sha256').update(bytes).digest('hex')}`,
    PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64: bytes.toString('base64'),
    PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED: true,
    PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS:
      'approvable_after_independent_review',
  };
});

import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
} from './__test-helpers__/armed-genesis-policy';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  closeGenesisAdmission,
  drainGenesisQualifications,
  shouldPersistGenesisQualification,
  type GenesisStateMachineDeps,
} from './genesis-award-state-machine';
import {
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  verifyGenesisCampaignActivationApproval,
  type GenesisCampaignActivation,
} from './policy/genesis-policy-engine';
import { decodeOpenSshEd25519PublicKey, type SshApprovalSignature } from './policy/approval-signature';
import { approvalManifestSha256 } from './policy/current-approval';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import { hashProposedMonetaryPolicyTemplate } from './policy/runtime-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './policy/pvt9-approval-manifest.generated';

const fixtureDir = path.join(__dirname, 'policy', '__fixtures__', 'approval');
const publicKey = fs.readFileSync(path.join(fixtureDir, 'fixture-key.pub'), 'utf8').trim();
const publicKeyHash = decodeOpenSshEd25519PublicKey(publicKey).sha256;
const manifestBytes = (name: 'a' | 'b') =>
  fs.readFileSync(path.join(fixtureDir, `manifest-${name}.json`));
const signature = (name: 'a' | 'b'): SshApprovalSignature => ({
  scheme: 'sshsig-ed25519',
  signer_identity: 'frank',
  namespace: 'provian-pvt-policy',
  public_key_sha256: publicKeyHash,
  armored_signature: fs.readFileSync(
    path.join(fixtureDir, `manifest-${name}.json.sig`),
    'utf8',
  ),
});

const TEST_GENESIS_CAMPAIGN_POLICY = installArmedGenesisPolicyForTest();
const START = TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms;
afterAll(restoreCheckedInGenesisPolicyAfterTest);

function activation(
  approvalSignature: SshApprovalSignature = signature('a'),
  manifestHash: string = PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
): GenesisCampaignActivation {
  return {
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: manifestHash,
    approval_signature: approvalSignature,
    frank_approval_audit_id: 'real-sshsig-fixture-audit',
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
    ),
    approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: START,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: 'pvt9-real-sshsig-fixture',
    ledger_namespace: 'pvt9-real-sshsig-fixture-ledger',
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'real-sshsig-fixture-operator',
  };
}

function reserve(approvedActivation: GenesisCampaignActivation) {
  const walletId = 'wallet-real-sshsig';
  return reserveGenesisCampaignGrant({
    manifest: PROPOSED_GENESIS_CAMPAIGN_POLICY,
    activation: approvedActivation,
    state: createEmptyGenesisLedgerState(approvedActivation.ledger_namespace),
    input: {
      pe_id: 'pe-real-sshsig',
      action_type: 'genesis_human_signup',
      wallet_id: walletId,
      economic_actor_id: walletId,
      immutable_anchor: { anchor_kind: 'human_wallet_id', anchor_id: walletId },
      qualifying_act_evidence: {
        verification_status: 'verified',
        evidence_id: 'real-sshsig-evidence',
        evidence_hash: `sha256:${'a'.repeat(64)}`,
        subject_wallet_id: walletId,
        canonical_bounty_key: 'genesis_human_signup',
        qualifying_act: 'create_human_wallet',
        immutable_anchor_kind: 'human_wallet_id',
        immutable_anchor_id: walletId,
        qualifying_act_at_ms: START,
      },
    },
    observation_context: {
      verification_status: 'verified',
      observed_at_ms: START,
      wallet_created: {
        wallet_id: walletId,
        created_at_ms: START,
        evidence_id: 'real-sshsig-wallet-evidence',
        evidence_hash: `sha256:${'b'.repeat(64)}`,
        source: 'authoritative_wallet_record',
      },
    },
  });
}

describe('Genesis activation exact-manifest SSHSIG binding', () => {
  const oldPublicKey = process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
  const oldKeyHash = process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;

  beforeAll(() => {
    process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = publicKey;
    process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = publicKeyHash;
  });
  afterAll(() => {
    if (oldPublicKey === undefined) delete process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
    else process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = oldPublicKey;
    if (oldKeyHash === undefined) delete process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
    else process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = oldKeyHash;
  });

  it('authorizes qualification, reservation, close, and recovery with real signature A', async () => {
    const approved = activation();
    expect(verifyGenesisCampaignActivationApproval(approved)).toBe(true);
    expect(shouldPersistGenesisQualification(
      'genesis_human_signup',
      START,
      approved,
    )).toBe(true);
    expect(reserve(approved)).toMatchObject({ allowed: true, reason: 'reserved' });

    const fake = createFakeFirestore();
    await fake.collection(GENESIS_ACTIVATION_COLLECTION).doc(GENESIS_ACTIVATION_DOCUMENT)
      .set(approved as unknown as Record<string, unknown>);
    await expect(closeGenesisAdmission(fake as unknown as Firestore, {
      admissionCloseAuditId: 'real-sshsig-close-audit',
      closedBy: 'real-sshsig-operator',
      now: START,
    })).resolves.toMatchObject({ idempotent: false, cutoffAtMs: START });
    await expect(drainGenesisQualifications({
      db: fake as unknown as Firestore,
    } as GenesisStateMachineDeps, { now: START + 1 }))
      .resolves.toEqual([]);
  });

  it('does not let signature B or a declared B hash authorize any Genesis consumer', async () => {
    const signatureBForA = activation(signature('b'));
    expect(verifyGenesisCampaignActivationApproval(signatureBForA)).toBe(false);
    expect(shouldPersistGenesisQualification(
      'genesis_human_signup',
      START,
      signatureBForA,
    )).toBe(false);
    expect(reserve(signatureBForA)).toMatchObject({
      allowed: false,
      reason: 'proposal_not_approved',
    });

    const hashB = approvalManifestSha256(manifestBytes('b'));
    expect(hashB).not.toBe(PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256);
    expect(verifyGenesisCampaignActivationApproval(activation(signature('b'), hashB)))
      .toBe(false);

    const fake = createFakeFirestore();
    await fake.collection(GENESIS_ACTIVATION_COLLECTION).doc(GENESIS_ACTIVATION_DOCUMENT)
      .set(signatureBForA as unknown as Record<string, unknown>);
    await expect(closeGenesisAdmission(fake as unknown as Firestore, {
      admissionCloseAuditId: 'invalid-sshsig-close-audit',
      closedBy: 'invalid-sshsig-operator',
      now: START,
    })).rejects.toThrow('genesis_admission_close_rejected:proposal_not_approved');
    await expect(drainGenesisQualifications({
      db: fake as unknown as Firestore,
    } as GenesisStateMachineDeps, { now: START + 1 }))
      .rejects.toThrow('genesis_recovery_activation_not_approved');
  });
});
