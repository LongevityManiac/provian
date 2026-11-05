/**
 * H4 — public-launch sequence guard. Blocks opening public signup while the
 * Genesis enqueue window is armed but grant persistence is not yet live.
 *
 * In that state every in-window human/device signup qualifies (enqueue armed) but
 * the persist gate refuses (activation doc absent/invalid/killed), so — even with
 * durable retention (H1) — you do NOT want real users hitting those legs before an
 * activation doc exists. This guard makes the sequencing a boot-time invariant
 * rather than an operator's memory.
 */
import type { Firestore } from 'firebase-admin/firestore';

import {
  genesisEnqueueArmed,
  isGenesisGrantPersistenceLive,
} from './genesis-award-state-machine';
import { PVT9_BASE_CONFIG } from './pvt9-base-config.generated';
import type { GenesisActivationApprovalVerifier } from './policy/genesis-policy-engine';

export class GenesisLaunchSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenesisLaunchSequenceError';
  }
}

export interface GenesisLaunchGuardInput {
  readonly publicLaunch: boolean;
  readonly genesisEnqueueArmed: boolean;
  readonly genesisPersistLive: boolean;
}

/**
 * The hazard is EXACTLY: signup open AND enqueue window armed AND persistence NOT
 * live. Any one of those three being false means no in-window grant is at risk, so
 * the guard permits it. Throws to fail closed on the hazard ("Unknown = Block").
 */
export function assertPublicLaunchGatedByGenesisActivation(
  input: GenesisLaunchGuardInput,
): void {
  if (input.publicLaunch && input.genesisEnqueueArmed && !input.genesisPersistLive) {
    throw new GenesisLaunchSequenceError(
      'PUBLIC_LAUNCH is true while the Genesis enqueue window is armed but grant '
      + 'persistence is not live (activation doc absent, invalid, or killed). Opening '
      + 'public signup now would refuse every in-window human and device Genesis grant. '
      + 'Create and sign the runtime activation doc so persistence is live, or keep '
      + 'PUBLIC_LAUNCH=false, before launch.',
    );
  }
}

/**
 * H4, SECOND EDGE — the launch/mint-readiness invariant.
 *
 * WHY IT WAS RE-POINTED. The persistence edge above has been SATISFIED, not
 * blocking, on every live triple since it shipped: production runs
 * `{launch:false, armed:true, persistLive:true}`, so the hazard conjunction is
 * false for a reason that has nothing to do with the guard working. A guard that
 * has only ever been observed permitting is not evidence of anything. This edge
 * asks a question that is actually LIVE today: may signup be opened while nothing
 * can mint and no-one has said minting should be on?
 *
 * THE RULE. If `PUBLIC_LAUNCH` is true, boot is refused unless BOTH
 *   (a) minting is DELIBERATELY enabled — `PVT_MINTING_DELIBERATELY_ENABLED`
 *       is exactly `'true'`; absent, `'false'`, or any other value refuses; and
 *   (b) a mint path is affirmatively KNOWN to exist — the probe returns `true`.
 *
 * FAIL CLOSED ON UNKNOWN, NOT MERELY ON A FALSE CONJUNCT. The probe returns
 * `boolean | undefined`, and `undefined` ("I could not determine whether a mint
 * path exists") refuses under its OWN verdict — it is never collapsed into
 * `false`, and it is never allowed to make the conjunction vacuously safe. A
 * probe that throws refuses too. The only admits are "launch is closed, so there
 * is no hazard" and "both conjuncts affirmatively hold".
 */
export type LaunchMintReadinessVerdict =
  | 'no_hazard_launch_closed'
  | 'permitted_minting_deliberately_enabled'
  | 'refused_minting_flag_absent'
  | 'refused_minting_flag_unknown_value'
  | 'refused_minting_not_enabled'
  | 'refused_mint_path_absent'
  | 'refused_mint_path_unknown';

export interface LaunchMintReadinessInput {
  readonly publicLaunch: boolean;
  /** Raw env value, so ABSENT and UNKNOWN stay distinguishable from `false`. */
  readonly mintingDeliberatelyEnabledRaw: string | undefined;
  /** `undefined` means UNKNOWN and refuses under its own verdict. */
  readonly mintPathPresent: boolean | undefined;
}

/** Exactly two admits; a verdict added later refuses by construction. */
export function launchMintReadinessPermits(verdict: LaunchMintReadinessVerdict): boolean {
  return verdict === 'no_hazard_launch_closed'
    || verdict === 'permitted_minting_deliberately_enabled';
}

