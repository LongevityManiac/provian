/**
 * settlement runtime — epoch-advance orchestration and the settler-side settlement fence.
 *
 * The PVT9 kernel is final and non-upgradeable, so this layer adds no authority
 * and mints nothing: it is a pure decision function over an observed on-chain
 * state snapshot. Nothing here signs, submits, or opens a network connection.
 *
 * The kernel already fences settlement on-chain in both directions while an
 * epoch advance is pending (`_requireSettlementPolicy` demands
 * `wallClockEpoch == epoch == lastOpenedEpoch` plus an exact policy hash), so a
 * mistake here can never over-mint — it can only waste a transaction. What this
 * layer buys is that the worker stops *before* spending a nonce on a batch the
 * kernel is certain to reject, and never resubmits a batch whose binding died at
 * an epoch boundary. Those facts are pinned in
 * `contracts/test/ProvianPVT9Wp4Settlement.t.sol`.
 */

const ADDRESS = /^0x[0-9a-f]{40}$/i;

/** Mirrors `ProvianPVT9.EPOCH_DURATION` (7 days). */
export const PVT9_EPOCH_DURATION_SEC = 604_800;

/**
 * Default refusal window before an epoch boundary. The kernel evaluates
 * `block.timestamp` at INCLUSION time, not at read time, so a batch submitted
 * just before a boundary can land just after it and revert with
 * `EpochMismatch`. This is an operating parameter, not an economic one — activation
 * owns the production value. Callers must pass one explicitly.
 */
export const DEFAULT_BOUNDARY_SAFETY_MARGIN_SEC = 120;

/**
 * The four facts the epoch CLOCK is a function of, and nothing else.
 *
 * Split out of `KernelEpochObservation` for the epoch keeper. `openNextEpoch()` carries no
 * modifier at all, so a keeper has no business knowing the hold or the minter — and being
 * forced to supply them would mean synthesizing values the keeper never reads, which is how
 * a caller ends up asserting something it did not observe.
 */
export interface EpochClockObservation {
  readonly epochZeroArmed: boolean;
  readonly epochZeroStartsAtSec: number;
  readonly lastOpenedEpoch: number;
  /**
   * Timestamp of the block this observation was read at. Never a local clock:
   * the kernel's fence is evaluated against chain time.
   */
  readonly observedAtSec: number;
}

/** A read of the kernel's epoch state, taken at a specific block. */
export interface KernelEpochObservation extends EpochClockObservation {
  readonly administrativeHold: boolean;
  /**
   * The kernel's current `operationalMinter`, or `null` for `address(0)`.
   * Both settlement entrypoints are `whenNotHeld onlyOperationalMinter`, and
   * that modifier tests IDENTITY (`msg.sender != operationalMinter`), not mere
   * configuration. `appointOperationalMinter` carries no one-time guard, so the
   * admin can repoint the minter at any moment — a settler still signing as the
   * previous address reverts on every batch. Epoch advance is unaffected:
   * `openNextEpoch()` carries no modifier at all.
   */
  readonly operationalMinter: string | null;
  /** The address this settler signs settlement transactions as. */
  readonly settlementSigner: string;
}

export type EpochGateClosedReason =
  | 'epoch_zero_not_armed'
  | 'before_epoch_zero'
  | 'administrative_hold'
  | 'operational_minter_revoked'
  | 'operational_minter_mismatch'
  | 'boundary_margin'
  | 'kernel_state_unreadable'
  /** A settler-supplied input is bad — local configuration, not the chain. */
  | 'settler_config_invalid'
  | 'last_opened_epoch_ahead_of_wall_clock';

export type EpochGateDecision =
  | {
      readonly kind: 'open';
      readonly epoch: number;
      readonly secondsUntilBoundary: number;
    }
  | {
      readonly kind: 'advance_required';
      readonly wallClockEpoch: number;
      readonly lastOpenedEpoch: number;
      readonly openNextEpochCallsRequired: number;
    }
  | { readonly kind: 'closed'; readonly reason: EpochGateClosedReason };

