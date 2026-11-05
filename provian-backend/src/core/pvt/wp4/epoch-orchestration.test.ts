import {
  DEFAULT_BOUNDARY_SAFETY_MARGIN_SEC,
  PVT9_EPOCH_DURATION_SEC,
  evaluateBatchResumption,
  evaluateEpochGate,
  planEpochAdvance,
  wallClockEpoch,
  type KernelEpochObservation,
  type PreparedBatchBinding,
  type SettlementObservation,
} from './epoch-orchestration';

const EPOCH_ZERO = 1_800_000_000;
const SIGNER = '0xabcdef0123456789abcdef0123456789abcdef01';
const OTHER_MINTER = '0xfedcba9876543210fedcba9876543210fedcba98';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const POLICY_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_POLICY_HASH = `0x${'cd'.repeat(32)}`;

/** Chain time `offsetSec` into `epoch`. */
function at(epoch: number, offsetSec: number): number {
  return EPOCH_ZERO + epoch * PVT9_EPOCH_DURATION_SEC + offsetSec;
}

function observation(overrides: Partial<KernelEpochObservation> = {}): KernelEpochObservation {
  return {
    epochZeroArmed: true,
    epochZeroStartsAtSec: EPOCH_ZERO,
    lastOpenedEpoch: 3,
    administrativeHold: false,
    operationalMinter: SIGNER,
    settlementSigner: SIGNER,
    observedAtSec: at(3, 3_600),
    ...overrides,
  };
}

describe('PVT9_EPOCH_DURATION_SEC', () => {
  it('equals the kernel EPOCH_DURATION of 7 days', () => {
    // Pinned as a literal on purpose: `at()` below is defined in terms of this
    // constant, so every other boundary assertion would survive a typo here.
    expect(PVT9_EPOCH_DURATION_SEC).toBe(604_800);
    expect(PVT9_EPOCH_DURATION_SEC).toBe(7 * 24 * 60 * 60);
  });
});

function settlementObservation(
  overrides: Partial<SettlementObservation> = {},
): SettlementObservation {
  return {
    ...observation(),
    nextFinalizedCursor: 1_000n,
    openEpochPolicyHash: POLICY_HASH,
    ...overrides,
  };
}

function binding(overrides: Partial<PreparedBatchBinding> = {}): PreparedBatchBinding {
  return {
    epoch: 3,
    policyHash: POLICY_HASH,
    cursorStart: 1_000n,
    cursorEnd: 1_400n,
    ...overrides,
  };
}

describe('wallClockEpoch', () => {
  it('floors chain time into the epoch the kernel would compute', () => {
    expect(wallClockEpoch(observation({ observedAtSec: EPOCH_ZERO }))).toBe(0);
    expect(wallClockEpoch(observation({ observedAtSec: at(0, PVT9_EPOCH_DURATION_SEC - 1) }))).toBe(0);
    expect(wallClockEpoch(observation({ observedAtSec: at(1, 0) }))).toBe(1);
    expect(wallClockEpoch(observation({ observedAtSec: at(11, 5) }))).toBe(11);
  });

  it('is null before epoch zero and on an unreadable snapshot', () => {
    expect(wallClockEpoch(observation({ observedAtSec: EPOCH_ZERO - 1 }))).toBeNull();
    expect(wallClockEpoch(observation({ observedAtSec: Number.NaN }))).toBeNull();
    expect(wallClockEpoch(observation({ epochZeroStartsAtSec: -1 }))).toBeNull();
  });
});

