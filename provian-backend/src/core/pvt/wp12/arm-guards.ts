/**
 * Arm-time guards for the irreversible kernel activation call.
 *
 * The finalized cursor is a claim counter bound to the shared fresh-kernel
 * invariant. The kernel has no cursor correction setter, and all later checks
 * are relative to this counter, so an incorrect offset would persist without
 * reverting. A different cursor is refused without an override.
 *
 * Every armed field is read back from the deployed kernel and compared to the
 * intended tuple. Constructing the right tuple alone does not prove it landed.
 * Usage text must identify a claim counter rather than a timestamp watermark.
 */

import { getAddress } from 'ethers';

import { KERNEL_NEXT_FINALIZED_CURSOR_START } from '../wp11/cutover-cursors';

/**
 * The ONLY value that may be armed, as the kernel's `uint256`. Derived from the
 * reconciliation's own constant — never a second literal.
 */
export const INTENDED_INITIAL_FINALIZED_CURSOR: bigint = BigInt(
  KERNEL_NEXT_FINALIZED_CURSOR_START,
);

export class ArmGuardRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArmGuardRefusal';
  }
}

/**
 * Resolve `--cursor`. Omitted means the invariant. Supplied means it must EQUAL
 * the invariant; anything else is refused by name, with both values printed.
 *
 * Refuses before parsing succeeds too: a non-numeric argument is a refusal, not
 * a `SyntaxError` thrown from `BigInt` with no context about what was refused.
 */
export function resolveInitialFinalizedCursor(raw: string | undefined): bigint {
  if (raw === undefined) return INTENDED_INITIAL_FINALIZED_CURSOR;
  const trimmed = raw.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) {
    throw new ArmGuardRefusal(
      `refusing to arm: --cursor ${JSON.stringify(raw)} is not a canonical non-negative integer. `
      + `The only valid value is ${INTENDED_INITIAL_FINALIZED_CURSOR} — the starting `
      + 'nextFinalizedCursor of a fresh kernel.',
    );
  }
  const supplied = BigInt(trimmed);
  if (supplied !== INTENDED_INITIAL_FINALIZED_CURSOR) {
    throw new ArmGuardRefusal(
      `refusing to arm: --cursor ${supplied} != the fresh-kernel invariant `
      + `${INTENDED_INITIAL_FINALIZED_CURSOR} `
      + '(cutover-cursors.ts KERNEL_NEXT_FINALIZED_CURSOR_START). nextFinalizedCursor counts '
      + 'SETTLED PVT9 CLAIMS and starts at zero on a zero-supply kernel with no carry. It has no '
      + 'setter: once armed it can only advance, so a wrong value is permanent and correctable '
      + 'only by deploying a successor contract. There is no override flag by design.',
    );
  }
  return supplied;
}

/**
 * What the arm call intends to write, plus the epoch-zero policy values the
 * KERNEL derives from its own compile-time constants.
 *
 * The derived block is deliberately supplied by reading the deployed kernel's
 * own public constants rather than by hardcoding a prediction here. A hardcoded
 * prediction that turned out wrong would throw AFTER the irreversible call — a
 * false alarm at the worst possible moment — whereas a self-consistency check
 * ("epoch zero equals what THIS kernel's constants say it must") cannot.
 */
export interface IntendedEpochZero {
  readonly epochZeroStartsAtSec: bigint;
  readonly genesisStartsAtSec: bigint;
  readonly genesisEndsAtSec: bigint;
  readonly initialMintRate: bigint;
  readonly provianTreasury: string;
  readonly foundationTreasury: string;
  readonly eligibilityVerifier: string;
  readonly configurationId: string;
  readonly configurationVersion: bigint;
  readonly initialFinalizedCursor: bigint;
  /** `INITIAL_GENESIS_EPOCH_CAP()`, read from the deployed kernel. */
  readonly kernelInitialGenesisEpochCap: bigint;
  /** `INITIAL_COMBINED_EPOCH_CAP()`, read from the deployed kernel. */
  readonly kernelInitialCombinedEpochCap: bigint;
  /** `HUMAN_FOUNDATION_BPS()`, read from the deployed kernel. */
  readonly kernelHumanFoundationBps: bigint;
}

