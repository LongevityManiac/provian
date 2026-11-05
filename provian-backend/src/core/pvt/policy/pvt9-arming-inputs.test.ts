import {
  assemblePvt9ArmingInputs,
  KERNEL_BOOTSTRAP_ADMIN,
  loadPvt9ArmingInputs,
  PVT9_ARMING_INPUTS,
  type Pvt9ArmingInputSurface,
  type Pvt9GenesisWindow,
} from './pvt9-arming-inputs';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './proposed-genesis-policy';

// The decided values. Duplicated here as an independent
// expectation so a silent edit of the surface is caught by a failing test.
const EXPECT = {
  bootstrapAdmin: '0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3',
  provianTreasury: '0x086e0F377af1245B8888540f39e99A42a7daF1dA',
  foundationTreasury: '0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936',
  operationalMinter: '0xF0Ea014CAa37C34aF5D0a7F646ad7d7A79C09dF7',
  batchApprover: '0xbFe2a6c929B5Ea5F09e68545BC2A63065da0209c',
  configurationId: '0xe0ee2de78a611198a17183b8505ed321902ba64b6577e2f1cb04a24e37cf23cb',
  configurationVersion: 1,
  // reset: the same 84-day window moved LATER by seven days, because the
  // successor kernel must be armed and `armEpochZero` requires
  // epochZeroStartsAt strictly in the future — the window is
  // now in the past. epochZeroStartsAt is DERIVED from the window open, so these
  // two are equal by construction, not by two independently maintained literals.
  epochZeroStartsAtMs: Date.UTC(2026, 7, 3),
  genesisStartsAtMs: Date.UTC(2026, 7, 3),
  // the close moved to 2027-01-01T00:00:00Z (open through 2026-12-31).
  genesisEndsAtMs: Date.UTC(2027, 0, 1),
} as const;

const APPROVED_WINDOW: Pvt9GenesisWindow = {
  startMs: EXPECT.genesisStartsAtMs,
  endMs: EXPECT.genesisEndsAtMs,
  approvalStatus: 'wp12_launch_dates_explicitly_approved',
};

// A deep clone of the real surface so per-field mutation tests never share nested refs.
function surfaceWith(overrides: Partial<Omit<Pvt9ArmingInputSurface, 'eligibilityVerifier'>> & {
  eligibilityVerifier?: Partial<Pvt9ArmingInputSurface['eligibilityVerifier']>;
} = {}): Pvt9ArmingInputSurface {
  return {
    provianTreasury: overrides.provianTreasury ?? PVT9_ARMING_INPUTS.provianTreasury,
    foundationTreasury: overrides.foundationTreasury ?? PVT9_ARMING_INPUTS.foundationTreasury,
    operationalMinter: overrides.operationalMinter ?? PVT9_ARMING_INPUTS.operationalMinter,
    batchApprover: overrides.batchApprover ?? PVT9_ARMING_INPUTS.batchApprover,
    eligibilityVerifier: {
      configurationId:
        overrides.eligibilityVerifier?.configurationId
        ?? PVT9_ARMING_INPUTS.eligibilityVerifier.configurationId,
      configurationVersion:
        overrides.eligibilityVerifier?.configurationVersion
        ?? PVT9_ARMING_INPUTS.eligibilityVerifier.configurationVersion,
    },
    epochZeroStartsAt: overrides.epochZeroStartsAt ?? PVT9_ARMING_INPUTS.epochZeroStartsAt,
  };
}

describe('PVT9 arming inputs — the checked-in surface holds every decided value', () => {
  test('the configurable surface holds NO admin slot (bootstrapAdmin is a kernel constant)', () => {
    expect(Object.keys(PVT9_ARMING_INPUTS).sort()).toEqual([
      'batchApprover',
      'eligibilityVerifier',
      'epochZeroStartsAt',
      'foundationTreasury',
      'operationalMinter',
      'provianTreasury',
    ]);
    // No key on the surface (or its nested verifier block) resembles an admin/owner slot.
    const allKeys = [
      ...Object.keys(PVT9_ARMING_INPUTS),
      ...Object.keys(PVT9_ARMING_INPUTS.eligibilityVerifier),
    ].map((k) => k.toLowerCase());
    for (const forbidden of ['admin', 'owner', 'bootstrap', 'governor', 'executor']) {
      expect(allKeys.some((k) => k.includes(forbidden))).toBe(false);
    }
    expect(KERNEL_BOOTSTRAP_ADMIN).toBe(EXPECT.bootstrapAdmin);
  });

  test('the surface literals equal the decided values exactly', () => {
    expect(PVT9_ARMING_INPUTS.provianTreasury).toBe(EXPECT.provianTreasury);
    expect(PVT9_ARMING_INPUTS.foundationTreasury).toBe(EXPECT.foundationTreasury);
    expect(PVT9_ARMING_INPUTS.operationalMinter).toBe(EXPECT.operationalMinter);
    expect(PVT9_ARMING_INPUTS.batchApprover).toBe(EXPECT.batchApprover);
    expect(PVT9_ARMING_INPUTS.eligibilityVerifier.configurationId).toBe(EXPECT.configurationId);
    expect(PVT9_ARMING_INPUTS.eligibilityVerifier.configurationVersion).toBe(EXPECT.configurationVersion);
    expect(PVT9_ARMING_INPUTS.epochZeroStartsAt).toBe('2026-08-03T00:00:00Z');
    // R5: derived from the policy window, never a second hardcoded copy.
    expect(Date.parse(PVT9_ARMING_INPUTS.epochZeroStartsAt))
      .toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms);
  });
});