describe('evaluateEpochGate', () => {
  it('opens mid-epoch and reports the distance to the boundary', () => {
    const gate = evaluateEpochGate(observation(), DEFAULT_BOUNDARY_SAFETY_MARGIN_SEC);
    expect(gate).toEqual({
      kind: 'open',
      epoch: 3,
      secondsUntilBoundary: PVT9_EPOCH_DURATION_SEC - 3_600,
    });
  });

  it('requires one openNextEpoch call per missed epoch', () => {
    expect(
      evaluateEpochGate(
        observation({ lastOpenedEpoch: 3, observedAtSec: at(4, 60) }),
        DEFAULT_BOUNDARY_SAFETY_MARGIN_SEC,
      ),
    ).toEqual({
      kind: 'advance_required',
      wallClockEpoch: 4,
      lastOpenedEpoch: 3,
      openNextEpochCallsRequired: 1,
    });

    expect(
      evaluateEpochGate(
        observation({ lastOpenedEpoch: 3, observedAtSec: at(6, 60) }),
        DEFAULT_BOUNDARY_SAFETY_MARGIN_SEC,
      ),
    ).toEqual({
      kind: 'advance_required',
      wallClockEpoch: 6,
      lastOpenedEpoch: 3,
      openNextEpochCallsRequired: 3,
    });
  });

  it('closes inside the boundary margin, because inclusion can land past it', () => {
    const marginSec = 120;
    // Exactly `marginSec` left: refused (the boundary is reachable).
    expect(
      evaluateEpochGate(
        observation({ observedAtSec: at(4, 0) - marginSec }),
        marginSec,
      ),
    ).toEqual({ kind: 'closed', reason: 'boundary_margin' });

    // One second more: allowed.
    expect(
      evaluateEpochGate(observation({ observedAtSec: at(4, 0) - marginSec - 1 }), marginSec),
    ).toEqual({ kind: 'open', epoch: 3, secondsUntilBoundary: marginSec + 1 });
  });

  it('closes when the operational minter is revoked or repointed elsewhere', () => {
    // `onlyOperationalMinter` tests IDENTITY, and `appointOperationalMinter`
    // has no one-time guard, so a rotation away from us must close the gate.
    expect(evaluateEpochGate(observation({ operationalMinter: null }), 0))
      .toEqual({ kind: 'closed', reason: 'operational_minter_revoked' });
    expect(evaluateEpochGate(observation({ operationalMinter: OTHER_MINTER }), 0))
      .toEqual({ kind: 'closed', reason: 'operational_minter_mismatch' });

    // Checksummed/mixed casing is the same address, not a mismatch.
    expect(
      evaluateEpochGate(
        observation({ operationalMinter: SIGNER.toUpperCase().replace('0X', '0x') }),
        0,
      ).kind,
    ).toBe('open');

    // Modifier order is `whenNotHeld onlyOperationalMinter`: hold reported first.
    expect(
      evaluateEpochGate(observation({ administrativeHold: true, operationalMinter: null }), 0),
    ).toEqual({ kind: 'closed', reason: 'administrative_hold' });

    // A raw `operationalMinter()` read returns the zero address rather than
    // null, and that is revocation — not somebody else holding the role.
    expect(evaluateEpochGate(observation({ operationalMinter: ZERO_ADDRESS }), 0))
      .toEqual({ kind: 'closed', reason: 'operational_minter_revoked' });

    // The modifier's second disjunct is `msg.sender == address(0)`, so a zero
    // signer must never read as open even when it "matches" a zero minter.
    expect(
      evaluateEpochGate(
        observation({ operationalMinter: ZERO_ADDRESS, settlementSigner: ZERO_ADDRESS }),
        0,
      ),
    ).toEqual({ kind: 'closed', reason: 'settler_config_invalid' });

    // A malformed chain read is unreadable state, not a mismatch verdict.
    expect(evaluateEpochGate(observation({ operationalMinter: '0xabc' }), 0))
      .toEqual({ kind: 'closed', reason: 'kernel_state_unreadable' });
  });

  it('fails closed rather than throwing when the minter read is not a string', () => {
    // A missing field or a number must not blow up the gate. Neither may be
    // reinterpreted as a deliberate revocation: only `null` and the zero
    // address encode that. An out-of-contract value means the read FAILED, and
    // reporting it as revoked would downgrade `abort` to a silent, endless
    // `hold` against a broken adapter.
    for (const bad of [undefined, 123, '', false, Number.NaN, {}]) {
      expect(
        evaluateEpochGate(observation({ operationalMinter: bad as unknown as string }), 0),
      ).toEqual({ kind: 'closed', reason: 'kernel_state_unreadable' });
    }

    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ operationalMinter: undefined as unknown as string }),
        DEFAULT_BOUNDARY_SAFETY_MARGIN_SEC,
      ),
    ).toEqual({ kind: 'abort', reason: 'chain_state_invalid' });
  });

  it('blames settler configuration, not the chain, for settler-supplied faults', () => {
    // Sending an operator to the RPC over a local config value wastes the
    // incident. The signer and the margin are both ours, not the kernel's.
    expect(evaluateEpochGate(observation({ settlementSigner: 'nope' }), 0))
      .toEqual({ kind: 'closed', reason: 'settler_config_invalid' });
    expect(evaluateEpochGate(observation({ settlementSigner: ZERO_ADDRESS }), 0))
      .toEqual({ kind: 'closed', reason: 'settler_config_invalid' });
    expect(evaluateEpochGate(observation(), -1))
      .toEqual({ kind: 'closed', reason: 'settler_config_invalid' });
    expect(evaluateEpochGate(observation(), Number.NaN))
      .toEqual({ kind: 'closed', reason: 'settler_config_invalid' });
  });

  it('closes on hold, before arming, before epoch zero, and on impossible state', () => {
    expect(evaluateEpochGate(observation({ administrativeHold: true }), 0))
      .toEqual({ kind: 'closed', reason: 'administrative_hold' });
    expect(evaluateEpochGate(observation({ epochZeroArmed: false }), 0))
      .toEqual({ kind: 'closed', reason: 'epoch_zero_not_armed' });
    expect(evaluateEpochGate(observation({ observedAtSec: EPOCH_ZERO - 1 }), 0))
      .toEqual({ kind: 'closed', reason: 'before_epoch_zero' });
    // The kernel cannot open an epoch ahead of chain time, so this snapshot lies.
    expect(evaluateEpochGate(observation({ lastOpenedEpoch: 9 }), 0))
      .toEqual({ kind: 'closed', reason: 'last_opened_epoch_ahead_of_wall_clock' });
  });

  it('closes rather than guessing on an unreadable snapshot', () => {
    expect(evaluateEpochGate(observation({ observedAtSec: Number.NaN }), 0))
      .toEqual({ kind: 'closed', reason: 'kernel_state_unreadable' });
    expect(evaluateEpochGate(observation({ lastOpenedEpoch: 1.5 }), 0))
      .toEqual({ kind: 'closed', reason: 'kernel_state_unreadable' });
  });

  it('reports the hold ahead of a pending advance, so settlement never slips through', () => {
    expect(
      evaluateEpochGate(
        observation({ administrativeHold: true, lastOpenedEpoch: 3, observedAtSec: at(5, 60) }),
        0,
      ),
    ).toEqual({ kind: 'closed', reason: 'administrative_hold' });
  });
});

