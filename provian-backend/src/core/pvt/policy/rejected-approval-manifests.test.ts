import fs from 'fs';
import path from 'path';
import type { Firestore } from 'firebase-admin/firestore';

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
} from '../__test-helpers__/armed-genesis-policy';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  drainGenesisQualifications,
  shouldPersistGenesisQualification,
  type GenesisStateMachineDeps,
} from '../genesis-award-state-machine';
import {
  approvalManifestSha256,
  resolveApprovalManifestBytesByHash,
  verifyPvtManifestApprovalByHash,
} from './current-approval';
import {
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  validateGenesisCampaignActivation,
  verifyGenesisCampaignActivationApproval,
  type GenesisCampaignActivation,
} from './genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './proposed-genesis-policy';
import {
  REJECTED_PVT_APPROVAL_MANIFEST_SHA256,
  isRejectedPvtApprovalManifestSha256,
} from './rejected-approval-manifests';
import { hashProposedMonetaryPolicyTemplate } from './runtime-monetary-policy';
import {
  decodeOpenSshEd25519PublicKey,
  type SshApprovalSignature,
  type SshApprovalVerifierConfig,
} from './approval-signature';

const REQUIRED_REJECTED_HASHES = [
  'sha256:04c0bec8a4a1bda992c5819e8e3bcf2def22e3e9306ce2ea51c9ffb682a0f123',
  'sha256:61c92cefad93a4477e5ff86fa093facee2d72265eae0d8caacc48eaca0903cff',
  'sha256:5d26fd57cbb3051854850f4cb52fed4f2994821616c50857a7ee1f96763f60a1',
  'sha256:9081b80b4d35589dcceaf181f13bc30885df2303db56d7717b507de343ee380b',
  'sha256:f5ee33f065efd2fc0ed028d25cfbdb13f245ab2e6f590f6c0ba5f8a3392f94bd',
  'sha256:84cfbfd180734b83cf5b286b463d02682c6e44c53c9af6cde2b67d85cbd36422',
  'sha256:fddd4d8008c67d673b4eb4e71e686e9e0c65248e6432e1e4bd0ae26a3bc3b4e8',
  'sha256:9dda0e70c92018a070307dd09e9450a4b9ad9a53740f3e382f73637831471cd1',
  'sha256:42494d93d5c07719a39f1b7ecce65af0a9f7f27c3ec673e4d476593f582c4baf',
  'sha256:a33676ef6c7b1bff191af4fd392160c98422df6fc00f7a8f3dc5bdbec9270cf2',
  'sha256:2e2aba9ecd12746b2362b05c6d98a90d8d9cdbd805e37cc063ca36e6bbf6d178',
  'sha256:14204edca0684b8f354f3f32c018bc16009796f17e426fb11ee921c54c824c6c',
  'sha256:683bc13371126e2f621f7cc3b07bdf0da4bf1c53180d67e32a09e26cc9e59217',
  'sha256:44f8145c3b46107b248b0dd5e54955b742e90b939a7d52e0e07646bb226751bf',
  'sha256:24c1e8affb2fda3aa8b67a88a37deed8e076c41223f1e64436ba9db09a1f6ee4',
  'sha256:a6cd8ad75f1df87975861f8f91a68e3278af0b5ab6f71b544a11206a4412c7af',
  'sha256:991022ec75e48e8d845cddcdff4a1b3a338ab0921f0cc55bbf402e3d0ae61629',
] as const;

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const ledgerSourcePath =
  'provian-backend/src/core/pvt/policy/rejected-approval-manifests.ts';
const documentationSurfaces = ['docs/PVT_MONETARY_ACCOUNTING_SPEC.md'] as const;

const fixtureDir = path.join(__dirname, '__fixtures__', 'approval');
const fixtureBytes = fs.readFileSync(path.join(fixtureDir, 'manifest-a.json'));
const publicKey = fs.readFileSync(path.join(fixtureDir, 'fixture-key.pub'), 'utf8').trim();
const publicKeySha256 = decodeOpenSshEd25519PublicKey(publicKey).sha256;
const verifierConfig: SshApprovalVerifierConfig = {
  signerIdentity: 'frank',
  namespace: 'provian-pvt-policy',
  openSshPublicKey: publicKey,
  publicKeySha256,
};
const signature: SshApprovalSignature = {
  scheme: 'sshsig-ed25519',
  signer_identity: 'frank',
  namespace: 'provian-pvt-policy',
  public_key_sha256: publicKeySha256,
  armored_signature: fs.readFileSync(
    path.join(fixtureDir, 'manifest-a.json.sig'),
    'utf8',
  ),
};

const TEST_GENESIS_CAMPAIGN_POLICY = installArmedGenesisPolicyForTest();
afterAll(restoreCheckedInGenesisPolicyAfterTest);

function rejectedActivation(hash: string): GenesisCampaignActivation {
  return {
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: hash,
    approval_signature: signature,
    frank_approval_audit_id: 'rejected-ledger-test-audit',
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
    ),
    approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: 'pvt9-rejected-ledger-test',
    ledger_namespace: 'pvt9-rejected-ledger-test-ledger',
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'rejected-ledger-test-operator',
  };
}