/** Every refusing verdict — the two admits are not conjunct failures. */
export type LaunchMintReadinessRefusal = Exclude<
  LaunchMintReadinessVerdict,
  'no_hazard_launch_closed' | 'permitted_minting_deliberately_enabled'
>;

/**
 * ALL failing conjuncts, not just the first. The two conjuncts — minting is
 * deliberately enabled, and a mint path is affirmatively present — are evaluated
 * INDEPENDENTLY, so an operator who has neither set sees BOTH named in the boot
 * error instead of fixing one and re-hitting the other. Empty means permitted
 * (launch closed, or both conjuncts hold). Both conjuncts are pure reads (env +
 * the checked-in config constant), so evaluating both costs nothing.
 */
export function collectLaunchMintReadinessRefusals(
  input: LaunchMintReadinessInput,
): LaunchMintReadinessRefusal[] {
  if (!input.publicLaunch) return [];
  const refusals: LaunchMintReadinessRefusal[] = [];
  // Conjunct A — minting is DELIBERATELY enabled.
  const raw = input.mintingDeliberatelyEnabledRaw;
  if (raw === undefined) {
    refusals.push('refused_minting_flag_absent');
  } else {
    const value = raw.trim();
    if (value === 'false' || value === '') refusals.push('refused_minting_not_enabled');
    else if (value !== 'true') refusals.push('refused_minting_flag_unknown_value');
  }
  // Conjunct B — a mint path is affirmatively KNOWN present. UNKNOWN refuses under
  // its own verdict and is never collapsed into false.
  if (input.mintPathPresent === undefined) refusals.push('refused_mint_path_unknown');
  else if (input.mintPathPresent === false) refusals.push('refused_mint_path_absent');
  return refusals;
}

export function explainLaunchMintReadiness(
  input: LaunchMintReadinessInput,
): LaunchMintReadinessVerdict {
  if (!input.publicLaunch) return 'no_hazard_launch_closed';
  const refusals = collectLaunchMintReadinessRefusals(input);
  // The primary verdict is the first refusal in conjunct order (minting flag before
  // mint path), preserving the single-verdict contract callers already depend on.
  return refusals.length === 0 ? 'permitted_minting_deliberately_enabled' : refusals[0];
}

export function assertPublicLaunchGatedByMintReadiness(
  input: LaunchMintReadinessInput,
): void {
  const refusals = collectLaunchMintReadinessRefusals(input);
  if (refusals.length === 0) return;
  throw new GenesisLaunchSequenceError(
    `PUBLIC_LAUNCH is true but launch mint-readiness is not satisfied. Failing `
    + `conjunct(s): ${refusals.join(', ')}. Opening public signup while nothing can `
    + `mint publishes an earning promise the system cannot keep. Set `
    + `PVT_MINTING_DELIBERATELY_ENABLED=true only when you have decided minting is on `
    + `(the kernel is read from the pinned config/pvt9-base.json, never from env; a `
    + `mint-path refusal means that config records no deployed, non-forbidden PVT9 `
    + `kernel), or keep PUBLIC_LAUNCH=false.`,
  );
}

/**
 * Startup wiring: reads live state and applies the guard. If PUBLIC_LAUNCH is false
 * there is no hazard and no read is performed. On the confirmed hazard it throws; the
 * caller MUST fail the boot. A read error under PUBLIC_LAUNCH=true propagates and
 * blocks by design — launching publicly while persistence is unverifiable is exactly
 * the state "Unknown = Block" exists for.
 */
export async function enforceGenesisLaunchSequenceAtStartup(
  db: Firestore,
  publicLaunch: boolean,
  approvalVerifier?: GenesisActivationApprovalVerifier,
  /** Injectable so a test can drive the UNKNOWN case without editing the env. */
  mintPathPresent?: boolean | undefined,
): Promise<void> {
  if (!publicLaunch) return;
  // The mint-readiness edge is checked FIRST and needs no I/O, so a launch attempt
  // with minting undeclared is refused before any read can fail for another reason.
  assertPublicLaunchGatedByMintReadiness({
    publicLaunch,
    mintingDeliberatelyEnabledRaw: process.env.PVT_MINTING_DELIBERATELY_ENABLED,
    mintPathPresent: mintPathPresent ?? resolveMintPathPresence(),
  });
  const persistLive = await isGenesisGrantPersistenceLive(db, approvalVerifier);
  assertPublicLaunchGatedByGenesisActivation({
    publicLaunch,
    genesisEnqueueArmed: genesisEnqueueArmed(),
    genesisPersistLive: persistLive,
  });
}

