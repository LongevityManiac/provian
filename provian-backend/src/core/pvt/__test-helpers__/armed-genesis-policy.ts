import {
  PROPOSED_GENESIS_CAMPAIGN_POLICY,
  type ProposedGenesisCampaignPolicyManifest,
} from '../policy/proposed-genesis-policy';

/** Synthetic protocol time used only by local tests; it is not a launch date. */
export const TEST_GENESIS_WINDOW_START_MS = 1_000_000;
/** Broad arbitrary boundary; neither its endpoints nor duration are policy. */
export const TEST_GENESIS_WINDOW_END_MS = Number.MAX_SAFE_INTEGER - 1;

const CHECKED_IN_WINDOW = { ...PROPOSED_GENESIS_CAMPAIGN_POLICY.window };
const CHECKED_IN_ARMING = { ...PROPOSED_GENESIS_CAMPAIGN_POLICY.arming };
const CHECKED_IN_BOUNTIES = PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.map(
  (bounty) => ({ ...bounty }),
);

export type ArmedTestGenesisCampaignPolicy = ProposedGenesisCampaignPolicyManifest & {
  readonly window: ProposedGenesisCampaignPolicyManifest['window'] & {
    readonly start_ms: number;
    readonly end_ms: number;
  };
};

export function createArmedGenesisPolicyForTest(): ArmedTestGenesisCampaignPolicy {
  return {
    ...PROPOSED_GENESIS_CAMPAIGN_POLICY,
    arming: {
      ...PROPOSED_GENESIS_CAMPAIGN_POLICY.arming,
      state: 'armed_by_explicit_pvt9_activation',
      grants_enabled: true,
      canonical_pvt_manifest_id: 'test-only-pvt9-manifest',
      ledger_namespace: 'test-only-genesis-ledger',
    },
    window: {
      ...PROPOSED_GENESIS_CAMPAIGN_POLICY.window,
      start_ms: TEST_GENESIS_WINDOW_START_MS,
      end_ms: TEST_GENESIS_WINDOW_END_MS,
      approval: {
        status: 'wp12_launch_dates_explicitly_approved',
        rationale: 'Synthetic test boundary only; this is not launch approval.',
      },
    },
    bounties: PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.map((bounty) => ({
      ...bounty,
      launch_armed: true,
      activation: 'explicit_pvt9_launch_activation' as const,
    })),
  };
}

/**
 * Some state-machine integration tests intentionally exercise the future armed
 * path through modules that consume the checked-in singleton. Mutating that
 * singleton is allowed only inside Jest's isolated test environment.
 */
export function installArmedGenesisPolicyForTest(): ArmedTestGenesisCampaignPolicy {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Synthetic Genesis policy may only be installed in tests');
  }
  const armed = createArmedGenesisPolicyForTest();
  Object.assign(
    PROPOSED_GENESIS_CAMPAIGN_POLICY.arming as unknown as Record<string, unknown>,
    armed.arming,
  );
  Object.assign(
    PROPOSED_GENESIS_CAMPAIGN_POLICY.window as unknown as Record<string, unknown>,
    armed.window,
  );
  for (let index = 0; index < armed.bounties.length; index += 1) {
    Object.assign(
      PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties[index] as unknown as Record<string, unknown>,
      armed.bounties[index],
    );
  }
  return PROPOSED_GENESIS_CAMPAIGN_POLICY as ArmedTestGenesisCampaignPolicy;
}

export function restoreCheckedInGenesisPolicyAfterTest(): void {
  Object.assign(
    PROPOSED_GENESIS_CAMPAIGN_POLICY.arming as unknown as Record<string, unknown>,
    CHECKED_IN_ARMING,
  );
  Object.assign(
    PROPOSED_GENESIS_CAMPAIGN_POLICY.window as unknown as Record<string, unknown>,
    CHECKED_IN_WINDOW,
  );
  for (let index = 0; index < CHECKED_IN_BOUNTIES.length; index += 1) {
    Object.assign(
      PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties[index] as unknown as Record<string, unknown>,
      CHECKED_IN_BOUNTIES[index],
    );
  }
}