/** One `openNextEpoch()` call per missed epoch, in ascending order. */
export interface EpochAdvancePlan {
  readonly fromEpoch: number;
  /** The wall-clock epoch: where a complete catch-up would finish. */
  readonly toEpoch: number;
  /** The epoch each successive `openNextEpoch()` call will open, capped by `maxCalls`. */
  readonly calls: readonly number[];
  /** Epochs still unopened after this run; non-zero means run again. */
  readonly remainingAfterPlan: number;
}

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function isZeroAddress(value: unknown): boolean {
  // Guarded like `isPolicyHash`: an adapter that hands back `undefined` or a
  // number must fail closed, never throw.
  return typeof value === 'string' && value.toLowerCase() === ZERO_ADDRESS;
}

function isUsableAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS.test(value) && !isZeroAddress(value);
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isReadableObservation(observation: EpochClockObservation): boolean {
  return isNonNegativeInteger(observation.epochZeroStartsAtSec)
    && isNonNegativeInteger(observation.lastOpenedEpoch)
    && isNonNegativeInteger(observation.observedAtSec);
}

/**
 * The epoch the kernel would compute from chain time, or `null` when epoch zero
 * has not started. Mirrors `ProvianPVT9.currentEpoch()`.
 */
export function wallClockEpoch(observation: EpochClockObservation): number | null {
  if (!isReadableObservation(observation)) return null;
  if (observation.observedAtSec < observation.epochZeroStartsAtSec) return null;
  return Math.floor(
    (observation.observedAtSec - observation.epochZeroStartsAtSec) / PVT9_EPOCH_DURATION_SEC,
  );
}

/**
 * Whether settlement may be attempted right now, and if not, exactly what is in
 * the way. Fail-closed: any unreadable or self-inconsistent observation closes
 * the gate rather than assuming a safe default.
 */
export function evaluateEpochGate(
  observation: KernelEpochObservation,
  boundarySafetyMarginSec: number,
): EpochGateDecision {
  if (!isNonNegativeInteger(boundarySafetyMarginSec)) {
    return { kind: 'closed', reason: 'settler_config_invalid' };
  }
  if (!isReadableObservation(observation)) {
    return { kind: 'closed', reason: 'kernel_state_unreadable' };
  }
  if (!observation.epochZeroArmed) return { kind: 'closed', reason: 'epoch_zero_not_armed' };

  const epoch = wallClockEpoch(observation);
  if (epoch === null) return { kind: 'closed', reason: 'before_epoch_zero' };

  // The kernel refuses to open an epoch ahead of chain time, so this is
  // structurally impossible; observing it means the snapshot is untrustworthy.
  if (observation.lastOpenedEpoch > epoch) {
    return { kind: 'closed', reason: 'last_opened_epoch_ahead_of_wall_clock' };
  }
  // Modifier order on both settlement entrypoints is `whenNotHeld
  // onlyOperationalMinter`, so the hold is reported ahead of the minter.
  if (observation.administrativeHold) return { kind: 'closed', reason: 'administrative_hold' };
  // The signer is settler configuration, not a chain read. The kernel's second
  // disjunct (`msg.sender == address(0)`) makes a zero signer unusable too.
  if (!isUsableAddress(observation.settlementSigner)) {
    return { kind: 'closed', reason: 'settler_config_invalid' };
  }
  // A raw `operationalMinter()` read returns the zero address, not null, so
  // both encodings of "revoked" must land on the same verdict.
  // Strict `=== null` on purpose. `null` and the zero address are the two
  // documented encodings of a deliberate revocation; `undefined` is not in the
  // declared type, so it means the read FAILED. Reporting that as a revocation
  // would give `hold`, and the settler would retry silently forever instead of
  // surfacing a broken adapter. Unknown = block.
  if (observation.operationalMinter === null || isZeroAddress(observation.operationalMinter)) {
    return { kind: 'closed', reason: 'operational_minter_revoked' };
  }
  if (!ADDRESS.test(observation.operationalMinter)) {
    return { kind: 'closed', reason: 'kernel_state_unreadable' };
  }
  // Identity, not configuration: a repointed minter reverts our batches.
  if (observation.operationalMinter.toLowerCase() !== observation.settlementSigner.toLowerCase()) {
    return { kind: 'closed', reason: 'operational_minter_mismatch' };
  }

  if (observation.lastOpenedEpoch < epoch) {
    return {
      kind: 'advance_required',
      wallClockEpoch: epoch,
      lastOpenedEpoch: observation.lastOpenedEpoch,
      openNextEpochCallsRequired: epoch - observation.lastOpenedEpoch,
    };
  }

  const boundaryAtSec = observation.epochZeroStartsAtSec + (epoch + 1) * PVT9_EPOCH_DURATION_SEC;
  const secondsUntilBoundary = boundaryAtSec - observation.observedAtSec;
  if (secondsUntilBoundary <= boundarySafetyMarginSec) {
    return { kind: 'closed', reason: 'boundary_margin' };
  }

  return { kind: 'open', epoch, secondsUntilBoundary };
}

