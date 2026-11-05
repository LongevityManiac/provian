import type { Firestore } from 'firebase-admin/firestore';

import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
} from './__test-helpers__/armed-genesis-policy';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  isGenesisAdmittingNow,
  isGenesisGrantPersistenceLive,
} from './genesis-award-state-machine';
import {
  GenesisLaunchSequenceError,
  assertPublicLaunchGatedByGenesisActivation,
  enforceGenesisLaunchSequenceAtStartup,
} from './genesis-launch-guard';
import {
  hashGenesisCampaignPolicyManifest,
  type GenesisCampaignActivation,
} from './policy/genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import { hashProposedMonetaryPolicyTemplate } from './policy/runtime-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './policy/pvt9-approval-manifest.generated';

const TEST_POLICY = installArmedGenesisPolicyForTest();
afterAll(restoreCheckedInGenesisPolicyAfterTest);

function armedActivation(overrides: Partial<GenesisCampaignActivation> = {}): GenesisCampaignActivation {
  return {
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
    approval_signature: {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace: 'provian-pvt-policy',
      public_key_sha256: `sha256:${'a'.repeat(64)}`,
      armored_signature: 'test-only-structured-signature',
    },
    frank_approval_audit_id: 'launch-guard-test-approval',
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
    ),
    approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: TEST_POLICY.window.start_ms,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: 'pvt9-launch-guard-test',
    ledger_namespace: 'pvt9-launch-guard-test-ledger',
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'launch-guard-test-operator',
    ...overrides,
  };
}

async function setActivation(
  fake: ReturnType<typeof createFakeFirestore>,
  activation: GenesisCampaignActivation,
): Promise<void> {
  await fake.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT)
    .set(activation as unknown as Record<string, unknown>);
}

describe('H4 public-launch sequence guard (pure predicate)', () => {
  // Enumerate all 8 combinations; exactly ONE — the hazard — must throw. This is the
  // non-vacuity proof: the guard fires on (open, armed, not-live) and NOTHING else.
  const bools = [false, true];
  for (const publicLaunch of bools) {
    for (const genesisEnqueueArmed of bools) {
      for (const genesisPersistLive of bools) {
        const isHazard = publicLaunch && genesisEnqueueArmed && !genesisPersistLive;
        test(`launch=${publicLaunch} armed=${genesisEnqueueArmed} live=${genesisPersistLive} ⇒ ${
          isHazard ? 'BLOCK' : 'permit'
        }`, () => {
          const call = () => assertPublicLaunchGatedByGenesisActivation({
            publicLaunch,
            genesisEnqueueArmed,
            genesisPersistLive,
          });
          if (isHazard) {
            expect(call).toThrow(GenesisLaunchSequenceError);
          } else {
            expect(call).not.toThrow();
          }
        });
      }
    }
  }
});

describe('H4 startup wiring', () => {
  test('PUBLIC_LAUNCH=false is a no-op even with the window armed and no activation', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await expect(
      enforceGenesisLaunchSequenceAtStartup(db, false),
    ).resolves.toBeUndefined();
  });

  test('PUBLIC_LAUNCH=true blocks when the window is armed but the activation is absent', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    // No activation doc: persistence is not live while the window is armed.
    await expect(
      enforceGenesisLaunchSequenceAtStartup(db, true),
    ).rejects.toBeInstanceOf(GenesisLaunchSequenceError);
  });

  test('PUBLIC_LAUNCH=true blocks when the activation is killed', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await setActivation(fake, armedActivation({
      grants_enabled: false,
      genesis_kill_switch_active: true,
    }));
    await expect(
      enforceGenesisLaunchSequenceAtStartup(db, true, () => true),
    ).rejects.toBeInstanceOf(GenesisLaunchSequenceError);
  });

  test('PUBLIC_LAUNCH=true permits boot once persistence is live (valid activation)', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await setActivation(fake, armedActivation());
    // H4 now has a SECOND edge (mint readiness) that is checked first. This test
    // is about the PERSISTENCE edge, so the mint-readiness conjuncts are satisfied
    // explicitly rather than by accident — otherwise this case would pass or fail
    // for a reason it is not testing.
    const saved = process.env.PVT_MINTING_DELIBERATELY_ENABLED;
    process.env.PVT_MINTING_DELIBERATELY_ENABLED = 'true';
    try {
      await expect(
        enforceGenesisLaunchSequenceAtStartup(db, true, () => true, true),
      ).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.PVT_MINTING_DELIBERATELY_ENABLED;
      else process.env.PVT_MINTING_DELIBERATELY_ENABLED = saved;
    }
  });

  // Shutdown coverage (2026-10-20): past the accrual end line Genesis admits nothing, and the relay
  // must still boot — the final settlement runs on it. A malformed line (Unknown = Block, an end
  // line at 0) must stop minting, never take the relay down.
  test.each(['1', 'not a number'])(
    'PUBLIC_LAUNCH=true still boots past the accrual end line (PVT_ACCRUAL_END_MS=%p)',
    async (endLine) => {
      const fake = createFakeFirestore();
      const db = fake as unknown as Firestore;
      await setActivation(fake, armedActivation());
      const savedMint = process.env.PVT_MINTING_DELIBERATELY_ENABLED;
      const savedEnd = process.env.PVT_ACCRUAL_END_MS;
      process.env.PVT_MINTING_DELIBERATELY_ENABLED = 'true';
      process.env.PVT_ACCRUAL_END_MS = endLine;
      try {
        await expect(
          enforceGenesisLaunchSequenceAtStartup(db, true, () => true, true),
        ).resolves.toBeUndefined();
      } finally {
        if (savedMint === undefined) delete process.env.PVT_MINTING_DELIBERATELY_ENABLED;
        else process.env.PVT_MINTING_DELIBERATELY_ENABLED = savedMint;
        if (savedEnd === undefined) delete process.env.PVT_ACCRUAL_END_MS;
        else process.env.PVT_ACCRUAL_END_MS = savedEnd;
      }
    },
  );

  test('read surfaces report admission closed past the end line while the boot probe stays live', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await setActivation(fake, armedActivation());
    const verify = () => true;
    const savedEnd = process.env.PVT_ACCRUAL_END_MS;
    try {
      delete process.env.PVT_ACCRUAL_END_MS;
      expect(await isGenesisAdmittingNow(db, verify)).toBe(true);
      process.env.PVT_ACCRUAL_END_MS = '1';
      // RED: past the line the read surface says no new grant; the boot probe is untouched.
      expect(await isGenesisAdmittingNow(db, verify)).toBe(false);
      expect(await isGenesisGrantPersistenceLive(db, verify)).toBe(true);
    } finally {
      if (savedEnd === undefined) delete process.env.PVT_ACCRUAL_END_MS;
      else process.env.PVT_ACCRUAL_END_MS = savedEnd;
    }
  });

  test('the mint-readiness edge blocks a launch even when persistence IS live', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await setActivation(fake, armedActivation());
    // Persistence live, activation valid — and boot is still refused, because
    // nobody has declared that minting is on. This is the live posture today.
    delete process.env.PVT_MINTING_DELIBERATELY_ENABLED;
    await expect(
      enforceGenesisLaunchSequenceAtStartup(db, true, () => true, true),
    ).rejects.toBeInstanceOf(GenesisLaunchSequenceError);
  });
});
