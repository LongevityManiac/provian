import { ethers } from 'ethers';

import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './proposed-genesis-policy';

/**
 * PVT9 arming configuration surface.
 *
 * This is the tracked home for the on-chain arming inputs activation must read to deploy
 * and arm the PVT9 kernel + eligibility verifier: the treasury/minter/approver
 * addresses and the verifier's constructor immutables, plus the epoch-zero clock
 * start. The Genesis admission window (genesisStartsAt / genesisEndsAt) is NOT
 * duplicated here — it lives in its designed home, `proposed-genesis-policy.ts`
 * (`window.start_ms` / `window.end_ms`); the loader below reads it from there, so the
 * two surfaces cannot disagree. See DECISIONS.md.
 *
 * This module holds VALUES and a validating READER only. It appoints nothing, deploys
 * nothing, signs nothing, and calls no chain method. Arming (`armEpochZero`,
 * `appointOperationalMinter`, `appointBatchApprover`, the verifier deploy) remains
 * activation's separately approved act; this surface only supplies the values that act reads.
 *
 * WHY `config/pvt9-base.json` is not the home: its runtime boundary seam validator
 * (`generate-pvt9-base-config.mjs`) requires the top-level keys to equal a fixed set
 * exactly and hard-requires `genesis.{armed:false, window_approved:false, start_at:null,
 * end_at:null}`. Those invariants are the guard that keeps PVT9 unconfigured/unarmed and
 * are deliberately left intact; they cannot carry any of these values.
 *
 * bootstrapAdmin is intentionally ABSENT from the configurable surface: it is the
 * compile-time constant `ProvianPVT9.BOOTSTRAP_ADMIN` /
 * `ProvianPVT9EligibilityVerifier.BOOTSTRAP_ADMIN`, not configuration. It is mirrored
 * below ONLY to prove pairwise distinctness against the role addresses. No arming input
 * is read from configuration for the admin.
 */

/**
 * Mirror of the compile-time kernel constant `ProvianPVT9.BOOTSTRAP_ADMIN`
 * (== `ProvianPVT9EligibilityVerifier.BOOTSTRAP_ADMIN`). Sourced from the kernel
 * constant, NOT from any config surface. Used only for the pairwise-distinctness check
 * so the role addresses can never silently collide with the admin EOA. Mirrors the same
 * literal already asserted by `scripts/wp2/generate-pvt9-base-config.mjs` (FRANK_DIRECT)
 * and the discovery routes.
 */
export const KERNEL_BOOTSTRAP_ADMIN = '0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3' as const;

/*
 * NOTE. This surface is the input record of the arming (the activation scripts that
 * consume it armed the kernel with epoch zero == the Genesis window open). The
 * SUCCESSOR was armed by `scripts/d486/execute.mjs`, under the successor kernel's rules:
 * the Genesis window may open BEFORE epoch zero (so the campaign's 2026-08-03 claims settle
 * on it), epoch zero is the arming block's time plus a short lead, and the cap policy is an
 * arming input (Fixed / MAX / MAX). The successor's epoch zero is recorded in
 * `contracts/deployments/base-pvt9-institutions.json` and read from the chain at runtime
 * (`epochZeroStartsAt()`), never from here. The treasuries, the settlement minter/approver
 * and the verifier constructor arguments below are the SAME values armed with.
 */

/**
 * The raw, decided arming values. Every value here was ratified by the operator (for the
 * treasuries/minter and configuration id/version; the automated batch-approver key minted
 * into GCP Secret Manager in commit 3030cbc7 /; for the epoch-zero instant).
 * They are NOT re-derived, altered, or chosen here.
 */
export interface Pvt9ArmingInputSurface {
  /** ERC-20 recipient of the immutable 0.5% Provian cut. */
  readonly provianTreasury: string;
  /** ERC-20 recipient of the immutable 0.5% Foundation floor. */
  readonly foundationTreasury: string;
  /** Appointed via `ProvianPVT9.appointOperationalMinter`. */
  readonly operationalMinter: string;
  /** Appointed via `ProvianPVT9EligibilityVerifier.appointBatchApprover`. */
  readonly batchApprover: string;
  /** `ProvianPVT9EligibilityVerifier` constructor immutables. */
  readonly eligibilityVerifier: {
    /** bytes32, non-zero. Changing it later requires a new verifier deployment. */
    readonly configurationId: string;
    /** uint64, non-zero. */
    readonly configurationVersion: number;
  };
  /**
   * `ProvianPVT9.EpochZeroConfig.epochZeroStartsAt` as an ISO-8601 UTC instant. Must be
   * `<= genesisStartsAt` (read from the Genesis policy window). armEpochZero additionally
   * requires it strictly in the future at the arming block. On the checked-in surface this
   * is DERIVED from that same window () — never an independently maintained copy.
   */
  readonly epochZeroStartsAt: string;
}