/**
 * What the deployed kernel actually reports AFTER `armEpochZero`. Read from the
 * public state getters plus `getEpochPolicy(0)`; passed in as plain data so this
 * comparison never touches a provider.
 */
export interface ArmedEpochZeroReadback {
  readonly epochZeroArmed: boolean;
  readonly epochZeroStartsAt: bigint;
  readonly genesisStartsAt: bigint;
  readonly genesisEndsAt: bigint;
  readonly nextFinalizedCursor: bigint;
  readonly policyOpened: boolean;
  readonly policyEpoch: bigint;
  readonly policyStartsAt: bigint;
  readonly policyCombinedCapMode: bigint;
  readonly policyMintRate: bigint;
  readonly policyGenesisCap: bigint;
  readonly policyCombinedCap: bigint;
  readonly policyProvianTreasury: string;
  readonly policyFoundationTreasury: string;
  readonly policyAgentFoundationBps: bigint;
  readonly policyBeneficiaryVerifier: string;
  readonly policyEligibilityVerifier: string;
  readonly policyEligibilityConfigurationId: string;
  readonly policyEligibilityConfigurationVersion: bigint;
  readonly policyHash: string;
}

/**
 * `CombinedCapMode.Automatic` — the mode `armEpochZero` sets (`:416`), ordinal
 * 0 by declaration order at `ProvianPVT9.sol:62-65`.
 *
 * This is the ONE expectation in the readback that is a source-level prediction
 * rather than a value read from the deployed kernel or from the intended
 * config: the enum has no getter to read the ordinal from. It is correct for
 * the pinned kernel; a kernel built from a source that declared `Fixed` first
 * would falsify it, and it is labelled here rather than folded in with the
 * chain-read constants.
 */
const COMBINED_CAP_MODE_AUTOMATIC = 0n;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

