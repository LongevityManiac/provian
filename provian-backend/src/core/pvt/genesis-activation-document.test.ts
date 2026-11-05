import fs from 'fs';
import path from 'path';

import {
  PVT9_GENESIS_LEDGER_NAMESPACE,
  SIGNABLE_APPROVAL_STATUS,
  buildGenesisActivationDocument,
  describeGenesisActivationRefusal,
  explainGenesisActivationRefusal,
} from './genesis-activation-document';
import { shouldPersistGenesisQualification } from './genesis-award-state-machine';
import { decodeOpenSshEd25519PublicKey, type SshApprovalSignature } from './policy/approval-signature';
import {
  hashGenesisCampaignPolicyManifest,
  type GenesisCampaignActivation,
} from './policy/genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import {
  PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS,
  PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
  PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED,
} from './policy/pvt9-approval-manifest.generated';
import { hashProposedMonetaryPolicyTemplate } from './policy/runtime-monetary-policy';

const WINDOW = PROPOSED_GENESIS_CAMPAIGN_POLICY.window;

/**
 * The manifest types both edges as nullable, because a DISARMED window is null.
 * A null here is a real condition, not a type nuisance: it would make every
 * in-window assertion below meaningless, so it fails the suite loudly instead of
 * being cast away.
 */
function requireArmedEdge(value: number | null, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`approved Genesis window ${name} is not armed: ${String(value)}`);
  }
  return value;
}
const START = requireArmedEdge(WINDOW.start_ms, 'start_ms');
const END = requireArmedEdge(WINDOW.end_ms, 'end_ms');

/**
 * The three Genesis legs, bound to the single approved source rather than
 * re-declared here (self-referential-control shape).
 */
const LEGS = PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.map((b) => b.canonical_bounty_key);

const fixtureDir = path.join(__dirname, 'policy', '__fixtures__', 'approval');
/**
 * A STRUCTURALLY VALID signature that does not verify over the production
 * manifest bytes. Needed to reach the approval layer at all: an unsigned
 * document is rejected earlier, as a structural failure, so it can never
 * demonstrate the approval-layer verdicts.
 */
const wellFormedForeignSignature = (): SshApprovalSignature => ({
  scheme: 'sshsig-ed25519',
  signer_identity: 'frank',
  namespace: 'provian-pvt-policy',
  public_key_sha256: decodeOpenSshEd25519PublicKey(
    fs.readFileSync(path.join(fixtureDir, 'fixture-key.pub'), 'utf8').trim(),
  ).sha256,
  armored_signature: fs.readFileSync(
    path.join(fixtureDir, 'manifest-a.json.sig'), 'utf8',
  ),
});

function doc(
  overrides: Partial<GenesisCampaignActivation> = {},
): GenesisCampaignActivation {
  return {
    ...buildGenesisActivationDocument({
      frankApprovalAuditId: 'test-frank-audit',
      operatorActivationAuditId: 'test-operator-audit',
      canonicalPvtManifestId: 'pvt9-test-manifest',
      approvalSignature: wellFormedForeignSignature(),
    }),
    ...overrides,
  };
}

describe('activation · the assembled Genesis activation document', () => {
  it('derives every hash and version from the single approved source', () => {
    const built = buildGenesisActivationDocument({
      frankApprovalAuditId: 'a',
      operatorActivationAuditId: 'b',
      canonicalPvtManifestId: 'c',
      approvalSignature: null,
    });
    expect(Object.keys(built).sort()).toEqual([
      'admission_close_audit_id',
      'admission_closed_at_ms',
      'approval_manifest_sha256',
      'approval_signature',
      'approval_status',
      'approved_monetary_policy_template_hash',
      'approved_policy_manifest_hash',
      'approved_policy_version',
      'canonical_pvt_manifest_id',
      'effective_at_ms',
      'frank_approval_audit_id',
      'genesis_kill_switch_active',
      'grants_enabled',
      'ledger_namespace',
      'operator_activation_audit_id',
      'prior_reservations_reconciled',
    ]);
    expect(built.approval_manifest_sha256).toBe(PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256);
    expect(built.approved_policy_manifest_hash)
      .toBe(hashGenesisCampaignPolicyManifest(PROPOSED_GENESIS_CAMPAIGN_POLICY));
    expect(built.approved_monetary_policy_template_hash)
      .toBe(hashProposedMonetaryPolicyTemplate());
    expect(built.approved_policy_version)
      .toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version);
    expect(built.effective_at_ms).toBe(START);
    // Bound to the APPROVED SOURCE, not to the module's own export — reviewer
    // defect 3: comparing to the export made a drifted copy uncatchable.
    expect(built.ledger_namespace)
      .toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.ledger_namespace);
    expect(PVT9_GENESIS_LEDGER_NAMESPACE)
      .toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.ledger_namespace);
    // An OPEN campaign carries no cutoff; closing is a separate evented op.
    expect(built.admission_closed_at_ms).toBeNull();
    expect(built.admission_close_audit_id).toBeNull();
    expect(built.grants_enabled).toBe(true);
    expect(built.genesis_kill_switch_active).toBe(false);
  });

  it('refuses a non-integer effective instant rather than assembling a bad doc', () => {
    expect(() => buildGenesisActivationDocument({
      frankApprovalAuditId: 'a',
      operatorActivationAuditId: 'b',
      canonicalPvtManifestId: 'c',
      approvalSignature: null,
      effectiveAtMs: 1.5,
    })).toThrow('genesis_activation_effective_at_invalid');
  });
});