/**
 * The `openNextEpoch()` calls needed to catch up, or `null` when none are due.
 * The kernel advances exactly one epoch per call and rejects any call ahead of
 * chain time, so a missed scheduler run needs one call per skipped epoch.
 *
 * Deliberately independent of `evaluateEpochGate`: `openNextEpoch()` carries no
 * modifier at all — not `whenNotHeld`, not `onlyOperationalMinter` — so neither
 * an administrative hold nor a revoked minter may stop epoch advance, or
 * scheduled policy would silently fail to apply for the length of the hold. It
 * is likewise independent of the boundary margin, since opening an epoch cannot
 * be invalidated by the next boundary.
 *
 * `maxCalls` bounds one run, both as the plan's "configured operating stop" and
 * so a caller that passes milliseconds where seconds were meant cannot make
 * this allocate an enormous array.
 */
export function planEpochAdvance(
  observation: EpochClockObservation,
  maxCalls: number,
): EpochAdvancePlan | null {
  if (!isReadableObservation(observation) || !observation.epochZeroArmed) return null;
  if (!Number.isSafeInteger(maxCalls) || maxCalls <= 0) return null;

  const epoch = wallClockEpoch(observation);
  if (epoch === null) return null;
  if (observation.lastOpenedEpoch >= epoch) return null;

  const due = epoch - observation.lastOpenedEpoch;
  const planned = Math.min(due, maxCalls);
  const calls: number[] = [];
  for (let index = 0; index < planned; index += 1) {
    calls.push(observation.lastOpenedEpoch + 1 + index);
  }
  return {
    fromEpoch: observation.lastOpenedEpoch,
    toEpoch: epoch,
    calls,
    remainingAfterPlan: due - planned,
  };
}

/** The epoch/policy/cursor a prepared batch was built against. */
export interface PreparedBatchBinding {
  readonly epoch: number;
  readonly policyHash: string;
  readonly cursorStart: bigint;
  readonly cursorEnd: bigint;
}

export interface SettlementObservation extends KernelEpochObservation {
  readonly nextFinalizedCursor: bigint;
  /** `getEpochPolicy(lastOpenedEpoch).policyHash` from the same snapshot. */
  readonly openEpochPolicyHash: string;
}

export type BatchRebuildReason = 'epoch_boundary_crossed' | 'policy_hash_changed';

export type BatchHoldReason =
  | 'administrative_hold'
  | 'operational_minter_revoked'
  | 'operational_minter_mismatch'
  | 'boundary_margin'
  | 'epoch_advance_required';

export type BatchAbortReason =
  | 'invalid_binding'
  | 'cursor_gap'
  | 'cursor_partially_consumed'
  | 'binding_epoch_in_future'
  | 'settler_config_invalid'
  | 'chain_state_invalid';

/**
 * `submit` — the binding is still live.
 * `rebuild` — the binding is permanently dead; re-derive against current state.
 *   Claim ids must stay stable across a rebuild (see `claim-identity.ts`).
 * `hold` — transient; retry the same binding later.
 * `already_settled` — the cursor range is fully consumed; resubmitting would
 *   attempt a double mint.
 * `abort` — inconsistent state; stop and surface rather than guess.
 */
export type BatchResumptionDecision =
  | { readonly kind: 'submit'; readonly epoch: number; readonly policyHash: string }
  | { readonly kind: 'rebuild'; readonly reason: BatchRebuildReason }
  | { readonly kind: 'hold'; readonly reason: BatchHoldReason }
  | { readonly kind: 'already_settled' }
  | { readonly kind: 'abort'; readonly reason: BatchAbortReason };

const BYTES32 = /^0x[0-9a-f]{64}$/i;
const ZERO_HASH = `0x${'0'.repeat(64)}`;

function isPolicyHash(value: unknown): value is string {
  // The kernel rejects a zero policy hash outright (`PolicyHashMismatch`), so a
  // zero here is never a settleable state.
  return typeof value === 'string' && BYTES32.test(value) && value.toLowerCase() !== ZERO_HASH;
}