describe('PVT9 arming inputs — loadPvt9ArmingInputs reads every value from the real config', () => {
  test('reads all five addresses, both verifier args, and all three instants', () => {
    const inputs = loadPvt9ArmingInputs();

    expect(inputs.bootstrapAdmin).toBe(EXPECT.bootstrapAdmin);
    expect(inputs.appointments.operationalMinter).toBe(EXPECT.operationalMinter);
    expect(inputs.appointments.batchApprover).toBe(EXPECT.batchApprover);
    expect(inputs.eligibilityVerifierConstructor.configurationId).toBe(EXPECT.configurationId);
    expect(inputs.eligibilityVerifierConstructor.configurationVersion).toBe(EXPECT.configurationVersion);
    expect(inputs.epochZeroConfig.provianTreasury).toBe(EXPECT.provianTreasury);
    expect(inputs.epochZeroConfig.foundationTreasury).toBe(EXPECT.foundationTreasury);

    expect(inputs.instants.epochZeroStartsAtMs).toBe(EXPECT.epochZeroStartsAtMs);
    expect(inputs.instants.genesisStartsAtMs).toBe(EXPECT.genesisStartsAtMs);
    expect(inputs.instants.genesisEndsAtMs).toBe(EXPECT.genesisEndsAtMs);
    expect(inputs.instants.epochZeroStartsAtIso).toBe('2026-08-03T00:00:00.000Z');
    expect(inputs.instants.genesisEndsAtIso).toBe('2027-01-01T00:00:00.000Z');

    // On-chain seconds (uint64), matching ProvianPVT9.EpochZeroConfig.
    expect(inputs.epochZeroConfig.epochZeroStartsAtSec).toBe(EXPECT.epochZeroStartsAtMs / 1000);
    expect(inputs.epochZeroConfig.genesisStartsAtSec).toBe(EXPECT.genesisStartsAtMs / 1000);
    expect(inputs.epochZeroConfig.genesisEndsAtSec).toBe(EXPECT.genesisEndsAtMs / 1000);
  });

  test('the Genesis window is read from proposed-genesis-policy — the two homes agree', () => {
    const inputs = loadPvt9ArmingInputs();
    // Proves there is no second, drifting copy of the dates: the loader's genesis instants
    // are exactly what proposed-genesis-policy.ts declares in its window.
    expect(inputs.instants.genesisStartsAtMs).toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms);
    expect(inputs.instants.genesisEndsAtMs).toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms);
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.approval.status)
      .toBe('wp12_launch_dates_explicitly_approved');
  });

  // . Every existing guard on "epochZeroStartsAt is DERIVED, not a
  // second copy" is INDIRECT: the equality tests above pass identically if the
  // module holds a hardcoded literal that happens to equal the current window, and
  // `scanForEpochZeroDefinitions()` (cutover-wp12r2.test.ts) is a filesystem regex
  // over date-shaped literals — a proxy, not the behaviour. This test proves the
  // behaviour directly: MOVE the window underneath the module, re-import it, and
  // require the derivation to follow. A hardcoded literal keeps the old date and
  // turns this RED, which is exactly its negative control (see the test below).
  test('the derivation FOLLOWS the window — moving window.start_ms moves epochZeroStartsAt', () => {
    const MOVED_START = Date.UTC(2027, 2, 9); // 2027-03-09, unrelated to any real window
    const MOVED_END = MOVED_START + 84 * 86_400_000;

    jest.resetModules();
    jest.doMock('./proposed-genesis-policy', () => ({
      ...jest.requireActual('./proposed-genesis-policy'),
      PROPOSED_GENESIS_CAMPAIGN_POLICY: {
        ...jest.requireActual('./proposed-genesis-policy').PROPOSED_GENESIS_CAMPAIGN_POLICY,
        window: {
          ...jest.requireActual('./proposed-genesis-policy').PROPOSED_GENESIS_CAMPAIGN_POLICY.window,
          start_ms: MOVED_START,
          end_ms: MOVED_END,
        },
      },
    }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const moved = require('./pvt9-arming-inputs') as typeof import('./pvt9-arming-inputs');
      // The derivation tracked the moved window…
      expect(moved.PVT9_ARMING_INPUTS.epochZeroStartsAt).toBe('2027-03-09T00:00:00Z');
      expect(Date.parse(moved.PVT9_ARMING_INPUTS.epochZeroStartsAt)).toBe(MOVED_START);
      // …and it is NOT the checked-in date, which is what a second copy would return.
      expect(moved.PVT9_ARMING_INPUTS.epochZeroStartsAt)
        .not.toBe(PVT9_ARMING_INPUTS.epochZeroStartsAt);
      // The whole loader follows too, not just the surface literal.
      const inputs = moved.loadPvt9ArmingInputs();
      expect(inputs.instants.epochZeroStartsAtMs).toBe(MOVED_START);
      expect(inputs.epochZeroConfig.epochZeroStartsAtSec).toBe(MOVED_START / 1000);
    } finally {
      jest.dontMock('./proposed-genesis-policy');
      jest.resetModules();
    }
  });

  test('NEGATIVE CONTROL — a second copy diverges from the window SILENTLY in production code', () => {
    // The permanent in-suite control for the derivation test above : feed
    // the VIOLATING INPUT to production code and assert the violation is real.
    //
    // The violating input is the exact defect found: a surface whose
    // `epochZeroStartsAt` is an independently-maintained copy, while the approved
    // window has moved underneath it. Constructed here against the real assembler.
    const MOVED_START = Date.UTC(2027, 2, 9);
    const MOVED_END = MOVED_START + 84 * 86_400_000;
    const withSecondCopy = assemblePvt9ArmingInputs(
      surfaceWith({ epochZeroStartsAt: PVT9_ARMING_INPUTS.epochZeroStartsAt }),
      {
        startMs: MOVED_START,
        endMs: MOVED_END,
        approvalStatus: 'wp12_launch_dates_explicitly_approved',
      },
    );

    // THE FINDING, and the reason the single derivation is load-bearing: the
    // assembler ACCEPTS this without throwing. Every validation it performs still
    // holds — `epochZeroStartsAt <= genesisStartsAt` is satisfied by a copy that is
    // merely EARLIER than the moved window — so no guard downstream of the surface
    // can see the staleness. Only having one derivation prevents it.
    expect(withSecondCopy.instants.epochZeroStartsAtMs)
      .toBe(Date.parse(PVT9_ARMING_INPUTS.epochZeroStartsAt));
    expect(withSecondCopy.instants.epochZeroStartsAtMs).not.toBe(MOVED_START);
    expect(withSecondCopy.instants.genesisStartsAtMs).toBe(MOVED_START);
    // Silently diverged — and this is the value that would have been armed, one
    // time and permanently, at an instant the policy manifest no longer approves.
    expect(withSecondCopy.instants.genesisStartsAtMs - withSecondCopy.instants.epochZeroStartsAtMs)
      .toBe(MOVED_START - Date.parse(PVT9_ARMING_INPUTS.epochZeroStartsAt));
    expect(withSecondCopy.instants.genesisStartsAtMs)
      .toBeGreaterThan(withSecondCopy.instants.epochZeroStartsAtMs);
  });

  test('ordering epochZero <= genesisStart < genesisEnd holds on the real values', () => {
    const inputs = loadPvt9ArmingInputs();
    expect(inputs.instants.epochZeroStartsAtMs).toBeLessThanOrEqual(inputs.instants.genesisStartsAtMs);
    expect(inputs.instants.genesisStartsAtMs).toBeLessThan(inputs.instants.genesisEndsAtMs);
  });

  test('all three instants are in the future as of the authoring date (2026-07-24)', () => {
    const commitDay = Date.UTC(2026, 6, 24);
    // Succeeds with the future-check anchored before the launch window.
    expect(() => loadPvt9ArmingInputs({ nowMsForFutureCheck: commitDay })).not.toThrow();
    const inputs = loadPvt9ArmingInputs({ nowMsForFutureCheck: commitDay });
    expect(inputs.instants.epochZeroStartsAtMs).toBeGreaterThan(commitDay);
  });

  test('the future-check rejects once the window is in the past (arm-time precondition)', () => {
    const afterEnd = Date.UTC(2026, 10, 15); // 2026-11-15, past genesisEnd
    expect(() => loadPvt9ArmingInputs({ nowMsForFutureCheck: afterEnd }))
      .toThrow(/must be in the future/);
  });
});

