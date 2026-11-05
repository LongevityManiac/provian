/**
 * H4's SECOND EDGE — re-pointed at a question that is live today.
 *
 * The persistence edge has been satisfied-not-blocking on every live triple since
 * it shipped, so it has never been observed firing in production. This edge asks:
 * may signup be opened while nothing can mint and no-one has said minting is on?
 *
 * THE NEGATIVE CONTROL the operator asked for is `THE SEVERED CONTROL` below: it severs
 * the condition the guard depends on and shows the assertion FAILING TO FIRE, then
 * restores it and shows it firing again. Without that pair, every green below
 * would be compatible with a guard hard-wired to throw.
 */
import {
  GenesisLaunchSequenceError,
  assertPublicLaunchGatedByMintReadiness,
  collectLaunchMintReadinessRefusals,
  explainLaunchMintReadiness,
  launchMintReadinessPermits,
  resolveMintPathPresence,
  type LaunchMintReadinessVerdict,
  type MintPathConfigView,
} from './genesis-launch-guard';
import { PVT9_BASE_CONFIG } from './pvt9-base-config.generated';

const ON = 'true';

describe('the launch/mint-readiness edge refuses unless BOTH conjuncts hold', () => {
  it('permits when launch is closed — the only no-hazard admit', () => {
    expect(explainLaunchMintReadiness({
      publicLaunch: false, mintingDeliberatelyEnabledRaw: undefined, mintPathPresent: undefined,
    })).toBe('no_hazard_launch_closed');
  });

  it('refuses a launch while the minting flag is ABSENT — the shipped posture today', () => {
    expect(explainLaunchMintReadiness({
      publicLaunch: true, mintingDeliberatelyEnabledRaw: undefined, mintPathPresent: true,
    })).toBe('refused_minting_flag_absent');
    expect(() => assertPublicLaunchGatedByMintReadiness({
      publicLaunch: true, mintingDeliberatelyEnabledRaw: undefined, mintPathPresent: true,
    })).toThrow(GenesisLaunchSequenceError);
  });

  it('refuses an explicit false, and refuses UNKNOWN values under a DIFFERENT verdict', () => {
    expect(explainLaunchMintReadiness({
      publicLaunch: true, mintingDeliberatelyEnabledRaw: 'false', mintPathPresent: true,
    })).toBe('refused_minting_not_enabled');
    for (const raw of ['TRUE', '1', 'yes', 'on']) {
      expect(explainLaunchMintReadiness({
        publicLaunch: true, mintingDeliberatelyEnabledRaw: raw, mintPathPresent: true,
      })).toBe('refused_minting_flag_unknown_value');
    }
  });

  it('refuses on UNKNOWN mint path — never collapsing UNKNOWN into false', () => {
    expect(explainLaunchMintReadiness({
      publicLaunch: true, mintingDeliberatelyEnabledRaw: ON, mintPathPresent: undefined,
    })).toBe('refused_mint_path_unknown');
    expect(explainLaunchMintReadiness({
      publicLaunch: true, mintingDeliberatelyEnabledRaw: ON, mintPathPresent: false,
    })).toBe('refused_mint_path_absent');
  });

  it('permits ONLY when both conjuncts affirmatively hold', () => {
    expect(explainLaunchMintReadiness({
      publicLaunch: true, mintingDeliberatelyEnabledRaw: ON, mintPathPresent: true,
    })).toBe('permitted_minting_deliberately_enabled');
  });

  it('the admit set is closed over the whole verdict union', () => {
    const all: LaunchMintReadinessVerdict[] = [
      'no_hazard_launch_closed', 'permitted_minting_deliberately_enabled',
      'refused_minting_flag_absent', 'refused_minting_flag_unknown_value',
      'refused_minting_not_enabled', 'refused_mint_path_absent', 'refused_mint_path_unknown',
    ];
    expect(all).toHaveLength(7);
    expect(all.filter(launchMintReadinessPermits))
      .toEqual(['no_hazard_launch_closed', 'permitted_minting_deliberately_enabled']);
  });
});

describe('THE SEVERED CONTROL — the guard is shown FAILING to fire, then restored', () => {
  it('severing the hazard makes the assertion silent; restoring it makes it throw', () => {
    // The hazard the guard exists for: launch open, minting undeclared.
    const hazard = {
      publicLaunch: true,
      mintingDeliberatelyEnabledRaw: undefined,
      mintPathPresent: true,
    } as const;

    // 1. RESTORED (the real condition) — it fires.
    expect(() => assertPublicLaunchGatedByMintReadiness(hazard)).toThrow(GenesisLaunchSequenceError);

    // 2. SEVERED — flip the single conjunct the guard keys on. If the guard were
    //    hard-wired to throw, or keyed on something it does not actually read,
    //    this would still throw and the green above would mean nothing.
    let fired = false;
    try {
      assertPublicLaunchGatedByMintReadiness({ ...hazard, publicLaunch: false });
    } catch { fired = true; }
    expect(fired).toBe(false);

    // 3. RESTORED again, to prove step 2 did not leave the guard disarmed.
    expect(() => assertPublicLaunchGatedByMintReadiness(hazard)).toThrow(GenesisLaunchSequenceError);
  });

  it('each conjunct is individually load-bearing: negating any ONE flips the verdict', () => {
    const permitting = {
      publicLaunch: true, mintingDeliberatelyEnabledRaw: ON, mintPathPresent: true,
    } as const;
    expect(explainLaunchMintReadiness(permitting)).toBe('permitted_minting_deliberately_enabled');
    // Negate exactly one conjunct at a time; each must refuse on its own.
    expect(explainLaunchMintReadiness({ ...permitting, mintingDeliberatelyEnabledRaw: undefined }))
      .toBe('refused_minting_flag_absent');
    expect(explainLaunchMintReadiness({ ...permitting, mintPathPresent: false }))
      .toBe('refused_mint_path_absent');
  });
});