/** One comparison, named, so a mismatch says WHICH field and BOTH values. */
interface FieldCheck {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

function addr(value: string): string {
  try {
    return getAddress(value);
  } catch {
    // Not a valid address: return it verbatim so the mismatch message shows the
    // real garbage rather than throwing an unrelated error out of the checker.
    return value;
  }
}

function hex32(value: string): string {
  return value.toLowerCase();
}

/**
 * Compare the armed on-chain state against the intended config, field by field,
 * in a fixed order. THROWS on the FIRST mismatch, naming the field and both
 * values. Returns the number of fields compared so a caller can never mistake
 * "compared nothing" for "everything matched".
 */
export function assertArmedEpochZeroMatches(
  intended: IntendedEpochZero,
  onChain: ArmedEpochZeroReadback,
): number {
  const checks: readonly FieldCheck[] = [
    { field: 'epochZeroArmed', expected: 'true', actual: String(onChain.epochZeroArmed) },
    {
      field: 'epochZeroStartsAt',
      expected: intended.epochZeroStartsAtSec.toString(),
      actual: onChain.epochZeroStartsAt.toString(),
    },
    {
      field: 'genesisStartsAt',
      expected: intended.genesisStartsAtSec.toString(),
      actual: onChain.genesisStartsAt.toString(),
    },
    {
      field: 'genesisEndsAt',
      expected: intended.genesisEndsAtSec.toString(),
      actual: onChain.genesisEndsAt.toString(),
    },
    {
      field: 'nextFinalizedCursor',
      expected: intended.initialFinalizedCursor.toString(),
      actual: onChain.nextFinalizedCursor.toString(),
    },
    { field: 'getEpochPolicy(0).opened', expected: 'true', actual: String(onChain.policyOpened) },
    { field: 'getEpochPolicy(0).epoch', expected: '0', actual: onChain.policyEpoch.toString() },
    {
      // Epoch zero's offset is zero, so startsAt must equal epochZeroStartsAt
      // exactly (`_writeEpochPolicy`: epochZeroStartsAt + epoch * EPOCH_DURATION).
      field: 'getEpochPolicy(0).startsAt',
      expected: intended.epochZeroStartsAtSec.toString(),
      actual: onChain.policyStartsAt.toString(),
    },
    {
      field: 'getEpochPolicy(0).combinedCapMode',
      expected: COMBINED_CAP_MODE_AUTOMATIC.toString(),
      actual: onChain.policyCombinedCapMode.toString(),
    },
    {
      field: 'getEpochPolicy(0).mintRate',
      expected: intended.initialMintRate.toString(),
      actual: onChain.policyMintRate.toString(),
    },
    {
      // Kernel-derived: armEpochZero sets _activeGenesisCap to the kernel's own
      // INITIAL_GENESIS_EPOCH_CAP. Compared against that constant READ FROM THE
      // SAME KERNEL, so this is a self-consistency check, not a prediction.
      field: 'getEpochPolicy(0).genesisCap',
      expected: intended.kernelInitialGenesisEpochCap.toString(),
      actual: onChain.policyGenesisCap.toString(),
    },
    {
      // Automatic mode, epoch 0 < FLAT_LAUNCH_EPOCHS, so the combined cap is
      // the kernel's INITIAL_COMBINED_EPOCH_CAP.
      field: 'getEpochPolicy(0).combinedCap',
      expected: intended.kernelInitialCombinedEpochCap.toString(),
      actual: onChain.policyCombinedCap.toString(),
    },
    {
      field: 'getEpochPolicy(0).provianTreasury',
      expected: addr(intended.provianTreasury),
      actual: addr(onChain.policyProvianTreasury),
    },
    {
      field: 'getEpochPolicy(0).foundationTreasury',
      expected: addr(intended.foundationTreasury),
      actual: addr(onChain.policyFoundationTreasury),
    },
    {
      // armEpochZero sets the agent Foundation rate to the immutable human
      // floor. A differing value would mean a differential rate is live at
      // epoch zero and a beneficiary verifier would be required.
      field: 'getEpochPolicy(0).agentFoundationBps',
      expected: intended.kernelHumanFoundationBps.toString(),
      actual: onChain.policyAgentFoundationBps.toString(),
    },
    {
      // armEpochZero never sets a beneficiary verifier; it must still be unset.
      field: 'getEpochPolicy(0).beneficiaryVerifier.verifier',
      expected: ZERO_ADDRESS,
      actual: addr(onChain.policyBeneficiaryVerifier),
    },
    {
      field: 'getEpochPolicy(0).eligibilityVerifier.verifier',
      expected: addr(intended.eligibilityVerifier),
      actual: addr(onChain.policyEligibilityVerifier),
    },
    {
      field: 'getEpochPolicy(0).eligibilityVerifier.configurationId',
      expected: hex32(intended.configurationId),
      actual: hex32(onChain.policyEligibilityConfigurationId),
    },
    {
      field: 'getEpochPolicy(0).eligibilityVerifier.version',
      expected: intended.configurationVersion.toString(),
      actual: onChain.policyEligibilityConfigurationVersion.toString(),
    },
    {
      // PRESENCE, not recomputation. `policyHash` is derived by the kernel from
      // the very fields compared above; recomputing it here would mirror kernel
      // math in an operator script and could throw a FALSE alarm after the
      // irreversible call. A zero hash means the policy was never written.
      // DECLARED as a weaker check rather than given a stronger-looking one.
      field: 'getEpochPolicy(0).policyHash (non-zero)',
      expected: 'non-zero',
      actual: hex32(onChain.policyHash) === ZERO_BYTES32 ? ZERO_BYTES32 : 'non-zero',
    },
  ];

  for (const check of checks) {
    if (check.expected !== check.actual) {
      throw new ArmGuardRefusal(
        `ARMED STATE DOES NOT MATCH INTENT — ${check.field}: on chain ${check.actual}, `
        + `intended ${check.expected}. armEpochZero is one-time and has no setter; `
        + 'this state is permanent and correctable only by a successor contract.',
      );
    }
  }
  return checks.length;
}

/**
 * Every field `assertArmedEpochZeroMatches` compares, in order. Exported so the
 * suite can prove the comparison is exhaustive over `EpochZeroConfig` and that
 * EACH field is individually able to fail — a readback that silently skipped a
 * field would be the same class of defect as arming without one.
 */
export const ARMED_READBACK_FIELDS: readonly string[] = [
  'epochZeroArmed',
  'epochZeroStartsAt',
  'genesisStartsAt',
  'genesisEndsAt',
  'nextFinalizedCursor',
  'getEpochPolicy(0).opened',
  'getEpochPolicy(0).epoch',
  'getEpochPolicy(0).startsAt',
  'getEpochPolicy(0).combinedCapMode',
  'getEpochPolicy(0).mintRate',
  'getEpochPolicy(0).genesisCap',
  'getEpochPolicy(0).combinedCap',
  'getEpochPolicy(0).provianTreasury',
  'getEpochPolicy(0).foundationTreasury',
  'getEpochPolicy(0).agentFoundationBps',
  'getEpochPolicy(0).beneficiaryVerifier.verifier',
  'getEpochPolicy(0).eligibilityVerifier.verifier',
  'getEpochPolicy(0).eligibilityVerifier.configurationId',
  'getEpochPolicy(0).eligibilityVerifier.version',
  'getEpochPolicy(0).policyHash (non-zero)',
];

/**
 * Every member of the on-chain `EpochPolicy` struct (`ProvianPVT9.sol:84-98`).
 * The suite asserts each appears in `ARMED_READBACK_FIELDS`, so a field added
 * to the struct — or one quietly dropped from the readback — fails the build
 * instead of silently going unverified. `beneficiaryVerifier` and
 * `eligibilityVerifier` are covered by their subfield entries above.
 */
export const EPOCH_POLICY_STRUCT_MEMBERS: readonly string[] = [
  'opened',
  'epoch',
  'startsAt',
  'combinedCapMode',
  'mintRate',
  'genesisCap',
  'combinedCap',
  'provianTreasury',
  'foundationTreasury',
  'agentFoundationBps',
  'beneficiaryVerifier',
  'eligibilityVerifier',
  'policyHash',
];

/**
 * Phrases that describe the cursor as something it is not. "cut-line cursor",
 * "cut line cursor" and "cutover reconciliation cursor" all point a reader at the legacy
 * timestamp watermark (`pvtv8_finalized.max_settled_pe_timestamp_ms`) rather
 * than at a claim counter that starts at zero.
 */
export const AMBIGUOUS_CURSOR_PHRASES: readonly RegExp[] = [
  /cut[-\s]?line\s+cursor/i,
  /cutover reconciliation\s+cursor/i,
  /cursor\s+at\s+the\s+cut[-\s]?line/i,
];

/**
 * Is this module's cursor constant still DERIVED from the reconciliation's
 * exported symbol, rather than re-spelled as its own `'0'`?
 *
 * The redeclaration detector ignores literals shorter than two characters,
 * and module-to-module copies are outside its comparison. BigInt('0') and
 * BigInt(KERNEL_NEXT_FINALIZED_CURSOR_START) have the same value, so only a
 * source binding check can prove the shared constant is still authoritative.
 *
 * Takes the source as an argument so a negative control can hand it the severed
 * spelling and watch this return false.
 */
export function bindsCursorToSharedConstant(armGuardsSource: string): boolean {
  if (armGuardsSource.trim().length === 0) return false;
  const imports = /import\s*\{[^}]*\bKERNEL_NEXT_FINALIZED_CURSOR_START\b[^}]*\}\s*from\s*'\.\.\/wp11\/cutover-cursors'/
    .test(armGuardsSource);
  const derives = /INTENDED_INITIAL_FINALIZED_CURSOR\s*:\s*bigint\s*=\s*BigInt\(\s*KERNEL_NEXT_FINALIZED_CURSOR_START\s*,?\s*\)/
    .test(armGuardsSource.replace(/\s*\n\s*/g, ' '));
  return imports && derives;
}

export interface AmbiguousCursorHit {
  readonly line: number;
  readonly phrase: string;
  readonly text: string;
}

/**
 * Scan a document for cursor descriptions that mislead. Returns hits; an empty
 * source is a HIT (`line: 0`) rather than a silent pass, so "found nothing"
 * can never mean "read nothing".
 */
export function findAmbiguousCursorDescriptions(source: string): readonly AmbiguousCursorHit[] {
  if (source.trim().length === 0) {
    return [{ line: 0, phrase: 'empty-source', text: 'nothing was scanned' }];
  }
  const hits: AmbiguousCursorHit[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const re of AMBIGUOUS_CURSOR_PHRASES) {
      if (re.test(lines[i])) {
        hits.push({ line: i + 1, phrase: re.source, text: lines[i].trim() });
      }
    }
  }
  return hits;
}