describe('PVT9 arming inputs — validation rejects every malformed input', () => {
  test('a valid synthetic surface + approved window assembles', () => {
    expect(() => assemblePvt9ArmingInputs(surfaceWith(), APPROVED_WINDOW)).not.toThrow();
  });

  test('rejects a non-EIP-55 (all-lowercase) address', () => {
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith({ provianTreasury: PVT9_ARMING_INPUTS.provianTreasury.toLowerCase() }),
      APPROVED_WINDOW,
    )).toThrow(/provianTreasury is not EIP-55 checksummed/);
  });

  test('rejects a structurally invalid address', () => {
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith({ operationalMinter: '0xnothexvalue' }),
      APPROVED_WINDOW,
    )).toThrow(/operationalMinter is not a valid EVM address/);
  });

  test('rejects the zero address', () => {
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith({ batchApprover: '0x0000000000000000000000000000000000000000' }),
      APPROVED_WINDOW,
    )).toThrow(/batchApprover must not be the zero address/);
  });

  test('rejects a role address colliding with another role', () => {
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith({ foundationTreasury: PVT9_ARMING_INPUTS.provianTreasury }),
      APPROVED_WINDOW,
    )).toThrow(/must be distinct but provianTreasury == foundationTreasury/);
  });

  test('rejects a role address colliding with the bootstrap admin constant', () => {
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith({ operationalMinter: KERNEL_BOOTSTRAP_ADMIN }),
      APPROVED_WINDOW,
    )).toThrow(/must be distinct but bootstrapAdmin == operationalMinter/);
  });

  test('rejects a zero / wrong-length configurationId', () => {
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith({ eligibilityVerifier: { configurationId: `0x${'0'.repeat(64)}` } }),
      APPROVED_WINDOW,
    )).toThrow(/configurationId must be non-zero/);
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith({ eligibilityVerifier: { configurationId: '0xdeadbeef' } }),
      APPROVED_WINDOW,
    )).toThrow(/configurationId must be a 32-byte hex string/);
  });

  test('rejects a non-positive configurationVersion', () => {
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith({ eligibilityVerifier: { configurationVersion: 0 } }),
      APPROVED_WINDOW,
    )).toThrow(/configurationVersion must be a positive uint64/);
  });

  test('rejects an epochZeroStartsAt that is not a strict UTC (Z) instant', () => {
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith({ epochZeroStartsAt: '2026-08-16T00:00:00' }),
      APPROVED_WINDOW,
    )).toThrow(/epochZeroStartsAt must be an ISO-8601 UTC instant ending in Z/);
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith({ epochZeroStartsAt: '2026-08-16T00:00:00+02:00' }),
      APPROVED_WINDOW,
    )).toThrow(/epochZeroStartsAt must be an ISO-8601 UTC instant ending in Z/);
  });

  test('rejects epochZeroStartsAt after genesisStartsAt', () => {
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith({ epochZeroStartsAt: '2026-08-23T00:00:00Z' }),
      APPROVED_WINDOW,
    )).toThrow(/require epochZeroStartsAt <= genesisStartsAt/);
  });

  test('rejects genesisEndsAt not after genesisStartsAt', () => {
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith(),
      { ...APPROVED_WINDOW, endMs: APPROVED_WINDOW.startMs },
    )).toThrow(/require genesisStartsAt < genesisEndsAt/);
  });

  test('rejects a null / unapproved Genesis window (fail closed)', () => {
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith(),
      { startMs: null, endMs: null, approvalStatus: 'requires_wp12_launch_date_approval' },
    )).toThrow(/approval is not wp12_launch_dates_explicitly_approved/);
    expect(() => assemblePvt9ArmingInputs(
      surfaceWith(),
      { startMs: null, endMs: EXPECT.genesisEndsAtMs, approvalStatus: 'wp12_launch_dates_explicitly_approved' },
    )).toThrow(/genesisStartsAt \(window\.start_ms\) must be a non-negative safe-integer/);
  });
});