describe('activation · the structural blocker, as an executable assertion', () => {
  it('the checked-in approval manifest declares itself NON-SIGNABLE', () => {
    // Bound to the constants the production code reads, not copies of them.
    expect(PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED as boolean).toBe(false);
    expect(PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS as string)
      .not.toBe(SIGNABLE_APPROVAL_STATUS);
  });

  it('a maximally-correct, well-formed-signature document is refused STRUCTURALLY', () => {
    const verdict = explainGenesisActivationRefusal(doc());
    expect(verdict.verdict).toBe('manifest_non_signable');
    if (verdict.verdict !== 'manifest_non_signable') throw new Error('unreachable');
    expect(verdict.signingPermitted).toBe(false);
    expect(verdict.requiredApprovalStatus).toBe(SIGNABLE_APPROVAL_STATUS);
    expect(describeGenesisActivationRefusal(verdict))
      .toContain('NO key and NO document can be accepted');
  });

  it('and the refusal is ONLY the approval layer — every other field is correct', () => {
    // This is the isolation that proves the verdict above is not hiding a
    // malformed document: with the approval layer satisfied, the SAME document
    // admits at the real gate. So the sole refusing conjunct is signability.
    expect(explainGenesisActivationRefusal(doc(), { approvalVerifier: () => true }))
      .toEqual({ verdict: 'admits' });
    expect(shouldPersistGenesisQualification(
      'genesis_human_signup', START, doc(), () => true,
    )).toBe(true);
  });

  it('NEGATIVE CONTROL — the two approval-layer verdicts are distinguishable', () => {
    // Without this, `signature_not_verified` is an UNREACHABLE BRANCH while the
    // manifest stays non-signable, and an unreachable branch is a guard that
    // cannot fail. Widening the explainer's INPUT — not the production
    // constants — is what makes the violating case constructible.
    expect(explainGenesisActivationRefusal(doc(), {
      signingPermitted: true,
      approvalStatus: SIGNABLE_APPROVAL_STATUS,
      approvalVerifier: () => false,
    })).toEqual({ verdict: 'signature_not_verified' });

    // One flag at a time: either alone must still read as non-signable.
    expect(explainGenesisActivationRefusal(doc(), {
      signingPermitted: false,
      approvalStatus: SIGNABLE_APPROVAL_STATUS,
      approvalVerifier: () => false,
    }).verdict).toBe('manifest_non_signable');
    expect(explainGenesisActivationRefusal(doc(), {
      signingPermitted: true,
      approvalStatus: 'gate_1_plain_english_policy_approved_non_signable',
      approvalVerifier: () => false,
    }).verdict).toBe('manifest_non_signable');
  });

  it.each([
    ['approval_manifest_sha256' as const, { approval_manifest_sha256: `sha256:${'a'.repeat(64)}` }],
    ['approved_monetary_policy_template_hash' as const,
      { approved_monetary_policy_template_hash: `sha256:${'b'.repeat(64)}` }],
  ])('REVIEWER DEFECT 2 — a well-formed WRONG %s never reports admits', (field, override) => {
    // These two are compared by the GATE (state-machine:419-421) and only
    // regex-checked by validateActivationStructure, so an explainer that relied
    // on the structural validator alone reported `admits` while the real gate
    // refused. Both must now agree, in both directions.
    const bad = doc(override);
    expect(explainGenesisActivationRefusal(bad, { approvalVerifier: () => true }))
      .toEqual({ verdict: 'bound_hash_mismatch', field });
    expect(shouldPersistGenesisQualification(
      'genesis_human_signup', START, bad, () => true,
    )).toBe(false);
    // And the honest-text property that was violated: the structural-blocker
    // message must not be attached to a document that is NOT otherwise correct.
    expect(describeGenesisActivationRefusal(
      explainGenesisActivationRefusal(bad),
    )).not.toContain('Every other field of this document is correct');
  });

  it('an UNSIGNED document is refused earlier, as malformed', () => {
    const verdict = explainGenesisActivationRefusal(
      doc({ approval_signature: null }), { approvalVerifier: () => true },
    );
    expect(verdict).toEqual({ verdict: 'malformed', reason: 'proposal_not_approved' });
  });

  it('a KILLED document is refused first, before anything else is judged', () => {
    expect(explainGenesisActivationRefusal(
      doc({ genesis_kill_switch_active: true }), { approvalVerifier: () => true },
    )).toEqual({ verdict: 'killed' });
  });
});