// The boot error must name EVERY failing conjunct, not just the first (audit 2026-08-05).
// The two conjuncts are evaluated independently, so an operator sees both to fix.
describe('the boot error names every failing conjunct', () => {
  it('collects BOTH refusals when neither conjunct holds', () => {
    expect(collectLaunchMintReadinessRefusals({
      publicLaunch: true, mintingDeliberatelyEnabledRaw: undefined, mintPathPresent: false,
    })).toEqual(['refused_minting_flag_absent', 'refused_mint_path_absent']);
  });

  it('the thrown error text carries BOTH names — RED against the old single-verdict message', () => {
    let message = '';
    try {
      assertPublicLaunchGatedByMintReadiness({
        publicLaunch: true, mintingDeliberatelyEnabledRaw: undefined, mintPathPresent: undefined,
      });
    } catch (e) { message = e instanceof Error ? e.message : String(e); }
    // The pre-change error named a single verdict, so it could not contain both at once.
    expect(message).toContain('refused_minting_flag_absent');
    expect(message).toContain('refused_mint_path_unknown');
  });

  it('empty means permitted — launch closed, or both conjuncts hold', () => {
    expect(collectLaunchMintReadinessRefusals({
      publicLaunch: false, mintingDeliberatelyEnabledRaw: undefined, mintPathPresent: undefined,
    })).toEqual([]);
    expect(collectLaunchMintReadinessRefusals({
      publicLaunch: true, mintingDeliberatelyEnabledRaw: ON, mintPathPresent: true,
    })).toEqual([]);
  });
});