describe('planEpochAdvance', () => {
  const MAX = 100;

  it('plans one ascending call per missed epoch', () => {
    expect(planEpochAdvance(observation({ lastOpenedEpoch: 3, observedAtSec: at(6, 60) }), MAX))
      .toEqual({ fromEpoch: 3, toEpoch: 6, calls: [4, 5, 6], remainingAfterPlan: 0 });
  });

  it('is null when already caught up', () => {
    expect(planEpochAdvance(observation(), MAX)).toBeNull();
  });

  it('still advances during an administrative hold and with the minter revoked', () => {
    // `openNextEpoch()` carries no modifier at all, so neither lever may strand
    // scheduled policy: they stop settlement, not epoch advance.
    expect(
      planEpochAdvance(
        observation({ administrativeHold: true, lastOpenedEpoch: 3, observedAtSec: at(5, 60) }),
        MAX,
      ),
    ).toEqual({ fromEpoch: 3, toEpoch: 5, calls: [4, 5], remainingAfterPlan: 0 });

    expect(
      planEpochAdvance(
        observation({
          operationalMinter: null,
          lastOpenedEpoch: 3,
          observedAtSec: at(5, 60),
        }),
        MAX,
      ),
    ).toEqual({ fromEpoch: 3, toEpoch: 5, calls: [4, 5], remainingAfterPlan: 0 });
  });

  it('still advances inside the boundary margin', () => {
    // Opening an epoch cannot be invalidated by the next boundary.
    expect(
      planEpochAdvance(observation({ lastOpenedEpoch: 3, observedAtSec: at(5, 0) - 1 }), MAX),
    ).toEqual({ fromEpoch: 3, toEpoch: 4, calls: [4], remainingAfterPlan: 0 });
  });

  it('caps one run at maxCalls and reports the remainder', () => {
    expect(planEpochAdvance(observation({ lastOpenedEpoch: 0, observedAtSec: at(10, 60) }), 4))
      .toEqual({ fromEpoch: 0, toEpoch: 10, calls: [1, 2, 3, 4], remainingAfterPlan: 6 });
  });

  it('refuses to materialise an enormous plan from a bad timestamp scale', () => {
    // Milliseconds passed where seconds were meant: bounded, not a 3M-entry array.
    const plan = planEpochAdvance(
      observation({ lastOpenedEpoch: 3, observedAtSec: EPOCH_ZERO * 1_000 }),
      100,
    );
    expect(plan?.calls).toHaveLength(100);
    expect(plan?.remainingAfterPlan).toBeGreaterThan(1_000_000);
  });

  it('is null on a non-positive or unreadable maxCalls', () => {
    const behind = observation({ lastOpenedEpoch: 3, observedAtSec: at(6, 60) });
    expect(planEpochAdvance(behind, 0)).toBeNull();
    expect(planEpochAdvance(behind, -1)).toBeNull();
    expect(planEpochAdvance(behind, 1.5)).toBeNull();
    expect(planEpochAdvance(behind, Number.NaN)).toBeNull();
  });

  it('is null when unarmed, before epoch zero, or unreadable', () => {
    expect(planEpochAdvance(observation({ epochZeroArmed: false, observedAtSec: at(6, 60) }), MAX)).toBeNull();
    expect(planEpochAdvance(observation({ observedAtSec: EPOCH_ZERO - 1 }), MAX)).toBeNull();
    expect(planEpochAdvance(observation({ observedAtSec: Number.NaN }), MAX)).toBeNull();
  });
});