function isValidChainState(observation: SettlementObservation): boolean {
  return typeof observation.nextFinalizedCursor === 'bigint'
    && observation.nextFinalizedCursor >= 0n
    && isPolicyHash(observation.openEpochPolicyHash);
}

function isValidBinding(binding: PreparedBatchBinding): boolean {
  return isNonNegativeInteger(binding.epoch)
    && isPolicyHash(binding.policyHash)
    && typeof binding.cursorStart === 'bigint'
    && typeof binding.cursorEnd === 'bigint'
    && binding.cursorStart >= 0n
    && binding.cursorEnd > binding.cursorStart;
}

/**
 * Whether a batch prepared earlier may still be submitted as-is.
 *
 * A batch is bound to an exact epoch and policy hash, so crossing a 7-day
 * boundary kills it outright — the kernel reverts with `EpochMismatch` and the
 * cursor never moves, so the work is rebuilt against the new epoch at the same
 * cursor and the same claim ids. That is the kernel's rule, not a choice made
 * here. This function decides only whether the prepared binding is still
 * submittable; it deliberately does not decide how a rebuild re-selects claims.
 */
export function evaluateBatchResumption(
  binding: PreparedBatchBinding,
  observation: SettlementObservation,
  boundarySafetyMarginSec: number,
): BatchResumptionDecision {
  if (!isValidBinding(binding)) return { kind: 'abort', reason: 'invalid_binding' };
  // The whole snapshot is validated up front, before any verdict can be
  // returned. `already_settled` is terminal, so it must never be reachable from
  // a partial or lying read.
  if (!isReadableObservation(observation) || !isValidChainState(observation)) {
    return { kind: 'abort', reason: 'chain_state_invalid' };
  }

  // What already happened on-chain outranks anything about the epoch: a
  // consumed range must never be resubmitted, whatever the clock says.
  const cursor = observation.nextFinalizedCursor;
  if (binding.cursorEnd <= cursor) return { kind: 'already_settled' };
  if (binding.cursorStart < cursor) return { kind: 'abort', reason: 'cursor_partially_consumed' };
  if (binding.cursorStart > cursor) return { kind: 'abort', reason: 'cursor_gap' };

  const gate = evaluateEpochGate(observation, boundarySafetyMarginSec);
  switch (gate.kind) {
    case 'closed':
      // Transient: the admin can resume or re-appoint, and the binding survives.
      if (gate.reason === 'administrative_hold') return { kind: 'hold', reason: 'administrative_hold' };
      if (gate.reason === 'operational_minter_revoked') {
        return { kind: 'hold', reason: 'operational_minter_revoked' };
      }
      if (gate.reason === 'operational_minter_mismatch') {
        return { kind: 'hold', reason: 'operational_minter_mismatch' };
      }
      if (gate.reason === 'boundary_margin') return { kind: 'hold', reason: 'boundary_margin' };
      // Don't blame the chain for a local misconfiguration.
      if (gate.reason === 'settler_config_invalid') {
        return { kind: 'abort', reason: 'settler_config_invalid' };
      }
      return { kind: 'abort', reason: 'chain_state_invalid' };

    case 'advance_required':
      // The binding died at the boundary unless it was already built for the
      // epoch that is about to be opened.
      if (binding.epoch > gate.wallClockEpoch) {
        return { kind: 'abort', reason: 'binding_epoch_in_future' };
      }
      if (binding.epoch < gate.wallClockEpoch) {
        return { kind: 'rebuild', reason: 'epoch_boundary_crossed' };
      }
      // Its policy hash was predicted, not observed; re-evaluate once opened.
      return { kind: 'hold', reason: 'epoch_advance_required' };

    case 'open':
      if (binding.epoch > gate.epoch) return { kind: 'abort', reason: 'binding_epoch_in_future' };
      if (binding.epoch < gate.epoch) return { kind: 'rebuild', reason: 'epoch_boundary_crossed' };
      if (binding.policyHash.toLowerCase() !== observation.openEpochPolicyHash.toLowerCase()) {
        return { kind: 'rebuild', reason: 'policy_hash_changed' };
      }
      return { kind: 'submit', epoch: gate.epoch, policyHash: observation.openEpochPolicyHash };
  }
}