// The mint-path probe reads ONLY the pinned config : the deployed
// kernel in config/pvt9-base.json. NOTHING reads a kernel address from env — not the
// retired orphan PVT9_CONTRACT_ADDRESS, not the retired PVT_CONTRACT_ADDRESS, and not the
// PVT_CONTRACT_ADDRESS_BASE live Cloud Run happens to carry. The config is bound from
// PVT9_BASE_CONFIG (the source the code reads), never a redeclared literal copy.
describe('resolveMintPathPresence reads the pinned config kernel, never env', () => {
  const CONFIG_KERNEL = PVT9_BASE_CONFIG.assets.pvt9.address;
  const ENV_KEYS = [
    'PVT_CONTRACT_ADDRESS',
    'PVT_CONTRACT_ADDRESS_BASE',
    'PVT9_CONTRACT_ADDRESS',
    'PVT_MINTING_DELIBERATELY_ENABLED',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** The real pinned config with its kernel replaced — the violating shapes. */
  const withKernel = (pvt9: Record<string, unknown>, forbidden?: unknown): MintPathConfigView => ({
    assets: { pvt9: { ...PVT9_BASE_CONFIG.assets.pvt9, ...pvt9 } },
    validation: {
      forbidden_pvt_addresses: forbidden === undefined
        ? PVT9_BASE_CONFIG.validation.forbidden_pvt_addresses
        : forbidden,
    },
  });

  it('the pinned config names a deployed, valid non-zero, non-forbidden kernel', () => {
    expect(PVT9_BASE_CONFIG.assets.pvt9.deployment_status).toBe('deployed');
    expect(CONFIG_KERNEL).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(CONFIG_KERNEL).not.toBe(`0x${'0'.repeat(40)}`);
    expect(PVT9_BASE_CONFIG.validation.forbidden_pvt_addresses.map((a) => a.toLowerCase()))
      .not.toContain(CONFIG_KERNEL.toLowerCase());
    expect(resolveMintPathPresence()).toBe(true);
  });

  it('env is never read: no kernel env var at all is still PRESENT; a wrong one changes nothing', () => {
    for (const k of ['PVT_CONTRACT_ADDRESS', 'PVT_CONTRACT_ADDRESS_BASE', 'PVT9_CONTRACT_ADDRESS']) {
      delete process.env[k];
    }
    expect(resolveMintPathPresence()).toBe(true);
    // The abandoned kernel in every env name the code once read (or might be tempted to).
    for (const k of ['PVT_CONTRACT_ADDRESS', 'PVT_CONTRACT_ADDRESS_BASE', 'PVT9_CONTRACT_ADDRESS']) {
      process.env[k] = '0x8b2306be03bA3ACAA81a891f9c3749df5eF66c61';
    }
    expect(resolveMintPathPresence()).toBe(true);
    // ...and env cannot CREATE a mint path the pinned config lacks.
    process.env.PVT_CONTRACT_ADDRESS = CONFIG_KERNEL;
    process.env.PVT_CONTRACT_ADDRESS_BASE = CONFIG_KERNEL;
    expect(resolveMintPathPresence(withKernel({ address: null, deployment_status: 'not_deployed' })))
      .toBe(false);
  });

  it('RED: a pinned config with NO deployed kernel is ABSENT and the launch is refused', () => {
    for (const shape of [
      { deployment_status: 'not_deployed' },
      { address: null },
      { address: '' },
      { address: `0x${'0'.repeat(40)}` },
      { abi: [] },
      { abi: null },
    ]) {
      const present = resolveMintPathPresence(withKernel(shape));
      expect(present).toBe(false);
      expect(explainLaunchMintReadiness({
        publicLaunch: true, mintingDeliberatelyEnabledRaw: ON, mintPathPresent: present,
      })).toBe('refused_mint_path_absent');
    }
  });

  it('RED: a malformed kernel field is UNKNOWN, not absent — refuses under its own verdict', () => {
    for (const shape of [
      { address: '0xnope' }, { address: '0x1234' }, { address: 42 }, { deployment_status: undefined },
      { abi: 42 }, { abi: 'x' },
    ]) {
      const present = resolveMintPathPresence(withKernel(shape));
      expect(present).toBeUndefined();
      expect(explainLaunchMintReadiness({
        publicLaunch: true, mintingDeliberatelyEnabledRaw: ON, mintPathPresent: present,
      })).toBe('refused_mint_path_unknown');
    }
  });

  it('RED: a pinned kernel on forbidden_pvt_addresses (the abandoned/retired kernels) is UNKNOWN', () => {
    expect(resolveMintPathPresence(withKernel({ address: '0x8b2306be03bA3ACAA81a891f9c3749df5eF66c61' }, [
      ...PVT9_BASE_CONFIG.validation.forbidden_pvt_addresses,
      '0x8b2306be03bA3ACAA81a891f9c3749df5eF66c61',
    ]))).toBeUndefined();
    // The live kernel itself forbidden — case-insensitively.
    expect(resolveMintPathPresence(withKernel({}, [CONFIG_KERNEL.toUpperCase().replace('0X', '0x')])))
      .toBeUndefined();
    // An unreadable forbidden list cannot be checked, so it cannot admit.
    expect(resolveMintPathPresence(withKernel({}, 'not-a-list'))).toBeUndefined();
    expect(resolveMintPathPresence(withKernel({}, [42]))).toBeUndefined();
  });

  it('RED: the deliberate-enable flag absent refuses even on the live env shape', () => {
    delete process.env.PVT_CONTRACT_ADDRESS;
    process.env.PVT_CONTRACT_ADDRESS_BASE = CONFIG_KERNEL;
    delete process.env.PVT_MINTING_DELIBERATELY_ENABLED;
    expect(explainLaunchMintReadiness({
      publicLaunch: true,
      mintingDeliberatelyEnabledRaw: process.env.PVT_MINTING_DELIBERATELY_ENABLED,
      mintPathPresent: resolveMintPathPresence(),
    })).toBe('refused_minting_flag_absent');
    expect(() => assertPublicLaunchGatedByMintReadiness({
      publicLaunch: true,
      mintingDeliberatelyEnabledRaw: process.env.PVT_MINTING_DELIBERATELY_ENABLED,
      mintPathPresent: resolveMintPathPresence(),
    })).toThrow(GenesisLaunchSequenceError);
  });

  // BOOT-PROOF (the local stand-in for the FLIP_RUNBOOK canary rehearsal): on the LIVE
  // Cloud Run env shape — no PVT_CONTRACT_ADDRESS, only PVT_CONTRACT_ADDRESS_BASE, which
  // nothing reads — plus PUBLIC_LAUNCH=true and PVT_MINTING_DELIBERATELY_ENABLED=true,
  // the mint-readiness edge ADMITS (no throw).
  it('BOOT-PROOF: live env shape + the deliberate flag admits the mint-readiness edge', () => {
    delete process.env.PVT_CONTRACT_ADDRESS;
    delete process.env.PVT9_CONTRACT_ADDRESS;
    process.env.PVT_CONTRACT_ADDRESS_BASE = CONFIG_KERNEL;
    process.env.PVT_MINTING_DELIBERATELY_ENABLED = 'true';
    expect(() => assertPublicLaunchGatedByMintReadiness({
      publicLaunch: true,
      mintingDeliberatelyEnabledRaw: process.env.PVT_MINTING_DELIBERATELY_ENABLED,
      mintPathPresent: resolveMintPathPresence(),
    })).not.toThrow();
  });
});