describe('activation · the persist gate refuses each bad document on ALL THREE legs', () => {
  it('covers exactly the three approved legs, over a non-empty population', () => {
    // The population is asserted before it is quantified over: a leg list that
    // silently emptied would otherwise satisfy every claim below vacuously.
    expect(LEGS.length).toBe(3);
    expect(LEGS.slice().sort()).toEqual([
      'genesis_device_link', 'genesis_human_signup', 'genesis_signup',
    ]);
  });

  it.each(LEGS)('%s — an ADMITTING document persists, in-window', (leg) => {
    expect(shouldPersistGenesisQualification(
      leg, START, doc(), () => true,
    )).toBe(true);
    expect(shouldPersistGenesisQualification(
      leg, END, doc(), () => true,
    )).toBe(true);
  });

  it.each(LEGS)('%s — RED: an UNSIGNED document is refused', (leg) => {
    expect(shouldPersistGenesisQualification(
      leg, START, doc({ approval_signature: null }), () => true,
    )).toBe(false);
  });

  it.each(LEGS)('%s — RED: a WRONG-KEY document is refused', (leg) => {
    // The production verifier, against a well-formed signature by a key that is
    // not the configured approval key over bytes that are not the manifest.
    expect(shouldPersistGenesisQualification(leg, START, doc()))
      .toBe(false);
  });

  /**
   * NOTE FOR WHOEVER MUTATES THIS NEXT. The kill refusal is defended TWICE and
   * independently: `genesis-award-state-machine.ts` checks it in the gate, and
   * `validateActivationStructure` in `genesis-policy-engine.ts` checks it again.
   * Removing EITHER one alone leaves these three tests GREEN — verified by
   * mutation — so a single-line mutation here proves nothing. Both must be
   * removed for them to go red, which is how the control was actually run.
   */
  it.each(LEGS)('%s — RED: a KILLED document is refused', (leg) => {
    expect(shouldPersistGenesisQualification(
      leg, START, doc({ genesis_kill_switch_active: true }), () => true,
    )).toBe(false);
  });

  it.each(LEGS)('%s — RED: an OUT-OF-WINDOW act is refused even when admitting', (leg) => {
    expect(shouldPersistGenesisQualification(
      leg, START - 1, doc(), () => true,
    )).toBe(false);
    expect(shouldPersistGenesisQualification(
      leg, END + 1, doc(), () => true,
    )).toBe(false);
  });

  it('RED: a non-Genesis action never persists, however valid the document', () => {
    expect(shouldPersistGenesisQualification(
      'wallet_created', START, doc(), () => true,
    )).toBe(false);
  });
});

describe('activation · the three production call sites are bound to this predicate', () => {
  /**
   * The leg coverage above would be a claim about a list I chose unless the
   * three PRODUCTION call sites are also observed. Each must read the activation
   * value from its own transaction and pass an injectable verifier — a site that
   * hard-coded either would be outside the gate this file tests.
   */
  const SITES = [
    // PHASE 1: `genesis_signup` moved off the external-address proof and onto agent
    // wallet creation, so the agent site is here rather than in external-address.
    'src/routes/agent-wallet.ts',
    'src/core/pvt/genesis-ingress.ts',
  ];

  it('finds exactly three call sites, each passing a transaction-read activation', () => {
    const root = path.resolve(__dirname, '..', '..', '..');
    let found = 0;
    for (const site of SITES) {
      const source = fs.readFileSync(path.join(root, site), 'utf8');
      const lines = source.split('\n');
      expect(lines.length).toBeGreaterThan(50);
      for (let i = 0; i < lines.length; i += 1) {
        if (!/persistQualification = shouldPersistGenesisQualification\(|!shouldPersistGenesisQualification\(/
          .test(lines[i])) continue;
        found += 1;
        const call = lines.slice(i, i + 6).join(' ');
        // The activation value comes from the surrounding transaction read,
        // never from a module constant or a literal.
        expect(call).toMatch(/activationSnap\.exists \? activationSnap\.data\(\) : undefined|activationValue/);
        // And the verifier is injectable, so a test can isolate the layer.
        expect(call).toMatch(/[Vv]erif(y|ier)/);
      }
    }
    expect(found).toBe(3);
  });
});