export const PVT9_ARMING_INPUTS: Pvt9ArmingInputSurface = Object.freeze({
  provianTreasury: '0x086e0F377af1245B8888540f39e99A42a7daF1dA',
  foundationTreasury: '0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936',
  operationalMinter: '0xF0Ea014CAa37C34aF5D0a7F646ad7d7A79C09dF7',
  batchApprover: '0xbFe2a6c929B5Ea5F09e68545BC2A63065da0209c',
  eligibilityVerifier: Object.freeze({
    configurationId: '0xe0ee2de78a611198a17183b8505ed321902ba64b6577e2f1cb04a24e37cf23cb',
    configurationVersion: 1,
  }),
  // DERIVED from the approved Genesis window, never a second
  // hardcoded copy. Epoch zero has always started exactly at the Genesis
  // window open (both were 2026-07-26T00:00:00Z before the R5 reset), and the
  // kernel requires `epochZeroStartsAt <= genesisStartsAt`; deriving preserves
  // that ratified equality and makes a future window move impossible to
  // half-apply. A null window would be a policy bug, not a date to invent, so
  // it throws rather than substituting one.
  epochZeroStartsAt: epochZeroStartsAtFromWindow(),
});

/**
 * Epoch zero opens exactly when the approved Genesis admission window opens.
 * Reads `proposed-genesis-policy.ts` LIVE — the single source of truth for the
 * dates — and throws if the window start is unset or not a non-negative safe
 * integer. A sub-second start would survive this guard but is rejected
 * downstream by `toUint64Seconds` ("must be a whole-second instant"), so the
 * whole-second requirement is enforced by the assembler, not here.
 */
function epochZeroStartsAtFromWindow(): string {
  const startMs = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms;
  if (!Number.isSafeInteger(startMs) || (startMs as number) < 0) {
    throw new Error(
      `PVT9_ARMING_INVALID: Genesis window.start_ms is unusable, so epochZeroStartsAt `
      + `cannot be derived: ${String(startMs)}`,
    );
  }
  return new Date(startMs as number).toISOString().replace('.000Z', 'Z');
}

/**
 * The Genesis admission window, read from `proposed-genesis-policy.ts`. Kept as a small
 * explicit interface so the loader's dependency on the policy window is obvious and the
 * pure assembler can be tested with synthetic windows.
 */
export interface Pvt9GenesisWindow {
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly approvalStatus: string;
}

/** The validated, assembled arming inputs the activation arming path consumes. */
export interface Pvt9ArmingInputs {
  /** Kernel constant, echoed for reference and distinctness auditing. Not configuration. */
  readonly bootstrapAdmin: string;
  readonly appointments: {
    readonly operationalMinter: string;
    readonly batchApprover: string;
  };
  /** `new ProvianPVT9EligibilityVerifier(kernel, configurationId, configurationVersion)`. */
  readonly eligibilityVerifierConstructor: {
    readonly configurationId: string;
    readonly configurationVersion: number;
  };
  /**
   * The subset of `ProvianPVT9.EpochZeroConfig` this surface supplies. `initialMintRate`
   * (an economic value) and `initialFinalizedCursor` are arm-time inputs owned by activation,
   * and the deployed verifier `address` is only known post-deploy; none is carried here.
   * Timestamps are seconds (uint64) to match the on-chain struct; block.timestamp is
   * seconds.
   */
  readonly epochZeroConfig: {
    readonly epochZeroStartsAtSec: number;
    readonly genesisStartsAtSec: number;
    readonly genesisEndsAtSec: number;
    readonly provianTreasury: string;
    readonly foundationTreasury: string;
  };
  /** The same three instants in ms + ISO, for audit and relay-side comparison. */
  readonly instants: {
    readonly epochZeroStartsAtMs: number;
    readonly genesisStartsAtMs: number;
    readonly genesisEndsAtMs: number;
    readonly epochZeroStartsAtIso: string;
    readonly genesisStartsAtIso: string;
    readonly genesisEndsAtIso: string;
  };
}