describe('evaluateBatchResumption', () => {
  const margin = DEFAULT_BOUNDARY_SAFETY_MARGIN_SEC;

  it('submits a binding that still matches the open epoch and cursor', () => {
    expect(evaluateBatchResumption(binding(), settlementObservation(), margin))
      .toEqual({ kind: 'submit', epoch: 3, policyHash: POLICY_HASH });
  });

  it('rebuilds once the epoch boundary has been crossed', () => {
    // Same prepared batch, one epoch later: the kernel would revert
    // EpochMismatch, so the binding is dead and must be re-derived.
    const later = settlementObservation({ lastOpenedEpoch: 4, observedAtSec: at(4, 3_600) });
    expect(evaluateBatchResumption(binding({ epoch: 3 }), later, margin))
      .toEqual({ kind: 'rebuild', reason: 'epoch_boundary_crossed' });
  });

  it('rebuilds a stale binding even while the advance is still pending', () => {
    const midAdvance = settlementObservation({ lastOpenedEpoch: 3, observedAtSec: at(4, 60) });
    expect(evaluateBatchResumption(binding({ epoch: 3 }), midAdvance, margin))
      .toEqual({ kind: 'rebuild', reason: 'epoch_boundary_crossed' });
  });

  it('holds a binding built for the epoch that is about to open', () => {
    // Its policy hash was predicted, not observed — re-check after opening.
    const midAdvance = settlementObservation({ lastOpenedEpoch: 3, observedAtSec: at(4, 60) });
    expect(evaluateBatchResumption(binding({ epoch: 4 }), midAdvance, margin))
      .toEqual({ kind: 'hold', reason: 'epoch_advance_required' });
  });

  it('rebuilds when the epoch is right but the policy hash moved', () => {
    expect(
      evaluateBatchResumption(
        binding({ policyHash: OTHER_POLICY_HASH }),
        settlementObservation(),
        margin,
      ),
    ).toEqual({ kind: 'rebuild', reason: 'policy_hash_changed' });
  });

  it('treats a fully consumed cursor range as already settled, never a rebuild', () => {
    // Precedence matters: a settled batch seen after a boundary must not be
    // rebuilt, or the same work would be minted twice.
    const crossed = settlementObservation({
      lastOpenedEpoch: 4,
      observedAtSec: at(4, 3_600),
      nextFinalizedCursor: 1_400n,
    });
    expect(evaluateBatchResumption(binding({ epoch: 3 }), crossed, margin))
      .toEqual({ kind: 'already_settled' });

    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ nextFinalizedCursor: 9_999n }),
        margin,
      ),
    ).toEqual({ kind: 'already_settled' });
  });

  it('aborts on a partially consumed or gapped cursor rather than guessing', () => {
    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ nextFinalizedCursor: 1_200n }),
        margin,
      ),
    ).toEqual({ kind: 'abort', reason: 'cursor_partially_consumed' });

    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ nextFinalizedCursor: 900n }),
        margin,
      ),
    ).toEqual({ kind: 'abort', reason: 'cursor_gap' });
  });

  it('aborts a settler-config fault under its own reason, not the chain\'s', () => {
    expect(
      evaluateBatchResumption(binding(), settlementObservation({ settlementSigner: 'nope' }), margin),
    ).toEqual({ kind: 'abort', reason: 'settler_config_invalid' });
  });

  it('treats a zero-address minter as revoked, like an explicit null', () => {
    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ operationalMinter: ZERO_ADDRESS }),
        margin,
      ),
    ).toEqual({ kind: 'hold', reason: 'operational_minter_revoked' });
  });

  it('holds on a revoked or repointed operational minter', () => {
    // Both are recoverable by a fresh appointment, so the binding is not dead.
    expect(
      evaluateBatchResumption(binding(), settlementObservation({ operationalMinter: null }), margin),
    ).toEqual({ kind: 'hold', reason: 'operational_minter_revoked' });

    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ operationalMinter: OTHER_MINTER }),
        margin,
      ),
    ).toEqual({ kind: 'hold', reason: 'operational_minter_mismatch' });
  });

  it('holds on an administrative hold and inside the boundary margin', () => {
    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ administrativeHold: true }),
        margin,
      ),
    ).toEqual({ kind: 'hold', reason: 'administrative_hold' });

    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ observedAtSec: at(4, 0) - margin }),
        margin,
      ),
    ).toEqual({ kind: 'hold', reason: 'boundary_margin' });
  });

  it('aborts a binding whose epoch is ahead of chain time', () => {
    expect(evaluateBatchResumption(binding({ epoch: 5 }), settlementObservation(), margin))
      .toEqual({ kind: 'abort', reason: 'binding_epoch_in_future' });

    const midAdvance = settlementObservation({ lastOpenedEpoch: 3, observedAtSec: at(4, 60) });
    expect(evaluateBatchResumption(binding({ epoch: 9 }), midAdvance, margin))
      .toEqual({ kind: 'abort', reason: 'binding_epoch_in_future' });
  });

  it('aborts on a malformed binding or chain state', () => {
    expect(evaluateBatchResumption(binding({ policyHash: '0xdeadbeef' }), settlementObservation(), margin))
      .toEqual({ kind: 'abort', reason: 'invalid_binding' });
    expect(evaluateBatchResumption(binding({ cursorEnd: 1_000n }), settlementObservation(), margin))
      .toEqual({ kind: 'abort', reason: 'invalid_binding' });
    expect(evaluateBatchResumption(binding({ epoch: -1 }), settlementObservation(), margin))
      .toEqual({ kind: 'abort', reason: 'invalid_binding' });
    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ nextFinalizedCursor: -1n }),
        margin,
      ),
    ).toEqual({ kind: 'abort', reason: 'chain_state_invalid' });
    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ epochZeroArmed: false }),
        margin,
      ),
    ).toEqual({ kind: 'abort', reason: 'chain_state_invalid' });
  });

  it('never returns the terminal already_settled verdict from an unreadable snapshot', () => {
    // A consumed-looking cursor must not launder a lying read into "done":
    // a caller that drops its durable outbox entry here would under-settle.
    const garbage = settlementObservation({
      epochZeroArmed: false,
      epochZeroStartsAtSec: Number.NaN,
      lastOpenedEpoch: -5,
      observedAtSec: Number.NaN,
      nextFinalizedCursor: 1_400n,
    });
    expect(evaluateBatchResumption(binding(), garbage, margin))
      .toEqual({ kind: 'abort', reason: 'chain_state_invalid' });
  });

  it('rejects a missing or zero open-epoch policy hash instead of throwing or submitting', () => {
    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ openEpochPolicyHash: undefined as unknown as string }),
        margin,
      ),
    ).toEqual({ kind: 'abort', reason: 'chain_state_invalid' });

    // The kernel rejects a zero policy hash outright (PolicyHashMismatch), so
    // matching zeroes on both sides must never read as a live binding.
    const zero = `0x${'0'.repeat(64)}`;
    expect(
      evaluateBatchResumption(
        binding({ policyHash: zero }),
        settlementObservation({ openEpochPolicyHash: zero }),
        margin,
      ),
    ).toEqual({ kind: 'abort', reason: 'invalid_binding' });
    expect(
      evaluateBatchResumption(
        binding(),
        settlementObservation({ openEpochPolicyHash: zero }),
        margin,
      ),
    ).toEqual({ kind: 'abort', reason: 'chain_state_invalid' });
  });

  it('matches policy hashes case-insensitively', () => {
    expect(
      evaluateBatchResumption(
        binding({ policyHash: POLICY_HASH.toUpperCase().replace('0X', '0x') }),
        settlementObservation(),
        margin,
      ),
    ).toEqual({ kind: 'submit', epoch: 3, policyHash: POLICY_HASH });
  });

  it('submits at epoch zero, the state immediately after arming', () => {
    const justArmed = settlementObservation({
      lastOpenedEpoch: 0,
      observedAtSec: at(0, 3_600),
    });
    expect(evaluateBatchResumption(binding({ epoch: 0 }), justArmed, margin))
      .toEqual({ kind: 'submit', epoch: 0, policyHash: POLICY_HASH });
  });
});