describe('single rejected PVT approval-manifest ledger', () => {
  it('contains every independently rejected digest exactly once and is frozen', () => {
    expect(REJECTED_PVT_APPROVAL_MANIFEST_SHA256).toEqual(REQUIRED_REJECTED_HASHES);
    expect(Object.isFrozen(REJECTED_PVT_APPROVAL_MANIFEST_SHA256)).toBe(true);
    expect(new Set(REJECTED_PVT_APPROVAL_MANIFEST_SHA256).size)
      .toBe(REQUIRED_REJECTED_HASHES.length);
    expect(REJECTED_PVT_APPROVAL_MANIFEST_SHA256.every(
      (hash) => /^sha256:[a-f0-9]{64}$/.test(hash),
    )).toBe(true);
    const source = fs.readFileSync(path.join(repositoryRoot, ledgerSourcePath), 'utf8');
    for (const hash of REQUIRED_REJECTED_HASHES) {
      expect(source.split(hash).length - 1).toBe(1);
    }
  });

  it('drives the generated manifest without an independently maintained partial list', () => {
    const generated = JSON.parse(fs.readFileSync(path.join(
      repositoryRoot,
      'docs/audit/pvt-wp0-wp1/pvt-policy-approval-manifest.generated.json',
    ), 'utf8')) as {
      prohibited_manifest_sha256?: string[];
      decided_launch_economics?: { rejected_manifest_ledger?: string };
    };
    expect(generated.prohibited_manifest_sha256)
      .toEqual([...REJECTED_PVT_APPROVAL_MANIFEST_SHA256]);
    expect(generated.decided_launch_economics?.rejected_manifest_ledger)
      .toBe(`single_append_only_${REJECTED_PVT_APPROVAL_MANIFEST_SHA256.length}_digest_ledger_drives_runtime_genesis_settlement_generated_manifest_tests_and_maintained_documentation_and_cannot_be_bypassed_by_injected_verifiers`);
  });

  it('is the referenced source of truth for every maintained documentation surface', () => {
    const enforced = new Set<string>(REJECTED_PVT_APPROVAL_MANIFEST_SHA256);
    for (const relativePath of documentationSurfaces) {
      const content = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
      expect(content).toContain(ledgerSourcePath);
      for (const line of content.split('\n')) {
        if (!/(reject|prohibit|must not be signed|signing target)/i.test(line)) continue;
        for (const match of line.matchAll(/(?:sha256:)?([a-f0-9]{64})/g)) {
          expect(enforced.has(`sha256:${match[1]}`)).toBe(true);
        }
      }
    }
  });

  it('blocks every ledger entry before manifest-byte resolution or SSHSIG verification', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const resolver = jest.fn(async () => fixtureBytes);
    for (const rejectedHash of REJECTED_PVT_APPROVAL_MANIFEST_SHA256) {
      expect(isRejectedPvtApprovalManifestSha256(rejectedHash)).toBe(true);
      await expect(resolveApprovalManifestBytesByHash(db, rejectedHash)).resolves.toBeNull();
      await expect(verifyPvtManifestApprovalByHash(
        rejectedHash,
        signature,
        resolver,
        verifierConfig,
      )).resolves.toBe(false);
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(approvalManifestSha256(fixtureBytes))
      .not.toBe(REJECTED_PVT_APPROVAL_MANIFEST_SHA256[0]);
  });

  it('blocks every ledger entry at Genesis qualification, reservation, and recovery before a permissive verifier', async () => {
    for (const rejectedHash of REJECTED_PVT_APPROVAL_MANIFEST_SHA256) {
      const activation = rejectedActivation(rejectedHash);
      const permissiveVerifier = jest.fn(() => true);
      expect(verifyGenesisCampaignActivationApproval(activation, verifierConfig)).toBe(false);
      expect(shouldPersistGenesisQualification(
        'genesis_human_signup',
        TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms,
        activation,
        permissiveVerifier,
      )).toBe(false);
      expect(validateGenesisCampaignActivation(
        PROPOSED_GENESIS_CAMPAIGN_POLICY,
        activation,
        permissiveVerifier,
      )).toBe('proposal_not_approved');
      expect(reserveGenesisCampaignGrant({
        manifest: PROPOSED_GENESIS_CAMPAIGN_POLICY,
        activation,
        state: createEmptyGenesisLedgerState(activation.ledger_namespace),
        input: {} as never,
        observation_context: {} as never,
        activation_approval_verifier: permissiveVerifier,
      })).toMatchObject({ allowed: false, reason: 'proposal_not_approved' });

      const fake = createFakeFirestore();
      await fake.collection(GENESIS_ACTIVATION_COLLECTION)
        .doc(GENESIS_ACTIVATION_DOCUMENT)
        .set(activation as unknown as Record<string, unknown>);
      await expect(drainGenesisQualifications({
        db: fake as unknown as Firestore,
        verifyGenesisActivationApproval: permissiveVerifier,
      } as unknown as GenesisStateMachineDeps, {
        now: TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms,
      })).rejects.toThrow('genesis_recovery_activation_not_approved');
      expect(permissiveVerifier).not.toHaveBeenCalled();
    }
  });
});