export interface LoadPvt9ArmingInputsOptions {
  /**
   * When provided, additionally require all three instants strictly greater than this ms
   * timestamp — the arm-time precondition (`armEpochZero` reverts unless
   * `epochZeroStartsAt > block.timestamp`). Omit for post-launch reads that must not
   * throw once the dates are in the past.
   */
  readonly nowMsForFutureCheck?: number;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const MS_PER_SECOND = 1000;

/**
 * EIP-55 checksum validation. `ethers.getAddress` throws unless the input is a valid
 * checksummed address; requiring the round-trip to equal the input rejects all-lowercase
 * or mis-cased forms (the "reject non-conforming" requirement), and an explicit zero-
 * address guard rejects the zero address even though it is checksum-valid.
 */
function requireChecksummedNonZeroAddress(label: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`PVT9_ARMING_INVALID: ${label} must be a string`);
  }
  let checksummed: string;
  try {
    checksummed = ethers.getAddress(value);
  } catch {
    throw new Error(`PVT9_ARMING_INVALID: ${label} is not a valid EVM address: ${value}`);
  }
  if (checksummed !== value) {
    throw new Error(
      `PVT9_ARMING_INVALID: ${label} is not EIP-55 checksummed (expected ${checksummed}, got ${value})`,
    );
  }
  if (checksummed === ZERO_ADDRESS) {
    throw new Error(`PVT9_ARMING_INVALID: ${label} must not be the zero address`);
  }
  return checksummed;
}

function requireUtcInstantMs(label: string, iso: unknown): number {
  if (typeof iso !== 'string' || !ISO_UTC.test(iso)) {
    throw new Error(`PVT9_ARMING_INVALID: ${label} must be an ISO-8601 UTC instant ending in Z: ${String(iso)}`);
  }
  const ms = Date.parse(iso);
  if (!Number.isSafeInteger(ms)) {
    throw new Error(`PVT9_ARMING_INVALID: ${label} did not parse to a valid UTC instant: ${iso}`);
  }
  return ms;
}

function requireWindowInstantMs(label: string, ms: unknown): number {
  if (!Number.isSafeInteger(ms) || (ms as number) < 0) {
    throw new Error(`PVT9_ARMING_INVALID: ${label} must be a non-negative safe-integer ms instant: ${String(ms)}`);
  }
  return ms as number;
}

function toUint64Seconds(label: string, ms: number): number {
  if (ms % MS_PER_SECOND !== 0) {
    throw new Error(`PVT9_ARMING_INVALID: ${label} must be a whole-second instant: ${ms}`);
  }
  const seconds = ms / MS_PER_SECOND;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || BigInt(seconds) > MAX_UINT64) {
    throw new Error(`PVT9_ARMING_INVALID: ${label} seconds out of uint64 range: ${seconds}`);
  }
  return seconds;
}

/**
 * Pure assembler + validator. Exported so tests can prove every rejection path against
 * synthetic inputs without mutating the checked-in constants. `loadPvt9ArmingInputs`
 * wraps it over the real surface + policy window.
 */