type KernelAddress =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'present'; readonly address: string };

/** Absent (empty/zero), unknown (malformed), or a present lowercased address. */
function parseKernelAddress(raw: unknown): KernelAddress {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'unknown' };
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'null') return { kind: 'absent' };
  if (!/^0x[a-f0-9]{40}$/.test(value)) return { kind: 'unknown' };
  if (value === `0x${'0'.repeat(40)}`) return { kind: 'absent' };
  return { kind: 'present', address: value };
}

/**
 * The slice of the pinned PVT9 config the mint-path probe reads. Widened to
 * `unknown` leaves so a test can construct the violating shapes (a config with no
 * kernel, a malformed one, a forbidden one) — the call site passes the real
 * checked-in `PVT9_BASE_CONFIG`.
 */
export interface MintPathConfigView {
  readonly assets: {
    readonly pvt9: {
      readonly address?: unknown;
      readonly abi?: unknown;
      readonly deployment_status?: unknown;
    };
  };
  readonly validation?: { readonly forbidden_pvt_addresses?: unknown };
}

/**
 * Is a PVT9 mint path configured? Returns `undefined` UNKNOWN, which refuses —
 * whenever the answer cannot be established, rather than guessing `false`.
 *
 * THE SEAM IS THE PINNED CONFIG, AND ONLY THE PINNED CONFIG.
 * The deployed PVT9 kernel is recorded in `config/pvt9-base.json`
 * (`PVT9_BASE_CONFIG.assets.pvt9`); `requireConfiguredPvt9Runtime` reads it from there,
 * and `pvt-principal-config.ts` pins its own literal copy of the same address.
 * No live path reads a kernel address from env (only the quarantined legacy
 * `anchor-recovery-cli.ts` still names `PVT_CONTRACT_ADDRESS`): the retired reads were the orphan
 * `PVT9_CONTRACT_ADDRESS` (set by nothing) and then `PVT_CONTRACT_ADDRESS` (set by
 * nothing on live Cloud Run either — it carries `PVT_CONTRACT_ADDRESS_BASE`, which
 * nothing reads). Either env read made this probe answer "absent" on the live env
 * and refuse the flip, even though the kernel is deployed and pinned. An env
 * pointer would also be a second, mutable source of truth for an address the
 * config already pins.
 *
 * A mint path is PRESENT only when the pinned config affirmatively records a
 * deployed kernel: `deployment_status === 'deployed'`, a valid non-zero address,
 * a non-empty ABI, and an address that is NOT on `forbidden_pvt_addresses` (the
 * abandoned `0x8b2306be…` and retired `0x4Bf02d5C…` kernels). The config recording
 * no deployed kernel is ABSENT (refuses); a malformed field, or a kernel address
 * the config itself forbids, is UNKNOWN (refuses under its own verdict) — never
 * coerced to false, never coerced to true.
 */
export function resolveMintPathPresence(
  config: MintPathConfigView = PVT9_BASE_CONFIG,
): boolean | undefined {
  const pvt9 = config.assets.pvt9;
  const configAddr = parseKernelAddress(pvt9.address);
  const status = pvt9.deployment_status;
  // UNKNOWN first — any malformed input refuses under its own verdict.
  if (configAddr.kind === 'unknown') return undefined;
  if (typeof status !== 'string') return undefined;
  // ABSENT — the config records no deployed kernel.
  if (status !== 'deployed') return false;
  if (configAddr.kind === 'absent') return false;
  if (pvt9.abi === undefined || pvt9.abi === null) return false;
  if (!Array.isArray(pvt9.abi)) return undefined; // malformed → UNKNOWN
  if (pvt9.abi.length === 0) return false;
  // A kernel the config itself forbids cannot be a mint path; an unreadable
  // forbidden list cannot be checked, so it is UNKNOWN.
  const forbidden = config.validation?.forbidden_pvt_addresses;
  if (!Array.isArray(forbidden)) return undefined;
  for (const entry of forbidden) {
    if (typeof entry !== 'string') return undefined;
    if (entry.trim().toLowerCase() === configAddr.address) return undefined;
  }
  return true;
}