export function assemblePvt9ArmingInputs(
  surface: Pvt9ArmingInputSurface,
  genesisWindow: Pvt9GenesisWindow,
  options: LoadPvt9ArmingInputsOptions = {},
): Pvt9ArmingInputs {
  const bootstrapAdmin = requireChecksummedNonZeroAddress('bootstrapAdmin', KERNEL_BOOTSTRAP_ADMIN);
  const provianTreasury = requireChecksummedNonZeroAddress('provianTreasury', surface.provianTreasury);
  const foundationTreasury = requireChecksummedNonZeroAddress('foundationTreasury', surface.foundationTreasury);
  const operationalMinter = requireChecksummedNonZeroAddress('operationalMinter', surface.operationalMinter);
  const batchApprover = requireChecksummedNonZeroAddress('batchApprover', surface.batchApprover);

  // Pairwise distinctness across all five role addresses (the four configurable roles
  // plus the admin constant). Every pair must differ by design: the admin, the minter,
  // the approver, and each treasury are distinct powers, and collapsing any two would
  // merge trust boundaries. Report the exact colliding pair rather than a bare boolean.
  const roles: ReadonlyArray<readonly [string, string]> = [
    ['bootstrapAdmin', bootstrapAdmin],
    ['provianTreasury', provianTreasury],
    ['foundationTreasury', foundationTreasury],
    ['operationalMinter', operationalMinter],
    ['batchApprover', batchApprover],
  ];
  for (let i = 0; i < roles.length; i += 1) {
    for (let j = i + 1; j < roles.length; j += 1) {
      if (roles[i][1].toLowerCase() === roles[j][1].toLowerCase()) {
        throw new Error(
          `PVT9_ARMING_INVALID: role addresses must be distinct but ${roles[i][0]} == ${roles[j][0]} (${roles[i][1]})`,
        );
      }
    }
  }

  // Verifier constructor immutables.
  const configurationId = surface.eligibilityVerifier.configurationId;
  if (typeof configurationId !== 'string' || !BYTES32.test(configurationId)) {
    throw new Error(`PVT9_ARMING_INVALID: configurationId must be a 32-byte hex string: ${String(configurationId)}`);
  }
  if (BigInt(configurationId) === 0n) {
    throw new Error('PVT9_ARMING_INVALID: configurationId must be non-zero');
  }
  const configurationVersion = surface.eligibilityVerifier.configurationVersion;
  if (!Number.isSafeInteger(configurationVersion)
    || configurationVersion <= 0
    || BigInt(configurationVersion) > MAX_UINT64) {
    throw new Error(`PVT9_ARMING_INVALID: configurationVersion must be a positive uint64: ${String(configurationVersion)}`);
  }

  // Three instants. epochZero comes from this surface (ISO-Z); the Genesis window comes
  // from proposed-genesis-policy.ts. The policy window must be the explicitly-approved one
  // — an unapproved/absent window fails closed so arming inputs cannot be assembled from a
  // date-less policy.
  if (genesisWindow.approvalStatus !== 'wp12_launch_dates_explicitly_approved') {
    throw new Error(
      `PVT9_ARMING_INVALID: Genesis window approval is not wp12_launch_dates_explicitly_approved (got ${genesisWindow.approvalStatus})`,
    );
  }
  const epochZeroStartsAtMs = requireUtcInstantMs('epochZeroStartsAt', surface.epochZeroStartsAt);
  const genesisStartsAtMs = requireWindowInstantMs('genesisStartsAt (window.start_ms)', genesisWindow.startMs);
  const genesisEndsAtMs = requireWindowInstantMs('genesisEndsAt (window.end_ms)', genesisWindow.endMs);

  if (!(epochZeroStartsAtMs <= genesisStartsAtMs)) {
    throw new Error(
      `PVT9_ARMING_INVALID: require epochZeroStartsAt <= genesisStartsAt (${epochZeroStartsAtMs} > ${genesisStartsAtMs})`,
    );
  }
  if (!(genesisStartsAtMs < genesisEndsAtMs)) {
    throw new Error(
      `PVT9_ARMING_INVALID: require genesisStartsAt < genesisEndsAt (${genesisStartsAtMs} >= ${genesisEndsAtMs})`,
    );
  }

  if (options.nowMsForFutureCheck !== undefined) {
    const now = options.nowMsForFutureCheck;
    if (!Number.isSafeInteger(now)) {
      throw new Error('PVT9_ARMING_INVALID: nowMsForFutureCheck must be a safe-integer ms timestamp');
    }
    for (const [label, ms] of [
      ['epochZeroStartsAt', epochZeroStartsAtMs],
      ['genesisStartsAt', genesisStartsAtMs],
      ['genesisEndsAt', genesisEndsAtMs],
    ] as const) {
      if (!(ms > now)) {
        throw new Error(`PVT9_ARMING_INVALID: ${label} must be in the future (${ms} <= ${now})`);
      }
    }
  }

  return Object.freeze({
    bootstrapAdmin,
    appointments: Object.freeze({ operationalMinter, batchApprover }),
    eligibilityVerifierConstructor: Object.freeze({ configurationId, configurationVersion }),
    epochZeroConfig: Object.freeze({
      epochZeroStartsAtSec: toUint64Seconds('epochZeroStartsAt', epochZeroStartsAtMs),
      genesisStartsAtSec: toUint64Seconds('genesisStartsAt', genesisStartsAtMs),
      genesisEndsAtSec: toUint64Seconds('genesisEndsAt', genesisEndsAtMs),
      provianTreasury,
      foundationTreasury,
    }),
    instants: Object.freeze({
      epochZeroStartsAtMs,
      genesisStartsAtMs,
      genesisEndsAtMs,
      epochZeroStartsAtIso: new Date(epochZeroStartsAtMs).toISOString(),
      genesisStartsAtIso: new Date(genesisStartsAtMs).toISOString(),
      genesisEndsAtIso: new Date(genesisEndsAtMs).toISOString(),
    }),
  });
}

/**
 * The activation arming path's reader: assemble and fully validate the arming inputs from the
 * checked-in surface and the approved Genesis window. Every value the arming path needs
 * is returned here; nothing is signed, appointed, or broadcast.
 */
export function loadPvt9ArmingInputs(options: LoadPvt9ArmingInputsOptions = {}): Pvt9ArmingInputs {
  return assemblePvt9ArmingInputs(
    PVT9_ARMING_INPUTS,
    {
      startMs: PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms,
      endMs: PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms,
      approvalStatus: PROPOSED_GENESIS_CAMPAIGN_POLICY.window.approval.status,
    },
    options,
  );
}
